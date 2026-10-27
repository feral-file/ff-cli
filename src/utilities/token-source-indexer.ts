/**
 * Indexer token source: adapter over the ff-indexer-v2 client.
 *
 * The indexer is the default token source. Raster is the opt-in alternative
 * under evaluation (feral-file#3576); keep both behind the TokenSource
 * contract so the vendor stays a configuration switch. This adapter keeps the
 * pre-Raster behaviour on purpose, including the indexing trigger and the
 * polling that makes unseen tokens slow (ff-cli#132).
 */

import type {
  ListOptions,
  ResolveOptions,
  ResolvedToken,
  TokenCoordinate,
  TokenListing,
  TokenSource,
} from './token-source-contract';

// nft-indexer.js is CommonJS and is required lazily so a Raster run never
// loads the indexer client at all.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadIndexer = () => require('./nft-indexer');

/** Page size the owner walk has always used against the indexer. */
const OWNER_PAGE_SIZE = 50;

/** Per-request cap the indexer path has always applied to a bounded listing. */
const MAX_BOUNDED_LIMIT = 100;

interface IndexerRow {
  contract_address?: string;
  token_number?: string;
}

/** chainOfContract infers a chain from an address; listings carry no chain name. */
function chainOfContract(contractAddress: string): string {
  return contractAddress.startsWith('KT') ? 'tezos' : 'ethereum';
}

/** rowsToResults converts raw indexer rows to results, one per row. */
function rowsToResults(rows: IndexerRow[], duration?: number): ResolvedToken[] {
  const indexer = loadIndexer();
  return rows.map((row) => {
    const contractAddress = row.contract_address || '';
    const coordinate: TokenCoordinate = {
      chain: chainOfContract(contractAddress),
      contractAddress,
      tokenId: String(row.token_number ?? ''),
    };
    const mapped = indexer.mapIndexerDataToStandardFormat(row, coordinate.chain);
    const converted = mapped.success ? indexer.convertToDP1Item(mapped, duration) : mapped;
    if (!converted.success || !converted.item) {
      return { success: false, coordinate, error: converted.error || 'Item build failed' };
    }
    return { success: true, coordinate, item: converted.item, still: converted.still || '' };
  });
}

/**
 * walkOwner pages through the indexer for an owner, as queryTokensByAddress did.
 * A failed first page throws; a failed later page keeps what was collected,
 * which is the indexer path's long-standing behaviour.
 */
async function walkOwner(address: string, limit: number | 'all'): Promise<IndexerRow[]> {
  const indexer = loadIndexer();
  if (limit !== 'all') {
    const result = await indexer.queryTokensByOwner(address, Math.min(limit, MAX_BOUNDED_LIMIT));
    if (!result.success) {
      throw new Error(result.error || 'Indexer owner query failed');
    }
    return result.tokens;
  }
  const rows: IndexerRow[] = [];
  for (let offset = 0; ; offset += OWNER_PAGE_SIZE) {
    const result = await indexer.queryTokensByOwner(address, OWNER_PAGE_SIZE, offset);
    if (!result.success && offset === 0) {
      throw new Error(result.error || 'Indexer owner query failed');
    }
    if (!result.success || result.tokens.length === 0) {
      return rows;
    }
    rows.push(...result.tokens);
    if (result.tokens.length < OWNER_PAGE_SIZE) {
      return rows;
    }
  }
}

/** createIndexerTokenSource builds the indexer provider. */
export function createIndexerTokenSource(): TokenSource {
  return {
    name: 'indexer',
    async resolveTokens(coords, opts: ResolveOptions = {}) {
      const raw: Array<{
        success: boolean;
        item?: Record<string, unknown>;
        still?: string;
        error?: string;
      }> = await loadIndexer().resolveTokenBatch(coords, opts.duration, opts.onProgress);
      return coords.map((coordinate, i): ResolvedToken => {
        const result = raw[i];
        if (result?.success && result.item) {
          return { success: true, coordinate, item: result.item, still: result.still || '' };
        }
        return { success: false, coordinate, error: result?.error || 'Token not resolved' };
      });
    },
    async listTokensByOwner(address, opts: ListOptions): Promise<TokenListing> {
      const rows = await walkOwner(address, opts.limit);
      return { results: rowsToResults(rows, opts.duration), skippedUnsupported: 0 };
    },
    async listTokensByContract(address, opts: ListOptions): Promise<TokenListing> {
      const limit =
        opts.limit === 'all' ? MAX_BOUNDED_LIMIT : Math.min(opts.limit, MAX_BOUNDED_LIMIT);
      const result = await loadIndexer().queryTokensByContract(address, limit);
      if (!result.success) {
        throw new Error(result.error || 'Indexer contract query failed');
      }
      return { results: rowsToResults(result.tokens, opts.duration), skippedUnsupported: 0 };
    },
  };
}
