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
import { resolveFxhashIteration, resolveFxhashProject } from '../utilities/fxhash-marketplace';
import { resolveNeortArt } from '../utilities/neort-marketplace';
import type { NeortArt } from '../utilities/neort-marketplace';
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
const { buildDP1Playlist, buildUrlItem } = require('../utilities/playlist-builder');

interface FindOptions {
  output?: string;
  limit?: string;
  yes?: boolean;
  play?: boolean;
  device?: string;
  publish?: boolean;
  server?: string;
  skipVerify?: boolean;
}

/**
 * Maximum item count for a single DP-1 playlist (v1.1 spec). Build paths
 * that exceed this would silently produce a playlist that `validateDP1Playlist`
 * rejects — so cap implicitly here and surface an actionable warning, and
 * reject explicit `--limit > MAX` outright.
 */
const DP1_MAX_ITEMS = 1024;

type PostBuildAction = 'play' | 'publish' | 'skip';

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

export const findCommand = new Command('find')
  .description('Find an artwork on the web and build a DP-1 playlist')
  .argument(
    '<input>',
    'URL (Objkt / fxhash / Art Blocks / OpenSea / SuperRare / Feral File / Neort), `ethereum:{contract}:{tokenId}`, `tezos:{contract}:{tokenId}`, or a wallet address'
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
  .option(
    '--skip-verify',
    'Skip signature verification before --play (mirrors `ff-cli play --skip-verify`)'
  )
  .action(async (input: string, options: FindOptions) => {
    try {
      console.log(chalk.blue('\nFind on Feral File CLI\n'));

      const parsed = parseFindInput(input);
      if (!parsed) {
        console.error(chalk.red('Could not understand input.'));
        console.error(
          chalk.dim(
            'Supported URLs: Objkt, fxhash, Art Blocks, OpenSea, SuperRare, Feral File, Neort. ' +
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

      // Neort is off-chain; its items skip Raster + FF indexer entirely and
      // build a DP-1 entry directly from Neort's API response.
      if (parsed.kind === 'neort-art') {
        await runNeortFind(parsed.id, options);
        return;
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

      const userLimit = parseLimitOption(options.limit);
      const seriesTotal = target.kind === 'series' ? target.summary.tokenCount : 1;
      // Implicit cap: no --limit + series > 1024 → cap to DP-1 max with a
      // clear warning. Explicit `--limit > 1024` was already rejected by
      // parseLimitOption, so reaching here means either capped-by-default or
      // the user picked a value within spec.
      const limit = Math.min(userLimit, DP1_MAX_ITEMS);
      if (userLimit === Number.POSITIVE_INFINITY && seriesTotal > DP1_MAX_ITEMS) {
        console.log(
          chalk.yellow(
            `Series has ${seriesTotal} tokens; DP-1 caps playlists at ${DP1_MAX_ITEMS}. ` +
              `Building with the first ${DP1_MAX_ITEMS} — pass \`--limit N\` (≤ ${DP1_MAX_ITEMS}) for fewer.`
          )
        );
        console.log();
      }
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

      // Second positional arg on getNFTTokenInfoBatch is `duration` (DP-1 item
      // display seconds), not concurrency — concurrency is hardcoded inside.
      // Omit it so the default (10s) applies; no misleading constant on this side.
      const items = await getNFTTokenInfoBatch(
        tokens.map((t) => ({
          chain: t.chain,
          contractAddress: t.contract,
          tokenId: t.tokenId,
        }))
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
          await doPlay(playlist, options.device, !!options.skipVerify);
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
  if (parsed.kind === 'fxhash-iteration') {
    const coords = await resolveFxhashIteration(parsed.slug);
    return resolveCoords(coords);
  }
  if (parsed.kind === 'fxhash-project') {
    const coords = await resolveFxhashProject(parsed.slug);
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
  if (n > DP1_MAX_ITEMS) {
    throw new Error(
      `Invalid --limit value: ${n} exceeds DP-1 playlist max of ${DP1_MAX_ITEMS} items.`
    );
  }
  return n;
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
  // Strict integer parse: Number.parseInt('5abc') silently returns 5; here we
  // want '5abc' to be rejected outright. Same anti-pattern parseLimitOption fixes.
  const index = answer ? Number(answer) : 0;
  if (!Number.isInteger(index) || index < 0 || index >= catalog.length) {
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

async function doPlay(
  playlist: Playlist,
  deviceName: string | undefined,
  skipVerify: boolean
): Promise<void> {
  // Match `ff-cli play`'s verification gate: signed playlists are verified
  // before device delivery; the same surface that play surfaces failures.
  // `buildDP1Playlist` signs when a playlist private key is configured and
  // silently continues unsigned otherwise — so when no key is set, the user
  // sees an actionable error here instead of an unverifiable playlist on
  // the wall.
  if (!skipVerify) {
    const { verifyPlaylist } = await import('../utilities/playlist-verifier');
    console.log(chalk.cyan('Verify playlist'));
    const verifyResult = await verifyPlaylist(playlist);
    if (!verifyResult.valid) {
      console.error(chalk.red('Playlist verification failed:'), verifyResult.error);
      if (verifyResult.details && verifyResult.details.length > 0) {
        for (const d of verifyResult.details) {
          console.error(chalk.dim(`  ${d.path}: ${d.message}`));
        }
      }
      console.error(
        chalk.dim(
          '  Tip: configure a playlist signing key (config or PLAYLIST_PRIVATE_KEY), ' +
            'or pass --skip-verify to bypass.'
        )
      );
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green('✓ Verified\n'));
  }
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

  // Validate --server regardless of server count. parseInt('0abc') would
  // silently truncate to 0 and route to a different server; with a single
  // server configured the old code skipped --server validation entirely and
  // accepted any garbage value while publishing to baseURLs[0].
  let serverIndex = 0;
  if (serverArg !== undefined) {
    const n = Number(serverArg);
    if (!Number.isInteger(n) || n < 0 || n >= feedConfig.baseURLs.length) {
      console.error(
        chalk.red(
          `Invalid --server value: ${serverArg} (expected integer in 0..${feedConfig.baseURLs.length - 1})`
        )
      );
      process.exitCode = 1;
      return;
    }
    serverIndex = n;
  } else if (feedConfig.baseURLs.length > 1) {
    if (nonInteractive) {
      console.error(
        chalk.red(
          `Multiple feed servers configured (${feedConfig.baseURLs.length}); pass --server <index> when running with --yes.`
        )
      );
      process.exitCode = 1;
      return;
    }
    console.log(chalk.yellow(`Multiple feed servers configured:`));
    feedConfig.baseURLs.forEach((url, i) => {
      console.log(chalk.cyan(`  ${i}: ${url}`));
    });
    const prompt = createPrompt();
    const answer = await prompt.ask('Select server (0-based index): ');
    prompt.close();
    console.log();
    const n = Number(answer);
    if (!Number.isInteger(n) || n < 0 || n >= feedConfig.baseURLs.length) {
      console.error(
        chalk.red(
          `Invalid selection: ${answer} (expected integer in 0..${feedConfig.baseURLs.length - 1})`
        )
      );
      process.exitCode = 1;
      return;
    }
    serverIndex = n;
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

/**
 * Neort flow. Off-chain platform with no on-chain coords, so we bypass
 * Raster + FF indexer and construct a single-item DP-1 playlist directly
 * from Neort's API response using the off-chain `provenance.offChainURI`
 * shape produced by `buildUrlItem`.
 */
async function runNeortFind(id: string, options: FindOptions): Promise<void> {
  const art: NeortArt = await resolveNeortArt(id);
  const artistLabel = art.artistName || 'Unknown artist';
  console.log(chalk.cyan(`Neort — ${artistLabel} — ${art.title}`));
  console.log(
    chalk.dim('  (Off-chain platform; building a one-item playlist directly from Neort.)')
  );
  console.log();

  const shouldBuild = !!options.yes || !!options.output || (await confirmMakePlaylist(1, 1));
  if (!shouldBuild) {
    console.log(chalk.dim('Cancelled.'));
    return;
  }

  const item = buildUrlItem(art.assetUrl, 10, { title: art.title });
  const playlistTitle = `${artistLabel} — ${art.title}`;
  const playlist = await buildDP1Playlist({ items: [item], title: playlistTitle });

  const outputPath = options.output ?? `${playlist.slug || 'playlist'}.json`;
  await fs.writeFile(outputPath, JSON.stringify(playlist, null, 2));

  console.log(chalk.green(`✓ Playlist saved to ${outputPath}`));
  console.log(chalk.dim('  1 item'));
  console.log();

  const actions = await decideActions(options);
  for (const action of actions) {
    if (action === 'play') {
      await doPlay(playlist, options.device);
    } else if (action === 'publish') {
      await doPublish(outputPath, options.server, !!options.yes);
    }
  }
}
