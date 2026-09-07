import axios, { AxiosError } from 'axios';
import fs from 'fs';
import type { Playlist } from '../types';
import { verifyPlaylist } from './playlist-verifier';

/**
 * DP-1 signature role that carries ownership of a playlist.
 *
 * Mirrors the feed's owner role for playlists (channels use `publisher`, which ff-cli does not publish).
 */
const OWNER_ROLE = 'curator';

interface PublishResult {
  success: boolean;
  playlistId?: string;
  message?: string;
  error?: string;
  feedServer?: string;
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
  try {
    // Step 1: Read and parse playlist file
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        error: `Playlist file not found: ${filePath}`,
      };
    }

    let playlist: Playlist;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      playlist = JSON.parse(content);
    } catch (_parseError) {
      return {
        success: false,
        error: `Invalid JSON in playlist file: ${filePath}`,
      };
    }

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
          `  signature from an undeclared key would not satisfy the feed. Start from the unsigned file\n` +
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
    if (
      declaredSignatures.length > 0 &&
      !declaredSignatures.some((sig) => sig.role === OWNER_ROLE)
    ) {
      const rolesUsed = [
        ...new Set(
          declaredSignatures
            .map((sig) => (typeof sig.role === 'string' ? sig.role.trim() : ''))
            .filter((role) => role.length > 0)
        ),
      ];
      const seen =
        rolesUsed.length > 0 ? rolesUsed.map((role) => `"${role}"`).join(', ') : 'no role';
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
          `The feed treats a key in curators[] as an owner only when that key also signed as "${OWNER_ROLE}".\n` +
          `  curators[] is already correct — only the role is missing, so add that signature to this file:\n` +
          `    ff-cli sign <file> -r ${OWNER_ROLE} --key <private key for a declared curator>\n` +
          `  Any key this playlist declares will do — you do not need the one that signed under the wrong\n` +
          `  role. Declared: ${eligibleList}\n` +
          `  It must be one of those. "sign" uses the configured key unless --key says otherwise, and a\n` +
          `  ${OWNER_ROLE} signature from an undeclared key leaves this same failure: the feed reads roles\n` +
          `  only from keys the document declares. Drop --key if a declared key is already your configured\n` +
          `  one, and confirm which identity a key carries with "ff-cli status --key <private key>".\n` +
          `  Signing appends, and the payload hash excludes signatures, so the existing entry stays valid\n` +
          `  and the document ends up carrying both. No unsigned copy is needed: you only have to start\n` +
          `  from one when changing signed content such as curators[] itself.`,
      };
    }

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
