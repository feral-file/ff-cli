/**
 * Playlist Builder Utilities
 *
 * Constructs DP-1 playlists and items via dp1-js document/leaf builders so
 * every generated object is schema-validated against the DP-1 AJV defs before
 * optional signing. Domain timing heuristics (DP-1 §4.1) stay in this module;
 * leaf shapes (display, provenance, contract) come from dp1-js, and inline Ref
 * Manifests (Playlist Extension §3.6) come from ./ref-manifest.
 */

const {
  PlaylistBuilder,
  PlaylistItemBuilder,
  DisplayPrefsBuilder,
  ProvenanceBuilder,
  ContractBuilder,
  ValidatePlaylist,
  slugify: dp1Slugify,
  generateId,
} = require('dp1-js');
const { getPlaylistConfig, getConfig } = require('../config');
const { signPlaylist } = require('./playlist-signer');
const { buildInlineManifestForToken } = require('./ref-manifest');

/** Default display background that passes DP-1 hex color validation. */
const DEFAULT_BACKGROUND = '#111111';

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
 * resolveItemTiming computes duration/loop decisions per DP-1 §4.1 without
 * mutating a playlist item. Callers stamp the result through PlaylistItemBuilder.
 *
 * @param {Object} mediaHints - Media signals for the time-based check
 * @param {string} [mediaHints.mimeType] - Indexer-reported MIME type
 * @param {string} [mediaHints.sourceUrl] - Item source URL
 * @param {number} [duration] - Explicit display seconds; omit for auto
 * @returns {{ duration?: number, loopFalse?: boolean }}
 */
function resolveItemTiming(mediaHints = {}, duration) {
  if (typeof duration === 'number') {
    return { duration };
  }

  if (isTimeBasedMedia(mediaHints.mimeType, mediaHints.sourceUrl)) {
    return { loopFalse: true };
  }

  if (isInteractiveWeb(mediaHints.mimeType, mediaHints.sourceUrl)) {
    // Generative/interactive works have no intrinsic runtime, so stamp the
    // configured generative duration to drive playlist rotation. A configured
    // value of 0 means "omit" — a conformant player then parks open-ended.
    const generativeDuration = getGenerativeDuration();
    if (generativeDuration > 0) {
      return { duration: generativeDuration };
    }
    return {};
  }

  return { duration: getDefaultStaticDuration() };
}

/**
 * applyItemTiming sets a DP1 item's playback timing per DP-1 §4.1.
 *
 * Kept for unit tests and callers that mutate plain objects. New construction
 * paths prefer resolveItemTiming + PlaylistItemBuilder so the final item is
 * schema-validated by dp1-js.
 *
 * @param {Object} item - DP1 playlist item (mutated in place)
 * @param {Object} mediaHints - Media signals for the time-based check
 * @param {string} [mediaHints.mimeType] - Indexer-reported MIME type
 * @param {string} [mediaHints.sourceUrl] - Item source URL
 * @param {number} [duration] - Explicit display seconds; omit for auto
 * @returns {Object} The same item, for chaining
 */
function applyItemTiming(item, mediaHints = {}, duration) {
  const timing = resolveItemTiming(mediaHints, duration);
  if (typeof timing.duration === 'number') {
    item.duration = timing.duration;
  }
  if (timing.loopFalse) {
    item.display = { ...(item.display || {}), loop: false };
  }
  return item;
}

/**
 * buildDefaultDisplay builds schema-valid DisplayPrefs via dp1-js.
 *
 * @param {{ loopFalse?: boolean }} [opts]
 * @returns {object} Validated DisplayPrefs
 */
function buildDefaultDisplay(opts = {}) {
  const builder = new DisplayPrefsBuilder().scaling('fit').background(DEFAULT_BACKGROUND).margin(0);
  if (opts.loopFalse) {
    builder.loop(false);
  }
  return builder.build();
}

/**
 * applyTimingToItemBuilder stamps resolveItemTiming results onto a builder.
 *
 * @param {InstanceType<typeof PlaylistItemBuilder>} itemBuilder
 * @param {Object} mediaHints
 * @param {number} [duration]
 * @param {object} [baseDisplay] - Already-built DisplayPrefs without loop
 * @returns {InstanceType<typeof PlaylistItemBuilder>}
 */
function applyTimingToItemBuilder(itemBuilder, mediaHints, duration, baseDisplay) {
  const timing = resolveItemTiming(mediaHints, duration);
  if (typeof timing.duration === 'number') {
    itemBuilder.durationSeconds(timing.duration);
  }
  if (timing.loopFalse) {
    itemBuilder.display(buildDefaultDisplay({ loopFalse: true }));
  } else if (baseDisplay) {
    itemBuilder.display(baseDisplay);
  }
  return itemBuilder;
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
 * getGenerativeDuration returns the configured display seconds for
 * generative/interactive (HTML) works, which have no intrinsic runtime.
 * Defaults to 60 when config is unavailable. A configured 0 is honored (the
 * caller omits the duration so the work plays open-ended).
 *
 * @returns {number} Display duration in seconds (0 means "omit / open-ended")
 */
function getGenerativeDuration() {
  try {
    const configured = getConfig().generativeDuration;
    return typeof configured === 'number' ? configured : 60;
  } catch (_error) {
    return 60;
  }
}

/**
 * slugify converts free text to a kebab-case slug via dp1-js.
 * Falls back to a short id when input is empty (dp1-js slugify throws then).
 *
 * @param {string} value - Source string to slugify
 * @returns {string} Slugified string
 */
function slugify(value) {
  const base = (value || '').toString().trim();
  if (!base) {
    return `playlist-${generateId().split('-')[0]}`;
  }
  try {
    return dp1Slugify(base);
  } catch (_error) {
    return `playlist-${generateId().split('-')[0]}`;
  }
}

/**
 * Convert single NFT token info to DP1 playlist item
 *
 * When the token carries description, artist, or a still image distinct from
 * the source, the item also gets an inline Ref Manifest (see ref-manifest.ts).
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

  const contractBuilder = new ContractBuilder()
    .chain(chain)
    .standard(standard)
    .address(token.contractAddress)
    .tokenId(String(token.tokenId));

  // Add metadata URI if available (contract.uri is the DP-1 field)
  const metadataUri = token.metadata?.uri || token.tokenURI;
  if (metadataUri) {
    contractBuilder.uri(metadataUri);
  }

  const itemBuilder = new PlaylistItemBuilder()
    .id(generateId())
    .title(token.name || `Token #${token.tokenId}`)
    .source(sourceUrl)
    .license('token')
    .provenance(new ProvenanceBuilder().type('onChain').contract(contractBuilder));

  // Add reference to image if animation_url was used as source
  if ((token.animation_url || token.animationUrl) && (token.image?.url || token.image)) {
    itemBuilder.ref(token.image?.url || token.image);
  }

  // `ref` and `inlineManifest` are complementary, not exclusive: DP-1 Playlist
  // Extension §3.6 resolves `defaults → inlineManifest → ref → item.local`, so
  // a present `ref` is authoritative and the inline copy is the fallback for an
  // offline or degraded fetch. Emitting both keeps the poster frame that FF1
  // builds read from `ref` while giving manifest-aware players the structured
  // metadata — §3.6 names ff-cli as the case it was added for, since a locally
  // built playlist has nowhere to host a remote manifest.
  const inlineManifest = buildInlineManifestForToken(token, { sourceUrl });
  if (inlineManifest) {
    itemBuilder.inlineManifest(inlineManifest);
  }

  applyTimingToItemBuilder(
    itemBuilder,
    { mimeType: token.image?.mimeType, sourceUrl },
    duration,
    buildDefaultDisplay()
  );

  return itemBuilder.build();
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
    return 'DP-1 Playlist';
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
  return `DP-1 Playlist (${items.length} ${items.length === 1 ? 'item' : 'items'})`;
}

/**
 * Build a complete DP-1 v1.1.0 playlist via PlaylistBuilder.
 *
 * Creates a schema-validated unsigned playlist, then optionally signs when a
 * private key is configured. Supports both object parameter and legacy
 * separate parameters.
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
 *   fixedId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
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

  // Validate items early (PlaylistBuilder also rejects empty items without dynamicQuery)
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

  // Build DP1 playlist structure using the v1.1.0 envelope via dp1-js.
  // Support deterministic mode for testing (freeze timestamp and ID).
  // No defaults.duration: items that should be timed carry an explicit
  // duration already, and a playlist-level default would make conformant
  // players time-cut items that intentionally omit duration to play
  // their natural length (DP-1 §4.1 end-of-stream advance).
  const playlistBuilder = new PlaylistBuilder()
    .dpVersion('1.1.0')
    .title(title)
    .slug(slug)
    .defaultDisplay(buildDefaultDisplay())
    .defaultLicense('token')
    .items(items);

  if (deterministicMode && fixedId) {
    playlistBuilder.id(fixedId);
  }
  if (deterministicMode && fixedTimestamp) {
    playlistBuilder.created(fixedTimestamp);
  }

  const playlist = playlistBuilder.build();

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
 * validateDP1Playlist schema-validates a playlist via dp1-js ValidatePlaylist.
 *
 * Unsigned drafts are accepted (`requireSignatures: false`). Returns the
 * historical `{ valid, errors }` shape for CLI/tests.
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
  try {
    ValidatePlaylist(playlist, { requireSignatures: false });
    return { valid: true, errors: [] };
  } catch (error) {
    const details = Array.isArray(error?.details) ? error.details : [];
    const errors =
      details.length > 0
        ? details.map((detail) => {
            const path = detail?.path ? String(detail.path) : '/';
            const message = detail?.message ? String(detail.message) : 'validation failed';
            return `${path}: ${message}`;
          })
        : [error instanceof Error ? error.message : String(error)];
    return { valid: false, errors };
  }
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
 * The extension is taken from the URL *pathname* only — the query string and
 * fragment are stripped first, so a signed URL like `art.png?sig=a.b` or
 * `clip.mp4#t=1` still resolves to its real extension instead of parsing `b`
 * or `mp4#t=1`. Misreading those would mislabel media as undetermined and
 * (via buildUrlItem) route it through the interactive-web timing path.
 *
 * @param {string} url - Media or page URL
 * @returns {string} MIME type, or '' when undetermined
 * @example
 * detectMimeType('https://example.com/image.png');        // 'image/png'
 * detectMimeType('https://example.com/art.png?sig=a.b');  // 'image/png'
 * detectMimeType('https://example.com/art.html');         // 'text/html'
 * detectMimeType('https://example.com/output/abc');       // ''
 */
function detectMimeType(url) {
  if (!url) {
    return '';
  }

  // Use the pathname only: drop query + fragment so a dot inside `?sig=a.b`
  // or `#v=1.2` can't masquerade as the file extension.
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not an absolute URL (bare path/filename) — strip fragment then query.
    pathname = String(url).split('#')[0].split('?')[0];
  }

  const lastSegment = pathname.split('/').pop() || '';
  const dotIndex = lastSegment.lastIndexOf('.');
  const extension = dotIndex >= 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : '';

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
 * Build a single DP1 playlist item from a URL via PlaylistItemBuilder.
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

  // No inline Ref Manifest here, deliberately: an off-chain URL item holds only
  // url, title, and mimeType. `mimeType` is a timing hint with no place in
  // DP-1 Metadata, and `title` is already written to the item below — so a
  // manifest would carry nothing the item does not already say. If a resolver
  // ever supplies a real description or artist, route it through
  // buildInlineManifestForToken rather than lowering that bar.
  const itemBuilder = new PlaylistItemBuilder()
    .id(generateId())
    .title(title)
    .source(sourceUrl)
    .license('open')
    // offChainURI has no provenance.uri in the DP-1 schema — only type.
    .provenance(new ProvenanceBuilder().type('offChainURI'));

  // A URL handed to `play` that isn't a recognized media file is treated as an
  // interactive web page: the FF1 renders unknown URLs in a sandboxed iframe,
  // so an explicit caller hint aside, "unknown" means web, not static image.
  // This routes such items through the open-ended (no-duration) timing path
  // instead of the static-image default.
  const mimeHint = options.mimeType || (detectMimeType(sourceUrl) === '' ? 'text/html' : undefined);

  applyTimingToItemBuilder(
    itemBuilder,
    { sourceUrl, mimeType: mimeHint },
    duration,
    buildDefaultDisplay()
  );

  return itemBuilder.build();
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
  resolveItemTiming,
  applyTimingToItemBuilder,
  buildUrlItem,
  buildDefaultDisplay,
};
