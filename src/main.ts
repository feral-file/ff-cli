/**
 * Main Flow Controller
 * Builds DP-1 playlists deterministically from structured parameters.
 */

// Suppress Ed25519 experimental warning immediately
const originalEmitWarning = process.emitWarning;
type WarningType = string | { name?: string } | undefined;
process.emitWarning = function (warning: unknown, type?: WarningType, ctor?: unknown) {
  if (
    ((typeof type === 'string' && type === 'ExperimentalWarning') ||
      (typeof type === 'object' && type?.name === 'ExperimentalWarning')) &&
    typeof warning === 'string' &&
    warning.includes('Ed25519')
  ) {
    return; // Suppress this warning
  }
  return originalEmitWarning.apply(this, [warning as never, type as never, ctor as never]);
} as unknown as typeof process.emitWarning;

import { getConfig } from './config';
import type {
  Requirement,
  PlaylistSettings,
  BuildPlaylistParams,
  BuildPlaylistOptions,
  BuildPlaylistResult,
} from './types';

// Lazy load utilities to avoid circular dependencies
// eslint-disable-next-line @typescript-eslint/no-require-imports
const getUtilities = () => require('./utilities');

/**
 * Validate and apply constraints to requirements
 *
 * @param {Array<Object>} requirements - Array of requirements
 * @returns {Array<Object>} Validated requirements
 */
export function validateRequirements(requirements: Requirement[]): Requirement[] {
  if (!requirements || !Array.isArray(requirements) || requirements.length === 0) {
    throw new Error('At least one requirement is needed');
  }

  return requirements.map((req, index) => {
    // Validate based on requirement type
    if (req.type === 'fetch_feed') {
      // Feed playlist requirement - only needs playlistName and quantity
      if (!req.playlistName) {
        throw new Error(`Requirement ${index + 1}: playlistName is required for fetch_feed`);
      }
      const quantity = typeof req.quantity === 'number' ? Math.min(req.quantity, 20) : 5;
      return {
        ...req,
        quantity,
      };
    }

    if (req.type === 'feral_file_artwork') {
      if (!req.artworkId) {
        throw new Error(`Requirement ${index + 1}: artworkId is required for feral_file_artwork`);
      }
      return req;
    }

    // Query address requirement
    if (req.type === 'query_address') {
      // Query all NFTs from an owner address
      if (!req.ownerAddress) {
        throw new Error(`Requirement ${index + 1}: ownerAddress is required for query_address`);
      }
      // Allow "all" as a string, or cap numeric values
      let quantity: number | string | undefined;
      if (req.quantity === 'all') {
        quantity = 'all';
      } else if (typeof req.quantity === 'number') {
        quantity = Math.min(req.quantity, 100);
      } else {
        quantity = undefined;
      }
      return {
        ...req,
        quantity,
      };
    }

    // Build playlist requirement
    if (req.type === 'build_playlist') {
      if (!req.blockchain) {
        throw new Error(`Requirement ${index + 1}: blockchain is required for build_playlist`);
      }

      if (!req.contractAddress) {
        throw new Error(`Requirement ${index + 1}: contractAddress is required for build_playlist`);
      }

      // tokenIds is now optional - if not provided, query random tokens from contract
      if (req.tokenIds && req.tokenIds.length > 0) {
        // Specific token IDs provided
        const quantity =
          typeof req.quantity === 'number'
            ? Math.min(req.quantity, 20)
            : Math.min(req.tokenIds.length, 20);
        return {
          ...req,
          quantity,
          tokenIds: req.tokenIds,
        };
      } else {
        // No token IDs - query random tokens from contract
        const quantity = typeof req.quantity === 'number' ? Math.min(req.quantity, 100) : 100;
        return {
          ...req,
          quantity,
          tokenIds: undefined, // Explicitly set to undefined
        };
      }
    }

    throw new Error(`Requirement ${index + 1}: invalid type "${(req as { type?: string }).type}"`);
  });
}

/**
 * Apply playlist settings defaults
 *
 * @param {Object} settings - Playlist settings
 * @returns {Object} Settings with defaults
 */
export function applyPlaylistDefaults(settings: Partial<PlaylistSettings> = {}): PlaylistSettings {
  return {
    title: settings.title || null,
    slug: settings.slug || null,
    // Leave durationPerItem undefined when not requested: absence means auto
    // timing downstream (video/audio omit duration and play their natural
    // length per DP-1 §4.1; static media falls back to config.defaultDuration
    // at item-build time). Filling a number here would force-cut video items.
    durationPerItem: settings.durationPerItem,
    preserveOrder: settings.preserveOrder !== false,
    deviceName: settings.deviceName,
  };
}

/**
 * Build playlist deterministically from structured parameters
 *
 * @param {Object} params - Playlist parameters
 * @param {Array<Object>} params.requirements - Array of requirements
 * @param {Object} [params.playlistSettings] - Playlist settings
 * @param {Object} options - Options
 * @param {boolean} [options.verbose=false] - Verbose output
 * @param {string} [options.outputPath='playlist.json'] - Output path
 * @returns {Promise<Object>} Result with playlist
 */
export async function buildPlaylistDirect(
  params: BuildPlaylistParams,
  options: BuildPlaylistOptions = {}
): Promise<BuildPlaylistResult> {
  const requirements = validateRequirements(params.requirements);
  const playlistSettings = applyPlaylistDefaults(params.playlistSettings);

  const utilities = getUtilities();
  const config = getConfig();

  // Initialize utilities with config (indexer endpoint, API key, etc.)
  utilities.initializeUtilities(config);

  return await utilities.buildPlaylistDirect({ requirements, playlistSettings }, options);
}
