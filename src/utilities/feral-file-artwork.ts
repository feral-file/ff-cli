/**
 * Feral File public artwork API helpers.
 *
 * The exhibition API is the source of truth for public artwork IDs, including
 * swapped artwork IDs where the public URL id differs from the on-chain token
 * id. The CLI should consume the identity fields returned by the artwork
 * endpoint instead of reconstructing contract identity from exhibition internals.
 */

import { USER_AGENT } from './user-agent';

export interface FeralFileArtworkTokenCoords {
  chain: 'ethereum' | 'tezos';
  contractAddress: string;
  tokenId: string;
}

interface FeralFileArtworkResponse {
  result?: {
    id?: string;
    chain?: unknown;
    contractAddress?: unknown;
    tokenID?: unknown;
  };
  error?: {
    message?: string;
  };
}

/**
 * resolveFeralFileArtwork resolves a public Feral File artwork id into indexer
 * token coordinates using the self-describing artwork API response.
 *
 * @param artworkId - Public artwork id from Feral File.
 * @param fetchImpl - Fetch implementation, injected by tests.
 * @returns Token coordinates suitable for ff-indexer-v2 lookup.
 */
export async function resolveFeralFileArtwork(
  artworkId: string,
  fetchImpl: typeof fetch = fetch
): Promise<FeralFileArtworkTokenCoords> {
  const normalizedArtworkId = artworkId.trim();
  if (!normalizedArtworkId) {
    throw new Error('Feral File artwork id is required');
  }

  const url = `https://feralfile.com/api/artworks/${encodeURIComponent(normalizedArtworkId)}`;
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  const body = (await response.json()) as FeralFileArtworkResponse;

  if (!response.ok) {
    throw new Error(body.error?.message || `Feral File artwork lookup failed (${response.status})`);
  }

  const artwork = body.result;
  if (!artwork) {
    throw new Error('Feral File artwork lookup returned no result');
  }

  const chain = normalizeFeralFileChain(artwork.chain);
  const contractAddress = stringField(artwork.contractAddress, 'contractAddress');
  const tokenId = stringField(artwork.tokenID, 'tokenID');

  return { chain, contractAddress, tokenId };
}

/**
 * parseFeralFileArtworkId extracts the public artwork id from supported Feral
 * File artwork URLs. Non-URL strings are treated as raw artwork ids so
 * structured build inputs can pass the id directly.
 *
 * @param input - Feral File artwork URL or raw public artwork id.
 * @returns Public artwork id.
 */
export function parseFeralFileArtworkId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Feral File artwork id is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'feralfile.com') {
    throw new Error(`Unsupported Feral File artwork URL host: ${parsed.hostname}`);
  }

  const match = parsed.pathname.match(/^\/exhibitions\/artwork\/([^/]+)\/?$/);
  if (!match) {
    throw new Error('Unsupported Feral File artwork URL path');
  }

  return decodeURIComponent(match[1]);
}

function normalizeFeralFileChain(value: unknown): 'ethereum' | 'tezos' {
  if (typeof value !== 'string') {
    throw new Error('Feral File artwork is missing chain');
  }

  const normalized = value.toLowerCase();
  if (normalized === 'ethereum' || normalized === 'tezos') {
    return normalized;
  }

  throw new Error(`Unsupported Feral File artwork chain: ${value}`);
}

function stringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Feral File artwork is missing ${fieldName}`);
  }
  return value;
}
