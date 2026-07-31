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
 * Load a DP-1 playlist from a local file or hosted URL.
 *
 * @param {string} source - Playlist file path or URL
 * @returns {Promise<LoadedPlaylist>} Loaded playlist payload with source metadata
 * @throws {Error} When source is empty, cannot be loaded, or JSON is invalid
 */
export async function loadPlaylistSource(source: string): Promise<LoadedPlaylist> {
  const trimmedSource = source.trim();
  if (!trimmedSource) {
    throw new Error('Playlist source is required');
  }

  if (isPlaylistSourceUrl(trimmedSource)) {
    const response = await fetchWithTimeout(trimmedSource);
    if (!response.ok) {
      throw new Error(`Failed to fetch playlist URL: ${response.status} ${response.statusText}`);
    }

    let playlistText: string;
    try {
      playlistText = await response.text();
    } catch (error) {
      throw new Error(
        `Failed to read playlist response from ${trimmedSource}: ${(error as Error).message}`
      );
    }

    try {
      return {
        playlist: JSON.parse(playlistText) as Playlist,
        source: trimmedSource,
        sourceType: 'url',
      };
    } catch (error) {
      throw new Error(
        `Invalid JSON from playlist URL ${trimmedSource}: ${(error as Error).message}`
      );
    }
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
    };

/**
 * Resolve a `play` command argument to a playable source.
 *
 * Files are always treated as playlists. URLs are tried as playlists first;
 * if loading fails (network, non-JSON, etc.), the URL is wrapped in a
 * synthesized single-item playlist so direct media URLs still work.
 *
 * The "URL → playlist or media" path uses throw-and-fallback because there
 * is no cheap way to distinguish a 200-OK media file from a malformed
 * playlist response without trying to parse it. Keeping the fallback
 * scoped to one helper means the play action no longer carries the
 * `loadedAsPlaylist` boolean dance.
 *
 * @param source - User-supplied path or URL
 * @param defaultDuration - Explicit duration (seconds) for the synthesized
 *   media item; omit for auto timing (video/audio URLs play their natural
 *   length per DP-1 §4.1, static media uses the configured default)
 * @returns Resolved playlist + metadata describing how it was loaded
 * @throws Error When `source` is empty, or is a non-URL file path that cannot be loaded
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
    const loaded = await loadPlaylistSource(trimmed);
    return {
      kind: 'playlist',
      playlist: loaded.playlist,
      sourceType: loaded.sourceType,
      source: loaded.source,
    };
  } catch {
    const item = buildUrlItem(trimmed, defaultDuration);
    const playlist = (await buildDP1Playlist({ items: [item], title: item.title })) as Playlist;
    return { kind: 'media', playlist, source: trimmed };
  }
}
