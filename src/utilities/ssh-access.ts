/**
 * SSH access control for FF1 devices.
 *
 * The sshAccess command is LAN-only: it is POSTed straight to the device's
 * `/api/cast` endpoint and never falls back to the relayer.
 *
 * Topic proof (feral-file#3551 phase 0): on a claimed FF1, newer FF OS rejects
 * a LAN `sshAccess` (and `connect`) cast unless it carries the relayer topic in
 * the `X-FF1-Topic` header, answering HTTP 401 `{"error":{"code":"topic_required"}}`.
 * The topic is the secret that `ff-cli device pair` stores in the OS keyring;
 * holding it proves the CLI was paired by the owner through the mobile app.
 * Older firmware and unclaimed devices ignore the header, so the request is
 * still sent without it when no topic is stored. The topic value must never be
 * logged or placed in an error message.
 */

import { fetchWithTimeout } from './http';
import * as logger from '../logger';
import { assertFF1CommandCompatibility, resolveConfiguredDevice } from './ff1-compatibility';
import { getTopicId } from './topic-store';
import type { FF1Device, FF1DeviceConfig } from '../types';

/** FF1_TOPIC_HEADER is the LAN cast header that carries the relayer topic proof. */
export const FF1_TOPIC_HEADER = 'X-FF1-Topic';

/** TOPIC_REQUIRED_CODE is the device error code for a missing or wrong topic proof. */
const TOPIC_REQUIRED_CODE = 'topic_required';

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

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

/** SshAccessDependencies are optional test seams; production uses the defaults. */
export interface SshAccessDependencies {
  fetchFn?: FetchFunction;
  getTopicIdFn?: (deviceId: string) => string | null;
  getFF1DeviceConfigFn?: () => FF1DeviceConfig;
}

/**
 * sendSshAccessCommand sends an SSH access command to an FF1 device over the LAN.
 *
 * @param {Object} params - Function parameters
 * @param {boolean} params.enabled - Whether to enable SSH access
 * @param {string} [params.deviceName] - Device name to target (defaults to first configured)
 * @param {string} [params.publicKey] - SSH public key to authorize (required for enable)
 * @param {number} [params.ttlSeconds] - Time-to-live in seconds for auto-disable
 * @param {SshAccessDependencies} [overrides] - Optional fetch, topic-store, and config seams
 * @returns {Promise<SshAccessResult>} Result object; never throws. A device that
 *   demands topic proof yields `success: false` with an actionable pairing error.
 * @example
 * // Enable SSH for 30 minutes
 * const result = await sendSshAccessCommand({
 *   enabled: true,
 *   publicKey: 'ssh-ed25519 AAAAC3... user@host',
 *   ttlSeconds: 1800,
 * });
 */
export async function sendSshAccessCommand(
  { enabled, deviceName, publicKey, ttlSeconds }: SshAccessParams,
  overrides: SshAccessDependencies = {}
): Promise<SshAccessResult> {
  const fetchFn: FetchFunction =
    overrides.fetchFn ?? ((input, init) => fetchWithTimeout(input, init ?? {}));
  try {
    if (enabled && (!publicKey || !publicKey.trim())) {
      return { success: false, error: 'Public key is required to enable SSH access' };
    }

    const resolved = resolveConfiguredDevice(deviceName, {
      getFF1DeviceConfigFn: overrides.getFF1DeviceConfigFn,
    });
    if (!resolved.success || !resolved.device) {
      return {
        success: false,
        error: resolved.error || 'FF1 device is not configured correctly',
      };
    }
    const device = resolved.device;

    const compatibility = await assertFF1CommandCompatibility(device, 'sshAccess', {
      fetchFn: overrides.fetchFn,
    });
    if (!compatibility.compatible) {
      return {
        success: false,
        error: compatibility.error || 'FF1 OS does not support SSH access command',
        details: compatibility.version ? `Detected version ${compatibility.version}` : undefined,
      };
    }

    const topicId = lookupTopicId(device, overrides.getTopicIdFn ?? getTopicId);
    const response = await fetchFn(`${device.host}/api/cast`, {
      method: 'POST',
      headers: buildSshAccessHeaders(device, topicId),
      body: JSON.stringify(buildSshAccessBody(enabled, publicKey, ttlSeconds)),
    });
    return await interpretSshAccessResponse(device, response);
  } catch (error) {
    logger.error(`Error sending SSH access command: ${(error as Error).message}`);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * lookupTopicId reads the stored relayer topic for a device, or null.
 *
 * A missing device ID, a missing topic, or an unavailable keyring all degrade
 * to "send without the header": unclaimed devices and older firmware accept
 * that, and a device that does require proof answers 401 topic_required, which
 * is mapped to the pairing guidance. Failing hard here would break SSH on every
 * device the header is irrelevant to.
 */
function lookupTopicId(
  device: FF1Device,
  getTopicIdFn: (deviceId: string) => string | null
): string | null {
  if (!device.id) {
    return null;
  }
  try {
    return getTopicIdFn(device.id);
  } catch (error) {
    logger.debug(`Secure topic storage unavailable: ${(error as Error).message}`);
    return null;
  }
}

/** buildSshAccessHeaders returns the cast headers, adding topic proof only when known. */
function buildSshAccessHeaders(device: FF1Device, topicId: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (device.apiKey) {
    headers['API-KEY'] = device.apiKey;
  }
  if (topicId) {
    headers[FF1_TOPIC_HEADER] = topicId;
  }
  return headers;
}

/** buildSshAccessBody returns the `sshAccess` cast body. */
function buildSshAccessBody(
  enabled: boolean,
  publicKey: string | undefined,
  ttlSeconds: number | undefined
): { command: 'sshAccess'; request: Record<string, unknown> } {
  const request: Record<string, unknown> = { enabled };
  if (publicKey && publicKey.trim()) {
    request.publicKey = publicKey.trim();
  }
  if (typeof ttlSeconds === 'number') {
    request.ttlSeconds = ttlSeconds;
  }
  return { command: 'sshAccess', request };
}

/** interpretSshAccessResponse maps the device HTTP response onto an SshAccessResult. */
async function interpretSshAccessResponse(
  device: FF1Device,
  response: Response
): Promise<SshAccessResult> {
  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`SSH access request failed: ${response.status} ${response.statusText}`);
    logger.debug(`Error details: ${errorText}`);
    if (isTopicRequired(response.status, errorText)) {
      return { success: false, error: topicRequiredMessage(device), details: errorText };
    }
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
}

/** isTopicRequired reports whether a device rejection is the topic-proof 401. */
function isTopicRequired(status: number, body: string): boolean {
  if (status !== 401) {
    return false;
  }
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return parsed?.error?.code === TOPIC_REQUIRED_CODE;
  } catch {
    return false;
  }
}

/**
 * topicRequiredMessage tells the user how to pair the CLI for this device.
 *
 * The same guidance covers "never paired" and "stored topic is stale" (the
 * device rotated its topic): pairing again replaces the keyring entry. A device
 * without a stable ID cannot be paired, so it is told to re-add first.
 */
function topicRequiredMessage(device: FF1Device): string {
  const label = device.name || device.host;
  const pairCommand = `ff-cli device pair ${quoteArg(label)}`;
  const base = `This FF1 requires ff-cli to be paired before SSH access can be changed.`;
  if (!device.id) {
    return `${base} Re-add the device with its ID (ff-cli device add --id <FF1 device ID>), then run \`${pairCommand}\` and choose "Pair with ff-cli" in the Feral File app.`;
  }
  return `${base} Run \`${pairCommand}\` and choose "Pair with ff-cli" in the Feral File app, then retry.`;
}

/** quoteArg double-quotes a shell argument that contains whitespace or quotes. */
function quoteArg(value: string): string {
  return /[\s"'$`\\]/.test(value) ? JSON.stringify(value) : value;
}
