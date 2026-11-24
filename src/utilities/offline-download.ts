/**
 * Offline download for FF1 devices: `ff-cli download`.
 *
 * FF OS can keep a playlist's works on the device so they display with no
 * network. The device calls this its offline cache; the Feral File app calls
 * the action "Download", and so does this command. The wire contract is
 * ffos-user docs/controld-inbound-controller-messages.md, "Offline Artwork
 * Caching Inbound Messages". The parts this module depends on:
 *
 * - `downloadPlaylist` with `{ dp1_call: <playlist> }` queues the items and
 *   answers at once with `{ ok, status: "queued", total, queuedCount }`. The
 *   download itself runs afterwards, so the answer says nothing about whether
 *   a work is held.
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
 *
 * The command exits 0 only for what it checked, so it takes only a playlist
 * whose items it can name exactly: a local file with a `source` on every
 * item, no inline (`data:`) source and no dynamic query. The device stores an
 * inline item with the playlist and never captures it, so it has no status
 * entry and nothing says whether what the item loads is held; such a playlist
 * is refused rather than reported as held. So is an item that names a whole
 * series: the device expands it into editions whose sources it does not
 * report back. The device also accepts `{ playlistUrl }` and
 * resolves dynamic queries, but then the device decides which sources are
 * queued (the hosted document can change between two fetches, and a dynamic
 * query replaces `items`), and a status read by the CLI's own list of
 * sources could report "held" for a playlist the device never queued that
 * way. Do not add those inputs back without a way to read the queued sources
 * from the device.
 *
 * Item sources can be signed URLs. Everything this module returns for the
 * terminal (titles, reasons, errors) goes through redactUrls; the exact
 * source is kept only for the request and for matching status entries.
 */

import { fetchWithTimeout } from './http';
import * as logger from '../logger';
import { resolveConfiguredDevice } from './ff1-compatibility';
import { publicControlCode } from './ff1-device';
import { type LoadedPlaylist, isPlaylistSourceUrl, loadPlaylistSource } from './playlist-source';
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

/**
 * UNKNOWN_STATE is an item's state before any status read has answered.
 * It is not `not_cached`: that would read as "the FF1 did not queue it".
 */
const UNKNOWN_STATE = 'unknown';

/** PENDING_STATES are the item states that can still change on their own. */
const PENDING_STATES = new Set(['queued', 'downloading', UNKNOWN_STATE]);

/**
 * TRANSIENT_SECURE_CODES are the control-protocol answers that say the
 * command was not run and may be sent again (retryableReply in
 * control/secure-transport.ts). The router's storm protection is the fourth:
 * a `command_failed` whose handler body is `{ error: "rate_limited" }`.
 */
const TRANSIENT_SECURE_CODES = new Set(['busy', 'rate_limited', 'internal_error']);

/** MAX_LABEL_LENGTH bounds the label of an item that has no title. */
const MAX_LABEL_LENGTH = 80;

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * DownloadOutcome is what `download` concluded about one item:
 * - `ready`: held in full; it displays with no network.
 * - `incomplete`: something is held, but not everything the work loads.
 * - `failed`: nothing usable is held, or the FF1 did not queue the item.
 * - `timed_out`: still queued or downloading, or never read, when the wait ended.
 */
export type DownloadOutcome = 'ready' | 'incomplete' | 'failed' | 'timed_out';

/** DownloadItemReport is one playlist item's final (or latest) state. */
export interface DownloadItemReport {
  /** Terminal-safe label: the item's title, or its redacted source. */
  title: string;
  /** Exact source, for matching only. Never print it: it may carry credentials. */
  source: string;
  /** Device state, or `unknown` before the first status read. */
  state: string;
  bytes: number;
  coverageComplete: boolean;
  /** Device free text for an incomplete capture, URLs redacted; wording is not stable. */
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
    const stopped = error as Error & { details?: string };
    return {
      success: false,
      waited: false,
      error: redactUrls(stopped.message),
      details: stopped.details && redactUrls(stopped.details),
    };
  }
}

/**
 * redactUrls removes the userinfo, query and fragment of every URL in a
 * string bound for the terminal. Item sources are often signed URLs, and the
 * device quotes them in its `reason` and error texts, so a query string can
 * be a credential. The path stays: it is what tells one work from another.
 *
 * @param {string} text - Text that may contain URLs
 * @returns {string} The text with `?…` and `#…` in place of each query and fragment
 * @example
 * redactUrls('fetch_failed:https://u:p@cdn.example/x?token=abc'); // 'fetch_failed:https://cdn.example/x?…'
 */
export function redactUrls(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s"<>]*)/gi, (_match, scheme: string, rest) => {
    // Punctuation that ends the URL belongs to the sentence around it (the
    // device joins reasons with "; "), so it is put back after the URL.
    const [, url, trailing] = /^(.*?)([;:,.)\]]*)$/.exec(rest as string) as RegExpExecArray;
    const [, authorityAndPath, query, fragment] = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(
      url
    ) as RegExpExecArray;
    const slash = authorityAndPath.indexOf('/');
    const authority = slash === -1 ? authorityAndPath : authorityAndPath.slice(0, slash);
    const path = slash === -1 ? '' : authorityAndPath.slice(slash);
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    return `${scheme}${host}${path}${query ? '?…' : ''}${fragment ? '#…' : ''}${trailing}`;
  });
}

/**
 * redactReason cuts an item's `reason` at its first `?` or `#`. A reason
 * names URLs and the references a work loads (a glTF texture as
 * `texture.png?token=…`), and nothing marks where a query or fragment ends
 * (it may hold a quote or a space), so everything after the first one goes:
 * a later reason is lost rather than a parameter shown. Titles do not get
 * this: "Work #1" is not a fragment.
 *
 * @param {string} reason - Device reason text
 * @returns {string} The reason up to its first `?` or `#`, with `…` after it
 * @example
 * redactReason("gltf_external_dependency:texture.png?name=artist's&token=abc"); // 'gltf_external_dependency:texture.png?…'
 */
export function redactReason(reason: string): string {
  // redactUrls still runs on what is kept, for a URL's userinfo.
  const cut = reason.search(/[?#]/);
  // A "?" that ends the reason has nothing after it to remove.
  if (cut === -1 || cut === reason.length - 1) {
    return redactUrls(reason);
  }
  return `${redactUrls(reason.slice(0, cut))}${reason[cut]}…`;
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
 * Only a playlist file whose every item names its source is accepted; the
 * module comment says why a URL or a dynamic playlist is refused.
 *
 * The playlist's signature is not verified here. `display` gates on it
 * because it sends for display; this command only asks the device to fetch
 * what the playlist names, and the device resolves the playlist under its
 * own rules and answers `resolve_failed` when it will not.
 *
 * @param {string} source - Playlist file path
 * @param {Function} [loadFn] - Playlist loader (tests)
 * @returns {Promise<DownloadSource>} Request and tracked items
 * @throws {Error} When the source is a URL, is not a DP-1 playlist, is
 *   dynamic, has an item with no source, an inline one or a whole series, or
 *   has a member name the device would read differently from this command;
 *   `details` on the error
 *   carries the follow-up line when there is one
 */
export async function loadDownloadSource(
  source: string,
  loadFn: (source: string) => Promise<LoadedPlaylist> = loadPlaylistSource
): Promise<DownloadSource> {
  const trimmed = source.trim();
  if (isPlaylistSourceUrl(trimmed)) {
    throw refusal(
      'download takes a playlist file, not a URL.',
      'Save the playlist first: `ff-cli fetch <id-or-url> -o playlist.json` for one published to a feed, or save the JSON from any other address. Then run `ff-cli download playlist.json`.'
    );
  }
  const loaded = await loadFn(trimmed);
  const playlist = loaded.playlist as Record<string, unknown> | null;
  refuseMisspelledMembers(trimmed, playlist);
  if (typeof playlist?.dpVersion !== 'string' || !Array.isArray(playlist.items)) {
    throw refusal(
      `${trimmed} is not a DP-1 playlist (it has no dpVersion or no items).`,
      'To keep a single work, put it in a playlist first (ff-cli find or ff-cli build).'
    );
  }
  if (isDynamicPlaylist(playlist)) {
    throw refusal(
      `${trimmed} is a dynamic playlist: the FF1 fills in its items from a query, so this command cannot name them or check what is held.`,
      'Download a playlist that lists its items.'
    );
  }
  const items = playlist.items as unknown[];
  if (items.length === 0) {
    throw refusal(`${trimmed} has no items, so there is nothing to download.`);
  }
  refuseUnusableSources(trimmed, items);
  return { request: { dp1_call: loaded.playlist }, tracked: trackItems(items) };
}

/**
 * refusal builds an error that stops the run before anything is sent.
 *
 * @param message - What is wrong
 * @param followUp - What to do instead
 * @returns The error, with the follow-up line on `details`
 */
function refusal(message: string, followUp?: string): Error {
  const error = new Error(message) as Error & { details?: string };
  error.details = [followUp, 'Nothing was sent to the device.'].filter(Boolean).join(' ');
  return error;
}

/**
 * isDynamicPlaylist reports whether the device would replace the playlist's
 * items by resolving a query: DP-1 `dynamicQuery`, or the legacy
 * `dynamicQueries` array the device still honors (ffos-user dp1/dp1.go,
 * resolveDynamicPlaylist).
 *
 * @param playlist - Parsed playlist
 * @returns True when the playlist carries either form
 */
function isDynamicPlaylist(playlist: Record<string, unknown>): boolean {
  const legacy = playlist.dynamicQueries;
  return (
    (playlist.dynamicQuery !== undefined && playlist.dynamicQuery !== null) ||
    (Array.isArray(legacy) && legacy.length > 0)
  );
}

/**
 * sourceOf returns an item's `source` when it is a non-empty string.
 *
 * @param item - One entry of `items`
 * @returns The source, or undefined
 */
function sourceOf(item: unknown): string | undefined {
  const source = (item as { source?: unknown } | null)?.source;
  return typeof source === 'string' && source ? source : undefined;
}

/**
 * itemLabel is the terminal-safe name of an item: its title, or its source
 * with URLs redacted (see redactUrls) and cut to a line's length. A `data:`
 * source is megabytes of payload, so it is named by its position instead.
 *
 * @param item - One entry of `items`
 * @param index - Zero-based position in the playlist
 * @returns The label
 */
function itemLabel(item: unknown, index: number): string {
  const title = (item as { title?: unknown } | null)?.title;
  if (typeof title === 'string' && title) {
    return redactUrls(title);
  }
  const source = sourceOf(item);
  if (!source || isDataUri(source)) {
    return `item ${index + 1}`;
  }
  const label = redactUrls(source);
  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…` : label;
}

/**
 * isDataUri matches the device's rule for an inline item (isDataURI in
 * ffos-user offlinecache/classify.go): the scheme compares case-insensitively.
 *
 * @param source - Item source
 * @returns True for a `data:` source in any letter case
 */
function isDataUri(source: string): boolean {
  return source.slice(0, 5).toLowerCase() === 'data:';
}

/**
 * refuseUnusableSources stops a playlist this command could not vouch for:
 * an item with no `source` is skipped by the device, and an inline `data:`
 * item is stored with the playlist but never captured, so the device has no
 * status for it and an inline page that loads something from the network
 * would be reported as held when it is not. A whole-series item is expanded
 * by the device into editions this command never hears the sources of, so
 * it would report the series held on the strength of one of them.
 *
 * @param file - Playlist path, for the message
 * @param items - The playlist's `items`
 * @throws {Error} Naming the items at fault
 */
function refuseUnusableSources(file: string, items: unknown[]): void {
  const labels = (test: (source: string | undefined) => boolean) =>
    items.flatMap((item, index) => (test(sourceOf(item)) ? [itemLabel(item, index)] : []));
  const missing = labels((source) => !source);
  if (missing.length > 0) {
    throw refusal(
      `${file} has ${missing.length} of ${items.length} items with no source: ${missing.join(', ')}.`,
      'The FF1 would skip them, so the playlist would not be held whole.'
    );
  }
  const inline = labels((source) => isDataUri(source!));
  if (inline.length > 0) {
    throw refusal(
      `${file} has ${inline.length} of ${items.length} items with an inline (data:) source: ${inline.join(', ')}.`,
      'The FF1 does not download an inline source, so this command cannot check that what it loads is held. Host the work at an address, or take the item out.'
    );
  }
  const series = items.flatMap((item, index) =>
    isWholeSeriesItem(item) ? [itemLabel(item, index)] : []
  );
  if (series.length > 0) {
    throw refusal(
      `${file} has ${series.length} of ${items.length} items that name a whole series: ${series.join(', ')}.`,
      'The FF1 expands a series into its editions, and this command cannot name them or check that each is held. List the editions as items of their own, each with its `tokenId`.'
    );
  }
}

/**
 * isWholeSeriesItem reports whether the device would expand an item into the
 * editions of a series. It is the device's own test (ffos-user dp1/series.go,
 * isSeriesItem): `seriesRegistry` provenance whose contract has a `seriesId`
 * and no `tokenId`. The same provenance with a `tokenId` names one edition
 * and is downloaded like any other item. Exact member names are enough here
 * because refuseMisspelledMembers has already run.
 *
 * @param item - One entry of `items`
 * @returns True for a whole-series item
 */
function isWholeSeriesItem(item: unknown): boolean {
  const provenance = (item as { provenance?: { type?: unknown; contract?: unknown } } | null)
    ?.provenance;
  if (provenance?.type !== 'seriesRegistry') {
    return false;
  }
  const contract = provenance.contract as { seriesId?: unknown; tokenId?: unknown } | null;
  if (!contract || contract.seriesId === undefined || contract.seriesId === null) {
    return false;
  }
  return !(typeof contract.tokenId === 'string' && contract.tokenId !== '');
}

/**
 * The member names the checks in this file read, and the ones the device
 * reads to decide what to queue (ffos-user dp1/dp1.go and dp1/series.go,
 * dp1-go playlist/playlist.go): the playlist and item identity a series is
 * resolved by, the dynamic query in both forms, and an item's source and
 * provenance.
 */
const CHECKED_MEMBERS = [
  'dpVersion',
  'id',
  'items',
  'dynamicQuery',
  'dynamicQueries',
  'source',
  'provenance',
  'type',
  'contract',
  'chain',
  'address',
  'seriesId',
  'tokenId',
];

const CHECKED_BY_FOLD = new Map(CHECKED_MEMBERS.map((name) => [foldMemberName(name), name]));

/**
 * foldMemberName folds a member name the way Go's encoding/json matches one
 * to a struct field: letter case is ignored, and for the ASCII names above
 * the only other characters that match are the long s (U+017F) for `s` and
 * the Kelvin sign (U+212A) for `k`.
 *
 * @param name - Member name as written
 * @returns The folded name
 */
function foldMemberName(name: string): string {
  return name
    .replace(/\u017f/g, 's')
    .replace(/\u212a/g, 'k')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * refuseMisspelledMembers stops a playlist in which any object has a member
 * the device would read as one of CHECKED_MEMBERS though it is not spelled
 * that way (`SeriesId`, `DynamicQuery`, a second `tokenid`). The device's
 * decoder matches names in any letter case and lets the later of two matches
 * win, so such a document means one thing to the checks here and another to
 * the device. Refusing it lets every other check read exact names.
 *
 * @param file - Playlist path, for the message
 * @param playlist - Parsed playlist
 * The name itself is safe to print: it folds to one of ours, so it is ASCII
 * letters and at most those two characters.
 *
 * @throws {Error} Naming the first such member and where it is
 */
function refuseMisspelledMembers(file: string, playlist: unknown): void {
  const walk = (value: unknown, where: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${where}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    for (const [name, member] of Object.entries(value)) {
      const exact = CHECKED_BY_FOLD.get(foldMemberName(name));
      if (exact !== undefined && exact !== name) {
        throw refusal(
          `${file} has a member "${name}" ${where ? `in ${where}` : 'at the top level'}: the FF1 reads it as "${exact}", and this command does not.`,
          `Spell it "${exact}", or take it out.`
        );
      }
      // A name that is not one of ours is file text: keep it printable and short.
      const step = name.replace(/[^\x21-\x7e]/g, '?').slice(0, 40);
      walk(member, where ? `${where}.${step}` : step);
    }
  };
  walk(playlist, '');
}

/**
 * trackItems lists the distinct item sources of a playlist, in playlist order.
 *
 * Items that share a source share one cache entry on the device, so they are
 * one line here too, under the first item's label. refuseUnusableSources has
 * already run, so every item has a source.
 *
 * @param items - The playlist's `items`
 * @returns Tracked items
 */
function trackItems(items: unknown[]): TrackedItem[] {
  const bySource = new Map<string, TrackedItem>();
  items.forEach((item, index) => {
    const source = sourceOf(item)!;
    if (bySource.has(source)) {
      return;
    }
    bySource.set(source, { source, title: itemLabel(item, index) });
  });
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
 * Failure texts are redacted here, the one place every device answer passes:
 * the device quotes item sources in its messages (see redactUrls).
 *
 * @param target - Resolved device
 * @param command - `downloadPlaylist` or `getOfflineCacheStatus`
 * @param request - The command's request object
 * @param timeoutMs - Deadline of the whole command: one signal is shared by
 *   every request it takes, so the secure transport's second request after a
 *   `replay` answer gets what is left of the time, not the full time again
 * @returns The `ok: true` body, or a failure
 */
async function sendDeviceCommand(
  target: DeviceTarget,
  command: string,
  request: Record<string, unknown>,
  timeoutMs: number = DEVICE_COMMAND_TIMEOUT_MS
): Promise<DeviceAnswer> {
  const signal = AbortSignal.timeout(timeoutMs);
  const bounded: DeviceTarget = {
    ...target,
    fetchFn: (input, init) => target.fetchFn(input, { ...init, signal }),
  };
  const answer = await sendOnRoute(bounded, command, request);
  if (!('failure' in answer)) {
    return answer;
  }
  const { error, details, retryable } = answer.failure;
  return {
    failure: { error: redactUrls(error), details: details && redactUrls(details), retryable },
  };
}

/**
 * sendOnRoute sends the command as a secure envelope when ff-cli holds a
 * controller file for the device, and as a plaintext cast otherwise.
 *
 * @param target - Resolved device, its fetch already bounded
 * @param command - Command name
 * @param request - Request object
 * @returns The `ok: true` body, or a failure
 */
async function sendOnRoute(
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
 * sendSecurely sends the command as a secure envelope over the LAN, with no
 * relayer fallback (see the module comment). Only `downloadPlaylist` uses the
 * transport's retry budget: a status read is retried by the wait loop, which
 * is what keeps the retries inside `--timeout`. So a transient answer to a
 * status read (TRANSIENT_SECURE_CODES) comes back retryable.
 *
 * A `command_failed` reply carries the handler's error body in `handlerBody`.
 * The router's storm limit (`error: "rate_limited"`) is transient like the
 * protocol code of that name; any other offline-cache answer is handed back
 * so its code gets the same copy as on the plaintext route.
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
      retry: command === 'downloadPlaylist',
    },
    { ...target.secureDeps, fetchFn: target.fetchFn as typeof fetch }
  );
  if (result.success) {
    return { body: result.response ?? {} };
  }
  const handlerBody = result.code === 'command_failed' ? result.handlerBody : undefined;
  const rateLimited = handlerBody?.error === 'rate_limited';
  if (handlerBody?.ok === false && !rateLimited) {
    return { body: handlerBody };
  }
  return {
    failure: {
      error: result.error ?? `${target.label} refused the request`,
      details: result.details,
      // No protocol code means the device was not reached at all.
      retryable: !result.code || TRANSIENT_SECURE_CODES.has(result.code) || rateLimited,
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
 * `--timeout` is one deadline for the whole wait, requests included: it is
 * handed to readStatus as `remainingMs`, which bounds every request and
 * page by what is left. A read the deadline cut short is dropped whole, so
 * the reports stay at the last complete read; a half-read playlist would
 * show the unread items as not kept.
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
  const deadlineMs = clockMsFn() + timeoutMs;
  const remainingMs = () => deadlineMs - clockMsFn();
  const sources = tracked.map((item) => item.source);
  const announced = new Map<string, string>();
  let reports = buildReports(tracked, new Map(), UNKNOWN_STATE);
  let lastFailure: DeviceFailure | undefined;

  for (;;) {
    const status = await readStatus(target, sources, remainingMs);
    if ('timedOut' in status) {
      return summarize(reports, true, lastFailure);
    }
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
    const leftMs = remainingMs();
    if (leftMs <= 0) {
      return summarize(reports, true, lastFailure);
    }
    await sleepFn(Math.min(POLL_INTERVAL_MS, leftMs));
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
 * No request starts once the deadline has passed, each request is bounded by
 * the time left, and an answer that lands after the deadline is not used.
 *
 * @param target - Resolved device
 * @param sources - Item sources to ask about
 * @param remainingMs - Milliseconds left before the wait's deadline
 * @returns Status by source, the first failure, or `timedOut`
 */
async function readStatus(
  target: DeviceTarget,
  sources: string[],
  remainingMs: () => number
): Promise<{ items: Map<string, StatusItem> } | { failure: DeviceFailure } | { timedOut: true }> {
  const items = new Map<string, StatusItem>();
  for (let start = 0; start < sources.length; start += STATUS_SOURCES_PER_REQUEST) {
    const slice = sources.slice(start, start + STATUS_SOURCES_PER_REQUEST);
    let cursor: string | undefined;
    do {
      const request = cursor ? { sources: slice, cursor } : { sources: slice };
      const leftMs = remainingMs();
      if (leftMs <= 0) {
        return { timedOut: true };
      }
      const answer = await sendDeviceCommand(
        target,
        'getOfflineCacheStatus',
        request,
        Math.min(DEVICE_COMMAND_TIMEOUT_MS, leftMs)
      );
      if (remainingMs() < 0) {
        return { timedOut: true };
      }
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
      // A state is a bare word; anything else is not printed.
      state: /^[a-z_]+$/.test(entry.state) ? entry.state : 'unknown',
      bytes: numberField(entry.bytes) ?? 0,
      coverageComplete: entry.coverageComplete === true,
      reason: typeof entry.reason === 'string' ? redactReason(entry.reason) : undefined,
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
 * @param missingState - State of a source with no entry; `unknown` before the first read
 * @returns Reports in playlist order
 */
function buildReports(
  tracked: TrackedItem[],
  status: Map<string, StatusItem>,
  missingState: string = 'not_cached'
): DownloadItemReport[] {
  return tracked.map((item) => {
    const seen: StatusItem = status.get(item.source) ?? {
      state: missingState,
      bytes: 0,
      coverageComplete: false,
    };
    return { ...item, ...seen, outcome: outcomeOf(seen) };
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
  if (item.state === 'ready' && item.coverageComplete) {
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
