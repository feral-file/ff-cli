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
import { getPlaylistConfig } from '../config';
import { playlistSigningDidKey } from './signing-identity';

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

/**
 * Resolve the key that signs an owner-bound intent, honouring an explicit `--key`.
 *
 * **Presence, never truthiness.** `--key ""` — the shape an unset shell variable takes,
 * `--key "$SIGNING_KEY"` with nothing in it — is an override that FAILED, not an absent one. Treating it
 * as absent silently fell back to the configured key, so a delete meant to be authorized by one identity
 * was authorized by another and tombstoned the playlist under it. There is no recovering from that: the
 * id is retired. So anything the caller actually passed goes through validation and is rejected there;
 * only `undefined` means "use the configured key".
 *
 * @param override - Value of `--key` exactly as the command received it
 * @param action - Which mutation is being authorized, for the no-key-configured message
 * @returns Key material for signing
 * @throws Error when the override is empty, or when nothing is configured and none was given
 */
export function resolveMutationSigningKey(
  override: string | undefined,
  action: 'delete' | 'replace'
): string {
  if (override !== undefined) {
    if (override.trim().length === 0) {
      throw new Error(
        'The --key value is empty. This usually means a shell variable did not expand ' +
          '(for example --key "$SIGNING_KEY" with SIGNING_KEY unset). Refusing rather than falling ' +
          'back to the configured key: a signature made by the wrong identity is not something a ' +
          `${action} can be taken back from.`
      );
    }
    return override;
  }

  const configured = getPlaylistConfig().privateKey;
  if (!configured) {
    throw new Error(
      `No playlist signing key is configured. A ${action} is authorized by a signature, so one is ` +
        'required: run "ff-cli setup", set playlist.privateKey in config.json, or pass --key.'
    );
  }
  return configured;
}

/**
 * Identity a mutation will sign under, resolved and validated together.
 *
 * Commands call this before doing anything else so a bad credential fails before any request — and, for
 * `unpublish`, before the operator is asked to confirm a delete they could not have completed. The key
 * material never appears in what comes back: only the `did:key` it derives to.
 *
 * @param override - Value of `--key` exactly as the command received it
 * @param action - Which mutation is being authorized
 * @returns The key material and the `did:key` it asserts
 */
export function mutationSignerIdentity(
  override: string | undefined,
  action: 'delete' | 'replace'
): { privateKey: string; didKey: string } {
  const privateKey = resolveMutationSigningKey(override, action);
  return { privateKey, didKey: playlistSigningDidKey(privateKey) };
}

/** Owner `did:key`s the stored playlist declares, in declaration order. */
export function storedOwnerKeys(stored: StoredPlaylist): string[] {
  const curators = Array.isArray(stored.curators) ? stored.curators : [];
  return curators
    .map((curator) => (typeof curator?.key === 'string' ? curator.key.trim() : ''))
    .filter((key) => key.length > 0);
}

/**
 * Owners of a stored playlist, split into what it *claims* and what it *proves*.
 *
 * Being named in `curators[]` is a claim; a valid `curator`-role signature from that key is the proof,
 * and the feed requires both before it treats a key as an owner. The two sets diverge in exactly one
 * real population: playlists published while ff-cli's default signing role was `agent`. Those declare a
 * curator and carry only that key's `agent` signature, so a check that stopped at the declaration would
 * pass them, sign an intent, send it, and read the feed's `403` back as "your key is not declared" — the
 * one thing that is not wrong with them.
 */
export interface StoredOwnership {
  /** Keys named in the stored `curators[]`. */
  declared: string[];
  /** Declared keys that also carry a cryptographically valid `curator`-role signature. */
  proven: string[];
}

/**
 * Resolve who can actually authorize a mutation on a stored playlist.
 *
 * Each candidate signature is verified individually rather than through a whole-envelope check: a stored
 * document legitimately carries entries this CLI does not depend on — the feed's own `feed` signature,
 * and any co-curator's — and one unverifiable stranger among them must not invalidate a proof that is
 * itself sound. Verification is over the stored bytes with `signatures` stripped and JCS-canonicalized,
 * so re-serializing the parsed document here is safe: canonicalization removes key-order and whitespace
 * differences before the digest is taken.
 *
 * @param stored - The playlist as the feed serves it
 * @returns Declared and proven owner keys
 */
export async function storedOwnership(stored: StoredPlaylist): Promise<StoredOwnership> {
  const declared = storedOwnerKeys(stored);
  const signatures = Array.isArray((stored as { signatures?: unknown }).signatures)
    ? ((stored as unknown as { signatures: Dp1Signature[] }).signatures ?? []).filter(Boolean)
    : [];

  if (declared.length === 0 || signatures.length === 0) {
    return { declared, proven: [] };
  }

  const dp1 = await import('dp1-js');
  const raw = Buffer.from(JSON.stringify(stored));
  const proven: string[] = [];

  for (const signature of signatures) {
    const kid = typeof signature?.kid === 'string' ? signature.kid.trim() : '';
    if (signature?.role !== OWNER_ROLE || !declared.includes(kid) || proven.includes(kid)) {
      continue;
    }
    try {
      dp1.VerifyMultiSignature(raw, signature as never);
      proven.push(kid);
    } catch {
      // An entry that does not verify is not proof. It is also not this command's business to report:
      // a stale or tampered signature on someone else's key changes nothing about whether the
      // signing key can act, and the answer below is derived from the set that survived.
    }
  }

  return { declared, proven };
}

/**
 * Where the signing identity came from.
 *
 * A refusal has to point at the thing the operator can actually change. Telling someone who passed
 * `--key` to edit `playlist.privateKey` sends them to a file this run never read, and it reads as if
 * their flag was ignored — which, after the empty-`--key` fallback, is exactly the doubt not to raise.
 */
export type KeySource = 'configured' | 'supplied';

/** How to describe the identity in a refusal, given where it came from. */
function identityLabel(keySource: KeySource): string {
  return keySource === 'supplied'
    ? 'The identity you passed with --key:'
    : 'Your configured identity:';
}

/** What to do about it, given where it came from. */
function retryAdvice(keySource: KeySource, plural: boolean): string {
  const which = plural ? 'one of the keys listed above' : 'the key listed above';
  return keySource === 'supplied'
    ? `  Run it again with an owner key: --key <private key for ${which}>.\n` +
        `  (Confirm which identity a key carries with "ff-cli status --key <private key>".)`
    : `  Point playlist.privateKey at ${which}, or pass one for this run with --key (confirm any\n` +
        `  key's identity with "ff-cli status --key <private key>").`;
}

/**
 * Refuse locally when the signing key cannot authorize a mutation on the stored playlist.
 *
 * The feed's own answer to every case here is a bare `403 forbidden`, which says nothing about which
 * identity was offered, which ones would have worked, or whether the problem is the declaration or the
 * proof. Separating them costs no request beyond the `GET` the mutation already had to make, and the
 * three answers point in genuinely different directions: switch keys, nothing can ever work, or the
 * declaration is right and the signature that would back it was never made.
 *
 * @param stored - The playlist as the feed serves it
 * @param signerDidKey - `did:key` the signing key will assert
 * @param action - Which mutation is being authorized, for the wording
 * @returns A failure to report, or `null` when the signing key is a proven owner.
 */
export async function ownershipPreflight(
  stored: StoredPlaylist,
  signerDidKey: string,
  action: 'delete' | 'replace',
  keySource: KeySource = 'configured'
): Promise<FeedMutationFailure | null> {
  const { declared, proven } = await storedOwnership(stored);
  if (proven.includes(signerDidKey)) {
    return null;
  }
  const verb = action === 'delete' ? 'delete' : 'replace';

  // A playlist with no declared curators is not "owned by someone else" — it is owned by nobody, and
  // nothing can ever authorize a write to it. Telling that operator to switch keys sends them looking
  // for one that does not exist; this is the state a playlist published without any curator declaration
  // is frozen in, and it is exactly what the publish-time curator check now prevents.
  if (declared.length === 0) {
    return {
      error: `This playlist declares no owners, so no key can ${verb} it.`,
      message:
        `The feed derives ownership from the stored document's curators[], and this one is empty — the\n` +
        `  shape a playlist published without an owner-role signature is frozen in. No signature can\n` +
        `  authorize a ${verb}, including this one (${signerDidKey}).\n` +
        `  Nothing can repair it: the owner set is immutable, and only an owner could change it. Publish\n` +
        `  a corrected playlist under a new id instead.`,
    };
  }

  // Declared, but nobody proved it. Same terminal outcome as the case above, different cause and
  // therefore a different message: curators[] is correct and the owner-role signature that would back
  // it was never made. This is the state of everything published from 2.5.0 with the default `agent`
  // role, so it is the case an operator is most likely to meet on an older playlist.
  if (proven.length === 0) {
    return {
      error: `No key has proved ownership of this playlist, so none can ${verb} it.`,
      message:
        `A key counts as an owner only when it is named in curators[] AND signed the document as\n` +
        `  "${OWNER_ROLE}". This playlist names ${declared.length === 1 ? 'a curator' : `${declared.length} curators`} and carries no valid ${OWNER_ROLE} signature\n` +
        `  from ${declared.length === 1 ? 'that key' : 'any of them'} — the shape of a playlist published while the default signing role was\n` +
        `  "agent".\n` +
        `  Declared:\n` +
        `${declared.map((key) => `    ${key}`).join('\n')}\n` +
        `  Nothing can repair it, including holding one of those keys: adding the missing signature\n` +
        `  would be a replace, and a replace needs the very proof that is missing. Publish a corrected\n` +
        `  playlist under a new id instead.`,
    };
  }

  // Declared, and someone proved it — but not this key. Distinct from the case above: an owner exists,
  // it is simply not the one configured here.
  if (declared.includes(signerDidKey)) {
    return {
      error: `This key is declared on this playlist but never signed it as ${OWNER_ROLE}, so it cannot ${verb} it.`,
      message:
        `The feed treats a declared key as an owner only once it has also signed the stored document\n` +
        `  as "${OWNER_ROLE}". This one is named in curators[] but carries no such signature, so an\n` +
        `  intent signed with it would be refused.\n` +
        `  ${identityLabel(keySource)}\n` +
        `    ${signerDidKey}\n` +
        `  Keys that have proved ownership:\n` +
        `${proven.map((key) => `    ${key}`).join('\n')}\n` +
        `${retryAdvice(keySource, proven.length > 1)}\n` +
        `  The declaration cannot be upgraded after the fact: the proof would have to be a signature\n` +
        `  over the document as published.`,
    };
  }

  const source =
    keySource === 'supplied' ? 'The key you passed with --key is' : 'The configured signing key is';
  return {
    error: `${source} not an owner of this playlist, so it cannot ${verb} it.`,
    message:
      `Only a key the stored playlist names in curators[] AND that signed it as "${OWNER_ROLE}" can\n` +
      `  authorize a ${verb}; the feed derives ownership from the stored document, not from a local copy.\n` +
      `  ${identityLabel(keySource)}\n` +
      `    ${signerDidKey}\n` +
      `  Keys that have proved ownership:\n` +
      `${proven.map((key) => `    ${key}`).join('\n')}\n` +
      `${retryAdvice(keySource, proven.length > 1)}\n` +
      `  Ownership cannot be granted after the fact: the owner set is immutable, so a playlist signed\n` +
      `  by the wrong key stays that way.`,
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
 *
 * `keySource` matters here for the same reason it does locally: two of these messages talk about the
 * signing identity, and calling it "configured" when the operator passed `--key` describes a file this
 * run never read. Worse, after a 403 it reads as though the override had been dropped — which is
 * precisely the doubt an operator should not be left with when their key was used and refused.
 *
 * @param error - The failure thrown by the request
 * @param action - Which mutation was attempted
 * @param keySource - Where the signing identity came from
 */
export function describeFeedMutationError(
  error: unknown,
  action: 'delete' | 'replace',
  keySource: KeySource = 'configured'
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
        (keySource === 'supplied'
          ? `  The key passed with --key produced no signature the feed could read, which should not\n` +
            `  happen once it has been accepted locally — please report this.\n`
          : `  This usually means no signing key is configured: run "ff-cli status" to check, and\n` +
            `  "ff-cli setup" to generate one.\n`) +
        `  ${suffix.trim() || 'The feed gave no further detail.'}`,
    };
  }

  // A 403 that reaches here has already passed the local ownership proof: the key that signed was found
  // in the stored curators[] with a valid curator-role signature over the stored bytes. Repeating "your
  // key is not declared" would therefore be a lie, and it is the wrong place to send someone — the
  // remaining causes are the feed disagreeing about the stored document, or a replace touching the
  // owner set. Say that the feed refused, and that the local check disagreed.
  if (status === 403) {
    const which =
      keySource === 'supplied'
        ? 'the key you passed with --key is'
        : 'the configured signing key is';
    return {
      error: `${verb} refused by the feed: it did not accept the signing key as an owner.`,
      message:
        `The local check disagreed — ${which} named in the stored playlist's curators[]\n` +
        `  and carries a valid "${OWNER_ROLE}" signature over the stored document — so this is the feed's\n` +
        `  own judgement, not a missing declaration.\n` +
        (action === 'replace'
          ? `  For a replace the usual cause is the submitted document changing the owner set: curators[]\n` +
            `  is immutable, and altering it is refused as a forbidden write rather than as a bad field.\n`
          : '') +
        `  Otherwise the stored document changed since it was read; run the command again, and report it\n` +
        `  if it persists.${suffix}`,
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
