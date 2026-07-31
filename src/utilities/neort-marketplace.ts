/**
 * Neort (neort.io) resolver.
 *
 * Neort is an off-chain platform for code-based / generative art. Pieces are
 * referenced by an opaque id (e.g. `ce3lvgkn70rlpj69ccc0`) and do NOT have
 * on-chain coordinates, so the find flow bypasses Raster + FF indexer for
 * Neort items and builds the DP-1 entry directly from Neort's API response
 * using the off-chain `provenance.offChainURI` shape.
 *
 * Asset / thumbnail URLs are constructed by stitching CloudFront paths with
 * fields from the API response (per Ryota / Neort, 2026-05-21):
 *   - artwork:   https://d32h66pp7fue57.cloudfront.net/artPreview/{resourceFileName}
 *   - thumbnail: https://d32h66pp7fue57.cloudfront.net/artThumb/{thumbFileName-or-selectedThumbFileName}
 *
 * Field nuances observed across real responses:
 *   - `thumbFileName` and `selectedThumbFileName` are mutually exclusive in
 *     practice; one is populated, the other empty. Prefer
 *     `selectedThumbFileName` (newer field) and fall back to `thumbFileName`.
 *   - `resourceFileName` is empty for static-image pieces (`resourceType: 3`),
 *     where the thumbnail IS the artwork — fall back to the thumb URL when
 *     resourceFileName is missing so static-image pieces still build.
 *   - Unknown ids return HTTP 200 with `id: ""` (an empty stub), not a 404 —
 *     reject when `id` is empty.
 */

import { fetchWithTimeout } from './http';
import * as logger from '../logger';
import { USER_AGENT } from './user-agent';

const NEORT_API_BASE = 'https://api.neort.io/v1';
const NEORT_CDN_BASE = 'https://d32h66pp7fue57.cloudfront.net';

interface NeortArtResponse {
  id: string;
  title: string;
  description: string;
  user: { id: string; name: string } | null;
  thumbFileName: string;
  selectedThumbFileName: string;
  resourceFileName: string;
  resourceType: number;
  isPublic: boolean;
}

export interface NeortArt {
  id: string;
  title: string;
  description: string;
  artistName: string;
  assetUrl: string;
  thumbnailUrl: string | null;
}

/**
 * Resolve a Neort art id to a playable asset URL plus title/artist metadata.
 *
 * @throws When the id is unknown, the art is private, or no playable asset
 *   can be constructed from the response.
 */
export async function resolveNeortArt(id: string): Promise<NeortArt> {
  logger.debug(`[neort] Resolving art id "${id}"`);
  const response = await fetchWithTimeout(`${NEORT_API_BASE}/art/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Neort API ${response.status} ${response.statusText} for art id "${id}".`);
  }
  const data = (await response.json()) as NeortArtResponse;
  if (!data.id) {
    throw new Error(
      `Neort: no art found for id "${id}". Check the URL — ids come from neort.io/art/{id}.`
    );
  }
  if (!data.isPublic) {
    throw new Error(`Neort: art "${id}" (${data.title || 'untitled'}) is not public.`);
  }
  const thumbFile = data.selectedThumbFileName || data.thumbFileName;
  const thumbnailUrl = thumbFile ? `${NEORT_CDN_BASE}/artThumb/${thumbFile}` : null;
  const assetUrl = data.resourceFileName
    ? `${NEORT_CDN_BASE}/artPreview/${data.resourceFileName}`
    : thumbnailUrl;
  if (!assetUrl) {
    throw new Error(
      `Neort: art "${id}" has no playable asset (resourceFileName and thumbnail are both empty).`
    );
  }
  return {
    id: data.id,
    title: data.title || `Neort ${data.id}`,
    description: data.description || '',
    artistName: data.user?.name ?? '',
    assetUrl,
    thumbnailUrl,
  };
}
