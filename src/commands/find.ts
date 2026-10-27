import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import { parseFindInput, resolveTokenInfos } from '@feralfile/source-resolver';
import type { TokenCoords } from '@feralfile/source-resolver';
import type { Playlist } from '../types';
import { createPrompt, promptYesNo } from './helpers/prompt';
import { selectFeedServer } from './helpers/feed-server';
import { resolveFeralFileToken } from '../utilities/ff-marketplace';
import { resolveObjktAlias } from '../utilities/objkt-marketplace';
import { resolveArtBlocksCollection } from '../utilities/ab-marketplace';
import { resolveOpenSeaCollection } from '../utilities/opensea-marketplace';
import { resolveFxhashIteration, resolveFxhashProject } from '../utilities/fxhash-marketplace';
import { resolveNeortArt } from '../utilities/neort-marketplace';
import type { NeortArt } from '../utilities/neort-marketplace';
import { resolveVerseSeries } from '../utilities/verse-marketplace';
import {
  resolveTokenToArtwork,
  resolveSlugToArtwork,
  listArtworkTokens,
  listArtistArtworks,
  resolveAddressToArtist,
  formatSummaryLine,
  RasterUnreachableError,
} from '../utilities/raster-client';
import type {
  RasterArtworkSummary,
  RasterArtworkRow,
  RasterToken,
} from '../utilities/raster-client';
import { castPlaylist } from '../utilities/playlist-cast';
import {
  failureMessages,
  getTokenSource,
  itemsOf,
  type ResolvedToken,
  type TokenSource,
} from '../utilities/token-source';
import { itemsFromRasterTokens } from '../utilities/token-source-raster';
import { getTokenSourceConfig } from '../config';

// playlist-builder is still CommonJS; require keeps interop simple.
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
 *   back to a one-item playlist for the pasted token.
 * `token-list` — the source-resolver library returned concrete token
 *   coordinates for a collection-like page, so no Raster series lookup is
 *   needed before handing tokens to the token source.
 */
type ResolvedTarget =
  | { kind: 'series'; summary: RasterArtworkSummary }
  | { kind: 'single'; coords: TokenCoords }
  | { kind: 'token-list'; title: string; coords: TokenCoords[]; hasMore?: boolean };

/**
 * A token to build into the playlist. `rasterToken` is the full Raster row
 * when a series page already returned it, so the Raster token source can
 * build the item without asking Raster again.
 */
type BuildToken = TokenCoords & { rasterToken: RasterToken | null };

const RASTER_PAGE_SIZE = 100;

/**
 * FIND_NON_INTERACTIVE_HINT is what `find` tells a caller without a terminal
 * when one of its questions comes up. `-y` answers every question with its
 * default, and that default is Play, so the hint names `--no-play` in the same
 * breath for a caller that only wants the file.
 */
const FIND_NON_INTERACTIVE_HINT =
  'Re-run with -y to accept the defaults (it builds the playlist and plays it on your FF1); add --no-play to only save it.';

/**
 * playAPageHint points a caller who handed `find` a page it cannot resolve to
 * the command that shows a page as it is.
 *
 * @param {string} input - The URL the caller gave `find`
 * @returns {string} One line naming `ff-cli play --web`
 */
function playAPageHint(input: string): string {
  return `To show this page itself on your FF1, run: ff-cli play --web "${input}"`;
}

export const findCommand = new Command('find')
  .description('Find an artwork on the web and build a DP-1 playlist')
  .argument(
    '<input>',
    'URL (Objkt / fxhash / Art Blocks / OpenSea / SuperRare / Feral File / Neort / Verse / Raster), `ethereum:{contract}:{tokenId}`, `tezos:{contract}:{tokenId}`, or a wallet address (picks one work by the artist at that address; for what a wallet owns, see `ff-cli build --help`)'
  )
  .option('-o, --output <path>', 'Save the playlist to this file (default: ./<slug>.json)')
  .option('-l, --limit <n>', 'Max tokens to include from the series (default: all)')
  .option('-p, --play', 'Play the playlist on an FF1 device after building')
  .option('--no-play', 'Never cast to a device; combine with -y to build and save without playing')
  .option('-d, --device <name>', 'Device to play on (used with --play; default: first configured)')
  .option('--publish', 'Publish the playlist to a configured feed server')
  .option('-s, --server <index>', 'Feed server index (used with --publish)')
  .option(
    '-y, --yes',
    'Skip interactive prompts. Without --output or --publish, -y plays the playlist on a device; add --no-play to skip casting'
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
            'Supported URLs: Objkt, fxhash, Art Blocks, OpenSea, SuperRare, Feral File, Neort, Verse, Raster. ' +
              'Or: `ethereum:{contract}:{tokenId}`, `tezos:{contract}:{tokenId}`, ' +
              'or a wallet address (`0x...` / `tz1.../tz2.../tz3...`).'
          )
        );
        // A plain web page or media URL is not an artwork lookup at all; `play`
        // casts those directly, so name it rather than leave the caller stuck.
        if (/^https?:\/\//i.test(input.trim())) {
          console.error(
            chalk.dim(`To play a web page or media URL as it is, run: ff-cli play "${input}"`)
          );
        }
        process.exit(1);
      }
      if (parsed.kind === 'unsupported') {
        const resolved = await resolveTokenListInput(input, resolverLimitFromOption(options.limit));
        if (resolved) {
          await runResolvedTarget(resolved, options);
          return;
        }
        console.error(chalk.red(parsed.reason));
        // `play` sends unrecognized pages on these hosts here, so the way out
        // of that loop has to be printed on this side too.
        console.error(chalk.dim(playAPageHint(input)));
        process.exit(1);
      }

      // Neort is off-chain; its items skip the token source entirely and
      // build a DP-1 entry directly from Neort's API response.
      if (parsed.kind === 'neort-art') {
        await runNeortFind(parsed.id, options);
        return;
      }

      const target = await resolveTarget(input, parsed, !!options.yes, options.limit);
      await runResolvedTarget(target, options);
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });

async function runResolvedTarget(target: ResolvedTarget, options: FindOptions): Promise<void> {
  if (target.kind === 'series') {
    console.log(chalk.cyan(formatSummaryLine(target.summary)));
  } else if (target.kind === 'token-list') {
    console.log(chalk.cyan(target.title));
  } else {
    const { chain, contract, tokenId } = target.coords;
    console.log(chalk.cyan(`Single token — ${chain} ${contract}:${tokenId}`));
    console.log(chalk.dim("  (Raster doesn't index this series — building a one-item playlist.)"));
  }
  console.log();

  const userLimit = parseLimitOption(options.limit);
  // Implicit cap: no --limit + series > 1024 → cap to DP-1 max with a
  // clear warning. Explicit `--limit > 1024` was already rejected by
  // parseLimitOption, so reaching here means either capped-by-default or
  // the user picked a value within spec.
  const limit = Math.min(userLimit, DP1_MAX_ITEMS);

  // Raster's GraphQL API exposes no series token counts, so enumerate
  // tokens first (up to the effective limit) and confirm with the real
  // number afterward. `hasMore` means the series continues past `limit`.
  let tokens: BuildToken[];
  let seriesHasMore = false;
  if (target.kind === 'series') {
    const fetched = await fetchTokens(target.summary, limit);
    tokens = fetched.tokens;
    seriesHasMore = fetched.hasMore;
  } else if (target.kind === 'token-list') {
    const allTokens = target.coords.map((coords) => ({
      ...coords,
      rasterToken: null,
    }));
    tokens = allTokens.slice(0, limit);
    seriesHasMore = allTokens.length > limit || !!target.hasMore;
  } else {
    tokens = [{ ...target.coords, rasterToken: null }];
  }

  if (tokens.length === 0) {
    console.error(
      chalk.red('Series has no tokens on supported chains (Ethereum + Tezos mainnet).')
    );
    process.exit(1);
  }

  if (userLimit === Number.POSITIVE_INFINITY && seriesHasMore) {
    console.log(
      chalk.yellow(
        `Series has more than ${DP1_MAX_ITEMS} tokens; DP-1 caps playlists at ${DP1_MAX_ITEMS}. ` +
          `Building with the first ${DP1_MAX_ITEMS} — pass \`--limit N\` (≤ ${DP1_MAX_ITEMS}) for fewer.`
      )
    );
    console.log();
  }

  const shouldBuild =
    !!options.yes || !!options.output || (await confirmMakePlaylist(tokens.length, seriesHasMore));
  if (!shouldBuild) {
    console.log(chalk.dim('Cancelled.'));
    return;
  }
  const source = getTokenSource();
  const label = source.name === 'raster' ? 'Raster' : 'FF indexer';
  console.log(
    chalk.dim(`Resolving ${tokens.length} token${tokens.length === 1 ? '' : 's'} via ${label}...`)
  );
  // The indexer warms previously-unseen tokens by polling, which
  // takes minutes on a large series; Raster answers from its own index.
  if (source.name === 'indexer' && tokens.length > 10) {
    console.log(
      chalk.dim(
        '  First-time tokens can take the indexer a while to warm; use `--limit 5` for a faster first pass.'
      )
    );
  }
  const results = await resolveBuildTokens(source, tokens);
  const items = itemsOf(results);

  if (items.length === 0) {
    console.error(chalk.red(`No tokens could be resolved via ${label}; cannot build playlist.`));
    for (const message of failureMessages(results)) {
      console.error(chalk.dim(`  ${message}`));
    }
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
    console.log(chalk.dim(`  ${dropped} token${dropped === 1 ? '' : 's'} could not be resolved:`));
    for (const message of failureMessages(results)) {
      console.log(chalk.dim(`    ${message}`));
    }
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
}

async function resolveTarget(
  input: string,
  parsed: NonNullable<ReturnType<typeof parseFindInput>>,
  skipPrompt: boolean,
  limitOption: string | undefined
): Promise<ResolvedTarget> {
  if (parsed.kind === 'token') {
    return resolveCoords(parsed.coords);
  }
  if (parsed.kind === 'ff-url') {
    // Shows and series both resolve through the source-resolver's Feral File
    // site module, which enumerates exactly the tokens the page describes
    // (series slug → /api/series → /api/artworks?seriesID). The old series
    // path resolved ONE token via ff-marketplace and then asked Raster, which
    // expands to the token's parent artwork — so a single-edition series page
    // (e.g. a Display Edition) surprisingly built the sibling collection's
    // full token list. A series URL means the user pointed at a specific
    // series; build exactly that. Artwork URLs keep the coords→Raster path:
    // a single-token page carries no series intent to preserve.
    if (parsed.urlKind === 'show' || parsed.urlKind === 'series') {
      const label = parsed.urlKind === 'show' ? 'show' : 'series';
      const target = await resolveTokenListInput(
        input,
        resolverLimitFromOption(limitOption),
        `Feral File ${label} ${parsed.identifier}`
      );
      if (target === null) {
        throw new Error(
          `Feral File: no supported tokens found for ${label} "${parsed.identifier}".`
        );
      }
      return target;
    }
    const coords = await resolveFeralFileToken(parsed);
    return resolveCoords(coords);
  }
  if (parsed.kind === 'objkt-alias') {
    const contract = await resolveObjktAlias(parsed.alias);
    return resolveCoords({ chain: 'tezos', contract, tokenId: parsed.tokenId });
  }
  if (parsed.kind === 'objkt-collection') {
    const target = await resolveTokenListInput(
      input,
      resolverLimitFromOption(limitOption),
      `Objkt collection ${parsed.slug}`
    );
    if (target === null) {
      throw new Error(`Objkt: no supported tokens found for collection "${parsed.slug}".`);
    }
    return target;
  }
  if (parsed.kind === 'ab-collection') {
    const coords = await resolveArtBlocksCollection(parsed.slug);
    return resolveCoords(coords);
  }
  if (parsed.kind === 'os-collection') {
    const coords = await resolveOpenSeaCollection(parsed.slug);
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
  if (parsed.kind === 'verse-series') {
    const target = await resolveTokenListInput(
      input,
      resolverLimitFromOption(limitOption),
      `Verse series ${parsed.slug}`
    );
    if (target !== null) {
      return target;
    }
    const coords = await resolveVerseSeries(parsed.slug);
    return resolveCoords(coords);
  }
  if (parsed.kind === 'raster-artwork') {
    const summary = await resolveSlugToArtwork(parsed.slug);
    if (summary === null) {
      throw new Error(
        `No artwork found on Raster for slug "${parsed.slug}". ` +
          'Check the URL — Raster artwork URLs are raster.art/artwork/{slug}.'
      );
    }
    return { kind: 'series', summary };
  }
  if (parsed.kind === 'address') {
    const artist = await resolveAddressToArtist(parsed.address);
    if (artist === null) {
      throw new Error(
        `No artist found on Raster for address ${parsed.address}. ` +
          'Raster indexes artists by their on-chain addresses; this address may not yet be claimed.'
      );
    }
    const catalog = await listArtistArtworks(artist.id);
    if (catalog.length === 0) {
      throw new Error('Artist has no artworks indexed on Raster.');
    }
    // A wallet address reads naturally as "what this wallet owns", and this
    // path builds something else: one work by the artist at the address. Say
    // so every time, so neither a person nor an agent mistakes the result.
    console.log(
      chalk.dim(
        'find on an address plays one work by the artist at that address. ' +
          'For what the wallet owns, use build with a query_address requirement (ff-cli build --help).'
      )
    );
    const picked = await pickFromCatalog(catalog, skipPrompt);
    return {
      kind: 'series',
      summary: { artworkId: picked.artworkId, title: picked.title, artists: [artist] },
    };
  }
  // `unsupported` is handled upstream; this branch keeps the type narrowing honest.
  throw new Error(`Unsupported parse result: ${parsed.kind}`);
}

/**
 * resolverLimitFromOption returns the exact bound to give source-resolver
 * before any collection-like network fetch starts. The CLI still slices
 * locally in `runResolvedTarget`, but passing this value early keeps large
 * marketplace catalogs from being over-resolved when the user requested a
 * smaller playlist.
 */
function resolverLimitFromOption(limitStr: string | undefined): number {
  return Math.min(parseLimitOption(limitStr), DP1_MAX_ITEMS);
}

/**
 * Resolve collection-like URLs through the source-resolver package when its
 * committed support goes beyond the synchronous parser marker. This keeps the
 * CLI aligned with the library without duplicating every marketplace API and
 * DOM extraction fallback locally.
 */
async function resolveTokenListInput(
  input: string,
  limit: number,
  fallbackTitle = 'Resolved source'
): Promise<ResolvedTarget | null> {
  const result = await resolveTokenInfos(input, { limit });
  if (result.kind !== 'tokens') {
    return null;
  }
  return {
    kind: 'token-list',
    title: result.title ?? fallbackTitle,
    coords: result.coords,
    hasMore: result.hasMore,
  };
}

/**
 * Resolve on-chain coords to a target. If Raster doesn't index this token,
 * fall back to single-token mode so we still build something playable.
 *
 * Raster being unreachable gets the same fallback: it only enriches the find
 * (series enumeration, artist labels) — the coords in hand are enough to
 * build a playable single-token playlist, and a network blip on one optional
 * dependency must not kill the whole command (#97).
 */
async function resolveCoords(coords: TokenCoords): Promise<ResolvedTarget> {
  let summary: RasterArtworkSummary | null;
  try {
    summary = await resolveTokenToArtwork(coords.chain, coords.contract, coords.tokenId);
  } catch (error) {
    if (!(error instanceof RasterUnreachableError)) {
      throw error;
    }
    console.log(chalk.yellow(`  ${error.message}`));
    console.log(chalk.dim('  Continuing without Raster — building a one-item playlist.'));
    return { kind: 'single', coords };
  }
  if (summary === null) {
    return { kind: 'single', coords };
  }
  return { kind: 'series', summary };
}

/**
 * Build the playlist title. For series, "Artist — Series Title". For a
 * one-item fallback, use the token source's name (already in the item)
 * with a fall-through to coords if name is missing.
 */
function playlistTitleFor(target: ResolvedTarget, items: Array<{ title?: string }>): string {
  if (target.kind === 'series') {
    const artistLabel = target.summary.artists.map((a) => a.name).join(', ') || 'Unknown artist';
    return `${artistLabel} — ${target.summary.title}`;
  }
  if (target.kind === 'token-list') {
    return target.title;
  }
  return items[0]?.title ?? `Token ${target.coords.tokenId}`;
}

/**
 * resolveBuildTokens turns the tokens to build into results, one per token.
 *
 * When every token already carries its Raster row (a Raster series page) and
 * Raster is the token source, the rows are mapped directly: the page already
 * paid for every field, so asking again would double the requests. Any other
 * mix goes through the token source by coordinate.
 */
async function resolveBuildTokens(
  source: TokenSource,
  tokens: BuildToken[]
): Promise<ResolvedToken[]> {
  const rows = tokens.map((t) => t.rasterToken);
  if (source.name === 'raster' && rows.every((row): row is RasterToken => row !== null)) {
    const entries = tokens.map((t, i) => ({ token: rows[i], requested: coordinateOf(t) }));
    return itemsFromRasterTokens(entries, getTokenSourceConfig().ipfsGateways);
  }
  // Unconditional progress: the final N/N line IS the "resolution finished"
  // signal, including for a single-batch run.
  return source.resolveTokens(tokens.map(coordinateOf), {
    onProgress: (done: number, total: number) => {
      console.log(chalk.dim(`  ${done}/${total} tokens resolved...`));
    },
  });
}

/** coordinateOf converts a find token to the token source's coordinate shape. */
function coordinateOf(token: BuildToken): {
  chain: string;
  contractAddress: string;
  tokenId: string;
} {
  return { chain: token.chain, contractAddress: token.contract, tokenId: token.tokenId };
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

/**
 * Enumerate series tokens from Raster up to `limit`. `hasMore` reports
 * whether the series continues past what was collected — the API exposes
 * no total counts, so this is all the size information the flow gets.
 */
async function fetchTokens(
  summary: RasterArtworkSummary,
  limit: number
): Promise<{ tokens: BuildToken[]; hasMore: boolean }> {
  const collected: BuildToken[] = [];
  let cursor: string | undefined;
  let skipped = 0;
  let hasMore = false;

  for (;;) {
    const page = await listArtworkTokens(summary.artworkId, {
      cursor,
      pageSize: RASTER_PAGE_SIZE,
    });
    skipped += page.skippedUnsupported;
    for (const t of page.tokens) {
      if (collected.length >= limit) {
        hasMore = true;
        break;
      }
      collected.push({
        chain: t.chain,
        contract: t.contractAddress,
        tokenId: t.tokenId,
        rasterToken: t.token,
      });
    }
    if (hasMore || page.nextCursor === null) {
      break;
    }
    if (collected.length >= limit) {
      hasMore = true;
      break;
    }
    cursor = page.nextCursor;
  }

  if (skipped > 0) {
    console.log(
      chalk.yellow(
        `  Skipped ${skipped} token${skipped === 1 ? '' : 's'} on unsupported chains (ff-cli builds Ethereum and Tezos mainnet only).`
      )
    );
  }

  return { tokens: collected, hasMore };
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
    console.log(chalk.dim(`  ${i}: ${row.title}`));
  });
  console.log();
  const prompt = createPrompt(FIND_NON_INTERACTIVE_HINT);
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

async function confirmMakePlaylist(count: number, hasMore: boolean): Promise<boolean> {
  const noun = count === 1 ? 'token' : 'tokens';
  const label = hasMore ? `the first ${count} ${noun}` : `${count} ${noun}`;
  const prompt = createPrompt(FIND_NON_INTERACTIVE_HINT);
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
 *
 * `--no-play` (commander sets `play === false`) is an opt-out that removes
 * casting from every path, including the `--yes` default and the interactive
 * prompt. It is additive: `--yes` alone keeps its deliberate "max-satisfaction
 * default for scripted use" of Play, and this must not change that. Because
 * `--no-play` already states the user's intent, it never opens the prompt.
 */
export async function decideActions(options: FindOptions): Promise<PostBuildAction[]> {
  const flagActions: PostBuildAction[] = [];
  const noPlay = options.play === false;
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
  // --no-play likewise means the save was the action; never prompt or default to Play.
  if (options.output || noPlay) {
    return [];
  }
  // --yes without --output defaults to Play (max-satisfaction default for scripted use).
  if (options.yes) {
    return ['play'];
  }
  return [await promptNextAction()];
}

export type { FindOptions, BuildToken, ResolvedTarget };

async function promptNextAction(): Promise<PostBuildAction> {
  const prompt = createPrompt(
    'The playlist is saved. Pass --play to cast it, or --publish to publish it.'
  );
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
  // Same verify → send gate `ff-cli play` uses, via the shared castPlaylist
  // helper. `find`'s playlists are already signed by buildDP1Playlist (when a
  // key is configured), so no signing is requested here — an unsigned one
  // fails the verify gate with an actionable message instead of reaching the
  // wall unverifiable.
  if (!skipVerify) {
    console.log(chalk.cyan('Verify playlist'));
  }

  const result = await castPlaylist(playlist, { deviceName, skipVerify });

  if (!result.success) {
    if (result.stage === 'verify') {
      console.error(chalk.red('Playlist verification failed:'), result.error);
      if (result.details && result.details.length > 0) {
        for (const d of result.details) {
          console.error(chalk.dim(`  ${d.path}: ${d.message}`));
        }
      }
      console.error(
        chalk.dim(
          '  Tip: configure a playlist signing key (config or PLAYLIST_PRIVATE_KEY), ' +
            'or pass --skip-verify to bypass.'
        )
      );
    } else {
      console.error(chalk.red('Play failed:'), result.error);
      if (result.deviceDetails) {
        console.error(chalk.dim(`  Details: ${result.deviceDetails}`));
      }
    }
    process.exitCode = 1;
    return;
  }

  if (result.verified) {
    console.log(chalk.green('✓ Verified\n'));
  }
  console.log(chalk.blue('Play on FF1'));
  console.log(chalk.green('✓ Playing'));
  if (result.deviceName) {
    console.log(chalk.dim(`  Device: ${result.deviceName}`));
  }
  if (result.device) {
    console.log(chalk.dim(`  Host: ${result.device}`));
  }
  console.log();
}

async function doPublish(
  savedPath: string,
  serverArg: string | undefined,
  nonInteractive: boolean
): Promise<void> {
  console.log(chalk.blue('Publish to feed'));
  const { getFeedConfig } = await import('../config.js');
  const { publishPlaylist } = await import('../utilities/playlist-publisher.js');

  const feedConfig = getFeedConfig();
  // One implementation of the server rule for every write path (see helpers/feed-server.ts): --server is
  // validated whatever the server count, and an ambiguous choice fails loudly rather than defaulting.
  const selection = await selectFeedServer(feedConfig.baseURLs, {
    serverArg,
    nonInteractive,
  });
  if (!selection.ok) {
    console.error(chalk.red(selection.error));
    if (selection.detail) {
      console.error(selection.detail);
    }
    process.exitCode = 1;
    return;
  }

  const serverUrl = selection.url;

  const result = await publishPlaylist(savedPath, serverUrl);
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
 * the token source and construct a single-item DP-1 playlist directly
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

  const shouldBuild = !!options.yes || !!options.output || (await confirmMakePlaylist(1, false));
  if (!shouldBuild) {
    console.log(chalk.dim('Cancelled.'));
    return;
  }

  // No explicit duration: auto timing (video/audio play natural length).
  const item = buildUrlItem(art.assetUrl, undefined, { title: art.title });
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
      await doPlay(playlist, options.device, !!options.skipVerify);
    } else if (action === 'publish') {
      await doPublish(outputPath, options.server, !!options.yes);
    }
  }
}
