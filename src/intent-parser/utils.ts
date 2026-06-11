/**
 * Intent Parser Utilities
 * Validation and constraint enforcement for parsed requirements
 */

import chalk from 'chalk';
import type { Config, Requirement, PlaylistSettings } from '../types';

interface RequirementParams {
  requirements: Requirement[];
  playlistSettings?: Partial<PlaylistSettings>;
}

/**
 * Apply constraints to parsed requirements
 *
 * @param {Object} params - Parsed parameters
 * @param {Array<Object>} params.requirements - Array of requirements
 * @param {Object} [params.playlistSettings] - Playlist settings
 * @param {Object} _config - Application config (kept in the signature for
 *   call-site stability; no constraint reads it since durationPerItem
 *   pre-filling was removed in favor of DP-1 §4.1 auto timing)
 * @returns {Object} Validated parameters
 */
export function applyConstraints(params: RequirementParams, _config: Config): RequirementParams {
  // Validate requirements array
  if (!params.requirements || !Array.isArray(params.requirements)) {
    throw new Error('Requirements must be an array');
  }

  if (params.requirements.length === 0) {
    throw new Error('At least one requirement is needed');
  }

  // Validate each requirement
  params.requirements = params.requirements.map((req, index) => {
    const r = req as unknown as Record<string, unknown>;
    if (!r.type) {
      throw new Error(`Requirement ${index + 1}: type is required`);
    }

    // Validate based on type
    if (r.type === 'build_playlist') {
      if (!r.blockchain) {
        throw new Error(`Requirement ${index + 1}: blockchain is required for build_playlist`);
      }
      if (!r.contractAddress) {
        throw new Error(`Requirement ${index + 1}: contractAddress is required for build_playlist`);
      }
    } else if (r.type === 'query_address') {
      if (!r.ownerAddress) {
        throw new Error(`Requirement ${index + 1}: ownerAddress is required for query_address`);
      }
    } else if (r.type === 'fetch_feed') {
      if (!r.playlistName) {
        throw new Error(`Requirement ${index + 1}: playlistName is required for fetch_feed`);
      }
    } else if (r.type === 'feral_file_artwork') {
      if (!r.artworkId) {
        throw new Error(`Requirement ${index + 1}: artworkId is required for feral_file_artwork`);
      }
    } else {
      throw new Error(`Requirement ${index + 1}: invalid type "${r.type}"`);
    }

    // Set default quantity if not provided
    // Allow "all" as a string value for query_address type
    let quantity: number | string;
    if (r.quantity === 'all') {
      quantity = 'all';
    } else if (r.quantity === null || r.quantity === undefined) {
      quantity = 5;
    } else if (typeof r.quantity === 'string') {
      // Try to parse string numbers
      const parsed = parseInt(r.quantity as string, 10);
      quantity = isNaN(parsed) ? (r.quantity as string) : parsed;
    } else {
      quantity = r.quantity as number;
    }

    return {
      ...r,
      quantity: quantity, // No cap - registry system handles large playlists efficiently
      tokenIds: (r.tokenIds as string[]) || [],
    } as Requirement;
  });

  // Note: No cap needed - registry system handles large playlists efficiently
  // Full items are stored in memory, only IDs are sent to AI model
  const hasAllQuantity = params.requirements.some((r) => 'quantity' in r && r.quantity === 'all');
  const totalRequested = params.requirements.reduce((sum, r) => {
    if ('quantity' in r && typeof r.quantity === 'number') {
      return sum + r.quantity;
    }
    return sum;
  }, 0);

  if (hasAllQuantity) {
    console.log(
      chalk.yellow(
        `\nRequesting all tokens from one or more addresses. This may take a while to fetch and process.\n`
      )
    );
  } else if (totalRequested > 100) {
    console.log(
      chalk.yellow(
        `\nRequesting ${totalRequested} items. This may take a while to fetch and process.\n`
      )
    );
  }

  // Set playlist defaults
  if (!params.playlistSettings) {
    params.playlistSettings = {};
  }

  // durationPerItem stays undefined unless the user asked for a per-item
  // time: absence means auto timing downstream (video/audio omit duration
  // and play their natural length per DP-1 §4.1; static media falls back to
  // config.defaultDuration at item-build time). Pre-filling a number here
  // would force-cut every video item.

  // Only set preserveOrder if not already specified
  if (params.playlistSettings.preserveOrder === undefined) {
    params.playlistSettings.preserveOrder = true;
  }

  return params;
}
