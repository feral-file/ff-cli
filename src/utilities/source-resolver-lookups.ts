/**
 * The ff-source-resolver-service routes ff-cli reads, typed as the service
 * answers them (openapi.yaml in feral-file/ff-source-resolver-service).
 *
 * This module is data only: it names no DP-1 shape and builds nothing.
 * `find` turns these answers into targets (commands/helpers/find-target.ts),
 * and the Raster token source maps the `/raster/*` records, which keep
 * Raster's own field names, into items (token-source-raster.ts).
 */

import { TOKENS_TIMEOUT_MS, serviceRequest } from './source-resolver-client';
import type { RasterToken } from './token-source-raster';

/** The chains a service record can name. Only the first two are buildable. */
export type ServiceChain = 'ethereum' | 'tezos' | 'other';

/** WorkCard is one work as `GET /work` describes it. Only the fields ff-cli reads are typed. */
export interface WorkCard {
  title: string;
  /** The first credited artist's name, the display string. */
  artist: string;
  chain: ServiceChain;
  contract: string;
  /** '' when the link named a whole series (`show: 'all'`) or no token at all. */
  tokenId: string;
  /** The series a source mentions, by name. */
  series?: string;
  /** Present only for a series of more than one distinct output: a Raster slug or `ff:<slug>`. */
  seriesSlug?: string;
  seriesSize?: number;
  /** The link named the whole series rather than one of its works. */
  show?: 'all';
}

/** WorkResult is the `GET /work` body. */
export interface WorkResult {
  /** Whether any source knew the work. */
  found: boolean;
  /** A line for the reader, when the service has one. */
  message?: string;
  work: WorkCard;
  /** Why a source did not answer (a Raster 401, an objkt timeout). Never an error by itself. */
  diag: string[];
}

/** SeriesOutput is one output of a series page. */
export interface SeriesOutput {
  tokenId: string;
  title: string;
  chain: ServiceChain;
  contract: string;
}

/** SeriesPage is one `GET /series` page: 100 outputs, mint order for Raster, index order for Feral File. */
export interface SeriesPage {
  title: string;
  total: number;
  outputs: SeriesOutput[];
  /** '' at the end. */
  next: string;
  /** Outputs on this page the service dropped for being on an unsupported chain. */
  skipped: number;
}

/** RasterArtistRecord is an artist at an address, as `/raster/artists` returns it. */
export interface RasterArtistRecord {
  id: string;
  name: string | null;
  slug: string | null;
}

/** RasterArtworkRecord is the part of an `/raster/artist-works` artwork ff-cli reads. */
export interface RasterArtworkRecord {
  id: string;
  slug: string | null;
  title: string;
}

/** OwnedTokenRecord is one `/raster/tokens-owned` node. */
export interface OwnedTokenRecord {
  quantity: number;
  lastAcquiredAt: string | null;
  token: RasterToken;
}

/** TokenRef is a coordinate in the service's request vocabulary. */
export interface TokenRef {
  chain: 'ethereum' | 'tezos';
  contract: string;
  tokenId: string;
}

/**
 * RASTER_REFS_PER_REQUEST is the most refs `/raster/tokens` takes at once
 * (the size ff-app measured: each alias carries full media and credits).
 */
export const RASTER_REFS_PER_REQUEST = 40;

/** RASTER_ARTIST_WORKS_PAGE is the largest `/raster/artist-works` page the service serves. */
const RASTER_ARTIST_WORKS_PAGE = 40;

/**
 * lookupWork asks which work a link or `chain:contract:tokenId` names.
 *
 * @param input - The caller's link or coordinate, as typed
 * @returns The work card and the service's notes
 */
export async function lookupWork(input: string): Promise<WorkResult> {
  return serviceRequest<WorkResult>({ path: '/work', query: { url: input } });
}

/**
 * lookupSeriesPage reads one page of a series.
 *
 * @param slug - A Raster artwork slug, or `ff:` and a Feral File series slug
 * @param after - The previous page's `next`; omit for the first page
 * @returns The page, or null when the service knows no such series
 */
export async function lookupSeriesPage(slug: string, after?: string): Promise<SeriesPage | null> {
  return serviceRequest<SeriesPage>(
    { path: '/series', query: { slug, after } },
    { notFoundAsNull: true }
  );
}

/**
 * lookupRasterArtists lists the Raster artists at a wallet address.
 *
 * @param address - An Ethereum or Tezos address
 * @returns The artists; empty when Raster knows none
 */
export async function lookupRasterArtists(address: string): Promise<RasterArtistRecord[]> {
  const body = await serviceRequest<{ artists: RasterArtistRecord[] }>({
    path: '/raster/artists',
    query: { address: address.trim() },
  });
  return body?.artists ?? [];
}

/**
 * lookupRasterArtistWorks walks an artist's whole catalog, page by page, so
 * the picker shows every work the way the single-response API once did.
 *
 * @param artistId - Raster artist id
 * @returns Every artwork, in Raster's order
 */
export async function lookupRasterArtistWorks(artistId: string): Promise<RasterArtworkRecord[]> {
  const works: RasterArtworkRecord[] = [];
  let after = '';
  do {
    const page = await serviceRequest<{ works: RasterArtworkRecord[]; next: string }>({
      path: '/raster/artist-works',
      query: { id: artistId, after, first: RASTER_ARTIST_WORKS_PAGE },
    });
    works.push(...(page?.works ?? []));
    after = page?.next ?? '';
  } while (after);
  return works;
}

/**
 * lookupRasterTokens reads Raster's records for up to RASTER_REFS_PER_REQUEST
 * coordinates in one request. Batching across requests is the caller's, which
 * owns progress and per-batch failure.
 *
 * @param refs - The coordinates, at most RASTER_REFS_PER_REQUEST
 * @returns One record per ref in order; null where Raster does not cover it
 */
export async function lookupRasterTokens(refs: TokenRef[]): Promise<(RasterToken | null)[]> {
  if (refs.length > RASTER_REFS_PER_REQUEST) {
    throw new Error(`lookupRasterTokens takes at most ${RASTER_REFS_PER_REQUEST} refs per call.`);
  }
  if (refs.length === 0) {
    return [];
  }
  const body = await serviceRequest<{ tokens: (RasterToken | null)[] }>({
    path: '/raster/tokens',
    body: { refs },
  });
  return refs.map((_, i) => body?.tokens?.[i] ?? null);
}

/**
 * lookupRasterTokensOwned reads one page of what an address holds on Raster.
 *
 * @param address - An Ethereum or Tezos address
 * @param options - `first` (at most 250) and the previous page's `next`
 * @returns The page's records and the next cursor ('' at the end)
 */
export async function lookupRasterTokensOwned(
  address: string,
  options: { first: number; after?: string }
): Promise<{ tokens: OwnedTokenRecord[]; next: string }> {
  const body = await serviceRequest<{ tokens: OwnedTokenRecord[]; next: string }>({
    path: '/raster/tokens-owned',
    query: { address: address.trim(), first: options.first, after: options.after },
  });
  return { tokens: body?.tokens ?? [], next: body?.next ?? '' };
}

/** PageTokens is what `GET /tokens` says a page holds: its title and its tokens' coordinates. */
export interface PageTokens {
  title: string;
  coords: TokenRef[];
}

/** PlaylistItemProvenance is the part of a `/tokens` playlist item that names its token. */
interface PlaylistItemProvenance {
  provenance?: { contract?: { chain?: string; address?: string; tokenId?: string } };
}

/**
 * lookupPageTokens asks the service which tokens a marketplace page shows,
 * for the pages `/work` cannot express as one work or one series: a
 * collection, a Feral File show, a fxhash or OpenSea project by its slug.
 *
 * `/tokens` answers with a signed DP-1 playlist the service built, and the
 * service leaves out a token it could not build an item for, so membership
 * read here can be short of the page's. That is a known gap: the service has
 * no route that lists a page's coordinates losslessly, and adding one there
 * is the fix, not reconstructing membership here. Only each item's
 * `provenance.contract` is read: ff-cli builds its own items through
 * its configured token source (one vendor per run), so the service's items
 * are not reused. DP-1 names Ethereum `evm`; the service builds Ethereum and Tezos only, so
 * `evm` is mapped back to Ethereum here.
 *
 * @param input - The page URL
 * @returns The playlist title and the coordinates on Ethereum and Tezos
 * @throws Error with the service's message when it cannot resolve the page
 */
export async function lookupPageTokens(input: string): Promise<PageTokens> {
  const playlist = await serviceRequest<{ title?: string; items?: PlaylistItemProvenance[] }>({
    path: '/tokens',
    query: { url: input },
    timeoutMs: TOKENS_TIMEOUT_MS,
  });
  const coords: TokenRef[] = [];
  for (const item of playlist?.items ?? []) {
    const contract = item.provenance?.contract;
    const chain = contract?.chain === 'evm' ? 'ethereum' : contract?.chain;
    if ((chain === 'ethereum' || chain === 'tezos') && contract?.address && contract?.tokenId) {
      coords.push({ chain, contract: contract.address, tokenId: contract.tokenId });
    }
  }
  return { title: playlist?.title ?? '', coords };
}

/** FeralFileArtworkCoords is a Feral File artwork's token, in the token source's vocabulary. */
export interface FeralFileArtworkCoords {
  chain: 'ethereum' | 'tezos';
  contractAddress: string;
  tokenId: string;
}

/** FERAL_FILE_ARTWORK_PATH matches the artwork page paths the service reads. */
const FERAL_FILE_ARTWORK_PATH = /^\/(?:exhibitions\/artwork|artworks)\/([^/]+)\/?$/;

/**
 * feralFileArtworkLink turns a `feral_file_artwork` requirement's `artworkId`
 * into the artwork page link `/work` reads. A raw public artwork id is
 * accepted as well as a feralfile.com artwork URL, so structured build inputs
 * can pass the id directly.
 *
 * @param input - A public artwork id, or a feralfile.com artwork URL
 * @returns The artwork page URL
 * @throws Error for an empty input or a URL that is not a Feral File artwork page
 */
export function feralFileArtworkLink(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Feral File artwork id is required');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return `https://feralfile.com/artworks/${encodeURIComponent(trimmed)}`;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'feralfile.com') {
    throw new Error(`Unsupported Feral File artwork URL host: ${url.hostname}`);
  }
  const match = FERAL_FILE_ARTWORK_PATH.exec(url.pathname);
  if (!match) {
    throw new Error('Unsupported Feral File artwork URL path');
  }
  return `https://feralfile.com/artworks/${match[1]}`;
}

/**
 * lookupFeralFileArtwork resolves a Feral File artwork to its token through
 * `/work`, which reads Feral File's own artwork record. That record is the
 * source of truth for swapped ids, where the public artwork id differs from
 * the on-chain token id, so the coordinates are taken from the answer and
 * never rebuilt from the id.
 *
 * @param input - A public artwork id, or a feralfile.com artwork URL
 * @returns The artwork's token coordinates
 * @throws Error when the artwork has no Ethereum or Tezos token the service found
 */
export async function lookupFeralFileArtwork(input: string): Promise<FeralFileArtworkCoords> {
  const link = feralFileArtworkLink(input);
  const work = (await lookupWork(link))?.work;
  if (
    !work ||
    (work.chain !== 'ethereum' && work.chain !== 'tezos') ||
    !work.contract ||
    !work.tokenId
  ) {
    throw new Error(`Feral File artwork ${input.trim()} has no Ethereum or Tezos token on record.`);
  }
  return { chain: work.chain, contractAddress: work.contract, tokenId: work.tokenId };
}
