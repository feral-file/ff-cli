/**
 * OpenSea marketplace resolver.
 *
 * OpenSea collection URLs (`opensea.io/collection/{slug}`) point to a series,
 * not a token. OpenSea's REST API requires an API key, so this resolver reads
 * the public collection page instead: the server-rendered HTML embeds the
 * first page of collection items as relay-style JSON where each item carries
 * `"chain":{"identifier":...},"contractAddress":"0x...","tokenId":"..."`
 * adjacently. One extracted (contract, tokenId) pair is enough — the standard
 * Raster reverse-lookup then enumerates the rest of the series like any other
 * marketplace.
 *
 * Extraction invariants (what must not change):
 * - Match only the adjacent `contractAddress` + `tokenId` pattern. The page
 *   also embeds payment-token contracts (WETH etc.) in other JSON shapes that
 *   never carry an adjacent tokenId, so adjacency is the noise filter.
 * - The most frequent contract among matches wins (collection items dominate
 *   any stray adjacency), and its lowest tokenId is the deterministic seed.
 * - tokenIds are compared as BigInt: ERC-721 ids can exceed Number range.
 *
 * Trade-off: scraping page HTML is less stable than a documented API, but the
 * alternative (requiring every user to provision an OpenSea API key) defeats
 * the paste-a-URL UX. Errors below name the fallback (`/item/` token URL) so
 * a layout change degrades to a one-step workaround, not a dead end.
 */

import * as logger from '../logger';
import type { TokenCoords } from '@feralfile/source-resolver';
import { USER_AGENT } from './user-agent';

/**
 * One embedded collection item: chain identifier, contract, tokenId. The
 * `[^{}]*` keeps the chain object match from swallowing unrelated JSON when
 * OpenSea reorders fields inside `chain`.
 */
const ITEM_PATTERN =
  /"chain":\{"identifier":"([a-z0-9_-]+)"[^{}]*\},"contractAddress":"(0x[a-fA-F0-9]{40})","tokenId":"(\d+)"/g;

const FALLBACK_HINT =
  'Paste a specific token URL (opensea.io/item/ethereum/{contract}/{tokenId}) ' +
  'or use `ethereum:{contract}:{tokenId}`.';

/**
 * Resolve an OpenSea collection slug to its contract address + the lowest
 * tokenId visible on the collection page (a representative seed for the
 * Raster series lookup).
 *
 * @throws When the page cannot be fetched, embeds no recognizable items
 *   (layout change or empty collection), or the collection is not on
 *   Ethereum mainnet (outside FF indexer coverage).
 */
export async function resolveOpenSeaCollection(slug: string): Promise<TokenCoords> {
  logger.debug(`[OpenSea] Resolving collection slug "${slug}"`);
  const response = await fetch(`https://opensea.io/collection/${encodeURIComponent(slug)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  if (!response.ok) {
    throw new Error(
      `OpenSea collection page returned ${response.status} ${response.statusText}. ` + FALLBACK_HINT
    );
  }
  const html = await response.text();

  // Tally (contract → tokenIds) per chain so the dominant-contract rule and
  // the ethereum-only guard can both give precise errors.
  const byContract = new Map<string, { chain: string; tokenIds: bigint[] }>();
  for (const match of html.matchAll(ITEM_PATTERN)) {
    const [, chain, contract, tokenId] = match;
    const key = contract.toLowerCase();
    const entry = byContract.get(key) ?? { chain, tokenIds: [] };
    entry.tokenIds.push(BigInt(tokenId));
    byContract.set(key, entry);
  }

  if (byContract.size === 0) {
    throw new Error(
      `OpenSea: no items found on the collection page for "${slug}". ` +
        'The collection may be empty, or the page layout changed. ' +
        FALLBACK_HINT
    );
  }

  let best: { contract: string; chain: string; tokenIds: bigint[] } | null = null;
  for (const [contract, entry] of byContract) {
    if (!best || entry.tokenIds.length > best.tokenIds.length) {
      best = { contract, ...entry };
    }
  }
  // byContract.size > 0 guarantees best is set; the check keeps TS honest.
  if (!best) {
    throw new Error(`OpenSea: no items found for "${slug}". ${FALLBACK_HINT}`);
  }

  if (best.chain !== 'ethereum') {
    throw new Error(
      `OpenSea collection "${slug}" is on ${best.chain} — ff-cli covers Ethereum and ` +
        'Tezos mainnet only. Paste an Ethereum-chain source instead.'
    );
  }

  const seed = best.tokenIds.reduce((min, id) => (id < min ? id : min));
  logger.debug(
    `[OpenSea] Resolved "${slug}" → ${best.contract} (seed tokenId ${seed}, ` +
      `${best.tokenIds.length} items sampled)`
  );
  return { chain: 'ethereum', contract: best.contract, tokenId: seed.toString() };
}
