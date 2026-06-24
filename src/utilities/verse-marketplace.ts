import type { TokenCoords } from '@feralfile/source-resolver';

/**
 * Resolve a Verse series slug to representative Ethereum token coordinates.
 *
 * Verse series pages render edition links as
 * `/items/ethereum/{contract}/{tokenId}`. Using the first rendered edition
 * keeps the resolver independent of private frontend state while still handing
 * Raster a token it can use to enumerate the full series.
 *
 * @param slug - Verse series slug from `/series/{slug}`
 * @returns Representative Ethereum token coordinates
 * @throws Error when the page cannot be fetched or no Ethereum edition link is present
 */
export async function resolveVerseSeries(slug: string): Promise<TokenCoords> {
  const url = `https://verse.works/series/${encodeURIComponent(slug)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Verse series lookup failed for ${slug}: ${response.status}`);
  }

  const html = await response.text();
  const match = /\/items\/ethereum\/(0x[a-fA-F0-9]{40})\/(\d+)/.exec(html);
  if (!match) {
    throw new Error(
      `Verse series ${slug} did not expose an Ethereum edition link. ` +
        'Paste a specific Verse item URL or raw `ethereum:{contract}:{tokenId}` coordinates.'
    );
  }

  return {
    chain: 'ethereum',
    contract: match[1].toLowerCase(),
    tokenId: match[2],
  };
}
