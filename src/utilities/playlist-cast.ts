import type { Playlist } from '../types';

/**
 * DP-1 signature role used when signing a playlist for playback.
 *
 * A cast never passes through a feed, so the delivered document carries no `feed` signature and its own
 * entry is the only one a player can judge. DP-1 §7.1.1 rule 1 has players verify a `feed` or `curator`
 * signature, so signing under the configured role (shipped default `agent`) leaves a document a
 * role-aware player may refuse, with nothing else in the envelope to fall back on.
 *
 * This also has to match what the builder wrote: a wrapped media URL arrives here already declaring the
 * signing key in `curators[]` and signed as `curator`, and signing REPLACES `signatures[]` rather than
 * appending — so any other role here silently downgrades that envelope on its way to the device.
 */
const PLAYBACK_SIGNING_ROLE = 'curator';

// playlist-signer and ff1-device are still CommonJS; require keeps interop simple.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { signPlaylist } = require('./playlist-signer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendPlaylistToDevice } = require('./ff1-device');

export type CastStage = 'sign' | 'verify' | 'send';

export interface CastPlaylistOptions {
  /** Target device name; falls back to the first configured device when omitted. */
  deviceName?: string;
  /** Bypass the sign + verify gate entirely (the `--skip-verify` escape hatch). */
  skipVerify?: boolean;
  /**
   * Sign the playlist before verifying. Used for the synthesized-media
   * fallback, whose single-item playlist is unsigned at build time. When set
   * but `signingKey` is missing, the cast fails closed at the `sign` stage
   * rather than delivering an unverifiable playlist.
   */
  requireSignature?: boolean;
  /** Ed25519 key (base64 or hex) used when `requireSignature` is set. */
  signingKey?: string | null;
}

export interface CastPlaylistResult {
  success: boolean;
  /** The playlist actually delivered — signed in place when `requireSignature`. */
  playlist: Playlist;
  /** Whether this call signed the playlist (drives "Signed and verified" vs "Verified"). */
  signed: boolean;
  /** Whether the verify gate ran and passed (false when skipped). */
  verified: boolean;
  /** Where it failed, when `success` is false. */
  stage?: CastStage;
  deviceName?: string;
  device?: string;
  error?: string;
  /** Structured DP-1 validation errors (verify-stage failures). */
  details?: Array<{ path: string; message: string }>;
  /** Free-text device transport detail (send-stage failures). */
  deviceDetails?: string;
}

/**
 * Shared "(sign →) verify → send to device" sequence used by `play` and
 * `find --play`.
 *
 * This is the single source of truth for getting a playlist onto an FF1: the
 * verification gate, the synthesized-media auto-sign (rebuilding the
 * `signatures[]` envelope), and the device transport. Callers own their
 * console output and map the returned `stage`/`error` to their own messages —
 * keeping delivery behavior consistent without coupling the two commands'
 * UX. Previously this logic was duplicated across `play`, `find`, and the
 * (now-removed) chat send path, and drifted between them.
 */
export async function castPlaylist(
  playlist: Playlist,
  options: CastPlaylistOptions = {}
): Promise<CastPlaylistResult> {
  let current = playlist;
  let signed = false;
  let verified = false;

  if (!options.skipVerify) {
    if (options.requireSignature) {
      if (!options.signingKey) {
        return {
          success: false,
          playlist: current,
          signed: false,
          verified: false,
          stage: 'sign',
          error: 'Cannot sign playlist for playback: no playlist signing key is configured',
        };
      }
      try {
        const signature = await signPlaylist(current, options.signingKey, PLAYBACK_SIGNING_ROLE);
        current = {
          ...current,
          signature: undefined,
          signatures: [signature],
        } as Playlist;
        signed = true;
      } catch (error) {
        return {
          success: false,
          playlist: current,
          signed: false,
          verified: false,
          stage: 'sign',
          error: `Failed to sign playlist for playback: ${(error as Error).message}`,
        };
      }
    }

    const { verifyPlaylist } = await import('./playlist-verifier');
    const verifyResult = await verifyPlaylist(current);
    if (!verifyResult.valid) {
      return {
        success: false,
        playlist: current,
        signed,
        verified: false,
        stage: 'verify',
        error: verifyResult.error,
        details: verifyResult.details,
      };
    }
    verified = true;
  }

  const sendResult = await sendPlaylistToDevice({
    playlist: current,
    deviceName: options.deviceName,
  });

  if (sendResult.success) {
    return {
      success: true,
      playlist: current,
      signed,
      verified,
      deviceName: sendResult.deviceName,
      device: sendResult.device,
    };
  }

  return {
    success: false,
    playlist: current,
    signed,
    verified,
    stage: 'send',
    error: sendResult.error,
    deviceDetails: sendResult.details,
  };
}
