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
 * nothing else: `source`, `duration`, `id`, and `display` are the curator's
 * decisions and are left exactly as found, even when the indexer disagrees. An
 * item the indexer cannot resolve is reported, never guessed at — a fabricated
 * artist line in a signed document is worse than a missing one.
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

export interface Dp1Manifest {
  metadata?: { title?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Dp1Item {
  id?: string;
  title?: string;
  source?: string;
  duration?: number;
  provenance?: Dp1Provenance;
  inlineManifest?: Dp1Manifest;
  /** URI of an externally hosted Ref Manifest. Outranks inlineManifest. */
  ref?: string;
  refHash?: string;
  [key: string]: unknown;
}

export interface Dp1Playlist {
  items?: Dp1Item[];
  /** DP-1 v1.1.0 multi-signature envelope. */
  signatures?: unknown;
  /** Legacy flat signature, still read by verify and sign in this repo. */
  signature?: unknown;
  [key: string]: unknown;
}

/** TokenCoordinate is the lookup key shape `getNFTTokenInfoBatch` expects. */
export interface TokenCoordinate {
  chain: string;
  contractAddress: string;
  tokenId: string;
}

/**
 * IndexerItem is one entry of what `getNFTTokenInfoBatch` returns: a DP-1 item
 * carrying `provenance` and, when the indexer had enough to build one, an
 * `inlineManifest`.
 *
 * Critically, the returned array is NOT positionally aligned with the input.
 * `getNFTTokenInfoBatch` ends with
 * `results.filter((r) => r.success && r.item).map((r) => r.item)`, so a token
 * the indexer cannot resolve is dropped rather than represented. Two tokens in,
 * one item out, and nothing in the payload says which request it answers except
 * its own provenance. Correlating by array position would attach one artwork's
 * artist and thumbnail to a different artwork — silently, inside a document
 * that then gets signed. Everything below correlates by coordinate instead.
 */
export interface IndexerItem {
  provenance?: Dp1Provenance;
  inlineManifest?: Dp1Manifest;
  [key: string]: unknown;
}

/**
 * TokenLookup resolves coordinates to indexer items. The result may be shorter
 * than the input and in any order. Injected rather than imported so tests
 * exercise the mapping without a network call; the CLI passes an adapter over
 * `getNFTTokenInfoBatch`.
 */
export type TokenLookup = (
  tokens: TokenCoordinate[],
  onProgress?: (done: number, total: number) => void
) => Promise<IndexerItem[]>;

/** SkipReason explains, per item, why enrichment did not write a manifest. */
export type SkipReason = 'already-labelled' | 'external-ref' | 'no-provenance' | 'not-indexed';

export interface SkippedItem {
  index: number;
  title: string;
  reason: SkipReason;
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
 * CHAIN_ALIASES translates a DP-1 chain name into the indexer's, outbound.
 *
 * DP-1 names the EVM family `evm` (core spec §6: "evm" | "tezos" | "bitmark" |
 * "other"), because the protocol describes a class of chains. The FF indexer
 * names the same thing `ethereum`, because it queries a specific one. Without
 * this every EVM item comes back unresolved, and the failure looks like a
 * missing artwork rather than a vocabulary mismatch.
 *
 * Unlisted values pass through so the indexer, not this table, decides what it
 * supports.
 */
const CHAIN_ALIASES: Record<string, string> = {
  evm: 'ethereum',
};

/**
 * canonicalChain collapses both vocabularies onto one name so a coordinate
 * sent to the indexer and a coordinate read back off its response compare
 * equal. The direction is deliberately the reverse of CHAIN_ALIASES: this one
 * is for matching, that one is for querying.
 */
function canonicalChain(chain: string): string {
  const lower = chain.trim().toLowerCase();
  return lower === 'ethereum' ? 'evm' : lower;
}

/**
 * coordinateKeyOf builds the correlation key for a provenance block, or null
 * when the block cannot identify a single work.
 *
 * The address is lowercased because the indexer echoes it checksummed while
 * callers typically write it lowercase, and the two must still match.
 */
function coordinateKeyOf(provenance: Dp1Provenance | undefined): string | null {
  const contract = provenance?.contract;
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
  return `${canonicalChain(chain)}:${address.trim().toLowerCase()}:${token}`;
}

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
 * manifestFor returns the manifest to write onto an item, or undefined when
 * the indexer resolved the token without building one.
 *
 * The curator's own title wins. `item.title` survives enrichment untouched,
 * but the tombstone reads the manifest first, so attaching an indexer title
 * that disagrees would change the displayed label while appearing to preserve
 * it — the indexer writes "Pre-Process #0" where a curator wrote
 * "Pre-Process". Everything else in the manifest (artist, description,
 * thumbnails) is what enrichment exists to fetch and is taken as given.
 */
function manifestFor(item: Dp1Item, resolved: IndexerItem): Dp1Manifest | undefined {
  const manifest = resolved.inlineManifest;
  if (!manifest) {
    return undefined;
  }
  const curatorTitle = typeof item.title === 'string' ? item.title.trim() : '';
  if (curatorTitle.length === 0) {
    return manifest;
  }
  return {
    ...manifest,
    metadata: { ...(manifest.metadata ?? {}), title: curatorTitle },
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
 * Signatures are dropped when anything changed, in both the DP-1 v1.1.0
 * `signatures[]` form and the legacy flat `signature` this repo still verifies.
 * A signature covers the document bytes, and an enriched document is a
 * different document; leaving a stale envelope in place would produce a file
 * that fails verification at the device with no explanation of why.
 */
export async function enrichPlaylistManifests(
  playlist: Dp1Playlist,
  lookup: TokenLookup,
  options: EnrichOptions = {}
): Promise<EnrichOutcome> {
  const items = Array.isArray(playlist.items) ? playlist.items : [];
  const skipped: SkippedItem[] = [];
  const pending: { index: number; key: string }[] = [];
  // One lookup per distinct artwork, not per item. getNFTTokenInfoBatch runs a
  // lookup for each token it is handed, and a token the indexer has not seen
  // triggers an indexing job and a poll that can take minutes. A playlist that
  // deliberately repeats a work — the same piece at two points in a loop —
  // would otherwise submit that job once per appearance.
  const coordinates = new Map<string, TokenCoordinate>();

  items.forEach((item, index) => {
    // An item with a `ref` is already labelled, by a manifest this command
    // cannot see. Ref outranks inlineManifest in the resolution order, so
    // enriching one writes a manifest the device will ignore while still
    // invalidating the signature: damage with no visible change.
    //
    // --force does not override this. Making the inline manifest win would
    // mean deleting the curator's `ref` and `refHash`, which is a different
    // and larger decision than filling in missing metadata — and one that
    // silently discards the integrity hash the remote manifest is checked
    // against. If that conversion is ever wanted it should be its own flag,
    // named for what it does.
    if (typeof item.ref === 'string' && item.ref.trim().length > 0) {
      skipped.push({ index, title: describeItem(item, index), reason: 'external-ref' });
      return;
    }
    if (item.inlineManifest && !options.force) {
      skipped.push({ index, title: describeItem(item, index), reason: 'already-labelled' });
      return;
    }
    const coordinate = coordinateFor(item);
    const key = coordinateKeyOf(item.provenance);
    if (!coordinate || !key) {
      skipped.push({ index, title: describeItem(item, index), reason: 'no-provenance' });
      return;
    }
    pending.push({ index, key });
    if (!coordinates.has(key)) {
      coordinates.set(key, coordinate);
    }
  });

  if (pending.length === 0) {
    return { playlist, enriched: 0, skipped, signatureInvalidated: false };
  }

  const resolved = await lookup([...coordinates.values()], options.onProgress);

  // Index what came back by its own coordinate. A response carrying no usable
  // provenance cannot be attributed to any request, so it is dropped rather
  // than guessed at; the affected item then reports as not-indexed, which is
  // exactly what happened.
  const byCoordinate = new Map<string, IndexerItem>();
  for (const entry of resolved) {
    const key = coordinateKeyOf(entry.provenance);
    if (key && !byCoordinate.has(key)) {
      byCoordinate.set(key, entry);
    }
  }

  let enriched = 0;
  for (const entry of pending) {
    const item = items[entry.index];
    const match = byCoordinate.get(entry.key);
    const manifest = match ? manifestFor(item, match) : undefined;
    if (!manifest) {
      skipped.push({
        index: entry.index,
        title: describeItem(item, entry.index),
        reason: 'not-indexed',
      });
      continue;
    }
    item.inlineManifest = manifest;
    enriched += 1;
  }

  const hadSignature = playlist.signatures !== undefined || playlist.signature !== undefined;
  const signatureInvalidated = enriched > 0 && hadSignature;
  if (signatureInvalidated) {
    delete playlist.signatures;
    delete playlist.signature;
    logger.debug('[Enrich] Dropped signatures: the enriched document must be re-signed.');
  }

  skipped.sort((a, b) => a.index - b.index);
  return { playlist, enriched, skipped, signatureInvalidated };
}
