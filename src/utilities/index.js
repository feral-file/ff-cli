/**
 * Utilities - Actual function implementations
 * Contains the real logic for querying NFTs and building playlists
 */

const chalk = require('chalk');
const nftIndexer = require('./nft-indexer');
const feedFetcher = require('./feed-fetcher');
const playlistBuilder = require('./playlist-builder');
const functions = require('./functions');
const domainResolver = require('./domain-resolver');
const logger = require('../logger');

const printedTokenCountKeys = new Set();

/**
 * Detect blockchain from contract address format.
 *
 * @param {string} contractAddress - Contract address
 * @returns {string} Chain name
 */
function detectChainFromContractAddress(contractAddress) {
  if (String(contractAddress || '').startsWith('KT')) {
    return 'tezos';
  }
  return 'ethereum';
}

/**
 * Convert indexer token rows to DP1 items.
 *
 * @param {Array<Object>} tokens - Raw indexer token rows
 * @param {number} duration - Duration per item in seconds
 * @returns {{ items: Array<Object>, skippedCount: number }} Converted items and skipped count
 */
function convertIndexerTokensToDP1Items(tokens, duration) {
  const items = [];
  let skippedCount = 0;

  for (const token of tokens) {
    const contractAddr = token.contract_address || token.contractAddress || '';
    const chain = detectChainFromContractAddress(contractAddr);
    const tokenData = nftIndexer.mapIndexerDataToStandardFormat(token, chain);

    if (tokenData.success) {
      const dp1Result = nftIndexer.convertToDP1Item(tokenData, duration);
      if (dp1Result.success && dp1Result.item) {
        items.push(dp1Result.item);
      } else if (!dp1Result.success) {
        skippedCount++;
      }
    }
  }

  return { items, skippedCount };
}

/**
 * Check if an address looks like an EVM address.
 *
 * @param {string} address - Address string
 * @returns {boolean} True when address matches 0x + 40 hex chars
 */
function isLikelyEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || ''));
}

/**
 * Query random tokens from a contract and convert to DP1 items.
 *
 * @param {string} contractAddress - Contract address
 * @param {number|string} [quantity] - Number of random tokens to select
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 * @returns {Promise<Array<Object>>} Array of DP1 items
 */
async function queryTokensByContractAddress(contractAddress, quantity, duration) {
  console.log(
    chalk.cyan(
      `   Fetching ${quantity || 100} random token(s) from contract ${contractAddress.substring(0, 10)}...`
    )
  );

  const limit = Math.min(quantity || 100, 100);
  const result = await nftIndexer.queryTokensByContract(contractAddress, limit);

  if (!result.success) {
    console.log(chalk.yellow(`   Could not fetch tokens from contract`));
    return [];
  }

  if (result.tokens.length === 0) {
    console.log(chalk.yellow(`   No tokens found in contract ${contractAddress}`));
    return [];
  }

  let selectedTokens = result.tokens;
  if (typeof quantity === 'number' && selectedTokens.length > quantity) {
    selectedTokens = shuffleArray([...selectedTokens]).slice(0, quantity);
  }

  console.log(chalk.dim(`   Got ${selectedTokens.length} token(s)`));

  const { items, skippedCount } = convertIndexerTokensToDP1Items(selectedTokens, duration);
  if (skippedCount > 0) {
    console.log(
      chalk.yellow(
        `   Skipped ${skippedCount} token(s) with invalid data (data URIs or URLs too long)`
      )
    );
  }

  return items;
}

/**
 * Initialize utilities with configuration
 *
 * The indexer now uses a hardcoded production endpoint, so no configuration is needed.
 * This function is kept for backwards compatibility.
 *
 * @param {Object} _config - Unused config parameter
 */
function initializeUtilities(_config) {
  nftIndexer.initializeIndexer();
}

/**
 * Query tokens from an owner address
 *
 * Fetches all tokens owned by an address, with optional random selection.
 * If no tokens found, instructs user to add address via Feral File mobile app.
 * Supports pagination to fetch all tokens when quantity is "all".
 *
 * @param {string} ownerAddress - Owner wallet address
 * @param {number|string} [quantity] - Number of random tokens to select, or "all" to fetch all tokens
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 * @returns {Promise<Array>} Array of DP1 playlist items
 */
async function queryTokensByAddress(ownerAddress, quantity, duration, options = {}) {
  try {
    const { suppressNotFoundGuidance = false } = options;
    const shouldFetchAll = quantity === 'all' || quantity === undefined || quantity === null;
    const batchSize = 50; // Fetch 50 tokens per page
    let allTokens = [];
    let offset = 0;
    let hasMore = true;

    // Fetch tokens with pagination if "all" is requested
    if (shouldFetchAll) {
      console.log(chalk.cyan(`   Fetching all tokens from ${ownerAddress}...`));

      while (hasMore) {
        const result = await nftIndexer.queryTokensByOwner(ownerAddress, batchSize, offset);

        if (!result.success) {
          if (offset === 0) {
            // First page failed
            console.log(chalk.yellow(`   Could not fetch tokens for ${ownerAddress}`));
            if (!suppressNotFoundGuidance) {
              console.log(
                chalk.cyan(
                  `   → Add this address in the Feral File mobile app, then try again with the CLI.`
                )
              );
            }
            return [];
          }
          // Subsequent pages failed - stop pagination but keep what we have
          hasMore = false;
          break;
        }

        if (result.tokens.length === 0) {
          // No more tokens
          hasMore = false;
          break;
        }

        allTokens = allTokens.concat(result.tokens);
        offset += batchSize;

        console.log(chalk.dim(`   → Fetched ${allTokens.length} tokens so far...`));

        // If we got fewer tokens than the batch size, we've reached the end
        if (result.tokens.length < batchSize) {
          hasMore = false;
        }
      }

      if (allTokens.length === 0 && offset === 0) {
        console.log(chalk.yellow(`   No tokens found for ${ownerAddress}`));
        if (!suppressNotFoundGuidance) {
          console.log(
            chalk.cyan(
              `   → Add this address in the Feral File mobile app, then try again with the CLI.`
            )
          );
        }
        return [];
      }
    } else {
      // Fetch specific quantity with single request
      const limit = Math.min(quantity, 100); // Cap at 100 per request
      const result = await nftIndexer.queryTokensByOwner(ownerAddress, limit);

      if (!result.success) {
        console.log(chalk.yellow(`   Could not fetch tokens for ${ownerAddress}`));
        if (!suppressNotFoundGuidance) {
          console.log(
            chalk.cyan(
              `   → Add this address in the Feral File mobile app, then try again with the CLI.`
            )
          );
        }
        return [];
      }

      if (result.tokens.length === 0) {
        console.log(chalk.yellow(`   No tokens found for ${ownerAddress}`));
        if (!suppressNotFoundGuidance) {
          console.log(
            chalk.cyan(
              `   → Add this address in the Feral File mobile app, then try again with the CLI.`
            )
          );
        }
        return [];
      }

      allTokens = result.tokens;
    }

    let selectedTokens = allTokens;

    // Apply quantity limit with random selection (only if numeric quantity specified)
    if (typeof quantity === 'number' && selectedTokens.length > quantity) {
      selectedTokens = shuffleArray([...selectedTokens]).slice(0, quantity);
    }

    const tokenCountKey = `${ownerAddress}|${quantity ?? 'all'}|${duration ?? 'auto'}`;
    if (!printedTokenCountKeys.has(tokenCountKey)) {
      console.log(chalk.dim(`Got ${selectedTokens.length} token(s)`));
      printedTokenCountKeys.add(tokenCountKey);
    }

    const { items, skippedCount } = convertIndexerTokensToDP1Items(selectedTokens, duration);

    if (skippedCount > 0) {
      console.log(
        chalk.yellow(
          `   Skipped ${skippedCount} token(s) with invalid data (data URIs or URLs too long)`
        )
      );
    }

    return items;
  } catch (error) {
    console.error(chalk.red(`   Error: ${error.message}\n`));
    throw error;
  }
}

/**
 * Query data for a single requirement (handles build_playlist, fetch_feed, and query_address)
 *
 * @param {Object} requirement - Requirement object
 * @param {string} requirement.type - Requirement type (build_playlist, fetch_feed, or query_address)
 * @param {string} [requirement.blockchain] - Blockchain network (for build_playlist)
 * @param {string} [requirement.contractAddress] - Contract address (for build_playlist)
 * @param {Array<string>} [requirement.tokenIds] - Token IDs (for build_playlist)
 * @param {string} [requirement.ownerAddress] - Owner address (for query_address)
 * @param {string} [requirement.playlistName] - Feed playlist name (for fetch_feed)
 * @param {number} [requirement.quantity] - Number of items
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 * @returns {Promise<Array>} Array of DP1 playlist items
 */
async function queryRequirement(requirement, duration) {
  const {
    type,
    blockchain,
    contractAddress,
    tokenIds,
    ownerAddress,
    playlistName,
    quantity,
    artworkId,
  } = requirement;

  // Handle query_address type
  if (type === 'query_address') {
    // Check if ownerAddress is a domain name (.eth or .tez)
    if (ownerAddress && (ownerAddress.endsWith('.eth') || ownerAddress.endsWith('.tez'))) {
      logger.verbose(chalk.cyan(`\nResolving domain ${ownerAddress}...`));

      const resolution = await domainResolver.resolveDomain(ownerAddress);

      if (resolution.resolved && resolution.address) {
        console.log(chalk.green(`${resolution.domain} → ${resolution.address}`));
        // Use resolved address instead of domain
        return await queryTokensByAddress(resolution.address, quantity, duration);
      } else {
        console.log(
          chalk.red(
            `  Could not resolve domain ${ownerAddress}: ${resolution.error || 'Unknown error'}`
          )
        );
        return [];
      }
    } else {
      const isEvmAddress = isLikelyEvmAddress(ownerAddress);
      const ownerItems = await queryTokensByAddress(ownerAddress, quantity, duration, {
        suppressNotFoundGuidance: isEvmAddress,
      });

      if (ownerItems.length > 0) {
        return ownerItems;
      }

      if (isEvmAddress) {
        console.log(chalk.cyan(`   No owned tokens found. Trying this address as a contract...`));
        const contractItems = await queryTokensByContractAddress(ownerAddress, quantity, duration);
        if (contractItems.length > 0) {
          return contractItems;
        }
        console.log(
          chalk.cyan(
            `   → Add this address in the Feral File mobile app, then try again with the CLI.`
          )
        );
      }

      return [];
    }
  }

  // Handle fetch_feed type
  if (type === 'fetch_feed') {
    console.log(chalk.cyan(`Getting items from "${playlistName}"...`));

    const result = await feedFetcher.fetchFeedPlaylistDirect(playlistName, quantity, duration);

    if (result.success && result.items) {
      return result.items;
    } else {
      console.log(
        chalk.yellow(`   Could not fetch playlist: ${result.error || 'No items found'}\n`)
      );
      return [];
    }
  }

  if (type === 'feral_file_artwork') {
    console.log(chalk.cyan(`Resolving Feral File artwork ${artworkId}...`));
    const { parseFeralFileArtworkId, resolveFeralFileArtwork } = require('./feral-file-artwork');
    const coords = await resolveFeralFileArtwork(parseFeralFileArtworkId(artworkId));
    const items = await nftIndexer.getNFTTokenInfoBatch([coords], duration);
    if (items.length > 0) {
      console.log(chalk.green(`✓ Got ${items.length} item(s)`));
    } else {
      console.log(chalk.yellow('   No items found for Feral File artwork'));
    }
    return items;
  }

  // Handle build_playlist type (original NFT querying logic)

  console.log(
    chalk.cyan(
      `Querying ${blockchain}${contractAddress ? ' (' + contractAddress.substring(0, 10) + '...)' : ''}...`
    )
  );

  let items = [];

  try {
    // Check if we're querying by contract (no specific token IDs) or by specific token IDs
    const isContractQuery = contractAddress && (!tokenIds || tokenIds.length === 0);

    if (isContractQuery) {
      const contractItems = await queryTokensByContractAddress(contractAddress, quantity, duration);
      if (contractItems.length > 0) {
        return contractItems;
      }
      console.log(chalk.cyan(`   → Trying as owner address instead...`));
      return await queryTokensByAddress(contractAddress, quantity, duration);
    }

    // Handle specific token IDs (original logic)
    if (blockchain.toLowerCase() === 'tezos') {
      // Tezos NFTs
      if (tokenIds && tokenIds.length > 0) {
        const tokens = tokenIds.map((tokenId) => ({
          chain: 'tezos',
          contractAddress,
          tokenId,
        }));
        items = await nftIndexer.getNFTTokenInfoBatch(tokens, duration);
      } else {
        console.log(chalk.yellow('   No token IDs specified'));
      }
    } else if (blockchain.toLowerCase() === 'ethereum' || blockchain.toLowerCase() === 'eth') {
      // Ethereum NFTs (including Art Blocks, Feral File, etc.)
      if (contractAddress && tokenIds && tokenIds.length > 0) {
        const tokens = tokenIds.map((tokenId) => ({
          chain: 'ethereum',
          contractAddress,
          tokenId,
        }));
        items = await nftIndexer.getNFTTokenInfoBatch(tokens, duration);
      } else {
        console.log(chalk.yellow('   Contract address and token IDs required'));
      }
    } else {
      console.log(chalk.yellow(`   Unsupported blockchain: ${blockchain}`));
    }

    if (items.length > 0) {
      console.log(chalk.green(`✓ Got ${items.length} item(s)`));
    } else {
      console.log(
        chalk.yellow(
          `   No items found. Check token IDs, contract address, or try querying by owner address.`
        )
      );
    }

    // Apply quantity limit
    if (quantity && items.length > quantity) {
      items = items.slice(0, quantity);
    }
  } catch (error) {
    console.error(chalk.red(`   Error: ${error.message}\n`));
    throw error;
  }

  return items;
}

/**
 * Build DP1 playlist from items
 *
 * Uses the core playlist-builder utility to create a DP1 v1.0.0 compliant playlist.
 *
 * @param {Array<Object>} items - Array of DP1 playlist items
 * @param {string} [title] - Playlist title
 * @param {string} [slug] - Playlist slug
 * @returns {Promise<Object>} DP1 playlist
 * @example
 * const playlist = await buildDP1Playlist(items, 'My Playlist', 'my-playlist');
 */
async function buildDP1Playlist(items, title, slug) {
  return await playlistBuilder.buildDP1Playlist({ items, title, slug });
}

/**
 * Send playlist to FF1 device
 *
 * This gateway verifies the playlist before any device transport happens.
 * Callers in the AI orchestrator and deterministic build path both route
 * through here, so the delivery policy stays consistent across the CLI.
 * TODO: Propagate structured send failures consistently from every caller;
 * buildPlaylistDirect currently preserves the pre-existing non-fatal behavior.
 *
 * @param {Object} playlist - DP1 playlist
 * @param {string} [deviceName] - Device name
 * @returns {Promise<Object>} Result
 */
async function sendToDevice(playlist, deviceName) {
  const playlistVerifier = await import('./playlist-verifier');
  const verifyPlaylist =
    playlistVerifier.verifyPlaylist ||
    (playlistVerifier.default && playlistVerifier.default.verifyPlaylist) ||
    playlistVerifier.default;

  if (typeof verifyPlaylist !== 'function') {
    return {
      success: false,
      error: 'Playlist verifier is not available',
    };
  }

  const verificationResult = await verifyPlaylist(playlist);

  if (!verificationResult.valid) {
    return {
      success: false,
      error: verificationResult.error || 'Failed to verify playlist before sending',
      details: verificationResult.details
        ? verificationResult.details
            .map((detail) => `• ${detail.path}: ${detail.message}`)
            .join('\n')
        : undefined,
    };
  }

  const { sendPlaylistToDevice } = require('./functions');
  return await sendPlaylistToDevice({ playlist, deviceName });
}

/**
 * Shuffle array using Fisher-Yates algorithm
 *
 * @param {Array} array - Array to shuffle
 * @returns {Array} Shuffled array
 */
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Build playlist directly from requirements (deterministic, no AI)
 *
 * TODO: Treat requested device send and feed publish failures consistently.
 * This function currently keeps the pre-existing main-branch behavior where
 * send/publish failures are non-fatal to the playlist build; fix that in a
 * dedicated follow-up when the command contract changes.
 *
 * @param {Object} params - Playlist parameters
 * @param {Array<Object>} params.requirements - Array of requirements
 * @param {Object} params.playlistSettings - Playlist settings
 * @param {Object} options - Build options
 * @param {boolean} [options.verbose] - Verbose output
 * @param {string} [options.outputPath] - Output file path
 * @returns {Promise<Object>} Result with playlist
 */
async function buildPlaylistDirect(params, options = {}) {
  const { requirements, playlistSettings } = params;
  const { verbose = false, outputPath = 'playlist.json' } = options;

  const allItems = [];
  // Undefined means auto timing: video/audio items omit duration and play
  // their natural length (DP-1 §4.1); static items get the configured default.
  const duration = playlistSettings.durationPerItem;

  console.log(chalk.cyan('\nBuilding playlist from your requirements...\n'));

  // Process each requirement
  for (let i = 0; i < requirements.length; i++) {
    const requirement = requirements[i];
    const reqNum = i + 1;

    console.log(
      chalk.cyan(`[${reqNum}/${requirements.length}] ${requirement.blockchain || 'Source'}`)
    );

    try {
      const items = await queryRequirement(requirement, duration);
      allItems.push(...items);
    } catch (error) {
      console.error(chalk.red(`  Failed: ${error.message}`));
      if (verbose) {
        console.error(chalk.dim(error.stack));
      }
    }
  }

  if (allItems.length === 0) {
    throw new Error('No items collected from any requirement');
  }

  // Apply ordering
  let finalItems = allItems;
  if (!playlistSettings.preserveOrder) {
    console.log(chalk.cyan('Shuffling items...'));
    finalItems = shuffleArray([...allItems]);
  }

  console.log(
    chalk.cyan(
      `Creating playlist with ${finalItems.length} ${finalItems.length === 1 ? 'item' : 'items'}...`
    )
  );

  // Build DP1 playlist
  const playlist = await buildDP1Playlist(
    finalItems,
    playlistSettings.title,
    playlistSettings.slug
  );

  // Save playlist to file
  const { savePlaylist } = require('../utils');
  const savedPath = await savePlaylist(playlist, outputPath);
  console.log(chalk.green(`✓ Playlist ready: ${savedPath}`));

  // Send to device if requested
  if (playlistSettings.deviceName !== undefined) {
    console.log(chalk.cyan('\nSending to device...'));
    await sendToDevice(playlist, playlistSettings.deviceName);
  }

  // Publish to feed server if requested
  let publishResult = null;
  if (playlistSettings.feedServer) {
    console.log(chalk.cyan('\nPublishing to feed server...'));
    try {
      const { publishPlaylist } = require('./playlist-publisher');
      publishResult = await publishPlaylist(
        savedPath,
        playlistSettings.feedServer.baseUrl,
        playlistSettings.feedServer.apiKey
      );

      if (publishResult.success) {
        console.log(chalk.green(`✓ Published to feed server`));
        if (publishResult.playlistId) {
          console.log(chalk.dim(`   Playlist ID: ${publishResult.playlistId}`));
        }
        if (publishResult.feedServer) {
          console.log(chalk.dim(`   Server: ${publishResult.feedServer}`));
        }
      } else {
        console.error(chalk.red(`Publish failed: ${publishResult.error}`));
        if (publishResult.message) {
          console.error(chalk.dim(`   ${publishResult.message}`));
        }
      }
    } catch (error) {
      console.error(chalk.red(`Publish failed: ${error.message}`));
      if (verbose) {
        console.error(chalk.dim(error.stack));
      }
    }
  }

  return {
    playlist,
    published: publishResult?.success || false,
    publishResult,
  };
}

module.exports = {
  initializeUtilities,
  queryRequirement,
  queryTokensByAddress,
  buildDP1Playlist,
  sendToDevice,
  resolveDomains: functions.resolveDomains,
  shuffleArray,
  buildPlaylistDirect,
  feedFetcher,
  // Export core playlist builder utilities
  playlistBuilder,
};
