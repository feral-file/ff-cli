/**
 * Raster token source: the opt-in provider under evaluation (feral-file#3576).
 *
 * Reads token rows from Raster's public GraphQL API and maps each one to the
 * vendor-neutral StandardToken, which token-item.ts turns into a DP-1 item
 * with the same code the indexer path uses. Item ids, provenance, inline
 * manifests and timing therefore come out identical in shape to the indexer's.
 *
 * What Raster cannot do, and how this provider answers instead of guessing:
 *   - no contract listing query: listTokensByContract throws a capability
 *     error rather than inventing a probe;
 *   - a token it does not cover, or a burned one, comes back null: reported
 *     as a failure, never filled from another vendor (one vendor per run);
 *   - Feral File metadata is a snapshot: bare ipfs:// and a retired CDN host
 *     are fixed up in media-url.ts;
 *   - `media.contentType` is a category, not a MIME type: rasterTimingMime
 *     turns it into a timing hint that never reaches the document.
 */

import { getAddress } from 'viem';
import * as logger from '../logger';
import {
  RASTER_TOKEN_BATCH_SIZE,
  fetchTokensByRef,
  fetchTokensOwned,
  type IndexerChain,
  type RasterMedia,
  type RasterToken,
} from './raster-client';
import { fixUpMediaUrl, type IpfsGateways } from './media-url';
import { convertToDP1Item, resolveTokenStandard, type TokenData } from './token-item';
import {
  RASTER_CANNOT_LIST_CONTRACT,
  TokenSourceCapabilityError,
  type ListOptions,
  type ResolveOptions,
  type ResolvedToken,
  type TokenCoordinate,
  type TokenListing,
  type TokenSource,
} from './token-source-contract';

/** CAIP-2 chains ff-cli builds items for. Others are skipped and counted. */
const CAIP_TO_CHAIN: Record<string, IndexerChain> = {
  'eip155:1': 'ethereum',
  'tezos:NetXdQprcVkpaWU': 'tezos',
};

/** Raster standards DP-1 can name; others become `other` (see rasterTokenStandard). */
const RASTER_STANDARDS: Record<string, string> = {
  ERC721: 'erc721',
  ERC1155: 'erc1155',
  FA2: 'fa2',
};

/** Page size for the wallet walk. 100 matches listArtistArtworks; 200 was probed fine. */
const OWNED_PAGE_SIZE = 100;

/** NOT_ON_RASTER explains a null `tokenByRef` in the user's terms. */
const NOT_ON_RASTER = 'Raster has no record of this token (not indexed, burned, or nonexistent)';

/**
 * rasterTokenStandard maps Raster's standard enum to a DP-1 standard.
 *
 * CRYPTOPUNKS and ORDINAL_INSCRIPTION have no DP-1 name, so they are `other`;
 * falling through to detection would call a punk `erc721`, which it is not.
 * A missing standard uses the caller's assertion, then detection.
 */
export function rasterTokenStandard(
  raw: string | null,
  chain: string,
  contractAddress: string,
  asserted?: string
): string {
  if (raw) {
    return RASTER_STANDARDS[raw.toUpperCase()] ?? 'other';
  }
  return resolveTokenStandard(chain, contractAddress, asserted);
}

/**
 * rasterTokenName picks the display title.
 *
 * Raster's GraphQL `Token.name` is empty for Art Blocks tokens (a known Raster
 * bug, feral-file#3546). Art Blocks token ids are project * 1,000,000 + mint,
 * so "<series> #<mint>" reproduces the title Art Blocks itself publishes,
 * e.g. "Fidenza #629".
 */
export function rasterTokenName(token: RasterToken): string {
  const name = (token.name ?? '').trim();
  if (name) {
    return name;
  }
  const artwork = token.artworks[0];
  if (artwork?.platform?.id === 'artblocks' && /^\d+$/.test(token.tokenId)) {
    return `${artwork.title} #${BigInt(token.tokenId) % 1_000_000n}`;
  }
  return artwork?.title || `Token #${token.tokenId}`;
}

/**
 * rasterTimingMime turns Raster's media category into a timing hint.
 *
 * The value only steers DP-1 §4.1 timing (video plays its length, web works
 * get the generative duration, the rest the static duration); it is never
 * written into the playlist. `previewType` describes how Raster encoded the
 * preview, not the work (a web app's preview is an image), so it is consulted
 * only when it says video. Empty means unknown, and the URL extension decides,
 * which is the indexer path's behaviour for extensionless URLs too.
 */
export function rasterTimingMime(media: RasterMedia | null): string {
  switch ((media?.contentType ?? '').toLowerCase()) {
    case 'video':
      return 'video/*';
    case 'webapp':
      return 'text/html';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'image':
      return 'image/*';
  }
  return (media?.previewType ?? '').toLowerCase().startsWith('video/') ? 'video/*' : '';
}

/**
 * RASTER_STILL is deliberately empty: Raster items carry no still image.
 *
 * Raster's preview renditions (`bits.raster.art/.../7200.avif`) load for a
 * browser user agent but answer 403 to curl and to the Feral File app's
 * default `dart:io` client (verified 2026-10-21), and AVIF decoding outside
 * browsers is not guaranteed. A still lands in `thumbnails.default` of a
 * manifest the curator signs, so a URL that is dead for some readers is worse
 * than none. Set a real rendition here only once Raster confirms access that
 * does not depend on the user agent, and record that evidence here.
 */
const RASTER_STILL = '';

/**
 * canonicalContract returns the address as the indexer recorded it.
 *
 * Raster lowercases EVM addresses; the indexer returned them checksummed, and
 * the DP-1 item id is sha256 of the address. Checksumming keeps ids and
 * provenance identical across vendors. Tezos addresses are case-sensitive
 * Base58 and Raster keeps them as written.
 */
function canonicalContract(chain: IndexerChain, address: string): string {
  if (chain !== 'ethereum') {
    return address;
  }
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

/**
 * rasterTokenToStandardToken maps one Raster row to the vendor-neutral token.
 *
 * @param token - Raster row selected through TOKEN_FIELDS
 * @param gateways - IPFS gateways for bare ipfs:// sources
 * @param requested - The coordinate asked for, when there was one
 * @returns TokenData ready for convertToDP1Item
 */
export function rasterTokenToStandardToken(
  token: RasterToken,
  gateways: IpfsGateways,
  requested?: TokenCoordinate
): TokenData {
  const chain = CAIP_TO_CHAIN[token.chainId];
  const rawAddress = token.contractAddress ?? requested?.contractAddress;
  if (!chain || !rawAddress) {
    return { success: false, error: `Unsupported chain ${token.chainId}` };
  }
  const contractAddress = canonicalContract(chain, rawAddress);
  const artwork = token.artworks[0];
  const platformId = artwork?.platform?.id ?? null;
  const name = rasterTokenName(token);
  const description = (token.description || artwork?.description || '').trim();
  const artistName = (token.artists[0] ?? artwork?.artists?.[0])?.name ?? '';
  const sourceUrl = fixUpMediaUrl(
    token.media?.contentUrl || token.media?.normalizedContentUrl,
    platformId,
    gateways
  );
  return {
    success: true,
    token: {
      chain,
      caip2Chain: token.chainId,
      contractAddress,
      tokenId: token.tokenId,
      standard: rasterTokenStandard(
        token.tokenStandard,
        chain,
        contractAddress,
        requested?.standard
      ),
      name,
      description,
      image: {
        url: sourceUrl,
        mimeType: rasterTimingMime(token.media),
        thumbnail: RASTER_STILL,
      },
      metadata: { attributes: [], artistName },
      collection: { name: artwork?.title || name, description },
      burned: false,
    },
  };
}

/** RasterTokenEntry pairs a fetched row with the coordinate it answers. */
export interface RasterTokenEntry {
  token: RasterToken;
  requested?: TokenCoordinate;
}

/**
 * itemsFromRasterTokens builds results from rows already in hand.
 *
 * Used by the series path of `find`, whose `artwork.tokens` page already
 * carries every field, and by the wallet walk, so neither pays a second
 * round trip.
 */
export function itemsFromRasterTokens(
  entries: RasterTokenEntry[],
  gateways: IpfsGateways,
  duration?: number
): ResolvedToken[] {
  return entries.map(({ token, requested }) => {
    const tokenData = rasterTokenToStandardToken(token, gateways, requested);
    const coordinate = requested ?? coordinateOf(tokenData, token);
    if (!tokenData.success) {
      return { success: false, coordinate, error: tokenData.error ?? 'Unmappable token' };
    }
    const converted = convertToDP1Item(tokenData, duration);
    if (!converted.success || !converted.item) {
      return { success: false, coordinate, error: converted.error ?? 'Item build failed' };
    }
    return { success: true, coordinate, item: converted.item, still: converted.still ?? '' };
  });
}

/** coordinateOf names the coordinate a row describes when nobody asked for it. */
function coordinateOf(tokenData: TokenData, token: RasterToken): TokenCoordinate {
  return {
    chain: tokenData.token?.chain ?? token.chainId,
    contractAddress: tokenData.token?.contractAddress ?? token.contractAddress ?? '',
    tokenId: token.tokenId,
  };
}

/**
 * normalizeChain maps a coordinate's chain to Raster's vocabulary, or null.
 *
 * The address prefix outranks the caller's chain name: `KT…` is Tezos and
 * `0x…` is EVM whatever the caller said, mirroring the auto-correction the
 * indexer path applied. Only Ethereum and Tezos mainnet are supported.
 */
function normalizeChain(coord: TokenCoordinate): IndexerChain | null {
  if (coord.contractAddress.startsWith('KT')) {
    return 'tezos';
  }
  if (coord.contractAddress.startsWith('0x')) {
    const chain = coord.chain.toLowerCase();
    return chain === 'ethereum' || chain === 'eth' || chain === 'evm' ? 'ethereum' : null;
  }
  return null;
}

/** reportProgress calls a progress callback, which must never break a run. */
function reportProgress(opts: ResolveOptions, done: number, total: number): void {
  try {
    opts.onProgress?.(done, total);
  } catch {
    /* progress display is best-effort */
  }
}

/** DECIMAL_TOKEN_ID is the only token id shape Raster's BigInt scalar accepts. */
const DECIMAL_TOKEN_ID = /^\d+$/;

/**
 * rejectionFor explains why a coordinate cannot be sent to Raster, or ''.
 *
 * Checked before batching because Raster validates every variable of a query
 * together: one non-decimal token id (`0x1f`, `#12`, a typo) rejects the whole
 * request, which would fail up to 39 valid neighbours with an unrelated error.
 */
function rejectionFor(coord: TokenCoordinate): string {
  if (normalizeChain(coord) === null) {
    return `Unsupported chain "${coord.chain}" (Ethereum and Tezos mainnet only)`;
  }
  if (!DECIMAL_TOKEN_ID.test(String(coord.tokenId ?? '').trim())) {
    return `Invalid token id "${coord.tokenId}" (expected a decimal integer)`;
  }
  return '';
}

/**
 * resolveBatch looks up one batch and turns each answer into a result.
 * Coordinates that cannot be sent fail on their own; a failed request fails
 * every coordinate it carried with the same reason.
 */
async function resolveBatch(
  batch: TokenCoordinate[],
  gateways: IpfsGateways,
  duration?: number
): Promise<ResolvedToken[]> {
  const lookups = batch.filter((coord) => rejectionFor(coord) === '');
  let rows: (RasterToken | null)[];
  try {
    rows = await fetchTokensByRef(
      lookups.map((coord) => ({
        chain: normalizeChain(coord) as IndexerChain,
        contractAddress: coord.contractAddress,
        tokenId: String(coord.tokenId).trim(),
      }))
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return batch.map((coordinate) => {
      const rejection = rejectionFor(coordinate);
      return { success: false, coordinate, error: rejection || message };
    });
  }
  const byCoord = new Map(lookups.map((coord, i) => [coord, rows[i]]));
  return batch.map((coordinate) => resolveOne(coordinate, byCoord, gateways, duration));
}

/** resolveOne turns one coordinate's row (or its absence) into a result. */
function resolveOne(
  coordinate: TokenCoordinate,
  rows: Map<TokenCoordinate, RasterToken | null>,
  gateways: IpfsGateways,
  duration?: number
): ResolvedToken {
  const rejection = rejectionFor(coordinate);
  if (rejection) {
    return { success: false, coordinate, error: rejection };
  }
  const row = rows.get(coordinate);
  if (!row) {
    return { success: false, coordinate, error: NOT_ON_RASTER };
  }
  return itemsFromRasterTokens([{ token: row, requested: coordinate }], gateways, duration)[0];
}

/**
 * walkOwnedTokens pages through an address's holdings until `limit` supported
 * tokens are collected or the walk ends. Any page failure throws: a silently
 * truncated wallet would look like a complete one.
 */
async function walkOwnedTokens(
  address: string,
  limit: number | 'all'
): Promise<{ tokens: RasterToken[]; skippedUnsupported: number }> {
  const tokens: RasterToken[] = [];
  let skippedUnsupported = 0;
  let after: string | undefined;
  do {
    const page = await fetchTokensOwned(address, { first: OWNED_PAGE_SIZE, after });
    for (const token of page.tokens) {
      if (!CAIP_TO_CHAIN[token.chainId] || !token.contractAddress) {
        skippedUnsupported += 1;
      } else if (limit === 'all' || tokens.length < limit) {
        tokens.push(token);
      }
    }
    after = page.nextCursor ?? undefined;
  } while (after && (limit === 'all' || tokens.length < limit));
  return { tokens, skippedUnsupported };
}

/**
 * createRasterTokenSource builds the Raster provider.
 *
 * Batches run one after another: 40 tokens per request already turns the
 * ff-cli#132 case (43 tokens, ~10 minutes on the indexer) into two requests,
 * and sequential batches keep load on an unmetered beta API predictable.
 *
 * @param gateways - Resolved IPFS gateways from config
 */
export function createRasterTokenSource(gateways: IpfsGateways): TokenSource {
  return {
    name: 'raster',
    async resolveTokens(coords, opts: ResolveOptions = {}) {
      const results: ResolvedToken[] = [];
      for (let i = 0; i < coords.length; i += RASTER_TOKEN_BATCH_SIZE) {
        const batch = coords.slice(i, i + RASTER_TOKEN_BATCH_SIZE);
        results.push(...(await resolveBatch(batch, gateways, opts.duration)));
        reportProgress(opts, results.length, coords.length);
      }
      logger.debug(`[Raster] Resolved ${results.filter((r) => r.success).length}/${coords.length}`);
      return results;
    },
    async listTokensByOwner(address, opts: ListOptions): Promise<TokenListing> {
      const walked = await walkOwnedTokens(address, opts.limit);
      const entries = walked.tokens.map((token) => ({ token }));
      return {
        results: itemsFromRasterTokens(entries, gateways, opts.duration),
        skippedUnsupported: walked.skippedUnsupported,
      };
    },
    async listTokensByContract(): Promise<TokenListing> {
      throw new TokenSourceCapabilityError(RASTER_CANNOT_LIST_CONTRACT);
    },
  };
}
