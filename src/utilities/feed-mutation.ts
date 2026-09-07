/**
 * Shared machinery for the feed's two owner-bound mutations: `PUT` (replace) and `DELETE`.
 *
 * The feed has no API key. Every mutating request is authorized by signatures the body carries, and for
 * replace and delete those signatures must come from a key the *stored* resource already names as an
 * owner (dp1-feed-v2 `docs/api_design.md`, "Authentication and authorization"). A create signs the
 * document itself; a replace and a delete additionally sign a short-lived **intent** envelope, because an
 * owner's document signatures are public via `GET` and could otherwise be replayed — the per-signature
 * `ts` is not covered by the signature, so only a `created` inside a signed payload can bound replay.
 *
 * Both intents therefore share the same shape and the same failure modes, which is why they live here
 * rather than in the publisher and unpublisher separately: the envelope, the freshness rule, the
 * ownership rule and the error vocabulary are one contract with two verbs.
 */

import axios, { AxiosError } from 'axios';
import type { Playlist } from '../types';

// playlist-signer is still CommonJS; require keeps the interop simple.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeSigningKeyToBase64Pkcs8 } = require('./playlist-signer');

/**
 * DP-1 signature role that carries ownership of a playlist.
 *
 * Mirrors the feed's owner role for playlists (channels use `publisher`, which ff-cli does not publish).
 * Intents are always signed in this role: only an owner signature authorizes a replace or a delete, so
 * signing an intent under any other role produces a body the feed answers with `403`.
 */
export const OWNER_ROLE = 'curator';

/** Identifies the playlist an intent acts on. Every field is compared against the stored row. */
export interface PlaylistIntentTarget {
  type: 'playlist';
  id: string;
  slug: string;
}

/** DELETE body before signatures are attached. */
export interface PlaylistDeleteIntent {
  action: 'delete';
  target: PlaylistIntentTarget;
  created: string;
}

/** `authorization` half of a PUT body before signatures are attached. */
export interface PlaylistReplaceIntent {
  action: 'replace';
  target: PlaylistIntentTarget;
  payloadHash: string;
  created: string;
}

/** DP-1 v1.1 multi-signature entry, as produced by dp1-js and accepted by the feed. */
export interface Dp1Signature {
  alg: string;
  kid: string;
  ts: string;
  payload_hash: string;
  role: string;
  sig: string;
}

/** A stored playlist as the feed serves it, narrowed to the fields the mutation paths read. */
export interface StoredPlaylist extends Record<string, unknown> {
  id?: string;
  slug?: string;
  created?: string;
  curators?: Array<{ name?: string; key?: string }>;
}

/** How a mutation failed, in the CLI's two-part shape: a one-line diagnosis plus a remedy. */
export interface FeedMutationFailure {
  error: string;
  message?: string;
}

/**
 * Whole-second RFC 3339 timestamp for an intent's `created`.
 *
 * The feed compares this against its own clock and rejects anything outside `auth.intent_max_clock_skew`
 * (default 5 minutes) with `400 invalid_timestamp`. Milliseconds are stripped to match the form the
 * playlist signer already emits, so both timestamps in a request read alike.
 */
export function intentTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the DELETE body's unsigned half.
 *
 * `id` and `slug` must match the stored row exactly — the feed compares both and answers `400
 * bad_request` on any disagreement — which is why callers read them from a `GET` rather than from
 * whatever the user typed.
 */
export function buildDeleteIntent(id: string, slug: string, created: string): PlaylistDeleteIntent {
  return { action: 'delete', target: { type: 'playlist', id, slug }, created };
}

/**
 * Build the `authorization` half of a PUT body.
 *
 * `payloadHash` binds the intent to the exact document being installed, so a captured intent cannot be
 * replayed to install different bytes. It is the DP-1 signing digest of the accompanying document.
 */
export function buildReplaceIntent(
  id: string,
  slug: string,
  payloadHash: string,
  created: string
): PlaylistReplaceIntent {
  return { action: 'replace', target: { type: 'playlist', id, slug }, payloadHash, created };
}

/**
 * DP-1 signing digest of a document, in the `sha256:<hex>` form the feed's `payloadHash` expects.
 *
 * dp1-js strips `signature`/`signatures` and JCS-canonicalizes internally, so the full signed document
 * is passed through unchanged; computing it any other way risks diverging from the digest the document's
 * own signatures were taken over.
 */
export async function documentPayloadHash(document: unknown): Promise<string> {
  const dp1 = await import('dp1-js');
  return dp1.PayloadHashString(Buffer.from(JSON.stringify(document)));
}

/**
 * Sign an intent with the playlist signing key, in the owner role.
 *
 * The signature covers the intent bytes with `signatures` stripped and JCS-canonicalized — the same
 * payload rule DP-1 uses for documents — so the unsigned intent object is passed here as-is and the
 * caller attaches the result afterwards. `ts` is set to the intent's own `created` so the two timestamps
 * a reviewer sees in a request body agree.
 */
export async function signIntent(
  intent: PlaylistDeleteIntent | PlaylistReplaceIntent,
  privateKeyMaterial: string
): Promise<Dp1Signature> {
  const dp1 = await import('dp1-js');
  const normalizedKey = normalizeSigningKeyToBase64Pkcs8(privateKeyMaterial);
  return (await dp1.SignMultiEd25519(
    Buffer.from(JSON.stringify(intent)),
    normalizedKey,
    OWNER_ROLE,
    intent.created
  )) as Dp1Signature;
}

/**
 * Reduce user input to the path segment the feed resolves.
 *
 * Operators copy playlist URLs out of a browser far more often than they copy bare UUIDs, and the feed's
 * `{id}` parameter accepts either an id or a slug. Anything that parses as an HTTP(S) URL contributes
 * its last non-empty path segment; everything else is passed through trimmed.
 */
export function resolvePlaylistIdentifier(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  return segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : trimmed;
}

/**
 * Fetch the stored playlist a mutation will target.
 *
 * Both mutations need the stored copy before they can be built at all: the delete intent must name the
 * stored `slug`, and a replace must prove its identity fields still equal the stored ones. Reading the
 * owners from here rather than from the local file is the point — a local document can claim any
 * `curators[]`, but only the stored set decides who may write.
 */
export async function fetchStoredPlaylist(
  feedServerUrl: string,
  identifier: string
): Promise<StoredPlaylist> {
  const response = await axios.get(`${feedServerUrl}/playlists/${encodeURIComponent(identifier)}`, {
    headers: { Accept: 'application/json' },
    timeout: 30000,
  });
  const stored = response.data as StoredPlaylist | undefined;
  if (!stored || typeof stored !== 'object') {
    throw new Error('Feed returned no playlist document');
  }
  return stored;
}

/** Owner `did:key`s the stored playlist declares, in declaration order. */
export function storedOwnerKeys(stored: StoredPlaylist): string[] {
  const curators = Array.isArray(stored.curators) ? stored.curators : [];
  return curators
    .map((curator) => (typeof curator?.key === 'string' ? curator.key.trim() : ''))
    .filter((key) => key.length > 0);
}

/**
 * Refuse locally when the configured key is not an owner of the stored playlist.
 *
 * The feed's own answer to this is a bare `403 forbidden`, which says nothing about *which* identity was
 * offered or which ones would have worked — so an operator with several keys learns only that one of
 * them was wrong. Naming both sides turns that into an actionable line, and costs no request beyond the
 * `GET` the mutation already had to make.
 *
 * @returns A failure to report, or `null` when the configured key is an owner.
 */
export function ownershipPreflight(
  stored: StoredPlaylist,
  signerDidKey: string,
  action: 'delete' | 'replace'
): FeedMutationFailure | null {
  const owners = storedOwnerKeys(stored);
  if (owners.includes(signerDidKey)) {
    return null;
  }
  const verb = action === 'delete' ? 'delete' : 'replace';

  // A playlist with no declared curators is not "owned by someone else" — it is owned by nobody, and
  // nothing can ever authorize a write to it. Telling that operator to switch keys sends them looking
  // for one that does not exist; this is the state every playlist published before ff-cli signed as
  // `curator` is in, and it is exactly what the publish-time owner-role gate now prevents.
  if (owners.length === 0) {
    return {
      error: `This playlist declares no owners, so no key can ${verb} it.`,
      message:
        `The feed derives ownership from the stored document's curators[], and this one is empty — the\n` +
        `  shape a playlist published without an owner-role signature is frozen in. No signature can\n` +
        `  authorize a ${verb}, including yours (${signerDidKey}).\n` +
        `  Nothing can repair it: the owner set is immutable, and only an owner could change it. Publish\n` +
        `  a corrected playlist under a new id instead.`,
    };
  }

  return {
    error: `The configured signing key is not an owner of this playlist, so it cannot ${verb} it.`,
    message:
      `Only a key the stored playlist names in curators[] can authorize a ${verb}; the feed derives\n` +
      `  ownership from the stored document, not from a local copy.\n` +
      `  Your configured identity:\n` +
      `    ${signerDidKey}\n` +
      `  Stored owners:\n` +
      `${owners.map((key) => `    ${key}`).join('\n')}\n` +
      `  Point playlist.privateKey at a key listed above (confirm any key's identity with\n` +
      `  "ff-cli status --key <private key>"). Ownership cannot be granted after the fact: the owner set\n` +
      `  is immutable, so a playlist signed by the wrong key stays that way.`,
  };
}

/** Feed error code carried in an error response body, when there is one. */
function feedErrorCode(error: AxiosError): string {
  const data = error.response?.data as { error?: unknown; code?: unknown } | undefined;
  const code = data?.error ?? data?.code;
  return typeof code === 'string' ? code : '';
}

/** Human-readable detail the feed supplied, if any. */
function feedErrorDetail(error: AxiosError): string {
  const data = error.response?.data as { message?: unknown } | undefined;
  if (typeof data?.message === 'string' && data.message.trim().length > 0) {
    return data.message.trim();
  }
  return '';
}

/**
 * Translate a feed mutation failure into the CLI's diagnosis-plus-remedy shape.
 *
 * The feed's status codes each mean something specific for an owner-bound write, and the raw JSON body
 * does not say which of them the operator hit — `400` alone covers both a stale intent and a target
 * mismatch. Mapping them here keeps `unpublish` and `publish --replace` answering in the same
 * vocabulary, and keeps that vocabulary next to the contract it mirrors.
 *
 * The codes handled are exactly those dp1-feed-v2 documents for these routes; anything else falls
 * through with the server's own words rather than being guessed at.
 */
export function describeFeedMutationError(
  error: unknown,
  action: 'delete' | 'replace'
): FeedMutationFailure {
  const axiosError = error as AxiosError;
  const status = axiosError.response?.status;
  const code = feedErrorCode(axiosError);
  const detail = feedErrorDetail(axiosError);
  const verb = action === 'delete' ? 'Delete' : 'Replace';
  const suffix = detail ? `\n  Feed said: ${detail}` : '';

  if (status === undefined) {
    return { error: `${verb} failed: ${axiosError.message}` };
  }

  if (status === 401) {
    return {
      error: `${verb} refused: the feed saw no signatures on the request.`,
      message:
        `Every mutating request is authorized by the signatures in its body — there is no API key.\n` +
        `  This usually means no signing key is configured: run "ff-cli status" to check, and\n` +
        `  "ff-cli setup" to generate one.${suffix}`,
    };
  }

  if (status === 403) {
    return {
      error: `${verb} refused: the signing key is not an owner of the stored playlist.`,
      message:
        `The signature verified, but its key is not in the stored playlist's curators[].\n` +
        (action === 'replace'
          ? `  A replace also fails this way when it changes the owner set: curators[] is immutable.\n`
          : '') +
        `  Sign with a key the stored playlist already names as a curator.${suffix}`,
    };
  }

  if (status === 400 && code === 'invalid_timestamp') {
    return {
      error: `${verb} refused: the signed intent was outside the feed's freshness window.`,
      message:
        `An intent is valid for about five minutes, and the window is wall-clock, so a machine whose\n` +
        `  clock has drifted fails every attempt. Check the system clock, then run the command again — a\n` +
        `  new intent is signed each time.${suffix}`,
    };
  }

  if (status === 400) {
    return {
      error: `${verb} refused: the request did not match the stored playlist.`,
      message:
        action === 'delete'
          ? `  The delete intent must name the stored id and slug exactly. They are read from the feed\n` +
            `  immediately before the request, so this means the playlist changed in between: run the\n` +
            `  command again.${suffix}`
          : `  A replace may not change identity: id, slug, and created must equal the stored document's,\n` +
            `  and every signature must verify. Re-read the stored copy and re-sign from it.${suffix}`,
    };
  }

  if (status === 404) {
    return {
      error: `${verb} refused: the feed has no such playlist.`,
      message:
        `Either the id or slug is wrong for this feed, or the playlist was already deleted. Deleted ids\n` +
        `  are tombstoned and never reused, so a deleted playlist cannot be restored under the same id.${suffix}`,
    };
  }

  if (status === 409) {
    return {
      error: `${verb} refused: the playlist changed between authorization and the write.`,
      message: `Another write landed first. Re-read the playlist and run the command again.${suffix}`,
    };
  }

  const body = axiosError.response?.data
    ? JSON.stringify(axiosError.response.data)
    : axiosError.message;
  return { error: `${verb} failed with status ${status}: ${body}` };
}

/** Narrow a stored playlist to a `Playlist` for the shared verification paths. */
export function asPlaylist(stored: StoredPlaylist): Playlist {
  return stored as unknown as Playlist;
}
