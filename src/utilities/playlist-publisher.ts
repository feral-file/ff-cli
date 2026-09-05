import axios, { AxiosError } from 'axios';
import fs from 'fs';
import type { Playlist } from '../types';
import { verifyPlaylist } from './playlist-verifier';

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

    // Step 2: Verify signature integrity before publishing.
    const deliveryResult = await verifyPlaylist(playlist);

    if (!deliveryResult.valid) {
      return {
        success: false,
        error: `Playlist verification failed: ${deliveryResult.error}`,
        message: deliveryResult.details?.map((d) => `  • ${d.path}: ${d.message}`).join('\n'),
      };
    }

    // Step 2b: fail here, not at the feed, when the signer is not declared as a curator.
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
      ? ((playlist as unknown as { signatures: Array<{ kid?: unknown }> }).signatures ?? [])
      : [];
    const signingKids = signatures
      .map((sig) => (typeof sig?.kid === 'string' ? sig.kid.trim() : ''))
      .filter((k) => k.length > 0);
    if (signingKids.length > 0 && !signingKids.some((kid) => curatorKeys.has(kid))) {
      return {
        success: false,
        error: 'Playlist is signed, but the signing key is not declared as a curator.',
        message:
          `The feed accepts a publish when a signature's kid appears in the playlist's own curators[].\n` +
          `  Add this to the playlist before signing:\n` +
          `    "curators": [{ "name": "Your name", "key": "${signingKids[0]}" }]\n` +
          `  then sign again from the unsigned file — signing appends, so re-signing an already-signed\n` +
          `  playlist leaves the earlier signature covering a document that no longer exists.`,
      };
    }

    // Step 3: Send validated playlist to feed server.
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
