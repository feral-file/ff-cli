/**
 * Playlist Builder Utilities
 * Core functions for building and validating DP1 playlists
 */

const { getPlaylistConfig, getConfig } = require('../config');
const { signPlaylist } = require('./playlist-signer');

/**
 * isTimeBasedMedia reports whether an item's media has an intrinsic runtime
 * (video or audio) per DP-1 §4.1 "time-based sources".
 *
 * Two signals are consulted because neither is reliable alone: indexer
 * `display.mime_type` is authoritative when present but is defaulted to
 * 'image/png' upstream when missing, and URL extensions only cover direct
 * media links. Either signal saying video/audio wins.
 *
 * @param {string} [mimeType] - MIME type reported by the indexer, if any
 * @param {string} [sourceUrl] - Item source URL, used as an extension fallback
 * @returns {boolean} True when the media is video or audio
 */
function isTimeBasedMedia(mimeType, sourceUrl) {
  const candidates = [String(mimeType || '').toLowerCase(), detectMimeType(sourceUrl)];
  return candidates.some((mime) => mime.startsWith('video/') || mime.startsWith('audio/'));
}

/**
 * isInteractiveWeb reports whether an item is an interactive web page (HTML).
 *
 * Such sources have no intrinsic runtime AND no end-of-stream event, so they
 * are timed differently from both video/audio (which end) and static images
 * (which need a display duration): they play open-ended. The FF1 player
 * renders these in a sandboxed iframe.
 *
 * Mirrors isTimeBasedMedia's two-signal approach: an explicit `text/html`
 * MIME hint or a `.html`/`.htm` URL extension qualifies.
 *
 * @param {string} [mimeType] - MIME type hint, if any
 * @param {string} [sourceUrl] - Item source URL, used as an extension fallback
 * @returns {boolean} True when the source is an interactive HTML page
 */
function isInteractiveWeb(mimeType, sourceUrl) {
  const candidates = [String(mimeType || '').toLowerCase(), detectMimeType(sourceUrl)];
  return candidates.some((mime) => mime.startsWith('text/html'));
}

/**
 * applyItemTiming sets a DP1 item's playback timing per DP-1 §4.1.
 *
 * Invariant this function owns: an explicit numeric `duration` always wins
 * and is stamped as-is. When `duration` is undefined/null ("auto"):
 *   - a time-based source (video/audio) gets NO duration and
 *     `display.loop: false`, so a conformant player MUST advance at
 *     end-of-stream — the media plays its natural length;
 *   - an interactive web page (HTML) gets NO duration either, but for the
 *     opposite reason: it has no end-of-stream event, so a conformant player
 *     parks on it indefinitely (the generative/interactive art keeps running);
 *   - static and code-based sources fall back to the configured
 *     `defaultDuration` because they have no intrinsic runtime to play out.
 *
 * Do not re-introduce an unconditional duration here: stamping a default on
 * video items silently truncates or pads them, and stamping one on an HTML
 * page cuts the artwork off and restarts it every `defaultDuration` seconds
 * (the bugs this guards against).
 *
 * @param {Object} item - DP1 playlist item (mutated in place)
 * @param {Object} mediaHints - Media signals for the time-based check
 * @param {string} [mediaHints.mimeType] - Indexer-reported MIME type
 * @param {string} [mediaHints.sourceUrl] - Item source URL
 * @param {number} [duration] - Explicit display seconds; omit for auto
 * @returns {Object} The same item, for chaining
 */
function applyItemTiming(item, mediaHints = {}, duration) {
  if (typeof duration === 'number') {
    item.duration = duration;
    return item;
  }

  if (isTimeBasedMedia(mediaHints.mimeType, mediaHints.sourceUrl)) {
    item.display = { ...(item.display || {}), loop: false };
    return item;
  }

  if (isInteractiveWeb(mediaHints.mimeType, mediaHints.sourceUrl)) {
    // No duration: an open-ended interactive page should play until the
    // playlist advances for another reason, not on a fixed timer.
    return item;
  }

  item.duration = getDefaultStaticDuration();
  return item;
}

/**
 * getDefaultStaticDuration returns the configured per-item display seconds
 * for media without an intrinsic runtime. Falls back to 10 when config is
 * unavailable (e.g. unit tests without a config file).
 *
 * @returns {number} Display duration in seconds
 */
function getDefaultStaticDuration() {
  try {
    return getConfig().defaultDuration || 10;
  } catch (_error) {
    return 10;
  }
}

/**
 * Convert a string to a URL-friendly slug
 *
 * Lowercases, trims, replaces whitespace with dashes, and strips invalid chars.
 * Falls back to a short id when input is empty.
 *
 * @param {string} value - Source string to slugify
 * @returns {string} Slugified string
 */
function slugify(value) {
  const base = (value || '').toString().trim().toLowerCase();
  if (!base) {
    const crypto = require('crypto');
    return `playlist-${crypto.randomUUID().split('-')[0]}`;
  }
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s-]/g, '') // remove invalid chars
    .replace(/\s+/g, '-') // spaces -> dashes
    .replace(/-+/g, '-') // collapse dashes
    .replace(/^-|-$/g, ''); // trim dashes
}

/**
 * Convert single NFT token info to DP1 playlist item
 *
 * @param {Object} tokenInfo - Token information from NFT indexer
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 *   (video/audio play natural length per DP-1 §4.1, static media uses the
 *   configured default — see applyItemTiming)
 * @returns {Object} DP1 playlist item
 * @throws {Error} When token data is missing or source is a data URI
 * @example
 * const item = convertTokenToDP1ItemSingle(tokenInfo, 10);
 * // Returns: { title, source, duration, license, provenance, ... }
 */
function convertTokenToDP1ItemSingle(tokenInfo, duration) {
  const { token } = tokenInfo;

  if (!token) {
    throw new Error('Invalid token info: missing token data');
  }

  // Determine the content source URL (prefer animation_url for dynamic content)
  const sourceUrl =
    token.animation_url || token.animationUrl || token.image?.url || token.image || '';

  // Skip items with data URIs (base64-encoded content)
  if (sourceUrl.startsWith('data:')) {
    throw new Error('Item source is a data URI - excluded from playlist');
  }

  // Map chain to DP1 format
  const chainMap = {
    ethereum: 'evm',
    polygon: 'evm',
    arbitrum: 'evm',
    optimism: 'evm',
    base: 'evm',
    tezos: 'tezos',
    bitmark: 'bitmark',
  };
  const chain = chainMap[token.chain?.toLowerCase()] || 'other';

  // Map token standard to DP1 format
  const standardMap = {
    erc721: 'erc721',
    erc1155: 'erc1155',
    fa2: 'fa2',
  };
  const standard = standardMap[token.standard?.toLowerCase()] || 'other';

  // Generate unique ID for the item (UUID v4 format)
  const crypto = require('crypto');
  const itemId = crypto.randomUUID();

  // Build DP1 item structure according to OpenAPI spec
  const dp1Item = {
    id: itemId,
    title: token.name || `Token #${token.tokenId}`,
    source: sourceUrl,
    license: 'token', // NFTs are token-gated by default
    created: new Date().toISOString(),
    provenance: {
      type: 'onChain',
      contract: {
        chain: chain,
        standard: standard,
        address: token.contractAddress,
        tokenId: String(token.tokenId),
      },
    },
  };

  // Add display preferences if available
  dp1Item.display = {
    scaling: 'fit',
    background: '#111',
    margin: 0,
  };

  // Add metadata URI if available
  if (token.metadata?.uri || token.tokenURI) {
    dp1Item.provenance.contract.uri = token.metadata?.uri || token.tokenURI;
  }

  // Add reference to image if animation_url was used as source
  if ((token.animation_url || token.animationUrl) && (token.image?.url || token.image)) {
    dp1Item.ref = token.image?.url || token.image;
  }

  return applyItemTiming(dp1Item, { mimeType: token.image?.mimeType, sourceUrl }, duration);
}

/**
 * Convert NFT token info(s) to DP1 playlist item(s)
 *
 * Handles both single token objects and maps/arrays of tokens.
 * For collections, returns a map of token key to DP1 item.
 *
 * @param {Object|Array} tokenInfo - Token information (single object or map of tokens)
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 * @returns {Object} Map of token key to DP1 playlist item, or single item
 * @example
 * // Single token
 * const item = convertTokenToDP1Item(tokenInfo, 10);
 *
 * // Multiple tokens
 * const items = convertTokenToDP1Item({ token1: info1, token2: info2 }, 10);
 */
function convertTokenToDP1Item(tokenInfo, duration) {
  // Handle array or map of tokens
  if (typeof tokenInfo === 'object' && !tokenInfo.token) {
    const results = {};
    Object.entries(tokenInfo).forEach(([key, info]) => {
      if (info.success !== false && info.token) {
        try {
          results[key] = convertTokenToDP1ItemSingle(info, duration);
        } catch (error) {
          results[key] = {
            success: false,
            error: error.message,
          };
        }
      } else {
        results[key] = {
          success: false,
          error: info.error || 'Invalid token info',
        };
      }
    });
    return results;
  }

  // Handle single token (backward compatibility)
  try {
    return convertTokenToDP1ItemSingle(tokenInfo, duration);
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Convert multiple tokens to DP1 playlist items
 *
 * Filters out failed tokens and converts successful ones.
 * Excludes items with data URIs in their source field.
 *
 * @param {Array} tokensInfo - Array of token information
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 * @returns {Array} Array of DP1 playlist items
 * @example
 * const items = convertTokensToDP1Items(tokensInfoArray, 10);
 */
function convertTokensToDP1Items(tokensInfo, duration) {
  return tokensInfo
    .filter((info) => info.success && info.token)
    .map((info) => {
      try {
        return convertTokenToDP1Item(info, duration);
      } catch (error) {
        return {
          success: false,
          error: error.message,
        };
      }
    })
    .filter((item) => item.success !== false);
}

/**
 * Generate a descriptive playlist title from items
 *
 * Analyzes items to determine if it's an NFT playlist and generates
 * an appropriate title based on the collection structure.
 *
 * @param {Array} items - Array of DP1 items
 * @returns {string} Generated title
 * @example
 * const title = generatePlaylistTitle(items);
 * // Returns: "NFT Collection Playlist" or "Multi-Collection NFT Playlist"
 */
function generatePlaylistTitle(items) {
  if (!items || items.length === 0) {
    return 'DP1 Playlist';
  }

  // Check if all items have provenance (likely NFT playlist)
  const hasProvenance = items.some((item) => item.provenance?.type === 'onChain');

  if (hasProvenance) {
    // Count unique contracts for NFT playlists
    const contracts = new Set();
    items.forEach((item) => {
      if (item.provenance?.contract?.address) {
        contracts.add(item.provenance.contract.address);
      }
    });

    if (contracts.size === 1) {
      return `NFT Collection Playlist`;
    } else if (contracts.size > 1) {
      return `Multi-Collection NFT Playlist`;
    }
  }

  // Fallback: use item count
  return `DP1 Playlist (${items.length} ${items.length === 1 ? 'item' : 'items'})`;
}

/**
 * Build complete DP1 v1.0.0 compliant playlist
 *
 * Creates a complete playlist structure with metadata, defaults, and optional signature.
 * Supports both object parameter and legacy separate parameters for backward compatibility.
 *
 * @param {Object|Array} paramsOrItems - Playlist parameters object or items array (legacy)
 * @param {Array} [paramsOrItems.items] - Array of DP1 items
 * @param {string} [paramsOrItems.title] - Playlist title (auto-generated if not provided)
 * @param {string} [paramsOrItems.slug] - Playlist slug (auto-generated from title if not provided)
 * @param {boolean} [paramsOrItems.deterministicMode] - Enable deterministic mode for testing
 * @param {string} [paramsOrItems.fixedTimestamp] - Fixed timestamp for deterministic mode
 * @param {string} [paramsOrItems.fixedId] - Fixed ID for deterministic mode
 * @param {Object} options - Additional options (legacy parameter)
 * @param {string} [options.title] - Playlist title (legacy)
 * @param {string} [options.slug] - Playlist slug (legacy; auto-generated from title if omitted)
 * @param {boolean} [options.deterministicMode] - Enable deterministic mode for testing
 * @param {string} [options.fixedTimestamp] - Fixed timestamp for deterministic mode
 * @param {string} [options.fixedId] - Fixed ID for deterministic mode
 * @returns {Promise<Object>} Complete DP1 playlist with signature
 * @throws {Error} When items array is empty or invalid
 * @example
 * // New style
 * const playlist = await buildDP1Playlist({ items, title: 'My Playlist', slug: 'my-playlist' });
 *
 * // Legacy style
 * const playlist = await buildDP1Playlist(items, { title: 'My Playlist' });
 *
 * // Deterministic mode for testing
 * const playlist = await buildDP1Playlist(items, {
 *   title: 'Test',
 *   deterministicMode: true,
 *   fixedTimestamp: '2024-01-01T00:00:00.000Z',
 *   fixedId: 'playlist_test_123'
 * });
 */
async function buildDP1Playlist(paramsOrItems, options = {}) {
  // Handle both object parameter and legacy separate parameters
  let items, title, slug, deterministicMode, fixedTimestamp, fixedId;

  if (
    paramsOrItems &&
    typeof paramsOrItems === 'object' &&
    !Array.isArray(paramsOrItems) &&
    paramsOrItems.items
  ) {
    // New style: single object parameter
    ({ items, title, slug, deterministicMode, fixedTimestamp, fixedId } = paramsOrItems);
  } else {
    // Legacy style: separate parameters
    items = paramsOrItems;
    ({ title, slug, deterministicMode, fixedTimestamp, fixedId } = options);
  }

  // Validate items
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Playlist must contain at least one item');
  }

  // Workaround: Parse items if they are JSON strings (some AI models return escaped strings)
  items = items.map((item) => {
    if (typeof item === 'string') {
      try {
        return JSON.parse(item);
      } catch (_e) {
        return item; // If parsing fails, return as-is
      }
    }
    return item;
  });

  // Auto-generate title if not provided
  if (!title) {
    title = generatePlaylistTitle(items);
  }

  // Auto-generate slug when not provided
  if (!slug) {
    slug = slugify(title);
  }

  // Build DP1 playlist structure using the v1.1.0 envelope.
  // Support deterministic mode for testing (freeze timestamp and ID)
  const timestamp = deterministicMode && fixedTimestamp ? fixedTimestamp : new Date().toISOString();
  const crypto = require('crypto');
  const playlistId = deterministicMode && fixedId ? fixedId : crypto.randomUUID();

  const playlist = {
    dpVersion: '1.1.0',
    id: playlistId,
    title,
    created: timestamp,
    items,
    defaults: {
      display: {
        scaling: 'fit',
        background: '#111',
        margin: 0,
      },
      license: 'token',
      // No defaults.duration: items that should be timed carry an explicit
      // duration already, and a playlist-level default would make conformant
      // players time-cut items that intentionally omit duration to play
      // their natural length (DP-1 §4.1 end-of-stream advance).
    },
  };

  // Always include slug (auto-generated when missing)
  playlist.slug = slug;

  // Sign the playlist if private key is configured.
  try {
    const playlistConfig = getPlaylistConfig();
    if (playlistConfig.privateKey) {
      playlist.signatures = [await signPlaylist(playlist, playlistConfig.privateKey)];
      delete playlist.signature;
    }
  } catch (error) {
    // If signing fails, log warning but continue (signature is optional).
    console.warn(`Warning: Failed to sign playlist: ${error.message}`);
  }

  return playlist;
}

/**
 * Validate DP1 playlist structure according to OpenAPI spec
 *
 * Performs comprehensive validation of playlist structure, fields, and item requirements.
 * Returns detailed errors for each validation failure.
 *
 * @param {Object} playlist - DP1 playlist to validate
 * @returns {Object} Validation result
 * @returns {boolean} returns.valid - Whether playlist is valid
 * @returns {Array<string>} returns.errors - Array of error messages
 * @example
 * const result = validateDP1Playlist(playlist);
 * if (!result.valid) {
 *   console.error('Validation errors:', result.errors);
 * }
 */
function validateDP1Playlist(playlist) {
  const errors = [];

  // Check required playlist fields
  if (!playlist.dpVersion) {
    errors.push('Missing required field: dpVersion');
  } else if (typeof playlist.dpVersion !== 'string') {
    errors.push('Field "dpVersion" must be a string');
  }

  if (!playlist.title) {
    errors.push('Missing required field: title');
  } else if (playlist.title.length > 256) {
    errors.push('Field "title" must not exceed 256 characters');
  }

  if (!playlist.items) {
    errors.push('Missing required field: items');
  } else if (!Array.isArray(playlist.items)) {
    errors.push('Field "items" must be an array');
  } else if (playlist.items.length === 0) {
    errors.push('Playlist must contain at least one item');
  } else if (playlist.items.length > 1024) {
    errors.push('Playlist cannot contain more than 1024 items');
  } else {
    // Validate each item according to PlaylistItem schema
    playlist.items.forEach((item, index) => {
      if (!item.source) {
        errors.push(`Item ${index}: Missing required field "source"`);
      } else if (typeof item.source !== 'string') {
        errors.push(`Item ${index}: Field "source" must be a string (URI)`);
      }

      // Duration is OPTIONAL per the DP-1 v1.1.0 schema (PlaylistItem requires
      // only `source`; duration has `minimum: 0`). Absent duration is meaningful:
      // time-based sources advance at end-of-stream (§4.1). Do not tighten this
      // back to required — it would reject spec-valid playlists.
      if (item.duration !== undefined && item.duration !== null) {
        if (typeof item.duration !== 'number' || item.duration < 0) {
          errors.push(`Item ${index}: Field "duration" must be a number >= 0`);
        }
      }

      if (!item.license) {
        errors.push(`Item ${index}: Missing required field "license"`);
      } else if (!['open', 'token', 'subscription'].includes(item.license)) {
        errors.push(`Item ${index}: Field "license" must be one of: open, token, subscription`);
      }

      // Validate optional title length
      if (item.title && item.title.length > 256) {
        errors.push(`Item ${index}: Field "title" must not exceed 256 characters`);
      }

      // Validate optional provenance structure
      if (item.provenance) {
        if (!item.provenance.type) {
          errors.push(`Item ${index}: provenance.type is required when provenance is present`);
        } else if (!['onChain', 'seriesRegistry', 'offChainURI'].includes(item.provenance.type)) {
          errors.push(
            `Item ${index}: provenance.type must be one of: onChain, seriesRegistry, offChainURI`
          );
        }

        if (item.provenance.contract) {
          if (!item.provenance.contract.chain) {
            errors.push(`Item ${index}: provenance.contract.chain is required`);
          } else if (
            !['evm', 'tezos', 'bitmark', 'other'].includes(item.provenance.contract.chain)
          ) {
            errors.push(
              `Item ${index}: provenance.contract.chain must be one of: evm, tezos, bitmark, other`
            );
          }
        }
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Detect MIME type from a URL or file extension.
 *
 * Maps known media/web extensions to a MIME type. Returns '' (empty) when the
 * extension is unknown or absent — the type is genuinely undetermined, and
 * callers decide the fallback. (Do NOT default to 'image/png': that silently
 * misclassified HTML pages and extensionless URLs as static images, stamping
 * them with a display duration that cut interactive artworks off.)
 *
 * @param {string} url - Media or page URL
 * @returns {string} MIME type, or '' when undetermined
 * @example
 * detectMimeType('https://example.com/image.png'); // 'image/png'
 * detectMimeType('https://example.com/art.html');  // 'text/html'
 * detectMimeType('https://example.com/output/abc'); // ''
 */
function detectMimeType(url) {
  if (!url) {
    return '';
  }

  const extension = url.split('.').pop()?.toLowerCase().split('?')[0];

  const mimeTypes = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    html: 'text/html',
    htm: 'text/html',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
  };

  return mimeTypes[extension] || '';
}

/**
 * Build a single DP1 playlist item from a URL
 *
 * @param {string} url - Media URL
 * @param {number} [duration] - Explicit display seconds; omit for auto timing
 *   (video/audio URLs play their natural length per DP-1 §4.1)
 * @param {Object} [options] - Optional configuration
 * @param {string} [options.title] - Optional item title override
 * @param {string} [options.mimeType] - Source media type hint for timing
 *   (DP-1 §4.1). Needed when the URL has no file extension to detect from —
 *   e.g. extensionless IPFS gateway URLs, where without this hint a video
 *   would be misclassified as a static image and stamped a fixed duration.
 * @returns {Object} DP1 playlist item
 */
function buildUrlItem(url, duration, options = {}) {
  const sourceUrl = String(url || '').trim();
  if (!sourceUrl) {
    throw new Error('URL is required to build a playlist item');
  }

  if (sourceUrl.startsWith('data:')) {
    throw new Error('Item source is a data URI - excluded from playlist');
  }

  let title = options.title;
  if (!title) {
    try {
      const parsed = new URL(sourceUrl);
      const pathName = parsed.pathname.split('/').filter(Boolean).pop();
      if (pathName) {
        title = decodeURIComponent(pathName);
      } else {
        title = parsed.hostname || 'URL Playback';
      }
    } catch (_error) {
      title = 'URL Playback';
    }
  }

  const crypto = require('crypto');
  const itemId = crypto.randomUUID();

  const item = {
    id: itemId,
    title,
    source: sourceUrl,
    license: 'open',
    created: new Date().toISOString(),
    provenance: {
      type: 'offChainURI',
      uri: sourceUrl,
    },
    display: {
      scaling: 'fit',
      background: '#111',
      margin: 0,
    },
  };

  // A URL handed to `play` that isn't a recognized media file is treated as an
  // interactive web page: the FF1 renders unknown URLs in a sandboxed iframe,
  // so an explicit caller hint aside, "unknown" means web, not static image.
  // This routes such items through the open-ended (no-duration) timing path
  // instead of the static-image default.
  const mimeHint = options.mimeType || (detectMimeType(sourceUrl) === '' ? 'text/html' : undefined);

  return applyItemTiming(item, { sourceUrl, mimeType: mimeHint }, duration);
}

module.exports = {
  convertTokenToDP1Item,
  convertTokenToDP1ItemSingle,
  convertTokensToDP1Items,
  generatePlaylistTitle,
  buildDP1Playlist,
  validateDP1Playlist,
  detectMimeType,
  isTimeBasedMedia,
  isInteractiveWeb,
  applyItemTiming,
  buildUrlItem,
};
