/**
 * Art Blocks marketplace resolver.
 *
 * AB collection URLs (`artblocks.io/collection/{slug}`) point to a series,
 * not a token. Their public Hasura GraphQL at `artblocks-mainnet.hasura.app`
 * resolves the slug to a contract + a representative tokenId in one call.
 * From there, the standard Raster reverse-lookup enumerates the rest of the
 * series like any other marketplace.
 *
 * AB does not publish a first-party MCP server as of 2026-05-17, so the
 * direct GraphQL path is the right shape.
 */

import * as logger from '../logger';
import type { TokenCoords } from './marketplace-url';
import { USER_AGENT } from './user-agent';

const AB_GRAPHQL = 'https://artblocks-mainnet.hasura.app/v1/graphql';

interface AbProjectResponse {
  data?: {
    projects_metadata?: Array<{
      contract_address: string;
      tokens: Array<{ token_id: string }>;
    }>;
  };
  errors?: Array<{ message: string }>;
}

/**
 * Resolve an Art Blocks collection slug to its contract address + the first
 * minted tokenId in the series.
 *
 * @throws When the slug is unknown, the project has no minted tokens, or
 *   the GraphQL call fails.
 */
export async function resolveArtBlocksCollection(slug: string): Promise<TokenCoords> {
  logger.debug(`[AB] Resolving collection slug "${slug}"`);
  const query =
    'query ($slug: String!) {' +
    '  projects_metadata(where: { slug: { _eq: $slug } }, limit: 1) {' +
    '    contract_address' +
    '    tokens(limit: 1, order_by: { invocation: asc }) { token_id }' +
    '  }' +
    '}';
  const response = await fetch(AB_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ query, variables: { slug } }),
  });
  if (!response.ok) {
    throw new Error(`Art Blocks GraphQL ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as AbProjectResponse;
  if (data.errors && data.errors.length > 0) {
    throw new Error(`Art Blocks GraphQL errors: ${data.errors.map((e) => e.message).join('; ')}`);
  }
  const project = data.data?.projects_metadata?.[0];
  if (!project) {
    throw new Error(
      `Art Blocks: no project found for slug "${slug}". ` +
        'Check the URL — slugs come from artblocks.io/collection/{slug}. ' +
        'AB Engine collaborations may live on a different subgraph and are not covered here yet.'
    );
  }
  const firstToken = project.tokens?.[0];
  if (!firstToken) {
    throw new Error(
      `Art Blocks: project "${slug}" has no minted tokens yet. ` +
        'Paste a specific token URL once at least one edition is minted.'
    );
  }
  return {
    chain: 'ethereum',
    contract: project.contract_address.toLowerCase(),
    tokenId: firstToken.token_id,
  };
}
