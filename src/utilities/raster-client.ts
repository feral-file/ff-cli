/**
 * Raster API client (kit.raster.art)
 *
 * Resolves on-chain coordinates and artist addresses into Raster `artwork_id`
 * (series) and `artist_id` (catalog) — the inputs the `ff-cli find` flow needs
 * before handing tokens to the FF GraphQL indexer for DP-1 conversion.
 *
 * This module is pure data: it does not construct DP-1 items, send anything
 * to devices, or build playlists. The fulfiller layer (FF indexer) consumes
 * the `{ chain, contractAddress, tokenId }` shapes this module emits.
 *
 * Chain filter: the FF indexer only supports Ethereum mainnet and Tezos
 * mainnet. Token lists are filtered here at the CAIP level and a
 * `skippedUnsupported` count is surfaced so callers can warn-skip without
 * walking every row themselves.
 */

import * as logger from '../logger';

const RASTER_BASE_URL = 'https://kit.raster.art';

// CAIP-2 chain IDs for the chains the FF indexer supports.
// Tezos mainnet's CAIP form uses the genesis block hash (NetXdQprcVkpaWU),
// not the human-readable "tezos:mainnet" — Raster returns the hash form on
// token rows and rejects "tezos:mainnet" with HTTP 400.
const CAIP_TO_INDEXER_CHAIN: Record<string, 'ethereum' | 'tezos'> = {
  'eip155:1': 'ethereum',
  'tezos:NetXdQprcVkpaWU': 'tezos',
};

export type IndexerChain = 'ethereum' | 'tezos';

export interface RasterArtist {
  id: number;
  name: string;
  slug: string | null;
}

export interface RasterArtworkSummary {
  artworkId: number;
  title: string;
  artists: RasterArtist[];
  tokenCount: number;
  editionSize: number;
  isEdition: boolean;
  hasOneOfOneTokens: boolean;
  platforms: Array<{ id: string; label: string }>;
  contractAddresses: string[];
}

export interface RasterArtworkRow {
  artworkId: number;
  title: string;
  tokenCount: number;
  isEdition: boolean;
  mintDate: string | null;
}

export interface RasterTokenCoords {
  caipChain: string;
  chain: IndexerChain;
  contractAddress: string;
  tokenId: string;
}

export interface PaginatedTokens {
  tokens: RasterTokenCoords[];
  totalCount: number;
  nextCursor: number | null;
  skippedUnsupported: number;
}

function stripContractChainPrefix(raw: string): string {
  const slash = raw.indexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

function caipToIndexerChain(caip: string): IndexerChain | null {
  return CAIP_TO_INDEXER_CHAIN[caip] ?? null;
}

/**
 * Thrown when Raster returns 404 for a requested path. Used as a soft signal
 * by callers that have a fallback path (e.g. `find` falls back to a
 * single-token playlist when Raster doesn't index the artwork).
 */
export class RasterNotFoundError extends Error {
  readonly notFound = true as const;
  constructor(path: string) {
    super(`Raster: not found (${path})`);
    this.name = 'RasterNotFoundError';
  }
}

async function rasterFetch<T>(path: string): Promise<T> {
  const url = `${RASTER_BASE_URL}${path}`;
  logger.debug(`[Raster] GET ${url}`);
  const response = await fetch(url);
  if (response.status === 404) {
    throw new RasterNotFoundError(path);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Raster API ${response.status} ${response.statusText} for ${path}: ${body.slice(0, 200)}`
    );
  }
  return (await response.json()) as T;
}

interface TokenLookupResponse {
  id: number;
  contract_address: string;
  token_id: string;
  title: string;
  artwork: {
    id: number;
    title: string;
    artists: RasterArtist[];
    is_edition: boolean;
    edition_size: number;
  };
}

interface ArtworkResponse {
  id: number;
  title: string;
  artists: RasterArtist[];
  token_count: number;
  edition_size: number;
  is_edition: boolean;
  has_one_of_one_tokens: boolean;
  contract_addresses: string[];
  platforms: Array<{ id: string; label: string }>;
}

interface ArtworkTokensResponse {
  tokens: Array<{
    chain_id: string;
    contract_address: string;
    token_id: string;
  }>;
  total_count: number;
  cursor: number | null;
}

interface ArtistArtworksResponse {
  artworks: Array<{
    id: number;
    title: string;
    num_tokens: number;
    num_pieces: number;
    is_edition: boolean;
    mint_date: string | null;
  }>;
}

interface SearchResponse {
  results: Array<{
    hits: Array<{
      document: {
        id: string;
        data_pk: string;
        data_type: 'artist' | 'artwork';
        title: string;
        addresses?: string[];
        aliases?: string[];
      };
    }>;
  }>;
}

/**
 * Resolve a token's on-chain coordinates to its Raster artwork (series) id.
 *
 * Accepts either a CAIP chain id (`eip155:1`) or human slug (`ethereum`) —
 * Raster handles both. Returns `null` when Raster doesn't index this token
 * (HTTP 404); callers can fall back to a single-token playlist in that case.
 * Other Raster errors throw normally.
 */
export async function resolveTokenToArtwork(
  chain: string,
  contract: string,
  tokenId: string
): Promise<{ artworkId: number; artworkTitle: string } | null> {
  const path =
    `/token/${encodeURIComponent(chain)}` +
    `/${encodeURIComponent(contract)}` +
    `/${encodeURIComponent(tokenId)}`;
  try {
    const data = await rasterFetch<TokenLookupResponse>(path);
    return {
      artworkId: data.artwork.id,
      artworkTitle: data.artwork.title,
    };
  } catch (error) {
    if (error instanceof RasterNotFoundError) {
      return null;
    }
    throw error;
  }
}

/**
 * Get the full Raster artwork summary suitable for the one-line resolve
 * message ("Snowfro — send/receive — 8977 tokens") and downstream UX.
 */
export async function getArtworkSummary(artworkId: number): Promise<RasterArtworkSummary> {
  const data = await rasterFetch<ArtworkResponse>(`/artwork/${artworkId}`);
  return {
    artworkId: data.id,
    title: data.title,
    artists: data.artists ?? [],
    tokenCount: data.token_count,
    editionSize: data.edition_size,
    isEdition: data.is_edition,
    hasOneOfOneTokens: data.has_one_of_one_tokens,
    platforms: data.platforms ?? [],
    contractAddresses: data.contract_addresses ?? [],
  };
}

/**
 * Resolve an artist's wallet address to a Raster artist id via `/search`.
 *
 * `/artist/{id}` does not accept raw addresses (404), so we bridge through
 * the multi-search endpoint and pick the artist hit whose `addresses` list
 * contains the input. Returns `null` when no artist matches.
 */
export async function resolveAddressToArtist(address: string): Promise<number | null> {
  const normalized = address.trim().toLowerCase();
  const data = await rasterFetch<SearchResponse>(`/search?query=${encodeURIComponent(address)}`);

  for (const result of data.results ?? []) {
    for (const hit of result.hits ?? []) {
      const doc = hit.document;
      if (doc.data_type !== 'artist') {
        continue;
      }
      const addrs = (doc.addresses ?? []).map((a) => a.toLowerCase());
      if (!addrs.includes(normalized)) {
        continue;
      }
      const parsed = Number.parseInt(doc.data_pk, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * List tokens in a Raster artwork (series), one page at a time.
 *
 * Filters out tokens whose chain is not supported by the FF indexer
 * (anything other than `eip155:1` or `tezos:NetXdQprcVkpaWU`) and reports
 * the count via `skippedUnsupported` so the caller can print a single
 * warn-skip line instead of one per token.
 *
 * Pagination: pass the returned `nextCursor` back as `options.cursor`.
 * `nextCursor` is `null` on the final page. Raster signals end-of-stream by
 * returning `cursor === total_count`; that is normalized to `null` here.
 */
export async function listArtworkTokens(
  artworkId: number,
  options: { cursor?: number; pageSize?: number } = {}
): Promise<PaginatedTokens> {
  const params = new URLSearchParams();
  if (options.cursor !== undefined) {
    params.set('cursor', String(options.cursor));
  }
  if (options.pageSize !== undefined) {
    params.set('page_size', String(options.pageSize));
  }
  const qs = params.toString();
  const path = `/artwork/${artworkId}/tokens${qs ? `?${qs}` : ''}`;

  const data = await rasterFetch<ArtworkTokensResponse>(path);

  const tokens: RasterTokenCoords[] = [];
  let skippedUnsupported = 0;
  for (const raw of data.tokens ?? []) {
    const chain = caipToIndexerChain(raw.chain_id);
    if (!chain) {
      skippedUnsupported += 1;
      continue;
    }
    tokens.push({
      caipChain: raw.chain_id,
      chain,
      contractAddress: stripContractChainPrefix(raw.contract_address),
      tokenId: raw.token_id,
    });
  }

  const rawCursor = data.cursor;
  const nextCursor = rawCursor === null || rawCursor >= data.total_count ? null : rawCursor;

  return {
    tokens,
    totalCount: data.total_count,
    nextCursor,
    skippedUnsupported,
  };
}

/**
 * List an artist's full catalog as light artwork rows (id, title, token count,
 * edition flag, mint date). Use {@link getArtworkSummary} when full details
 * are needed for a specific row.
 *
 * The endpoint returns the full catalog in a single response; no cursor is
 * exposed by Raster for this path.
 */
export async function listArtistArtworks(artistId: number): Promise<RasterArtworkRow[]> {
  const data = await rasterFetch<ArtistArtworksResponse>(`/artist/${artistId}/artworks`);
  return (data.artworks ?? []).map((row) => ({
    artworkId: row.id,
    title: row.title,
    tokenCount: row.num_tokens ?? row.num_pieces ?? 0,
    isEdition: row.is_edition,
    mintDate: row.mint_date ?? null,
  }));
}

/**
 * Format a one-line summary for the resolved artwork.
 *
 * @example
 *   formatSummaryLine(summary) // "Snowfro — send/receive — 8977 tokens"
 */
export function formatSummaryLine(summary: RasterArtworkSummary): string {
  const artistNames = summary.artists.map((a) => a.name).join(', ') || 'Unknown artist';
  const tokenWord = summary.tokenCount === 1 ? 'token' : 'tokens';
  return `${artistNames} — ${summary.title} — ${summary.tokenCount} ${tokenWord}`;
}
