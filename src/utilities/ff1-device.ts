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
import type { ControllerStoreOptions, ControllerRecord } from './control/controller-store';
import { findSecureController, runSecureCommand } from './control/secure-transport';
import { describeControlCode } from './control/control-errors';
import { isTransientDeviceNetworkError, parseRetryAfterMs } from './device-network';

export { isTransientDeviceNetworkError, parseRetryAfterMs };

const SEND_RETRY_ATTEMPTS = 3;
const SEND_RETRY_BASE_DELAY_MS = 750;
const RATE_LIMIT_STATUS = 429;
// Cap how long a device-supplied Retry-After can stall the CLI, so a buggy or
// hostile device cannot pin a command for minutes/hours.
const MAX_RETRY_DELAY_MS = 30_000;
// PUBLIC_CONTROL_CODES are the ff1-control-v1 §4.4 public errors a secured
// FF1 can answer a plaintext cast with (LAN 401/403, relayer RPC message).
const PUBLIC_CONTROL_CODES = new Set([
  'bad_envelope',
  'unknown_controller',
  'bad_signature',
  'enrollment_required',
  'envelope_required',
  'locked',
]);

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
  /** Controller key store location (tests); defaults to the user config dir. */
  controllerStore?: ControllerStoreOptions;
  /** Unix-seconds clock for secure requests (tests). */
  nowFn?: () => number;
}

interface DeliveryDependencies {
  fetchFn: typeof fetch;
  getTopicIdFn: (deviceId: string) => string | null;
  getRelayerConfigFn: () => { baseUrl: string; apiKey?: string };
  waitFn: (delayMs: number) => Promise<void>;
  noticeFn: (message: string) => void;
  controllerStore?: ControllerStoreOptions;
  nowFn?: () => number;
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
    controllerStore: overrides.controllerStore,
    nowFn: overrides.nowFn,
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

    // A stored controller file means this FF1 was paired under the control
    // protocol (ff1-control-v1): every command goes as a secure envelope and
    // the legacy plaintext path below is never used for it.
    const secure = findSecureController(device, dependencies.controllerStore);
    if (secure.failure) {
      return { success: false, error: secure.failure.error, details: secure.failure.details };
    }

    const compatibility = await assertFF1CommandCompatibility(device, 'displayPlaylist', {
      fetchFn: dependencies.fetchFn,
      controller: secure.record
        ? { record: secure.record, deps: secureDeps(dependencies) }
        : undefined,
    });
    if (!compatibility.compatible) {
      return {
        success: false,
        error: compatibility.error || 'FF1 OS does not support playlist casting',
        details:
          compatibility.details ??
          (compatibility.version ? `Detected version ${compatibility.version}` : undefined),
      };
    }

    if (secure.record) {
      return sendPlaylistSecurely(playlist, device, secure.record, dependencies);
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

      const publicCode = publicControlCode(response.status, errorText);
      if (publicCode) {
        const failure = describeControlCode(publicCode, device.name || device.id || device.host);
        return { success: false, error: failure.error, details: failure.details };
      }

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
 * secureDeps forwards the delivery seams to the secure transport.
 *
 * @param dependencies - Resolved delivery dependencies
 * @returns Secure transport dependencies
 */
function secureDeps(dependencies: DeliveryDependencies) {
  return {
    fetchFn: dependencies.fetchFn,
    getTopicIdFn: dependencies.getTopicIdFn,
    getRelayerConfigFn: dependencies.getRelayerConfigFn,
    waitFn: dependencies.waitFn,
    noticeFn: dependencies.noticeFn,
    controllerStore: dependencies.controllerStore,
    nowFn: dependencies.nowFn,
  };
}

/**
 * sendPlaylistSecurely delivers displayPlaylist as a secure envelope with the
 * same retry budget and LAN-then-relayer fallback as the plaintext path. The
 * `req` is the unchanged plaintext request object (§3.3).
 *
 * @param playlist - DP-1 playlist
 * @param device - Device with a stored controller record
 * @param record - Enrolled controller record
 * @param dependencies - Delivery seams
 * @returns Send result
 */
async function sendPlaylistSecurely(
  playlist: Playlist,
  device: FF1Device,
  record: ControllerRecord,
  dependencies: DeliveryDependencies
): Promise<SendPlaylistResult> {
  logger.info(`Sending playlist to FF1 device (secure): ${device.host}`);
  const result = await runSecureCommand(
    {
      device: device as FF1Device & { id: string },
      record,
      cmd: 'displayPlaylist',
      req: { dp1_call: playlist, intent: { action: 'now_display' } },
      relayerFallback: true,
      retry: true,
    },
    secureDeps(dependencies)
  );
  const deviceName = device.name || device.host;
  if (!result.success) {
    return {
      success: false,
      error: result.error,
      details: result.details,
      transport: result.transport,
    };
  }
  if (nestedCastOk(result.response) === false) {
    return {
      success: false,
      error: `Device "${deviceName}" rejected the display command`,
      details: JSON.stringify(result.response),
      transport: result.transport,
    };
  }
  const viaRelayer = result.transport === 'relayer';
  return {
    success: true,
    device: device.host,
    deviceName,
    response: result.response,
    message: viaRelayer
      ? 'Playlist successfully sent through the FF1 relayer'
      : 'Playlist successfully sent to FF1 device',
    transport: result.transport,
  };
}

/**
 * publicControlCode extracts a control-protocol public error (§4.4) from a
 * LAN 401/403, e.g. a secured FF1 refusing plaintext with
 * `enrollment_required`. Other bodies return undefined.
 *
 * @param status - HTTP status
 * @param body - Response text
 * @returns The code, or undefined
 */
export function publicControlCode(status: number, body: string): string | undefined {
  if (status !== 401 && status !== 403) {
    return undefined;
  }
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' && PUBLIC_CONTROL_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * plaintextRefusalCode finds a control-protocol refusal in a relayer reply:
 * the flat plaintext denial `{ok:false,error:"<code>",command,message}` or the
 * public-error shape `{error:{code}}`, at any of the relayer's nesting levels.
 *
 * @param response - Parsed relayer response
 * @returns A §4.4 code, or undefined
 */
function plaintextRefusalCode(response: unknown): string | undefined {
  let current: unknown = response;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    const record = current as Record<string, unknown>;
    const error = record.error as unknown;
    const code =
      record.ok === false && typeof error === 'string'
        ? error
        : (error as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && PUBLIC_CONTROL_CODES.has(code)) {
      return code;
    }
    current = record.message;
  }
  return undefined;
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
  // A secured FF1 refuses a plaintext relayer cast it will not run
  // (ff1-control-v1 §4.4/§7.2) with a flat `{ok:false,error:"<code>"}` RPC
  // message; map it to pairing guidance instead of a bare rejection.
  const refusal = plaintextRefusalCode(result.response);
  if (refusal) {
    const failure = describeControlCode(refusal, input.device.name ?? input.device.id);
    return { success: false, error: failure.error, details: failure.details, transport: 'relayer' };
  }
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
