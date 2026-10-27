/**
 * Token item construction shared by every token source.
 *
 * This module turns a StandardToken, the vendor-neutral token shape, into a
 * DP-1 playlist item. It used to live inside nft-indexer.js, which meant the
 * item id, provenance, inline manifest and timing rules would have been
 * deleted along with the ff-indexer-v2 client if Raster replaces it
 * (feral-file#3576). Keeping them here, with no knowledge of any vendor, is
 * what lets two providers emit byte-identical items for the same token: the
 * indexer provider and the Raster provider both map their rows to
 * a StandardToken and hand it to convertToDP1Item.
 *
 * Invariants that must not change without a migration of existing playlists:
 *   - the item id is sha256(`${contractAddress}-${tokenId}`) formatted as a
 *     UUID, so the same token always yields the same id across vendors;
 *   - provenance.contract.chain comes from the row's CAIP-2 chain when the
 *     row has one, and only falls back to the caller's chain name otherwise;
 *   - the inline manifest id is derived from the token coordinate by
 *     ref-manifest.ts, independent of which vendor supplied the metadata.
 */

import { createHash } from 'node:crypto';
import {
  PlaylistItemBuilder,
  ProvenanceBuilder,
  ContractBuilder,
  type Chain,
  type TokenStandard,
} from 'dp1-js';
import * as logger from '../logger';
import { buildInlineManifestForToken } from './ref-manifest';

// playlist-builder.js is still CommonJS; require keeps interop simple, the
// same way find.ts and playlist-source.ts load it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyTimingToItemBuilder, buildDefaultDisplay } = require('./playlist-builder');

/**
 * StandardToken is the vendor-neutral token shape every provider produces.
 *
 * `chain` is the client chain name the caller inferred (`ethereum`, `tezos`),
 * kept beside `caip2Chain`, the network the provider recorded, because the
 * name still selects CID prefixes and detection fallbacks while the CAIP-2
 * value answers DP-1's chain enum. `image.url` is the media the provider
 * chose as the source; `image.thumbnail` is the still it names for the token.
 */
export interface StandardToken {
  chain: string;
  caip2Chain?: string;
  contractAddress: string;
  tokenId: string;
  standard?: string;
  name?: string;
  description?: string;
  image?: string | { url?: string; mimeType?: string; thumbnail?: string };
  animation_url?: string;
  animationUrl?: string;
  metadata?: { attributes?: unknown[]; artistName?: string };
  owner?: string;
  collection?: { name?: string; description?: string };
  burned?: boolean;
}

/** TokenData wraps a StandardToken with the success flag providers emit. */
export interface TokenData {
  success: boolean;
  token?: StandardToken;
  error?: string;
}

/** Dp1ItemResult is one outcome of convertToDP1Item. */
export interface Dp1ItemResult {
  success: boolean;
  item?: Record<string, unknown>;
  still?: string;
  error?: string;
}

/**
 * detectTokenStandard guesses a token standard from a chain name and an address.
 *
 * This is the last-resort fallback, not the answer. It sees no token, only a
 * chain name and an address format, so it cannot tell ERC-721 from ERC-1155
 * and answers `erc721` for every EVM contract. It is still needed in two
 * places: a lookup by coordinate has to build some key before a provider has
 * been asked anything, and a token row that arrived without a `standard`
 * field has nothing better to offer.
 *
 * Prefer, in order: the provider row's own standard, a caller's assertion, and
 * only then this. On-chain detection is deliberately not attempted here.
 *
 * @param chain - Blockchain network
 * @param contractAddress - Contract address
 * @returns Token standard (erc721, erc1155, fa2, or other)
 */
export function detectTokenStandard(chain: string, contractAddress: string): string {
  const lowerChain = String(chain || '').toLowerCase();

  // Tezos contracts use FA2 standard
  if (lowerChain === 'tezos' || String(contractAddress || '').startsWith('KT')) {
    return 'fa2';
  }

  // Ethereum: erc721 is a guess, not a reading. Only the provider row or a
  // caller's assertion can distinguish an ERC-1155 token from an ERC-721 one.
  if (lowerChain === 'ethereum') {
    return 'erc721';
  }

  return 'other';
}

/**
 * CID_STANDARDS are the token standards the indexer keys CIDs on and DP-1
 * `provenance.contract.standard` accepts from this CLI. A standard outside
 * this set, asserted by a caller or arriving on a row, says nothing the key
 * can carry, so detection decides instead.
 */
export const CID_STANDARDS: ReadonlySet<string> = new Set(['erc721', 'erc1155', 'fa2']);

/**
 * normalizeCidStandard returns a standard the CID format can carry, or ''.
 *
 * Both a provider row and a caller's assertion are untrusted strings from
 * outside this module ('ERC1155', ' fa2 ', 'ERC-1155', undefined). Anything not
 * in CID_STANDARDS is treated as absent rather than passed through, so a
 * misspelled standard never reaches a CID or a DP-1 `provenance.contract`.
 *
 * @param value - Candidate standard
 * @returns Normalized standard, or '' when it is not one we can use
 */
export function normalizeCidStandard(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CID_STANDARDS.has(normalized) ? normalized : '';
}

/**
 * resolveTokenStandard picks the standard a lookup key is built with.
 *
 * detectTokenStandard cannot tell ERC-721 from ERC-1155, so when the caller
 * knows the standard (a DP-1 playlist carries it in
 * `provenance.contract.standard`) that assertion wins.
 *
 * @param chain - Blockchain network
 * @param contractAddress - Contract address
 * @param asserted - Standard the caller vouches for, if any
 * @returns Token standard for the lookup key
 */
export function resolveTokenStandard(
  chain: string,
  contractAddress: string,
  asserted?: unknown
): string {
  return normalizeCidStandard(asserted) || detectTokenStandard(chain, contractAddress);
}

/**
 * CAIP2_NAMESPACE_TO_DP1_CHAIN maps CAIP-2 namespaces to the chain values DP-1
 * `provenance.contract` allows. Namespaces outside this map have no DP-1
 * equivalent.
 */
const CAIP2_NAMESPACE_TO_DP1_CHAIN: Record<string, string> = {
  eip155: 'evm',
  tezos: 'tezos',
  bitmark: 'bitmark',
};

/**
 * dp1ChainFromCaip2 derives a DP-1 chain from a CAIP-2 chain id.
 *
 * @param caip2Chain - CAIP-2 chain id from a provider row, e.g. `eip155:1`
 * @returns DP-1 chain (`evm`, `tezos`, `bitmark`), or '' when unknown or absent
 */
export function dp1ChainFromCaip2(caip2Chain: unknown): string {
  if (typeof caip2Chain !== 'string') {
    return '';
  }
  const namespace = caip2Chain.trim().toLowerCase().split(':')[0];
  return CAIP2_NAMESPACE_TO_DP1_CHAIN[namespace] || '';
}

/**
 * CHAIN_NAME_TO_DP1_CHAIN maps client chain names to the chain values DP-1
 * `provenance.contract` allows. It answers only for tokens that reached us
 * without a provider row, that is a caller-supplied coordinate.
 */
const CHAIN_NAME_TO_DP1_CHAIN: Record<string, string> = {
  ethereum: 'evm',
  polygon: 'evm',
  arbitrum: 'evm',
  optimism: 'evm',
  base: 'evm',
  zora: 'evm',
  tezos: 'tezos',
  bitmark: 'bitmark',
};

/**
 * resolveDp1Chain picks the DP-1 chain for a token's `provenance.contract`.
 *
 * The row's CAIP-2 chain and the caller's chain name are not two guesses to try
 * in turn: they are different claims, and the row's is the network the
 * provider recorded. So a token carrying a row chain is answered from that
 * chain alone; a namespace with no DP-1 equivalent becomes `other`, never the
 * caller's name. Falling through would be actively wrong, because owner and
 * contract lookups label every non-KT address `ethereum` before mapping, so a
 * Solana row would inherit that label and be published as an EVM contract.
 *
 * @param token - Token in the internal standard format
 * @returns DP-1 chain (`evm`, `tezos`, `bitmark`, or `other`)
 */
export function resolveDp1Chain(token: Pick<StandardToken, 'caip2Chain' | 'chain'>): string {
  const rowChain = typeof token.caip2Chain === 'string' ? token.caip2Chain.trim() : '';
  if (rowChain) {
    return dp1ChainFromCaip2(rowChain) || 'other';
  }
  return CHAIN_NAME_TO_DP1_CHAIN[String(token.chain || '').toLowerCase()] || 'other';
}

/**
 * extractArtistName returns the first artist's name from an artists array, or ''.
 *
 * @param artists - Array of artist objects with a name
 * @returns Artist name or empty string
 */
export function extractArtistName(artists: unknown): string {
  if (!Array.isArray(artists) || artists.length === 0) {
    return '';
  }
  const first = artists[0] as { name?: unknown } | undefined;
  return typeof first?.name === 'string' ? first.name : '';
}

/**
 * isUsableSourceUrl reports whether a media URL can be a DP-1 item source.
 *
 * Data URIs are refused because the FF1 display path cannot load them and
 * inlining base64 would dwarf the playlist; URLs over 1024 characters exceed
 * the DP-1 limit on `source`.
 *
 * @param url - Candidate media URL
 * @returns True when URL is usable in a DP-1 source
 */
export function isUsableSourceUrl(url: unknown): url is string {
  if (!url || typeof url !== 'string') {
    return false;
  }
  if (url.startsWith('data:')) {
    return false;
  }
  if (url.length > 1024) {
    return false;
  }
  return true;
}

/** MediaAssetRow is the indexer's `media_assets` row shape, kept for getBestMediaUrl. */
export interface MediaAssetRow {
  source_url?: string | null;
  variants?: Record<string, unknown> | null;
}

/** DisplayFields is the subset of a provider's presentation block getBestMediaUrl reads. */
export interface DisplayFields {
  animation_url?: string | null;
  image_url?: string | null;
}

/**
 * getBestMediaUrl picks a DP-1 usable URL from a `display` block and asset rows.
 *
 * Order: display.animation_url, transcoded asset URLs (source + variants),
 * display.image_url. The thumbnail is always `display.image_url`, the field
 * reserved for a still.
 *
 * @param display - Merged presentation block
 * @param mediaAssets - Transcoded asset rows
 * @returns Object with url and thumbnail properties
 */
export function getBestMediaUrl(
  display: DisplayFields = {},
  mediaAssets: MediaAssetRow[] = []
): { url: string; thumbnail: string } {
  const urlsFromAssets: unknown[] = [];
  for (const asset of Array.isArray(mediaAssets) ? mediaAssets : []) {
    if (asset?.source_url) {
      urlsFromAssets.push(asset.source_url);
    }
    const v = asset?.variants;
    if (v && typeof v === 'object') {
      for (const val of Object.values(v)) {
        if (typeof val === 'string') {
          urlsFromAssets.push(val);
        }
      }
    }
  }

  const candidates = [display?.animation_url, ...urlsFromAssets, display?.image_url];

  for (const candidate of candidates) {
    if (isUsableSourceUrl(candidate)) {
      return {
        url: candidate,
        thumbnail: display?.image_url || '',
      };
    }
  }

  const imageUrl = display?.image_url || '';
  return {
    url: imageUrl,
    thumbnail: imageUrl,
  };
}

/**
 * itemIdFor derives the deterministic DP-1 item id for a token coordinate.
 *
 * sha256 of `${contractAddress}-${tokenId}` formatted UUID-style. This is a
 * cross-vendor contract: a playlist built from the indexer and one built from
 * Raster must carry the same id for the same token.
 *
 * @param token - Token coordinate
 * @returns UUID-formatted id
 */
export function itemIdFor(token: Pick<StandardToken, 'contractAddress' | 'tokenId'>): string {
  const idSource = `${token.contractAddress}-${token.tokenId}`;
  const hash = createHash('sha256').update(idSource).digest('hex');
  return `${hash.substr(0, 8)}-${hash.substr(8, 4)}-${hash.substr(12, 4)}-${hash.substr(16, 4)}-${hash.substr(20, 12)}`;
}

/**
 * pickSourceUrl chooses the item source from a token's media candidates.
 *
 * Priority: animation_url, then image.url. The first usable candidate wins;
 * when none is usable the first non-empty one is returned so the caller can
 * report precisely why it was rejected.
 *
 * @param token - Token in the internal standard format
 * @returns Source URL, or '' when the token names no media at all
 */
function pickSourceUrl(token: StandardToken): string {
  const candidateSourceUrls = [
    token.animation_url || token.animationUrl,
    token.image && typeof token.image === 'object' ? token.image.url : '',
  ]
    .map((value) => String(value || ''))
    .filter(Boolean);

  return candidateSourceUrls.find((url) => isUsableSourceUrl(url)) || candidateSourceUrls[0] || '';
}

/**
 * rejectSourceUrl explains why a source URL cannot be used, or returns ''.
 *
 * @param token - Token the URL belongs to, for the log line
 * @param sourceUrl - Candidate source
 * @returns Error message, or '' when the URL is usable
 */
function rejectSourceUrl(token: StandardToken, sourceUrl: string): string {
  const coordinate = { contractAddress: token.contractAddress, tokenId: token.tokenId };
  if (!sourceUrl) {
    logger.warn('[Token Item] No source URL found for token:', coordinate);
    return 'No source URL available';
  }
  if (sourceUrl.startsWith('data:')) {
    logger.debug('[Token Item] Skipping token with data URI:', coordinate);
    return 'Source is a data URI (not supported)';
  }
  if (sourceUrl.length > 1024) {
    logger.debug('[Token Item] Skipping token with source URL too long:', {
      ...coordinate,
      urlLength: sourceUrl.length,
    });
    return `Source URL too long (${sourceUrl.length} chars, max 1024)`;
  }
  return '';
}

/**
 * convertToDP1Item converts a token in the standard format to a DP-1 item.
 *
 * When the token carries description, artist, or a still image distinct from
 * the source, the item also gets an inline Ref Manifest (see ref-manifest.ts).
 *
 * @param tokenData - Token data in standard format
 * @param duration - Explicit display seconds; omit for auto timing
 *   (video/audio play natural length per DP-1 §4.1)
 * @returns DP-1 item with success/error status, plus the token's still
 */
export function convertToDP1Item(tokenData: TokenData, duration?: number): Dp1ItemResult {
  const { token } = tokenData;

  if (!token) {
    return {
      success: false,
      error: tokenData.error || 'Invalid token data',
    };
  }

  const sourceUrl = pickSourceUrl(token);
  const rejection = rejectSourceUrl(token, sourceUrl);
  if (rejection) {
    return { success: false, error: rejection };
  }

  // Build via dp1-js PlaylistItemBuilder so leaf blocks match the DP-1 AJV schema.
  const itemBuilder = new PlaylistItemBuilder()
    .id(itemIdFor(token))
    .source(sourceUrl)
    .license('open')
    .provenance(
      new ProvenanceBuilder().type('onChain').contract(
        new ContractBuilder()
          // resolveDp1Chain and the standard helpers only ever return members
          // of the dp1-js unions, so the casts narrow rather than lie.
          .chain(resolveDp1Chain(token) as Chain)
          .standard(
            (token.standard ||
              detectTokenStandard(token.chain, token.contractAddress)) as TokenStandard
          )
          .address(token.contractAddress)
          .tokenId(String(token.tokenId))
      )
    );

  if (token.name) {
    itemBuilder.title(token.name);
  }

  // Carry description, artist, and still image inline (DP-1 Playlist Extension
  // §3.6). The helper returns undefined when the token has nothing beyond its
  // title, so thin tokens stay thin.
  const inlineManifest = buildInlineManifestForToken(token, { sourceUrl });
  if (inlineManifest) {
    itemBuilder.inlineManifest(inlineManifest);
  }

  const mimeType =
    typeof token.image === 'object' && token.image ? token.image.mimeType : undefined;
  applyTimingToItemBuilder(itemBuilder, { mimeType, sourceUrl }, duration, buildDefaultDisplay());

  let dp1Item: Record<string, unknown>;
  try {
    dp1Item = itemBuilder.build() as unknown as Record<string, unknown>;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  logger.debug('[Token Item] ✓ Converted to DP-1:', {
    title: token.name,
    source: sourceUrl ? sourceUrl.substring(0, 60) + '...' : '(no source URL)',
  });

  return {
    success: true,
    item: dp1Item,
    still: stillOf(token),
  };
}

/**
 * stillOf names the token's still image as the provider identifies it, or ''.
 *
 * Only `image.thumbnail` qualifies. `image.url` is the media the provider
 * selected as the source, which is the live rendition whenever one exists,
 * exactly what must never land in a thumbnail slot. It is returned beside the
 * DP-1 item rather than inside it because the item only carries the still when
 * it differs from the item's own source, and a consumer building a manifest
 * against a different source (see enrich-playlist.ts) needs the still
 * regardless. Nothing about the URL's shape is inspected: the provider's word
 * that it is an image is the evidence, and a suffix check would reject the
 * extensionless CDN URLs providers commonly return.
 *
 * @param token - Token in the internal standard format
 * @returns http(s) still URL, or '' when the provider named none
 */
export function stillOf(token: StandardToken): string {
  const image = token.image;
  const candidate =
    typeof image === 'string' ? image : typeof image === 'object' && image ? image.thumbnail : '';
  const trimmed = String(candidate || '').trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : '';
}
