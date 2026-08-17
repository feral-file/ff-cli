/**
 * Inline Ref Manifest construction for DP-1 playlist items.
 *
 * DP-1 Playlist Extension §3.6 lets an item carry a complete Ref Manifest
 * inline instead of behind a `ref` URL. That matters here because ff-cli has
 * nowhere to host a manifest document: it emits a playlist file and hands it
 * to an FF1 device. Before dp1-js 2.3.0 there was no item-level home for the
 * artwork description, artist, or still image the indexer already returns, so
 * `nft-indexer.js` discarded all three. Inline manifests give them a home.
 *
 * This module is a leaf on purpose: it imports only `dp1-js` and the logger,
 * never another `src/utilities/` module. `nft-indexer.js` already requires
 * `playlist-builder.js`, so putting this logic in either of them would make
 * the require graph a question that has to be re-answered on every edit.
 *
 * Integrity note: an inline manifest is covered by the playlist signature, so
 * unlike a ref-fetched manifest it carries no `refHash`. Everything written
 * here therefore ends up inside a signed document — which is why the mapping
 * below refuses to synthesize fields the CLI cannot actually substantiate.
 */

import { createHash } from 'node:crypto';
import { MetadataBuilder, RefManifestBuilder, type RefManifest } from 'dp1-js';
import * as logger from '../logger';

/**
 * TokenLike is the structural intersection of the two internal token shapes in
 * this repo. `nft-indexer.mapIndexerDataToStandardFormat` always produces the
 * object form of `image`, but `playlist-builder.convertTokenToDP1ItemSingle`
 * accepts caller-supplied tokens and defensively handles `image` as a bare
 * string. Both must work here so the two factories can share this helper
 * verbatim.
 */
export interface TokenLike {
  chain?: string;
  contractAddress?: string;
  tokenId?: string | number;
  name?: string;
  description?: string;
  metadata?: { artistName?: string };
  image?: string | { url?: string; thumbnail?: string; mimeType?: string };
}

export interface InlineManifestOptions {
  /** The item's resolved `source` URL, used to reject a redundant thumbnail. */
  sourceUrl?: string;
  /** RFC 3339 creation timestamp. Defaults to the per-process value below. */
  created?: string;
}

/**
 * DP-1 version this CLI emits. RefManifestBuilder falls back to "0.1.0" when
 * `refVersion` is unset, which would contradict the `dpVersion: 1.1.0`
 * envelope playlist-builder.js builds around these items.
 */
const REF_VERSION = '1.1.0';

/**
 * The Feral File indexer exposes no language tag on `display`, and the schema
 * requires a locale. Every string we map comes from that one untagged source,
 * so "en" is an assumption, not an observation. If the indexer ever returns a
 * language, thread it through rather than widening this constant.
 */
const DEFAULT_LOCALE = 'en';

/**
 * One CLI invocation stamps one manifest timestamp.
 *
 * Freezing at module load keeps a 500-token `build` from writing 500 different
 * clocks across items of the same playlist, and keeps two runs byte-diffable
 * except for this single value. The playlist envelope's own `created` already
 * varies the same way (playlist-builder.js pins it only under the test-only
 * deterministicMode). This assumes a short-lived process: do not reuse this
 * module from a daemon without threading `created` in explicitly.
 */
const MANIFEST_CREATED_AT = new Date().toISOString();

/** Namespace prefix keeping manifest ids from aliasing PlaylistItem ids. */
const ID_NAMESPACE = 'dp1:ref-manifest:v1';

/** uuidFromSeed formats a sha256 digest UUID-style, mirroring nft-indexer.js. */
function uuidFromSeed(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

/** text trims a possibly-absent value down to a non-empty string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * resolveStillUri picks the still image that belongs in `metadata.thumbnails`.
 *
 * Returns an empty string unless the candidate is genuinely additional
 * information. Three rejections, each for a distinct reason:
 *
 *   - equal to `sourceUrl`: for a static token `image.url` IS the source
 *     (see getBestMediaUrl in nft-indexer.js), so a thumbnail identical to it
 *     is pure duplication inside a signed payload;
 *   - `data:`: both item factories already refuse data-URI sources, and
 *     inlining base64 into every playlist would dwarf the playlist itself;
 *   - anything not http(s): `Thumbnail.uri` carries `format: "uri"`, and an
 *     `ipfs://` value is not resolvable by the FF1 display path today.
 */
function resolveStillUri(token: TokenLike, sourceUrl: string): string {
  const image = token.image;
  const candidate =
    typeof image === 'string' ? text(image) : text(image?.thumbnail) || text(image?.url);

  if (!candidate || candidate === sourceUrl) {
    return '';
  }
  if (!candidate.startsWith('http://') && !candidate.startsWith('https://')) {
    return '';
  }
  return candidate;
}

/**
 * buildInlineManifestForToken builds the Ref Manifest for one playlist item,
 * or returns undefined when the token carries nothing worth carrying.
 *
 * Emission threshold: at least one of description, artists, or thumbnails must
 * survive normalization. `title` deliberately does NOT count — it is already a
 * first-class PlaylistItem field, so a title-only manifest adds payload to
 * every FF1 transfer and every signed envelope while telling a consumer
 * nothing new. The threshold is expressed here, once, so the item factories
 * stay a two-line call and cannot drift apart.
 *
 * Deliberately not mapped, each for a reason that should survive future edits:
 *   - `creditLine`: the schema calls it copyright and credit information. The
 *     CLI has no such string; deriving one from `token.owner` would assert a
 *     rights claim it has no basis for, inside a signed document.
 *   - `tags`: `metadata.attributes` is hard-coded to [] upstream, and NFT
 *     traits are key/value pairs — flattening them yields garbage like
 *     ["Blue", "Hat"].
 *   - `collection`: no Metadata field accepts it, and upstream computes its
 *     name by splitting the token name on '#' — string surgery, not identity.
 *   - `owner`: not the artist, not credit, and stale the moment the token
 *     trades.
 *   - `controls`: display preferences already live on `item.display`, written
 *     from the DP-1 §4.1 timing heuristics. Duplicating them here would create
 *     two sources of truth with no rule for which wins.
 *   - `i18n`: no localized strings exist anywhere in this pipeline.
 *
 * Never throws. A manifest is decoration; nft-indexer.js turns a builder throw
 * into `{ success: false }`, which the build pipeline counts as a dropped
 * token — so a malformed thumbnail must not silently shorten a user's
 * playlist.
 *
 * @param token - Token in the internal standard format
 * @param opts - Resolved item source URL, and an optional created override
 * @returns A schema-valid RefManifest, or undefined when below the threshold
 */
export function buildInlineManifestForToken(
  token: TokenLike | null | undefined,
  opts: InlineManifestOptions = {}
): RefManifest | undefined {
  if (!token || typeof token !== 'object') {
    return undefined;
  }

  const sourceUrl = text(opts.sourceUrl);
  const title = text(token.name);
  const description = text(token.description);
  const artistName = text(token.metadata?.artistName);
  const stillUri = resolveStillUri(token, sourceUrl);

  if (!description && !artistName && !stillUri) {
    return undefined;
  }

  try {
    const metadata = new MetadataBuilder();
    if (title) {
      metadata.title(title);
    }
    if (description) {
      metadata.description(description);
    }
    if (artistName) {
      metadata.addArtist({ name: artistName });
    }
    if (stillUri) {
      // A plain literal, not ThumbnailBuilder: `w`/`h` became optional in
      // dp1-js 2.3.0 and we never know the intrinsic pixel dimensions, so the
      // emitted shape must be exactly { uri } with no undefined-valued keys.
      metadata.addThumbnail('default', { uri: stillUri });
    }

    return new RefManifestBuilder()
      .refVersion(REF_VERSION)
      .id(manifestId(token, sourceUrl))
      .created(opts.created ?? MANIFEST_CREATED_AT)
      .locale(DEFAULT_LOCALE)
      .metadata(metadata)
      .build();
  } catch (error) {
    logger.debug('[Ref Manifest] Skipping inline manifest:', {
      contractAddress: token.contractAddress,
      tokenId: token.tokenId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * manifestId derives a stable id from token coordinates.
 *
 * The manifest describes the artwork, not one playlist entry, so the id must
 * be identical across runs and across playlists — it is a cache key. The
 * namespace prefix is load-bearing: nft-indexer.js derives the PlaylistItem id
 * from the bare `${contract}-${tokenId}` string, and a consumer keying a
 * manifest cache must never alias a playlist-item cache.
 */
function manifestId(token: TokenLike, sourceUrl: string): string {
  const contract = text(token.contractAddress);
  const tokenId = text(String(token.tokenId ?? ''));
  if (contract && tokenId) {
    return uuidFromSeed(`${ID_NAMESPACE}:${text(token.chain)}:${contract}:${tokenId}`);
  }
  // Off-indexer tokens (caller-supplied objects) have no coordinates; the
  // source URL is the only stable identity available.
  return uuidFromSeed(`${ID_NAMESPACE}:src:${sourceUrl}`);
}
