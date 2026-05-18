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

const RASTER_PAGE_SIZE = 100;
const INDEXER_CONCURRENCY = 10;

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
  .option('-y, --yes', 'Skip interactive prompts; default action is Play')
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

      const summary = await resolveToArtworkSummary(parsed, !!options.yes);

      console.log(chalk.cyan(formatSummaryLine(summary)));
      console.log();

      const shouldBuild =
        !!options.yes || !!options.output || (await confirmMakePlaylist(summary.tokenCount));
      if (!shouldBuild) {
        console.log(chalk.dim('Cancelled.'));
        return;
      }

      const tokens = await fetchTokens(summary, options.limit);
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
        INDEXER_CONCURRENCY
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

      const artistLabel = summary.artists.map((a) => a.name).join(', ') || 'Unknown artist';
      const playlist = await buildDP1Playlist({
        items,
        title: `${artistLabel} — ${summary.title}`,
      });

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
          await doPublish(outputPath, options.server);
        }
      }
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });

async function resolveToArtworkSummary(
  parsed: NonNullable<ReturnType<typeof parseFindInput>>,
  skipPrompt: boolean
): Promise<RasterArtworkSummary> {
  if (parsed.kind === 'token') {
    return resolveCoordsToSummary(parsed.coords);
  }
  if (parsed.kind === 'ff-url') {
    const coords = await resolveFeralFileToken(parsed);
    return resolveCoordsToSummary(coords);
  }
  if (parsed.kind === 'objkt-alias') {
    const contract = await resolveObjktAlias(parsed.alias);
    return resolveCoordsToSummary({
      chain: 'tezos',
      contract,
      tokenId: parsed.tokenId,
    });
  }
  if (parsed.kind === 'ab-collection') {
    const coords = await resolveArtBlocksCollection(parsed.slug);
    return resolveCoordsToSummary(coords);
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
    return getArtworkSummary(picked.artworkId);
  }
  // `unsupported` is handled upstream; this branch keeps the type narrowing honest.
  throw new Error(`Unsupported parse result: ${parsed.kind}`);
}

async function resolveCoordsToSummary(coords: TokenCoords): Promise<RasterArtworkSummary> {
  const { artworkId } = await resolveTokenToArtwork(coords.chain, coords.contract, coords.tokenId);
  return getArtworkSummary(artworkId);
}

async function fetchTokens(
  summary: RasterArtworkSummary,
  limitStr: string | undefined
): Promise<TokenCoords[]> {
  const limit = limitStr ? Number.parseInt(limitStr, 10) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(limit) && limitStr) {
    throw new Error(`Invalid --limit value: ${limitStr}`);
  }

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

async function confirmMakePlaylist(tokenCount: number): Promise<boolean> {
  const prompt = createPrompt();
  const yes = await promptYesNo(
    prompt.ask,
    `Build playlist with ${tokenCount} token${tokenCount === 1 ? '' : 's'}?`,
    true
  );
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
async function decideActions(options: FindOptions): Promise<PostBuildAction[]> {
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

async function doPlay(playlist: Playlist, deviceName: string | undefined): Promise<void> {
  console.log(chalk.blue('Play on FF1'));
  const result = await sendPlaylistToDevice({ playlist, deviceName });
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

async function doPublish(savedPath: string, serverArg: string | undefined): Promise<void> {
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
  if (feedConfig.baseURLs.length > 1) {
    if (serverArg !== undefined) {
      serverIndex = Number.parseInt(serverArg, 10);
    } else {
      console.log(chalk.yellow(`Multiple feed servers configured:`));
      feedConfig.baseURLs.forEach((url, i) => {
        console.log(chalk.cyan(`  ${i}: ${url}`));
      });
      const prompt = createPrompt();
      const answer = await prompt.ask('Select server (0-based index): ');
      prompt.close();
      console.log();
      serverIndex = Number.parseInt(answer, 10);
    }
  }
  if (
    !Number.isFinite(serverIndex) ||
    serverIndex < 0 ||
    serverIndex >= feedConfig.baseURLs.length
  ) {
    console.error(chalk.red(`Invalid server index: ${serverArg ?? serverIndex}`));
    process.exitCode = 1;
    return;
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
