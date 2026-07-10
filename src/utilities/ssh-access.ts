/**
 * SSH access control for FF1 devices.
 */

import * as logger from '../logger';
import { assertFF1CommandCompatibility, resolveConfiguredDevice } from './ff1-compatibility';

interface SshAccessParams {
  enabled: boolean;
  deviceName?: string;
  publicKey?: string;
  ttlSeconds?: number;
}

interface SshAccessResult {
  success: boolean;
  device?: string;
  deviceName?: string;
  response?: Record<string, unknown>;
  error?: string;
  details?: string;
}

/**
 * Send an SSH access command to an FF1 device.
 *
 * @param {Object} params - Function parameters
 * @param {boolean} params.enabled - Whether to enable SSH access
 * @param {string} [params.deviceName] - Device name to target (defaults to first configured)
 * @param {string} [params.publicKey] - SSH public key to authorize (required for enable)
 * @param {number} [params.ttlSeconds] - Time-to-live in seconds for auto-disable
 * @returns {Promise<Object>} Result object
 * @returns {boolean} returns.success - Whether the command succeeded
 * @returns {string} [returns.device] - Device host used
 * @returns {string} [returns.deviceName] - Device name used
 * @returns {Object} [returns.response] - Response from device
 * @returns {string} [returns.error] - Error message if failed
 * @throws {Error} When device configuration is invalid or missing
 * @example
 * // Enable SSH for 30 minutes
 * const result = await sendSshAccessCommand({
 *   enabled: true,
 *   publicKey: 'ssh-ed25519 AAAAC3... user@host',
 *   ttlSeconds: 1800,
 * });
 */
export async function sendSshAccessCommand({
  enabled,
  deviceName,
  publicKey,
  ttlSeconds,
}: SshAccessParams): Promise<SshAccessResult> {
  try {
    if (enabled && (!publicKey || !publicKey.trim())) {
      return {
        success: false,
        error: 'Public key is required to enable SSH access',
      };
    }

    const resolved = resolveConfiguredDevice(deviceName);
    if (!resolved.success || !resolved.device) {
      return {
        success: false,
        error: resolved.error || 'FF1 device is not configured correctly',
      };
    }
    const device = resolved.device;

    const compatibility = await assertFF1CommandCompatibility(device, 'sshAccess');
    if (!compatibility.compatible) {
      return {
        success: false,
        error: compatibility.error || 'FF1 OS does not support SSH access command',
        details: compatibility.version ? `Detected version ${compatibility.version}` : undefined,
      };
    }

    const apiUrl = `${device.host}/api/cast`;

    const request: Record<string, unknown> = {
      enabled,
    };
    if (publicKey && publicKey.trim()) {
      request.publicKey = publicKey.trim();
    }
    if (typeof ttlSeconds === 'number') {
      request.ttlSeconds = ttlSeconds;
    }

    const requestBody = {
      command: 'sshAccess',
      request,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (device.apiKey) {
      headers['API-KEY'] = device.apiKey;
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`SSH access request failed: ${response.status} ${response.statusText}`);
      logger.debug(`Error details: ${errorText}`);
      return {
        success: false,
        error: `Device returned error ${response.status}: ${response.statusText}`,
        details: errorText,
      };
    }

    const responseData = (await response.json()) as Record<string, unknown>;
    logger.info('SSH access command succeeded');
    logger.debug(`Device response: ${JSON.stringify(responseData)}`);

    return {
      success: true,
      device: device.host,
      deviceName: device.name || device.host,
      response: responseData,
    };
  } catch (error) {
    logger.error(`Error sending SSH access command: ${(error as Error).message}`);
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}
