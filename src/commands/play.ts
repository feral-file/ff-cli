import { Command } from 'commander';
import chalk from 'chalk';
import { parseFindInput } from '@feralfile/source-resolver';
import { getPlaylistConfig } from '../config';
import {
  buildMediaPlaySource,
  checkWebPageUrl,
  isPlaylistSourceUrl,
  loadPlaylistSource,
  refusalForLoadFailure,
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
 *
 * A URL that does not exist (404/410, no such host, a broken `.json` link)
 * is refused here rather than redirected: the redirect also suggests
 * `play --web`, which would cast the error page.
 *
 * @throws {Error} When the URL does not exist (refusalForLoadFailure)
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
  } catch (error) {
    const refusal = refusalForLoadFailure(source.trim(), error);
    if (refusal) {
      throw refusal;
    }
    return null;
  }
}

/**
 * resolveWebPageSource wraps `source` as a web page for `play --web`, without
 * the discovery redirect or the playlist probe.
 *
 * `--web` exists because the discovery parser claims whole hosts: any page on
 * feralfile.com, opensea.io, objkt.com and the like is redirected to `find`,
 * and `find` rejects every page that is not an artwork it can resolve (a
 * homepage, an exhibition overview, a profile). Before `--web` there was no
 * way to put such a page on a wall; the two commands pointed at each other.
 *
 * @param {string} source - The URL the caller passed
 * @returns {Promise<PlaySource>} A `media` source with a `text/html` item
 * @throws {Error} When `source` is not an http(s) URL
 */
async function resolveWebPageSource(source: string): Promise<PlaySource> {
  const url = source.trim();
  if (!isPlaylistSourceUrl(url)) {
    throw new Error(`--web takes an http(s) URL; got "${source}".`);
  }
  const note = await checkWebPageUrl(url);
  return buildMediaPlaySource(url, { asWebPage: true, note });
}

export const playCommand = new Command('play')
  .description('Play a playlist file, playlist URL, media URL, or web page on an FF1 device')
  .argument('<source>', 'Playlist file, playlist URL, or any media or web page URL')
  .option('-d, --device <name>', 'Device name (uses first device if not specified)')
  .option(
    '--web',
    'Play the URL as a web page, even on a marketplace site where play would otherwise send you to find'
  )
  .option(
    '--skip-verify',
    'Skip signature verification and auto-sign gating before playing; use only when you accept malformed envelopes'
  )
  .action(
    async (source: string, options: { device?: string; skipVerify?: boolean; web?: boolean }) => {
      try {
        const resolved = options.web
          ? await resolveWebPageSource(source)
          : await resolveDefaultSource(source, options.device);
        await castResolved(resolved, options);
      } catch (error) {
        if (!options.web && isPlaylistSourceUrl(source)) {
          printPlaylistSourceLoadFailure(source, error as Error);
        } else {
          console.error(chalk.red('\nError:'), (error as Error).message);
        }
        process.exit(1);
      }
    }
  );

/**
 * resolveDefaultSource resolves a `play` argument without `--web`: discovery
 * inputs go to `find`, everything else loads as a playlist or wraps as media.
 *
 * `play` casts an exact playable source. A marketplace URL / on-chain coords /
 * wallet must be resolved through the indexer first, so it redirects to `find`
 * rather than silently wrapping the *page* as a web item. Exception: a
 * discovery-classified URL that actually serves a DP-1 playlist document (the
 * discovery parser claims whole hosts, catching feed playlist URLs) plays
 * directly; see probeDiscoveryUrlAsPlaylist. The redirect names `--web` too,
 * for the caller who did mean the page.
 *
 * @param {string} source - The URL, path, or reference the caller passed
 * @param {string} [device] - Device name, carried into the suggested command
 * @returns {Promise<PlaySource>} What to cast; exits 1 on a discovery input
 */
async function resolveDefaultSource(source: string, device?: string): Promise<PlaySource> {
  const discovery = describeDiscoveryInput(source);
  let probed: PlaySource | null = null;
  if (discovery) {
    probed = await probeDiscoveryUrlAsPlaylist(source);
  }
  if (discovery && !probed) {
    console.error(
      chalk.red('\n`play` casts an exact playlist or media URL — it does not search marketplaces.')
    );
    console.error(
      chalk.dim(`  "${source}" looks like ${discovery}, which needs to be resolved first.`)
    );
    const deviceFlag = device ? ` -d "${device}"` : '';
    console.log(chalk.yellow(`\nTry:  ff-cli find "${source}" --play -y${deviceFlag}`));
    if (isPlaylistSourceUrl(source)) {
      console.log(
        chalk.dim(`To show the page itself:  ff-cli play --web "${source}"${deviceFlag}`)
      );
    }
    process.exit(1);
  }

  // No explicit duration: a direct video/audio URL plays its natural
  // length (DP-1 §4.1); static media uses config.defaultDuration.
  return probed ?? (await resolvePlaySource(source));
}

/**
 * castResolved signs (for a synthesized media playlist), verifies, and sends
 * a resolved source, then reports the outcome. Exits 1 on any failure.
 *
 * @param {PlaySource} resolved - What to cast
 * @param {Object} options - The `play` options
 * @returns {Promise<void>}
 */
async function castResolved(
  resolved: PlaySource,
  options: { device?: string; skipVerify?: boolean }
): Promise<void> {
  const isPlaylistSource = resolved.kind === 'playlist';
  const sourceLabel = isPlaylistSource
    ? `${resolved.sourceType}: ${resolved.source}`
    : resolved.source;

  console.log(chalk.blue('\nPlay on FF1\n'));

  if (resolved.kind === 'media' && resolved.note) {
    console.log(chalk.yellow(resolved.note));
  }

  if (!options.skipVerify && isPlaylistSource) {
    console.log(chalk.cyan(`Verify playlist (${sourceLabel})`));
  }

  // A direct media/web URL is wrapped in an unsigned single-item playlist,
  // so it must be signed before the verify gate; a loaded playlist is sent
  // as-is. castPlaylist owns the sign → verify → send sequence.
  // Resolve through getPlaylistConfig rather than reading config.playlist directly: it is the one
  // place that knows a config value may still be the config.json.example placeholder, in which case a
  // valid PLAYLIST_PRIVATE_KEY must win. Duplicating the `config || env` precedence here is what made
  // this path sign with the template literal while every other signing path used the real key.
  const privateKey = getPlaylistConfig().privateKey || undefined;
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
}
