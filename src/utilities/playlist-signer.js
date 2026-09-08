/**
 * Playlist Signing Utility.
 * Uses the DP-1 v1.1.0 signing contract via the `dp1-js` package.
 */

const { getPlaylistConfig } = require('../config');
const { isDp1PlaylistSigningRole } = require('./playlist-signing-role');
const { parsePlaylistPrivateKeyToKeyObject } = require('./ed25519-key-derive');
const { isSameFileForDirectWrite } = require('./same-file');

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
 * @param {Object} [options.fs] - Filesystem module override, for tests
 * @returns {Promise<Object>} Result with signed playlist
 * @returns {boolean} returns.success - Whether signing succeeded
 * @returns {Object} [returns.playlist] - Signed playlist object
 * @returns {Array<Object>} [returns.dropped] - The stale entries that were discarded, classified
 * @returns {boolean} [returns.inPlace] - Whether the input file itself was overwritten
 * @returns {string|null} [returns.backupPath] - Where the pre-re-sign original was preserved, if it was
 * @returns {string} [returns.error] - Error message if failed
 */
async function signPlaylistFile(playlistPath, privateKeyBase64, outputPath, roleOverride, options) {
  // One fs handle for every filesystem call in this function, so a test can record the ORDER of the
  // backup and the source write. That order is the whole guarantee: a backup synced after the source
  // was truncated protects nothing, and no assertion about either write alone can catch it.
  const fs = (options && options.fs) || require('fs');
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
    // Classify against the signature just produced: its `kid` and `role` are what this run actually
    // asserted, so no separate derivation is needed to tell which entries it supersedes.
    const fresh = signedPlaylist.signatures[signedPlaylist.signatures.length - 1];
    const dropped = replaceSignatures
      ? await describeDroppedSignatures(playlist, fresh?.kid, fresh?.role, dp1)
      : [];
    const verification = await verifySignedPlaylistEnvelope(signedPlaylist, dp1);
    if (!verification.valid) {
      throw new Error(`Signed playlist verification failed: ${verification.error}`);
    }

    const output = outputPath || playlistPath;
    // Filesystem identity, not path equality: an --output pointing at a symlink or a hard link of the
    // input is the same inode, and a string comparison calls it a different file — so no backup was
    // written and the report claimed the input was untouched while the write went straight through it.
    const inPlace = isSameFileForDirectWrite(output, playlistPath);

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
    if (inPlace && dropped.some((entry) => entry.kind !== 'replaced' && entry.verified)) {
      // The bytes as read, not a re-serialization: the signatures cover the exact document, so a
      // reformatted copy would not verify and would be a backup in name only.
      backupPath = writeBackup(fs, playlistPath, playlistContent);
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
 * **An entry counts as replaced only when the fresh signature matches it in BOTH `kid` and `role`.**
 * Matching on the key alone was wrong in a way that quietly produced unpublishable documents: re-signing
 * as `agent` with a key that had signed as `curator` dropped the curator entry, called it "replaced",
 * and left it out of the backup — and the result then fails the publisher's declared-curator preflight,
 * with nothing left on disk to recover the lost signature from. Ownership lives in the role as much as
 * in the key, so a role change is a loss like any other.
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
 * Non-replaced entries are reported as removed, with their own role carried through — a document may
 * legitimately hold `agent`, `institution`, or `licensor` entries. That a feed re-appends its own
 * signature after verifying a replacement is stated separately, as the general fact it is.
 *
 * `kid` is reported as its last 8 characters: enough to match a curators[] row at a glance, with the
 * full value still in the file.
 *
 * @param {Object} playlist - The playlist as read, before signing
 * @param {string} [signingKid] - `did:key` of the key that just signed
 * @param {string} [signingRole] - DP-1 role the fresh signature asserts
 * @param {Object} dp1 - Loaded dp1-js module
 * @returns {Promise<Array<{kind: string, sameKey: boolean, claimsSigningKey: boolean, role: string|null, kid: string|null, verified: boolean, checkable: boolean, label: string}>>}
 */
async function describeDroppedSignatures(playlist, signingKid, signingRole, dp1) {
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

    // A `kid` and a `role` are claims the entry makes about itself, and nothing in a document stops an
    // attacker — or a corrupted file — from copying the signer's own. Only a signature that verifies
    // has established whose it is, so an unverified entry is never credited as this key's, and never
    // reported as replaced. Otherwise a forged entry carrying the signing key's kid and role would be
    // labelled "your own earlier signature, replaced" and vanish from the unverified summary, which is
    // precisely where a tampered signature most needs to appear.
    const claimsSigningKey = Boolean(kid && signingKid && kid === signingKid);
    const sameKey = verified && claimsSigningKey;
    const replaced = sameKey && role === signingRole;

    const outcome = verified
      ? 'removed; still valid over this content'
      : 'removed; could not be verified against this document';

    let label;
    if (replaced) {
      label = `your own earlier signature (${descriptor}) — replaced by this signing`;
    } else if (sameKey) {
      // Same key, different role. Naming it as another key's would be wrong, and naming it as replaced
      // would be worse: this run asserts a different role, so the entry is gone and not reinstated.
      label = `your signature in another role (${descriptor}) — ${outcome}`;
    } else if (claimsSigningKey) {
      // Carries this key's kid but does not verify, so whose it is was never established. Said as the
      // claim it is: asserting it IS yours would credit a possible forgery, and asserting it is
      // someone else's would misdescribe the ordinary case where you edited the document after signing.
      label = `a signature claiming your key (${descriptor}) — ${outcome}`;
    } else {
      label = `another key's signature (${descriptor}) — ${outcome}`;
    }

    dropped.push({
      kind: replaced ? 'replaced' : 'other',
      sameKey,
      claimsSigningKey,
      role,
      kid,
      verified,
      checkable: true,
      label,
    });
  }

  if (typeof playlist.signature === 'string' && playlist.signature.trim()) {
    // A legacy flat signature carries neither kid nor role, and the multi-signature verifier has
    // nothing to check it with. `checkable: false` keeps it out of both summaries: it is not a
    // signature that failed, it is one nothing here can judge.
    dropped.push({
      kind: 'other',
      sameKey: false,
      claimsSigningKey: false,
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
 * Write the pre-re-sign backup, with the same care the file it copies already had.
 *
 * The backup exists because `--replace-signatures` discards signatures this command cannot reproduce,
 * so it has to be at least as safe as the document it preserves. Four properties, and the last three
 * are the same ones `enrich`'s atomic write establishes for its temporary file — this is that pattern,
 * applied to a direct write rather than a rename.
 *
 * **It never overwrites.** An existing `.before-resign.json` is somebody's only copy too — quite
 * possibly from the previous run of this command. `'wx'` claims the name atomically, so a collision
 * costs a retry rather than a file, and `existsSync`-then-write cannot lose one to a concurrent
 * creator.
 *
 * **It carries the source's mode**, applied at create time rather than chmod'ed afterwards so no window
 * exists where the bytes sit at wider permissions. `fchmod` follows because `open` filters the mode
 * through umask and `fchmod` does not.
 *
 * **It carries the source's ownership.** A new file takes this process's uid and gid, so a
 * `0640 alice:curators` playlist re-signed by someone whose primary group differs becomes
 * `0640 bob:users` — the mode is preserved and the access is still wider, which is the failure mode a
 * mode-only copy hides. When ownership cannot be reproduced the backup is removed and the in-place
 * re-sign is refused, rather than completed against a copy that leaks.
 *
 * **It is durable before the source is touched.** Data and directory entry are both synced here, so a
 * crash between the two writes cannot leave the backup unwritten and the source already overwritten.
 *
 * A source that cannot be stat-ed is a refusal for the same reason: with no mode and no ownership to
 * copy, the only alternative is a default-mode backup, which is precisely the disclosure this guards
 * against. `--output` is the way through in every refusal — it leaves the input untouched, so no backup
 * is needed at all.
 *
 * @param {Object} fs - Node fs module (injectable for tests)
 * @param {string} playlistPath - Path of the file about to be overwritten
 * @param {string} contents - Exact bytes to preserve
 * @param {{uid: number|undefined, gid: number|undefined}} [identity] - POSIX identity of this process,
 *   for tests; defaults to `process.getuid()`/`getgid()`, which are undefined off POSIX
 * @returns {string} The path written
 * @throws {Error} When the source cannot be stat-ed, or its ownership cannot be reproduced
 */
function writeBackup(fs, playlistPath, contents, identity) {
  const path = require('path');

  // Read mode and ownership before the file is replaced. Without them there is nothing to reproduce,
  // and a default-mode copy of a restricted document is worse than not running.
  let source;
  try {
    source = fs.statSync(playlistPath);
  } catch (error) {
    throw new Error(
      `Cannot read the permissions of ${playlistPath} (${error.message}), so the copy this re-sign ` +
        'would leave behind could be readable by users the original was not. Refusing to replace it ' +
        'in place. Use --output to write the signed playlist elsewhere, which leaves the input — and ' +
        'the signatures on it — untouched.'
    );
  }
  const mode = source.mode & 0o7777;

  // Only where POSIX identity exists. Windows has no getuid/getgid and reports uid and gid as 0 on
  // every stat, so the comparison there would always "differ" and chown a file whose ownership never
  // moved. (libuv makes fchown a no-op on Windows, so nothing would break — but the branch would be
  // asserting something it cannot know.)
  //
  // Injectable so the refusal path can be exercised wherever the tests run. Reading `process` directly
  // made this branch unreachable on Windows, which is correct behaviour and a test that silently
  // asserted nothing there — the coverage disappeared on exactly the platform least like the author's.
  const uid = identity ? identity.uid : process.getuid?.();
  const gid = identity ? identity.gid : process.getgid?.();
  const mustChown =
    uid !== undefined && gid !== undefined && (source.uid !== uid || source.gid !== gid);

  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate =
      attempt === 1
        ? `${playlistPath}.before-resign.json`
        : `${playlistPath}.before-resign.${attempt}.json`;

    let fd;
    try {
      fd = fs.openSync(candidate, 'wx', mode);
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        continue;
      }
      throw error;
    }

    let settled = false;
    try {
      try {
        fs.fchmodSync(fd, mode);
      } catch {
        // Windows supports only the write bit here. A backup that exists with approximate permissions
        // beats refusing to preserve the document at all.
      }

      if (mustChown) {
        try {
          fs.fchownSync(fd, source.uid, source.gid);
        } catch (error) {
          throw new Error(
            `Cannot give ${candidate} the same owner as ${playlistPath} (${error.message}). The copy ` +
              'would belong to you instead, which can widen who is able to read it. Refusing to ' +
              'replace the playlist in place. Use --output to write the signed playlist elsewhere, ' +
              'which leaves the input — and the signatures on it — untouched.'
          );
        }
      }

      fs.writeFileSync(fd, contents, 'utf-8');
      // Durability before the source is truncated, not after. Without this a crash in the window
      // between the two writes loses the backup AND the original — the one outcome the backup exists
      // to make impossible.
      fs.fsyncSync(fd);
      settled = true;
    } finally {
      fs.closeSync(fd);
      if (!settled) {
        // A partial or wrongly-owned backup is worse than none: it looks like a safe copy.
        try {
          fs.rmSync(candidate, { force: true });
        } catch {
          // Nothing further to try; the error being thrown is the one that matters.
        }
      }
    }

    syncDirectoryEntry(fs, path.dirname(candidate));
    return candidate;
  }

  throw new Error(
    `Could not reserve a backup path next to ${playlistPath}: too many .before-resign files already ` +
      'exist. Move or delete some, or sign with --output to leave the input untouched.'
  );
}

/**
 * syncDirectoryEntry flushes a directory so a newly created name survives power loss.
 *
 * Best-effort by design, as in `enrich`: directory fsync is not portable — Windows rejects it outright
 * — and a durability barrier that cannot be raised is not a reason to fail a write that has already
 * succeeded. The data itself was synced first, so the worst case is the name missing after a crash,
 * not a truncated backup.
 *
 * @param {Object} fs - Node fs module
 * @param {string} directory - Directory holding the new entry
 */
function syncDirectoryEntry(fs, directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
  } catch {
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    // Not portable; see above.
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Nothing to do.
    }
  }
}

module.exports = {
  signPlaylist,
  verifyPlaylist,
  signPlaylistFile,
  // Exported for the feed-mutation intents: a delete/replace intent is signed with the same key
  // material as a playlist, so it must accept the same encodings and raise the same guidance when the
  // key is malformed. Duplicating the normalizer there would let the two paths drift.
  normalizeSigningKeyToBase64Pkcs8,
  // Exported for tests: the backup's guarantees (never overwrite, exclusive create, source mode) are
  // the point of it, and they are far easier to pin directly than through a signing run.
  writeBackup,
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
