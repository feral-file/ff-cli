import { fetchWithTimeout } from './http';
import { promises as fs } from 'fs';
import type { Playlist } from '../types';

// playlist-builder is still CommonJS; require keeps the interop simple.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildUrlItem, buildDP1Playlist } = require('./playlist-builder');

/**
 * Parsed playlist source metadata.
 */
export interface LoadedPlaylist {
  playlist: Playlist;
  source: string;
  sourceType: 'file' | 'url';
}

/**
 * Determine whether a playlist source is an HTTP(S) URL.
 *
 * @param {string} source - Playlist source value
 * @returns {boolean} Whether the value parses as http:// or https:// URL
 */
export function isPlaylistSourceUrl(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * PlaylistUrlLoadError is a failure to load an http(s) URL as a playlist,
 * tagged with how it failed so `resolvePlaySource` can tell a missing playlist
 * from a URL that is simply not a playlist.
 *
 * - `status`: the server answered with a non-OK HTTP status (`status` is set).
 * - `network`: no answer at all (DNS, refused connection, timeout); `code` is
 *   the underlying system error code when fetch exposes one.
 * - `body`: an OK answer whose body could not be read or parsed as JSON. This
 *   is what every ordinary web page and media file produces.
 */
export class PlaylistUrlLoadError extends Error {
  readonly kind: 'status' | 'network' | 'body';
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    detail: { kind: 'status' | 'network' | 'body'; status?: number; code?: string }
  ) {
    super(message);
    this.name = 'PlaylistUrlLoadError';
    this.kind = detail.kind;
    this.status = detail.status;
    this.code = detail.code;
  }
}

/**
 * networkErrorCode digs the system error code (ENOTFOUND, ECONNREFUSED, …)
 * out of a fetch failure. Node's fetch throws `TypeError('fetch failed')` and
 * puts the real error on `cause`.
 *
 * @param {unknown} error - What fetch threw
 * @returns {string | undefined} The code, when there is one
 */
function networkErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

/**
 * loadPlaylistUrl fetches an http(s) URL and parses it as a playlist.
 *
 * @param {string} url - Trimmed http(s) URL
 * @returns {Promise<LoadedPlaylist>} The parsed document
 * @throws {PlaylistUrlLoadError} On any failure, tagged with its kind
 */
async function loadPlaylistUrl(url: string): Promise<LoadedPlaylist> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    throw new PlaylistUrlLoadError(`Could not reach ${url}: ${(error as Error).message}`, {
      kind: 'network',
      code: networkErrorCode(error),
    });
  }
  if (!response.ok) {
    throw new PlaylistUrlLoadError(
      `Failed to fetch playlist URL: ${response.status} ${response.statusText}`,
      { kind: 'status', status: response.status }
    );
  }

  let playlistText: string;
  try {
    playlistText = await response.text();
  } catch (error) {
    throw new PlaylistUrlLoadError(
      `Failed to read playlist response from ${url}: ${(error as Error).message}`,
      { kind: 'body' }
    );
  }

  try {
    return { playlist: JSON.parse(playlistText) as Playlist, source: url, sourceType: 'url' };
  } catch (error) {
    throw new PlaylistUrlLoadError(
      `Invalid JSON from playlist URL ${url}: ${(error as Error).message}`,
      { kind: 'body' }
    );
  }
}

/**
 * Load a DP-1 playlist from a local file or hosted URL.
 *
 * @param {string} source - Playlist file path or URL
 * @returns {Promise<LoadedPlaylist>} Loaded playlist payload with source metadata
 * @throws {Error} When source is empty, cannot be loaded, or JSON is invalid; a URL
 *   failure is a PlaylistUrlLoadError
 */
export async function loadPlaylistSource(source: string): Promise<LoadedPlaylist> {
  const trimmedSource = source.trim();
  if (!trimmedSource) {
    throw new Error('Playlist source is required');
  }

  if (isPlaylistSourceUrl(trimmedSource)) {
    return loadPlaylistUrl(trimmedSource);
  }

  let fileText: string;
  try {
    fileText = await fs.readFile(trimmedSource, 'utf-8');
  } catch (_error) {
    throw new Error(`Playlist file not found at ${trimmedSource}`);
  }

  try {
    return {
      playlist: JSON.parse(fileText) as Playlist,
      source: trimmedSource,
      sourceType: 'file',
    };
  } catch (error) {
    throw new Error(`Invalid JSON in ${trimmedSource}: ${(error as Error).message}`);
  }
}

/**
 * Resolved source for the `play` command.
 *
 * `playlist` — the source loaded as a DP-1 playlist (a local file or a
 *   hosted playlist URL).
 * `media` — the source is a direct media URL; a single-item DP-1 playlist
 *   was synthesized around it.
 *
 * The kind is what callers branch on to decide whether to print
 * playlist-style verification messages.
 */
export type PlaySource =
  | {
      kind: 'playlist';
      playlist: Playlist;
      sourceType: 'file' | 'url';
      source: string;
    }
  | {
      kind: 'media';
      playlist: Playlist;
      source: string;
      /**
       * Set when ff-cli could not read the URL itself and is sending it
       * anyway, so the caller can say so instead of reporting a clean play.
       */
      note?: string;
    };

/**
 * buildMediaPlaySource wraps a URL in a synthesized single-item playlist, the
 * shape `play` sends for a direct media file or web page.
 *
 * @param {string} url - Trimmed http(s) URL
 * @param {Object} [options] - Item options
 * @param {number} [options.duration] - Explicit display seconds; omit for auto timing
 * @param {string} [options.mimeType] - Timing hint; `text/html` plays open-ended as a page
 * @param {string} [options.note] - Carried to the caller (see PlaySource.note)
 * @returns {Promise<PlaySource>} A `media` play source
 */
export async function buildMediaPlaySource(
  url: string,
  options: { duration?: number; mimeType?: string; note?: string } = {}
): Promise<PlaySource> {
  const item = buildUrlItem(url, options.duration, { mimeType: options.mimeType });
  const playlist = (await buildDP1Playlist({ items: [item], title: item.title })) as Playlist;
  return options.note
    ? { kind: 'media', playlist, source: url, note: options.note }
    : { kind: 'media', playlist, source: url };
}

/**
 * looksLikePlaylistUrl reports whether a URL names a JSON document by its
 * path. A `.json` URL that fails to load is a broken playlist link, never a
 * page someone meant to show on a wall.
 *
 * @param {string} url - http(s) URL
 * @returns {boolean} True when the path ends in `.json`
 */
function looksLikePlaylistUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.json');
  } catch {
    return false;
  }
}

/**
 * Resolve a `play` command argument to a playable source.
 *
 * Files are always treated as playlists. URLs are tried as playlists first;
 * a URL whose body is not a playlist (an ordinary web page, a video, an
 * image) is wrapped in a synthesized single-item playlist so direct media
 * URLs and web pages still work.
 *
 * The "URL → playlist or media" path uses throw-and-fallback because there
 * is no cheap way to distinguish a 200-OK media file from a malformed
 * playlist response without trying to parse it.
 *
 * Not every failure falls back. Wrapping a URL that does not exist sends the
 * device a 404 page and reports "Playing", the silent wrong result an agent
 * trusting exit codes cannot catch. So these fail instead:
 * - HTTP 404 or 410: nothing is there.
 * - DNS failure (ENOTFOUND): the host does not exist.
 * - A `.json` URL that cannot be loaded or parsed: a broken playlist link.
 * Other failures (403 from bot protection, 5xx, timeouts) still fall back,
 * with a `note`, because the device fetches media itself and often succeeds
 * where a command-line client is refused.
 *
 * @param source - User-supplied path or URL
 * @param defaultDuration - Explicit duration (seconds) for the synthesized
 *   media item; omit for auto timing (video/audio URLs play their natural
 *   length per DP-1 §4.1, static media uses the configured default)
 * @returns Resolved playlist + metadata describing how it was loaded
 * @throws Error When `source` is empty, is a non-URL file path that cannot be loaded,
 *   or is a URL that does not exist (see above)
 */
export async function resolvePlaySource(
  source: string,
  defaultDuration?: number
): Promise<PlaySource> {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error('Playlist source is required');
  }

  if (!isPlaylistSourceUrl(trimmed)) {
    const loaded = await loadPlaylistSource(trimmed);
    return {
      kind: 'playlist',
      playlist: loaded.playlist,
      sourceType: loaded.sourceType,
      source: loaded.source,
    };
  }

  try {
    const loaded = await loadPlaylistUrl(trimmed);
    return {
      kind: 'playlist',
      playlist: loaded.playlist,
      sourceType: loaded.sourceType,
      source: loaded.source,
    };
  } catch (error) {
    const failure = error as PlaylistUrlLoadError;
    if (failure.status === 404 || failure.status === 410) {
      throw new Error(
        `Nothing at ${trimmed} (HTTP ${failure.status}). Check the URL; nothing was sent to the device.`
      );
    }
    if (failure.code === 'ENOTFOUND') {
      throw new Error(
        `No such host for ${trimmed}. Check the URL; nothing was sent to the device.`
      );
    }
    if (looksLikePlaylistUrl(trimmed)) {
      throw new Error(
        `${trimmed} looks like a playlist (.json) but could not be loaded: ${failure.message}`
      );
    }
    const note =
      failure.kind === 'body'
        ? undefined
        : `ff-cli could not read this URL itself (${failure.message}); sending it to the device anyway.`;
    return buildMediaPlaySource(trimmed, { duration: defaultDuration, note });
  }
}
