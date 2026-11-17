/**
 * Offline download for FF1 devices: `ff-cli download`.
 *
 * FF OS can keep a playlist's works on the device so they display with no
 * network. The device calls this its offline cache; the Feral File app calls
 * the action "Download", and so does this command. The wire contract is
 * ffos-user docs/controld-inbound-controller-messages.md, "Offline Artwork
 * Caching Inbound Messages". The parts this module depends on:
 *
 * - `downloadPlaylist` takes `{ dp1_call: <playlist> }` or
 *   `{ playlistUrl: <url> }`, queues the items and answers at once with
 *   `{ ok, status: "queued", total, queuedCount }`. The download itself runs
 *   afterwards, so the answer says nothing about whether a work is held.
 * - `getOfflineCacheStatus` with `{ sources: [...] }` answers one entry per
 *   item. An item is identified by its exact `source` string, never its DP-1
 *   `id`. `coverageComplete` and `bytes` are left out of an entry when they
 *   would be false or 0, so a missing field reads as false or 0.
 * - Both answer a failure as `{ ok: false, error: { code, message, retryable } }`
 *   inside a successful transport reply. A reply is a success only when its
 *   body says `ok: true`.
 *
 * Routing follows `ssh`: with a controller file the commands are sent as
 * ff1-control-v1 envelopes, otherwise as plaintext casts, and on both routes
 * over the LAN only. The relayer is not used: waiting means many status
 * reads, and a device that cannot be reached on the LAN is better reported
 * than polled through the relay. Both commands are controller tier on the
 * device, so a "Can display" grant is enough.
 */

import { fetchWithTimeout } from './http';
import * as logger from '../logger';
import { resolveConfiguredDevice } from './ff1-compatibility';
import { publicControlCode } from './ff1-device';
import {
  type LoadedPlaylist,
  PlaylistUrlLoadError,
  isPlaylistSourceUrl,
  loadPlaylistSource,
} from './playlist-source';
import type { FF1Device, FF1DeviceConfig } from '../types';
import type { ControllerRecord, ControllerStoreOptions } from './control/controller-store';
import { describeControlCode } from './control/control-errors';
import {
  type SecureTransportDeps,
  findSecureController,
  runSecureCommand,
} from './control/secure-transport';

/** DEFAULT_DOWNLOAD_TIMEOUT_SECONDS is how long `download` waits for the items. */
export const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 180;

/** POLL_INTERVAL_MS is the pause between two status reads while waiting. */
const POLL_INTERVAL_MS = 2000;

/**
 * STATUS_SOURCES_PER_REQUEST is the device's cap on `sources` in one
 * `getOfflineCacheStatus` request (MaxStatusSources). A longer list is
 * refused whole, so longer playlists are asked about in slices.
 */
const STATUS_SOURCES_PER_REQUEST = 1024;

/**
 * DEVICE_COMMAND_TIMEOUT_MS is the deadline of one request to the device.
 * `downloadPlaylist` classifies every item before it answers, which the
 * device bounds at 25 s inside its own 30 s reply deadline; the CLI's shared
 * 20 s default would give up on a large playlist the device is about to
 * queue.
 */
const DEVICE_COMMAND_TIMEOUT_MS = 35_000;

/** PENDING_STATES are the item states that can still change on their own. */
const PENDING_STATES = new Set(['queued', 'downloading']);

/** INLINE_STATE labels an item whose bytes are in the playlist body itself. */
const INLINE_STATE = 'inline';

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * DownloadOutcome is what `download` concluded about one item:
 * - `ready`: held in full; it displays with no network.
 * - `incomplete`: something is held, but not everything the work loads.
 * - `failed`: nothing usable is held, or the FF1 did not queue the item.
 * - `timed_out`: still queued or downloading when the wait ended.
 */
export type DownloadOutcome = 'ready' | 'incomplete' | 'failed' | 'timed_out';

/** DownloadItemReport is one playlist item's final (or latest) state. */
export interface DownloadItemReport {
  title: string;
  source: string;
  /** Device state, or `inline` for a `data:` item that needs no download. */
  state: string;
  bytes: number;
  coverageComplete: boolean;
  /** Device free text for an incomplete capture; wording is not stable. */
  reason?: string;
  outcome: DownloadOutcome;
}

/** DownloadResult is the outcome of one `download` run. */
export interface DownloadResult {
  success: boolean;
  error?: string;
  details?: string;
  device?: string;
  deviceName?: string;
  /** Items in the playlist as the FF1 resolved it. */
  total?: number;
  /** Distinct sources the FF1 queued. */
  queuedCount?: number;
  /** False when the run ended at the queue answer (`--no-wait` or a failure before it). */
  waited: boolean;
  timedOut?: boolean;
  items?: DownloadItemReport[];
}

/** DownloadParams are the inputs of one `download` run. */
export interface DownloadParams {
  source: string;
  deviceName?: string;
  wait: boolean;
  timeoutSeconds?: number;
  /** Called when an item is first seen and each time its state changes. */
  onItemState?: (item: DownloadItemReport) => void;
}

/** DownloadDependencies are optional test seams; production uses the defaults. */
export interface DownloadDependencies {
  fetchFn?: FetchFunction;
  getFF1DeviceConfigFn?: () => FF1DeviceConfig;
  /** Controller key store location (tests); defaults to the user config dir. */
  controllerStore?: ControllerStoreOptions;
  /** Unix-seconds clock for secure requests (tests). */
  nowFn?: () => number;
  loadPlaylistFn?: (source: string) => Promise<LoadedPlaylist>;
  /** Millisecond clock that measures the wait (tests). */
  clockMsFn?: () => number;
  sleepFn?: (delayMs: number) => Promise<void>;
}

/** TrackedItem is one distinct item source the wait follows. */
interface TrackedItem {
  title: string;
  source: string;
  inline: boolean;
}

/** DownloadSource is a loaded source: what to send and what to follow. */
export interface DownloadSource {
  request: Record<string, unknown>;
  tracked: TrackedItem[];
}

/** DeviceTarget is the resolved device with its route and transport seams. */
interface DeviceTarget {
  device: FF1Device;
  label: string;
  record: ControllerRecord | null;
  fetchFn: FetchFunction;
  secureDeps: SecureTransportDeps;
}

/** DeviceFailure is a failed device command, ready for a result. */
interface DeviceFailure {
  error: string;
  details?: string;
  /** True when the device said the same request may succeed later. */
  retryable: boolean;
}

type DeviceAnswer = { body: Record<string, unknown> } | { failure: DeviceFailure };

/** StatusItem is one `getOfflineCacheStatus` entry with the omitted fields filled in. */
interface StatusItem {
  state: string;
  bytes: number;
  coverageComplete: boolean;
  reason?: string;
}

/**
 * downloadPlaylist asks an FF1 to keep a playlist for display with no network
 * and, unless `wait` is false, follows every item until it is held, has
 * failed, or the timeout passes.
 *
 * @param {DownloadParams} params - Source, device and wait settings
 * @param {DownloadDependencies} [overrides] - Test seams
 * @returns {Promise<DownloadResult>} Result object; never throws. `success` is
 *   true only when every item is held with complete coverage, or, with
 *   `wait: false`, when the FF1 queued the playlist.
 * @example
 * const result = await downloadPlaylist({ source: 'playlist.json', wait: true });
 */
export async function downloadPlaylist(
  params: DownloadParams,
  overrides: DownloadDependencies = {}
): Promise<DownloadResult> {
  try {
    const source = await loadDownloadSource(params.source, overrides.loadPlaylistFn);
    const target = resolveTarget(params.deviceName, overrides);
    if ('failure' in target) {
      return { success: false, waited: false, ...target.failure };
    }
    return await runDownload(source, target, params, overrides);
  } catch (error) {
    const refusal = error as Error & { details?: string };
    return { success: false, waited: false, error: refusal.message, details: refusal.details };
  }
}

/**
 * runDownload queues the playlist on the device and then waits for it.
 *
 * @param source - Loaded source
 * @param target - Resolved device
 * @param params - Wait settings
 * @param overrides - Clock seams
 * @returns Download result
 */
async function runDownload(
  source: DownloadSource,
  target: DeviceTarget,
  params: DownloadParams,
  overrides: DownloadDependencies
): Promise<DownloadResult> {
  const base = { device: target.device.host, deviceName: target.label };
  const queued = await sendDeviceCommand(target, 'downloadPlaylist', source.request);
  if ('failure' in queued) {
    const { error, details } = queued.failure;
    return { success: false, waited: false, error, details, ...base };
  }
  const counts = {
    total: numberField(queued.body.total),
    queuedCount: numberField(queued.body.queuedCount),
  };
  if (!params.wait) {
    return { success: true, waited: false, ...counts, ...base };
  }
  const waited = await waitForItems(target, source.tracked, params, overrides);
  return { ...waited, ...counts, ...base };
}

/**
 * loadDownloadSource loads a `download` argument and returns the request to
 * send and the item sources to follow.
 *
 * A URL is fetched here as well as by the device: the device resolves
 * `playlistUrl` itself and answers only with counts, so reading the playlist
 * is the only way the CLI learns which sources to ask about. The same read
 * is what refuses a media file or web page before anything is sent.
 *
 * The playlist's signature is not verified here. `display` gates on it
 * because it sends for display; this command only asks the device to fetch
 * what the playlist names, and the device resolves the playlist under its
 * own rules and answers `resolve_failed` when it will not.
 *
 * @param {string} source - Playlist file path or http(s) playlist URL
 * @param {Function} [loadFn] - Playlist loader (tests)
 * @returns {Promise<DownloadSource>} Request and tracked items
 * @throws {Error} When the source is not a DP-1 playlist with item sources;
 *   `details` on the error carries the follow-up line
 */
export async function loadDownloadSource(
  source: string,
  loadFn: (source: string) => Promise<LoadedPlaylist> = loadPlaylistSource
): Promise<DownloadSource> {
  const trimmed = source.trim();
  const isUrl = isPlaylistSourceUrl(trimmed);
  let loaded: LoadedPlaylist;
  try {
    loaded = await loadFn(trimmed);
  } catch (error) {
    if (isUrl && (error as Partial<PlaylistUrlLoadError>)?.kind === 'json') {
      throw notAPlaylist(trimmed, 'it answers with a web page or media file');
    }
    throw error;
  }
  const playlist = loaded.playlist as { dpVersion?: unknown; items?: unknown } | null;
  if (typeof playlist?.dpVersion !== 'string' || !Array.isArray(playlist.items)) {
    throw notAPlaylist(trimmed, 'it has no dpVersion or no items');
  }
  const tracked = trackItems(playlist.items);
  if (tracked.length === 0) {
    throw new Error(
      `${trimmed} has no items with a source, so there is nothing to download. A playlist whose items the FF1 fills in itself cannot be followed from here.`
    );
  }
  return {
    request: isUrl ? { playlistUrl: trimmed } : { dp1_call: loaded.playlist },
    tracked,
  };
}

/**
 * notAPlaylist builds the refusal for a source that is not a DP-1 playlist.
 *
 * @param source - What the caller passed
 * @param why - What was found instead
 * @returns The error, with the follow-up line on `details`
 */
function notAPlaylist(source: string, why: string): Error {
  const error = new Error(`${source} is not a DP-1 playlist (${why}).`) as Error & {
    details?: string;
  };
  error.details =
    'download takes a playlist file or a playlist URL. To keep a single work, put it in a playlist first (ff-cli find or ff-cli build). Nothing was sent to the device.';
  return error;
}

/**
 * trackItems lists the distinct item sources of a playlist, in playlist order.
 *
 * Items that share a source share one cache entry on the device, so they are
 * one line here too, under the first item's title. An item without a source
 * is left out: the device skips it and has nothing to report for it.
 *
 * @param items - The playlist's `items`
 * @returns Tracked items
 */
function trackItems(items: unknown[]): TrackedItem[] {
  const bySource = new Map<string, TrackedItem>();
  for (const raw of items) {
    const item = raw as { source?: unknown; title?: unknown } | null;
    if (typeof item?.source !== 'string' || !item.source || bySource.has(item.source)) {
      continue;
    }
    bySource.set(item.source, {
      source: item.source,
      title: typeof item.title === 'string' && item.title ? item.title : item.source,
      // The device never queues a data: item: its bytes are in the playlist
      // body it stores, so the item is already kept and status has no entry.
      inline: item.source.startsWith('data:'),
    });
  }
  return [...bySource.values()];
}

/**
 * resolveTarget picks the device and its route (secure envelope or plaintext).
 *
 * @param deviceName - Device name, or undefined for the default device
 * @param overrides - Config, store and transport seams
 * @returns The target, or a failure when the device or its pairing is unusable
 */
function resolveTarget(
  deviceName: string | undefined,
  overrides: DownloadDependencies
): DeviceTarget | { failure: { error: string; details?: string } } {
  const resolved = resolveConfiguredDevice(deviceName, {
    getFF1DeviceConfigFn: overrides.getFF1DeviceConfigFn,
  });
  if (!resolved.success || !resolved.device) {
    return { failure: { error: resolved.error || 'FF1 device is not configured correctly' } };
  }
  const device = resolved.device;
  const secure = findSecureController(device, overrides.controllerStore);
  if (secure.failure) {
    return { failure: { error: secure.failure.error, details: secure.failure.details } };
  }
  const fetchFn: FetchFunction =
    overrides.fetchFn ??
    ((input, init) => fetchWithTimeout(input, init ?? {}, DEVICE_COMMAND_TIMEOUT_MS));
  return {
    device,
    label: device.name || device.id || device.host,
    record: secure.record,
    fetchFn,
    secureDeps: {
      fetchFn: fetchFn as typeof fetch,
      controllerStore: overrides.controllerStore,
      nowFn: overrides.nowFn,
    },
  };
}

/**
 * sendDeviceCommand sends one offline-cache command on the device's route and
 * returns the handler's answer body, or a failure with user-facing copy.
 *
 * @param target - Resolved device
 * @param command - `downloadPlaylist` or `getOfflineCacheStatus`
 * @param request - The command's request object
 * @returns The `ok: true` body, or a failure
 */
async function sendDeviceCommand(
  target: DeviceTarget,
  command: string,
  request: Record<string, unknown>
): Promise<DeviceAnswer> {
  try {
    const reply = target.record
      ? await sendSecurely(target, target.record, command, request)
      : await sendPlaintext(target, command, request);
    return 'failure' in reply ? reply : interpretBody(reply.body, target.label);
  } catch (error) {
    logger.debug(`${command} failed: ${(error as Error).message}`);
    return {
      failure: {
        error: `Could not reach ${target.label} at ${target.device.host}`,
        details: (error as Error).message,
        retryable: true,
      },
    };
  }
}

/**
 * sendSecurely sends the command as a secure envelope over the LAN, with the
 * transport's retry budget and no relayer fallback (see the module comment).
 *
 * A `command_failed` reply carries the handler's error body as JSON text in
 * `details`; when that body is an offline-cache answer it is handed back so
 * its code gets the same copy as on the plaintext route.
 *
 * @param target - Resolved device
 * @param record - Enrolled controller record
 * @param command - Command name
 * @param request - Request object
 * @returns The reply body, or a failure
 */
async function sendSecurely(
  target: DeviceTarget,
  record: ControllerRecord,
  command: string,
  request: Record<string, unknown>
): Promise<DeviceAnswer> {
  const result = await runSecureCommand(
    {
      device: target.device as FF1Device & { id: string },
      record,
      cmd: command,
      req: request,
      relayerFallback: false,
      retry: true,
    },
    target.secureDeps
  );
  if (result.success) {
    return { body: result.response ?? {} };
  }
  const handlerBody = result.code === 'command_failed' ? parseObject(result.details) : null;
  if (handlerBody && handlerBody.ok === false) {
    return { body: handlerBody };
  }
  return {
    failure: {
      error: result.error ?? `${target.label} refused the request`,
      details: result.details,
      // No protocol code means the device was not reached at all.
      retryable: !result.code,
    },
  };
}

/**
 * sendPlaintext sends the command as a plaintext LAN cast, the route for a
 * device ff-cli holds no controller file for. A secured FF1 refuses it with
 * a control-protocol public error, which gets the shared pairing guidance.
 *
 * @param target - Resolved device
 * @param command - Command name
 * @param request - Request object
 * @returns The reply body, or a failure
 */
async function sendPlaintext(
  target: DeviceTarget,
  command: string,
  request: Record<string, unknown>
): Promise<DeviceAnswer> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (target.device.apiKey) {
    headers['API-KEY'] = target.device.apiKey;
  }
  const response = await target.fetchFn(`${target.device.host}/api/cast`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command, request }),
  });
  const text = await response.text();
  if (!response.ok) {
    const code = publicControlCode(response.status, text);
    if (code) {
      const failure = describeControlCode(code, target.label);
      return { failure: { error: failure.error, details: failure.details, retryable: false } };
    }
    return {
      failure: {
        error: `Device returned error ${response.status}: ${response.statusText}`,
        details: text.slice(0, 500),
        retryable: response.status === 429 || response.status >= 500,
      },
    };
  }
  return { body: unwrapCastBody(parseObject(text) ?? {}) };
}

/**
 * unwrapCastBody returns the handler's body from a plaintext cast reply. The
 * LAN hub nests it under `message` (the shape `getDeviceStatus` is read from
 * elsewhere in this CLI); a bare body is accepted too. A string `message` is
 * an error text, not a wrapper.
 *
 * @param reply - Parsed reply
 * @returns The innermost body
 */
function unwrapCastBody(reply: Record<string, unknown>): Record<string, unknown> {
  let body = reply;
  for (let depth = 0; depth < 3; depth += 1) {
    const inner = body.message;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
      break;
    }
    body = inner as Record<string, unknown>;
  }
  return body;
}

/**
 * interpretBody accepts a handler body only when it says `ok: true`.
 *
 * A body with no `ok` at all is a failure too: FF OS without the offline
 * cache forwards an unknown command to the player, and whatever comes back
 * must not be reported as "queued".
 *
 * @param body - Handler body
 * @param label - Device name for messages
 * @returns The body, or a failure
 */
function interpretBody(body: Record<string, unknown>, label: string): DeviceAnswer {
  if (body.ok === true) {
    return { body };
  }
  if (body.ok !== false) {
    return {
      failure: {
        error: `${label} did not accept the download command. Its FF OS may be too old to keep works for display with no network.`,
        details: JSON.stringify(body).slice(0, 500),
        retryable: false,
      },
    };
  }
  return { failure: describeOfflineError(body.error, label) };
}

/**
 * describeOfflineError maps an offline-cache error onto user-facing copy.
 *
 * The codes are the device's (`offlineCacheErrorResponse` in ffos-user).
 * `error` is `{ code, message, retryable }` from the offline-cache handlers,
 * or a bare code string from the router's flat plaintext denial; the latter
 * is a control-protocol code and uses the shared table.
 *
 * @param error - The body's `error`
 * @param label - Device name for messages
 * @returns Failure copy
 */
function describeOfflineError(error: unknown, label: string): DeviceFailure {
  if (typeof error === 'string') {
    const failure = describeControlCode(error, label);
    return { error: failure.error, details: failure.details, retryable: false };
  }
  const detail = (error ?? {}) as { code?: unknown; message?: unknown; retryable?: unknown };
  const code = typeof detail.code === 'string' ? detail.code : 'unknown';
  const message = typeof detail.message === 'string' ? detail.message : undefined;
  return {
    error: offlineErrorHeadline(code, label),
    details: code === 'disabled' ? undefined : message,
    retryable: detail.retryable === true,
  };
}

/**
 * offlineErrorHeadline is the one-sentence message for an offline-cache code.
 *
 * @param code - Device error code
 * @param label - Device name
 * @returns The sentence
 */
function offlineErrorHeadline(code: string, label: string): string {
  switch (code) {
    case 'disabled':
      return `${label} has offline display turned off, so it cannot keep works to display with no network.`;
    case 'resolve_failed':
      return `${label} could not load the playlist.`;
    case 'busy':
      return `${label} is busy with another download or removal; try again in a moment.`;
    case 'invalid_request':
      return `${label} rejected the request as malformed.`;
    case 'unsupported_media':
      return `${label} cannot keep this kind of work: a live stream has no fixed file to hold.`;
    case 'offline_cache_error':
    case 'internal':
      return `${label} hit a storage or network error while handling the download.`;
    default:
      return `${label} refused the download (${code}).`;
  }
}

/**
 * waitForItems polls item status until every tracked item has settled or the
 * timeout passes, and builds the final result.
 *
 * A status read the device marks retryable (or that did not reach it) does
 * not end the wait: the download keeps running on the device, so the next
 * read is tried until the timeout. Any other failed read ends it.
 *
 * @param target - Resolved device
 * @param tracked - Items to follow
 * @param params - Timeout and progress callback
 * @param overrides - Clock seams
 * @returns Result without the device and count fields
 */
async function waitForItems(
  target: DeviceTarget,
  tracked: TrackedItem[],
  params: DownloadParams,
  overrides: DownloadDependencies
): Promise<DownloadResult> {
  const clockMsFn = overrides.clockMsFn ?? Date.now;
  const sleepFn = overrides.sleepFn ?? defaultSleep;
  const timeoutMs = (params.timeoutSeconds ?? DEFAULT_DOWNLOAD_TIMEOUT_SECONDS) * 1000;
  const startedAt = clockMsFn();
  const sources = tracked.filter((item) => !item.inline).map((item) => item.source);
  const announced = new Map<string, string>();
  let reports = buildReports(tracked, new Map());
  let lastFailure: DeviceFailure | undefined;

  for (;;) {
    const status = await readStatus(target, sources);
    if ('failure' in status) {
      if (!status.failure.retryable) {
        return { success: false, waited: true, ...status.failure, items: reports };
      }
      lastFailure = status.failure;
    } else {
      lastFailure = undefined;
      reports = buildReports(tracked, status.items);
      announceChanges(reports, announced, params.onItemState);
      if (reports.every((report) => report.outcome !== 'timed_out')) {
        return summarize(reports, false);
      }
    }
    const remainingMs = timeoutMs - (clockMsFn() - startedAt);
    if (remainingMs <= 0) {
      return summarize(reports, true, lastFailure);
    }
    await sleepFn(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
}

/** defaultSleep resolves after `delayMs` milliseconds. */
function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * readStatus reads the status of `sources`, in slices the device accepts and
 * through every page of each slice.
 *
 * The device caps a page at 1000 entries, below the 1024 sources one request
 * may name, so a full slice can itself need a second page (`nextCursor`).
 *
 * @param target - Resolved device
 * @param sources - Item sources to ask about
 * @returns Status by source, or the first failure
 */
async function readStatus(
  target: DeviceTarget,
  sources: string[]
): Promise<{ items: Map<string, StatusItem> } | { failure: DeviceFailure }> {
  const items = new Map<string, StatusItem>();
  for (let start = 0; start < sources.length; start += STATUS_SOURCES_PER_REQUEST) {
    const slice = sources.slice(start, start + STATUS_SOURCES_PER_REQUEST);
    let cursor: string | undefined;
    do {
      const request = cursor ? { sources: slice, cursor } : { sources: slice };
      const answer = await sendDeviceCommand(target, 'getOfflineCacheStatus', request);
      if ('failure' in answer) {
        return answer;
      }
      collectStatusItems(answer.body.items, items);
      const next = answer.body.nextCursor;
      // A repeated cursor would loop forever on a device bug; stop instead.
      cursor = typeof next === 'string' && next && next !== cursor ? next : undefined;
    } while (cursor);
  }
  return { items };
}

/**
 * collectStatusItems adds a page of status entries to `into`, filling in the
 * fields the device omits when they are false or 0.
 *
 * @param entries - The reply's `items`
 * @param into - Status by source
 */
function collectStatusItems(entries: unknown, into: Map<string, StatusItem>): void {
  if (!Array.isArray(entries)) {
    return;
  }
  for (const raw of entries) {
    const entry = raw as Record<string, unknown> | null;
    if (typeof entry?.source !== 'string' || typeof entry.state !== 'string') {
      continue;
    }
    into.set(entry.source, {
      state: entry.state,
      bytes: numberField(entry.bytes) ?? 0,
      coverageComplete: entry.coverageComplete === true,
      reason: typeof entry.reason === 'string' ? entry.reason : undefined,
    });
  }
}

/**
 * buildReports turns the latest status into one report per tracked item.
 *
 * A source the device has no entry for is `not_cached`: after the queue
 * answer that means the device did not queue it (a stream, a source it could
 * not classify, or one it has since removed), and it will not change on its
 * own.
 *
 * @param tracked - Items to report on, in playlist order
 * @param status - Latest status by source
 * @returns Reports in playlist order
 */
function buildReports(
  tracked: TrackedItem[],
  status: Map<string, StatusItem>
): DownloadItemReport[] {
  return tracked.map((item) => {
    const seen: StatusItem = item.inline
      ? { state: INLINE_STATE, bytes: 0, coverageComplete: true }
      : (status.get(item.source) ?? { state: 'not_cached', bytes: 0, coverageComplete: false });
    return {
      title: item.title,
      source: item.source,
      ...seen,
      outcome: outcomeOf(seen),
    };
  });
}

/**
 * outcomeOf classifies one item. `coverageComplete` is the device's only
 * stable signal that everything the work loads is held, so a `ready` entry
 * without it is incomplete; `partial` and `broken_online` are finished
 * captures with gaps. A queued or downloading item is `timed_out` even while
 * the wait still runs: that is what it becomes if the wait ends now, and the
 * wait ends early exactly when no item reads that way.
 *
 * @param item - Latest status
 * @returns The outcome
 */
function outcomeOf(item: StatusItem): DownloadOutcome {
  if (PENDING_STATES.has(item.state)) {
    return 'timed_out';
  }
  if (item.state === INLINE_STATE || (item.state === 'ready' && item.coverageComplete)) {
    return 'ready';
  }
  return item.state === 'failed' || item.state === 'not_cached' ? 'failed' : 'incomplete';
}

/**
 * announceChanges reports each item whose state differs from the last one
 * announced, so a long wait shows movement without repeating itself.
 *
 * @param reports - Latest reports
 * @param announced - Last announced state by source (updated in place)
 * @param onItemState - Progress callback
 */
function announceChanges(
  reports: DownloadItemReport[],
  announced: Map<string, string>,
  onItemState?: (item: DownloadItemReport) => void
): void {
  for (const report of reports) {
    if (announced.get(report.source) === report.state) {
      continue;
    }
    announced.set(report.source, report.state);
    onItemState?.(report);
  }
}

/**
 * summarize builds the final result: success only when every item is held
 * with complete coverage, otherwise an error that counts what is missing.
 *
 * @param reports - Final reports
 * @param timedOut - Whether the wait ended on the timeout
 * @param lastFailure - A status read that was still failing at the timeout
 * @returns Download result
 */
function summarize(
  reports: DownloadItemReport[],
  timedOut: boolean,
  lastFailure?: DeviceFailure
): DownloadResult {
  const count = (outcome: DownloadOutcome) =>
    reports.filter((report) => report.outcome === outcome).length;
  const parts = [
    count('failed') ? `${count('failed')} failed` : '',
    count('incomplete') ? `${count('incomplete')} incomplete` : '',
    count('timed_out') ? `${count('timed_out')} timed out` : '',
  ].filter(Boolean);
  if (parts.length === 0) {
    return { success: true, waited: true, timedOut: false, items: reports };
  }
  return {
    success: false,
    waited: true,
    timedOut,
    items: reports,
    error: `${count('ready')} of ${reports.length} held for display with no network: ${parts.join(', ')}.`,
    details: lastFailure
      ? `The last status read failed: ${lastFailure.error}`
      : timedOut
        ? 'The FF1 keeps downloading after the wait ends; run the command again to check.'
        : undefined,
  };
}

/** numberField returns a finite number, or undefined for anything else. */
function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** parseObject parses JSON text into an object, or returns null. */
function parseObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
