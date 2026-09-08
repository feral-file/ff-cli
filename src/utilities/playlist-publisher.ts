import axios, { AxiosError } from 'axios';
import fs from 'fs';
import type { Playlist } from '../types';
import { verifyPlaylist } from './playlist-verifier';
import {
  OWNER_ROLE,
  buildReplaceIntent,
  describeFeedMutationError,
  documentPayloadHash,
  fetchStoredPlaylist,
  intentTimestamp,
  mutationSignerIdentity,
  ownershipPreflight,
  signIntent,
  storedOwnerKeys,
  type KeySource,
  type StoredPlaylist,
} from './feed-mutation';

interface PublishResult {
  success: boolean;
  playlistId?: string;
  message?: string;
  error?: string;
  feedServer?: string;
}

export interface ReplaceOptions {
  /** Signing key material for the authorization intent; falls back to the configured playlist key. */
  privateKey?: string;
  /** Where `privateKey` came from, so a refusal points at something the operator can change. */
  keySource?: KeySource;
}

/**
 * Publish a verified playlist to a DP-1 feed server
 *
 * Flow:
 * 1. Read and parse playlist file
 * 2. Verify the playlist signature before upload
 * 3. If valid, send the verified playlist to feed server
 * 4. Return result with playlist ID or error
 *
 * @param {string} filePath - Path to playlist JSON file
 * @param {string} feedServerUrl - Feed server base URL
 * @returns {Promise<Object>} Result with success status, playlistId, or error
 * @example
 * const result = await publishPlaylist('playlist.json', 'http://localhost:8787/api/v1');
 * if (result.success) {
 *   console.log(`Published with ID: ${result.playlistId}`);
 * } else {
 *   console.error(`Failed: ${result.error}`);
 * }
 */
export async function publishPlaylist(
  filePath: string,
  feedServerUrl: string
): Promise<PublishResult> {
  const loaded = readPlaylistFile(filePath);
  if ('failure' in loaded) {
    return loaded.failure;
  }
  const { playlist } = loaded;

  const refusal = await preflightPlaylistForUpload(playlist);
  if (refusal) {
    return refusal;
  }

  try {
    // Step 5: Send validated playlist to feed server.
    //
    // No auth header. The feed authorizes a create from the document's own signatures: it requires a
    // signature whose kid matches a key declared in the playlist's `curators[]`. An API key is neither
    // sent nor accepted -- the feed removed that path entirely -- so a playlist that is not self-signed
    // by a declared curator is rejected no matter what credentials accompany it.
    const response = await axios.post(`${feedServerUrl}/playlists`, playlist, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    const playlistId = response.data?.id || response.data?.uuid;

    if (response.status === 201 || response.status === 202) {
      return {
        success: true,
        playlistId,
        message: `Published to feed server (${response.status === 202 ? 'queued' : 'created'})`,
        feedServer: feedServerUrl,
      };
    }

    return {
      success: false,
      error: `Unexpected response status: ${response.status}`,
      feedServer: feedServerUrl,
    };
  } catch (error) {
    const axiosError = error as AxiosError;
    const errorMessage = axiosError.response?.data
      ? JSON.stringify(axiosError.response.data)
      : axiosError.message;

    return {
      success: false,
      error: `Failed to publish: ${errorMessage}`,
    };
  }
}

/**
 * Replace a playlist already stored on a DP-1 feed with a re-signed document.
 *
 * A `POST` of an id the feed already holds is a `409`; editing an existing playlist goes through `PUT`,
 * which is owner-bound, owner-immutable and replay-bound (dp1-feed-v2 `docs/api_design.md`, "PUT
 * (replace)"). The body is not the document alone but `{ document, authorization }`: an owner's document
 * signatures are public via `GET`, so a document on its own could be replayed to roll a playlist back to
 * an earlier version. The authorization intent carries a `payloadHash` binding it to these exact bytes
 * and a `created` inside the freshness window, both inside a signed payload, which is what a replayed
 * body cannot forge.
 *
 * Identity is validated, not substituted: `id`, `slug`, and `created` must equal the stored document's,
 * and the owner set may not change. Those three are checked locally first — the feed's answer is a bare
 * `400`, which does not say which field moved, and the usual cause is a rebuilt playlist that minted a
 * fresh `created` rather than an edited one.
 *
 * Flow:
 * 1. Read, verify, and preflight the document exactly as a create would.
 * 2. `GET` the stored playlist by the document's own id.
 * 3. Refuse locally on an identity change, an owner-set change, or a non-owner signing key.
 * 4. Sign an authorization intent bound to the document's payload hash.
 * 5. `PUT` both halves and report the outcome.
 *
 * @param filePath - Path to the fully re-signed playlist JSON file
 * @param feedServerUrl - Feed server base URL, including `/api/v1`
 * @param options - Optional signing-key override for the authorization intent
 * @returns Result with the replaced playlist id, or a diagnosis and a remedy
 * @example
 * const result = await replacePlaylist('playlist.json', 'https://feed.example.com/api/v1');
 */
export async function replacePlaylist(
  filePath: string,
  feedServerUrl: string,
  options: ReplaceOptions = {}
): Promise<PublishResult> {
  const loaded = readPlaylistFile(filePath);
  if ('failure' in loaded) {
    return loaded.failure;
  }
  const { playlist } = loaded;

  const refusal = await preflightPlaylistForUpload(playlist);
  if (refusal) {
    return refusal;
  }

  const documentId = typeof playlist.id === 'string' ? playlist.id.trim() : '';
  if (!documentId) {
    return {
      success: false,
      error: 'The playlist has no id, so there is nothing on the feed for it to replace.',
      message:
        'A replace targets an existing resource by its id. Publish it without --replace to create it.',
    };
  }

  // Presence, not truthiness: `--key ""` is an override that failed to expand, and falling back to the
  // configured key would sign someone else's replacement into place.
  let privateKey: string;
  let signerDidKey: string;
  try {
    ({ privateKey, didKey: signerDidKey } = mutationSignerIdentity(options.privateKey, 'replace'));
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  let stored: StoredPlaylist;
  try {
    stored = await fetchStoredPlaylist(feedServerUrl, documentId);
  } catch (error) {
    const described = describeFeedMutationError(error, 'replace');
    const missing = (error as { response?: { status?: number } }).response?.status === 404;
    return {
      success: false,
      ...described,
      // A 404 here is not the same failure as a 404 on the PUT itself: the operator asked to replace a
      // playlist this feed has never held, and the fix is to publish it instead of guessing at ids.
      ...(missing
        ? {
            error: `This feed has no playlist with id ${documentId}, so there is nothing to replace.`,
            message:
              'Publish it without --replace to create it. If it was deleted, the id is tombstoned and\n' +
              '  cannot be recreated — build the playlist again so it gets a new id.',
          }
        : {}),
      feedServer: feedServerUrl,
    };
  }

  const mismatch = replaceIdentityMismatch(playlist, stored);
  if (mismatch) {
    return { success: false, ...mismatch, feedServer: feedServerUrl };
  }

  const keySource: KeySource =
    options.keySource ?? (options.privateKey !== undefined ? 'supplied' : 'configured');
  const ownership = await ownershipPreflight(stored, signerDidKey, 'replace', keySource);
  if (ownership) {
    return { success: false, ...ownership, feedServer: feedServerUrl };
  }

  try {
    const created = intentTimestamp();
    const payloadHash = await documentPayloadHash(playlist);
    const storedSlug = typeof stored.slug === 'string' ? stored.slug : '';
    const intent = buildReplaceIntent(documentId, storedSlug, payloadHash, created);
    const signature = await signIntent(intent, privateKey);

    const response = await axios.put(
      `${feedServerUrl}/playlists/${encodeURIComponent(documentId)}`,
      { document: playlist, authorization: { ...intent, signatures: [signature] } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    if (response.status !== 200) {
      return {
        success: false,
        error: `Unexpected response status: ${response.status}`,
        feedServer: feedServerUrl,
      };
    }

    return {
      success: true,
      playlistId: response.data?.id || documentId,
      message: 'Replaced on feed server',
      feedServer: feedServerUrl,
    };
  } catch (error) {
    return {
      success: false,
      ...describeFeedMutationError(error, 'replace'),
      feedServer: feedServerUrl,
    };
  }
}

/**
 * replaceIdentityMismatch reports the immutable fields a replace would have changed.
 *
 * The feed compares `id`, `slug` and `created` against the stored row and holds the owner set fixed; any
 * disagreement is a `400` or `403` that names none of them. The common cause is a rebuilt document rather
 * than an edited one — `find`/`build` mint a fresh id, slug and `created` every run — so the remedy is to
 * edit the published document, not to rebuild it.
 *
 * `created` is compared as an instant because the feed does: two spellings of the same moment are equal.
 *
 * @returns The failure to report, or `null` when identity and ownership are unchanged
 */
function replaceIdentityMismatch(
  playlist: Playlist,
  stored: StoredPlaylist
): { error: string; message?: string } | null {
  const differences: string[] = [];

  const documentSlug = typeof playlist.slug === 'string' ? playlist.slug : '';
  const storedSlug = typeof stored.slug === 'string' ? stored.slug : '';
  if (documentSlug !== storedSlug) {
    differences.push(`    slug: stored "${storedSlug}", document "${documentSlug}"`);
  }

  const documentCreated = typeof playlist.created === 'string' ? playlist.created : '';
  const storedCreated = typeof stored.created === 'string' ? stored.created : '';
  if (!sameInstant(documentCreated, storedCreated)) {
    differences.push(`    created: stored "${storedCreated}", document "${documentCreated}"`);
  }

  const documentOwners = storedOwnerKeys(playlist as unknown as StoredPlaylist);
  const owners = storedOwnerKeys(stored);
  if (documentOwners.join(' ') !== owners.join(' ')) {
    differences.push(
      `    curators: stored [${owners.join(', ')}], document [${documentOwners.join(', ')}]`
    );
  }

  if (differences.length === 0) {
    return null;
  }

  // The remedy has to hand back a runnable sequence, and every step of it has to produce the input the
  // next one needs. `verify` was named here before and does not: it validates and prints a summary, so
  // someone following it literally ends up with no document to edit and a second dead end.
  const storedId = typeof stored.id === 'string' && stored.id ? stored.id : '<id>';
  return {
    error: 'The document changes fields a replace may not change.',
    message:
      `A replace keeps identity and ownership fixed: id, slug, and created must equal the stored\n` +
      `  document's, and the curators[] owner set is immutable.\n` +
      `${differences.join('\n')}\n` +
      `  Start from the published document, not a rebuilt one — "find" and "build" mint a new id, slug,\n` +
      `  and created every run, which is a new playlist rather than a replacement:\n` +
      `    ff-cli fetch ${storedId} -o playlist.json\n` +
      `    (edit the fields you meant to change)\n` +
      `    ff-cli sign playlist.json -r ${OWNER_ROLE} --replace-signatures\n` +
      `    ff-cli publish playlist.json --replace\n` +
      `  --replace-signatures is required after an edit: the fetched document's signatures cover the\n` +
      `  content as published, and signing appends rather than replacing.`,
  };
}

/** True when two RFC 3339 strings name the same instant, whatever their spelling. */
function sameInstant(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * readPlaylistFile reads and parses a playlist document from disk.
 *
 * Split out because both `publishPlaylist` and `replacePlaylist` start here and must answer identically:
 * a missing or malformed file is a local problem, and neither should reach the network to learn that.
 *
 * @param filePath - Path to a playlist JSON file
 * @returns The parsed playlist, or the failure to report
 */
function readPlaylistFile(filePath: string): { playlist: Playlist } | { failure: PublishResult } {
  if (!fs.existsSync(filePath)) {
    return { failure: { success: false, error: `Playlist file not found: ${filePath}` } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_parseError) {
    return { failure: { success: false, error: `Invalid JSON in playlist file: ${filePath}` } };
  }

  // Well-formed JSON is not yet a document. `null`, `[]`, `"text"` and numbers all parse cleanly, and
  // casting them straight to Playlist made the very next step — reading `playlist.signature` — throw a
  // TypeError from inside a helper that sits outside both public entry points' try/catch. The caller
  // asked for a PublishResult and got an exception instead, so a stray file answered with a stack
  // trace rather than a diagnosis. Both verbs must fail here, structurally, as they do for bad JSON.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const found = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed;
    return {
      failure: {
        success: false,
        error: `Playlist file does not contain a playlist document: ${filePath}`,
        message:
          `The file is valid JSON but holds ${found}, not an object. A DP-1 playlist is a JSON object\n` +
          `  with dpVersion, id, title, and items at the top level.`,
      },
    };
  }

  return { playlist: parsed as Playlist };
}

/**
 * preflightPlaylistForUpload runs every local gate a document must pass before it is sent to a feed.
 *
 * Create and replace share this entirely: both are authorized by the document's own signatures, and both
 * need a `curator`-role signature from a declared key. Keeping one implementation is what stops the two
 * verbs from drifting into different diagnoses for the same broken document — a replace that accepted a
 * document `publish` refuses would let exactly the unauthorizable state this guards against back in.
 *
 * @param playlist - Parsed playlist document
 * @returns The failure to report, or `null` when the document may be sent
 */
async function preflightPlaylistForUpload(playlist: Playlist): Promise<PublishResult | null> {
  // Step 2: refuse legacy flat-signature documents outright, before verification.
  //
  // A flat `signature` string carries no kid, so the curator rule below has nothing to match and such
  // a document would reach the feed only to be refused as unauthenticated — verified against a running
  // feed. This runs ahead of verification deliberately: the document is unpublishable whether or not
  // its legacy signature is valid, and 're-sign as a v1.1 envelope' is the remedy either way, which
  // 'signature verification failed' would not convey.
  const hasLegacyFlatSignature =
    typeof (playlist as { signature?: unknown }).signature === 'string' &&
    (playlist as unknown as { signature: string }).signature.trim().length > 0;
  const hasEnvelope = Array.isArray((playlist as { signatures?: unknown }).signatures)
    ? ((playlist as unknown as { signatures: unknown[] }).signatures ?? []).length > 0
    : false;
  if (!hasEnvelope && hasLegacyFlatSignature) {
    return {
      success: false,
      error: 'Playlist carries a legacy flat signature, which the feed cannot authorize.',
      message:
        `The feed authorizes a publish from a signatures[] envelope, matching a signature's kid\n` +
        `  against the playlist's own curators[]. A flat "signature" string carries no kid.\n` +
        `  Re-sign it as a DP-1 v1.1 envelope:\n` +
        `    1. remove the "signature" field\n` +
        `    2. declare your key: "curators": [{ "name": "Your name", "key": "<did:key from ff-cli status>" }]\n` +
        `    3. ff-cli sign <file> -r ${OWNER_ROLE}\n` +
        `  The role matters: a declared key counts as an owner only when it also signed as "${OWNER_ROLE}",\n` +
        `  and plain "ff-cli sign" uses playlist.role, which defaults to "agent".`,
    };
  }

  // Step 3: Verify signature integrity before publishing.
  const deliveryResult = await verifyPlaylist(playlist);

  if (!deliveryResult.valid) {
    return {
      success: false,
      error: `Playlist verification failed: ${deliveryResult.error}`,
      message: deliveryResult.details?.map((d) => `  • ${d.path}: ${d.message}`).join('\n'),
    };
  }

  // Step 4: fail here, not at the feed, when the signer is not declared as a curator.
  //
  // The feed accepts a create only when a signature's `kid` matches a key the document declares in
  // `curators[]`. Signing alone does not satisfy that, and the server's answer — "no valid curator
  // signature found" — reads as a signing problem, which sends people to check their key instead of
  // their document. Checking locally turns a confusing 400 into an instruction, and costs no request.
  const curatorKeys = new Set(
    (Array.isArray((playlist as { curators?: unknown }).curators)
      ? ((playlist as unknown as { curators: Array<{ key?: unknown }> }).curators ?? [])
      : []
    )
      .map((c) => (typeof c?.key === 'string' ? c.key.trim() : ''))
      .filter((k) => k.length > 0)
  );
  const signatures = Array.isArray((playlist as { signatures?: unknown }).signatures)
    ? ((playlist as unknown as { signatures: Array<{ kid?: unknown; role?: unknown }> })
        .signatures ?? [])
    : [];
  const signingKids = signatures
    .map((sig) => (typeof sig?.kid === 'string' ? sig.kid.trim() : ''))
    .filter((k) => k.length > 0);
  const declaredSignatures = signatures.filter((sig) =>
    curatorKeys.has(typeof sig?.kid === 'string' ? sig.kid.trim() : '')
  );
  // Same predicate as `no declared signature`, expressed through the set the next gate also needs.
  if (signingKids.length > 0 && declaredSignatures.length === 0) {
    return {
      success: false,
      error: 'Playlist is signed, but the signing key is not declared as a curator.',
      message:
        `The feed accepts a publish when a signature's kid appears in the playlist's own curators[].\n` +
        `  Add this to the playlist before signing:\n` +
        `    "curators": [{ "name": "Your name", "key": "${signingKids[0]}" }]\n` +
        `  then sign again from the unsigned file, with the same key you just declared:\n` +
        `    ff-cli sign <file> -r ${OWNER_ROLE} --key <private key for ${signingKids[0]}>\n` +
        `  Drop --key if that key is your configured one; "sign" uses the configured key otherwise, and a\n` +
        `  signature from an undeclared key would not satisfy the feed. The role is ff-cli's requirement\n` +
        `  rather than every feed's: see the owner-role check for why publishing without it is refused.\n` +
        `  Start from the unsigned file\n` +
        `  because declaring curators[] changes the signed payload: signing appends, so the earlier\n` +
        `  signature would be left covering a document that no longer exists.`,
    };
  }

  // Step 4b: a declared key must also have signed AS curator.
  //
  // Being named in curators[] is a claim; signing in the owner role is the proof, and the feed requires
  // both before it treats a key as an owner. A document that is declared but signed under another role
  // (ff-cli's own default was `agent`) verifies cleanly and is still refused, and the server answers in
  // terms of ownership — which reads as "fix curators[]", the one part that is already correct. Naming
  // the role and the remedy here is the difference between a one-flag fix and a wrong-end search.
  //
  // This is deliberately stricter than a feed that ignores the role: such a feed accepts the document
  // today and freezes it the moment role-aware ownership lands, because a replace and a delete both
  // need an owner signature the document does not carry. Refusing now keeps that document from being
  // created at all.
  if (declaredSignatures.length > 0 && !declaredSignatures.some((sig) => sig.role === OWNER_ROLE)) {
    const rolesUsed = [
      ...new Set(
        declaredSignatures
          .map((sig) => (typeof sig.role === 'string' ? sig.role.trim() : ''))
          .filter((role) => role.length > 0)
      ),
    ];
    const seen = rolesUsed.length > 0 ? rolesUsed.map((role) => `"${role}"`).join(', ') : 'no role';
    // List every key eligible to repair this, not the one that happens to have signed.
    //
    // The gate above accepts an owner-role signature from ANY declared key, so on a playlist declaring
    // several curators the holder of any one of them can append it. Naming only the key that signed
    // under the wrong role describes an impossible fix to everyone else — they may not hold it — while
    // a key they do hold would have worked. `sign` still defaults to the configured key, which need not
    // be declared at all, so the eligible set has to be stated rather than assumed.
    const eligibleKeys = [...curatorKeys];
    const eligibleList =
      eligibleKeys.length > 0 ? eligibleKeys.join(', ') : 'a key declared in curators[]';
    return {
      success: false,
      error: `Playlist is signed by a declared curator, but under a non-owner role (${seen}).`,
      message:
        `This is ff-cli's check, not a feed's answer. Feeds are moving to role-aware ownership, where\n` +
        `  a key in curators[] counts as an owner only if it also signed as "${OWNER_ROLE}". A feed that\n` +
        `  does not check the role yet will accept this document, and then be unable to authorize a\n` +
        `  replace or a delete for it: both need an owner signature it does not carry. Publishing it is\n` +
        `  what makes that permanent, so ff-cli refuses here instead.\n` +
        `\n` +
        `  curators[] is already correct — only the role is missing, so add that signature to this file:\n` +
        `    ff-cli sign <file> -r ${OWNER_ROLE} --key <private key for a declared curator>\n` +
        `  Any key this playlist declares will do — you do not need the one that signed under the wrong\n` +
        `  role. Declared: ${eligibleList}\n` +
        `  It must be one of those: a ${OWNER_ROLE} signature from an undeclared key satisfies neither\n` +
        `  this check nor role-aware ownership, since both read roles only from declared keys. "sign"\n` +
        `  uses the configured key unless --key says otherwise; drop --key if a declared key is already\n` +
        `  your configured one, and confirm which identity a key carries with\n` +
        `  "ff-cli status --key <private key>".\n` +
        `  Signing appends, and the payload hash excludes signatures, so the existing entry stays valid\n` +
        `  and the document ends up carrying both. No unsigned copy is needed: you only have to start\n` +
        `  from one when changing signed content such as curators[] itself.`,
    };
  }

  return null;
}
