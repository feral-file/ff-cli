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

import * as logger from '../logger';
import { USER_AGENT } from './user-agent';

const OBJKT_GRAPHQL = 'https://data.objkt.com/v3/graphql';

interface FaPathResponse {
  data?: {
    fa?: Array<{ contract: string }>;
  };
  errors?: Array<{ message: string }>;
}

interface ObjktCollectionResponse {
  data?: {
    fa?: Array<{ contract: string; name?: string | null }>;
  };
  errors?: Array<{ message: string }>;
}

interface ObjktCollectionTokensResponse {
  data?: {
    token?: Array<{ fa_contract: string; token_id: string | number }>;
  };
  errors?: Array<{ message: string }>;
}

export interface ObjktCollectionTokens {
  title: string;
  tokens: Array<{ chain: 'tezos'; contract: string; tokenId: string }>;
  hasMore: boolean;
}

/**
 * Resolve an Objkt URL alias to its KT1 contract address.
 *
 * @throws When the alias is not registered on Objkt, or the GraphQL call fails.
 */
export async function resolveObjktAlias(alias: string): Promise<string> {
  logger.debug(`[Objkt] Resolving alias "${alias}"`);
  const query = 'query ($path: String!) { fa(where: { path: { _eq: $path } }) { contract } }';
  const response = await fetch(OBJKT_GRAPHQL, {
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

/**
 * Resolve an Objkt collection to at most `limit` Tezos token coordinates.
 *
 * The upstream source-resolver can enumerate whole Objkt collections, but
 * large historical collections such as hicetnunc are far bigger than the
 * CLI needs for a `find --limit N` or DP-1's 1024 item cap. This bounded
 * resolver preserves the same public Objkt API contract while avoiding a
 * full-catalog walk before the user has confirmed playlist creation.
 */
export async function resolveObjktCollection(
  identifier: string,
  limit: number
): Promise<ObjktCollectionTokens> {
  logger.debug(`[Objkt] Resolving collection "${identifier}"`);
  const collectionQuery =
    'query ($identifier: String!) { ' +
    'fa(where: { _or: [{ path: { _eq: $identifier } }, { contract: { _eq: $identifier } }, { collection_id: { _eq: $identifier } }] }, limit: 1) ' +
    '{ contract name } }';
  const collection = await postObjktGraphQL<ObjktCollectionResponse>(collectionQuery, {
    identifier,
  });
  const firstCollection = collection.data?.fa?.[0];
  if (!firstCollection?.contract) {
    throw new Error(`Objkt: collection "${identifier}" did not resolve to a contract.`);
  }

  const tokenQuery =
    'query ($contract: String!, $limit: Int!) { ' +
    'token(where: { fa_contract: { _eq: $contract } }, order_by: { pk: asc }, limit: $limit) ' +
    '{ fa_contract token_id } }';
  const tokenLimit = limit + 1;
  const tokenData = await postObjktGraphQL<ObjktCollectionTokensResponse>(tokenQuery, {
    contract: firstCollection.contract,
    limit: tokenLimit,
  });
  const rows = tokenData.data?.token ?? [];
  return {
    title: firstCollection.name ?? `Objkt collection ${identifier}`,
    tokens: rows.slice(0, limit).map((token) => ({
      chain: 'tezos',
      contract: token.fa_contract,
      tokenId: String(token.token_id),
    })),
    hasMore: rows.length > limit,
  };
}

async function postObjktGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(OBJKT_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Objkt GraphQL ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as T & { errors?: Array<{ message: string }> };
  if (data.errors && data.errors.length > 0) {
    throw new Error(`Objkt GraphQL errors: ${data.errors.map((e) => e.message).join('; ')}`);
  }
  return data;
}
