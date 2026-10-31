/**
 * Problem reports to Feral File support (`ff-cli report`).
 *
 * The report goes to support-logs' public `POST /v2/cli/reports`, which mints
 * the support bundle id the app uses (`Support [<id>]`) and answers with a
 * short-lived token valid only for that bundle's FF1 log submission. ff-cli
 * holds no support credential: it is a public package, so any key it shipped
 * would be public too. support-intake later moves the stored report into the
 * support inbox, where it becomes a case like a report from the app.
 *
 * With an Art Computer, the report carries `device_id`, `version` and `branch`
 * from its LAN `GET /api/status`, and once the report has posted the FF1 is
 * sent its existing `uploadLogs` command with the token as `apiKey`, so its
 * logs land under the same bundle id. FF OS sends that key as `x-api-key` to
 * `/v2/ff1/log-submissions`; no firmware change is involved.
 *
 * What must not change:
 * - The body is the report text, the reply address when given, this ff-cli's
 *   version, the OS and Node versions, and the Art Computer block. Nothing
 *   else leaves this machine: no config, keys, topic, or controller files.
 * - The report is posted once and never retried: a request that timed out may
 *   have been stored, and a resend would open a second case.
 * - The device upload is best effort and never changes the outcome: the
 *   report has already reached support by then.
 */

import os from 'node:os';
import { defaultDeadlineFetch, fetchWithTimeout } from './http';
import { USER_AGENT } from './user-agent';
import { parsePlaylistPrivateKeyToKeyObject } from './ed25519-key-derive';
import { publicControlCode } from './ff1-device';
import { describeControlCode } from './control/control-errors';
import {
  type SecureTransportDeps,
  findSecureController,
  runSecureCommand,
} from './control/secure-transport';
import type { FF1Device } from '../types';

/** MAX_REPORT_BYTES is support-logs' cap on `report`, in UTF-8 bytes. */
export const MAX_REPORT_BYTES = 32_768;

/** STATUS_TIMEOUT_MS bounds the LAN status read, so an absent FF1 delays a report only briefly. */
const STATUS_TIMEOUT_MS = 5_000;

/** SUPPORT_BUNDLE_ID is the app's reference format: 13 base62 characters (ff-app support_bundle_id.dart). */
const SUPPORT_BUNDLE_ID = /^[0-9A-Za-z]{13}$/;

/** SUPPORT_EMAIL is the human route when the report cannot be posted. */
const SUPPORT_EMAIL = 'support@feralfile.com';

/** ReportDevice is the Art Computer block of a report. */
export interface ReportDevice {
  device_id?: string;
  version?: string;
  branch?: string;
}

/** ReportPayload is the `POST /v2/cli/reports` body. */
export interface ReportPayload {
  report: string;
  ff_cli_version: string;
  reporter_email?: string;
  os: string;
  node_version: string;
  device?: ReportDevice;
}

/** ReportReceipt is what support-logs answers a stored report with. */
export interface ReportReceipt {
  supportBundleId: string;
  /** Absent only when the answer carried none; the device upload is then skipped. */
  uploadToken?: string;
}

/** ReportFailure names what went wrong and, in `details`, what to do next. */
export interface ReportFailure {
  error: string;
  details?: string;
}

/** PostResult is the outcome of postReport. */
export type PostResult = { ok: true; receipt: ReportReceipt } | ({ ok: false } & ReportFailure);

/** LogUploadResult is the outcome of requestLogUpload. */
export interface LogUploadResult {
  success: boolean;
  error?: string;
  details?: string;
}

/**
 * buildReportPayload assembles the report body from the text, the optional
 * reply address and Art Computer block, and this ff-cli and runtime.
 *
 * @param input - Report text, ff-cli version (what `ff-cli --version` prints),
 *   reply address, and Art Computer block
 * @returns The body to post
 */
export function buildReportPayload(input: {
  report: string;
  ffCliVersion: string;
  email?: string;
  device?: ReportDevice;
}): ReportPayload {
  return {
    report: input.report,
    ff_cli_version: input.ffCliVersion,
    ...(input.email ? { reporter_email: input.email } : {}),
    os: `${process.platform} ${os.release()}`,
    node_version: process.version,
    ...(input.device && Object.keys(input.device).length > 0 ? { device: input.device } : {}),
  };
}

/**
 * isEmailAddress is a syntax check only: one `@`, no spaces, a dot in the
 * domain. support-logs checks again.
 *
 * @param value - Candidate address
 * @returns Whether it looks like an address
 */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * containsSigningKey reports whether `report` carries the configured playlist
 * signing key, as configured or in another encoding ff-cli accepts for the
 * same key (PKCS#8 DER or the 32-byte seed, as hex or base64). Whitespace and
 * case are ignored, so a wrapped PEM body still matches.
 *
 * A cheap guard against pasting a config or key file into a report, not a
 * secret scanner. Every form compared is at least 32 characters of key
 * material, so a match is never a coincidence.
 *
 * @param report - Report text
 * @param material - Configured key (`playlist.privateKey` or PLAYLIST_PRIVATE_KEY), if any
 * @returns Whether the report contains it
 */
export function containsSigningKey(report: string, material: string | null | undefined): boolean {
  const configured = material?.trim();
  if (!configured) {
    return false;
  }
  const haystack = report.replace(/\s+/g, '').toLowerCase();
  return signingKeyForms(configured).some((form) => haystack.includes(form.toLowerCase()));
}

/** signingKeyForms lists the encodings of one key to look for; an unparseable key is matched as written. */
function signingKeyForms(material: string): string[] {
  const forms = [material.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')];
  try {
    const key = parsePlaylistPrivateKeyToKeyObject(material);
    const der = key.export({ format: 'der', type: 'pkcs8' });
    const seed = Buffer.from(String(key.export({ format: 'jwk' }).d), 'base64url');
    for (const bytes of [der, seed]) {
      forms.push(bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url'));
    }
  } catch {
    // Matched as written only.
  }
  return forms.filter((form) => form.length >= 32);
}

/**
 * readDeviceStatus reads the Art Computer's identity and build from its LAN
 * `GET /api/status` (FF OS hub/status.go: `device_id`, `version` and `branch`
 * among other fields). The route is open on every FF OS, secured or not, so no
 * controller is involved. A failed read is returned in `error`, never thrown:
 * the report then goes with the device ID configured for it, if any.
 *
 * @param device - Configured Art Computer
 * @param fetchFn - Fetch (tests); defaults to a short deadline
 * @returns The Art Computer block, and why the read failed when it did
 */
export async function readDeviceStatus(
  device: FF1Device,
  fetchFn: typeof fetch = (input, init) => fetchWithTimeout(input, init ?? {}, STATUS_TIMEOUT_MS)
): Promise<{ device: ReportDevice; error?: string }> {
  const fallback: ReportDevice = device.id ? { device_id: device.id } : {};
  let body: unknown;
  try {
    const response = await fetchFn(`${device.host}/api/status`, { headers: deviceHeaders(device) });
    if (!response.ok) {
      return { device: fallback, error: `HTTP ${response.status}` };
    }
    body = await response.json();
  } catch (error) {
    return { device: fallback, error: (error as Error).message };
  }
  const status = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const read: ReportDevice = {};
  for (const key of ['device_id', 'version', 'branch'] as const) {
    const value = status[key];
    if (typeof value === 'string' && value.trim()) {
      read[key] = value.trim();
    }
  }
  if (Object.keys(read).length === 0) {
    return { device: fallback, error: 'the answer had no device_id, version or branch' };
  }
  return { device: { ...fallback, ...read } };
}

/**
 * postReport sends the report body to `<baseUrl>/v2/cli/reports`, once.
 *
 * The endpoint is public by design; its bounds are the size cap and the
 * service's per-IP and global rate limits. Errors are the service's
 * `{code, message}` JSON.
 *
 * @param baseUrl - support-logs origin
 * @param body - Serialized ReportPayload
 * @param fetchFn - Fetch (tests); defaults to the shared deadline
 * @returns The receipt, or a failure that says what to do next
 */
export async function postReport(
  baseUrl: string,
  body: string,
  fetchFn: typeof fetch = defaultDeadlineFetch
): Promise<PostResult> {
  let response: Response;
  let text: string;
  try {
    response = await fetchFn(`${baseUrl}/v2/cli/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body,
    });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach Feral File support at ${baseUrl} (${(error as Error).message})`,
      details: `Check this computer's internet connection and run the same command again. If it keeps failing, email the report to ${SUPPORT_EMAIL}.`,
    };
  }
  if (!response.ok) {
    return { ok: false, ...refusal(response.status, text) };
  }
  return parseReceipt(response.status, text);
}

/** parseReceipt reads `support_bundle_id` and `ff1_upload_token` from a 2xx answer. */
function parseReceipt(status: number, text: string): PostResult {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object') {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // Reported below as an answer without a reference.
  }
  const id = parsed.support_bundle_id;
  if (typeof id !== 'string' || !SUPPORT_BUNDLE_ID.test(id)) {
    return {
      ok: false,
      error: `Feral File support answered HTTP ${status} without a report reference`,
      details: `The report may have arrived, but there is no reference to quote. Email it to ${SUPPORT_EMAIL} so it is not lost.`,
    };
  }
  const token = parsed.ff1_upload_token;
  return {
    ok: true,
    receipt: {
      supportBundleId: id,
      ...(typeof token === 'string' && token ? { uploadToken: token } : {}),
    },
  };
}

/** refusal maps a non-2xx answer to copy that says what to do next. */
function refusal(status: number, text: string): ReportFailure {
  const reason = serviceMessage(text);
  const said = reason ? `: ${reason}` : '';
  if (status === 429) {
    return {
      error: `Feral File support is limiting reports right now (HTTP 429)${said}`,
      details: 'Wait a few minutes, then run the same command again.',
    };
  }
  if (status === 400) {
    return {
      error: `Feral File support refused the report (HTTP 400)${said}`,
      details: 'Fix what the answer names, then run the command again.',
    };
  }
  if (status < 500) {
    return {
      error: `Feral File support refused the report (HTTP ${status})${said}`,
      details: `If you set supportLogs.baseUrl or FF_SUPPORT_LOGS_URL, check it. Otherwise email the report to ${SUPPORT_EMAIL}.`,
    };
  }
  return {
    error: `Feral File support could not take the report (HTTP ${status})${said}`,
    details: `Try again later. If it keeps failing, email the report to ${SUPPORT_EMAIL}.`,
  };
}

/** serviceMessage reads support-logs' `{code, message}` error, or a short excerpt of anything else. */
function serviceMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown } | null;
    if (typeof parsed?.message === 'string' && parsed.message) {
      return parsed.message;
    }
    if (typeof parsed?.code === 'string' && parsed.code) {
      return parsed.code;
    }
  } catch {
    // Not JSON: quote it.
  }
  return text.trim().slice(0, 200);
}

/**
 * requestLogUpload asks the Art Computer to upload its logs under the report's
 * bundle, with FF OS's existing `uploadLogs` command and the bundle-scoped
 * token as `apiKey`. FF OS requires `userId` and `title` and does not use them.
 *
 * The transport is the one ff-cli uses for the FF1's other owner-tier
 * commands. With a controller file, a secure envelope (FF OS control/tiers.go
 * puts `uploadLogs` at owner tier, so a controller-role grant gets
 * `permission_denied`), over the LAN and through the relayer only when the LAN
 * is unreachable, like `device controllers` and `device revoke`; the envelope
 * is sealed to the FF1, so the relayer never sees the token. Without one, a
 * plaintext LAN `/api/cast`, which FF OS takes from any LAN peer while the FF1
 * is not secured (in phase 0 only `sshAccess` needs topic proof). No retry:
 * FF OS runs one log upload at a time and ignores a duplicate.
 *
 * FF OS acks at once and uploads in the background (it needs internet), so
 * success means the FF1 took the request, not that the logs arrived.
 *
 * @param device - Configured Art Computer
 * @param receipt - The posted report's bundle id and upload token
 * @param deps - Transport seams (tests)
 * @returns Whether the FF1 took the request; never throws
 */
export async function requestLogUpload(
  device: FF1Device,
  receipt: { supportBundleId: string; uploadToken: string },
  deps: SecureTransportDeps = {}
): Promise<LogUploadResult> {
  const req = {
    userId: 'ff-cli',
    apiKey: receipt.uploadToken,
    title: 'ff-cli report',
    supportBundleID: receipt.supportBundleId,
  };
  const secure = findSecureController(device, deps.controllerStore);
  if (secure.failure) {
    return { success: false, error: secure.failure.error, details: secure.failure.details };
  }
  if (!secure.record) {
    return castUploadLogs(device, req, deps.fetchFn ?? defaultDeadlineFetch);
  }
  // The secure transport can still throw on paths it does not map (a relayer
  // answer whose body read fails). This step runs after the report is in, so a
  // throw here must not reach the command and turn a delivered report into
  // exit 1, which would invite a second report.
  try {
    const result = await runSecureCommand(
      {
        device: device as FF1Device & { id: string },
        record: secure.record,
        cmd: 'uploadLogs',
        req,
        relayerFallback: true,
        retry: false,
      },
      deps
    );
    return { success: result.success, error: result.error, details: result.details };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/** castUploadLogs sends `uploadLogs` as a plaintext LAN cast and reads FF OS's `{ok}` answer. */
async function castUploadLogs(
  device: FF1Device,
  req: Record<string, unknown>,
  fetchFn: typeof fetch
): Promise<LogUploadResult> {
  const label = device.name || device.host;
  let response: Response;
  let text: string;
  try {
    response = await fetchFn(`${device.host}/api/cast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders(device) },
      body: JSON.stringify({ command: 'uploadLogs', request: req }),
    });
    text = await response.text();
  } catch (error) {
    return {
      success: false,
      error: `Could not reach ${label} at ${device.host} (${(error as Error).message})`,
      details: 'Check that it is on and reachable from this computer.',
    };
  }
  if (!response.ok) {
    const code = publicControlCode(response.status, text);
    if (code) {
      const failure = describeControlCode(code, device.name || device.id || device.host);
      return { success: false, error: failure.error, details: failure.details };
    }
    return {
      success: false,
      error: `${label} answered HTTP ${response.status}`,
      details: text.trim().slice(0, 200) || undefined,
    };
  }
  let answer: { ok?: unknown; message?: unknown; error?: unknown } | null = null;
  try {
    answer = JSON.parse(text) as typeof answer;
  } catch {
    // Reported below.
  }
  if (!answer || typeof answer !== 'object') {
    // FF OS answers {"ok":true}. An empty or non-JSON 2xx (seen on the first
    // cast after boot) does not say whether the command ran.
    return {
      success: false,
      error: `${label} answered HTTP ${response.status} without a usable reply`,
      details: 'It may or may not upload its logs.',
    };
  }
  if (answer.ok === false) {
    const why = typeof answer.message === 'string' ? answer.message : String(answer.error ?? '');
    return { success: false, error: `${label} refused the request`, details: why || undefined };
  }
  return { success: true };
}

/** deviceHeaders carries the device's legacy API key when one is configured. */
function deviceHeaders(device: FF1Device): Record<string, string> {
  return device.apiKey ? { 'API-KEY': device.apiKey } : {};
}
