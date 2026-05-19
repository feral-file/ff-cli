/**
 * fxhash marketplace resolver.
 *
 * fxhash's UI exposes individual iterations under `/iteration/{slug}` where
 * the slug (e.g. `garden-monoliths-215`) is the objkt's own slug — `215` is
 * an iteration number within the `garden-monoliths` generative project, but
 * the URL slug as a whole is what their GraphQL accepts via `objkt(slug:)`.
 *
 * The single call returns the FA2 contract address (`gentkContractAddress`)
 * and the on-chain integer tokenId (`onChainId`), which is exactly what the
 * FF indexer needs. Iteration number and project slug are returned as a side
 * effect for any future UX, but they are not needed for resolution.
 *
 * Tezos-only: FX1-prefixed gentks live on Tezos. FX2 (EVM) tokens are out of
 * scope and are caught earlier in the URL parser.
 */

import * as logger from '../logger';
import type { TokenCoords } from './marketplace-url';

const FXHASH_GRAPHQL = 'https://api.fxhash.xyz/graphql';

interface FxhashObjktResponse {
  data?: {
    objkt?: {
      gentkContractAddress: string | null;
      onChainId: number | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

/**
 * Resolve an fxhash iteration URL slug to its on-chain Tezos coordinates.
 *
 * @throws When the slug is unknown, the GraphQL call fails, or the resolved
 *   objkt is missing its on-chain fields (un-minted / pre-reveal).
 */
export async function resolveFxhashIteration(slug: string): Promise<TokenCoords> {
  logger.debug(`[fxhash] Resolving iteration slug "${slug}"`);
  const query = 'query ($slug: String!) { objkt(slug: $slug) { gentkContractAddress onChainId } }';
  const response = await fetch(FXHASH_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { slug } }),
  });
  if (!response.ok) {
    throw new Error(`fxhash GraphQL ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as FxhashObjktResponse;
  if (data.errors && data.errors.length > 0) {
    throw new Error(`fxhash GraphQL errors: ${data.errors.map((e) => e.message).join('; ')}`);
  }
  const objkt = data.data?.objkt;
  if (!objkt) {
    throw new Error(
      `fxhash: no iteration found for slug "${slug}". ` +
        'Check the URL — slugs come from fxhash.xyz/iteration/{slug}. ' +
        'Pre-reveal or unminted iterations may not be queryable yet.'
    );
  }
  if (!objkt.gentkContractAddress || objkt.onChainId === null) {
    throw new Error(
      `fxhash: iteration "${slug}" is missing on-chain coordinates ` +
        '(gentkContractAddress / onChainId). It may be pre-reveal or unassigned.'
    );
  }
  return {
    chain: 'tezos',
    contract: objkt.gentkContractAddress,
    tokenId: String(objkt.onChainId),
  };
}
