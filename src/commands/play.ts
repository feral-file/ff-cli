import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../config';
import { isPlaylistSourceUrl, resolvePlaySource } from '../utilities/playlist-source';
import {
  printPlaylistSourceLoadFailure,
  printPlaylistVerificationFailure,
} from './helpers/playlist-display';

// ff1-device is still CommonJS; require keeps the interop simple.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendPlaylistToDevice } = require('../utilities/ff1-device');

export const playCommand = new Command('play')
  .description('Play a playlist or media URL on an FF1 device')
  .argument('<source>', 'Playlist file, playlist URL, or media URL')
  .option('-d, --device <name>', 'Device name (uses first device if not specified)')
  .option(
    '--skip-verify',
    'Skip signature verification and auto-sign gating before playing; use only when you accept malformed envelopes'
  )
  .action(async (source: string, options: { device?: string; skipVerify?: boolean }) => {
    try {
      const config = getConfig();
      const resolved = await resolvePlaySource(source, config.defaultDuration || 10);
      const isPlaylistSource = resolved.kind === 'playlist';
      const sourceLabel = isPlaylistSource
        ? `${resolved.sourceType}: ${resolved.source}`
        : resolved.source;

      console.log(chalk.blue('\nPlay on FF1\n'));

      if (!options.skipVerify) {
        const playlistConfig = config.playlist;
        const privateKey = playlistConfig?.privateKey || process.env.PLAYLIST_PRIVATE_KEY;
        if (isPlaylistSource) {
          console.log(chalk.cyan(`Verify playlist (${sourceLabel})`));
        }

        const verifier = await import('../utilities/playlist-verifier');
        const verifyResult = await verifier.preparePlaylistForDelivery(
          resolved.playlist,
          true,
          privateKey
        );

        if (!verifyResult.valid) {
          printPlaylistVerificationFailure(
            {
              valid: false,
              error: verifyResult.error,
              details: verifyResult.details,
            },
            isPlaylistSource ? `source: ${sourceLabel}` : undefined
          );
          process.exit(1);
        }

        if (isPlaylistSource) {
          if (verifyResult.signed) {
            console.log(chalk.green('✓ Signed and verified\n'));
          } else {
            console.log(chalk.green('✓ Verified\n'));
          }
        }

        resolved.playlist = verifyResult.playlist as typeof resolved.playlist;
      }

      const result = await sendPlaylistToDevice({
        playlist: resolved.playlist,
        deviceName: options.device,
      });

      if (result.success) {
        console.log(chalk.green('✓ Playing'));
        if (result.deviceName) {
          console.log(chalk.dim(`  Device: ${result.deviceName}`));
        }
        if (result.device) {
          console.log(chalk.dim(`  Host: ${result.device}`));
        }
        console.log();
      } else {
        console.error(chalk.red('\nPlay failed:'), result.error);
        if (result.details) {
          console.error(chalk.dim(`  Details: ${result.details}`));
        }
        process.exit(1);
      }
    } catch (error) {
      if (isPlaylistSourceUrl(source)) {
        printPlaylistSourceLoadFailure(source, error as Error);
      } else {
        console.error(chalk.red('\nError:'), (error as Error).message);
      }
      process.exit(1);
    }
  });
