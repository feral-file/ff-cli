/**
 * Token source factory: the one place that decides which vendor answers.
 *
 * Commands call getTokenSource() and see only the TokenSource contract.
 * The Feral File indexer (ff-indexer-v2) is the default. Raster is opt-in with
 * `tokenSource: "raster"` (or FF_TOKEN_SOURCE=raster) while it is evaluated:
 * its data still has open bugs (feral-file#3546), so it is not the default
 * until they are fixed (owner decision, 2026-10-22). There is no fallback
 * between providers: one vendor answers a whole run (feral-file#3576).
 */

import { getTokenSourceConfig } from '../config';
import type { TokenSourceConfig } from '../types';
import { createIndexerTokenSource } from './token-source-indexer';
import { createRasterTokenSource } from './token-source-raster';
import type { TokenSource } from './token-source-contract';

export * from './token-source-contract';

/**
 * createTokenSource builds the provider a configuration selects.
 *
 * @param config - Resolved token source configuration
 * @returns The selected provider
 */
export function createTokenSource(config: TokenSourceConfig): TokenSource {
  if (config.source === 'raster') {
    return createRasterTokenSource(config.ipfsGateways);
  }
  return createIndexerTokenSource();
}

/** getTokenSource builds the provider from the current configuration. */
export function getTokenSource(): TokenSource {
  return createTokenSource(getTokenSourceConfig());
}
