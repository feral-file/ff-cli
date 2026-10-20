/**
 * Controller key store: one JSON file per FF1 at
 * `<config dir>/controllers/<deviceId>.json` (feral-file#3551 M6).
 *
 * The file holds this CLI's private controller keys (ctlSig, ctlEnc), the
 * device profile it pinned during `ff-cli device pair` (the ONLY trust root
 * for replies), the grant (role, nk) once enrolled, and the request counter.
 *
 * Invariants a later change must keep:
 * - Mode 0600 in a 0700 directory on POSIX. Windows has no mode bits; there
 *   the file relies on the per-user profile ACL (documented caveat).
 * - `ctr` only ever increases, and is persisted BEFORE a request carrying it
 *   is sent (nextCounter). A crash after the write and before the send just
 *   skips a number, which the device's window tolerates; sending first and
 *   crashing before the write would reuse a counter, which the device rejects
 *   as `replay`. Allocation is serialized across processes by a lock file.
 * - Every write is tmp + fsync + rename, so a crash never leaves a truncated
 *   file (and a truncated file is the one way to lose `ctr`).
 * - Private JWKs are never logged or put into an error message.
 *
 * The OS keyring was rejected as the store: headless Linux has no secret
 * service, and the counter must be written on every request.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfigPaths } from '../../config';
import {
  type ControlRole,
  type ControllerKeys,
  type DeviceProfile,
  controllerIdOf,
  parseProfile,
} from './codec';
import { generatePrivateJwk, parsePrivateJwk, thumbprint } from './jwk';
import {
  ControlFormatError,
  isB64uOfLength,
  parseStrictJson,
  stringMember,
  strictObject,
  uintMember,
} from './strict-json';

/** ControllerRecord is the parsed controller file. */
export interface ControllerRecord {
  v: 1;
  deviceId: string;
  /** Pinned device profile; gen and pins are derived from it. */
  profile: DeviceProfile;
  keys: ControllerKeys;
  label: string;
  /** Absent until enrollment completes. */
  role?: ControlRole;
  /** Notification key, b64u(32); absent until enrollment completes. */
  nk?: string;
  /** Last counter allocated; the next request uses ctr + 1. */
  ctr: number;
  createdAt: number;
  enrolledAt?: number;
}

/** ControllerStoreOptions override the directory (tests) and clock. */
export interface ControllerStoreOptions {
  dir?: string;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
// A lock older than this is from a process that died mid-allocation; an
// allocation holds the lock for one small file write.
const LOCK_STALE_MS = 30_000;

/**
 * controllersDir returns `<XDG_CONFIG_HOME or ~/.config>/ff-cli/controllers`,
 * next to the user config.json that getConfigPaths resolves.
 *
 * @param options - Optional directory override
 * @returns Absolute directory path
 */
export function controllersDir(options: ControllerStoreOptions = {}): string {
  return options.dir ?? path.join(path.dirname(getConfigPaths().userPath), 'controllers');
}

/**
 * controllerFilePath returns the file for one device. The device ID becomes
 * a file name, so it is restricted to a safe alphabet (FF1-XXXXXXXX fits).
 *
 * @param deviceId - FF1 device ID
 * @param options - Optional directory override
 * @returns Absolute file path
 * @throws {Error} When the device ID is not file-name safe
 */
export function controllerFilePath(deviceId: string, options: ControllerStoreOptions = {}): string {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error(`FF1 device ID "${deviceId}" cannot name a controller file`);
  }
  return path.join(controllersDir(options), `${deviceId}.json`);
}

/**
 * isEnrolled reports whether a record has completed enrollment.
 *
 * @param record - Controller record
 * @returns True when role and nk are present
 */
export function isEnrolled(record: ControllerRecord): boolean {
  return record.role !== undefined && record.nk !== undefined;
}

/**
 * parseControllerRecord validates a controller file strictly. A corrupt file
 * is an error, never "no file": silently treating it as absent would send
 * plaintext to a device the user secured.
 *
 * @param text - File contents
 * @returns The record
 * @throws {ControlFormatError} When malformed
 */
export function parseControllerRecord(text: string): ControllerRecord {
  const obj = strictObject(
    parseStrictJson(text),
    ['v', 'deviceId', 'gen', 'pins', 'profile', 'keys', 'label', 'ctr', 'createdAt'],
    ['role', 'nk', 'enrolledAt'],
    'controller file'
  );
  if (uintMember(obj, 'v') !== 1) {
    throw new ControlFormatError('controller file v must be 1');
  }
  const keysObj = strictObject(obj.keys, ['sig', 'enc'], [], 'controller keys');
  const record: ControllerRecord = {
    v: 1,
    deviceId: stringMember(obj, 'deviceId'),
    profile: parseProfile(obj.profile),
    keys: {
      sig: parsePrivateJwk(keysObj.sig, 'controller sig key'),
      enc: parsePrivateJwk(keysObj.enc, 'controller enc key'),
    },
    label: stringMember(obj, 'label'),
    ctr: uintMember(obj, 'ctr'),
    createdAt: uintMember(obj, 'createdAt'),
  };
  if (record.profile.dev !== record.deviceId) {
    throw new ControlFormatError('controller file profile is for another device');
  }
  // gen and pins are redundant with the profile; a mismatch means the file
  // was hand-edited, and which half to believe cannot be decided.
  const pins = strictObject(obj.pins, ['sig', 'enc'], [], 'controller pins');
  if (
    obj.gen !== record.profile.gen ||
    pins.sig !== thumbprint(record.profile.sig) ||
    pins.enc !== thumbprint(record.profile.enc)
  ) {
    throw new ControlFormatError('controller file pins do not match its profile');
  }
  if ('role' in obj) {
    const role = stringMember(obj, 'role');
    if (role !== 'owner' && role !== 'controller') {
      throw new ControlFormatError('controller file role is invalid');
    }
    record.role = role;
  }
  if ('nk' in obj) {
    if (!isB64uOfLength(obj.nk, 32)) {
      throw new ControlFormatError('controller file nk is invalid');
    }
    record.nk = obj.nk;
  }
  if ('enrolledAt' in obj) {
    record.enrolledAt = uintMember(obj, 'enrolledAt');
  }
  return record;
}

/**
 * serializeControllerRecord renders the file. gen and pins are derived from
 * the profile and written for inspection; load checks they still agree.
 */
function serializeControllerRecord(record: ControllerRecord): string {
  const body: Record<string, unknown> = {
    v: 1,
    deviceId: record.deviceId,
    gen: record.profile.gen,
    pins: { sig: thumbprint(record.profile.sig), enc: thumbprint(record.profile.enc) },
    profile: record.profile,
    keys: record.keys,
    label: record.label,
    ctr: record.ctr,
    createdAt: record.createdAt,
  };
  if (record.role !== undefined) {
    body.role = record.role;
  }
  if (record.nk !== undefined) {
    body.nk = record.nk;
  }
  if (record.enrolledAt !== undefined) {
    body.enrolledAt = record.enrolledAt;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * loadController reads the controller file for a device, or null when none.
 *
 * @param deviceId - FF1 device ID
 * @param options - Optional directory override
 * @returns The record, or null when the file does not exist
 * @throws {Error} When the file exists but is unreadable or corrupt
 */
export function loadController(
  deviceId: string,
  options: ControllerStoreOptions = {}
): ControllerRecord | null {
  const file = controllerFilePath(deviceId, options);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Cannot read controller file ${file}: ${(error as Error).message}`);
  }
  try {
    const record = parseControllerRecord(text);
    if (record.deviceId !== deviceId) {
      throw new ControlFormatError('controller file is for another device');
    }
    return record;
  } catch (error) {
    // The message comes from the validator and never echoes key material.
    throw new Error(
      `Controller file ${file} is corrupt (${(error as Error).message}). Run \`ff-cli device unpair\` and pair again.`
    );
  }
}

/** ensurePrivateDir creates the controllers directory 0700 (tightening an existing one). */
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, DIR_MODE);
  }
}

/**
 * writeAtomic writes a file as tmp + fsync + rename + best-effort dir fsync.
 * The tmp file is created exclusively with mode 0600, so the keys are never
 * readable by others even for an instant (umask can only narrow it).
 */
function writeAtomic(file: string, contents: string): void {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', FILE_MODE);
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(file, FILE_MODE);
    // Directory fsync makes the rename durable; Windows rejects it, and on
    // POSIX a failure here only weakens durability, never consistency.
    try {
      const dfd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      // best effort
    }
  }
}

/**
 * saveController persists a record atomically with private permissions.
 *
 * @param record - Record to save
 * @param options - Optional directory override
 */
export function saveController(
  record: ControllerRecord,
  options: ControllerStoreOptions = {}
): void {
  writeAtomic(controllerFilePath(record.deviceId, options), serializeControllerRecord(record));
}

/**
 * createController generates fresh controller keys for a pinned profile and
 * saves them as a pending (not yet enrolled) record with ctr 0.
 *
 * @param input - Pinned profile and label
 * @param options - Optional directory override
 * @returns The saved record
 */
export function createController(
  input: { profile: DeviceProfile; label: string; now?: number },
  options: ControllerStoreOptions = {}
): ControllerRecord {
  const record: ControllerRecord = {
    v: 1,
    deviceId: input.profile.dev,
    profile: input.profile,
    keys: { sig: generatePrivateJwk(), enc: generatePrivateJwk() },
    label: input.label,
    ctr: 0,
    createdAt: input.now ?? Math.floor(Date.now() / 1000),
  };
  saveController(record, options);
  return record;
}

/**
 * deleteController removes a device's controller file.
 *
 * @param deviceId - FF1 device ID
 * @param options - Optional directory override
 * @returns True when a file was removed
 */
export function deleteController(deviceId: string, options: ControllerStoreOptions = {}): boolean {
  const file = controllerFilePath(deviceId, options);
  if (!fs.existsSync(file)) {
    return false;
  }
  fs.rmSync(file);
  return true;
}

/** sleepSync blocks briefly without spinning the CPU (lock retry only). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * withControllerLock runs fn while holding `<file>.lock`, created with O_EXCL
 * so two ff-cli processes cannot allocate the same counter. A lock older
 * than LOCK_STALE_MS is from a crashed process and is broken.
 */
function withControllerLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  ensurePrivateDir(path.dirname(file));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', FILE_MODE));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (isStaleLock(lock)) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for controller lock ${lock}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function isStaleLock(lock: string): boolean {
  try {
    return Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * nextCounter allocates the next request counter: under the lock it re-reads
 * the file, increments ctr and saves, and only then returns. The caller sends
 * a request with the returned counter at most once (§2.6: a lost reply is
 * never replayed with the same ctr; a retry allocates again).
 *
 * @param deviceId - FF1 device ID
 * @param options - Optional directory override
 * @returns The updated record and the counter to use
 * @throws {Error} When the file is missing or corrupt
 */
export function nextCounter(
  deviceId: string,
  options: ControllerStoreOptions = {}
): { record: ControllerRecord; ctr: number } {
  const file = controllerFilePath(deviceId, options);
  return withControllerLock(file, () => {
    const record = loadController(deviceId, options);
    if (!record) {
      throw new Error(`No controller file for ${deviceId}; run \`ff-cli device pair\``);
    }
    if (!Number.isSafeInteger(record.ctr + 1)) {
      throw new Error('Controller counter exhausted; run `ff-cli device unpair` and pair again');
    }
    record.ctr += 1;
    saveController(record, options);
    return { record, ctr: record.ctr };
  });
}

/**
 * markEnrolled stores the grant from a successful enroll reply. It re-reads
 * under the lock so a counter allocated concurrently is not rolled back.
 *
 * @param deviceId - FF1 device ID
 * @param grant - Role and nk from the reply
 * @param options - Optional directory override
 * @returns The updated record
 */
export function markEnrolled(
  deviceId: string,
  grant: { role: ControlRole; nk: string; now?: number },
  options: ControllerStoreOptions = {}
): ControllerRecord {
  const file = controllerFilePath(deviceId, options);
  return withControllerLock(file, () => {
    const record = loadController(deviceId, options);
    if (!record) {
      throw new Error(`No controller file for ${deviceId}`);
    }
    record.role = grant.role;
    record.nk = grant.nk;
    record.enrolledAt = grant.now ?? Math.floor(Date.now() / 1000);
    saveController(record, options);
    return record;
  });
}

/**
 * describeController returns the non-secret facts of a record for display.
 *
 * @param record - Controller record
 * @returns controllerId, pins and grant facts; never private material
 */
export function describeController(record: ControllerRecord): {
  controllerId: string;
  gen: string;
  sigPin: string;
  encPin: string;
  role?: ControlRole;
} {
  return {
    controllerId: controllerIdOf(record.keys),
    gen: record.profile.gen,
    sigPin: thumbprint(record.profile.sig),
    encPin: thumbprint(record.profile.enc),
    role: record.role,
  };
}
