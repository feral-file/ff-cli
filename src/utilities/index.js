/**
 * Utilities - Actual function implementations
 * Contains the real logic for querying NFTs and building playlists.
 *
 * Token data comes from the configured token source (token-source.ts):
 * Raster by default, the deprecated Feral File indexer when
 * `tokenSource: "indexer"` is set. This module never names a vendor except to
 * phrase guidance that only makes sense for one of them.
 */

const chalk = require('chalk');
const feedFetcher = require('./feed-fetcher');
const playlistBuilder = require('./playlist-builder');
const functions = require('./functions');
const domainResolver = require('./domain-resolver');
const logger = require('../logger');
const {
  getTokenSource,
  itemsOf,
  failureMessages,
  TokenSourceCapabilityError,
} = require('./token-source');

const printedTokenCountKeys = new Set();

/** Per-request cap every bounded listing has always applied. */
const MAX_LISTING = 100;

/**
 * The indexer only knows wallets someone added in the Feral File app, so an
 * empty answer there means "not added yet". Raster is pre-indexed, so the
 * same advice would be wrong for it.
 */
const ADD_ADDRESS_GUIDANCE =
  '   → Add this address in the Feral File mobile app, then try again with the CLI.';

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
 * printAddressGuidance prints the add-in-app hint, only where it applies.
 *
 * @param {Object} source - Active token source
 * @param {boolean} suppress - Caller will try another lookup first
 */
function printAddressGuidance(source, suppress) {
  if (!suppress && source.name === 'indexer') {
    console.log(chalk.cyan(ADD_ADDRESS_GUIDANCE));
  }
}

/**
 * pickResults applies a numeric quantity as a random selection.
 *
 * @param {Array<Object>} results - Listing results
 * @param {number|string} [quantity] - Count, or "all"/undefined for everything
 * @returns {Array<Object>} Selected results
 */
function pickResults(results, quantity) {
  if (typeof quantity === 'number' && results.length > quantity) {
    return shuffleArray([...results]).slice(0, quantity);
  }
  return results;
}

/**
 * reportSkips prints how many listed tokens produced no item, and why.
 *
 * @param {Array<Object>} results - Results that were converted
 * @param {number} skippedUnsupported - Tokens dropped for an unsupported chain
 */
function reportSkips(results, skippedUnsupported) {
  const failed = results.filter((result) => !result.success).length;
  if (failed > 0) {
    console.log(chalk.yellow(`   Skipped ${failed} token(s) that could not be built into items`));
    for (const message of failureMessages(results)) {
      console.log(chalk.dim(`     ${message}`));
    }
  }
  if (skippedUnsupported > 0) {
    console.log(
      chalk.yellow(
        `   Skipped ${skippedUnsupported} token(s) on chains other than Ethereum and Tezos mainnet`
      )
    );
  }
}

/**
 * Query random tokens from a contract and convert to DP-1 items.
 *
 * A source that cannot list contracts (Raster) throws
 * TokenSourceCapabilityError, which is deliberately not caught here: the
 * requirement fails with that message instead of quietly building nothing.
 *
 * @param {string} contractAddress - Contract address
 * @param {number|string} [quantity] - Number of random tokens to select
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 * @param {Object} source - Active token source
 * @returns {Promise<Array<Object>>} Array of DP-1 items
 */
async function queryTokensByContractAddress(contractAddress, quantity, duration, source) {
  console.log(
    chalk.cyan(
      `   Fetching ${quantity || MAX_LISTING} random token(s) from contract ${contractAddress.substring(0, 10)}...`
    )
  );
  const limit = Math.min(typeof quantity === 'number' ? quantity : MAX_LISTING, MAX_LISTING);
  let listing;
  try {
    listing = await source.listTokensByContract(contractAddress, { limit, duration });
  } catch (error) {
    if (error instanceof TokenSourceCapabilityError) {
      throw error;
    }
    console.log(chalk.yellow(`   Could not fetch tokens from contract: ${error.message}`));
    return [];
  }
  if (listing.results.length === 0) {
    console.log(chalk.yellow(`   No tokens found in contract ${contractAddress}`));
    return [];
  }
  const selected = pickResults(listing.results, quantity);
  console.log(chalk.dim(`   Got ${selected.length} token(s)`));
  reportSkips(selected, listing.skippedUnsupported);
  return itemsOf(selected);
}

/**
 * Query tokens from an owner address.
 *
 * Fetches the tokens an address holds through the active token source, with
 * optional random selection. `quantity` of "all" (or none) walks the whole
 * wallet; a number stops early and samples from what was fetched.
 *
 * @param {string} ownerAddress - Owner wallet address
 * @param {number|string} [quantity] - Number of random tokens to select, or "all"
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 * @param {Object} [options]
 * @param {boolean} [options.suppressNotFoundGuidance] - Caller will try another lookup
 * @param {Object} [source] - Token source; defaults to the configured one
 * @returns {Promise<Array>} Array of DP-1 playlist items
 */
async function queryTokensByAddress(
  ownerAddress,
  quantity,
  duration,
  options = {},
  source = getTokenSource()
) {
  const { suppressNotFoundGuidance = false } = options;
  const fetchAll = quantity === 'all' || quantity === undefined || quantity === null;
  const limit = fetchAll ? 'all' : Math.min(quantity, MAX_LISTING);
  if (fetchAll) {
    console.log(chalk.cyan(`   Fetching all tokens from ${ownerAddress}...`));
  }

  let listing;
  try {
    listing = await source.listTokensByOwner(ownerAddress, { limit, duration });
  } catch (error) {
    console.log(chalk.yellow(`   Could not fetch tokens for ${ownerAddress}: ${error.message}`));
    printAddressGuidance(source, suppressNotFoundGuidance);
    return [];
  }
  if (listing.results.length === 0) {
    console.log(chalk.yellow(`   No tokens found for ${ownerAddress}`));
    reportSkips([], listing.skippedUnsupported);
    printAddressGuidance(source, suppressNotFoundGuidance);
    return [];
  }

  const selected = pickResults(listing.results, quantity);
  const tokenCountKey = `${ownerAddress}|${quantity ?? 'all'}|${duration ?? 'auto'}`;
  if (!printedTokenCountKeys.has(tokenCountKey)) {
    console.log(chalk.dim(`Got ${selected.length} token(s)`));
    printedTokenCountKeys.add(tokenCountKey);
  }
  reportSkips(selected, listing.skippedUnsupported);
  return itemsOf(selected);
}

/**
 * resolveCoordinates builds items for explicit coordinates and reports misses.
 *
 * @param {Array<Object>} coords - Token coordinates
 * @param {number} [duration] - Explicit display seconds
 * @param {Object} source - Active token source
 * @returns {Promise<Array<Object>>} DP-1 items for the resolved coordinates
 */
async function resolveCoordinates(coords, duration, source) {
  const results = await source.resolveTokens(coords, { duration });
  for (const message of failureMessages(results)) {
    console.log(chalk.dim(`   ${message}`));
  }
  return itemsOf(results);
}

/**
 * queryOwnerRequirement handles a query_address requirement.
 *
 * An EVM address that holds nothing may be a contract, so the contract
 * listing is tried next. On a source that cannot list contracts the user is
 * told so, rather than shown an unexplained empty result.
 *
 * @param {string} ownerAddress - Address or .eth/.tez domain
 * @param {number|string} [quantity] - Count or "all"
 * @param {number} [duration] - Explicit display seconds
 * @param {Object} source - Active token source
 * @returns {Promise<Array<Object>>} DP-1 items
 */
async function queryOwnerRequirement(ownerAddress, quantity, duration, source) {
  if (ownerAddress && (ownerAddress.endsWith('.eth') || ownerAddress.endsWith('.tez'))) {
    logger.verbose(chalk.cyan(`\nResolving domain ${ownerAddress}...`));
    const resolution = await domainResolver.resolveDomain(ownerAddress);
    if (!resolution.resolved || !resolution.address) {
      console.log(
        chalk.red(
          `  Could not resolve domain ${ownerAddress}: ${resolution.error || 'Unknown error'}`
        )
      );
      return [];
    }
    console.log(chalk.green(`${resolution.domain} → ${resolution.address}`));
    return await queryTokensByAddress(resolution.address, quantity, duration, {}, source);
  }

  const isEvmAddress = isLikelyEvmAddress(ownerAddress);
  const ownerItems = await queryTokensByAddress(
    ownerAddress,
    quantity,
    duration,
    { suppressNotFoundGuidance: isEvmAddress },
    source
  );
  if (ownerItems.length > 0 || !isEvmAddress) {
    return ownerItems;
  }

  console.log(chalk.cyan(`   No owned tokens found. Trying this address as a contract...`));
  try {
    const contractItems = await queryTokensByContractAddress(
      ownerAddress,
      quantity,
      duration,
      source
    );
    if (contractItems.length > 0) {
      return contractItems;
    }
  } catch (error) {
    if (!(error instanceof TokenSourceCapabilityError)) {
      throw error;
    }
    console.log(chalk.yellow(`   ${error.message}`));
    return [];
  }
  printAddressGuidance(source, false);
  return [];
}

/**
 * queryTokenIdsRequirement handles a build_playlist requirement.
 *
 * With token ids, the coordinates are resolved directly. Without them the
 * contract is listed; a source that cannot list contracts fails the
 * requirement with its reason (no owner-address guess on that path).
 *
 * @param {Object} requirement - build_playlist requirement
 * @param {number} [duration] - Explicit display seconds
 * @param {Object} source - Active token source
 * @returns {Promise<Array<Object>>} DP-1 items
 */
async function queryTokenIdsRequirement(requirement, duration, source) {
  const { blockchain, contractAddress, tokenIds, quantity } = requirement;
  console.log(
    chalk.cyan(
      `Querying ${blockchain}${contractAddress ? ' (' + contractAddress.substring(0, 10) + '...)' : ''}...`
    )
  );

  if (contractAddress && (!tokenIds || tokenIds.length === 0)) {
    const contractItems = await queryTokensByContractAddress(
      contractAddress,
      quantity,
      duration,
      source
    );
    if (contractItems.length > 0) {
      return contractItems;
    }
    console.log(chalk.cyan(`   → Trying as owner address instead...`));
    return await queryTokensByAddress(contractAddress, quantity, duration, {}, source);
  }

  const chain = String(blockchain || '').toLowerCase();
  const knownChain =
    chain === 'tezos' ? 'tezos' : chain === 'ethereum' || chain === 'eth' ? 'ethereum' : '';
  if (!knownChain) {
    console.log(chalk.yellow(`   Unsupported blockchain: ${blockchain}`));
    return [];
  }
  if (!contractAddress || !tokenIds || tokenIds.length === 0) {
    console.log(chalk.yellow('   Contract address and token IDs required'));
    return [];
  }

  const coords = tokenIds.map((tokenId) => ({ chain: knownChain, contractAddress, tokenId }));
  let items = await resolveCoordinates(coords, duration, source);
  if (items.length > 0) {
    console.log(chalk.green(`✓ Got ${items.length} item(s)`));
  } else {
    console.log(
      chalk.yellow(
        `   No items found. Check token IDs, contract address, or try querying by owner address.`
      )
    );
  }
  if (quantity && items.length > quantity) {
    items = items.slice(0, quantity);
  }
  return items;
}

/**
 * Query data for a single requirement (build_playlist, fetch_feed,
 * query_address, or feral_file_artwork).
 *
 * @param {Object} requirement - Requirement object
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 * @param {Object} [source] - Token source; defaults to the configured one.
 *   buildPlaylistDirect passes one so a whole build uses one vendor.
 * @returns {Promise<Array>} Array of DP-1 playlist items
 */
async function queryRequirement(requirement, duration, source = getTokenSource()) {
  const { type, ownerAddress, playlistName, quantity, artworkId } = requirement;

  if (type === 'query_address') {
    return await queryOwnerRequirement(ownerAddress, quantity, duration, source);
  }

  if (type === 'fetch_feed') {
    console.log(chalk.cyan(`Getting items from "${playlistName}"...`));
    const result = await feedFetcher.fetchFeedPlaylistDirect(playlistName, quantity, duration);
    if (result.success && result.items) {
      return result.items;
    }
    console.log(chalk.yellow(`   Could not fetch playlist: ${result.error || 'No items found'}\n`));
    return [];
  }

  if (type === 'feral_file_artwork') {
    console.log(chalk.cyan(`Resolving Feral File artwork ${artworkId}...`));
    const { parseFeralFileArtworkId, resolveFeralFileArtwork } = require('./feral-file-artwork');
    const coords = await resolveFeralFileArtwork(parseFeralFileArtworkId(artworkId));
    const items = await resolveCoordinates([coords], duration, source);
    if (items.length > 0) {
      console.log(chalk.green(`✓ Got ${items.length} item(s)`));
    } else {
      console.log(chalk.yellow('   No items found for Feral File artwork'));
    }
    return items;
  }

  try {
    return await queryTokenIdsRequirement(requirement, duration, source);
  } catch (error) {
    // A capability error is already a complete sentence that the build loop
    // prints as the requirement's failure; printing it here too doubles it.
    if (!(error instanceof TokenSourceCapabilityError)) {
      console.error(chalk.red(`   Error: ${error.message}\n`));
    }
    throw error;
  }
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
  const playlistVerifier = await import('./playlist-verifier.js');
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

  // One provider for the whole build, so every requirement comes from the
  // same vendor and the indexer deprecation warning prints once.
  const source = getTokenSource();

  // Process each requirement
  for (let i = 0; i < requirements.length; i++) {
    const requirement = requirements[i];
    const reqNum = i + 1;

    console.log(
      chalk.cyan(`[${reqNum}/${requirements.length}] ${requirement.blockchain || 'Source'}`)
    );

    try {
      const items = await queryRequirement(requirement, duration, source);
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
      publishResult = await publishPlaylist(savedPath, playlistSettings.feedServer.baseUrl);

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
