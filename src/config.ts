import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  Config,
  BrowserConfig,
  PlaylistConfig,
  FeedConfig,
  FF1DeviceConfig,
  ValidationResult,
} from './types';
import {
  DP1_PLAYLIST_SIGNING_ROLES,
  resolveDp1PlaylistSigningRole,
} from './utilities/playlist-signing-role';
import { configuredFF1Devices } from './utilities/config-placeholders';

export function getConfigPaths(): { localPath: string; userPath: string } {
  const localPath = path.join(process.cwd(), 'config.json');
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const userPath = path.join(configBase, 'ff-cli', 'config.json');
  return { localPath, userPath };
}

/**
 * Load configuration from config.json or environment variables
 * Priority: config.json > .env > defaults
 *
 * @returns {Object} Configuration object
 * @returns {number} returns.defaultDuration - Default duration per item in seconds
 */
function loadConfig(): Config {
  const { localPath, userPath } = getConfigPaths();

  const defaultConfig: Config = {
    defaultDuration: parseInt(process.env.DEFAULT_DURATION || '10', 10),
    generativeDuration: parseInt(process.env.DEFAULT_GENERATIVE_DURATION || '60', 10),
    browser: {
      timeout: parseInt(process.env.BROWSER_TIMEOUT || '90000', 10),
      sanitizationLevel: process.env.SANITIZATION_LEVEL || 'medium',
    },
    feed: {
      baseURLs: process.env.FEED_BASE_URLS
        ? process.env.FEED_BASE_URLS.split(',')
        : ['https://dp1-feed-operator-api-prod.autonomy-system.workers.dev/api/v1'],
    },
  };

  // Try to load config.json if it exists
  const configPath = fs.existsSync(localPath) ? localPath : userPath;
  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<Config>;

      // Merge with defaults, file config takes precedence
      return {
        ...defaultConfig,
        ...fileConfig,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: Failed to parse config at ${configPath}. ${message}. Using defaults.`);
      return defaultConfig;
    }
  }

  // Return default config if no file exists
  return defaultConfig;
}

/**
 * Get current configuration
 *
 * @returns {Object} Current configuration
 */
export function getConfig(): Config {
  return loadConfig();
}

/**
 * Convert sanitization level string to numeric value
 *
 * @param {string|number} level - Sanitization level ('none', 'low', 'medium', 'high') or number (0-3)
 * @returns {number} Numeric level (0 = none, 1 = low, 2 = medium, 3 = high)
 */
export function sanitizationLevelToNumber(level: string | number): number {
  if (typeof level === 'number') {
    return level;
  }

  const levelMap: Record<string, number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
  };

  return levelMap[level] !== undefined ? levelMap[level] : 2; // Default to medium (2)
}

/**
 * Get browser configuration
 *
 * @returns {Object} Browser configuration
 * @returns {number} returns.timeout - Browser timeout in milliseconds
 * @returns {number} returns.sanitizationLevel - Numeric sanitization level (0-3)
 */
export function getBrowserConfig(): { timeout: number; sanitizationLevel: number } {
  const config = getConfig();
  const browserConfig: BrowserConfig = config.browser || {
    timeout: 90000,
    sanitizationLevel: 'medium',
  };

  return {
    timeout: browserConfig.timeout,
    sanitizationLevel: sanitizationLevelToNumber(browserConfig.sanitizationLevel),
  };
}

/**
 * Get playlist configuration including signing private key and role.
 *
 * @returns {Object} Playlist configuration
 * @returns {string|null} returns.privateKey - Ed25519 private key in base64 or hex format (null if not configured)
 * @returns {string|null} returns.role - DP-1 signing role (null if not configured)
 */
export function getPlaylistConfig(): PlaylistConfig {
  const config = getConfig();
  const playlistConfig: Partial<PlaylistConfig> = config.playlist || {};

  return {
    privateKey: playlistConfig.privateKey || process.env.PLAYLIST_PRIVATE_KEY || null,
    role: playlistConfig.role || process.env.PLAYLIST_ROLE || null,
  };
}

/**
 * Resolve the effective playlist signing role used by runtime paths.
 *
 * Validation must inspect the same value that setup and signing use so
 * preflight checks do not accept combinations that will fail later, or reject
 * whitespace-padded values that runtime trims before validation.
 *
 * @param {Config} config - Loaded configuration object.
 * @returns {string|null} Effective role after config/env fallback and trimming.
 */
function resolveEffectivePlaylistRole(config: Config): string | null {
  const playlistConfig: Partial<PlaylistConfig> = config.playlist || {};
  const configuredRole = playlistConfig.role || process.env.PLAYLIST_ROLE || null;

  if (configuredRole === null) {
    return null;
  }

  return resolveDp1PlaylistSigningRole(configuredRole);
}

/**
 * Get feed configuration for DP1 feed API
 *
 * Supports both legacy (feed.baseURLs/apiKey) and new (feedServers array) formats.
 *
 * @returns {Object} Feed configuration
 * @returns {string[]} returns.baseURLs - Array of base URLs for feed APIs
 * @returns {string} [returns.apiKey] - Optional API key for authentication (legacy)
 * @returns {Array<Object>} [returns.servers] - Array of feed servers with individual API keys (new)
 */
export function getFeedConfig(): {
  baseURLs: string[];
  apiKey?: string;
  servers?: Array<{ baseUrl: string; apiKey?: string }>;
} {
  const config = getConfig();

  // Check for new feedServers format first
  if (config.feedServers && Array.isArray(config.feedServers) && config.feedServers.length > 0) {
    const baseURLs = config.feedServers.map((server) => server.baseUrl);
    return {
      baseURLs,
      servers: config.feedServers,
    };
  }

  // Fall back to legacy feed format
  const feedConfig: FeedConfig = config.feed || {};

  // Support both legacy baseURL and new baseURLs
  let urls: string[] = [];
  if (feedConfig.baseURLs && Array.isArray(feedConfig.baseURLs)) {
    urls = feedConfig.baseURLs;
  } else if (feedConfig.baseURL) {
    urls = [feedConfig.baseURL];
  } else {
    // Default feed URL
    urls = ['https://dp1-feed-operator-api-prod.autonomy-system.workers.dev/api/v1'];
  }

  return {
    baseURLs: urls,
    apiKey: feedConfig.apiKey,
  };
}

/**
 * Get FF1 device configuration for casting playlists
 *
 * @returns {Object} FF1 device configuration
 * @returns {Array<Object>} returns.devices - Array of configured FF1 devices
 * @returns {string} returns.devices[].host - Device host URL
 * @returns {string} [returns.devices[].apiKey] - Optional device API key
 * @returns {string} [returns.devices[].id] - Optional stable physical device ID
 * @returns {string} [returns.devices[].name] - Optional device name
 */
export function getFF1DeviceConfig(): FF1DeviceConfig {
  const config = getConfig();
  const ff1Devices = config.ff1Devices || { devices: [] };

  return {
    devices: configuredFF1Devices(ff1Devices.devices || []),
  };
}

const DEFAULT_FF1_RELAYER_URL = 'https://tv-cast-coordination.autonomy-system.workers.dev';

/**
 * Get the FF1 relayer endpoint using repository config priority.
 *
 * `config.json` wins over environment variables, which win over the production
 * default. The API key remains optional because the signed topic is the
 * per-device credential; it exists only for deployments that retain a separate
 * cloud-edge compatibility gate.
 */
export function getFF1RelayerConfig(): { baseUrl: string; apiKey?: string } {
  return resolveFF1RelayerConfig(getConfig());
}

/** Resolve and validate the effective FF1 relayer configuration. */
function resolveFF1RelayerConfig(config: Config): { baseUrl: string; apiKey?: string } {
  const configured = config.ff1Relayer as unknown;
  if (
    configured !== undefined &&
    (configured === null || typeof configured !== 'object' || Array.isArray(configured))
  ) {
    throw new Error('ff1Relayer must be an object');
  }
  const fields = (configured || {}) as Record<string, unknown>;
  if (fields.baseUrl !== undefined && typeof fields.baseUrl !== 'string') {
    throw new Error('ff1Relayer.baseUrl must be a string');
  }
  if (fields.apiKey !== undefined && typeof fields.apiKey !== 'string') {
    throw new Error('ff1Relayer.apiKey must be a string');
  }
  const baseUrl = (
    (fields.baseUrl as string | undefined) ||
    process.env.FF1_RELAYER_URL ||
    DEFAULT_FF1_RELAYER_URL
  )
    .trim()
    .replace(/\/$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('ff1Relayer.baseUrl must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('ff1Relayer.baseUrl must be a valid HTTP(S) URL');
  }
  const apiKey = ((fields.apiKey as string | undefined) || process.env.FF1_RELAYER_API_KEY)?.trim();
  return {
    baseUrl,
    apiKey: apiKey || undefined,
  };
}

/**
 * Validate configuration
 *
 * @returns {Object} Validation result
 * @returns {boolean} returns.valid - Whether the configuration is valid
 * @returns {Array<string>} returns.errors - List of validation errors
 */
export function validateConfig(): ValidationResult {
  const errors: string[] = [];

  try {
    const config = getConfig();

    // Validate browser configuration
    if (config.browser) {
      if (config.browser.timeout && typeof config.browser.timeout !== 'number') {
        errors.push('Browser timeout must be a number');
      }

      const validLevels = ['none', 'low', 'medium', 'high'];
      if (
        config.browser.sanitizationLevel &&
        !validLevels.includes(config.browser.sanitizationLevel as string) &&
        typeof config.browser.sanitizationLevel !== 'number'
      ) {
        errors.push(
          `Invalid browser.sanitizationLevel: "${config.browser.sanitizationLevel}". Must be one of: ${validLevels.join(', ')} or 0-3`
        );
      }
    }

    // Validate playlist configuration (optional, but warn if configured incorrectly)
    if (config.playlist && config.playlist.privateKey) {
      const key = config.playlist.privateKey;
      const placeholderPattern = /your_ed25519_private_key/i;
      if (!placeholderPattern.test(key) && typeof key === 'string' && key.length > 0) {
        const base64Regex = /^[A-Za-z0-9+/]+=*$/;
        const hexRegex = /^(0x)?[0-9a-fA-F]+$/;
        if (!base64Regex.test(key) && !hexRegex.test(key)) {
          errors.push(
            'playlist.privateKey must be a valid base64- or hex-encoded ed25519 private key'
          );
        }
      }
    }

    if (config.playlist?.role !== undefined || process.env.PLAYLIST_ROLE !== undefined) {
      try {
        resolveEffectivePlaylistRole(config);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('Unsupported DP-1 playlist signing role')
        ) {
          errors.push(`playlist.role must be one of: ${DP1_PLAYLIST_SIGNING_ROLES.join(', ')}`);
        } else {
          errors.push((error as Error).message);
        }
      }
    }

    try {
      resolveFF1RelayerConfig(config);
    } catch (error) {
      errors.push((error as Error).message);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  } catch (error) {
    errors.push((error as Error).message);
    return { valid: false, errors };
  }
}

/**
 * Create a sample config.json file from config.json.example
 *
 * Loads the bundled config.json.example template from the package directory
 * and writes it to the user's current working directory.
 *
 * @returns {Promise<string>} Path to the created config file
 * @throws {Error} If config.json already exists or example file is missing
 */
export async function createSampleConfig(targetPath?: string): Promise<string> {
  const { userPath } = getConfigPaths();
  const configPath = targetPath || userPath;

  // Check if config.json already exists in user's directory
  if (fs.existsSync(configPath)) {
    throw new Error('config.json already exists');
  }

  // Look for config.json.example across the layouts we ship in:
  //  - cwd: running from a source checkout
  //  - __dirname/../..: npm install (this file is dist/src/config.js, template
  //    sits at the package root)
  //  - __dirname/..: single-file release bundle (this file is bundled into
  //    lib/ff-cli.js, template sits one level up at the package root)
  const exampleCandidates = [
    path.join(process.cwd(), 'config.json.example'),
    path.join(__dirname, '../..', 'config.json.example'),
    path.join(__dirname, '..', 'config.json.example'),
  ];
  const examplePath = exampleCandidates.find((candidate) => fs.existsSync(candidate));

  if (!examplePath) {
    throw new Error(
      'config.json.example not found (likely an incomplete install). ' +
        'Reinstall with: npm i -g @feralfile/cli'
    );
  }

  const exampleConfig = fs.readFileSync(examplePath, 'utf-8');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, exampleConfig, 'utf-8');

  return configPath;
}
