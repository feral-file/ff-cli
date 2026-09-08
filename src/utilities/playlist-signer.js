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
 * @param {boolean} [options.force=false] - Overwrite a destination holding a different document
 * @param {Object} [options.fs] - Filesystem module override, for tests
 * @returns {Promise<Object>} Result with signed playlist
 * @returns {boolean} returns.success - Whether signing succeeded
 * @returns {Object} [returns.playlist] - Signed playlist object
 * @returns {Array<Object>} [returns.dropped] - The stale entries that were discarded, classified
 * @returns {boolean} [returns.inPlace] - Whether the input file itself was overwritten
 * @returns {string} [returns.error] - Error message if failed
 */
async function signPlaylistFile(playlistPath, privateKeyBase64, outputPath, roleOverride, options) {
  // One fs handle for every filesystem call in this function, so a test can record the ORDER of the
  // backup and the source write. That order is the whole guarantee: a backup synced after the source
  // was truncated protects nothing, and no assertion about either write alone can catch it.
  const fs = (options && options.fs) || require('fs');
  const path = require('path');

  // Hold the source open for the whole call, and read its bytes through that descriptor.
  //
  // Everything downstream — the parsed document, the signature classification, the decision about what
  // may be discarded — describes the file that was READ. Looking the path up again later to decide
  // whether the output is that file compares against whatever is at the name now, so an atomic
  // replacement in between lets a classification of one document authorize truncating another. The
  // descriptor pins the identity the rest of the call is reasoning about.
  let sourceFd;
  const output = outputPath || playlistPath;
  let createdOutput = false;
  let wrote = false;
  try {
    sourceFd = fs.openSync(playlistPath, fs.constants.O_RDONLY);
  } catch (openError) {
    return {
      success: false,
      error:
        openError && openError.code === 'ENOENT'
          ? `Playlist file not found: ${playlistPath}`
          : openError.message,
    };
  }

  try {
    const sourceBytes = readAllFrom(fs, sourceFd);
    const sourceDigest = digestOf(sourceBytes);
    const playlistContent = sourceBytes.toString('utf-8');
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
    const force = Boolean(options && options.force);
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

    // Bind the output to a descriptor BEFORE deciding whether it is the input, and write through that
    // same descriptor. Checking a path and then writing to it is two lookups, and in a shared
    // directory they can disagree: an --output that does not exist when it is checked can be a symlink
    // to the input by the time it is written, so the refusal below never fires and the write follows
    // the link into the input while the report calls it untouched. A descriptor cannot be re-pointed.
    //
    // Only ever truncate bytes this command has inspected.
    //
    // Every earlier version answered "is the output the input?" with file identity — inode, name,
    // realpath — and every one of them lost to the same shape of race: a path can be re-pointed
    // between any two syscalls, so a stat taken before the write says nothing about what the write
    // will land on. Identity is the wrong question. What matters is not whether two names refer to one
    // file but whether the bytes about to be destroyed are the bytes that were read and classified.
    //
    // So the output descriptor is read back and digested, and the comparison is against the digest of
    // the source. Equal means this IS the inspected document, however the name got here, and the
    // discard rules apply to it. Unequal means the destination holds something never looked at, which
    // is refused rather than guessed about. Neither answer depends on a name staying still.
    //
    // O_CREAT|O_EXCL first: a success proves the file did not exist a moment ago, so it holds nothing
    // to preserve and nothing to compare. On EEXIST the retry keeps O_CREAT so a dangling symlink gets
    // its target created, and adds O_RDWR because the destination now has to be read back.
    //
    // No O_TRUNC anywhere: nothing is destroyed before the decision.
    let fd;
    try {
      fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      createdOutput = true;
    } catch (openError) {
      if (!openError || openError.code !== 'EEXIST') {
        throw openError;
      }
      try {
        fd = fs.openSync(output, fs.constants.O_RDWR | fs.constants.O_CREAT);
      } catch (retryError) {
        if (retryError && retryError.code === 'EACCES') {
          // The destination has to be read back before it can be destroyed, so a write-only file that
          // already exists is no longer a usable target. Worth saying, because the errno alone reads
          // like a bug rather than a rule.
          throw new Error(
            `Cannot read ${output} to check what it holds (${retryError.message}). A destination that ` +
              'already exists is read before it is overwritten, so it needs read permission. Write to ' +
              'a new name instead.'
          );
        }
        throw retryError;
      }
    }

    try {
      // `inPlace` now means "this descriptor holds the document that was read", which is the only
      // sense the discard rules ever needed.
      let inPlace = false;
      let overwroteAnother = false;

      if (!createdOutput) {
        const outputBytes = readAllFrom(fs, fd);
        const outputDigest = digestOf(outputBytes);
        inPlace = outputDigest === sourceDigest;

        // An empty destination holds nothing to destroy, so there is nothing for the rule to protect.
        // This is how a dangling symlink is written: O_EXCL will not follow the link, so the retry
        // creates the target and cannot prove it did — but the file it opened is provably empty, which
        // answers the same question the proof would have.
        const empty = outputBytes.length === 0;

        if (inPlace) {
          // Refuse rather than overwrite a signature only its holder could reproduce. The invariant is
          // that a still-valid endorsement from another key is never destroyed in place; scoped to what
          // cannot be recovered, since your own entry is replaced by this run and an unverified one was
          // not restorable from the input either.
          const unrecoverable = dropped.filter(
            (entry) => entry.kind !== 'replaced' && entry.verified && !entry.sameKey
          );
          if (unrecoverable.length > 0) {
            const count = unrecoverable.length;
            throw new Error(
              `This would discard ${count} still-valid signature${count === 1 ? '' : 's'} from ` +
                'other keys. Write the result elsewhere so the original stays:\n' +
                `    ff-cli sign ${playlistPath} -r ${role} --replace-signatures --output <new file>`
            );
          }
        } else if (!empty && !force) {
          // Something is there and it is not what was signed. Overwriting it would destroy a document
          // this command never read, which no flag combination should do silently.
          throw new Error(
            `${output} already exists and is not the playlist being signed; choose a new name, or ` +
              'pass --force to overwrite it.'
          );
        } else if (!empty) {
          overwroteAnother = true;
        }
      }

      // Truncate only now, past every refusal, through the descriptor whose contents were just read.
      fs.ftruncateSync(fd, 0);
      writeAll(fs, fd, Buffer.from(JSON.stringify(signedPlaylist, null, 2), 'utf-8'));
      // Durable before the success line prints: a report of a file that is not on disk is a lie the
      // operator has no way to detect.
      fs.fsyncSync(fd);
      wrote = true;

      console.log(`✓ Playlist signed and saved to: ${path.resolve(output)}`);

      return {
        success: true,
        playlist: signedPlaylist,
        dropped,
        inPlace,
        overwroteAnother,
        outputPath: path.resolve(output),
      };
    } finally {
      // Close, and nothing else. An earlier version removed the empty file a refusal had created, by
      // name — and a name is exactly what this whole function stopped trusting. Between the close and
      // the unlink the name can be another file, and deleting somebody else's document to tidy up
      // after ourselves is a far worse outcome than the litter it was avoiding. The failure path says
      // what may be there instead, and leaves it.
      fs.closeSync(fd);
    }
  } catch (error) {
    return {
      success: false,
      // Said only when this call created the file, which O_EXCL told us for certain. Anything else
      // would be a guess about a name we no longer hold open, and the point of saying it at all is so
      // an operator is not surprised by a zero-byte playlist we deliberately did not remove.
      error:
        createdOutput && !wrote
          ? `${error.message}\n  An incomplete output may remain at ${output}.`
          : error.message,
    };
  } finally {
    try {
      fs.closeSync(sourceFd);
    } catch {
      // Nothing to do; the result has already been decided.
    }
  }
}

/**
 * readAllFrom reads a descriptor from byte zero, without depending on or moving its file offset.
 *
 * Positioned reads are used throughout so the same descriptor can be read twice — once for the
 * document and once to check it has not changed — with no seek between them.
 *
 * @param {Object} fs - Node fs module
 * @param {number} fd - Descriptor open for reading
 * @returns {Buffer} Everything the descriptor holds
 */
function readAllFrom(fs, fd) {
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  for (;;) {
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (!(bytes > 0)) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
    position += bytes;
  }
  return Buffer.concat(chunks);
}

/** Content digest, the only comparison that answers "are these the same bytes". */
function digestOf(buffer) {
  return require('crypto').createHash('sha256').update(buffer).digest('hex');
}

/**
 * writeAll writes every byte of `buffer` to `fd`, or throws.
 *
 * `write(2)` may write fewer bytes than asked — a short write is not an error, it is the contract — and
 * the return value was being ignored. Since this runs immediately after truncating the destination, a
 * short write left a partial document on disk under a "Playlist signed" report: the one failure the
 * operator cannot see, because the command said it succeeded.
 *
 * @param {Object} fs - Node fs module
 * @param {number} fd - Descriptor open for writing
 * @param {Buffer} buffer - Bytes to write
 * @throws {Error} If the descriptor stops accepting bytes before the buffer is exhausted
 */
function writeAll(fs, fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
    if (!(written > 0)) {
      throw new Error(
        `Wrote only ${offset} of ${buffer.length} bytes; the file on disk is incomplete. ` +
          'Re-run the command, and check the destination has space and is writable.'
      );
    }
    offset += written;
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
