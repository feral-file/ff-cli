/**
 * FF1 device compatibility helpers for command preflight checks.
 */

import { fetchWithTimeout } from './http';
import { getFF1DeviceConfig } from '../config';
import { findConfiguredDeviceIndex } from './device-lookup';
import type { FF1Device, FF1DeviceConfig } from '../types';
import * as logger from '../logger';
import type { ControllerRecord } from './control/controller-store';
import { type SecureTransportDeps, runSecureCommand } from './control/secure-transport';
import { describeControlCode } from './control/control-errors';

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

interface FF1CommandPolicy {
  minimumVersion: string;
}

export type FF1Command = 'displayPlaylist' | 'sshAccess';

interface FF1DeviceSelectionResult {
  success: boolean;
  device?: FF1Device;
  error?: string;
}

interface ResolveDeviceOptions {
  getFF1DeviceConfigFn?: () => FF1DeviceConfig;
}

interface CompatibilityCheckOptions {
  fetchFn?: FetchFunction;
  /**
   * The device's enrolled controller record. When present the probe is sent
   * as a secure envelope (ff1-control-v1): a secured FF1 refuses plaintext on
   * the LAN, so a plaintext probe would always fail there.
   */
  controller?: { record: ControllerRecord; deps?: SecureTransportDeps };
}

interface FF1VersionProbe {
  version?: string;
  /** Set when the device refused the probe with an authorization answer. */
  refusal?: { error: string; details?: string };
}

export interface FF1CompatibilityResult {
  compatible: boolean;
  error?: string;
  details?: string;
  version?: string;
}

const FF1_COMMAND_POLICIES: Record<FF1Command, FF1CommandPolicy> = {
  displayPlaylist: {
    minimumVersion: '1.0.0',
  },
  sshAccess: {
    minimumVersion: '1.0.9',
  },
};

/**
 * Load and validate the configured FF1 device selected by name.
 *
 * @param {string} [deviceName] - Optional device name (case-insensitive) or host URL,
 *   resolved with the same matching rules as `device remove`/`default`/`rename`
 * @param {Object} [options] - Optional dependency overrides
 * @param {Function} [options.getFF1DeviceConfigFn] - Optional config loader override
 * @returns {FF1DeviceSelectionResult} Selected device or reason for failure
 * @throws {Error} Never throws; malformed configuration is returned as an error result
 * @example
 * const result = resolveConfiguredDevice('Living Room');
 */
export function resolveConfiguredDevice(
  deviceName?: string,
  options: ResolveDeviceOptions = {}
): FF1DeviceSelectionResult {
  const getFF1DeviceConfigFn = options.getFF1DeviceConfigFn || getFF1DeviceConfig;
  const deviceConfig = getFF1DeviceConfigFn();

  if (!deviceConfig.devices || deviceConfig.devices.length === 0) {
    return {
      success: false,
      error: 'No FF1 devices configured. Add devices to config.json under "ff1Devices"',
    };
  }

  let device = deviceConfig.devices[0];

  if (deviceName) {
    const index = findConfiguredDeviceIndex(deviceConfig.devices, deviceName);
    device = index === -1 ? undefined : (deviceConfig.devices[index] as FF1Device);
    if (!device) {
      const availableNames = deviceConfig.devices
        .map((item) => item.name)
        .filter(Boolean)
        .join(', ');
      return {
        success: false,
        error: `Device "${deviceName}" not found. Available devices: ${availableNames || 'none with names'}`,
      };
    }
    logger.info(`Found device by name: ${deviceName}`);
  } else {
    logger.info('Using first configured device');
  }

  if (!device.host) {
    return {
      success: false,
      error: 'Invalid device configuration: must include host',
    };
  }

  return {
    success: true,
    device,
  };
}

/**
 * Ensure the target device supports the requested FF1 command.
 *
 * @param {Object} device - FF1 device configuration
 * @param {FF1Command} command - Command to execute
 * @param {Object} [options] - Optional dependency overrides
 * @param {Function} [options.fetchFn] - Optional fetch implementation
 * @returns {Promise<FF1CompatibilityResult>} Compatibility result
 * @throws {Error} Never throws; network and parsing failures produce a compatible result
 * @example
 * const result = await assertFF1CommandCompatibility(device, 'displayPlaylist');
 */
export async function assertFF1CommandCompatibility(
  device: FF1Device,
  command: FF1Command,
  options: CompatibilityCheckOptions = {}
): Promise<FF1CompatibilityResult> {
  // Default probe fetch rides the shared deadline: a device that accepts
  // the TCP connection but never answers must not hang `ff-cli ssh`.
  const fetchFn =
    options.fetchFn || ((input: string, init?: RequestInit) => fetchWithTimeout(input, init ?? {}));
  const policy = getCommandPolicy(command);

  const versionResult =
    options.controller && device.id
      ? await detectFF1VersionSecurely(device as FF1Device & { id: string }, options.controller)
      : await detectFF1VersionSafely(device, buildVersionHeaders(device), fetchFn);
  if (versionResult?.refusal) {
    return { compatible: false, ...versionResult.refusal };
  }
  return resolveCompatibility(device, command, policy, versionResult);
}

/**
 * Return command compatibility requirements.
 *
 * @param {FF1Command} command - Command to check
 * @returns {FF1CommandPolicy} Policy metadata
 * @example
 * getCommandPolicy('sshAccess'); // { minimumVersion: '1.0.0' }
 */
function getCommandPolicy(command: FF1Command): FF1CommandPolicy {
  return FF1_COMMAND_POLICIES[command];
}

/**
 * Detect FF1 version and recover compatibility when detection fails.
 *
 * @param {FF1Device} device - Target device
 * @param {Object} headers - Request headers
 * @param {Function} fetchFn - Fetch implementation
 * @returns {Promise<FF1VersionProbe | null>} Detected version metadata
 */
async function detectFF1VersionSafely(
  device: FF1Device,
  headers: Record<string, string>,
  fetchFn: FetchFunction
): Promise<FF1VersionProbe | null> {
  try {
    return await detectFF1Version(device, headers, fetchFn);
  } catch (error) {
    logger.debug('FF1 version detection failed; continuing with command', (error as Error).message);
    return null;
  }
}

/**
 * Resolve final compatibility decision from detected version and policy.
 *
 * @param {FF1Device} device - Target device
 * @param {FF1Command} command - Command requested
 * @param {FF1CommandPolicy} policy - Version policy
 * @param {FF1VersionProbe | null} versionResult - Detected version probe
 * @returns {FF1CompatibilityResult} Compatibility decision
 */
function resolveCompatibility(
  device: FF1Device,
  command: FF1Command,
  policy: FF1CommandPolicy,
  versionResult: FF1VersionProbe | null
): FF1CompatibilityResult {
  if (!versionResult?.version) {
    logger.warn(`Could not verify FF1 OS version for ${device.name || device.host}`);
    return { compatible: true };
  }

  const normalizedVersion = normalizeVersion(versionResult.version);
  if (!normalizedVersion) {
    return {
      compatible: true,
      version: versionResult.version,
    };
  }

  if (compareVersions(normalizedVersion, policy.minimumVersion) < 0) {
    return {
      compatible: false,
      version: normalizedVersion,
      error: `Unsupported FF1 OS ${normalizedVersion} for ${command}. FF1 OS must be ${policy.minimumVersion} or newer.`,
    };
  }

  return {
    compatible: true,
    version: normalizedVersion,
  };
}

/**
 * Detect FF1 OS version via POST /api/cast with getDeviceStatus command.
 *
 * Reads `message.installedVersion` from the device status response.
 *
 * @param {FF1Device} device - Target device
 * @param {Record<string, string>} headers - Request headers (e.g. API-KEY)
 * @param {FetchFunction} fetchFn - Fetch implementation
 * @returns {Promise<FF1VersionProbe | null>} Version probe, a refusal, or null if unavailable
 * @example
 * const probe = await detectFF1Version(device, {}, fetch);
 */
async function detectFF1Version(
  device: FF1Device,
  headers: Record<string, string>,
  fetchFn: FetchFunction
): Promise<FF1VersionProbe | null> {
  try {
    const response = await fetchFn(`${device.host}/api/cast`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'getDeviceStatus', request: {} }),
    });

    if (!response.ok) {
      return refusalFromPublicError(
        response.status,
        await response.text(),
        device.name || device.id || device.host
      );
    }

    const data = (await response.json()) as { message?: { installedVersion?: string } };
    const version = data?.message?.installedVersion;
    if (!version) {
      return null;
    }

    return { version };
  } catch (_error) {
    return null;
  }
}

/**
 * refusalFromPublicError recognizes a secured FF1 refusing a plaintext LAN
 * cast (ff1-control-v1 §4.4, HTTP 403 `enrollment_required`). That answer
 * means every plaintext command will be refused, so the preflight stops with
 * the pairing guidance instead of sending the real command into the same 403.
 * Any other failure keeps the historical "could not verify" behavior.
 *
 * @param status - HTTP status
 * @param body - Response body text
 * @param label - Device name for the pair command
 * @returns A refusal probe, or null
 */
function refusalFromPublicError(
  status: number,
  body: string,
  label: string
): FF1VersionProbe | null {
  if (status !== 401 && status !== 403) {
    return null;
  }
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
    if (code === 'enrollment_required' || code === 'locked') {
      return { refusal: describeControlCode(code, label) };
    }
  } catch {
    // Not a control-protocol answer.
  }
  return null;
}

/**
 * TRANSIENT_PROBE_CODES are secure-probe answers that do not mean "this
 * controller may not proceed": the FF1 shed load (rate_limited, or the
 * router's storm protection surfacing as command_failed) or could not record
 * the replay window (internal_error, §4.3: not executed, retry with a new ctr).
 * The plaintext probe sees the same conditions as HTTP 429 and carries on, so
 * the secure probe does too; the real command then applies its own retries.
 */
const TRANSIENT_PROBE_CODES = new Set(['rate_limited', 'internal_error', 'command_failed']);

/**
 * detectFF1VersionSecurely runs the getDeviceStatus probe as a secure
 * envelope over the LAN only (no retry, no relayer: the probe never had
 * either). A protocol refusal (revoked, unknown controller, …) stops the
 * command with actionable guidance; an unreachable device degrades to
 * "could not verify", exactly like the plaintext probe.
 *
 * @param device - Device with a stable ID
 * @param controller - Enrolled controller record and transport seams
 * @returns Version probe, refusal, or null
 */
async function detectFF1VersionSecurely(
  device: FF1Device & { id: string },
  controller: { record: ControllerRecord; deps?: SecureTransportDeps }
): Promise<FF1VersionProbe | null> {
  const result = await runSecureCommand(
    {
      device,
      record: controller.record,
      cmd: 'getDeviceStatus',
      req: {},
      relayerFallback: false,
      retry: false,
    },
    controller.deps
  );
  if (!result.success) {
    if (result.code && !TRANSIENT_PROBE_CODES.has(result.code)) {
      return { refusal: { error: result.error!, details: result.details } };
    }
    logger.debug('Secure FF1 version probe failed; continuing with command', result.error);
    return null;
  }
  // res is the handler's existing body; accept both the bare status object
  // and the `{message:{…}}` wrapper the plaintext LAN reply uses.
  const res = result.response as {
    installedVersion?: unknown;
    message?: { installedVersion?: unknown };
  };
  const version = res?.installedVersion ?? res?.message?.installedVersion;
  return typeof version === 'string' && version ? { version } : null;
}

/**
 * Build headers shared by cast requests.
 *
 * @param {FF1Device} device - Target device
 * @returns {Record<string, string>} Headers map
 * @example
 * const headers = buildVersionHeaders(device);
 */
function buildVersionHeaders(device: FF1Device): Record<string, string> {
  const headers: Record<string, string> = {};
  if (device.apiKey) {
    headers['API-KEY'] = device.apiKey;
  }
  return headers;
}

/**
 * Parse and normalize a version string to x.y.z format.
 *
 * @param {string} version - Raw version string
 * @returns {string | null} Normalized semver-like version
 * @example
 * normalizeVersion('v1.2') // '1.2.0'
 */
function normalizeVersion(version: string): string | null {
  const raw = version.trim();
  const match = raw.match(/(?:v)?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return null;
  }

  const major = match[1];
  const minor = match[2];
  const patch = match[3] || '0';
  return `${major}.${minor}.${patch}`;
}

/**
 * Compare two semantic versions in x.y.z format.
 *
 * @param {string} left - First version
 * @param {string} right - Second version
 * @returns {number} 1 if left > right, -1 if left < right, 0 if equal
 * @example
 * compareVersions('1.2.1', '1.2.0'); // 1
 */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((value) => Number.parseInt(value, 10));
  const rightParts = right.split('.').map((value) => Number.parseInt(value, 10));

  for (let i = 0; i < 3; i++) {
    const leftPart = leftParts[i] || 0;
    const rightPart = rightParts[i] || 0;
    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}
