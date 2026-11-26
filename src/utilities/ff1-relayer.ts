import { defaultDeadlineFetch } from './http';
import * as logger from '../logger';
import { pairCommand } from './control/control-errors';
import type { Playlist } from '../types';

export interface RelayerCastResult {
  success: boolean;
  response?: Record<string, unknown>;
  error?: string;
  /**
   * Explanation for the user. For a non-2xx answer it is the relayer's raw
   * body, except for the device-connection errors 1003/1004, which get plain
   * copy instead (deviceConnectionFailure).
   */
  details?: string;
  /** HTTP status of a non-2xx relayer answer. */
  status?: number;
  /** ff-relayer's numeric `error.id` from a non-2xx JSON body, when present. */
  relayerErrorId?: number;
}

/** RELAYER_NO_DEVICE_SOCKET is ff-relayer's `/api/cast` error id for "no FF1 socket on this topic". */
export const RELAYER_NO_DEVICE_SOCKET = 1003;
/** RELAYER_DEVICE_TIMEOUT is ff-relayer's `/api/cast` error id for "the FF1 socket did not reply in 5 s". */
export const RELAYER_DEVICE_TIMEOUT = 1004;

/**
 * parseRelayerErrorId reads ff-relayer's `{"error":{"id":<number>}}` body.
 * Other bodies (plain text, HTML, the 410 `{"error":"<string>"}` shape)
 * return undefined.
 *
 * @param bodyText - Raw non-2xx response body
 * @returns The numeric error id, or undefined
 */
function parseRelayerErrorId(bodyText: string): number | undefined {
  try {
    const id = (JSON.parse(bodyText) as { error?: { id?: unknown } } | null)?.error?.id;
    return typeof id === 'number' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * deviceConnectionFailure turns ff-relayer's 1003/1004 into copy that says
 * what happened to the FF1 (ff-cli#125). Both mean "the FF1 is not usable on
 * the relayer right now", yet the raw `not found` body reads like a missing
 * credential, and users went looking for a key that does not exist: topic
 * casts are never key-checked (ff-relayer docs/api.md, Access control).
 *
 * Semantics come from ff-relayer PortalRelayer.handleCast and must stay in
 * step with it:
 * - 1003: no FF1 socket is on the topic, so nothing was sent. The FF1 is
 *   offline, still reconnecting (it redials on its own after a drop), or now
 *   uses another topic because it was reset or set up again.
 * - 1004: the command WAS broadcast to the FF1's socket and no reply came
 *   within 5 s (a weak link, or a socket the relayer has not yet dropped as
 *   stale). The FF1 may have run it, so the copy must never say "not sent"
 *   or invite a blind retry.
 * No "last seen" time is given: the relayer reports none, and this path runs
 * only when the FF1's LAN status is unreachable.
 *
 * @param id - ff-relayer error id
 * @param deviceLabel - Device name or ID, when the caller knows it
 * @returns Error and details, or undefined for any other id
 */
function deviceConnectionFailure(
  id: number | undefined,
  deviceLabel: string | undefined
): { error: string; details: string } | undefined {
  const subject = deviceLabel ? `FF1 "${deviceLabel}"` : 'The FF1';
  if (id === RELAYER_NO_DEVICE_SOCKET) {
    const pair = deviceLabel ? pairCommand(deviceLabel) : 'ff-cli device pair <name>';
    return {
      error: `${subject} is not connected to the relayer right now`,
      details:
        'The relayer has no open connection from this FF1 (relayer error 1003), so nothing was sent. ' +
        'This is not a key or credential problem: the relayer route needs no key. ' +
        'Check that the FF1 is on and online; it reconnects to the relayer by itself, so try again in a minute, ' +
        "or run ff-cli on the FF1's own network. " +
        'An FF1 on older FF OS is not on the relay channel this ff-cli uses: update it, or reach it on its own network. ' +
        `If the FF1 was reset or set up again since pairing, run \`${pair}\`.`,
    };
  }
  if (id === RELAYER_DEVICE_TIMEOUT) {
    return {
      error: `${subject} did not answer through the relayer within 5 seconds`,
      details:
        'The FF1 is connected to the relayer but did not reply in time (relayer error 1004), ' +
        'often on a weak Wi-Fi link or just after it went offline. ' +
        'It may still have run the command: check the FF1 before running it again.',
    };
  }
  return undefined;
}

function nestedOk(value: unknown): boolean | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ok === 'boolean') {
    return record.ok;
  }
  return nestedOk(record.message);
}

/**
 * sendPlaylistViaRelayer sends a display command through the mobile-compatible
 * FF1 relayer contract.
 *
 * The result preserves the relayer's HTTP failure status before interpreting
 * any response body. Successful responses must contain JSON when non-empty;
 * non-2xx responses may use plain text or HTML without obscuring the original
 * gateway failure.
 *
 * @param input - Relayer endpoint, optional compatibility key, paired topic,
 * playlist, optional device label for messages, and optional fetch
 * implementation.
 * @returns A structured result for handled request failures, HTTP statuses,
 * and JSON parsing errors.
 */
export async function sendPlaylistViaRelayer(input: {
  baseUrl: string;
  apiKey?: string;
  topicId: string;
  playlist: Playlist;
  deviceLabel?: string;
  fetchFn?: typeof fetch;
}): Promise<RelayerCastResult> {
  const result = await sendCastViaRelayer({
    ...input,
    body: {
      command: 'displayPlaylist',
      request: {
        dp1_call: input.playlist,
        intent: { action: 'now_display' },
      },
    },
  });
  if (result.success && nestedOk(result.response) === false) {
    return {
      success: false,
      error: 'FF1 rejected the relayer display command',
      details: JSON.stringify(result.response),
      response: result.response,
    };
  }
  return result;
}

/**
 * sendCastViaRelayer posts one cast body to the relayer topic endpoint and
 * returns the parsed JSON response without interpreting the device's answer.
 * It is shared by the legacy plaintext Play path and the secure `ff1Envelope`
 * path (ff1-control-v1 §10: the envelope rides the same topic cast).
 *
 * A non-2xx answer keeps its HTTP status and ff-relayer error id for callers
 * that route on them (secure-transport heldTopicGone); 1003/1004 get plain
 * copy (deviceConnectionFailure) and every other answer keeps its raw body.
 *
 * @param input - Relayer endpoint, optional compatibility key, paired topic,
 * cast body, optional device label for messages, and optional fetch
 * implementation.
 * @returns The parsed relayer response, or a structured failure.
 */
export async function sendCastViaRelayer(input: {
  baseUrl: string;
  apiKey?: string;
  topicId: string;
  body: Record<string, unknown>;
  deviceLabel?: string;
  fetchFn?: typeof fetch;
}): Promise<RelayerCastResult> {
  // Production default rides the shared deadline (#101 review).
  const fetchFn = input.fetchFn ?? defaultDeadlineFetch;
  let url: URL;
  try {
    url = new URL('/api/cast', input.baseUrl);
  } catch {
    return {
      success: false,
      error: 'Invalid FF1 relayer configuration',
      details: 'ff1Relayer.baseUrl must be a valid HTTP(S) URL',
    };
  }
  url.searchParams.set('topicID', input.topicId);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.apiKey) {
    headers['API-KEY'] = input.apiKey;
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      // The relayer accepts GET or POST with the same body. Node's standards-
      // compliant fetch rejects GET bodies, so CLI uses POST while preserving
      // the mobile request shape and topic query parameter.
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
    });
  } catch (error) {
    return {
      success: false,
      error: 'Could not reach the FF1 relayer',
      details: (error as Error).message,
    };
  }

  const bodyText = (await response.text()).trim();
  // HTTP status is authoritative for gateway failures. A non-2xx body is only
  // probed for ff-relayer's error id (relayerHttpFailure) and never fails on
  // it, so an HTML/plain-text 401 cannot hide the actionable missing-key
  // diagnosis behind a secondary JSON parsing error.
  if (!response.ok) {
    return relayerHttpFailure(response, bodyText, input);
  }

  let data: Record<string, unknown> = {};
  if (bodyText) {
    try {
      data = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return {
        success: false,
        error: `FF1 relayer returned non-JSON HTTP ${response.status}`,
        details: bodyText.slice(0, 200),
      };
    }
  }
  return { success: true, response: data };
}

/**
 * relayerHttpFailure describes a non-2xx relayer answer. HTTP status is
 * authoritative for gateway failures, so a body is read only for ff-relayer's
 * own JSON error id; anything else is reported as the raw body.
 *
 * @param response - The non-2xx response
 * @param bodyText - Its trimmed body
 * @param input - The cast's compatibility key and device label
 * @returns A structured failure
 */
function relayerHttpFailure(
  response: Response,
  bodyText: string,
  input: { apiKey?: string; deviceLabel?: string }
): RelayerCastResult {
  const relayerErrorId = parseRelayerErrorId(bodyText);
  const ids = relayerErrorId !== undefined ? { relayerErrorId } : {};
  const connection = deviceConnectionFailure(relayerErrorId, input.deviceLabel);
  if (connection) {
    logger.debug(`FF1 relayer returned HTTP ${response.status}: ${bodyText}`);
    return { success: false, ...connection, status: response.status, ...ids };
  }
  const needsCompatibilityKey = response.status === 401 && !input.apiKey;
  return {
    success: false,
    error: `FF1 relayer returned HTTP ${response.status}`,
    status: response.status,
    ...ids,
    details: needsCompatibilityKey
      ? 'This relayer deployment still requires its optional FF1_RELAYER_API_KEY compatibility gate.'
      : bodyText || response.statusText,
  };
}
