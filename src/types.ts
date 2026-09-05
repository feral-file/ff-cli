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
  /**
   * Display name recorded for this signing key in a built playlist's `curators[]`.
   *
   * DP-1 requires `name` alongside `key`, and the feed authorizes a create by matching a signature's
   * `kid` against a declared curator key — so a playlist built and signed without this entry cannot be
   * published at all. Defaults to `ff-cli` rather than staying empty for that reason.
   */
  curatorName?: string | null;
}

export interface FeedConfig {
  baseURL?: string; // Legacy: single URL
  baseURLs?: string[]; // Legacy: array of URLs
  /**
   * @deprecated Ignored. The feed authorizes writes from the signatures inside the document and no
   * longer accepts an API key. Still declared so existing config files parse rather than erroring; it is
   * never read or sent.
   */
  apiKey?: string;
}

export interface FeedServer {
  baseUrl: string; // Feed server base URL
  /** @deprecated Ignored; see FeedConfig.apiKey. */
  apiKey?: string;
}

export interface FF1Device {
  host: string;
  apiKey?: string;
  name?: string;
  /** Stable physical FF1 identifier used as the secure topic-store account. */
  id?: string;
  addresses?: string[];
}

export interface FF1DeviceConfig {
  devices: FF1Device[];
}

export interface FF1RelayerConfig {
  baseUrl?: string;
  /** Optional deployment compatibility gate; never required by the topic credential model. */
  apiKey?: string;
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
  feedServers?: FeedServer[]; // New: array of feed servers (publishing is authorized by document signatures, not keys)
  playlist?: PlaylistConfig;
  ff1Devices?: FF1DeviceConfig;
  ff1Relayer?: FF1RelayerConfig;
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
