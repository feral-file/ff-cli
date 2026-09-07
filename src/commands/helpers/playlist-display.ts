import chalk from 'chalk';
import { isPlaylistSourceUrl, loadPlaylistSource } from '../../utilities/playlist-source';
import type { Playlist } from '../../types';

export interface PlaylistVerificationResult {
  valid: boolean;
  error?: string;
  details?: Array<{ path: string; message: string }>;
  playlist?: Playlist;
}

/**
 * Print the standard "playlist saved" footer with the next-step hint.
 *
 * Used by `chat` and `build` after they write a playlist to disk, so the
 * surface message stays consistent across both commands.
 */
export function displayPlaylistSummary(playlist: Playlist, outputPath: string) {
  console.log(chalk.green('\nPlaylist saved'));
  console.log(chalk.dim(`  Output: ./${outputPath}`));
  console.log(chalk.dim('  Next: play last | publish playlist'));
  console.log();
}

/**
 * Print a focused failure for playlist source loading problems with a
 * URL-vs-file aware hint block.
 */
export function printPlaylistSourceLoadFailure(source: string, error: Error): void {
  const isUrl = isPlaylistSourceUrl(source);

  if (isUrl) {
    console.error(chalk.red('\nCould not load hosted playlist URL'));
    console.error(chalk.red(`  Source: ${source}`));
    console.error(chalk.red(`  Error: ${error.message}`));
    console.log(chalk.yellow('\n  Hint:'));
    console.log(chalk.yellow('    • Check the URL is reachable'));
    console.log(chalk.yellow('    • Confirm the response is JSON'));
    console.log(chalk.yellow('    • Use a local file path if network access is unavailable'));
    return;
  }

  console.error(chalk.red(`\nCould not load playlist file`));
  console.error(chalk.red(`  Source: ${source}`));
  console.error(chalk.red(`  Error: ${error.message}`));
}

/**
 * Print playlist validation failure details consistently for commands that
 * validate structure before sending (for example `play`).
 */
export function printPlaylistVerificationFailure(
  verifyResult: PlaylistVerificationResult,
  source?: string
): void {
  console.error(
    chalk.red(`\nPlaylist validation failed:${source ? ` (${source})` : ''}`),
    verifyResult.error
  );

  if (verifyResult.details && verifyResult.details.length > 0) {
    console.log(chalk.yellow('\n   Validation errors:'));
    verifyResult.details.forEach((detail: { path: string; message: string }) => {
      console.log(chalk.yellow(`     • ${detail.path}: ${detail.message}`));
    });
  }

  console.log(chalk.yellow('\n   Use --skip-verify to play anyway (not recommended)\n'));
}

/**
 * Load a playlist from a path or URL and run parse-only validation (`validatePlaylist`).
 *
 * The `validate` command uses this as the full check. The `verify` command uses it
 * for the structure pass only, then runs `verifyPlaylist` for cryptographic checks.
 */
export async function validatePlaylistSource(source: string): Promise<PlaylistVerificationResult> {
  const loaded = await loadPlaylistSource(source);

  const verifier = await import('../../utilities/playlist-verifier.js');
  const { validatePlaylist } = verifier;
  const verifyResult = await validatePlaylist(loaded.playlist);

  return {
    ...verifyResult,
    playlist: verifyResult.valid ? loaded.playlist : undefined,
  };
}

/**
 * Run the `validate` command flow. It checks DP-1 structure only and does
 * not require signatures or public keys.
 */
export async function runValidateCommand(source: string): Promise<void> {
  try {
    console.log(chalk.blue('\nValidate playlist\n'));

    const verifier = await import('../../utilities/playlist-verifier.js');
    const { printVerificationResult } = verifier;

    const result = await validatePlaylistSource(source);

    printVerificationResult(result, source, { failureKind: 'structure' });

    if (!result.valid) {
      process.exit(1);
    }
  } catch (error) {
    printPlaylistSourceLoadFailure(source, error as Error);
    process.exit(1);
  }
}

/**
 * Run the `verify` command flow: same DP-1 structure checks as `validate`, then
 * cryptographic verification via dp1-js. Unsigned playlists fail at the crypto
 * step. dp1-js `verifyPlaylist` uses the optional second argument **only** to
 * verify legacy flat `signature` strings; `signatures[]` envelopes do not rely
 * on it. When `--public-key` is omitted, the CLI may still pass a key derived
 * from `playlist.privateKey` / `PLAYLIST_PRIVATE_KEY`; dp1-js ignores it unless
 * the playlist is on the legacy signature path.
 */
export async function runVerifyCommand(source: string, publicKey?: string): Promise<void> {
  try {
    console.log(chalk.blue('\nVerify playlist\n'));

    const verifier = await import('../../utilities/playlist-verifier.js');
    const { printVerificationResult } = verifier;

    const result = await validatePlaylistSource(source);
    if (!result.valid) {
      printVerificationResult(result, source, { failureKind: 'structure' });
      process.exit(1);
    }

    const signedResult = await verifier.verifyPlaylist(result.playlist, publicKey);
    const finalResult = signedResult.valid
      ? { ...result, valid: true, error: undefined, details: undefined }
      : { valid: false, error: signedResult.error, details: signedResult.details };

    printVerificationResult(finalResult, source, { failureKind: 'signature' });

    if (!signedResult.valid) {
      process.exit(1);
    }
  } catch (error) {
    printPlaylistSourceLoadFailure(source, error as Error);
    process.exit(1);
  }
}
