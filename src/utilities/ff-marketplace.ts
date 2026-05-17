/**
 * Feral File marketplace resolver.
 *
 * The FF public API (`feralfile.com/api`) does not expose `chain` or
 * `contractAddress` on the artwork record, so resolving an FF URL to
 * on-chain coordinates requires walking artwork → series → exhibition →
 * contract. This module isolates that walk; when the API fix in
 * feral-file/ff-exhibition#3039 ships, the artwork path collapses to a
 * single GET and this file shrinks.
 *
 * For series URLs (multi-token), we return one representative token —
 * the Raster reverse-lookup in the caller resolves to the series and
 * enumerates the rest. We deliberately do not exhaust pages here; the
 * upstream Raster client owns series enumeration.
 */
import * as logger from '../logger';
import type { IndexerChain } from './raster-client';
import type { TokenCoords, FeralFileUrlKind } from './marketplace-url';

const FF_API_BASE = 'https://feralfile.com/api';

interface ArtworkByIdResponse {
  result: {
    id: string;
    seriesID: string;
  };
}

interface SeriesByIdResponse {
  result: {
    id: string;
    exhibitionID: string;
    onchainID: string;
  };
}

interface SeriesByQueryResponse {
  result: Array<{
    id: string;
    exhibitionID: string;
    slug: string;
  }>;
}

interface ArtworksByQueryResponse {
  result: Array<{
    id: string;
    seriesID: string;
  }>;
}

interface ExhibitionResponse {
  result: {
    contracts: Array<{
      blockchainType: string;
      address: string;
    }>;
  };
}

async function ffFetch<T>(path: string): Promise<T> {
  const url = `${FF_API_BASE}${path}`;
  logger.debug(`[FF API] GET ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Feral File API ${response.status} ${response.statusText} for ${path}: ${body.slice(0, 200)}`
    );
  }
  return (await response.json()) as T;
}

function ffChainToIndexer(blockchainType: string): IndexerChain | null {
  const normalized = blockchainType.toLowerCase();
  if (normalized === 'ethereum' || normalized === 'tezos') {
    return normalized;
  }
  return null;
}

function pickSupportedContract(contracts: Array<{ blockchainType: string; address: string }>): {
  chain: IndexerChain;
  address: string;
} {
  for (const c of contracts) {
    const chain = ffChainToIndexer(c.blockchainType);
    if (chain) {
      return {
        chain,
        address: chain === 'ethereum' ? c.address.toLowerCase() : c.address,
      };
    }
  }
  const seen = contracts.map((c) => c.blockchainType).join(', ') || 'none';
  throw new Error(
    `Feral File: no Ethereum or Tezos contract found for this exhibition (saw: ${seen}). ` +
      'The FF indexer in ff-cli covers eth + tezos mainnet only.'
  );
}

/**
 * Resolve a parsed Feral File URL to on-chain token coordinates.
 *
 * For series URLs, returns the first token in the series — the Raster
 * reverse-lookup in the caller resolves to the series and enumerates the
 * rest. `show` URLs are rejected: a single exhibition spans multiple series,
 * which is wider than v1 supports.
 */
export async function resolveFeralFileToken(parsed: {
  urlKind: FeralFileUrlKind;
  identifier: string;
}): Promise<TokenCoords> {
  switch (parsed.urlKind) {
    case 'artwork':
      return resolveFromArtworkID(parsed.identifier);
    case 'series':
      return resolveFromSeriesSlug(parsed.identifier);
    case 'show':
      throw new Error(
        'Feral File `/exhibitions/shows/{slug}` URLs span multiple series; not supported in v1. ' +
          'Paste a specific series (`/exhibitions/series/{slug}`) or artwork URL.'
      );
  }
}

async function resolveFromArtworkID(tokenId: string): Promise<TokenCoords> {
  const artwork = await ffFetch<ArtworkByIdResponse>(`/artworks/${tokenId}`);
  const series = await ffFetch<SeriesByIdResponse>(`/series/${artwork.result.seriesID}`);
  const exhibition = await ffFetch<ExhibitionResponse>(
    `/exhibitions/${series.result.exhibitionID}`
  );
  const { chain, address } = pickSupportedContract(exhibition.result.contracts);
  return { chain, contract: address, tokenId };
}

async function resolveFromSeriesSlug(slug: string): Promise<TokenCoords> {
  const series = await ffFetch<SeriesByQueryResponse>(`/series?slug=${encodeURIComponent(slug)}`);
  if (!series.result || series.result.length === 0) {
    throw new Error(`Feral File: no series found for slug "${slug}".`);
  }
  // Slug collisions across exhibitions are documented in ff-exhibition#3039.
  // Take the first record; the user can pass the artwork URL directly to disambiguate.
  if (series.result.length > 1) {
    logger.warn(
      `[FF API] Slug "${slug}" matched ${series.result.length} series across exhibitions; ` +
        'taking the first. Pass /exhibitions/artwork/{tokenId} to disambiguate.'
    );
  }
  const picked = series.result[0];

  const artworks = await ffFetch<ArtworksByQueryResponse>(
    `/artworks?seriesID=${encodeURIComponent(picked.id)}`
  );
  if (!artworks.result || artworks.result.length === 0) {
    throw new Error(`Feral File: series "${slug}" has no artworks.`);
  }
  const representativeTokenId = artworks.result[0].id;

  const exhibition = await ffFetch<ExhibitionResponse>(`/exhibitions/${picked.exhibitionID}`);
  const { chain, address } = pickSupportedContract(exhibition.result.contracts);
  return { chain, contract: address, tokenId: representativeTokenId };
}
