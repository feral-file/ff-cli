/**
 * fxhash marketplace resolver.
 *
 * fxhash's UI exposes:
 *  - individual iterations under `/iteration/{slug}` (e.g. `garden-monoliths-215`)
 *    — resolved via `objkt(slug:)` to (contract, onChainId).
 *  - generative projects (series) under `/project/{slug}` and `/generative/{slug}`
 *    — resolved via `generativeToken(slug:)` to (contract, first iteration's
 *    onChainId), which Raster then reverse-looks-up to enumerate the rest of
 *    the series. Mirrors the AB collection flow.
 *
 * Tezos-only: FX1-prefixed gentks live on Tezos. FX2 (EVM) tokens / projects
 * are out of scope. EVM gentk URLs are caught earlier in the URL parser; EVM
 * projects under `/project/{slug}` will simply not resolve via the Tezos
 * GraphQL endpoint and surface as "slug not found".
 */

import * as logger from '../logger';
import type { TokenCoords } from '@feralfile/source-resolver';
import { USER_AGENT } from './user-agent';

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
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
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

interface FxhashGenerativeTokenResponse {
  data?: {
    generativeToken?: {
      objkts: Array<{
        gentkContractAddress: string | null;
        onChainId: number | null;
      }>;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

/**
 * Resolve an fxhash generative project slug (e.g. `garden-monoliths`) to its
 * contract + a representative on-chain tokenId — the first minted iteration.
 * Raster then enumerates the rest of the series via the standard reverse
 * lookup, identical to the AB collection flow.
 *
 * Note: each Objkt has its own `gentkContractAddress`. fxhash projects can
 * span multiple gentk contracts (V1/V2/V3 mint phases), so we read the contract
 * off the iteration itself, not the project header.
 *
 * @throws When the slug is unknown (Tezos endpoint won't see EVM-only
 *   projects), the project has no minted iterations, or the GraphQL call
 *   fails.
 */
export async function resolveFxhashProject(slug: string): Promise<TokenCoords> {
  logger.debug(`[fxhash] Resolving project slug "${slug}"`);
  const query =
    'query ($slug: String!) {' +
    '  generativeToken(slug: $slug) {' +
    '    objkts(skip: 0, take: 1, sort: { iteration: "ASC" }) {' +
    '      gentkContractAddress' +
    '      onChainId' +
    '    }' +
    '  }' +
    '}';
  const response = await fetch(FXHASH_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ query, variables: { slug } }),
  });
  if (!response.ok) {
    throw new Error(`fxhash GraphQL ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as FxhashGenerativeTokenResponse;
  if (data.errors && data.errors.length > 0) {
    throw new Error(`fxhash GraphQL errors: ${data.errors.map((e) => e.message).join('; ')}`);
  }
  const project = data.data?.generativeToken;
  if (!project) {
    throw new Error(
      `fxhash: no project found for slug "${slug}". ` +
        'Check the URL — slugs come from fxhash.xyz/project/{slug} or /generative/{slug}. ' +
        'EVM-only projects on fxhash are not covered (FF indexer is Tezos mainnet only for fxhash).'
    );
  }
  const firstObjkt = project.objkts?.[0];
  if (!firstObjkt || !firstObjkt.gentkContractAddress || firstObjkt.onChainId === null) {
    throw new Error(
      `fxhash: project "${slug}" has no minted iterations yet, or is pre-reveal. ` +
        'Paste a specific iteration URL once at least one edition is minted.'
    );
  }
  return {
    chain: 'tezos',
    contract: firstObjkt.gentkContractAddress,
    tokenId: String(firstObjkt.onChainId),
  };
}
