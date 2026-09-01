/**
 * Fills in missing inline Ref Manifests on an existing DP-1 playlist.
 *
 * `find` and `build` attach an `inlineManifest` to every item they create, so
 * playlists this CLI authors end to end are already labelled. Playlists that
 * arrive any other way are not: items copied out of another playlist, items
 * hand-written against a known contract, items inherited from a document
 * predating §3.6. Those carry a `source` and a `provenance` block and nothing
 * else, and there was no way to repair them short of editing JSON by hand.
 *
 * What the gap costs is visible on a device. The FF1 tombstone resolves its
 * label through `ref` -> `inlineManifest` -> `item.metadata` and falls back to
 * the item title, so an unlabelled item shows a title with no artist line. The
 * app's grid is worse: it can rasterize a thumbnail from a direct image, video,
 * or SVG source, but not from a live HTML work, so every generative item in an
 * unlabelled playlist renders as an empty tile. A playlist of computational art
 * is mostly live HTML, which is exactly the case that looks broken.
 *
 * Enrichment is additive and narrow on purpose. It writes `inlineManifest` and
 * nothing else: `source`, `duration`, `title`, `id`, and `display` are the
 * curator's decisions and are left exactly as found, even when the indexer
 * disagrees. An item the indexer cannot resolve is reported, never guessed at
 * — a fabricated artist line in a signed document is worse than a missing one.
 */

import * as logger from '../logger';

/**
 * Dp1Provenance is the on-chain coordinate block DP-1 items carry. Enrichment
 * is keyed on it because it is the only field that identifies *which* artwork
 * an item is; a `source` URL is a rendition, and many renditions share one.
 */
export interface Dp1Provenance {
  type?: string;
  contract?: {
    chain?: string;
    address?: string;
    tokenId?: string | number;
  };
}

export interface Dp1Item {
  id?: string;
  title?: string;
  source?: string;
  duration?: number;
  provenance?: Dp1Provenance;
  inlineManifest?: unknown;
  [key: string]: unknown;
}

export interface Dp1Playlist {
  items?: Dp1Item[];
  signatures?: unknown;
  [key: string]: unknown;
}

/** TokenCoordinate is the lookup key shape `getNFTTokenInfoBatch` expects. */
export interface TokenCoordinate {
  chain: string;
  contractAddress: string;
  tokenId: string;
}

/**
 * IndexerResult is one entry of `getNFTTokenInfoBatch`'s result array, and its
 * shape is heterogeneous: a resolved token comes back as the DP-1 item itself
 * (carrying `inlineManifest`), while a failed one comes back as a marker object
 * `{ success: false, error, token }`. There is no wrapper around the success
 * case, so `result.item` does not exist — reading it yields undefined for every
 * token and enrichment silently reports the whole playlist as unindexed.
 */
export type IndexerResult =
  | ({ inlineManifest?: unknown } & Record<string, unknown>)
  | ({ success: false; error?: string } & Record<string, unknown>);

/**
 * TokenLookup resolves coordinates to indexer results, positionally aligned
 * with its input. Injected rather than imported so tests exercise the mapping
 * without a network call; the CLI passes `getNFTTokenInfoBatch`.
 */
export type TokenLookup = (
  tokens: TokenCoordinate[],
  onProgress?: (done: number, total: number) => void
) => Promise<IndexerResult[]>;

/** SkipReason explains, per item, why enrichment did not write a manifest. */
export type SkipReason = 'already-labelled' | 'no-provenance' | 'not-indexed';

export interface SkippedItem {
  index: number;
  title: string;
  reason: SkipReason;
  detail?: string;
}

export interface EnrichOutcome {
  playlist: Dp1Playlist;
  enriched: number;
  skipped: SkippedItem[];
  /** True when the document changed and any prior signature is now void. */
  signatureInvalidated: boolean;
}

export interface EnrichOptions {
  /** Rewrite manifests that already exist. Off by default: a hand-authored
   *  manifest may carry curator intent the indexer does not know about. */
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * manifestFrom pulls the inline manifest out of one batch entry, tolerating
 * both shapes described on IndexerResult. Returns undefined for a failure
 * marker or an item the indexer resolved without a manifest.
 */
function manifestFrom(result: IndexerResult | undefined): unknown {
  if (!result || typeof result !== 'object') {
    return undefined;
  }
  if ((result as { success?: boolean }).success === false) {
    return undefined;
  }
  return (result as { inlineManifest?: unknown }).inlineManifest;
}

/**
 * errorFrom reads the failure text a marker object carries, when it has one.
 */
function errorFrom(result: IndexerResult | undefined): string | undefined {
  const error = (result as { error?: unknown } | undefined)?.error;
  return typeof error === 'string' ? error : undefined;
}

/**
 * CHAIN_ALIASES bridges two vocabularies that do not agree.
 *
 * DP-1 names the EVM family `evm` (core spec §6: "evm" | "tezos" | "bitmark" |
 * "other"), because the protocol describes a class of chains. The FF indexer
 * names the same thing `ethereum`, because it queries a specific one. Reading
 * provenance written by the spec and handing it to the indexer therefore needs
 * a translation, and without it every EVM item comes back "not indexed" — the
 * failure looks like a missing artwork rather than a vocabulary mismatch.
 *
 * Unlisted values pass through untranslated so the indexer, not this table,
 * decides what it supports. Extend this only when the indexer adds a chain
 * whose DP-1 name differs.
 */
const CHAIN_ALIASES: Record<string, string> = {
  evm: 'ethereum',
};

/**
 * describeItem names an item for operator output, preferring its title.
 */
function describeItem(item: Dp1Item, index: number): string {
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  return title.length > 0 ? title : `item ${index + 1}`;
}

/**
 * coordinateFor extracts a lookup key from an item, or null when the item
 * carries no usable on-chain coordinate.
 *
 * All three parts are required. A contract with no token id identifies a
 * collection rather than a work, and resolving that would attach some other
 * item's manifest to this one.
 */
function coordinateFor(item: Dp1Item): TokenCoordinate | null {
  const contract = item.provenance?.contract;
  if (!contract) {
    return null;
  }
  const { chain, address, tokenId } = contract;
  if (!chain || !address || tokenId === undefined || tokenId === null) {
    return null;
  }
  const token = String(tokenId).trim();
  if (token.length === 0) {
    return null;
  }
  const normalized = chain.trim().toLowerCase();
  return {
    chain: CHAIN_ALIASES[normalized] ?? normalized,
    contractAddress: address,
    tokenId: token,
  };
}

/**
 * enrichPlaylistManifests attaches an inline Ref Manifest to every item that
 * lacks one and can be resolved on chain.
 *
 * The playlist is mutated in place and returned; callers that need the
 * original should read it twice. Items are looked up in one batch so the
 * indexer sees a single burst rather than a request per item — warming
 * previously-unseen tokens is the slow path, and it parallelizes internally.
 *
 * Signatures are dropped when anything changed. A DP-1 signature covers the
 * document bytes, and an enriched document is a different document; leaving a
 * stale envelope in place would produce a file that fails verification at the
 * device with no explanation of why.
 */
export async function enrichPlaylistManifests(
  playlist: Dp1Playlist,
  lookup: TokenLookup,
  options: EnrichOptions = {}
): Promise<EnrichOutcome> {
  const items = Array.isArray(playlist.items) ? playlist.items : [];
  const skipped: SkippedItem[] = [];
  const pending: { index: number; coordinate: TokenCoordinate }[] = [];

  items.forEach((item, index) => {
    if (item.inlineManifest && !options.force) {
      skipped.push({ index, title: describeItem(item, index), reason: 'already-labelled' });
      return;
    }
    const coordinate = coordinateFor(item);
    if (!coordinate) {
      skipped.push({ index, title: describeItem(item, index), reason: 'no-provenance' });
      return;
    }
    pending.push({ index, coordinate });
  });

  if (pending.length === 0) {
    return { playlist, enriched: 0, skipped, signatureInvalidated: false };
  }

  const results = await lookup(
    pending.map((entry) => entry.coordinate),
    options.onProgress
  );

  let enriched = 0;
  pending.forEach((entry, position) => {
    const result = results[position];
    const manifest = manifestFrom(result);
    const item = items[entry.index];
    if (!manifest) {
      skipped.push({
        index: entry.index,
        title: describeItem(item, entry.index),
        reason: 'not-indexed',
        detail: errorFrom(result),
      });
      return;
    }
    item.inlineManifest = manifest;
    enriched += 1;
  });

  const signatureInvalidated = enriched > 0 && playlist.signatures !== undefined;
  if (signatureInvalidated) {
    delete playlist.signatures;
    logger.debug('[Enrich] Dropped signatures: the enriched document must be re-signed.');
  }

  skipped.sort((a, b) => a.index - b.index);
  return { playlist, enriched, skipped, signatureInvalidated };
}
