/**
 * Raster API client (api.raster.art — public GraphQL API).
 *
 * Resolves on-chain coordinates and artist addresses into Raster artworks
 * (series) and artists (catalog) for `ff-cli find`, and fetches the full token
 * rows the Raster token source (token-source-raster.ts) turns into DP-1 items.
 *
 * This module is pure data: it does not construct DP-1 items, send anything
 * to devices, or build playlists. Mapping a RasterToken to the vendor-neutral
 * token shape happens in token-source-raster.ts.
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

const DEFAULT_RASTER_GRAPHQL_URL = 'https://api.raster.art/graphql';

/**
 * Hard ceiling on a single Raster round trip. Without it, a stalled TCP
 * connect or unanswered request leaves `find` hanging with no output (#97) —
 * the failure mode agents can least diagnose. 20 s is generous for a
 * transcontinental GraphQL query and still turns "silent hang" into a fast,
 * actionable error.
 */
const RASTER_REQUEST_TIMEOUT_MS = 20_000;

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

/**
 * Raster could not be reached at the network level (connect failure, broken
 * IPv6 path, timeout). Distinct from API-level errors so callers that hold
 * usable token coordinates can degrade gracefully instead of dying — Raster
 * only enriches a find, it is not required to build a playable playlist.
 */
export class RasterUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RasterUnreachableError';
  }
}

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
  chain: IndexerChain;
  contractAddress: string;
  tokenId: string;
  /** The full Raster row, so a series build needs no second round trip. */
  token: RasterToken;
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
export async function rasterQuery<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const endpoint = process.env.RASTER_API_URL ?? DEFAULT_RASTER_GRAPHQL_URL;
  logger.debug(`[Raster] POST ${endpoint} ${JSON.stringify(variables)}`);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  const apiKey = process.env.RASTER_API_KEY;
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(RASTER_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Undici's "fetch failed" carries no endpoint and no cause in its
    // message — name the host and the real failure so the error is
    // actionable, and let callers detect network failure by type.
    const cause = (error as { cause?: { message?: string } }).cause;
    const detail = cause?.message ?? (error as Error).message;
    throw new RasterUnreachableError(`Raster API unreachable (${endpoint}): ${detail}`);
  }
  if (!response.ok) {
    // Body text is best-effort context; the HTTP status alone is the error.
    // A body read that rejects here must not mask the status — and an HTTP
    // error is an API-level failure, deliberately NOT RasterUnreachableError.
    const body = await response.text().catch(() => '');
    throw new Error(`Raster API ${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
  }
  // The network-error boundary extends through body consumption: a response
  // whose stream stalls past the headers or terminates mid-body rejects
  // HERE, not in fetch() above. Those must still surface as
  // RasterUnreachableError or resolveCoords cannot perform its promised
  // single-token fallback. (A 200 whose body cannot be read or parsed is
  // unusable either way — falling back is right even for server-side
  // garbage.)
  let payload: { data?: T; errors?: Array<{ message: string }> };
  try {
    payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    const detail = cause?.message ?? (error as Error).message;
    throw new RasterUnreachableError(
      `Raster API unreachable (${endpoint}): response body failed: ${detail}`
    );
  }
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`Raster API error: ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  if (payload.data === undefined) {
    throw new Error('Raster API returned no data.');
  }
  return payload.data;
}

export interface ArtistFields {
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
 * Resolve a `raster.art/artwork/{slug}` URL to its artwork (series) summary.
 *
 * One round trip via `artworkBySlug`. Returns `null` when the slug is
 * unknown (Raster models not-found as a null query field, not an HTTP 404).
 */
export async function resolveSlugToArtwork(slug: string): Promise<RasterArtworkSummary | null> {
  const data = await rasterQuery<{
    artworkBySlug: {
      id: string;
      title: string;
      artists: ArtistFields[];
    } | null;
  }>(
    `query ResolveSlug($slug: String!) {
      artworkBySlug(slug: $slug) {
        id
        title
        artists { id name slug }
      }
    }`,
    { slug }
  );

  const artwork = data.artworkBySlug;
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

/** RasterMedia is Raster's media block. `contentType` and `previewType` are not MIME types. */
export interface RasterMedia {
  previewHash: string | null;
  previewType: string | null;
  contentUrl: string | null;
  normalizedContentUrl: string | null;
  contentType: string | null;
}

/** RasterArtworkRef is the artwork (series) a token belongs to, as embedded on a token. */
export interface RasterArtworkRef {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  platform: { id: string; name: string } | null;
  artists: ArtistFields[];
}

/**
 * RasterToken is one token row selected through TOKEN_FIELDS.
 *
 * Raster lowercases EVM contract addresses and keeps Tezos addresses as
 * written (verified 2026-10-21). `name` is empty for Art Blocks tokens, a
 * known Raster bug the token source works around.
 */
export interface RasterToken {
  chainId: string;
  contractAddress: string | null;
  tokenId: string;
  tokenStandard: string | null;
  name: string | null;
  description: string | null;
  media: RasterMedia | null;
  artworks: RasterArtworkRef[];
  artists: ArtistFields[];
}

/**
 * TOKEN_FIELDS is the one selection every token-reading query shares, so the
 * three entry points (by reference, by owner, by artwork) feed the same mapper.
 */
export const TOKEN_FIELDS = `fragment TokenFields on Token {
  chainId contractAddress tokenId tokenStandard name description
  media { previewHash previewType contentUrl normalizedContentUrl contentType }
  artworks { id slug title description platform { id name } artists { id name slug } }
  artists { id name slug }
}`;

/**
 * RASTER_TOKEN_BATCH_SIZE caps aliased `tokenByRef` lookups per request.
 * 40 is the size probed on feral-file#3546 (one request, 2.9 s); larger
 * batches are unmeasured, so raise it only with a new measurement.
 */
export const RASTER_TOKEN_BATCH_SIZE = 40;

/** RasterTokenRef is a coordinate to look up, in the client chain vocabulary. */
export interface RasterTokenRef {
  chain: IndexerChain;
  contractAddress: string;
  tokenId: string;
}

/**
 * buildTokenByRefBatchQuery builds one query with `count` aliased lookups.
 *
 * Refs travel as numbered variables (`$r0`…), never interpolated into the
 * text, so token ids above 2^53 (every Feral File id) arrive as strings and
 * no caller-supplied value can alter the document.
 */
export function buildTokenByRefBatchQuery(count: number): string {
  const indices = Array.from({ length: count }, (_, i) => i);
  const params = indices.map((i) => `$r${i}: TokenRefInput!`).join(', ');
  const fields = indices.map((i) => `  t${i}: tokenByRef(ref: $r${i}) { ...TokenFields }`);
  return `query TokensByRef(${params}) {\n${fields.join('\n')}\n}\n${TOKEN_FIELDS}`;
}

/**
 * fetchTokensByRef looks up one batch of coordinates in a single request.
 *
 * The result is aligned with the input; a token Raster does not cover, or one
 * that was burned, is `null` (Raster answers null rather than an error).
 * Batching across requests, progress, and per-batch failure handling belong to
 * the caller, which is why more than RASTER_TOKEN_BATCH_SIZE refs is refused
 * instead of split here.
 *
 * @throws RasterUnreachableError on network failure; Error on API failure
 */
export async function fetchTokensByRef(refs: RasterTokenRef[]): Promise<(RasterToken | null)[]> {
  if (refs.length > RASTER_TOKEN_BATCH_SIZE) {
    throw new Error(`fetchTokensByRef takes at most ${RASTER_TOKEN_BATCH_SIZE} refs per call.`);
  }
  if (refs.length === 0) {
    return [];
  }
  const variables: Record<string, unknown> = {};
  refs.forEach((ref, i) => {
    variables[`r${i}`] = {
      chainId: INDEXER_CHAIN_TO_CAIP[ref.chain],
      contractAddress: ref.contractAddress,
      tokenId: ref.tokenId,
    };
  });
  const data = await rasterQuery<Record<string, RasterToken | null>>(
    buildTokenByRefBatchQuery(refs.length),
    variables
  );
  return refs.map((_, i) => data[`t${i}`] ?? null);
}

/** OwnedTokensPage is one page of an address's holdings. */
export interface OwnedTokensPage {
  tokens: RasterToken[];
  nextCursor: string | null;
  totalCount: number;
}

/**
 * fetchTokensOwned reads one page of `address.tokensOwned`, the wallet walk.
 *
 * Raster resolves any well-formed address and returns an empty connection when
 * it knows no holdings, so an empty page is an answer, not an error. Chain
 * filtering is left to the caller, which owns the skipped-chain report.
 */
export async function fetchTokensOwned(
  address: string,
  options: { first: number; after?: string }
): Promise<OwnedTokensPage> {
  const data = await rasterQuery<{
    address: {
      tokensOwned: {
        totalCount: number;
        nodes: Array<{ token: RasterToken }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  }>(
    `query TokensOwned($address: String!, $first: Int, $after: String) {
      address(address: $address) {
        tokensOwned(first: $first, after: $after) {
          totalCount
          nodes { token { ...TokenFields } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    ${TOKEN_FIELDS}`,
    { address: address.trim(), first: options.first, after: options.after ?? null }
  );
  const owned = data.address?.tokensOwned;
  if (!owned) {
    return { tokens: [], nextCursor: null, totalCount: 0 };
  }
  const { hasNextPage, endCursor } = owned.pageInfo;
  return {
    tokens: owned.nodes.map((node) => node.token),
    nextCursor: hasNextPage && endCursor ? endCursor : null,
    totalCount: owned.totalCount,
  };
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
        nodes: RasterToken[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  }>(
    `query ArtworkTokens($id: ID!, $first: Int, $after: String) {
      artwork(id: $id) {
        tokens(first: $first, after: $after) {
          nodes { ...TokenFields }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    ${TOKEN_FIELDS}`,
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
      chain,
      contractAddress: raw.contractAddress,
      tokenId: raw.tokenId,
      token: raw,
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
