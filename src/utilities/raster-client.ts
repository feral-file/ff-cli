/**
 * Raster API client (api.raster.art — public GraphQL API).
 *
 * Resolves on-chain coordinates and artist addresses into Raster artworks
 * (series) and artists (catalog) — the inputs the `ff-cli find` flow needs
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
 *
 * API notes (v0.1.0, https://docs.api.raster.art/):
 *  - Auth: `x-api-key` header, sent when RASTER_API_KEY is set in the
 *    environment. The endpoint currently answers without a key; the docs
 *    declare one required, so the hook is wired in ahead of enforcement.
 *  - Not-found is a `null` query field, not an HTTP 404.
 *  - Connections expose no total counts — callers learn series size by
 *    paginating, so the find flow fetches before it prompts.
 */

import * as logger from '../logger';
import { USER_AGENT } from './user-agent';

const RASTER_GRAPHQL_URL = process.env.RASTER_API_URL ?? 'https://api.raster.art/graphql';

// CAIP-2 chain IDs for the chains the FF indexer supports.
// Tezos mainnet's CAIP form uses the genesis block hash (NetXdQprcVkpaWU),
// not the human-readable "tezos:mainnet" — Raster returns the hash form on
// token rows and resolves nothing for "tezos:mainnet".
const CAIP_TO_INDEXER_CHAIN: Record<string, 'ethereum' | 'tezos'> = {
  'eip155:1': 'ethereum',
  'tezos:NetXdQprcVkpaWU': 'tezos',
};

const INDEXER_CHAIN_TO_CAIP: Record<IndexerChain, string> = {
  ethereum: 'eip155:1',
  tezos: 'tezos:NetXdQprcVkpaWU',
};

export type IndexerChain = 'ethereum' | 'tezos';

export interface RasterArtist {
  id: string;
  name: string;
  slug: string | null;
}

export interface RasterArtworkSummary {
  artworkId: string;
  title: string;
  artists: RasterArtist[];
}

export interface RasterArtworkRow {
  artworkId: string;
  title: string;
}

export interface RasterTokenCoords {
  caipChain: string;
  chain: IndexerChain;
  contractAddress: string;
  tokenId: string;
}

export interface PaginatedTokens {
  tokens: RasterTokenCoords[];
  nextCursor: string | null;
  skippedUnsupported: number;
}

function caipToIndexerChain(caip: string): IndexerChain | null {
  return CAIP_TO_INDEXER_CHAIN[caip] ?? null;
}

/**
 * POST one GraphQL operation to Raster and return `data`.
 *
 * Throws on HTTP errors and on GraphQL `errors` entries. "Not found" never
 * lands here — Raster models it as a null query field with no error, so
 * callers check their own field for null.
 */
async function rasterQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  logger.debug(`[Raster] POST ${RASTER_GRAPHQL_URL} ${JSON.stringify(variables)}`);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  const apiKey = process.env.RASTER_API_KEY;
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  const response = await fetch(RASTER_GRAPHQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Raster API ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
  }
  const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`Raster API error: ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  if (payload.data === undefined) {
    throw new Error('Raster API returned no data.');
  }
  return payload.data;
}

interface ArtistFields {
  id: string;
  name: string | null;
  slug: string | null;
}

function toRasterArtist(raw: ArtistFields): RasterArtist {
  return { id: raw.id, name: raw.name ?? 'Unknown artist', slug: raw.slug };
}

/**
 * Resolve a token's on-chain coordinates to its Raster artwork (series).
 *
 * One round trip: `tokenByRef` returns the artwork with artists inline, so
 * this yields the full summary directly. Returns `null` when Raster doesn't
 * index this token; callers fall back to a single-token playlist in that
 * case. Tokens occasionally belong to multiple artworks; the first one is
 * Raster's primary association.
 */
export async function resolveTokenToArtwork(
  chain: IndexerChain,
  contract: string,
  tokenId: string
): Promise<RasterArtworkSummary | null> {
  const data = await rasterQuery<{
    tokenByRef: {
      artworks: Array<{
        id: string;
        title: string;
        artists: ArtistFields[];
      }>;
    } | null;
  }>(
    `query ResolveToken($ref: TokenRefInput!) {
      tokenByRef(ref: $ref) {
        artworks { id title artists { id name slug } }
      }
    }`,
    {
      ref: {
        chainId: INDEXER_CHAIN_TO_CAIP[chain],
        contractAddress: contract,
        tokenId,
      },
    }
  );

  const artwork = data.tokenByRef?.artworks?.[0];
  if (!artwork) {
    return null;
  }
  return {
    artworkId: artwork.id,
    title: artwork.title,
    artists: (artwork.artists ?? []).map(toRasterArtist),
  };
}

/**
 * Resolve a wallet address to the Raster artist who claims it.
 *
 * The `address` query carries artist associations directly (the old REST
 * API needed a `/search` bridge). Returns `null` when no artist claims the
 * address. Checksummed Ethereum input is normalized server-side.
 */
export async function resolveAddressToArtist(address: string): Promise<RasterArtist | null> {
  const data = await rasterQuery<{
    address: { artists: ArtistFields[] } | null;
  }>(
    `query ResolveAddress($address: String!) {
      address(address: $address) { artists { id name slug } }
    }`,
    { address: address.trim() }
  );

  const artist = data.address?.artists?.[0];
  return artist ? toRasterArtist(artist) : null;
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
 * `nextCursor` is `null` on the final page. The API exposes no total count;
 * the only way to learn a series' size is to walk it.
 */
export async function listArtworkTokens(
  artworkId: string,
  options: { cursor?: string; pageSize?: number } = {}
): Promise<PaginatedTokens> {
  const data = await rasterQuery<{
    artwork: {
      tokens: {
        nodes: Array<{ chainId: string; contractAddress: string | null; tokenId: string }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  }>(
    `query ArtworkTokens($id: ID!, $first: Int, $after: String) {
      artwork(id: $id) {
        tokens(first: $first, after: $after) {
          nodes { chainId contractAddress tokenId }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    { id: artworkId, first: options.pageSize ?? null, after: options.cursor ?? null }
  );

  if (!data.artwork) {
    throw new Error(`Raster: artwork ${artworkId} not found.`);
  }

  const tokens: RasterTokenCoords[] = [];
  let skippedUnsupported = 0;
  for (const raw of data.artwork.tokens.nodes) {
    const chain = caipToIndexerChain(raw.chainId);
    if (!chain || !raw.contractAddress) {
      skippedUnsupported += 1;
      continue;
    }
    tokens.push({
      caipChain: raw.chainId,
      chain,
      contractAddress: raw.contractAddress,
      tokenId: raw.tokenId,
    });
  }

  const { hasNextPage, endCursor } = data.artwork.tokens.pageInfo;
  return {
    tokens,
    nextCursor: hasNextPage && endCursor ? endCursor : null,
    skippedUnsupported,
  };
}

/**
 * List an artist's full catalog as light artwork rows (id + title — the
 * API exposes no per-artwork token counts or mint dates yet).
 *
 * Walks the artist's `artworks` connection to the end so the caller sees
 * the complete catalog, matching the old single-response REST behavior.
 */
export async function listArtistArtworks(artistId: string): Promise<RasterArtworkRow[]> {
  const rows: RasterArtworkRow[] = [];
  let cursor: string | null = null;

  do {
    const data: {
      artist: {
        artworks: {
          nodes: Array<{ id: string; title: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    } = await rasterQuery(
      `query ArtistArtworks($id: ID!, $after: String) {
        artist(id: $id) {
          artworks(first: 100, after: $after) {
            nodes { id title }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: artistId, after: cursor }
    );

    if (!data.artist) {
      throw new Error(`Raster: artist ${artistId} not found.`);
    }
    for (const node of data.artist.artworks.nodes) {
      rows.push({ artworkId: node.id, title: node.title });
    }
    const { hasNextPage, endCursor } = data.artist.artworks.pageInfo;
    cursor = hasNextPage && endCursor ? endCursor : null;
  } while (cursor !== null);

  return rows;
}

/**
 * Format a one-line summary for the resolved artwork.
 *
 * @example
 *   formatSummaryLine(summary) // "Snowfro — send/receive"
 */
export function formatSummaryLine(summary: RasterArtworkSummary): string {
  const artistNames = summary.artists.map((a) => a.name).join(', ') || 'Unknown artist';
  return `${artistNames} — ${summary.title}`;
}
