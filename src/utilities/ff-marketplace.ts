/**
 * Feral File marketplace resolver.
 *
 * The FF public API (`feralfile.com/api`) exposes self-describing artwork
 * identity: `chain`, `contractAddress`, and `tokenID`. Keep resolution on that
 * public contract so external consumers and the CLI do not need to duplicate
 * Feral File's internal artwork → series → exhibition data model.
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
  result: ArtworkIdentity;
}

interface SeriesByQueryResponse {
  result: Array<{
    id: string;
    exhibitionID: string;
    slug: string;
  }>;
}

interface ArtworksByQueryResponse {
  result: ArtworkIdentity[];
}

interface ArtworkIdentity {
  id: string;
  seriesID: string;
  chain?: string;
  contractAddress?: string;
  tokenID?: string;
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
  return artworkIdentityToCoords(artwork.result, `/artworks/${tokenId}`);
}

async function resolveFromSeriesSlug(slug: string): Promise<TokenCoords> {
  const series = await ffFetch<SeriesByQueryResponse>(`/series?slug=${encodeURIComponent(slug)}`);
  if (!series.result || series.result.length === 0) {
    throw new Error(`Feral File: no series found for slug "${slug}".`);
  }
  if (series.result.length > 1) {
    throw new Error(
      `Feral File: slug "${slug}" matched ${series.result.length} series. ` +
        'Paste a specific /exhibitions/artwork/{id} URL to disambiguate.'
    );
  }
  const picked = series.result[0];

  const artworks = await ffFetch<ArtworksByQueryResponse>(
    `/artworks?seriesID=${encodeURIComponent(picked.id)}`
  );
  if (!artworks.result || artworks.result.length === 0) {
    throw new Error(`Feral File: series "${slug}" has no artworks.`);
  }
  return artworkIdentityToCoords(artworks.result[0], `/artworks?seriesID=${picked.id}`);
}

/**
 * artworkIdentityToCoords converts the public Feral File artwork identity
 * fields into the coordinate shape expected by Raster and the FF indexer.
 *
 * `id` is not always the on-chain token ID: swapped artworks can be addressed
 * by a public swap token while `tokenID` carries the actual on-chain token.
 * Require `tokenID` explicitly so an API regression fails loudly instead of
 * silently indexing the wrong token.
 */
function artworkIdentityToCoords(artwork: ArtworkIdentity, sourcePath: string): TokenCoords {
  const chain = ffChainToIndexer(artwork.chain ?? '');
  if (!chain) {
    throw new Error(
      `Feral File: artwork identity from ${sourcePath} has unsupported or missing chain ` +
        `"${artwork.chain ?? 'missing'}". The FF indexer in ff-cli covers eth + tezos mainnet only.`
    );
  }
  if (!artwork.contractAddress) {
    throw new Error(`Feral File: artwork identity from ${sourcePath} is missing contractAddress.`);
  }
  if (!artwork.tokenID) {
    throw new Error(`Feral File: artwork identity from ${sourcePath} is missing tokenID.`);
  }

  return {
    chain,
    contract:
      chain === 'ethereum' ? artwork.contractAddress.toLowerCase() : artwork.contractAddress,
    tokenId: artwork.tokenID,
  };
}
