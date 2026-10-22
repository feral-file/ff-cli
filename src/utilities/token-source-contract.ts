/**
 * Token source contract: the vendor-neutral seam between commands and the
 * services that answer "which token is this, and what does it display".
 *
 * Commands (`find`, `build`, `enrich`) depend on this contract only. Each
 * vendor is one provider module that implements it: token-source-indexer.ts
 * (the default) and token-source-raster.ts (opt-in, feral-file#3576).
 * A future art-catalog-service adapter would be a third provider, and nothing
 * outside token-source.ts would change.
 *
 * Kept free of provider imports so providers can import it without a cycle;
 * the factory that chooses a provider lives in token-source.ts.
 */

import type { TokenSourceName } from '../types';

export type { TokenSourceName };

/** TokenCoordinate is a token to look up, in the client chain vocabulary. */
export interface TokenCoordinate {
  chain: string;
  contractAddress: string;
  tokenId: string;
  /**
   * The token standard the caller asserts, when it does (a DP-1 playlist
   * carries it in `provenance.contract.standard`). Providers prefer their own
   * row's standard and fall back to this before guessing from the address.
   */
  standard?: string;
}

/**
 * ResolvedToken is the outcome for one coordinate.
 *
 * Results are always one per input, in input order, so a caller can tell
 * which request a failure belongs to. `still` is the token's still image as
 * the provider names it, carried beside the item because the item drops it
 * whenever it equals the source (enrich needs it against a different source).
 */
export type ResolvedToken = ResolvedSuccess | ResolvedFailure;

/** ResolvedSuccess carries the built DP-1 item. */
export interface ResolvedSuccess {
  success: true;
  coordinate: TokenCoordinate;
  item: Record<string, unknown>;
  still: string;
}

/** ResolvedFailure carries the reason, in terms a user can act on. */
export interface ResolvedFailure {
  success: false;
  coordinate: TokenCoordinate;
  error: string;
}

/**
 * isResolved narrows a result. This repo compiles without strictNullChecks,
 * under which TypeScript does not narrow a union on a boolean discriminant,
 * so callers use these guards instead of `if (result.success)`.
 */
export function isResolved(result: ResolvedToken): result is ResolvedSuccess {
  return result.success === true;
}

/** isFailed is the complement of isResolved. */
export function isFailed(result: ResolvedToken): result is ResolvedFailure {
  return result.success === false;
}

/** ResolveOptions tune item construction and progress reporting. */
export interface ResolveOptions {
  /** Explicit display seconds; omit for DP-1 §4.1 auto timing. */
  duration?: number;
  /** Called with (done, total) as batches finish. Errors thrown here are ignored. */
  onProgress?: (done: number, total: number) => void;
}

/** ListOptions bound a listing. `'all'` walks to the end. */
export interface ListOptions {
  limit: number | 'all';
  duration?: number;
}

/** TokenListing is a listing's results plus tokens dropped for an unsupported chain. */
export interface TokenListing {
  results: ResolvedToken[];
  skippedUnsupported: number;
}

/** TokenSource is what every provider implements. */
export interface TokenSource {
  readonly name: TokenSourceName;
  /** Coordinates to DP-1 items. Never throws per token; failures are results. */
  resolveTokens(coords: TokenCoordinate[], opts?: ResolveOptions): Promise<ResolvedToken[]>;
  /** Tokens held by an address. Throws when the listing itself fails. */
  listTokensByOwner(address: string, opts: ListOptions): Promise<TokenListing>;
  /**
   * Tokens minted by a contract. Throws TokenSourceCapabilityError when the
   * provider cannot list contracts (Raster has no such query).
   */
  listTokensByContract(address: string, opts: ListOptions): Promise<TokenListing>;
}

/**
 * TokenSourceCapabilityError means the active provider cannot answer this
 * kind of request at all. It is deliberately not retried against another
 * provider: one vendor answers a whole run (owner decision, feral-file#3576).
 */
export class TokenSourceCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenSourceCapabilityError';
  }
}

/** RASTER_CANNOT_LIST_CONTRACT is the user-facing reason contract listing fails on Raster. */
export const RASTER_CANNOT_LIST_CONTRACT =
  'Raster cannot list a contract. Give tokenIds, an owner address, or run find on the series URL.';

/** itemsOf keeps the items of the successful results, in order. */
export function itemsOf(results: ResolvedToken[]): Record<string, unknown>[] {
  return results.filter(isResolved).map((result) => result.item);
}

/** failureMessages returns each distinct failure reason once, for a summary line. */
export function failureMessages(results: ResolvedToken[]): string[] {
  const messages = results.filter(isFailed).map((result) => result.error);
  return [...new Set(messages)];
}
