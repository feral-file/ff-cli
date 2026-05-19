/**
 * Feral File marketplace resolver.
 *
 * Both artwork and series URLs go through the self-describing
 * `/api/artworks/{id}` endpoint (one GET returning chain, contract, and the
 * on-chain tokenID — including the swapped tokenID case where the public
 * URL id differs from the on-chain id). Series URLs add one extra hop:
 * resolve the series slug, then look up its first artwork, then hand that
 * artwork id to `resolveFeralFileArtwork`. The exhibition's contract list is
 * not consulted — exhibitions can host multiple series across multiple
 * contracts, so picking-first would silently route a Tezos series to an
 * Ethereum sibling contract on the same exhibition.
 *
 * Show URLs are rejected: a single exhibition spans multiple series, which
 * is wider than v1 supports.
 */
import * as logger from '../logger';
import type { TokenCoords, FeralFileUrlKind } from './marketplace-url';
import { resolveFeralFileArtwork } from './feral-file-artwork';

const FF_API_BASE = 'https://feralfile.com/api';

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

/**
 * Resolve a parsed Feral File URL to on-chain token coordinates. For series
 * URLs we return one representative token; the Raster reverse-lookup in the
 * caller resolves to the series and enumerates the rest.
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

async function resolveFromArtworkID(publicArtworkId: string): Promise<TokenCoords> {
  // /api/artworks/{id} returns chain + contractAddress + on-chain tokenID
  // directly, including the swapped-id case where URL id != on-chain id.
  const { chain, contractAddress, tokenId } = await resolveFeralFileArtwork(publicArtworkId);
  return {
    chain,
    contract: chain === 'ethereum' ? contractAddress.toLowerCase() : contractAddress,
    tokenId,
  };
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
  // Hand the representative artwork's public id to the canonical resolver so
  // we get the right (chain, contract, on-chain tokenID) for THIS series —
  // not whatever picking-first off the exhibition's contract list returned.
  return resolveFromArtworkID(artworks.result[0].id);
}
