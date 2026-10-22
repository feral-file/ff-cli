/**
 * NFT Indexer Client (ff-indexer-v2).
 *
 * The Feral File indexer is the default token source. Raster
 * (src/utilities/token-source-raster.ts) answers instead when
 * `tokenSource: "raster"` is configured (feral-file#3576). This module is
 * reached exclusively through src/utilities/token-source-indexer.ts; do not
 * add callers that bypass the TokenSource contract.
 *
 * Vendor-neutral item construction (convertToDP1Item and the standard/chain
 * helpers) lives in src/utilities/token-item.ts and is re-exported here only
 * so existing tests keep their import paths.
 */

// The production endpoint is hardcoded, as PROJECT_SPEC states, and stays
// that way. INDEXER_API_URL is a test hook, not configuration: the
// find-command suite spawns the CLI as a child process, so the only way to
// point it at a local mock is through the environment.
//
// It is gated on NODE_ENV=test because index.ts loads dotenv at startup. An
// ungated read would mean a stray INDEXER_API_URL in someone's .env, or an
// inherited shell value, silently redirecting every token lookup and indexing
// mutation — a configuration surface nobody documented and no one would think
// to check. The gate keeps the hook usable without creating that surface.
const GRAPHQL_ENDPOINT =
  process.env.NODE_ENV === 'test' && process.env.INDEXER_API_URL
    ? process.env.INDEXER_API_URL
    : 'https://indexer.feralfile.com/graphql';
const { fetchWithTimeout } = require('./http');
const logger = require('../logger');
const {
  convertToDP1Item,
  detectTokenStandard,
  extractArtistName,
  getBestMediaUrl,
  normalizeCidStandard,
  resolveTokenStandard,
} = require('./token-item');

// Polling configuration (in milliseconds)
const POLLING_INTERVAL_MS = 2000; // Poll every 2 seconds
const POLLING_TIMEOUT_MS = 60000; // Max poll for 1 minute

/**
 * GraphQL mutation document for enqueueing token indexing (exposed for tests; must match runtime).
 */
const TRIGGER_TOKEN_INDEXING_MUTATION = `
      mutation TriggerTokenIndexing($token_cids: [String!]!) {
        triggerTokenIndexing(token_cids: $token_cids) {
          job_id
        }
      }
    `;

/**
 * GraphQL query document for job queue status (exposed for tests; must match runtime).
 */
const JOB_STATUS_QUERY = `
      query JobStatus($job_id: Int!) {
        jobStatus(job_id: $job_id) {
          status
          last_error
        }
      }
    `;

/**
 * buildTokensListQuery builds the `tokens { items { ... } }` request body used by queryTokens.
 *
 * Presentation comes only from `display` and `media_assets`. The indexer merges metadata and
 * enrichment into `display`; the client does not repeat that merge by fetching raw metadata fields.
 *
 * `chain` and `standard` are selected because the row is the only place either fact is known.
 * `detectTokenStandard` has an address and a chain name and nothing else, so it answers `erc721` for
 * every EVM contract — which wrote `erc721` into playlists for every ERC-1155 token `find` reached by
 * owner or by contract. The indexer stores what the token actually is (`erc721`, `erc1155`, `fa2`)
 * beside its CAIP-2 `chain` (`eip155:1`, `tezos:mainnet`), so the row answers both questions and
 * detection drops to a fallback. Do not remove these two fields from the selection.
 *
 * @param {Object} [params]
 * @param {Array<string>} [params.token_cids]
 * @param {Array<string>} [params.owners]
 * @param {Array<string>} [params.contract_addresses]
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @returns {string} GraphQL query string (inline arguments, no variables)
 */
function buildTokensListQuery(params = {}) {
  const { token_cids = [], owners = [], contract_addresses = [], limit = 50, offset = 0 } = params;

  const ownerFilter = owners.length > 0 ? `owners: ${JSON.stringify(owners)},` : '';
  const tokenCidsFilter = token_cids.length > 0 ? `token_cids: ${JSON.stringify(token_cids)},` : '';
  const contractFilter =
    contract_addresses.length > 0
      ? `contract_addresses: ${JSON.stringify(contract_addresses)},`
      : '';

  return `
      query {
        tokens(${ownerFilter} ${tokenCidsFilter} ${contractFilter} limit: ${limit}, offset: ${offset}) {
        items {
          contract_address
          token_number
          current_owner
          burned
          chain
          standard
          display {
            name
            description
            mime_type
            image_url
            animation_url
            artists {
              name
            }
          }
          media_assets {
            source_url
            variants(keys: [l, m, xl, xxl, preview])
          }
        }
      }
    }
  `;
}

/**
 * Build CAIP-2 token CID for indexer v2
 *
 * Constructs a token identifier in CAIP-2 format compatible with ff-indexer-v2.
 * Format: `{caip2Chain}:{standard}:{contractAddress}:{tokenNumber}`
 *
 * @param {string} chain - Blockchain network (ethereum, polygon, tezos, etc)
 * @param {string} contractAddress - Contract address
 * @param {string} tokenId - Token ID
 * @param {string} [standard] - Asserted token standard; detected when omitted
 * @returns {string} Token CID in CAIP-2 format
 * @example
 * // Returns: eip155:1:erc721:0xabc123:456
 * const cid = buildTokenCID('ethereum', '0xabc123', '456');
 * @example
 * // Returns: eip155:1:erc1155:0xabc123:456
 * const cid = buildTokenCID('ethereum', '0xabc123', '456', 'erc1155');
 * @example
 * // Returns: tezos:mainnet:fa2:KT1abc:789
 * const cid = buildTokenCID('tezos', 'KT1abc', '789');
 */
function buildTokenCID(chain, contractAddress, tokenId, standard) {
  // Map chain names to CAIP-2 format (supports only Ethereum and Tezos)
  const caip2Map = {
    ethereum: 'eip155:1',
    tezos: 'tezos:mainnet',
    fa2: 'tezos:mainnet', // FA2 is Tezos
  };

  const lowerChain = chain.toLowerCase();
  const caip2Chain = caip2Map[lowerChain];

  if (!caip2Chain) {
    throw new Error(`Unsupported chain: ${chain}. Only ethereum and tezos are supported.`);
  }

  const resolvedStandard = resolveTokenStandard(chain, contractAddress, standard);

  return `${caip2Chain}:${resolvedStandard}:${contractAddress}:${tokenId}`;
}

/**
 * Unified GraphQL query for tokens from indexer v2
 *
 * Supports querying by token CIDs and/or owners. Selects `display` and `media_assets` only.
 *
 * @param {Object} params - Query parameters
 * @param {Array<string>} [params.token_cids] - Array of token CIDs to query
 * @param {Array<string>} [params.owners] - Array of owner addresses to query
 * @param {number} [params.limit] - Maximum number of tokens to return (default: 50)
 * @param {number} [params.offset] - Offset for pagination (default: 0)
 * @returns {Promise<Array<Object>>} Array of token data
 * @throws {Error} When query fails
 * @example
 * // Query by token CID
 * const tokens = await queryTokens({ token_cids: ['eip155:1:erc721:0xabc:123'] });
 *
 * // Query by owner address
 * const tokens = await queryTokens({ owners: ['0x1234...'], limit: 100 });
 *
 * // Query specific tokens for a specific owner
 * const tokens = await queryTokens({ token_cids: ['eip155:1:erc721:0xabc:123'], owners: ['0x1234...'] });
 */
async function queryTokens(params = {}) {
  const { token_cids = [], owners = [], limit = 50, offset = 0 } = params;
  const query = buildTokensListQuery(params);

  try {
    const headers = { 'Content-Type': 'application/json' };

    logger.debug('[NFT Indexer] Querying tokens:', { token_cids, owners, limit, offset });
    logger.debug('[NFT Indexer] GraphQL query:', query);

    const response = await fetchWithTimeout(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Inside queryTokens — caller (queryTokenDataFromIndexer) falls back
      // to the trigger-indexing path when this returns/throws. Demoting to
      // debug so transient 502s don't flood stderr during recoverable runs.
      logger.debug('[NFT Indexer] HTTP error response:', {
        status: response.status,
        body: errorBody.substring(0, 500),
      });
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      logger.debug('[NFT Indexer] GraphQL errors:', result.errors);
      throw new Error(`GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
    }

    // v2 API wraps tokens in { items: [...], total: N }
    const tokenList = result.data?.tokens;
    const tokens = tokenList?.items || [];
    return tokens;
  } catch (error) {
    logger.debug('[NFT Indexer] Failed to query tokens:', error.message);
    throw error;
  }
}

/**
 * Query single token data from indexer by token CID
 *
 * Convenience wrapper around queryTokens for single token queries.
 *
 * @param {string} tokenCID - Token CID in CAIP-2 format
 * @returns {Promise<Object|null>} Token data or null if not found
 */
async function queryTokenDataFromIndexer(tokenCID) {
  try {
    const tokens = await queryTokens({ token_cids: [tokenCID] });
    return tokens[0] || null;
  } catch (error) {
    logger.debug('[NFT Indexer] Failed to query token data:', error.message);
    return null;
  }
}

/**
 * Map indexer token row (GraphQL `display` + `media_assets`) to internal standard format.
 *
 * Treats `display` as the authoritative merged presentation from the server. When `display`
 * is null or partial, we only use what is present (for example `Token #${token_number}` for name);
 * we do not splice in raw `metadata` or enrichment because those are not selected from GraphQL.
 *
 * The row's own `standard` and `chain` outrank both the asserted `standard` and the `chain`
 * argument, because they are the token's identity as the indexer recorded it while the arguments are
 * the caller's inference — `find` by owner or by contract only knows "the address starts with 0x, so
 * ethereum". Precedence for the standard is row → asserted → detection; the CAIP-2 `chain` is kept
 * beside the caller's chain name (not in place of it) as `caip2Chain`, because the name still selects
 * the CID prefix and the detection fallback while the CAIP-2 value answers DP-1's chain enum.
 *
 * @param {Object} indexerData - Token fields from indexer GraphQL
 * @param {string} chain - Blockchain network the caller inferred
 * @param {string} [standard] - Asserted token standard; used when the row carries none
 * @returns {Object} Standardized token data
 */
function mapIndexerDataToStandardFormat(indexerData, chain, standard) {
  if (!indexerData) {
    return {
      success: false,
      error: 'Token not found in indexer',
    };
  }

  const display = indexerData.display || {};
  const mediaAssets = indexerData.media_assets || [];
  const media = getBestMediaUrl(display, mediaAssets);
  const artistName = extractArtistName(display.artists);
  const name = display.name || `Token #${indexerData.token_number}`;
  const description = display.description || '';
  const resolvedStandard =
    normalizeCidStandard(indexerData.standard) ||
    resolveTokenStandard(chain, indexerData.contract_address, standard);
  const caip2Chain = typeof indexerData.chain === 'string' ? indexerData.chain : '';

  return {
    success: true,
    token: {
      chain,
      caip2Chain,
      contractAddress: indexerData.contract_address,
      tokenId: indexerData.token_number,
      standard: resolvedStandard,
      name,
      description,
      image: {
        url: media.url,
        mimeType: display.mime_type || 'image/png',
        thumbnail: media.thumbnail,
      },
      animation_url: display.animation_url,
      metadata: {
        attributes: [],
        artistName,
      },
      owner: indexerData.current_owner,
      collection: {
        name: name.split('#')[0].trim(),
        description,
      },
      burned: indexerData.burned || false,
    },
  };
}

/**
 * Get NFT token information from indexer and return as DP1 item (supports single or batch)
 * @param {Object|Array} params - Token parameters (single object or array)
 * @param {number} [params.duration] - Explicit display seconds; omit for auto timing
 * @returns {Promise<Object>} DP1 item(s)
 */
async function getNFTTokenInfo(params) {
  const duration = params.duration;

  // Handle array input for batch processing
  if (Array.isArray(params.tokens)) {
    return await getNFTTokenInfoBatch(params.tokens, duration);
  }

  // Handle single token
  const { chain, contractAddress, tokenId, standard } = params;
  const result = await getNFTTokenInfoSingle(
    { chain, contractAddress, tokenId, standard },
    duration
  );
  return result;
}

/**
 * Get single NFT token information from indexer and return as DP1 item
 *
 * Queries the indexer for token data. If not found, triggers async indexing workflow,
 * polls for completion, and retries token query. Also polls for `media_assets`
 * while renditions are still processing when needed.
 *
 * @param {Object} params - Token parameters
 * @param {string} params.chain - Blockchain network
 * @param {string} params.contractAddress - Contract address
 * @param {string} params.tokenId - Token ID
 * @param {number} duration - Display duration in seconds
 * @param {Object} [options] - Optional overrides (for tests): polling intervals/timeouts
 * @param {Object} [options.jobPoll] - Passed to pollForJobCompletion
 * @param {Object} [options.mediaPoll] - Passed to pollForMediaAssets
 * @returns {Promise<Object>} DP1 item with success/error status
 */
async function getNFTTokenInfoSingle(params, duration, options = {}) {
  let chain = params.chain;
  const { contractAddress, tokenId, standard } = params;

  // DEFENSIVE: Auto-detect and correct chain based on contract address format
  if (contractAddress.startsWith('KT') && chain !== 'tezos') {
    logger.warn(
      `[NFT Indexer] Chain mismatch detected! Contract ${contractAddress} starts with KT but chain="${chain}". Auto-correcting to "tezos".`
    );
    chain = 'tezos';
  } else if (contractAddress.startsWith('0x') && chain === 'tezos') {
    logger.warn(
      `[NFT Indexer] Chain mismatch detected! Contract ${contractAddress} starts with 0x but chain="tezos". Auto-correcting to "ethereum".`
    );
    chain = 'ethereum';
  }

  logger.info(`[NFT Indexer] Fetching token info for:`, {
    chain,
    contractAddress,
    tokenId,
  });

  try {
    // Build token CID in CAIP-2 format
    const tokenCID = buildTokenCID(chain, contractAddress, tokenId, standard);
    logger.info(`[NFT Indexer] Built token CID: ${tokenCID}`);

    // Query the indexer
    logger.info(`[NFT Indexer] Querying indexer GraphQL for token...`);
    let indexerData = await queryTokenDataFromIndexer(tokenCID);

    // If token not found, trigger async indexing and poll
    if (!indexerData) {
      logger.info(`[NFT Indexer] Token not in database, triggering async indexing...`);

      // Trigger background indexing workflow
      const indexResult = await triggerIndexingAsync(chain, contractAddress, tokenId, standard);

      if (!indexResult.success) {
        logger.debug(`[NFT Indexer] Failed to trigger indexing:`, indexResult.error);
        return {
          success: false,
          error: `Token not found and indexing failed: ${indexResult.error}`,
        };
      }

      logger.info('[NFT Indexer] Indexing job triggered', {
        job_id: indexResult.job_id,
      });

      // Poll for job completion (queue-backed jobs use job_id / jobStatus)
      const pollResult = await pollForJobCompletion(indexResult.job_id, options.jobPoll ?? {});

      if (!pollResult.success) {
        logger.debug('[NFT Indexer] Job polling failed:', pollResult.error);
        return {
          success: false,
          error: `Indexing job failed: ${pollResult.error}`,
        };
      }

      if (pollResult.timedOut) {
        logger.warn('[NFT Indexer] Job polling timed out before completion');
        return {
          success: false,
          error: `Token indexing timed out. Please try again in a moment.`,
        };
      }

      // Job completed, query token again
      logger.info(`[NFT Indexer] Job completed, querying token again...`);
      indexerData = await queryTokenDataFromIndexer(tokenCID);

      // If still not found after indexing, consider it invalid
      if (!indexerData) {
        logger.warn(
          `[NFT Indexer] Token still not found after indexing. Contract or token ID may be invalid.`
        );
        return {
          success: false,
          error: `Token not found. Invalid contract address or token ID.`,
        };
      }
    }

    logger.info(`[NFT Indexer] ✓ Token found in database`);

    // If token found but no media_assets yet, poll until indexer has renditions or timeout
    if (!Array.isArray(indexerData.media_assets) || indexerData.media_assets.length === 0) {
      logger.info('[NFT Indexer] Media assets not available, polling...');
      indexerData = await pollForMediaAssets(tokenCID, options.mediaPoll ?? {});

      if (!indexerData) {
        logger.warn('[NFT Indexer] Failed to retrieve token data during metadata polling');
        return {
          success: false,
          error: `Failed to retrieve complete token data`,
        };
      }
    }

    // Map to standard format and convert to DP1
    const tokenData = mapIndexerDataToStandardFormat(indexerData, chain, standard);
    return convertToDP1Item(tokenData, duration);
  } catch (error) {
    logger.debug(`[NFT Indexer] Error fetching token:`, error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Resolve a batch of tokens and return every outcome (parallel processing)
 *
 * For missing tokens: triggers indexing per token, polls by job_id, then fetches again.
 *
 * Unlike getNFTTokenInfoBatch this keeps one result per input token, in input
 * order: a resolved token as `{ success: true, item, still }`, a failed one as
 * `{ success: false, error, token }`. Callers that must know which request an
 * answer belongs to, or that need the still beside the item, use this.
 *
 * @param {Array} tokens - Array of token parameters (chain, contractAddress, tokenId, standard?)
 * @param {number} duration - Display duration in seconds
 * @param {Function} [onProgress] - Called with (done, total) after each batch
 * @returns {Promise<Array>} One result per input token
 */
async function resolveTokenBatch(tokens, duration, onProgress) {
  logger.info(`[NFT Indexer] 📦 Starting batch processing for ${tokens.length} token(s)...`);
  logger.debug('[NFT Indexer] Batch tokens:', tokens);

  const results = [];

  // Process in parallel with concurrency limit
  const concurrency = 10;
  for (let i = 0; i < tokens.length; i += concurrency) {
    const batch = tokens.slice(i, i + concurrency);
    logger.info(
      `[NFT Indexer] Processing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(tokens.length / concurrency)} (${batch.length} tokens)`
    );

    const batchResults = await Promise.all(
      batch.map((token, idx) =>
        getNFTTokenInfoSingle(token, duration).catch((error) => {
          logger.debug(`[NFT Indexer] Token ${idx + 1} in batch failed:`, error.message);
          return {
            success: false,
            error: error.message,
            token,
          };
        })
      )
    );

    // Log results
    const successful = batchResults.filter((r) => r.success).length;
    const failed = batchResults.filter((r) => !r.success).length;
    logger.info(`[NFT Indexer] Batch complete: ${successful} success, ${failed} failed`);

    results.push(...batchResults);

    // Indexing previously-unseen tokens can take minutes (the indexer warms
    // renditions by polling); without user-visible progress the CLI reads as
    // hung. logger.info above is verbose-gated, so callers that face a human
    // pass onProgress to render it. Errors in the callback must never break
    // the batch — reporting is strictly best-effort.
    if (typeof onProgress === 'function') {
      try {
        onProgress(results.length, tokens.length);
      } catch {
        /* progress display is best-effort */
      }
    }
  }

  logger.info(`[NFT Indexer] ✓ Batch processing complete: ${results.length} total results`);
  const successCount = results.filter((r) => r.success && r.item).length;
  const failedCount = results.length - successCount;
  logger.info(`[NFT Indexer] Final: ${successCount} items with data, ${failedCount} without`);

  return results;
}

/**
 * Get NFT token information in batch and return as DP1 items (parallel processing)
 *
 * For missing tokens: triggers indexing per token, polls by job_id, then fetches again.
 *
 * Returns only the resolved items. Failures are dropped, not represented, so
 * the result is neither aligned with nor as long as the input; a caller that
 * needs the association uses resolveTokenBatch.
 *
 * @param {Array} tokens - Array of token parameters
 * @param {number} duration - Display duration in seconds
 * @returns {Promise<Array>} Array of DP1 items
 */
async function getNFTTokenInfoBatch(tokens, duration, onProgress) {
  const results = await resolveTokenBatch(tokens, duration, onProgress);

  // Return only items (not error objects)
  const items = results.filter((r) => r.success && r.item).map((r) => r.item);
  logger.info(`[NFT Indexer] Returning ${items.length} items`);

  return items;
}

/**
 * Get collection information
 * @param {Object} params - Collection parameters
 * @param {string} params.chain - Blockchain network
 * @param {string} params.contractAddress - Collection contract address
 * @returns {Promise<Object>} Collection information
 */
async function getCollectionInfo(params) {
  const { chain, contractAddress } = params;

  // TODO: Implement collection info fetching

  logger.debug(`[NFT Indexer] Fetching collection info for:`, {
    chain,
    contractAddress,
  });

  return {
    success: true,
    collection: {
      chain,
      contractAddress,
      name: 'Collection Name',
      description: 'Collection Description',
      image: 'https://example.com/collection.png',
      totalSupply: 10000,
      floorPrice: {
        value: '0.1',
        currency: 'ETH',
      },
      metadata: {},
    },
  };
}

/**
 * Trigger async indexing workflow for a token (fire-and-forget)
 *
 * Starts an asynchronous background workflow to index and persist the token via GraphQL mutation.
 * Does not wait for completion - returns immediately.
 *
 * @param {string} chain - Blockchain network
 * @param {string} contractAddress - Contract address (required)
 * @param {string} tokenId - Token ID (required)
 * @returns {Promise<Object>} Result with job id only (queue correlation)
 * @returns {boolean} returns.success - Whether indexing job was accepted
 * @returns {number} [returns.job_id] - Postgres queue job id; use with jobStatus / pollForJobCompletion
 * @returns {string} [returns.error] - Error message if failed
 */
async function triggerIndexingAsync(chain, contractAddress, tokenId, standard) {
  try {
    // Build token CID
    const tokenCID = buildTokenCID(chain, contractAddress, tokenId, standard);

    logger.debug('[NFT Indexer] Triggering token indexing job via GraphQL mutation:', {
      tokenCID,
    });

    const mutation = TRIGGER_TOKEN_INDEXING_MUTATION;

    const variables = {
      token_cids: [tokenCID],
    };

    const headers = { 'Content-Type': 'application/json' };

    const response = await fetchWithTimeout(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: mutation, variables }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
    }

    const triggerResult = result.data?.triggerTokenIndexing;
    const rawJobId = triggerResult?.job_id;
    const jobId =
      rawJobId !== undefined && rawJobId !== null && rawJobId !== ''
        ? typeof rawJobId === 'number'
          ? rawJobId
          : parseInt(String(rawJobId), 10)
        : NaN;

    if (Number.isFinite(jobId) && jobId >= 1) {
      logger.debug('[NFT Indexer] ✓ Indexing job enqueued:', { jobId });
      return {
        success: true,
        job_id: jobId,
      };
    }
    logger.warn('[NFT Indexer] Unexpected mutation response:', result);
    return {
      success: false,
      error: 'No job_id returned from triggerTokenIndexing',
    };
  } catch (error) {
    logger.debug('[NFT Indexer] Async indexing error:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * queryJobStatus loads `jobStatus` from the indexer (minimal selection: status + last_error).
 *
 * @param {number|string} jobId - Queue job id from triggerTokenIndexing
 * @returns {Promise<{ success: boolean, status?: string, lastError?: string|null, error?: string }>}
 */
async function queryJobStatus(jobId) {
  try {
    const id = typeof jobId === 'number' ? jobId : parseInt(String(jobId).trim(), 10);
    if (!Number.isFinite(id) || id < 1) {
      return { success: false, error: 'Invalid job_id' };
    }

    const query = JOB_STATUS_QUERY;

    const variables = { job_id: id };
    const headers = { 'Content-Type': 'application/json' };

    const response = await fetchWithTimeout(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(`GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
    }

    const jobData = result.data?.jobStatus;
    if (jobData) {
      return {
        success: true,
        status: jobData.status,
        lastError: jobData.last_error ?? null,
      };
    }
    return {
      success: false,
      error: 'No job status returned',
    };
  } catch (error) {
    logger.debug('[NFT Indexer] Failed to query job status:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Poll until jobStatus reports a terminal state or timeout.
 *
 * @param {number|string} jobId - Job id from triggerTokenIndexing
 * @param {Object} [options]
 * @param {number} [options.intervalMs] - Delay between polls (default POLLING_INTERVAL_MS)
 * @param {number} [options.timeoutMs] - Max wall time (default POLLING_TIMEOUT_MS)
 */
async function pollForJobCompletion(jobId, options = {}) {
  const intervalMs = options.intervalMs ?? POLLING_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? POLLING_TIMEOUT_MS;
  const startTime = Date.now();
  let pollCount = 0;

  logger.debug('[NFT Indexer] Starting job polling...', {
    jobId,
    timeoutMs,
    intervalMs,
  });

  try {
    while (true) {
      const statusResult = await queryJobStatus(jobId);

      if (!statusResult.success) {
        return {
          success: false,
          error: statusResult.error,
        };
      }

      const status = statusResult.status;
      pollCount += 1;

      logger.debug(`[NFT Indexer] Poll #${pollCount}: status = ${status}`);

      const normalized = typeof status === 'string' ? status.toLowerCase() : '';

      // Indexer terminal-success states: both `completed` (older) and
      // `succeeded` (current pgmq convention) appear in the wild. Accepting
      // both prevents the CLI from polling-to-timeout on freshly-triggered
      // tokens, which was masking as "No tokens could be indexed" on the
      // first encounter while the underlying job had already finished.
      if (normalized === 'completed' || normalized === 'succeeded') {
        const elapsedMs = Date.now() - startTime;
        logger.info(`[NFT Indexer] ✓ Job ${normalized} after ${pollCount} polls (${elapsedMs}ms)`);
        return {
          success: true,
          completed: true,
          timedOut: false,
          status,
        };
      }

      if (normalized === 'failed') {
        const detail = statusResult.lastError ? `: ${statusResult.lastError}` : '';
        logger.warn(`[NFT Indexer] Job failed${detail}`);
        return {
          success: false,
          completed: false,
          timedOut: false,
          status,
          error: `Job failed${detail}`,
        };
      }

      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= timeoutMs) {
        logger.warn(
          `[NFT Indexer] Job polling timed out after ${pollCount} polls (${elapsedMs}ms)`
        );
        return {
          success: true,
          completed: false,
          timedOut: true,
          status,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } catch (error) {
    logger.debug('[NFT Indexer] Error during job polling:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Poll until token has `media_assets` from the indexer (renditions) or timeout.
 *
 * @param {string} tokenCID - Token CID in CAIP-2 format
 * @param {Object} [options]
 * @param {number} [options.intervalMs] - Delay between polls (default POLLING_INTERVAL_MS)
 * @param {number} [options.timeoutMs] - Max wall time (default POLLING_TIMEOUT_MS)
 * @returns {Promise<Object|null>} Token data when assets appear, null if timeout
 */
async function pollForMediaAssets(tokenCID, options = {}) {
  const intervalMs = options.intervalMs ?? POLLING_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? POLLING_TIMEOUT_MS;
  const startTime = Date.now();
  let pollCount = 0;

  logger.debug('[NFT Indexer] Starting metadata assets polling...', {
    tokenCID,
    timeoutMs,
    intervalMs,
  });

  try {
    while (true) {
      const tokenData = await queryTokenDataFromIndexer(tokenCID);

      pollCount += 1;

      // Indexer v2 exposes a single `media_assets` list (not legacy metadata_media_assets).
      if (tokenData && Array.isArray(tokenData.media_assets) && tokenData.media_assets.length > 0) {
        const elapsedMs = Date.now() - startTime;
        logger.info(`[NFT Indexer] ✓ Media assets found after ${pollCount} polls (${elapsedMs}ms)`);
        return tokenData;
      }

      logger.debug(`[NFT Indexer] Poll #${pollCount}: media_assets not yet available`);

      // Check timeout
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= timeoutMs) {
        logger.warn(
          `[NFT Indexer] Media assets polling timed out after ${pollCount} polls (${elapsedMs}ms). Using fallback URLs.`
        );
        return tokenData; // Return token data as-is, will use fallback URLs
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } catch (error) {
    logger.debug('[NFT Indexer] Error during media assets polling:', error.message);
    return null;
  }
}

/**
 * Search for NFTs by query
 * @param {Object} params - Search parameters
 * @param {string} params.query - Search query
 * @param {string} params.chain - Optional chain filter
 * @param {number} params.limit - Results limit
 * @returns {Promise<Object>} Search results
 */
async function searchNFTs(params) {
  const { query, chain, limit = 10 } = params;

  // TODO: Implement NFT search if indexer supports it

  logger.debug(`[NFT Indexer] Searching NFTs:`, { query, chain, limit });

  return {
    success: true,
    results: [],
    total: 0,
  };
}

/**
 * Query tokens owned by an address
 *
 * Fetches all tokens owned by a given address from the indexer.
 * Returns token data in a format suitable for conversion to DP1 items.
 *
 * @param {string} ownerAddress - Owner wallet address
 * @param {number} [limit=100] - Maximum number of tokens to fetch
 * @returns {Promise<Object>} Result with tokens array
 * @returns {boolean} returns.success - Whether query succeeded
 * @returns {Array} [returns.tokens] - Array of token data
 * @returns {string} [returns.error] - Error message if failed
 * @example
 * const result = await queryTokensByOwner('0x1234...', 50);
 * if (result.success) {
 *   console.log(`Found ${result.tokens.length} tokens`);
 * }
 */
/**
 * Query tokens owned by an address
 *
 * Convenience wrapper around queryTokens for owner-based queries.
 * Fetches all tokens owned by a given address from the indexer.
 * Supports pagination for fetching large collections.
 *
 * @param {string} ownerAddress - Owner wallet address
 * @param {number} [limit=100] - Maximum number of tokens to fetch per page
 * @param {number} [offset=0] - Offset for pagination
 * @returns {Promise<Object>} Result with tokens array
 * @returns {boolean} returns.success - Whether query succeeded
 * @returns {Array} [returns.tokens] - Array of token data
 * @returns {number} [returns.count] - Number of tokens found in this page
 * @returns {string} [returns.error] - Error message if failed
 * @example
 * // Fetch first page
 * const result = await queryTokensByOwner('0x1234...', 100, 0);
 * // Fetch second page
 * const result2 = await queryTokensByOwner('0x1234...', 100, 100);
 */
async function queryTokensByOwner(ownerAddress, limit = 100, offset = 0) {
  try {
    logger.info(`[NFT Indexer] Querying tokens by owner: ${ownerAddress}`);

    const tokens = await queryTokens({
      owners: [ownerAddress],
      limit,
      offset,
    });

    return {
      success: true,
      tokens,
    };
  } catch (error) {
    logger.error(`[NFT Indexer] Failed to query tokens by owner: ${error.message}`);
    return {
      success: false,
      tokens: [],
      error: error.message,
    };
  }
}

async function queryTokensByContract(contractAddress, limit = 100, offset = 0) {
  try {
    logger.info(`[NFT Indexer] Querying tokens by contract: ${contractAddress}`);

    const tokens = await queryTokens({
      contract_addresses: [contractAddress],
      limit,
      offset,
    });

    return {
      success: true,
      tokens,
    };
  } catch (error) {
    logger.error(`[NFT Indexer] Failed to query tokens by contract: ${error.message}`);
    return {
      success: false,
      tokens: [],
      error: error.message,
    };
  }
}

module.exports = {
  // Primary functions (return DP1 items)
  getNFTTokenInfo,
  // Batch processing
  getNFTTokenInfoBatch,
  resolveTokenBatch,
  // Single token processing
  getNFTTokenInfoSingle,
  // Additional functions
  getCollectionInfo,
  searchNFTs,
  triggerIndexingAsync,
  buildTokenCID,
  convertToDP1Item,
  // Address-based functions
  queryTokensByOwner,
  queryTokensByContract,
  // Unified GraphQL query
  queryTokens,
  // Job queue
  queryJobStatus,
  pollForJobCompletion,
  pollForMetadataAssets: pollForMediaAssets,
  // Export for testing
  queryTokenDataFromIndexer,
  mapIndexerDataToStandardFormat,
  detectTokenStandard,
  extractArtistName,
  getBestMediaUrl,
  // GraphQL documents (tests / contract stability)
  buildTokensListQuery,
  TRIGGER_TOKEN_INDEXING_MUTATION,
  JOB_STATUS_QUERY,
};
