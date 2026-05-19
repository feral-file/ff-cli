import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import type { Playlist } from '../types';
import { createPrompt, promptYesNo } from './helpers/prompt';
import { parseFindInput } from '../utilities/marketplace-url';
import type { TokenCoords } from '../utilities/marketplace-url';
import { resolveFeralFileToken } from '../utilities/ff-marketplace';
import { resolveObjktAlias } from '../utilities/objkt-marketplace';
import { resolveArtBlocksCollection } from '../utilities/ab-marketplace';
import { getConfig } from '../config';
import {
  resolveTokenToArtwork,
  getArtworkSummary,
  listArtworkTokens,
  listArtistArtworks,
  resolveAddressToArtist,
  formatSummaryLine,
} from '../utilities/raster-client';
import type { RasterArtworkSummary, RasterArtworkRow } from '../utilities/raster-client';
import { sendPlaylistToDevice } from '../utilities/ff1-device';

// nft-indexer + playlist-builder are still CommonJS; require keeps interop simple.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNFTTokenInfoBatch } = require('../utilities/nft-indexer');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildDP1Playlist } = require('../utilities/playlist-builder');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { signPlaylist } = require('../utilities/playlist-signer');

interface FindOptions {
  output?: string;
  limit?: string;
  yes?: boolean;
  play?: boolean;
  device?: string;
  publish?: boolean;
  server?: string;
}

type PostBuildAction = 'play' | 'publish' | 'skip';

interface PlaylistVerificationResult {
  valid: boolean;
  playlist?: Playlist;
  error?: string;
  details?: Array<{ path: string; message: string }>;
}

interface FindPlayDeps {
  preparePlaylistForPlayback?: (playlist: Playlist) => Promise<PlaylistVerificationResult>;
  sendPlaylistToDevice?: typeof sendPlaylistToDevice;
}

/**
 * What resolves out of a `find` input.
 *
 * `series` — Raster knows the artwork; we'll enumerate every token in it.
 * `single` — Raster doesn't index this token's series (returns 404); fall
 *   back to a one-item playlist using the FF indexer for the pasted token.
 */
type ResolvedTarget =
  | { kind: 'series'; summary: RasterArtworkSummary }
  | { kind: 'single'; coords: TokenCoords };

const RASTER_PAGE_SIZE = 100;
const INDEXER_DISPLAY_DURATION_SECONDS = 10;

export const findCommand = new Command('find')
  .description('Find an artwork on the web and build a DP-1 playlist')
  .argument(
    '<input>',
    'URL (Objkt / fxhash / Art Blocks / OpenSea / Feral File), `ethereum:{contract}:{tokenId}`, `tezos:{contract}:{tokenId}`, or a wallet address'
  )
  .option('-o, --output <path>', 'Save the playlist to this file (default: ./<slug>.json)')
  .option('-l, --limit <n>', 'Max tokens to include from the series (default: all)')
  .option('-p, --play', 'Play the playlist on an FF1 device after building')
  .option('-d, --device <name>', 'Device to play on (used with --play; default: first configured)')
  .option('--publish', 'Publish the playlist to a configured feed server')
  .option('-s, --server <index>', 'Feed server index (used with --publish)')
  .option(
    '-y, --yes',
    'Skip interactive prompts; defaults to Play unless --output or --publish is set'
  )
  .action(async (input: string, options: FindOptions) => {
    try {
      console.log(chalk.blue('\nFind on Feral File CLI\n'));

      const parsed = parseFindInput(input);
      if (!parsed) {
        console.error(chalk.red('Could not understand input.'));
        console.error(
          chalk.dim(
            'Supported URLs: Objkt, fxhash, Art Blocks, OpenSea, Feral File. ' +
              'Or: `ethereum:{contract}:{tokenId}`, `tezos:{contract}:{tokenId}`, ' +
              'or a wallet address (`0x...` / `tz1.../tz2.../tz3...`).'
          )
        );
        process.exit(1);
      }
      if (parsed.kind === 'unsupported') {
        console.error(chalk.red(parsed.reason));
        process.exit(1);
      }

      const target = await resolveTarget(parsed, !!options.yes);

      if (target.kind === 'series') {
        console.log(chalk.cyan(formatSummaryLine(target.summary)));
      } else {
        const { chain, contract, tokenId } = target.coords;
        console.log(chalk.cyan(`Single token — ${chain} ${contract}:${tokenId}`));
        console.log(
          chalk.dim("  (Raster doesn't index this series — building a one-item playlist.)")
        );
      }
      console.log();

      const limit = parseLimitOption(options.limit);
      const seriesTotal = target.kind === 'series' ? target.summary.tokenCount : 1;
      const willInclude = Math.min(seriesTotal, limit);
      const shouldBuild =
        !!options.yes || !!options.output || (await confirmMakePlaylist(willInclude, seriesTotal));
      if (!shouldBuild) {
        console.log(chalk.dim('Cancelled.'));
        return;
      }

      const tokens =
        target.kind === 'series' ? await fetchTokens(target.summary, limit) : [target.coords];
      console.log(
        chalk.dim(
          `Indexing ${tokens.length} token${tokens.length === 1 ? '' : 's'} via FF indexer...`
        )
      );

      const items = await getNFTTokenInfoBatch(
        tokens.map((t) => ({
          chain: t.chain,
          contractAddress: t.contract,
          tokenId: t.tokenId,
        })),
        INDEXER_DISPLAY_DURATION_SECONDS
      );

      if (!Array.isArray(items) || items.length === 0) {
        console.error(chalk.red('No tokens could be indexed; cannot build playlist.'));
        console.error(
          chalk.dim(
            '  The FF indexer may be under load when warming a series of previously-unseen tokens.'
          )
        );
        console.error(
          chalk.dim('  Try `--limit 5` first to warm the cache, then re-run without --limit.')
        );
        process.exit(1);
      }

      const title = playlistTitleFor(target, items);
      const playlist = await buildDP1Playlist({ items, title });

      const outputPath = options.output ?? `${playlist.slug || 'playlist'}.json`;
      await fs.writeFile(outputPath, JSON.stringify(playlist, null, 2));

      console.log(chalk.green(`✓ Playlist saved to ${outputPath}`));
      console.log(chalk.dim(`  ${items.length} item${items.length === 1 ? '' : 's'}`));
      const dropped = tokens.length - items.length;
      if (dropped > 0) {
        console.log(
          chalk.dim(`  ${dropped} token${dropped === 1 ? '' : 's'} dropped during indexing`)
        );
      }
      console.log();

      const actions = await decideActions(options);
      for (const action of actions) {
        if (action === 'play') {
          await doPlay(playlist, options.device);
        } else if (action === 'publish') {
          await doPublish(outputPath, options.server, !!options.yes);
        }
      }
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });

async function resolveTarget(
  parsed: NonNullable<ReturnType<typeof parseFindInput>>,
  skipPrompt: boolean
): Promise<ResolvedTarget> {
  if (parsed.kind === 'token') {
    return resolveCoords(parsed.coords);
  }
  if (parsed.kind === 'ff-url') {
    const coords = await resolveFeralFileToken(parsed);
    return resolveCoords(coords);
  }
  if (parsed.kind === 'objkt-alias') {
    const contract = await resolveObjktAlias(parsed.alias);
    return resolveCoords({ chain: 'tezos', contract, tokenId: parsed.tokenId });
  }
  if (parsed.kind === 'ab-collection') {
    const coords = await resolveArtBlocksCollection(parsed.slug);
    return resolveCoords(coords);
  }
  if (parsed.kind === 'address') {
    const artistId = await resolveAddressToArtist(parsed.address);
    if (artistId === null) {
      throw new Error(
        `No artist found on Raster for address ${parsed.address}. ` +
          'Raster indexes artists by their on-chain addresses; this address may not yet be claimed.'
      );
    }
    const catalog = await listArtistArtworks(artistId);
    if (catalog.length === 0) {
      throw new Error('Artist has no artworks indexed on Raster.');
    }
    const picked = await pickFromCatalog(catalog, skipPrompt);
    const summary = await getArtworkSummary(picked.artworkId);
    return { kind: 'series', summary };
  }
  // `unsupported` is handled upstream; this branch keeps the type narrowing honest.
  throw new Error(`Unsupported parse result: ${parsed.kind}`);
}

/**
 * Resolve on-chain coords to a target. If Raster doesn't index this token
 * (404), fall back to single-token mode so we still build something playable.
 */
async function resolveCoords(coords: TokenCoords): Promise<ResolvedTarget> {
  const lookup = await resolveTokenToArtwork(coords.chain, coords.contract, coords.tokenId);
  if (lookup === null) {
    return { kind: 'single', coords };
  }
  const summary = await getArtworkSummary(lookup.artworkId);
  return { kind: 'series', summary };
}

/**
 * Build the playlist title. For series, "Artist — Series Title". For a
 * one-item fallback, use the indexer's token name (already in the item)
 * with a fall-through to coords if name is missing.
 */
function playlistTitleFor(target: ResolvedTarget, items: Array<{ title?: string }>): string {
  if (target.kind === 'series') {
    const artistLabel = target.summary.artists.map((a) => a.name).join(', ') || 'Unknown artist';
    return `${artistLabel} — ${target.summary.title}`;
  }
  return items[0]?.title ?? `Token ${target.coords.tokenId}`;
}

export function parseLimitOption(limitStr: string | undefined): number {
  if (limitStr === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  // Strict integer parse: `Number('5abc')` is NaN, while `parseInt('5abc', 10)`
  // returns 5 and silently truncates user input. Reject anything that isn't a
  // clean positive integer.
  const n = Number(limitStr);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --limit value: ${limitStr} (expected a positive integer)`);
  }
  return n;
}

/**
 * parseServerIndexOption validates a zero-based feed server selection without
 * parseInt-style prefix truncation. Publishing to the wrong configured feed is
 * worse than rejecting a malformed flag, so explicit and prompted server
 * values must be whole-number indexes inside the configured server list.
 */
export function parseServerIndexOption(serverArg: string, serverCount: number): number {
  const serverIndex = Number(serverArg);
  if (
    !Number.isFinite(serverIndex) ||
    !Number.isInteger(serverIndex) ||
    serverIndex < 0 ||
    serverIndex >= serverCount
  ) {
    throw new Error(`Invalid server index: ${serverArg}`);
  }
  return serverIndex;
}

async function fetchTokens(summary: RasterArtworkSummary, limit: number): Promise<TokenCoords[]> {
  const collected: TokenCoords[] = [];
  let cursor: number | undefined;
  let skipped = 0;

  while (collected.length < limit) {
    const page = await listArtworkTokens(summary.artworkId, {
      cursor,
      pageSize: RASTER_PAGE_SIZE,
    });
    skipped += page.skippedUnsupported;
    for (const t of page.tokens) {
      if (collected.length >= limit) {
        break;
      }
      collected.push({
        chain: t.chain,
        contract: t.contractAddress,
        tokenId: t.tokenId,
      });
    }
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
  }

  if (skipped > 0) {
    console.log(
      chalk.yellow(
        `  Skipped ${skipped} token${skipped === 1 ? '' : 's'} on unsupported chains (FF indexer covers eth + tezos mainnet only).`
      )
    );
  }

  return collected;
}

async function pickFromCatalog(
  catalog: RasterArtworkRow[],
  skipPrompt: boolean
): Promise<RasterArtworkRow> {
  if (catalog.length === 1 || skipPrompt) {
    return catalog[0];
  }
  console.log(chalk.cyan(`Found ${catalog.length} artworks for this artist:`));
  catalog.forEach((row, i) => {
    const count = `${row.tokenCount} token${row.tokenCount === 1 ? '' : 's'}`;
    console.log(chalk.dim(`  ${i}: ${row.title} (${count})`));
  });
  console.log();
  const prompt = createPrompt();
  const answer = await prompt.ask(`Pick one (0-${catalog.length - 1}, default 0): `);
  prompt.close();
  console.log();
  const index = answer ? Number.parseInt(answer, 10) : 0;
  if (!Number.isFinite(index) || index < 0 || index >= catalog.length) {
    throw new Error(`Invalid selection: "${answer}"`);
  }
  return catalog[index];
}

async function confirmMakePlaylist(count: number, total: number): Promise<boolean> {
  const noun = total === 1 ? 'token' : 'tokens';
  const label = count < total ? `${count} of ${total} ${noun}` : `${count} ${noun}`;
  const prompt = createPrompt();
  const yes = await promptYesNo(prompt.ask, `Build playlist with ${label}?`, true);
  prompt.close();
  console.log();
  return yes;
}

/**
 * Decide which post-build actions to run.
 *
 * Precedence: explicit flags (--play / --publish) win and may combine. If no
 * flag is set, fall back to --yes default (Play) or an interactive 3-way
 * prompt. Save is unconditional and already done before this is called.
 */
export async function decideActions(options: FindOptions): Promise<PostBuildAction[]> {
  const flagActions: PostBuildAction[] = [];
  if (options.play) {
    flagActions.push('play');
  }
  if (options.publish) {
    flagActions.push('publish');
  }
  if (flagActions.length > 0) {
    return flagActions;
  }
  // --output alone (with or without --yes) means "save mode" — the save was the action.
  if (options.output) {
    return [];
  }
  // --yes without --output defaults to Play (max-satisfaction default for scripted use).
  if (options.yes) {
    return ['play'];
  }
  return [await promptNextAction()];
}

export type { FindOptions };

async function promptNextAction(): Promise<PostBuildAction> {
  const prompt = createPrompt();
  const answer = (
    await prompt.ask('Next? [P]lay on FF1 / just [S]ave / pub[L]ish to feed (default: Play): ')
  )
    .trim()
    .toLowerCase();
  prompt.close();
  console.log();
  if (!answer || answer === 'p' || answer === 'play' || answer === 'y' || answer === 'yes') {
    return 'play';
  }
  if (answer === 's' || answer === 'save' || answer === 'n' || answer === 'no') {
    return 'skip';
  }
  if (answer === 'l' || answer === 'pub' || answer === 'publish') {
    return 'publish';
  }
  throw new Error(`Unrecognized choice: "${answer}". Use P, S, or L.`);
}

/**
 * doPlay prepares a generated `find` playlist for FF1 playback and sends only
 * a verified envelope to the selected device.
 */
export async function doPlay(
  playlist: Playlist,
  deviceName: string | undefined,
  deps: FindPlayDeps = {}
): Promise<void> {
  console.log(chalk.blue('Play on FF1'));
  const preparePlaylistForPlayback =
    deps.preparePlaylistForPlayback ?? prepareGeneratedPlaylistForPlayback;
  const prepared = await preparePlaylistForPlayback(playlist);
  if (!prepared.valid || !prepared.playlist) {
    printFindPlaybackPreparationFailure(prepared);
    process.exitCode = 1;
    return;
  }

  const send = deps.sendPlaylistToDevice ?? sendPlaylistToDevice;
  const result = await send({ playlist: prepared.playlist, deviceName });
  if (result.success) {
    console.log(chalk.green('✓ Playing'));
    if (result.deviceName) {
      console.log(chalk.dim(`  Device: ${result.deviceName}`));
    }
    if (result.device) {
      console.log(chalk.dim(`  Host: ${result.device}`));
    }
    console.log();
    return;
  }
  console.error(chalk.red('Play failed:'), result.error);
  if (result.details) {
    console.error(chalk.dim(`  Details: ${result.details}`));
  }
  process.exitCode = 1;
}

/**
 * prepareGeneratedPlaylistForPlayback enforces the same fail-closed delivery
 * contract as `play` for CLI-generated playlists. `find` can build a playlist
 * without a signing key, but it must not send that unsigned envelope to an FF1
 * device; when a key is available, sign and verify the generated playlist
 * before transport.
 */
export async function prepareGeneratedPlaylistForPlayback(
  playlist: Playlist,
  deps: {
    getPrivateKey?: () => string | undefined;
    signPlaylist?: typeof signPlaylist;
    verifyPlaylist?: (playlist: Playlist) => Promise<PlaylistVerificationResult>;
  } = {}
): Promise<PlaylistVerificationResult> {
  const { verifyPlaylist } = deps.verifyPlaylist
    ? { verifyPlaylist: deps.verifyPlaylist }
    : await import('../utilities/playlist-verifier');

  const verified = await verifyPlaylist(playlist);
  if (verified.valid) {
    return { valid: true, playlist };
  }

  if (hasSignatureMaterial(playlist)) {
    return verified;
  }

  const privateKey =
    deps.getPrivateKey !== undefined
      ? deps.getPrivateKey()
      : (getConfig().playlist?.privateKey ?? process.env.PLAYLIST_PRIVATE_KEY);
  if (!privateKey) {
    return {
      valid: false,
      error: 'Cannot sign playlist for playback: no playlist signing key is configured',
    };
  }

  try {
    const signer = deps.signPlaylist ?? signPlaylist;
    const signature = await signer(playlist, privateKey);
    const signedPlaylist = {
      ...playlist,
      signature: undefined,
      signatures: [signature],
    } as Playlist;
    const signedVerification = await verifyPlaylist(signedPlaylist);
    if (signedVerification.valid) {
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
}

function hasSignatureMaterial(playlist: Playlist): boolean {
  const candidate = playlist as Playlist & { signature?: unknown; signatures?: unknown[] };
  return Boolean(
    candidate.signature || (Array.isArray(candidate.signatures) && candidate.signatures.length > 0)
  );
}

function printFindPlaybackPreparationFailure(result: PlaylistVerificationResult): void {
  console.error(chalk.red('\nCannot play generated playlist:'), result.error);

  if (result.details && result.details.length > 0) {
    console.log(chalk.yellow('\n   Validation errors:'));
    result.details.forEach((detail) => {
      console.log(chalk.yellow(`     • ${detail.path}: ${detail.message}`));
    });
  }

  console.log(
    chalk.yellow(
      '\n   Configure playlist.privateKey or PLAYLIST_PRIVATE_KEY, then rerun find --play.\n'
    )
  );
}

async function doPublish(
  savedPath: string,
  serverArg: string | undefined,
  nonInteractive: boolean
): Promise<void> {
  console.log(chalk.blue('Publish to feed'));
  const { getFeedConfig } = await import('../config');
  const { publishPlaylist } = await import('../utilities/playlist-publisher');

  const feedConfig = getFeedConfig();
  if (!feedConfig.baseURLs || feedConfig.baseURLs.length === 0) {
    console.error(chalk.red('No feed servers configured.'));
    console.error(chalk.yellow('  Add feed server URLs to config.json: feed.baseURLs'));
    process.exitCode = 1;
    return;
  }

  let serverIndex = 0;
  if (serverArg !== undefined) {
    try {
      serverIndex = parseServerIndexOption(serverArg, feedConfig.baseURLs.length);
    } catch (error) {
      console.error(chalk.red((error as Error).message));
      process.exitCode = 1;
      return;
    }
  } else if (feedConfig.baseURLs.length > 1) {
    if (nonInteractive) {
      console.error(
        chalk.red(
          `Multiple feed servers configured (${feedConfig.baseURLs.length}); pass --server <index> when running with --yes.`
        )
      );
      process.exitCode = 1;
      return;
    } else {
      console.log(chalk.yellow(`Multiple feed servers configured:`));
      feedConfig.baseURLs.forEach((url, i) => {
        console.log(chalk.cyan(`  ${i}: ${url}`));
      });
      const prompt = createPrompt();
      const answer = await prompt.ask('Select server (0-based index): ');
      prompt.close();
      console.log();
      try {
        serverIndex = parseServerIndexOption(answer, feedConfig.baseURLs.length);
      } catch (error) {
        console.error(chalk.red((error as Error).message));
        process.exitCode = 1;
        return;
      }
    }
  }

  const serverUrl = feedConfig.baseURLs[serverIndex];
  const serverApiKey = feedConfig.servers?.[serverIndex]?.apiKey ?? feedConfig.apiKey;

  const result = await publishPlaylist(savedPath, serverUrl, serverApiKey);
  if (result.success) {
    console.log(chalk.green('✓ Published'));
    if (result.playlistId) {
      console.log(chalk.dim(`  Playlist ID: ${result.playlistId}`));
    }
    if (result.feedServer) {
      console.log(chalk.dim(`  Server: ${result.feedServer}`));
    }
    console.log();
    return;
  }
  console.error(chalk.red('Publish failed:'), result.error);
  if (result.message) {
    console.error(chalk.dim(`  ${result.message}`));
  }
  process.exitCode = 1;
}
