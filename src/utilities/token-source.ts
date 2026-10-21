/**
 * Token source factory: the one place that decides which vendor answers.
 *
 * Commands call getTokenSource() and see only the TokenSource contract.
 * Raster is the default; `tokenSource: "indexer"` (or FF_TOKEN_SOURCE=indexer)
 * selects the deprecated ff-indexer-v2 adapter and prints a warning, so
 * nobody stays on the old vendor without knowing it. There is no fallback
 * between providers (owner decision, feral-file#3576).
 */

import chalk from 'chalk';
import { getTokenSourceConfig } from '../config';
import type { TokenSourceConfig } from '../types';
import { createIndexerTokenSource } from './token-source-indexer';
import { createRasterTokenSource } from './token-source-raster';
import type { TokenSource } from './token-source-contract';

export * from './token-source-contract';

/**
 * INDEXER_DEPRECATION_WARNING is printed when the deprecated vendor is chosen.
 * It goes through console.warn because logger.warn only prints under --verbose.
 */
export const INDEXER_DEPRECATION_WARNING =
  'Warning: tokenSource "indexer" is deprecated and will be removed; Raster is the default. ' +
  'Remove tokenSource from config.json or unset FF_TOKEN_SOURCE.';

let warnedThisProcess = false;

/**
 * createTokenSource builds the provider a configuration selects.
 *
 * @param config - Resolved token source configuration
 * @param deps.warn - Receives the deprecation line; injected for tests
 */
export function createTokenSource(
  config: TokenSourceConfig,
  deps: { warn?: (line: string) => void } = {}
): TokenSource {
  if (config.source === 'indexer') {
    (deps.warn ?? defaultWarn)(INDEXER_DEPRECATION_WARNING);
    return createIndexerTokenSource();
  }
  return createRasterTokenSource(config.ipfsGateways);
}

/** defaultWarn prints the deprecation line once per process. */
function defaultWarn(line: string): void {
  if (warnedThisProcess) {
    return;
  }
  warnedThisProcess = true;
  console.warn(chalk.yellow(line));
}

/** getTokenSource builds the provider from the current configuration. */
export function getTokenSource(): TokenSource {
  return createTokenSource(getTokenSourceConfig());
}
