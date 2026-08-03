import { Command } from 'commander';
import chalk from 'chalk';
import { parseFindInput } from '@feralfile/source-resolver';
import { getConfig } from '../config';
import {
  isPlaylistSourceUrl,
  loadPlaylistSource,
  resolvePlaySource,
  type PlaySource,
} from '../utilities/playlist-source';
import { castPlaylist } from '../utilities/playlist-cast';
import {
  printPlaylistSourceLoadFailure,
  printPlaylistVerificationFailure,
} from './helpers/playlist-display';

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

/**
 * probeDiscoveryUrlAsPlaylist loads a discovery-classified http(s) URL as a
 * DP-1 playlist document, or returns null when it is not one.
 *
 * The discovery parser claims whole hosts — any *.feralfile.com URL parses
 * as a Feral File URL, and non-exhibition paths come back `unsupported` —
 * which wrongly redirected DP-1 feed playlist URLs
 * (https://feed.feralfile.com/api/v1/playlists/{slug}, exactly the URLs the
 * feed hands out) to `find`, which has no feed route either; the documented
 * "hosted playlist URL plays directly" contract was unreachable for them
 * (found 2026-08-02 casting a published playlist to an FF1).
 *
 * Probing the document keeps both behaviors without a host allowlist: a URL
 * that serves DP-1 JSON (`dpVersion` marker) plays directly; a marketplace
 * *page* fails the probe (non-JSON, or JSON with no marker) and still
 * redirects to `find` instead of being wrapped as a web item. The probe
 * costs one fetch before a redirect, only for discovery inputs that are
 * http(s) URLs; coordinates and wallet addresses never hit the network.
 */
export async function probeDiscoveryUrlAsPlaylist(source: string): Promise<PlaySource | null> {
  if (!isPlaylistSourceUrl(source)) {
    return null;
  }
  try {
    const loaded = await loadPlaylistSource(source);
    const document = loaded.playlist as { dpVersion?: unknown };
    if (typeof document?.dpVersion !== 'string') {
      return null;
    }
    return {
      kind: 'playlist',
      playlist: loaded.playlist,
      sourceType: loaded.sourceType,
      source: loaded.source,
    };
  } catch {
    return null;
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
      // Exception: a discovery-classified URL that actually serves a DP-1
      // playlist document (the discovery parser claims whole hosts, catching
      // feed playlist URLs) plays directly — see probeDiscoveryUrlAsPlaylist.
      const discovery = describeDiscoveryInput(source);
      let probed: PlaySource | null = null;
      if (discovery) {
        probed = await probeDiscoveryUrlAsPlaylist(source);
      }
      if (discovery && !probed) {
        console.error(
          chalk.red(
            '\n`play` casts an exact playlist or media URL — it does not search marketplaces.'
          )
        );
        console.error(
          chalk.dim(`  "${source}" looks like ${discovery}, which needs to be resolved first.`)
        );
        const deviceFlag = options.device ? ` -d "${options.device}"` : '';
        console.log(chalk.yellow(`\nTry:  ff-cli find "${source}" --play${deviceFlag}`));
        process.exit(1);
      }

      const config = getConfig();
      // No explicit duration: a direct video/audio URL plays its natural
      // length (DP-1 §4.1); static media uses config.defaultDuration.
      const resolved = probed ?? (await resolvePlaySource(source));
      const isPlaylistSource = resolved.kind === 'playlist';
      const sourceLabel = isPlaylistSource
        ? `${resolved.sourceType}: ${resolved.source}`
        : resolved.source;

      console.log(chalk.blue('\nPlay on FF1\n'));

      if (!options.skipVerify && isPlaylistSource) {
        console.log(chalk.cyan(`Verify playlist (${sourceLabel})`));
      }

      // A direct media/web URL is wrapped in an unsigned single-item playlist,
      // so it must be signed before the verify gate; a loaded playlist is sent
      // as-is. castPlaylist owns the sign → verify → send sequence.
      const privateKey = config.playlist?.privateKey || process.env.PLAYLIST_PRIVATE_KEY;
      const result = await castPlaylist(resolved.playlist, {
        deviceName: options.device,
        skipVerify: options.skipVerify,
        requireSignature: resolved.kind === 'media',
        signingKey: privateKey,
      });

      if (!result.success) {
        if (result.stage === 'verify') {
          printPlaylistVerificationFailure(
            { valid: false, error: result.error, details: result.details },
            isPlaylistSource ? `source: ${sourceLabel}` : undefined
          );
        } else if (result.stage === 'sign') {
          console.error(chalk.red(`\n${result.error}`));
        } else {
          console.error(chalk.red('\nPlay failed:'), result.error);
          if (result.deviceDetails) {
            console.error(chalk.dim(`  Details: ${result.deviceDetails}`));
          }
        }
        process.exit(1);
      }

      if (result.verified) {
        console.log(chalk.green(result.signed ? '✓ Signed and verified\n' : '✓ Verified\n'));
      }

      console.log(chalk.green('✓ Playing'));
      if (result.deviceName) {
        console.log(chalk.dim(`  Device: ${result.deviceName}`));
      }
      if (result.device) {
        console.log(chalk.dim(`  Host: ${result.device}`));
      }
      console.log();
    } catch (error) {
      if (isPlaylistSourceUrl(source)) {
        printPlaylistSourceLoadFailure(source, error as Error);
      } else {
        console.error(chalk.red('\nError:'), (error as Error).message);
      }
      process.exit(1);
    }
  });
