import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../config';
import { isPlaylistSourceUrl, resolvePlaySource } from '../utilities/playlist-source';
import { parseFindInput } from '../utilities/marketplace-url';
import {
  printPlaylistSourceLoadFailure,
  printPlaylistVerificationFailure,
} from './helpers/playlist-display';

// ff1-device is still CommonJS; require keeps the interop simple.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendPlaylistToDevice } = require('../utilities/ff1-device');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { signPlaylist } = require('../utilities/playlist-signer');

/**
 * Human label for a discovery input that `play` cannot cast directly.
 *
 * `play` casts an exact, already-playable source (a playlist file, a hosted
 * playlist URL, or a direct media/web URL). A marketplace URL, on-chain
 * coordinates, or a wallet address must be *resolved* through the indexer
 * first — that is `find`'s job. Returns a label for those inputs so `play`
 * can redirect the user instead of silently wrapping, say, an Art Blocks
 * collection *page* as a web item. Returns null for anything `play` should
 * handle itself (plain URLs and file paths parse to null here).
 *
 * A recognized-but-`unsupported` result (e.g. a legacy Art Blocks
 * `/projects/{id}` URL, or an unsupported-chain OpenSea link) is also a
 * discovery input — it's a marketplace URL, not a playable file — so it is
 * redirected to `find` too, which surfaces the specific reason.
 */
export function describeDiscoveryInput(source: string): string | null {
  const parsed = parseFindInput(source);
  if (!parsed) {
    return null;
  }
  if (parsed.kind === 'unsupported') {
    return 'a marketplace URL';
  }
  switch (parsed.kind) {
    case 'token':
      return 'an on-chain token reference';
    case 'address':
      return 'a wallet address';
    case 'ff-url':
      return 'a Feral File URL';
    case 'objkt-alias':
      return 'an Objkt token';
    case 'ab-collection':
      return 'an Art Blocks collection';
    case 'os-collection':
      return 'an OpenSea collection';
    case 'fxhash-iteration':
    case 'fxhash-project':
      return 'an fxhash work';
    case 'neort-art':
      return 'a Neort work';
    case 'verse-series':
      return 'a Verse series';
    case 'raster-artwork':
      return 'a Raster artwork';
    default:
      return 'an artwork reference';
  }
}

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
      // `play` casts an exact playable source. A marketplace URL / on-chain
      // coords / wallet must be resolved through the indexer first — redirect
      // to `find` rather than silently wrapping the *page* as a web item.
      const discovery = describeDiscoveryInput(source);
      if (discovery) {
        console.error(
          chalk.red(
            '\n`play` casts an exact playlist or media URL — it does not search marketplaces.'
          )
        );
        console.error(chalk.dim(`  "${source}" looks like ${discovery} to resolve first.`));
        const deviceFlag = options.device ? ` -d "${options.device}"` : '';
        console.log(chalk.yellow(`\nTry:  ff-cli find "${source}" --play${deviceFlag}`));
        process.exit(1);
      }

      const config = getConfig();
      // No explicit duration: a direct video/audio URL plays its natural
      // length (DP-1 §4.1); static media uses config.defaultDuration.
      const resolved = await resolvePlaySource(source);
      const isPlaylistSource = resolved.kind === 'playlist';
      const sourceLabel = isPlaylistSource
        ? `${resolved.sourceType}: ${resolved.source}`
        : resolved.source;

      console.log(chalk.blue('\nPlay on FF1\n'));

      if (!options.skipVerify) {
        const playlistConfig = config.playlist;
        const privateKey = playlistConfig?.privateKey || process.env.PLAYLIST_PRIVATE_KEY;
        const { verifyPlaylist } = await import('../utilities/playlist-verifier');

        if (isPlaylistSource) {
          console.log(chalk.cyan(`Verify playlist (${sourceLabel})`));
        }

        const verifyResult =
          resolved.kind === 'media'
            ? await (async () => {
                try {
                  if (!privateKey) {
                    return {
                      valid: false,
                      error:
                        'Cannot sign playlist for playback: no playlist signing key is configured',
                    };
                  }

                  const signature = await signPlaylist(resolved.playlist, privateKey);
                  const signedPlaylist = {
                    ...resolved.playlist,
                    signature: undefined,
                    signatures: [signature],
                  };
                  const signedVerification = await verifyPlaylist(signedPlaylist);
                  if (signedVerification.valid) {
                    resolved.playlist = signedPlaylist as typeof resolved.playlist;
                    return { valid: true, playlist: signedPlaylist };
                  }

                  return {
                    valid: false,
                    error: signedVerification.error,
                    details: signedVerification.details,
                  };
                } catch (error) {
                  return {
                    valid: false,
                    error: `Failed to sign playlist for playback: ${(error as Error).message}`,
                  };
                }
              })()
            : await verifyPlaylist(resolved.playlist);

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

        if (resolved.kind === 'media') {
          console.log(chalk.green('✓ Signed and verified\n'));
        } else if (isPlaylistSource) {
          console.log(chalk.green('✓ Verified\n'));
        }
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
