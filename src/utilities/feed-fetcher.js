/**
 * DP1 Feed Fetcher
 * Utilities to fetch playlists from DP1 Feed API
 * API: https://github.com/display-protocol/dp1-feed
 */

const { fetchWithTimeout } = require('./http');
const chalk = require('chalk');
const fuzzysort = require('fuzzysort');
const { getFeedConfig } = require('../config');

/**
 * Get feed API base URLs from configuration
 *
 * @returns {string[]} Array of feed API base URLs
 */
function getFeedApiUrls() {
  const feedConfig = getFeedConfig();
  return feedConfig.baseURLs;
}

/**
 * Build a concise feed reachability error message.
 *
 * @param {Array<string>} failedFeeds - Feed URLs that could not be reached
 * @returns {string} Human-readable error message
 */
function buildFeedUnreachableError(failedFeeds = []) {
  const failedCount = Array.isArray(failedFeeds) ? failedFeeds.length : 0;
  if (failedCount === 0) {
    return 'No reachable feed servers available';
  }

  if (failedCount === 1) {
    return `Configured feed server is unreachable: ${failedFeeds[0]}`;
  }

  return `All configured feed servers are unreachable (${failedCount}): ${failedFeeds.join(', ')}`;
}

/**
 * Fetch playlists from a single feed URL with pagination
 *
 * @param {string} feedUrl - Feed API base URL
 * @param {number} limit - Items per page (default: 50, max: 100)
 * @returns {Promise<Object>} Result with playlists and reachability
 */
async function fetchPlaylistsFromFeed(feedUrl, limit = 100) {
  try {
    // API has a maximum limit of 100
    const validLimit = Math.min(limit, 100);
    const response = await fetchWithTimeout(
      `${feedUrl}/playlists?limit=${validLimit}&sort=-created`
    );

    if (!response.ok) {
      console.log(chalk.yellow(`  Feed ${feedUrl} returned ${response.status}`));
      return {
        playlists: [],
        reachable: false,
        feedUrl,
        error: `HTTP ${response.status}`,
      };
    }

    const data = await response.json();
    const playlists = data.items || [];

    // Add feedUrl to each playlist for tracking
    return {
      playlists: playlists.map((p) => ({
        ...p,
        feedUrl,
      })),
      reachable: true,
      feedUrl,
      error: null,
    };
  } catch (error) {
    console.log(chalk.yellow(`  Failed to fetch from ${feedUrl}: ${error.message}`));
    return {
      playlists: [],
      reachable: false,
      feedUrl,
      error: error.message,
    };
  }
}

/**
 * Fetch playlists with pagination and fuzzy filtering to save memory
 *
 * @param {string} feedUrl - Feed API base URL
 * @param {string} searchTerm - Search term for fuzzy filtering
 * @param {number} pageSize - Items per page (default: 50, max: 100)
 * @param {number} topN - Keep top N matches per page (default: 10)
 * @param {number} maxItems - Maximum total items to fetch (default: 500)
 * @returns {Promise<Object>} Result with matches and reachability
 */
async function fetchPlaylistsWithPagination(
  feedUrl,
  searchTerm,
  pageSize = 50,
  topN = 10,
  maxItems = 500
) {
  const allMatches = [];
  let reachable = false;
  let offset = 0;
  let hasMore = true;
  let totalFetched = 0;

  while (hasMore && totalFetched < maxItems) {
    // Calculate limit for this page (might be less than pageSize on last page)
    // API has a maximum limit of 100
    const remainingItems = maxItems - totalFetched;
    const currentLimit = Math.min(pageSize, remainingItems, 100);

    try {
      const response = await fetchWithTimeout(
        `${feedUrl}/playlists?limit=${currentLimit}&offset=${offset}&sort=-created`
      );
      reachable = true;

      if (!response.ok) {
        if (response.status === 404 || response.status === 400) {
          // No more pages or offset not supported
          hasMore = false;
          break;
        }
        break;
      }

      const data = await response.json();
      const playlists = data.items || [];

      if (playlists.length === 0) {
        hasMore = false;
        break;
      }

      totalFetched += playlists.length;

      // Extract titles for fuzzy matching
      const titles = playlists.map((p) => p.title);

      // Fuzzy match on this page
      const results = fuzzysort.go(searchTerm, titles, {
        threshold: -5000, // More lenient threshold
        limit: topN, // Keep only top N per page
      });

      // Map results back to playlist objects
      results.forEach((result) => {
        const playlist = playlists.find((p) => p.title === result.target);
        if (playlist) {
          allMatches.push({
            title: playlist.title,
            id: playlist.id,
            feedUrl,
            score: result.score,
          });
        }
      });

      // Check if we've reached the end
      if (playlists.length < currentLimit) {
        hasMore = false;
      } else {
        offset += playlists.length;
      }
    } catch (_error) {
      hasMore = false;
    }
  }

  return {
    matches: allMatches,
    reachable,
    feedUrl,
  };
}

/**
 * Fetch all playlists from all configured feeds
 *
 * @returns {Promise<Object>} Playlists with feed reachability metadata
 */
async function fetchAllPlaylists() {
  const feedUrls = getFeedApiUrls();

  // Fetch playlists from all feeds in parallel
  const feedResults = await Promise.all(feedUrls.map((url) => fetchPlaylistsFromFeed(url)));

  const playlists = feedResults.flatMap((result) => result.playlists || []);
  const reachableFeeds = feedResults
    .filter((result) => result.reachable)
    .map((result) => result.feedUrl);
  const unreachableFeeds = feedResults
    .filter((result) => !result.reachable)
    .map((result) => result.feedUrl);

  return {
    playlists,
    reachableFeeds,
    unreachableFeeds,
  };
}

/**
 * Search for exact playlist match by name across multiple feeds
 *
 * @param {string} playlistName - Exact playlist name to search for
 * @returns {Promise<Object>} Search result with playlist or error
 */
async function searchExactPlaylist(playlistName) {
  try {
    const { playlists, reachableFeeds, unreachableFeeds } = await fetchAllPlaylists();

    if (reachableFeeds.length === 0) {
      return {
        success: false,
        errorType: 'feed_unreachable',
        error: buildFeedUnreachableError(unreachableFeeds),
      };
    }

    if (playlists.length === 0) {
      return {
        success: false,
        errorType: 'playlist_not_found',
        error: `No playlists available in reachable feed server(s) for "${playlistName}"`,
      };
    }

    // Find exact match (case-insensitive)
    const normalizedSearchName = playlistName.toLowerCase().trim();
    const exactMatch = playlists.find((p) => p.title.toLowerCase().trim() === normalizedSearchName);

    if (exactMatch) {
      // Fetch full playlist details
      const playlist = await getPlaylistById(exactMatch.id, exactMatch.feedUrl);
      return {
        success: true,
        playlist,
      };
    } else {
      return {
        success: false,
        errorType: 'playlist_not_found',
        error: `No exact match found for playlist "${playlistName}"`,
      };
    }
  } catch (error) {
    return {
      success: false,
      errorType: 'feed_unreachable',
      error: error.message,
    };
  }
}

/**
 * Find the best matching playlist using fuzzy string matching with pagination
 *
 * @param {string} searchTerm - Search term to match against
 * @returns {Promise<Object>} Result with best matching playlist name and map
 */
async function findBestMatchingPlaylist(searchTerm) {
  try {
    const feedUrls = getFeedApiUrls();

    // Fetch from all feeds in parallel with pagination and filtering
    const allMatchesResults = await Promise.all(
      feedUrls.map((url) => fetchPlaylistsWithPagination(url, searchTerm, 50, 10))
    );

    const reachableFeeds = allMatchesResults
      .filter((result) => result.reachable)
      .map((result) => result.feedUrl);
    const unreachableFeeds = allMatchesResults
      .filter((result) => !result.reachable)
      .map((result) => result.feedUrl);

    if (reachableFeeds.length === 0) {
      return {
        success: false,
        errorType: 'feed_unreachable',
        error: buildFeedUnreachableError(unreachableFeeds),
      };
    }

    // Flatten and combine results from all feeds
    const allMatches = allMatchesResults.flatMap((result) => result.matches || []);

    if (allMatches.length === 0) {
      return {
        success: false,
        errorType: 'playlist_not_found',
        error: `No matching playlists found for "${searchTerm}"`,
      };
    }

    // Sort by score (highest first) and get best match
    allMatches.sort((a, b) => b.score - a.score);

    // Build playlistMap for ID lookup
    const playlistMap = {};
    allMatches.forEach((match) => {
      playlistMap[match.title] = {
        id: match.id,
        feedUrl: match.feedUrl,
      };
    });

    const bestMatch = allMatches[0].title;

    // Simplified output: only show the best match, not all alternatives
    console.log(chalk.green(`✓ Found: "${bestMatch}"`));

    return {
      success: true,
      bestMatch,
      playlistMap,
      allMatches: allMatches.map((m) => m.title),
    };
  } catch (error) {
    return {
      success: false,
      errorType: 'feed_unreachable',
      error: error.message,
    };
  }
}

/**
 * Get playlist by ID or slug from a specific feed or try all feeds
 *
 * @param {string} idOrSlug - Playlist ID (UUID) or slug
 * @param {string} [feedUrl] - Optional specific feed URL to use
 * @returns {Promise<Object>} Playlist object
 */
async function getPlaylistById(idOrSlug, feedUrl = null) {
  try {
    const feedUrls = feedUrl ? [feedUrl] : getFeedApiUrls();

    // Try each feed URL until we find the playlist
    for (const url of feedUrls) {
      try {
        const response = await fetchWithTimeout(`${url}/playlists/${idOrSlug}`);

        if (response.ok) {
          const playlist = await response.json();
          return playlist;
        }
      } catch (_error) {
        // Continue to next feed
        continue;
      }
    }

    throw new Error(`Playlist "${idOrSlug}" not found in any feed`);
  } catch (error) {
    throw new Error(`Failed to fetch playlist: ${error.message}`);
  }
}

/**
 * Shuffle array using Fisher-Yates algorithm
 *
 * @param {Array} array - Array to shuffle
 * @returns {Array} Shuffled array
 */
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Get playlist items from a playlist
 *
 * @param {Object} playlist - DP1 playlist object
 * @param {number} quantity - Number of items to extract
 * @param {number} [duration] - Explicit display seconds; omit to keep item timing
 * @param {boolean} shuffle - Whether to shuffle and randomly select items
 * @returns {Array<Object>} Array of DP1 playlist items
 */
function extractPlaylistItems(playlist, quantity, duration, shuffle = true) {
  if (!playlist.items || playlist.items.length === 0) {
    return [];
  }

  let items = playlist.items;

  // Shuffle and randomly select if requested
  if (shuffle && items.length > quantity) {
    items = shuffleArray(items);
  }

  // Take requested quantity
  items = items.slice(0, quantity);

  // Apply an explicit duration override when one was requested; otherwise
  // keep each item's own timing (including intentionally absent duration,
  // which DP-1 §4.1 uses for natural-length playback of video/audio).
  //
  // Strip any item-level `created`: the DP-1 PlaylistItem schema has no
  // `created` field (it lives only at the playlist level), so drop it here —
  // including from legacy feed entries that may still carry it — before the
  // items reach PlaylistBuilder for construction.
  items = items.map((item) => {
    const { created: _created, ...next } = item;
    if (typeof duration === 'number') {
      next.duration = duration;
    }
    return next;
  });

  return items;
}

/**
 * Fetch feed playlist (deterministic - exact match only)
 *
 * @param {string} playlistName - Exact playlist name
 * @param {number} quantity - Number of items to fetch
 * @param {number} [duration] - Explicit display seconds; omit to keep item timing
 * @returns {Promise<Object>} Result with items
 */
async function fetchFeedPlaylistDirect(playlistName, quantity = 5, duration) {
  const feedUrls = getFeedApiUrls();
  console.log(
    chalk.cyan(`Searching for playlist "${playlistName}" in ${feedUrls.length} source(s)...`)
  );

  const result = await searchExactPlaylist(playlistName);

  if (!result.success) {
    if (result.errorType === 'feed_unreachable') {
      console.log(chalk.yellow(`   Feed server unavailable: ${result.error}`));
    } else {
      console.log(chalk.yellow(`   Playlist not found: ${result.error}`));
    }
    return {
      success: false,
      error: result.error,
      errorType: result.errorType,
      items: [],
    };
  }

  const items = extractPlaylistItems(result.playlist, quantity, duration);

  console.log(chalk.green(`✓ Got ${items.length} item(s)\n`));

  return {
    success: true,
    playlist: result.playlist,
    items,
  };
}

/**
 * Search for playlists using fuzzy matching
 *
 * @param {string} playlistName - Playlist name (can be fuzzy)
 * @param {number} quantity - Number of items to fetch
 * @param {number} [duration] - Explicit display seconds; omit to keep item timing
 * @returns {Promise<Object>} Result with best match and map for lookup
 */
async function searchFeedPlaylists(playlistName, quantity = 5, duration) {
  const feedUrls = getFeedApiUrls();
  console.log(
    chalk.cyan(`Searching for playlist "${playlistName}" in ${feedUrls.length} source(s)...`)
  );

  const result = await findBestMatchingPlaylist(playlistName);

  if (!result.success) {
    if (result.errorType === 'feed_unreachable') {
      console.log(chalk.yellow(`   Feed server unavailable: ${result.error}\n`));
    } else {
      console.log(chalk.yellow(`   Playlist not found: ${result.error}\n`));
    }
    return {
      success: false,
      error: result.error,
      errorType: result.errorType,
    };
  }

  return {
    success: true,
    bestMatch: result.bestMatch,
    playlistMap: result.playlistMap,
    searchTerm: playlistName,
    quantity,
    duration,
  };
}

/**
 * Fetch specific playlist by ID or name and extract items
 *
 * @param {string} playlistIdOrName - Playlist ID, slug, or exact name
 * @param {number} quantity - Number of items to fetch
 * @param {number} [duration] - Explicit display seconds; omit to keep item timing
 * @param {Object} playlistMap - Optional map of names to IDs for lookup
 * @param {boolean} shuffle - Whether to shuffle and randomly select items
 * @returns {Promise<Object>} Result with items
 */
async function fetchPlaylistItems(
  playlistIdOrName,
  quantity = 5,
  duration,
  playlistMap = null,
  shuffle = true
) {
  try {
    let playlistId = playlistIdOrName;
    let feedUrl = null;

    // If playlistMap provided, look up the ID from the name
    if (playlistMap && playlistMap[playlistIdOrName]) {
      playlistId = playlistMap[playlistIdOrName].id;
      feedUrl = playlistMap[playlistIdOrName].feedUrl;
    }

    const playlist = await getPlaylistById(playlistId, feedUrl);
    const items = extractPlaylistItems(playlist, quantity, duration, shuffle);

    console.log(
      chalk.green(`✓ Got ${items.length} item(s) from "${playlist.title || playlistId}"\n`)
    );

    return {
      success: true,
      playlist,
      items,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      items: [],
    };
  }
}

module.exports = {
  searchExactPlaylist,
  findBestMatchingPlaylist,
  getPlaylistById,
  extractPlaylistItems,
  fetchFeedPlaylistDirect,
  searchFeedPlaylists,
  fetchPlaylistItems,
};
