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

/** How loading a URL as a playlist failed; see PlaylistUrlLoadError. */
export type PlaylistUrlLoadErrorKind = 'status' | 'network' | 'read' | 'json';

/**
 * PlaylistUrlLoadError is a failure to load an http(s) URL as a playlist,
 * tagged with how it failed so `resolvePlaySource` can tell a missing playlist
 * from a URL that is simply not a playlist.
 *
 * - `status`: the server answered with a non-OK HTTP status (`status` is set).
 * - `network`: no answer at all (DNS, refused connection, timeout); `code` is
 *   the underlying system error code when fetch exposes one.
 * - `read`: an OK answer whose body was cut off (timeout or dropped connection
 *   mid-download). Nothing was learned about the URL, so it is not "not a
 *   playlist" either.
 * - `json`: an OK answer, read in full, that is not JSON. This is what every
 *   ordinary web page and media file produces.
 */
export class PlaylistUrlLoadError extends Error {
  readonly kind: PlaylistUrlLoadErrorKind;
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    detail: { kind: PlaylistUrlLoadErrorKind; status?: number; code?: string }
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
      { kind: 'read' }
    );
  }

  try {
    return { playlist: JSON.parse(playlistText) as Playlist, source: url, sourceType: 'url' };
  } catch (error) {
    throw new PlaylistUrlLoadError(
      `Invalid JSON from playlist URL ${url}: ${(error as Error).message}`,
      { kind: 'json' }
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
 * refusalForLoadFailure returns the error `play` must stop with when a URL it
 * tried to load is known not to exist, or null when it may still be sent.
 *
 * Wrapping a URL that does not exist sends the device an error page and
 * reports "Playing", the silent wrong result an agent trusting exit codes
 * cannot catch. These are refused:
 * - HTTP 404 or 410: nothing is there.
 * - DNS failure (ENOTFOUND): the host does not exist. A temporary resolver
 *   failure (EAI_AGAIN) is not refused.
 * - A `.json` URL that cannot be loaded or parsed: a broken playlist link.
 * Real marketplace pages answer 200 to a command-line client (checked against
 * OpenSea, Art Blocks, objkt, SuperRare, Feral File, Neort, Verse), so this
 * rule is safe on discovery hosts too.
 *
 * @param {string} url - The URL that failed to load
 * @param {unknown} failure - What loading threw
 * @returns {Error | null} The refusal, or null
 */
export function refusalForLoadFailure(url: string, failure: unknown): Error | null {
  const loadFailure = failure as Partial<PlaylistUrlLoadError> | null;
  if (loadFailure?.status === 404 || loadFailure?.status === 410) {
    return new Error(
      `Nothing at ${url} (HTTP ${loadFailure.status}). Check the URL; nothing was sent to the device.`
    );
  }
  if (loadFailure?.code === 'ENOTFOUND') {
    return new Error(`No such host for ${url}. Check the URL; nothing was sent to the device.`);
  }
  if (looksLikePlaylistUrl(url)) {
    return new Error(
      `${url} looks like a playlist (.json) but could not be loaded: ${(failure as Error)?.message}`
    );
  }
  return null;
}

/**
 * noteForLoadFailure returns the line `play` prints when it sends a URL it
 * could not read itself, or undefined when the URL was read in full and is
 * simply not a playlist (an ordinary page or media file).
 *
 * @param {unknown} failure - What loading threw
 * @returns {string | undefined} The note, if any
 */
function noteForLoadFailure(failure: unknown): string | undefined {
  const loadFailure = failure as Partial<PlaylistUrlLoadError> | null;
  if (loadFailure?.kind === 'json') {
    return undefined;
  }
  return `ff-cli could not read this URL itself (${(failure as Error)?.message}); sending it to the device anyway.`;
}

/**
 * checkWebPageUrl fetches a URL that `play --web` is about to send, refusing
 * one that does not exist and returning a note when it could not be read.
 *
 * `--web` skips the playlist probe, so without this check a typo or a dead
 * link handed to `--web` (the hint `play` prints for marketplace pages) would
 * be cast as an error page with a successful exit. Only the status line is
 * needed; the body is cancelled unread. The `.json` rule does not apply: the
 * caller said this is a page.
 *
 * @param {string} url - Trimmed http(s) URL
 * @returns {Promise<string | undefined>} A note when the URL could not be read
 * @throws {Error} When the URL answers 404/410 or its host does not resolve
 */
export async function checkWebPageUrl(url: string): Promise<string | undefined> {
  let failure: PlaylistUrlLoadError;
  try {
    const response = await fetchWithTimeout(url);
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) {
      return undefined;
    }
    failure = new PlaylistUrlLoadError(`HTTP ${response.status} ${response.statusText}`.trim(), {
      kind: 'status',
      status: response.status,
    });
  } catch (error) {
    failure = new PlaylistUrlLoadError(`Could not reach ${url}: ${(error as Error).message}`, {
      kind: 'network',
      code: networkErrorCode(error),
    });
  }
  if (failure.status === 404 || failure.status === 410 || failure.code === 'ENOTFOUND') {
    throw refusalForLoadFailure(url, failure);
  }
  return noteForLoadFailure(failure);
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
 * Not every failure falls back: a URL that does not exist is refused (see
 * refusalForLoadFailure). Other failures (403 from bot protection, 5xx,
 * timeouts, a body cut off mid-download) still fall back, with a `note`,
 * because the device fetches media itself and often succeeds where a
 * command-line client is refused.
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
    const refusal = refusalForLoadFailure(trimmed, error);
    if (refusal) {
      throw refusal;
    }
    return buildMediaPlaySource(trimmed, {
      duration: defaultDuration,
      note: noteForLoadFailure(error),
    });
  }
}
