/**
 * Playlist Verification Utility.
 * Delegates signature-shape handling to dp1-js and keeps the CLI as a thin
 * orchestration layer.
 */

import type { Playlist } from '../types';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import { createRequire } from 'module';

/**
 * Cryptographically verify a playlist via dp1-js (after parsing succeeds).
 *
 * Unlike {@link validatePlaylist}, this forwards to dp1-js `verifyPlaylist`. The
 * library verifies DP-1 v1.1.0 `signatures[]` envelopes from embedded material.
 * dp1-js uses the optional public key argument only for legacy flat `signature`
 * strings, not for `signatures[]`. The CLI may still derive a public key from
 * `playlist.privateKey` / `PLAYLIST_PRIVATE_KEY` when `--public-key` is omitted;
 * dp1-js ignores that value unless the playlist uses the legacy path. Legacy
 * `signature` payloads need the matching public key via `--public-key` or
 * derivation as above.
 *
 * Use {@link validatePlaylist} for structure-only checks (`validate` command).
 *
 * @param playlist - Playlist object
 * @param publicKey - Optional Ed25519 key material for legacy `signature` verification.
 * PEM SPKI, 64-character hex (optional `0x`), 32-byte base64, or SPKI DER base64 are normalized to PEM before calling dp1-js. If derivation from config fails or PEM normalization fails, the CLI logs a short warning, drops the optional key material, and still calls dp1-js (so DP-1 v1.1.0 `signatures[]` verification can succeed without relying on legacy key arguments).
 * @returns Verification result with `valid` and optional `error` / `details`
 */
export async function verifyPlaylist(
  playlist: unknown,
  publicKey?: string
): Promise<{
  valid: boolean;
  error?: string;
  details?: Array<{ path: string; message: string }>;
}> {
  try {
    const result = await parseDp1Playlist(playlist);

    if (result && 'error' in result && result.error) {
      return {
        valid: false,
        error: result.error.message,
        details: result.error.details || [],
      };
    }

    const dp1 = await loadDp1();
    const verifyFn = dp1.verifyPlaylist;

    if (typeof verifyFn !== 'function') {
      throw new Error('dp1-js does not expose verifyPlaylist');
    }

    let key: string | undefined = publicKey?.trim() || undefined;
    if (!key) {
      try {
        const { getPlaylistConfig } = await import('../config');
        const privateKeyMaterial = getPlaylistConfig().privateKey;
        if (privateKeyMaterial) {
          const { deriveEd25519PublicKeyForVerify } = await import('./ed25519-key-derive');
          key = deriveEd25519PublicKeyForVerify(privateKeyMaterial);
        }
      } catch (err) {
        console.warn(
          chalk.yellow(
            `Could not derive a verify public key from playlist config (${(err as Error).message}); continuing verification without it.`
          )
        );
        key = undefined;
      }
    }

    if (key) {
      try {
        const { normalizeVerifyPublicKeyToPem } = await import('./ed25519-key-derive');
        key = normalizeVerifyPublicKeyToPem(key);
      } catch (err) {
        console.warn(
          chalk.yellow(
            `Could not normalize public key for dp1-js (${(err as Error).message}); continuing verification without it.`
          )
        );
        key = undefined;
      }
    }

    const ok = await verifyFn(playlist, key);
    return ok ? { valid: true } : { valid: false, error: 'Playlist signature verification failed' };
  } catch (error) {
    return {
      valid: false,
      error: `Verification failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Validate playlist structure without checking signatures.
 *
 * This is the parse-only path used by `validate`. It keeps the CLI
 * semantics aligned with the repo contract: schema/shape validation is
 * separate from cryptographic verification.
 */
export async function validatePlaylist(playlist: unknown): Promise<{
  valid: boolean;
  error?: string;
  details?: Array<{ path: string; message: string }>;
}> {
  try {
    const result = await parseDp1Playlist(playlist);

    if (result && 'error' in result && result.error) {
      return {
        valid: false,
        error: result.error.message,
        details: result.error.details || [],
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Verification failed: ${(error as Error).message}`,
    };
  }
}

async function parseDp1Playlist(playlist: unknown): Promise<{
  error?: { message: string; details?: Array<{ path: string; message: string }> };
}> {
  const module = (await loadDp1()) as {
    parseDP1Playlist?: (input: unknown) => {
      error?: { message: string; details?: Array<{ path: string; message: string }> };
    };
    default?: {
      parseDP1Playlist?: (input: unknown) => {
        error?: { message: string; details?: Array<{ path: string; message: string }> };
      };
    };
  };

  const parseFn = module.parseDP1Playlist;
  if (typeof parseFn !== 'function') {
    throw new Error('dp1-js does not expose parseDP1Playlist');
  }

  return parseFn(playlist);
}

/**
 * Loads the published DP-1 implementation bundled with the CLI (`dp1-js`).
 * Local checkout overrides via environment are intentionally unsupported so
 * resolution stays deterministic across machines and CI.
 */
async function loadDp1(): Promise<Record<string, unknown>> {
  const require = createRequire(__filename);
  return require('dp1-js');
}

/**
 * Verify playlist file
 *
 * Reads playlist from file and validates structure.
 *
 * @param {string} playlistPath - Path to playlist JSON file
 * @returns {Promise<Object>} Verification result
 * @returns {boolean} returns.valid - Whether playlist is valid
 * @returns {Object} [returns.playlist] - Validated playlist object
 * @returns {string} [returns.error] - Error message if invalid
 * @returns {Array<Object>} [returns.details] - Detailed validation errors
 * @example
 * const result = await verifyPlaylistFile('playlist.json');
 * if (result.valid) {
 *   console.log('Playlist is valid');
 * }
 */
export async function verifyPlaylistFile(playlistPath: string): Promise<{
  valid: boolean;
  playlist?: Playlist;
  error?: string;
  details?: Array<{ path: string; message: string }>;
}> {
  try {
    // Check if file exists
    try {
      await fs.access(playlistPath);
    } catch {
      return {
        valid: false,
        error: `Playlist file not found: ${playlistPath}`,
      };
    }

    // Read and parse playlist file
    const playlistContent = await fs.readFile(playlistPath, 'utf-8');
    let playlistData: unknown;

    try {
      playlistData = JSON.parse(playlistContent);
    } catch (parseError) {
      return {
        valid: false,
        error: `Invalid JSON: ${(parseError as Error).message}`,
      };
    }

    // Verify using dp1-js (optional key is derived for legacy signature path only inside dp1-js).
    const result = await verifyPlaylist(playlistData);

    if (result.valid) {
      return {
        valid: true,
        playlist: playlistData as Playlist,
      };
    }

    return {
      valid: false,
      error: result.error,
      details: result.details,
    };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to verify playlist file: ${(error as Error).message}`,
    };
  }
}

/** Which phase failed when printing a non-success result from `verify` / `validate`. */
export type VerificationPrintFailureKind = 'structure' | 'signature';

/**
 * Prints verification results to the console.
 *
 * For failed results, `failureKind` distinguishes DP-1 structure parsing (the `validate`
 * path and the first half of `verify`) from cryptographic verification (the second half
 * of `verify` only). Defaults to `structure`.
 *
 * @param result - Verification result
 * @param filename - Optional source label (path or URL)
 * @param options - When `result.valid` is false, `failureKind` selects the failure headline
 */
export function printVerificationResult(
  result: {
    valid: boolean;
    playlist?: Playlist;
    error?: string;
    details?: Array<{ path: string; message: string }>;
  },
  filename?: string,
  options?: { failureKind?: VerificationPrintFailureKind }
): void {
  if (result.valid) {
    console.log(chalk.green('\nPlaylist is valid'));
    if (filename) {
      console.log(chalk.dim(`  File: ${filename}`));
    }
    if (result.playlist) {
      console.log(chalk.dim(`  Title: ${result.playlist.title}`));
      console.log(chalk.dim(`  Items: ${result.playlist.items?.length || 0}`));
      console.log(chalk.dim(`  DP Version: ${result.playlist.dpVersion}`));
      if (Array.isArray(result.playlist.signatures)) {
        console.log(chalk.dim(`  Signatures: ${result.playlist.signatures.length}`));
      } else if (result.playlist.signature && typeof result.playlist.signature === 'string') {
        console.log(chalk.dim(`  Signature: ${result.playlist.signature.substring(0, 30)}...`));
      }
    }
    console.log();
  } else {
    const kind = options?.failureKind ?? 'structure';
    const headline =
      kind === 'signature'
        ? '\nPlaylist signature verification failed'
        : '\nPlaylist validation failed';
    console.log(chalk.red(headline));
    if (filename) {
      console.log(chalk.dim(`  File: ${filename}`));
    }
    console.log(chalk.red(`  Error: ${result.error}`));

    if (result.details && result.details.length > 0) {
      const detailsHeading = kind === 'signature' ? '\n  Details:' : '\n  Validation errors:';
      console.log(chalk.yellow(detailsHeading));
      result.details.forEach((detail) => {
        console.log(chalk.yellow(`    • ${detail.path}: ${detail.message}`));
      });
    }
    console.log();
  }
}
