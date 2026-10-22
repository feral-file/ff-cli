/**
 * Media URL fix-ups for token sources whose URLs the FF1 cannot load as given.
 *
 * Raster stores token metadata as a snapshot. Two consequences matter for
 * playback, both measured on feral-file#3546 (2026-10-20):
 *   - most Feral File works carry a bare `ipfs://` CID, which no browser or
 *     FF1 resolves without a gateway;
 *   - works whose metadata predates Feral File's CDN move still point at
 *     `cdn.feralfileassets.com`, a host that no longer resolves. The same
 *     paths are served by `cdn.artworks.feralfile.io`.
 *   - some Feral File works carry an https URL on `ipfs.bitmark.com`, Feral
 *     File's legacy gateway, instead of a bare CID. The owner asked for those
 *     to go through the Feral File gateway like every other Feral File CID
 *     (2026-10-22), so one gateway setting governs all Feral File media.
 *
 * The rewrite is applied here rather than asked of Raster because it is the
 * one fix ff-cli can make alone. Remove a DEAD_HOST_REWRITES entry only once
 * Raster re-reads `tokenURI` for the affected contracts (ask 2 on #3546).
 */

/** IpfsGateways are the resolved, `/ipfs/`-terminated gateway prefixes. */
export interface IpfsGateways {
  feralFile: string;
  default: string;
}

/**
 * FERAL_FILE_PLATFORM_ID is Raster's `artwork.platform.id` for Feral File.
 * Feral File works use Feral File's own gateway, which pins them.
 */
export const FERAL_FILE_PLATFORM_ID = 'feralfile';

/** DEAD_HOST_REWRITES maps retired asset hosts to the hosts serving the same paths. */
export const DEAD_HOST_REWRITES: Readonly<Record<string, string>> = {
  'cdn.feralfileassets.com': 'cdn.artworks.feralfile.io',
};

/**
 * LEGACY_FERAL_FILE_GATEWAYS are retired Feral File-operated IPFS gateway
 * hosts. A `/ipfs/<cid>` URL on one is re-pointed at the configured Feral
 * File gateway whatever the platform id says, because the host itself proves
 * the CID is Feral File media. A URL without an `/ipfs/` path is left alone.
 */
export const LEGACY_FERAL_FILE_GATEWAYS: ReadonlySet<string> = new Set(['ipfs.bitmark.com']);

/**
 * legacyGatewayToFeralFile returns the URL re-pointed at the Feral File
 * gateway, or null when the URL is not a `/ipfs/` path on a legacy host.
 * An empty query (`?` with nothing after it, as Raster emits) is dropped.
 */
function legacyGatewayToFeralFile(parsed: URL, gateways: IpfsGateways): string | null {
  if (!LEGACY_FERAL_FILE_GATEWAYS.has(parsed.hostname.toLowerCase())) {
    return null;
  }
  const match = /^\/ipfs\/(.+)$/i.exec(parsed.pathname);
  if (!match) {
    return null;
  }
  return `${gateways.feralFile}${match[1]}${parsed.search}${parsed.hash}`;
}

/**
 * ipfsToGateway turns `ipfs://<cid>[/path]` into a gateway URL, or '' when the
 * URI names no CID. An `ipfs://ipfs/<cid>` form appears in the wild and is
 * treated the same way the source-resolver package treats it.
 */
function ipfsToGateway(uri: string, platformId: string | null, gateways: IpfsGateways): string {
  const path = uri
    .slice('ipfs://'.length)
    .replace(/^ipfs\//i, '')
    .replace(/^\/+/, '');
  if (!path) {
    return '';
  }
  const gateway = platformId === FERAL_FILE_PLATFORM_ID ? gateways.feralFile : gateways.default;
  return `${gateway}${path}`;
}

/**
 * fixUpMediaUrl returns a URL the FF1 display path can load, or ''.
 *
 * Order: map `ipfs://` through the platform's gateway, then move a legacy
 * Feral File gateway URL onto the Feral File gateway, then swap a retired
 * host for its replacement. Data URIs pass through unchanged so
 * convertToDP1Item can report them as data URIs instead of as missing media.
 * Any other non-HTTP(S) scheme becomes '' because nothing downstream can load
 * it, and an empty source is reported as "No source URL available".
 *
 * @param url - Source URL from the token source
 * @param platformId - Raster `artwork.platform.id`, or null when unknown
 * @param gateways - Resolved IPFS gateways from config
 * @returns Loadable URL, the data URI unchanged, or ''
 */
export function fixUpMediaUrl(
  url: string | null | undefined,
  platformId: string | null,
  gateways: IpfsGateways
): string {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed || trimmed.startsWith('data:')) {
    return trimmed;
  }
  const candidate = /^ipfs:\/\//i.test(trimmed)
    ? ipfsToGateway(trimmed, platformId, gateways)
    : trimmed;
  if (!candidate) {
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return '';
  }
  const regatewayed = legacyGatewayToFeralFile(parsed, gateways);
  if (regatewayed) {
    return regatewayed;
  }
  const replacement = DEAD_HOST_REWRITES[parsed.hostname.toLowerCase()];
  if (replacement) {
    parsed.hostname = replacement;
    return parsed.toString();
  }
  return candidate;
}
