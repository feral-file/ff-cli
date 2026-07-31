/**
 * Objkt marketplace resolver.
 *
 * Objkt URLs accept either a raw KT1 contract address OR a short collection
 * alias (e.g. `objkt.com/tokens/hicetnunc/111068` where `hicetnunc` maps to
 * `KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton`). The alias-to-contract mapping
 * lives in their public GraphQL `fa.path` field.
 *
 * The URL parser stays sync; this module owns the one async call needed
 * when an alias segment is detected.
 */

import { fetchWithTimeout } from './http';
import * as logger from '../logger';
import { USER_AGENT } from './user-agent';

const OBJKT_GRAPHQL = 'https://data.objkt.com/v3/graphql';

interface FaPathResponse {
  data?: {
    fa?: Array<{ contract: string }>;
  };
  errors?: Array<{ message: string }>;
}

/**
 * Resolve an Objkt URL alias to its KT1 contract address.
 *
 * @throws When the alias is not registered on Objkt, or the GraphQL call fails.
 */
export async function resolveObjktAlias(alias: string): Promise<string> {
  logger.debug(`[Objkt] Resolving alias "${alias}"`);
  const query = 'query ($path: String!) { fa(where: { path: { _eq: $path } }) { contract } }';
  const response = await fetchWithTimeout(OBJKT_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ query, variables: { path: alias } }),
  });
  if (!response.ok) {
    throw new Error(`Objkt GraphQL ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as FaPathResponse;
  if (data.errors && data.errors.length > 0) {
    throw new Error(`Objkt GraphQL errors: ${data.errors.map((e) => e.message).join('; ')}`);
  }
  const contract = data.data?.fa?.[0]?.contract;
  if (!contract) {
    throw new Error(
      `Objkt: alias "${alias}" did not resolve to a contract. ` +
        'If this is a real collection, paste the URL using its KT1 contract address instead.'
    );
  }
  return contract;
}
