/**
 * FF1 Device Communication Module
 * Handles sending DP1 playlists to FF1 devices via the Relayer API
 */

import { defaultDeadlineFetch } from './http';
import * as logger from '../logger';
import { getFF1RelayerConfig } from '../config';
import type { FF1Device, Playlist } from '../types';
import { assertFF1CommandCompatibility, resolveConfiguredDevice } from './ff1-compatibility';
import { sendPlaylistViaRelayer } from './ff1-relayer';
import { getTopicId } from './topic-store';

const SEND_RETRY_ATTEMPTS = 3;
const SEND_RETRY_BASE_DELAY_MS = 750;
const RATE_LIMIT_STATUS = 429;
// Cap how long a device-supplied Retry-After can stall the CLI, so a buggy or
// hostile device cannot pin a command for minutes/hours.
const MAX_RETRY_DELAY_MS = 30_000;

interface SendPlaylistParams {
  playlist: Playlist;
  deviceName?: string;
}

interface SendPlaylistResult {
  success: boolean;
  device?: string;
  deviceName?: string;
  response?: Record<string, unknown>;
  message?: string;
  error?: string;
  details?: string;
  transport?: 'lan' | 'relayer';
}

export interface FF1DeviceDependencies {
  fetchFn?: typeof fetch;
  getTopicIdFn?: (deviceId: string) => string | null;
  getRelayerConfigFn?: () => { baseUrl: string; apiKey?: string };
  waitFn?: (delayMs: number) => Promise<void>;
  noticeFn?: (message: string) => void;
}

interface DeliveryDependencies {
  fetchFn: typeof fetch;
  getTopicIdFn: (deviceId: string) => string | null;
  getRelayerConfigFn: () => { baseUrl: string; apiKey?: string };
  waitFn: (delayMs: number) => Promise<void>;
  noticeFn: (message: string) => void;
}

/** Find an FF1 `ok` flag through the nested cast response envelopes. */
function nestedCastOk(value: unknown): boolean | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ok === 'boolean') {
    return record.ok;
  }
  return nestedCastOk(record.message);
}

/**
 * Sleep for a short duration before retrying transient network errors.
 *
 * @param {number} delayMs - Milliseconds to wait
 * @returns {Promise<void>} Promise that resolves after the delay
 */
function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * isTransientDeviceNetworkError returns true when a send failure is likely temporary.
 *
 * This classifier intentionally targets resolver and route-level failures that are
 * common on local mDNS/Wi-Fi environments. Permanent command errors should surface
 * immediately without retry loops.
 *
 * @param {unknown} error - Error thrown by fetch
 * @returns {boolean} True when retrying is likely to recover
 */
export function isTransientDeviceNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const networkCodes = new Set([
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNRESET',
  ]);

  const message = error.message || '';
  const messageLooksTransient =
    message.includes('fetch failed') ||
    message.includes('getaddrinfo') ||
    message.includes('EHOSTUNREACH') ||
    message.includes('ENOTFOUND') ||
    message.includes('ETIMEDOUT') ||
    message.includes('network timeout') ||
    message.includes('No route to host');

  if (messageLooksTransient) {
    return true;
  }

  const causeCode =
    error.cause &&
    typeof error.cause === 'object' &&
    'code' in error.cause &&
    typeof (error.cause as { code?: unknown }).code === 'string'
      ? (error.cause as { code: string }).code
      : undefined;

  return Boolean(causeCode && networkCodes.has(causeCode));
}

/**
 * parseRetryAfterMs converts an HTTP `Retry-After` header into milliseconds.
 *
 * Supports both forms from RFC 7231: a delta-seconds integer (e.g. "5") and an
 * HTTP-date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT"). Returns undefined when the
 * header is absent or unparseable, so callers can fall back to their own
 * backoff. A past date clamps to 0 (retry immediately).
 *
 * @param {string | null | undefined} headerValue - Raw Retry-After header value
 * @returns {number | undefined} Delay in milliseconds, or undefined if unknown
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // A valid HTTP-date always contains letters (month/day names, or the ISO
  // 'T'/'Z'). Requiring one rejects bare numeric junk (e.g. "-5", "5.5") that
  // Date.parse would otherwise misinterpret as a date.
  if (/[a-zA-Z]/.test(trimmed)) {
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }

  return undefined;
}

/**
 * Send a DP1 playlist to an FF1 device using the cast API
 *
 * This function sends the entire DP1 JSON payload to a configured FF1 device.
 * If a device name is provided, it searches for a device with that exact name.
 * If no device name is provided, it uses the first configured device.
 * The API-KEY header is only included if the device has an apiKey configured.
 *
 * @param {Object} params - Function parameters
 * @param {Object} params.playlist - Complete DP1 v1.0.0 playlist object to send
 * @param {string} [params.deviceName] - Name of the device to send to (exact match required)
 * @returns {Promise<Object>} Result object
 * @returns {boolean} returns.success - Whether the cast was successful
 * @returns {string} [returns.device] - Device host that received the playlist
 * @returns {string} [returns.deviceName] - Name of the device used
 * @returns {Object} [returns.response] - Response from the device
 * @returns {string} [returns.error] - Error message if failed
 * @throws {Error} When device configuration is invalid or missing
 * @example
 * // Send to first device
 * const result = await sendPlaylistToDevice({
 *   playlist: { version: '1.1.0', title: 'My Collection', items: [...] }
 * });
 *
 * @example
 * // Send to specific device by name
 * const result = await sendPlaylistToDevice({
 *   playlist: { version: '1.1.0', title: 'My Collection', items: [...] },
 *   deviceName: 'Living Room Display'
 * });
 */
export async function sendPlaylistToDevice(
  { playlist, deviceName }: SendPlaylistParams,
  overrides: FF1DeviceDependencies = {}
): Promise<SendPlaylistResult> {
  const dependencies: DeliveryDependencies = {
    // Production default rides the shared deadline; injected test fetches
    // are preserved untouched (#101 review).
    fetchFn: overrides.fetchFn ?? defaultDeadlineFetch,
    getTopicIdFn: overrides.getTopicIdFn ?? getTopicId,
    getRelayerConfigFn: overrides.getRelayerConfigFn ?? getFF1RelayerConfig,
    waitFn: overrides.waitFn ?? waitForRetry,
    noticeFn: overrides.noticeFn ?? logger.always,
  };
  let device: FF1Device | undefined;
  try {
    // Validate input
    if (!playlist || typeof playlist !== 'object') {
      return {
        success: false,
        error: 'Invalid playlist: must provide a valid DP-1 playlist object',
      };
    }

    const resolved = resolveConfiguredDevice(deviceName);
    if (!resolved.success || !resolved.device) {
      return {
        success: false,
        error: resolved.error || 'FF1 device is not configured correctly',
      };
    }
    device = resolved.device;

    const compatibility = await assertFF1CommandCompatibility(device, 'displayPlaylist', {
      fetchFn: dependencies.fetchFn,
    });
    if (!compatibility.compatible) {
      return {
        success: false,
        error: compatibility.error || 'FF1 OS does not support playlist casting',
        details: compatibility.version ? `Detected version ${compatibility.version}` : undefined,
      };
    }

    logger.info(`Sending playlist to FF1 device: ${device.host}`);

    const apiUrl = `${device.host}/api/cast`;

    // Wrap playlist in required structure
    const requestBody = {
      command: 'displayPlaylist',
      request: {
        dp1_call: playlist,
        intent: { action: 'now_display' },
      },
    };

    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add API-KEY header only if apiKey is provided
    if (device.apiKey) {
      headers['API-KEY'] = device.apiKey;
    }

    // Make the API request with bounded retries for transient local network
    // errors, device rate-limiting, and empty/non-JSON bodies (the device can
    // return an empty response on the first cast after boot).
    let response: Response | null = null;
    let responseData: Record<string, unknown> = {};
    // Describes a 2xx response whose body could not be parsed, so the post-loop
    // handler can report it clearly if every attempt is exhausted.
    let lastBodyIssue: string | null = null;
    for (let attempt = 1; attempt <= SEND_RETRY_ATTEMPTS; attempt += 1) {
      try {
        response = await dependencies.fetchFn(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        });

        // The device sheds bursts of commands with HTTP 429 to protect itself.
        // Treat it as transient: honor Retry-After when present, otherwise back
        // off, and retry within the bounded attempt budget.
        if (response.status === RATE_LIMIT_STATUS && attempt < SEND_RETRY_ATTEMPTS) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
          const retryDelay = Math.min(
            retryAfterMs ?? SEND_RETRY_BASE_DELAY_MS * attempt,
            MAX_RETRY_DELAY_MS
          );
          logger.warn(
            `Device rate-limited the command (attempt ${attempt}/${SEND_RETRY_ATTEMPTS}); retrying in ${retryDelay}ms`
          );
          response = null;
          await dependencies.waitFn(retryDelay);
          continue;
        }

        // Non-2xx (other than 429 handled above): surface via the post-loop
        // handler, which re-reads the body as error text.
        if (!response.ok) {
          break;
        }

        // 2xx: read the body defensively. An empty or non-JSON body is a known
        // transient hiccup (commonly the first cast after boot), so retry within
        // the attempt budget instead of throwing "Unexpected end of JSON input".
        const bodyText = (await response.text()).trim();
        if (bodyText === '') {
          lastBodyIssue = 'device returned an empty response body';
        } else {
          try {
            responseData = JSON.parse(bodyText) as Record<string, unknown>;
            lastBodyIssue = null;
            break;
          } catch {
            lastBodyIssue = `device returned a non-JSON response body: ${bodyText.slice(0, 200)}`;
          }
        }

        if (attempt < SEND_RETRY_ATTEMPTS) {
          const retryDelay = SEND_RETRY_BASE_DELAY_MS * attempt;
          logger.warn(
            `${lastBodyIssue} (attempt ${attempt}/${SEND_RETRY_ATTEMPTS}); retrying in ${retryDelay}ms`
          );
          response = null;
          await dependencies.waitFn(retryDelay);
          continue;
        }
        // Out of attempts; let the post-loop handler report the body issue.
        break;
      } catch (error) {
        const shouldRetry = attempt < SEND_RETRY_ATTEMPTS && isTransientDeviceNetworkError(error);
        if (!shouldRetry) {
          throw error;
        }

        const retryDelay = SEND_RETRY_BASE_DELAY_MS * attempt;
        logger.warn(
          `Transient network error while sending playlist (attempt ${attempt}/${SEND_RETRY_ATTEMPTS}): ${(error as Error).message}`
        );
        logger.debug(`Retrying playlist send in ${retryDelay}ms`);
        await dependencies.waitFn(retryDelay);
      }
    }

    if (!response) {
      const deviceLabel = device.name || device.host;
      return fallbackToRelayer({
        playlist,
        device,
        dependencies,
        lanFailure: {
          success: false,
          error: `Could not reach device "${deviceLabel}" at ${device.host}`,
          details:
            'Check that the device is powered on and reachable on your network. ' +
            'If the device IP changed (e.g. after a factory reset), run: ff-cli setup',
        },
      });
    }

    // Check response status
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Failed to cast to device: ${response.status} ${response.statusText}`);
      logger.debug(`Error details: ${errorText}`);

      if (response.status === RATE_LIMIT_STATUS) {
        const deviceLabel = device.name || device.host;
        return {
          success: false,
          error: `Device "${deviceLabel}" is busy and rate-limited the command`,
          details:
            'The Art Computer is shedding a burst of commands to protect itself. ' +
            'Wait a few seconds and try again.',
        };
      }

      return {
        success: false,
        error: `Device returned error ${response.status}: ${response.statusText}`,
        details: errorText,
      };
    }

    // 2xx but the body never parsed within the retry budget: report the HTTP
    // status and what was wrong rather than crashing on a JSON parse error.
    if (lastBodyIssue) {
      const deviceLabel = device.name || device.host;
      logger.error(
        `Cast to "${deviceLabel}" returned HTTP ${response.status} but ${lastBodyIssue}`
      );
      return {
        success: false,
        error: `Device "${deviceLabel}" accepted the request (HTTP ${response.status}) but returned no usable response`,
        details:
          `${lastBodyIssue}. This is often transient on the first cast after boot — ` +
          'wait a few seconds and try again.',
      };
    }

    if (nestedCastOk(responseData) === false) {
      return {
        success: false,
        error: `Device "${device.name || device.host}" rejected the display command`,
        details: JSON.stringify(responseData),
      };
    }

    logger.info('Successfully sent playlist to FF1 device');
    logger.debug(`Device response: ${JSON.stringify(responseData)}`);

    return {
      success: true,
      device: device.host,
      deviceName: device.name || device.host,
      response: responseData,
      message: 'Playlist successfully sent to FF1 device',
      transport: 'lan',
    };
  } catch (error) {
    const errorMessage = (error as Error).message;
    logger.error(`Error sending playlist to device: ${errorMessage}`);

    if (device && isTransientDeviceNetworkError(error)) {
      const deviceLabel = device.name || device.host;
      return fallbackToRelayer({
        playlist,
        device,
        dependencies,
        lanFailure: {
          success: false,
          error: `Could not reach device "${deviceLabel}" at ${device.host}`,
          details:
            'Check that the device is powered on and reachable on your network. ' +
            'If the device IP changed (e.g. after a factory reset), run: ff-cli setup',
        },
      });
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Fall back to the relayer only after LAN reachability is exhausted.
 *
 * Topic lookup is keyed by the stable physical device ID and happens only at
 * the fallback boundary, keeping the credential out of config and normal LAN
 * requests. Application/HTTP errors do not enter this path.
 */
async function fallbackToRelayer(input: {
  playlist: Playlist;
  device: FF1Device;
  dependencies: DeliveryDependencies;
  lanFailure: SendPlaylistResult;
}): Promise<SendPlaylistResult> {
  if (!input.device.id) {
    return {
      ...input.lanFailure,
      details: `${input.lanFailure.details} Pair the relayer with: ff-cli device pair ${input.device.name ?? '<device>'}`,
    };
  }

  let topicId: string | null;
  try {
    topicId = input.dependencies.getTopicIdFn(input.device.id);
  } catch (error) {
    return {
      ...input.lanFailure,
      details: `${input.lanFailure.details} Secure topic storage is unavailable: ${(error as Error).message}`,
    };
  }
  if (!topicId) {
    return {
      ...input.lanFailure,
      details: `${input.lanFailure.details} Pair this device for relayer fallback with: ff-cli device pair ${input.device.name ?? input.device.id}`,
    };
  }

  input.dependencies.noticeFn(
    `Notice: LAN device is unreachable; falling back to the FF1 relayer for ${input.device.name ?? input.device.id}.`
  );
  let relayer: { baseUrl: string; apiKey?: string };
  try {
    relayer = input.dependencies.getRelayerConfigFn();
  } catch (error) {
    return {
      success: false,
      error: 'Invalid FF1 relayer configuration',
      details: (error as Error).message,
      transport: 'relayer',
    };
  }
  const result = await sendPlaylistViaRelayer({
    ...relayer,
    topicId,
    playlist: input.playlist,
    fetchFn: input.dependencies.fetchFn,
  });
  if (!result.success) {
    return {
      success: false,
      error: result.error,
      details: result.details,
      transport: 'relayer',
    };
  }
  return {
    success: true,
    device: relayer.baseUrl,
    deviceName: input.device.name ?? input.device.id,
    response: result.response,
    message: 'Playlist successfully sent through the FF1 relayer',
    transport: 'relayer',
  };
}
