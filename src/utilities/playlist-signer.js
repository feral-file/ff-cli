/**
 * Playlist Signing Utility.
 * Uses the DP-1 v1.1.0 signing contract via the `dp1-js` package.
 */

const { getPlaylistConfig } = require('../config');
const { isDp1PlaylistSigningRole } = require('./playlist-signing-role');
const { parsePlaylistPrivateKeyToKeyObject } = require('./ed25519-key-derive');

/**
 * Normalize any supported signing-key encoding to base64 PKCS#8 DER, the form
 * dp1-js's signer expects. This makes hex seeds, base64 seeds, and PEM work for
 * signing (not just base64 PKCS#8), and replaces dp1-js's cryptic OpenSSL error
 * (e.g. "header too long") with actionable guidance when the key is malformed.
 *
 * @param {string} material - Raw key string from config or --key
 * @returns {string} base64-encoded PKCS#8 DER Ed25519 private key
 */
function normalizeSigningKeyToBase64Pkcs8(material) {
  let keyObject;
  try {
    keyObject = parsePlaylistPrivateKeyToKeyObject(material);
  } catch (error) {
    throw new Error(
      `Invalid Ed25519 signing key: ${error.message}. Provide a base64 PKCS#8 DER key ` +
        '(recommended), a 32-byte raw seed as hex or base64, or a PEM key. ' +
        'Run `ff-cli setup` to generate one.'
    );
  }
  return keyObject.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

/**
 * Sign a playlist using the DP-1 signing API.
 * The signed payload excludes any pre-existing signature fields so the output
 * is stable across re-signing and matches the library's canonical digest.
 *
 * @param {Object} playlist - Playlist object without signature
 * @param {string} [privateKeyBase64] - Ed25519 private key in hex or base64 format (optional, uses config if not provided)
 * @param {string} [roleOverride] - DP-1 signing role override (optional, uses config if not provided)
 * @returns {Promise<Object>} DP-1 signature envelope
 * @throws {Error} If private key is invalid or signing fails
 */
async function signPlaylist(playlist, privateKeyBase64, roleOverride) {
  // Get private key from config if not provided
  let privateKey = privateKeyBase64;
  if (!privateKey) {
    const config = getPlaylistConfig();
    privateKey = config.privateKey;
  }

  if (!privateKey) {
    throw new Error('Private key is required for signing');
  }

  try {
    const playlistToSign = { ...playlist };
    delete playlistToSign.signature;
    delete playlistToSign.signatures;

    const dp1 = await loadDp1();
    const raw = Buffer.from(JSON.stringify(playlistToSign));
    const config = getPlaylistConfig();
    const role = resolvePlaylistSigningRole(roleOverride || config.role);
    const normalizedKey = normalizeSigningKeyToBase64Pkcs8(privateKey);

    if (typeof dp1.SignMultiEd25519 === 'function') {
      return dp1.SignMultiEd25519(raw, normalizedKey, role, currentTimestamp());
    }

    throw new Error('dp1-js does not expose SignMultiEd25519');
  } catch (error) {
    throw new Error(`Failed to sign playlist: ${error.message}`);
  }
}

/**
 * Verify a playlist signature with the DP-1 verification API.
 *
 * @param {Object} playlist - Playlist object with signature field
 * @param {string} publicKeyHex - Ed25519 public key in hex format (with or without 0x prefix)
 * @returns {Promise<boolean>} True if signature is valid, false otherwise
 * @throws {Error} If verification process fails
 */
async function verifyPlaylist(playlist, publicKeyHex) {
  if (!publicKeyHex) {
    throw new Error('Public key is required for verification');
  }

  try {
    const dp1 = await loadDp1();
    const verifyFn = dp1.verifyPlaylist;
    if (typeof verifyFn !== 'function') {
      throw new Error('dp1-js does not expose verifyPlaylist');
    }

    const isValid = await verifyFn(playlist, publicKeyHex);
    return isValid;
  } catch (error) {
    throw new Error(`Failed to verify playlist signature: ${error.message}`);
  }
}

/**
 * Sign a playlist file
 * Reads playlist from file, signs it, and writes back
 *
 * @param {string} playlistPath - Path to playlist JSON file
 * @param {string} [privateKeyBase64] - Ed25519 private key in hex or base64 format (optional, uses config if not provided)
 * @param {string} [outputPath] - Output path (optional, overwrites input if not provided)
 * @param {string} [roleOverride] - DP-1 signing role override
 * @param {Object} [options] - Signing options
 * @param {boolean} [options.replaceSignatures=false] - Drop every existing signature and sign fresh
 * @returns {Promise<Object>} Result with signed playlist
 * @returns {boolean} returns.success - Whether signing succeeded
 * @returns {Object} [returns.playlist] - Signed playlist object
 * @returns {Array<Object>} [returns.dropped] - The stale entries that were discarded, classified
 * @returns {boolean} [returns.inPlace] - Whether the input file itself was overwritten
 * @returns {string|null} [returns.backupPath] - Where the pre-re-sign original was preserved, if it was
 * @returns {string} [returns.error] - Error message if failed
 */
async function signPlaylistFile(playlistPath, privateKeyBase64, outputPath, roleOverride, options) {
  const fs = require('fs');
  const path = require('path');

  try {
    // Read playlist file
    if (!fs.existsSync(playlistPath)) {
      throw new Error(`Playlist file not found: ${playlistPath}`);
    }

    const playlistContent = fs.readFileSync(playlistPath, 'utf-8');
    const playlist = JSON.parse(playlistContent);
    const config = getPlaylistConfig();
    // Presence, not truthiness. `--key ""` is what an unset shell variable expands to; treating it as
    // absent signs with the configured key while the user believes they supplied another one. The same
    // hazard the feed mutations were just fixed for, and the signature it produces is just as wrong.
    if (privateKeyBase64 !== undefined && String(privateKeyBase64).trim().length === 0) {
      throw new Error(
        'The --key value is empty. This usually means a shell variable did not expand ' +
          '(for example --key "$SIGNING_KEY" with SIGNING_KEY unset). Refusing rather than falling ' +
          'back to the configured key, which would sign under an identity you did not choose.'
      );
    }
    const privateKey = privateKeyBase64 !== undefined ? privateKeyBase64 : config.privateKey;
    const role = resolvePlaylistSigningRole(roleOverride || config.role);

    const validation = await validatePlaylistForSigning(playlist);
    if (!validation.valid) {
      throw new Error(`Playlist validation failed: ${validation.error}`);
    }

    const dp1 = await loadDp1();
    if (!privateKey) {
      throw new Error('Private key is required for signing');
    }
    const replaceSignatures = Boolean(options && options.replaceSignatures);
    const signedPlaylist = await buildSignedPlaylistEnvelope(
      playlist,
      privateKey,
      dp1,
      role,
      replaceSignatures
    );
    // Classify against the signature just produced: its `kid` is this key's identity, so no separate
    // derivation is needed to tell the signer's own entries from everyone else's.
    const signingKid = signedPlaylist.signatures[signedPlaylist.signatures.length - 1]?.kid;
    const dropped = replaceSignatures
      ? await describeDroppedSignatures(playlist, signingKid, dp1)
      : [];
    const verification = await verifySignedPlaylistEnvelope(signedPlaylist, dp1);
    if (!verification.valid) {
      throw new Error(`Signed playlist verification failed: ${verification.error}`);
    }

    const output = outputPath || playlistPath;
    const inPlace = path.resolve(output) === path.resolve(playlistPath);

    // Preserve the original BEFORE overwriting it, when overwriting is what destroys the only copy of
    // a signature this run cannot reproduce.
    //
    // The report tells the owner that a still-valid third-party signature was removed and that the
    // previous file is the way to get it back. On an in-place run that advice arrived after the file
    // was gone — the one case where the remedy was destroyed by the command giving it. Writing the
    // backup first makes the sentence true.
    //
    // Only for that case: a self signature is replaced by this run, an unverified one is not restorable
    // from the old file either, and an --output run leaves the input untouched. A backup in those cases
    // would be litter, and litter trains people to ignore the file that matters.
    let backupPath = null;
    if (inPlace && dropped.some((entry) => entry.kind === 'other' && entry.verified)) {
      backupPath = reserveBackupPath(fs, playlistPath);
      // The bytes as read, not a re-serialization: the signatures cover the exact document, so a
      // reformatted copy would not verify and would be a backup in name only.
      fs.writeFileSync(backupPath, playlistContent, 'utf-8');
    }

    fs.writeFileSync(output, JSON.stringify(signedPlaylist, null, 2), 'utf-8');

    console.log(`✓ Playlist signed and saved to: ${path.resolve(output)}`);

    return {
      success: true,
      playlist: signedPlaylist,
      dropped,
      inPlace,
      backupPath,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Describe the signatures `--replace-signatures` discards, so the output can name them.
 *
 * A count alone is not actionable on a co-curated playlist: the owner has to know whose signatures are
 * gone before they publish the replacement, not after someone notices their name missing.
 *
 * **There is no "void" verdict here, and that is deliberate.** Calling an entry void asserts that it
 * verified against the previous content and no longer does — a claim about a document this command has
 * never seen. The operator edited in place; the pre-edit bytes exist nowhere by the time `sign` runs.
 * A failed `VerifyMultiSignature` proves only that the entry does not verify against the document as it
 * stands, which is equally consistent with an edit, with an entry that was tampered with, and with one
 * that was never valid. So the verdict is exactly what can be checked: it verifies against this
 * document, or it does not.
 *
 * A flat legacy `signature` is a third case again — no `kid`, no `role`, and nothing the
 * multi-signature verifier can check — so it is reported as unverifiable rather than as a failure.
 *
 * It does not treat a `feed` role as "the feed's, so it comes back" either. Any key can emit a
 * signature carrying `role: "feed"`, and this CLI holds no feed identity to check a `kid` against.
 * Every non-self entry is reported as another key's, with its own role carried through — a document may
 * legitimately hold `agent`, `institution`, or `licensor` entries. That a feed re-appends its own
 * signature after verifying a replacement is stated separately, as the general fact it is.
 *
 * `kid` is reported as its last 8 characters: enough to match a curators[] row at a glance, with the
 * full value still in the file.
 *
 * @param {Object} playlist - The playlist as read, before signing
 * @param {string} [signingKid] - `did:key` of the key that just signed
 * @param {Object} dp1 - Loaded dp1-js module
 * @returns {Promise<Array<{kind: string, role: string|null, kid: string|null, verified: boolean, checkable: boolean, label: string}>>}
 */
async function describeDroppedSignatures(playlist, signingKid, dp1) {
  const dropped = [];
  const raw = Buffer.from(JSON.stringify(playlist));

  for (const entry of Array.isArray(playlist.signatures) ? playlist.signatures : []) {
    if (!entry) {
      continue;
    }
    const kid = typeof entry.kid === 'string' && entry.kid ? entry.kid : null;
    const role = typeof entry.role === 'string' && entry.role ? entry.role : null;
    const short = kid ? kid.slice(-8) : 'unknown';
    const descriptor = role ? `${role}, ...${short}` : `no role, ...${short}`;

    let verified = false;
    try {
      dp1.VerifyMultiSignature(raw, entry);
      verified = true;
    } catch {
      verified = false;
    }

    const own = Boolean(kid && signingKid && kid === signingKid);
    dropped.push({
      kind: own ? 'self' : 'other',
      role,
      kid,
      verified,
      checkable: true,
      label: own
        ? `your own earlier signature (${descriptor}) — replaced by this signing`
        : verified
          ? `another key's signature (${descriptor}) — removed; still valid over this content`
          : `another key's signature (${descriptor}) — removed; could not be verified against this document`,
    });
  }

  if (typeof playlist.signature === 'string' && playlist.signature.trim()) {
    // A legacy flat signature carries neither kid nor role, and the multi-signature verifier has
    // nothing to check it with. `checkable: false` keeps it out of both summaries: it is not a
    // signature that failed, it is one nothing here can judge.
    dropped.push({
      kind: 'other',
      role: null,
      kid: null,
      verified: false,
      checkable: false,
      label: 'a legacy flat signature (no kid, no role) — removed; not checkable here',
    });
  }

  return dropped;
}

/**
 * Choose a path for the pre-re-sign backup, never overwriting one that already exists.
 *
 * An existing `.before-resign.json` is somebody's only copy of an earlier document — quite possibly
 * from the previous run of this same command — so clobbering it to preserve the current one would
 * destroy exactly what the backup exists to protect. Later attempts are numbered instead.
 *
 * The suffix goes after the full filename rather than before the extension so it cannot collide with a
 * real playlist, and so `playlist.json` and `playlist.backup.json` produce different names.
 *
 * @param {Object} fs - Node fs module
 * @param {string} playlistPath - Path of the file about to be overwritten
 * @returns {string} A path that does not yet exist
 */
function reserveBackupPath(fs, playlistPath) {
  const first = `${playlistPath}.before-resign.json`;
  if (!fs.existsSync(first)) {
    return first;
  }
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${playlistPath}.before-resign.${n}.json`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not reserve a backup path next to ${playlistPath}: too many .before-resign files already ` +
      'exist. Move or delete some, or sign with --output to leave the input untouched.'
  );
}

module.exports = {
  signPlaylist,
  verifyPlaylist,
  signPlaylistFile,
  // Exported for the feed-mutation intents: a delete/replace intent is signed with the same key
  // material as a playlist, so it must accept the same encodings and raise the same guidance when the
  // key is malformed. Duplicating the normalizer there would let the two paths drift.
  normalizeSigningKeyToBase64Pkcs8,
};

function resolvePlaylistSigningRole(role) {
  const candidate = typeof role === 'string' ? role.trim() : '';
  const effectiveRole = candidate || 'agent';

  if (!isDp1PlaylistSigningRole(effectiveRole)) {
    throw new Error(
      `Unsupported DP-1 playlist signing role "${effectiveRole}". Expected one of: agent, feed, curator, institution, licensor`
    );
  }

  return effectiveRole;
}

async function validatePlaylistForSigning(playlist) {
  const dp1 = await loadDp1();
  const parseFn = dp1.parseDP1Playlist;

  if (typeof parseFn !== 'function') {
    throw new Error('dp1-js does not expose parseDP1Playlist');
  }

  const result = parseFn(playlist);

  if (result && result.error) {
    return { valid: false, error: result.error.message };
  }

  return { valid: true };
}

/**
 * Produce a DP-1 v1.1.0 playlist object with a new multi-signature appended.
 * The digest uses JSON with top-level `signature` and `signatures` removed (same
 * as dp1-js/dp1-go §7.1); prior `signatures[]` entries are kept on the returned
 * object so repeated `sign` runs accumulate endorsements instead of replacing them.
 *
 * `replaceSignatures` discards them instead, and exists because appending is only
 * correct while the signed content is unchanged. Editing a signed document moves
 * bytes the earlier entries cover, so they become unverifiable — and this function's
 * caller verifies the whole envelope before writing, which means an edited document
 * cannot be re-signed at all without dropping them. That is the ordinary path for a
 * feed replace: fetch the published playlist, change a field, sign fresh, PUT.
 *
 * The feed's own `feed` entry is dropped by the same rule rather than as a special
 * case: it covers the pre-edit content too, and the feed appends a new one after it
 * verifies the replacement, so carrying the old one forward can only fail.
 *
 * @param {Object} playlist - Parsed playlist (may already include `signatures[]`)
 * @param {string} privateKey - Private key material forwarded to dp1-js
 * @param {Object} dp1 - Loaded dp1-js module
 * @param {string} role - DP-1 signing role
 * @param {boolean} [replaceSignatures=false] - Discard existing signatures instead of appending
 * @returns {Promise<Object>} Playlist with legacy `signature` cleared and merged `signatures[]`
 */
async function buildSignedPlaylistEnvelope(playlist, privateKey, dp1, role, replaceSignatures) {
  const playlistToSign = { ...playlist };
  delete playlistToSign.signature;
  delete playlistToSign.signatures;

  // Normalize to base64 PKCS#8 DER so any supported key encoding (hex/base64
  // seed, PEM) works and a malformed key surfaces a clear error instead of
  // dp1-js's cryptic OpenSSL ASN.1 failure ("header too long" / "wrong tag").
  const normalizedKey = normalizeSigningKeyToBase64Pkcs8(privateKey);

  const existingSignatures =
    !replaceSignatures && Array.isArray(playlist.signatures)
      ? playlist.signatures.filter((entry) => Boolean(entry))
      : [];

  if (typeof dp1.SignMultiEd25519 === 'function') {
    const signature = await dp1.SignMultiEd25519(
      Buffer.from(JSON.stringify(playlistToSign)),
      normalizedKey,
      role,
      currentTimestamp()
    );

    return {
      ...playlist,
      signature: undefined,
      signatures: [...existingSignatures, signature],
    };
  }

  throw new Error('dp1-js does not expose SignMultiEd25519');
}

/**
 * Verify a signed playlist envelope with dp1-js before it is persisted.
 * The sign command must only write outputs that the same verifier path accepts;
 * otherwise it can succeed while immediately generating a broken artifact.
 *
 * @param {Object} signedPlaylist - Playlist envelope with signatures attached
 * @param {Object} dp1 - Loaded dp1-js module
 * @returns {Promise<{ valid: boolean; error?: string }>} Verification result
 */
async function verifySignedPlaylistEnvelope(signedPlaylist, dp1) {
  const verifyFn = dp1.verifyPlaylist;

  if (typeof verifyFn !== 'function') {
    throw new Error('dp1-js does not expose verifyPlaylist');
  }

  const isValid = await verifyFn(signedPlaylist);
  if (!isValid) {
    return { valid: false, error: 'signed playlist is not verifiable' };
  }

  return { valid: true };
}

/**
 * Loads `dp1-js`; env overrides are not supported (see playlist-verifier).
 * Uses dynamic `import()` so the single-file release bundle inlines dp1-js
 * instead of leaving a runtime require that can't resolve.
 */
async function loadDp1() {
  return import('dp1-js');
}

function currentTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
