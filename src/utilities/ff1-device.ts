/**
 * FF1 Device Communication Module
 * Handles sending DP1 playlists to FF1 devices via the Relayer API
 */

import * as logger from '../logger';
import type { Playlist } from '../types';
import { assertFF1CommandCompatibility, resolveConfiguredDevice } from './ff1-compatibility';

const SEND_RETRY_ATTEMPTS = 3;
const SEND_RETRY_BASE_DELAY_MS = 750;

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
export async function sendPlaylistToDevice({
  playlist,
  deviceName,
}: SendPlaylistParams): Promise<SendPlaylistResult> {
  let device: { host: string; name?: string; apiKey?: string; topicID?: string } | undefined;
  try {
    // Validate input
    if (!playlist || typeof playlist !== 'object') {
      return {
        success: false,
        error: 'Invalid playlist: must provide a valid DP1 playlist object',
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

    const compatibility = await assertFF1CommandCompatibility(device, 'displayPlaylist');
    if (!compatibility.compatible) {
      return {
        success: false,
        error: compatibility.error || 'FF1 OS does not support playlist casting',
        details: compatibility.version ? `Detected version ${compatibility.version}` : undefined,
      };
    }

    logger.info(`Sending playlist to FF1 device: ${device.host}`);

    // Construct API URL with optional topicID
    let apiUrl = `${device.host}/api/cast`;
    if (device.topicID && device.topicID.trim() !== '') {
      apiUrl += `?topicID=${encodeURIComponent(device.topicID)}`;
      logger.debug(`Using topicID: ${device.topicID}`);
    }

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

    // Make the API request with bounded retries for transient local network errors.
    let response: Response | null = null;
    for (let attempt = 1; attempt <= SEND_RETRY_ATTEMPTS; attempt += 1) {
      try {
        response = await fetch(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        });
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
        await waitForRetry(retryDelay);
      }
    }

    if (!response) {
      const deviceLabel = device.name || device.host;
      return {
        success: false,
        error: `Could not reach device "${deviceLabel}" at ${device.host}`,
        details:
          'Check that the device is powered on and reachable on your network. ' +
          'If the device IP changed (e.g. after a factory reset), run: ff-cli setup',
      };
    }

    // Check response status
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Failed to cast to device: ${response.status} ${response.statusText}`);
      logger.debug(`Error details: ${errorText}`);

      return {
        success: false,
        error: `Device returned error ${response.status}: ${response.statusText}`,
        details: errorText,
      };
    }

    // Parse response
    const responseData = (await response.json()) as Record<string, unknown>;
    logger.info('Successfully sent playlist to FF1 device');
    logger.debug(`Device response: ${JSON.stringify(responseData)}`);

    return {
      success: true,
      device: device.host,
      deviceName: device.name || device.host,
      response: responseData,
      message: 'Playlist successfully sent to FF1 device',
    };
  } catch (error) {
    const errorMessage = (error as Error).message;
    logger.error(`Error sending playlist to device: ${errorMessage}`);

    if (device && isTransientDeviceNetworkError(error)) {
      const deviceLabel = device.name || device.host;
      return {
        success: false,
        error: `Could not reach device "${deviceLabel}" at ${device.host}`,
        details:
          'Check that the device is powered on and reachable on your network. ' +
          'If the device IP changed (e.g. after a factory reset), run: ff-cli setup',
      };
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}
