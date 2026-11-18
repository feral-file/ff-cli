/**
 * What a `find` input names, asked of ff-source-resolver-service.
 *
 * The service is the only thing that talks to Raster and the marketplaces
 * (owner decision, 2026-11-18), so this module holds no lookup code of its
 * own: it sends the input to the service and turns the answer into a target
 * the find command builds. The input is still parsed locally, by the shared
 * library's synchronous `parseFindInput`, for the three things only a local
 * parse can do: tell a wallet address from a link, recognize the off-chain
 * Neort pages the service does not cover, and keep the coordinates of a token
 * link so `find` still builds that token when the service is unavailable.
 *
 * Degrade rule (feral-file#3612, generalized from Raster to the service):
 * when the service cannot serve the run, a token link or coordinate builds a
 * one-item playlist through the token source and a wallet address lists its
 * holdings through the indexer. An input only the service can resolve (a
 * series page, a raster.art link, a collection) fails with a message saying
 * the service is not answering.
 */

import chalk from 'chalk';
import type { ParsedFindInput, TokenCoords } from '@feralfile/source-resolver';
import { isSourceResolverUnavailable } from '../../utilities/source-resolver-client';
import {
  lookupPageTokens,
  lookupRasterArtists,
  lookupRasterArtistWorks,
  lookupSeriesPage,
  lookupWork,
  type RasterArtworkRecord,
  type WorkResult,
} from '../../utilities/source-resolver-lookups';
import { createPrompt } from './prompt';

/** A target that builds without a series listing. */
export type DirectTarget =
  | {
      kind: 'single';
      coords: TokenCoords;
      /**
       * true when the service was unavailable, which `find` has already
       * said; the token's series is then unknown rather than absent.
       */
      degraded: boolean;
      /**
       * The service's `diag` notes: a source that did not answer (Raster
       * refusing the service, an objkt timeout). Non-empty means the series
       * may exist and could not be read, so `find` shows them instead of
       * claiming there is no series.
       */
      notes: string[];
    }
  | { kind: 'wallet'; address: string }
  | { kind: 'token-list'; title: string; coords: TokenCoords[] };

/**
 * What resolves out of a `find` input.
 *
 * `series` — a series of distinct works the service can list (`/series`).
 * `single` — one token: its series is unknown, or the service is unavailable.
 * `token-list` — the coordinates the service read off a collection-like page.
 * `wallet` — no Raster artist claims the address, or the service is
 *   unavailable; list its holdings.
 */
export type ResolvedTarget =
  | {
      kind: 'series';
      /** A Raster artwork slug, or `ff:` and a Feral File series slug. */
      slug: string;
      title: string;
      artist: string;
      /**
       * fallback is what the input itself can still build when the service
       * turns unavailable after naming the series (a later page refused, say):
       * the pasted token, or the wallet behind an artist's address. A series
       * link has none, since only the service knows which works it holds.
       */
      fallback?: DirectTarget;
    }
  | DirectTarget;

/** SeriesTokens is a series enumerated up to a limit. */
export interface SeriesTokens {
  tokens: TokenCoords[];
  /** The series continues past what was collected. */
  hasMore: boolean;
}

/**
 * FIND_NON_INTERACTIVE_HINT is what `find` tells a caller without a terminal
 * when one of its questions comes up. `-y` answers every question with its
 * default, and that default is to display, so the hint names `--no-display` in
 * the same breath for a caller that only wants the file.
 */
export const FIND_NON_INTERACTIVE_HINT =
  'Re-run with -y to accept the defaults (it builds the playlist and displays it on your FF1); add --no-display to only save it.';

/**
 * resolveFindTarget turns a parsed input into a target, or null when the
 * service knows no token behind it (the caller explains and exits).
 *
 * Every link and coordinate goes to `/work` first. A card naming a buildable
 * token or a series is the target; a card without one (a collection, a show,
 * a project page) is asked of `/tokens` for the page's coordinates.
 *
 * @param input - The caller's input, as typed
 * @param parsed - parseFindInput's reading of it (never `neort-art`)
 * @param skipPrompt - true when --yes picks an artist's first work unprompted
 * @returns The target, or null when nothing behind the input can be built
 */
export async function resolveFindTarget(
  input: string,
  parsed: ParsedFindInput,
  skipPrompt: boolean
): Promise<ResolvedTarget | null> {
  if (parsed.kind === 'address') {
    return resolveAddress(parsed.address, skipPrompt);
  }
  const local = parsed.kind === 'token' ? parsed.coords : null;
  let work: WorkResult;
  try {
    work = await lookupWork(input);
  } catch (error) {
    if (!isSourceResolverUnavailable(error)) {
      throw error;
    }
    return degradeOrFail(error as Error, local);
  }
  return (
    targetFromWork(work) ??
    (local ? single(local, work.diag) : resolvePageTokens(input, parsed.kind))
  );
}

/**
 * REPRESENTATIVE_TOKEN_PAGES are the page kinds that name a work through one
 * representative token: a project page by its slug resolves to its first
 * output, and `find` builds that token's series as it does for a pasted
 * token. Every other page (a collection, a Feral File show) means its exact
 * list, even when that list holds a single token.
 */
const REPRESENTATIVE_TOKEN_PAGES: ReadonlySet<ParsedFindInput['kind']> = new Set([
  'fxhash-iteration',
  'fxhash-project',
  'os-collection',
  'ab-collection',
]);

/**
 * lookupWorkOrDegrade asks `/work` about coordinates the caller already
 * holds, building them alone when the service is unavailable.
 *
 * @param coords - Coordinates to look up
 * @returns The token's series, or the token itself
 */
async function lookupWorkOrDegrade(coords: TokenCoords): Promise<ResolvedTarget> {
  let work: WorkResult;
  try {
    work = await lookupWork(`${coords.chain}:${coords.contract}:${coords.tokenId}`);
  } catch (error) {
    if (!isSourceResolverUnavailable(error)) {
      throw error;
    }
    return degradeOrFail(error as Error, coords);
  }
  return targetFromWork(work) ?? single(coords, work.diag);
}

/**
 * degradeOrFail is the unavailable-service branch: build the token in hand,
 * or say that only the service can read this input.
 *
 * @param error - The SourceResolverUnavailableError
 * @param local - The coordinates the input itself carries, if any
 * @returns A one-item target for a token input
 * @throws Error naming the service for any other input
 */
function degradeOrFail(error: Error, local: TokenCoords | null): ResolvedTarget {
  if (local === null) {
    throw new Error(
      `This link can only be resolved by the Feral File source resolver, which is not answering: ${error.message}`
    );
  }
  console.log(chalk.yellow(`  ${error.message}`));
  console.log(
    chalk.dim('  Continuing without the source resolver — building a one-item playlist.')
  );
  return { kind: 'single', coords: local, degraded: true, notes: [] };
}

/**
 * targetFromWork reads a `/work` card.
 *
 * A token that belongs to a series of distinct works builds the whole series
 * (as `find` on a token always has), with the token itself as the fallback.
 * A link that named the whole series (`show: 'all'`) has no token to fall
 * back on. Editions of one work are not a series here: the service sets
 * `seriesSlug` only for distinct outputs, so an edition builds one item.
 *
 * @param result - The `/work` answer
 * @returns The target, or null when the card names neither a token nor a series
 */
export function targetFromWork(result: WorkResult): ResolvedTarget | null {
  const { work } = result;
  const coords = buildableCoords(work.chain, work.contract, work.tokenId);
  if (work.seriesSlug && (coords || work.show === 'all')) {
    return {
      kind: 'series',
      slug: work.seriesSlug,
      title: work.series || work.title,
      artist: work.artist,
      fallback: coords ? { kind: 'single', coords, degraded: true, notes: [] } : undefined,
    };
  }
  return coords ? single(coords, result.diag) : null;
}

/**
 * buildableCoords returns coordinates the token source can build, or null.
 *
 * @param chain - The service's chain name
 * @param contract - Contract address
 * @param tokenId - Token id; '' for none
 * @returns Ethereum or Tezos coordinates with a contract and a token id
 */
function buildableCoords(chain: string, contract: string, tokenId: string): TokenCoords | null {
  if ((chain !== 'ethereum' && chain !== 'tezos') || !contract || !tokenId) {
    return null;
  }
  return { chain, contract, tokenId };
}

/** single builds a one-token target the service answered for, with its notes. */
function single(coords: TokenCoords, notes: string[]): DirectTarget {
  return { kind: 'single', coords, degraded: false, notes };
}

/**
 * resolvePageTokens asks `/tokens` which tokens a page shows.
 *
 * On a page that names a work through a representative token
 * (REPRESENTATIVE_TOKEN_PAGES), the first token goes back through `/work` as
 * a coordinate, so it builds that token's series the way a pasted token
 * does. Any other page builds exactly the tokens it lists.
 *
 * @param input - The page URL
 * @param kind - parseFindInput's kind for the page
 * @returns The target, or null when the page holds no buildable token
 */
async function resolvePageTokens(
  input: string,
  kind: ParsedFindInput['kind']
): Promise<ResolvedTarget | null> {
  let page: Awaited<ReturnType<typeof lookupPageTokens>>;
  try {
    page = await lookupPageTokens(input);
  } catch (error) {
    if (isSourceResolverUnavailable(error)) {
      throw error;
    }
    return null;
  }
  if (page.coords.length === 0) {
    return null;
  }
  if (REPRESENTATIVE_TOKEN_PAGES.has(kind)) {
    return lookupWorkOrDegrade(page.coords[0]);
  }
  return { kind: 'token-list', title: page.title || 'Resolved source', coords: page.coords };
}

/**
 * resolveAddress turns a wallet address into a target: one work by the artist
 * Raster says owns the address, or the wallet's holdings when no artist claims
 * it.
 *
 * The service being unavailable falls back to the holdings listing, which the
 * token source answers without the service by default. An artist's address
 * then yields what the wallet holds rather than the artist's works: a
 * narrower answer, but a playlist to display instead of an exit 1.
 *
 * @param address - Ethereum or Tezos address from the input
 * @param skipPrompt - true when --yes picks the first artwork unprompted
 * @returns The artist's chosen series, or the wallet target
 */
async function resolveAddress(address: string, skipPrompt: boolean): Promise<ResolvedTarget> {
  const wallet: DirectTarget = { kind: 'wallet', address };
  let artistName = '';
  let catalog: RasterArtworkRecord[];
  try {
    const [artist] = await lookupRasterArtists(address);
    if (!artist) {
      return wallet;
    }
    artistName = artist.name ?? '';
    catalog = (await lookupRasterArtistWorks(artist.id)).filter((work) => !!work.slug);
  } catch (error) {
    if (!isSourceResolverUnavailable(error)) {
      throw error;
    }
    console.log(chalk.yellow(`  ${(error as Error).message}`));
    console.log(
      chalk.dim("  Continuing without the source resolver — listing the wallet's holdings.")
    );
    return wallet;
  }
  if (catalog.length === 0) {
    throw new Error('Artist has no artworks indexed on Raster.');
  }
  console.log(
    chalk.dim(
      'find on an address displays one work by the artist at that address. ' +
        'For what the wallet owns, use build with a query_address requirement (ff-cli build --help).'
    )
  );
  const picked = await pickFromCatalog(catalog, skipPrompt);
  return {
    kind: 'series',
    slug: picked.slug as string,
    title: picked.title,
    artist: artistName,
    fallback: wallet,
  };
}

/**
 * pickFromCatalog asks which of an artist's works to build.
 *
 * @param catalog - The artist's works, each with a slug
 * @param skipPrompt - true to take the first without asking
 * @returns The chosen work
 * @throws Error on an answer that names no work
 */
async function pickFromCatalog(
  catalog: RasterArtworkRecord[],
  skipPrompt: boolean
): Promise<RasterArtworkRecord> {
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

/**
 * fetchSeriesTokens enumerates a series, or returns null when the service
 * turned unavailable mid-enumeration and the target carries a fallback to
 * build instead. The service can answer the first lookup and fail a later
 * page (Raster rate-limiting it, say), and that must degrade the same way an
 * unavailable first lookup does (feral-file#3612). Without a fallback the
 * error stands.
 *
 * @param target - The series target, with its optional fallback
 * @param limit - Effective token cap for the playlist
 * @returns The enumerated tokens, or null to build the fallback
 */
export async function fetchSeriesTokens(
  target: Extract<ResolvedTarget, { kind: 'series' }>,
  limit: number
): Promise<SeriesTokens | null> {
  try {
    return await walkSeries(target.slug, limit);
  } catch (error) {
    if (!isSourceResolverUnavailable(error) || !target.fallback) {
      throw error;
    }
    console.log(chalk.yellow(`  ${(error as Error).message}`));
    console.log(
      chalk.dim('  Continuing without the source resolver — building from the input alone.')
    );
    return null;
  }
}

/**
 * walkSeries pages through `/series` until `limit` buildable tokens are
 * collected or the series ends.
 *
 * Outputs not on Ethereum or Tezos (a Feral File work that is not on chain,
 * say) cannot go through the token source; they are skipped and counted with
 * the ones the service already dropped, and reported in one line.
 *
 * @param slug - The series slug from `/work` or the artist catalog
 * @param limit - Effective token cap for the playlist
 * @returns The tokens and whether the series continues past them
 * @throws Error when the service knows no such series
 */
async function walkSeries(slug: string, limit: number): Promise<SeriesTokens> {
  const tokens: TokenCoords[] = [];
  let skipped = 0;
  let hasMore = false;
  let after = '';
  for (;;) {
    const page = await lookupSeriesPage(slug, after || undefined);
    if (page === null) {
      throw new Error(`The source resolver has no series "${slug}".`);
    }
    skipped += page.skipped;
    for (const output of page.outputs) {
      const coords = buildableCoords(output.chain, output.contract, output.tokenId);
      if (!coords) {
        skipped += 1;
      } else if (tokens.length >= limit) {
        hasMore = true;
      } else {
        tokens.push(coords);
      }
    }
    if (hasMore || !page.next || tokens.length >= limit) {
      hasMore = hasMore || (!!page.next && tokens.length >= limit);
      break;
    }
    after = page.next;
  }
  reportSkipped(skipped);
  return { tokens, hasMore };
}

/** reportSkipped prints one line for the outputs ff-cli cannot build. */
function reportSkipped(skipped: number): void {
  if (skipped > 0) {
    console.log(
      chalk.yellow(
        `  Skipped ${skipped} token${skipped === 1 ? '' : 's'} on unsupported chains (ff-cli builds Ethereum and Tezos mainnet only).`
      )
    );
  }
}
