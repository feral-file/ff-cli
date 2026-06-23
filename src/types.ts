/**
 * Type definitions for ff-cli
 */

export interface BrowserConfig {
  timeout: number;
  sanitizationLevel: string | number;
}

export interface PlaylistConfig {
  privateKey: string | null;
  role: string | null;
}

export interface FeedConfig {
  baseURL?: string; // Legacy: single URL
  baseURLs?: string[]; // Legacy: array of URLs
  apiKey?: string; // Legacy: single API key for all servers
}

export interface FeedServer {
  baseUrl: string; // Feed server base URL
  apiKey?: string; // Optional API key for this server
}

export interface FF1Device {
  host: string;
  apiKey?: string;
  topicID?: string;
  name?: string;
}

export interface FF1DeviceConfig {
  devices: FF1Device[];
}

export interface IndexerConfig {
  endpoint: string;
  apiKey?: string;
}

export interface Config {
  defaultDuration: number;
  /**
   * Display seconds stamped on generative/interactive (HTML) works, which have
   * no intrinsic runtime. Defaults to 60. Set to 0 to omit the duration so a
   * conformant player parks on the work open-ended instead of rotating.
   */
  generativeDuration: number;
  browser: BrowserConfig;
  feed?: FeedConfig; // Legacy
  feedServers?: FeedServer[]; // New: array of feed servers with individual API keys
  playlist?: PlaylistConfig;
  ff1Devices?: FF1DeviceConfig;
  indexer?: IndexerConfig;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface PlaylistItem {
  blockchain: string;
  tokenID: string;
  duration?: number;
  [key: string]: unknown;
}

export interface Playlist {
  version: string;
  title: string;
  description?: string;
  slug?: string;
  items: PlaylistItem[];
  [key: string]: unknown;
}

export interface PlaylistSettings {
  title: string | null;
  slug: string | null;
  // Undefined = auto timing: video/audio items omit duration and play their
  // natural length (DP-1 §4.1); static items use config.defaultDuration.
  durationPerItem?: number;
  preserveOrder: boolean;
  deviceName?: string;
  feedServer?: { baseUrl: string; apiKey?: string };
}

export interface BuildPlaylistRequirement {
  type: 'build_playlist';
  blockchain: string;
  contractAddress: string;
  tokenIds: string[];
  quantity?: number | string;
}

export interface QueryAddressRequirement {
  type: 'query_address';
  ownerAddress: string;
  quantity?: number | string;
}

export interface FetchFeedRequirement {
  type: 'fetch_feed';
  playlistName: string;
  quantity?: number | string;
}

export interface FeralFileArtworkRequirement {
  type: 'feral_file_artwork';
  artworkId: string;
}

export type Requirement =
  | BuildPlaylistRequirement
  | QueryAddressRequirement
  | FetchFeedRequirement
  | FeralFileArtworkRequirement;

export interface BuildPlaylistParams {
  requirements: Requirement[];
  playlistSettings?: Partial<PlaylistSettings>;
}

export interface BuildPlaylistOptions {
  verbose?: boolean;
  outputPath?: string;
  deviceName?: string;
}

export interface BuildPlaylistResult {
  success: boolean;
  playlist?: Playlist;
  error?: string;
  [key: string]: unknown;
}

/** Response shape from `triggerTokenIndexing` (ff-indexer GraphQL; job queue). */
export interface IndexerIndexingTriggerResult {
  success: boolean;
  job_id?: number;
  error?: string;
}

/** Outcome of polling `jobStatus` until terminal state or timeout (nft-indexer client). */
export interface IndexerJobPollResult {
  success: boolean;
  completed?: boolean;
  timedOut?: boolean;
  status?: string;
  error?: string;
}
