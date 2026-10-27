/**
 * Controller key store: one JSON file per FF1 at
 * `<config dir>/controllers/<deviceId>.json` (feral-file#3551 M6).
 *
 * The file holds this CLI's private controller keys (ctlSig, ctlEnc), the
 * device profile it pinned from an owner's sealed registration result during
 * `ff-cli device pair` (the ONLY trust root for replies), the verified
 * registration facts, the grant (role, nk, expiry) once enrolled, and the
 * request counter.
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
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getConfigPaths } from '../../config';
import {
  type ControllerRole,
  type ControllerKeys,
  type DeviceProfile,
  controllerIdOf,
  parseProfile,
} from './codec';
import { generatePrivateJwk, parsePrivateJwk, sameKey, thumbprint } from './jwk';
import {
  ControlFormatError,
  isB64uOfLength,
  parseStrictJson,
  stringMember,
  strictObject,
  uintMember,
} from './strict-json';

/**
 * RegistrationRecord keeps the facts of the owner's verified registration
 * result (ff1-control-v1 §5.6.2) that `ff-cli device pair --resume` needs to
 * finish enrolling without the pairing channel. The profile it pinned is the
 * record's profile; the relayer topic, when sent, is in the OS keyring.
 */
export interface RegistrationRecord {
  channelId: string;
  /**
   * Relayer topic the result carried. It came with an unverified result, so
   * it reaches the OS keyring (and the relayer route) only after the enroll
   * reply verified under the profile pinned from the same result.
   */
  topicId?: string;
  /** The FF1's name as the owner's app sent it. */
  deviceName: string;
  /** The role the owner registered; the enroll reply is authoritative. */
  role: ControllerRole;
  expiresAt?: number;
  receivedAt: number;
}

/** ControllerRecord is the parsed controller file. */
export interface ControllerRecord {
  v: 1;
  deviceId: string;
  /** Pinned device profile; gen and pins are derived from it. */
  profile: DeviceProfile;
  keys: ControllerKeys;
  label: string;
  /** Absent until enrollment completes. */
  role?: ControllerRole;
  /** Notification key, b64u(32); absent until enrollment completes. */
  nk?: string;
  /** Grant expiry from the last enroll reply; absent for a grant that never expires. */
  expiresAt?: number;
  /** Present when the profile was pinned from an owner's registration result. */
  registration?: RegistrationRecord;
  /**
   * Whether the FF1's last verified getDeviceStatus listed `relayV2` in
   * `control.transports` (absent field: lan and relayer only). Absent until a
   * verified status is seen. Commands use a derived relay v2 endpoint only
   * when this is true (config.ts resolveV2Endpoint).
   */
  relayV2?: boolean;
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
// A lock is held for one small synchronous file write. A lock whose recorded
// holder PID is dead AND that is at least LOCK_MIN_STALE_MS old is stale; the
// age floor keeps a breaker from racing a holder that has only just written
// its token. A lock without a readable PID (the holder died between create
// and write) is stale after LOCK_UNOWNED_STALE_MS. A lock whose PID is alive
// (or was reused) is never broken automatically: the timeout error names the
// file for the user to remove.
const LOCK_MIN_STALE_MS = 1_000;
const LOCK_UNOWNED_STALE_MS = 30_000;

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
  const normalized = normalizeDeviceId(deviceId);
  if (!DEVICE_ID_PATTERN.test(normalized)) {
    throw new Error(`FF1 device ID "${deviceId}" cannot name a controller file`);
  }
  return path.join(controllersDir(options), `${normalized}.json`);
}

/**
 * normalizeDeviceId is the one spelling of a device ID the store uses: trimmed
 * and upper case, matching the topic store and the device's own hostname
 * (FF1-XXXXXXXX). A hand-edited config.json may carry `ff1-abc`; without this
 * the file written under the profile's upper-case `dev` would not be found.
 *
 * @param deviceId - Configured or profile device ID
 * @returns Normalized ID
 */
export function normalizeDeviceId(deviceId: string): string {
  return deviceId.trim().toUpperCase();
}

/**
 * sameIdentity reports whether two profiles are the same control identity.
 *
 * @param a - First profile
 * @param b - Second profile
 * @returns True when dev, gen and both keys match
 */
export function sameIdentity(a: DeviceProfile, b: DeviceProfile): boolean {
  return a.dev === b.dev && a.gen === b.gen && sameKey(a.sig, b.sig) && sameKey(a.enc, b.enc);
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
    ['role', 'nk', 'enrolledAt', 'expiresAt', 'registration', 'relayV2'],
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
  if ('expiresAt' in obj) {
    record.expiresAt = uintMember(obj, 'expiresAt');
  }
  if ('registration' in obj) {
    record.registration = parseRegistrationRecord(obj.registration);
  }
  if ('relayV2' in obj) {
    if (typeof obj.relayV2 !== 'boolean') {
      throw new ControlFormatError('controller file relayV2 is invalid');
    }
    record.relayV2 = obj.relayV2;
  }
  return record;
}

/** parseRegistrationRecord validates the stored registration facts. */
function parseRegistrationRecord(value: unknown): RegistrationRecord {
  const obj = strictObject(
    value,
    ['channelId', 'deviceName', 'role', 'receivedAt'],
    ['expiresAt', 'topicId'],
    'controller file registration'
  );
  const role = stringMember(obj, 'role');
  if (role !== 'owner' && role !== 'controller') {
    throw new ControlFormatError('controller file registration role is invalid');
  }
  const registration: RegistrationRecord = {
    channelId: stringMember(obj, 'channelId'),
    deviceName: stringMember(obj, 'deviceName'),
    role,
    receivedAt: uintMember(obj, 'receivedAt'),
  };
  if ('expiresAt' in obj) {
    registration.expiresAt = uintMember(obj, 'expiresAt');
  }
  if ('topicId' in obj) {
    const topicId = stringMember(obj, 'topicId');
    if (!topicId) {
      throw new ControlFormatError('controller file registration topicId is empty');
    }
    registration.topicId = topicId;
  }
  return registration;
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
  if (record.expiresAt !== undefined) {
    body.expiresAt = record.expiresAt;
  }
  if (record.registration !== undefined) {
    body.registration = record.registration;
  }
  if (record.relayV2 !== undefined) {
    body.relayV2 = record.relayV2;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * ControllerFileCorruptError is thrown by loadController for a file that was
 * read but does not parse. A file that could not be read at all (EACCES, EIO,
 * a Windows lock) throws a plain Error instead: its keys may be fine, so no
 * caller may treat it as absent and write over it.
 */
export class ControllerFileCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControllerFileCorruptError';
  }
}

/**
 * loadController reads the controller file for a device, or null when none.
 *
 * @param deviceId - FF1 device ID
 * @param options - Optional directory override
 * @returns The record, or null when the file does not exist
 * @throws {ControllerFileCorruptError} When the file exists but is corrupt
 * @throws {Error} When the file exists but cannot be read
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
    throw new Error(
      `Cannot read controller file ${file}: ${(error as Error).message}. Its keys were not changed; fix the file's permissions (or close the program holding it) and try again.`
    );
  }
  try {
    const record = parseControllerRecord(text);
    if (record.deviceId !== normalizeDeviceId(deviceId)) {
      throw new ControlFormatError('controller file is for another device');
    }
    return record;
  } catch (error) {
    // The message comes from the validator and never echoes key material.
    throw new ControllerFileCorruptError(
      `Controller file ${file} is corrupt (${(error as Error).message}). Run \`ff-cli device pair\` again; it moves the file aside before pairing.`
    );
  }
}

/**
 * renameCorruptAside renames a corrupt controller file to
 * `<id>.json.corrupt-<unix seconds>` so a new pairing never writes over it
 * (it may still be the only copy of an owner key). The caller holds the
 * file's lock.
 *
 * @param file - Controller file path
 * @returns The new path
 */
function renameCorruptAside(file: string): string {
  const aside = `${file}.corrupt-${Math.floor(Date.now() / 1000)}`;
  fs.renameSync(file, aside);
  return aside;
}

/**
 * setAsideCorruptController moves the device's controller file aside when it
 * is (still) corrupt; a readable or missing file is left alone.
 *
 * @param deviceId - FF1 device ID
 * @param options - Optional directory override
 * @returns The new path, or null when nothing was moved
 * @throws {Error} When the file cannot be read
 */
export function setAsideCorruptController(
  deviceId: string,
  options: ControllerStoreOptions = {}
): string | null {
  const file = controllerFilePath(deviceId, options);
  return withControllerLock(file, () => {
    try {
      loadController(deviceId, options);
      return null;
    } catch (error) {
      if (!(error instanceof ControllerFileCorruptError)) {
        throw error;
      }
      return renameCorruptAside(file);
    }
  });
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
  // Any failure before the rename (ENOSPC on write, fsync, close, rename)
  // removes the temp file: it holds private keys and must not linger.
  try {
    try {
      fs.writeFileSync(fd, contents, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
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
 * createController saves a pending (not yet enrolled) record with ctr 0 for a
 * pinned profile: with the given keys (the ones the owner registered), else
 * freshly generated ones.
 *
 * @param input - Pinned profile, label, and optionally keys and registration facts
 * @param options - Optional directory override
 * @returns The saved record
 */
export function createController(
  input: {
    profile: DeviceProfile;
    label: string;
    keys?: ControllerKeys;
    registration?: RegistrationRecord;
    now?: number;
    /** Refuse (under the lock) when a controller file already exists. */
    exclusive?: boolean;
  },
  options: ControllerStoreOptions = {}
): ControllerRecord {
  const record: ControllerRecord = {
    v: 1,
    deviceId: input.profile.dev,
    profile: input.profile,
    keys: input.keys ?? { sig: generatePrivateJwk(), enc: generatePrivateJwk() },
    label: input.label,
    ctr: 0,
    createdAt: input.now ?? Math.floor(Date.now() / 1000),
  };
  if (input.registration) {
    record.registration = input.registration;
  }
  const file = controllerFilePath(record.deviceId, options);
  withControllerLock(file, () => {
    // Checked under the lock: a record another process created meanwhile
    // may already have spent counters, and must never be written over.
    if (input.exclusive && fs.existsSync(file)) {
      throw new Error(
        `A controller file for ${record.deviceId} appeared while pairing (${file}); it was kept. Run \`ff-cli device pair\` again.`
      );
    }
    saveController(record, options);
  });
  return record;
}

/**
 * stagingStore is where `ff-cli device pair` keeps a new controller while an
 * existing record for the same FF1 stays in place: the old keys (possibly the
 * last reachable owner grant) are replaced only once the new pairing is
 * enrolled (promoteStagedController), never by a pairing that fails.
 *
 * @param options - Main store options
 * @returns Store options for the staging directory
 */
export function stagingStore(options: ControllerStoreOptions = {}): ControllerStoreOptions {
  return { dir: path.join(controllersDir(options), 'pairing') };
}

/**
 * promoteStagedController moves an enrolled staged record over the device's
 * controller file. Both locks are held (main, then staged; nothing takes them
 * in the other order), so no counter allocated on either file is lost.
 *
 * @param deviceId - FF1 device ID
 * @param options - Main store options
 * @returns The promoted record
 * @throws {Error} When the staged file is missing or corrupt
 */
export function promoteStagedController(
  deviceId: string,
  options: ControllerStoreOptions = {}
): ControllerRecord {
  const staged = stagingStore(options);
  const from = controllerFilePath(deviceId, staged);
  const to = controllerFilePath(deviceId, options);
  return withControllerLock(to, () =>
    withControllerLock(from, () => {
      const record = loadController(deviceId, staged);
      if (!record) {
        throw new Error(`No staged controller file for ${deviceId}`);
      }
      // Rewritten rather than renamed: the staging directory is a different
      // directory, and writeAtomic gives the same durability as every write.
      // An earlier promotion that crashed before the remove already wrote
      // these keys; the main file may have advanced its counter since, so it
      // is kept as is.
      let current: ControllerRecord | null;
      try {
        current = loadController(deviceId, options);
      } catch (error) {
        if (!(error instanceof ControllerFileCorruptError)) {
          throw error; // unreadable: its keys may be fine, keep both files
        }
        // Corrupt: kept aside, and the enrolled staged record replaces it.
        renameCorruptAside(to);
        current = null;
      }
      if (!current || !sameControl(current, record)) {
        saveController(record, options);
        fs.rmSync(from, { force: true });
        return record;
      }
      fs.rmSync(from, { force: true });
      return current;
    })
  );
}

/**
 * dropStagedController removes the device's staged record when it is no
 * longer the pairing to continue: `onlyIfPromoted` drops it only when the
 * main file already holds its keys (a promotion that crashed before the
 * remove), otherwise it is dropped unconditionally (a same-identity pairing
 * superseded it).
 *
 * @param deviceId - FF1 device ID
 * @param onlyIfPromoted - Drop only a staged record whose keys the main file holds
 * @param options - Main store options
 * @returns True when a staged file was removed
 */
export function dropStagedController(
  deviceId: string,
  onlyIfPromoted: boolean,
  options: ControllerStoreOptions = {}
): boolean {
  const staged = stagingStore(options);
  const from = controllerFilePath(deviceId, staged);
  const to = controllerFilePath(deviceId, options);
  return withControllerLock(to, () =>
    withControllerLock(from, () => {
      if (!fs.existsSync(from)) {
        return false;
      }
      if (onlyIfPromoted) {
        let record: ControllerRecord | null;
        let current: ControllerRecord | null;
        try {
          record = loadController(deviceId, staged);
          current = loadController(deviceId, options);
        } catch {
          return false; // corrupt: leave both for the user to see
        }
        if (!record || !current || !sameControl(current, record)) {
          return false;
        }
      }
      fs.rmSync(from, { force: true });
      return true;
    })
  );
}

/**
 * sameControl reports whether two records are the same keys under the same
 * control identity. Keys alone are not enough: a pairing after a factory
 * reset may register this computer's existing keys with the new identity,
 * and that staged record must still replace the old one.
 */
function sameControl(a: ControllerRecord, b: ControllerRecord): boolean {
  return (
    a.keys.sig.d === b.keys.sig.d &&
    a.keys.enc.d === b.keys.enc.d &&
    sameIdentity(a.profile, b.profile)
  );
}

/**
 * pairingKeysPath is where `ff-cli device pair` keeps the keys it shows in
 * the controller QR before any owner answered: `pairing/<id>.keys.json`.
 * The QR's keys must survive an interrupted pairing, because an owner may
 * already have registered them (§5.6 step 5: a later retry with the same
 * keys completes it), and a controller record cannot exist yet without the
 * profile the owner's answer carries.
 *
 * @param deviceId - FF1 device ID
 * @param options - Main store options
 * @returns Absolute file path
 */
function pairingKeysPath(deviceId: string, options: ControllerStoreOptions = {}): string {
  const file = controllerFilePath(deviceId, stagingStore(options));
  return file.replace(/\.json$/, '.keys.json');
}

/** parsePairingKeys validates the pairing keys file strictly. */
function parsePairingKeys(text: string, deviceId: string): ControllerKeys {
  const obj = strictObject(
    parseStrictJson(text),
    ['v', 'deviceId', 'keys', 'createdAt'],
    [],
    'pairing keys file'
  );
  if (uintMember(obj, 'v') !== 1 || obj.deviceId !== deviceId) {
    throw new ControlFormatError('pairing keys file is for another device or version');
  }
  uintMember(obj, 'createdAt');
  const keysObj = strictObject(obj.keys, ['sig', 'enc'], [], 'pairing keys');
  return {
    sig: parsePrivateJwk(keysObj.sig, 'pairing sig key'),
    enc: parsePrivateJwk(keysObj.enc, 'pairing enc key'),
  };
}

/** readPairingKeysText reads the pairing keys file, null when absent. */
function readPairingKeysText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `Cannot read pairing keys file ${file}: ${(error as Error).message}. Fix its permissions and try again.`
    );
  }
}

/**
 * hasPairingKeys reports whether a pairing keys file exists for the device
 * (readable, corrupt or not), without creating one.
 *
 * @param deviceId - FF1 device ID
 * @param options - Main store options
 * @returns True when the file exists
 */
export function hasPairingKeys(deviceId: string, options: ControllerStoreOptions = {}): boolean {
  return fs.existsSync(pairingKeysPath(normalizeDeviceId(deviceId), options));
}

/**
 * loadPairingKeys returns the saved pairing keys without creating any.
 *
 * @param deviceId - FF1 device ID
 * @param options - Main store options
 * @returns The keys, or null when there is no readable, valid file
 * @throws {Error} When the file exists but cannot be read
 */
export function loadPairingKeys(
  deviceId: string,
  options: ControllerStoreOptions = {}
): ControllerKeys | null {
  const id = normalizeDeviceId(deviceId);
  const text = readPairingKeysText(pairingKeysPath(id, options));
  if (text === null) {
    return null;
  }
  try {
    return parsePairingKeys(text, id);
  } catch {
    return null;
  }
}

/**
 * pairingKeys returns the keys an earlier interrupted pairing showed for the
 * device, or creates and saves new ones (0600, atomic) before they are shown.
 * A corrupt file is moved aside, never written over; an unreadable one
 * throws, its keys may be fine.
 *
 * @param deviceId - FF1 device ID
 * @param options - Main store options
 * @returns The keys and whether they were already saved
 */
export function pairingKeys(
  deviceId: string,
  options: ControllerStoreOptions = {}
): { keys: ControllerKeys; reused: boolean } {
  const id = normalizeDeviceId(deviceId);
  const file = pairingKeysPath(id, options);
  return withControllerLock(file, () => {
    const text = readPairingKeysText(file);
    if (text !== null) {
      try {
        return { keys: parsePairingKeys(text, id), reused: true };
      } catch {
        renameCorruptAside(file);
      }
    }
    const keys = { sig: generatePrivateJwk(), enc: generatePrivateJwk() };
    const body = { v: 1, deviceId: id, keys, createdAt: Math.floor(Date.now() / 1000) };
    writeAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
    return { keys, reused: false };
  });
}

/**
 * deletePairingKeys removes the pairing keys file once its keys are in a
 * controller record (or the controller is unpaired).
 *
 * @param deviceId - FF1 device ID
 * @param options - Main store options
 * @returns True when a file was removed
 */
export function deletePairingKeys(deviceId: string, options: ControllerStoreOptions = {}): boolean {
  const file = pairingKeysPath(normalizeDeviceId(deviceId), options);
  return withControllerLock(file, () => {
    if (!fs.existsSync(file)) {
      return false;
    }
    fs.rmSync(file);
    return true;
  });
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
  // Under the lock, so a concurrent nextCounter cannot re-create the file
  // (resurrecting it) after the delete.
  return withControllerLock(file, () => {
    if (!fs.existsSync(file)) {
      return false;
    }
    fs.rmSync(file);
    return true;
  });
}

/**
 * recordRegistration stores a verified registration result on an existing
 * record (same keys, same identity) as a locked re-read + save, so a counter
 * allocated concurrently by another process is never rolled back.
 *
 * @param deviceId - FF1 device ID
 * @param update - The label the owner registered and the result's facts
 * @param options - Optional directory override
 * @returns The updated record
 * @throws {Error} When the file is missing or corrupt
 */
export function recordRegistration(
  deviceId: string,
  update: { label: string; registration: RegistrationRecord },
  options: ControllerStoreOptions = {}
): ControllerRecord {
  const file = controllerFilePath(deviceId, options);
  return withControllerLock(file, () => {
    const record = loadController(deviceId, options);
    if (!record) {
      throw new Error(`No controller file for ${deviceId}`);
    }
    record.label = update.label;
    record.registration = update.registration;
    saveController(record, options);
    return record;
  });
}

/** sleepSync blocks briefly without spinning the CPU (lock retry only). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * withControllerLock runs fn while holding `<file>.lock`, created with O_EXCL
 * so two ff-cli processes cannot allocate the same counter. The lock records
 * the holder's PID and a unique token; see isStaleLock for when it is broken.
 * fn must be synchronous, so a JS-level signal handler can never run while
 * the lock is held.
 */
function withControllerLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  ensurePrivateDir(path.dirname(file));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // The token makes the lock ours: release removes it only if it still holds
  // this token, so a process can never delete another process's live lock.
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', FILE_MODE);
      try {
        fs.writeFileSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const stale = readStaleLock(lock);
      if (stale !== null) {
        breakStaleLock(lock, stale);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for controller lock ${lock}. If no other ff-cli command is running, delete that file and retry.`
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    releaseLock(lock, token);
  }
}

/**
 * breakStaleLock moves a lock judged stale aside with rename, which only one
 * of several concurrent breakers can win (losers get ENOENT and retry the
 * O_EXCL create). The moved file is then re-read: if it is no longer the lock
 * that was judged stale, another process re-created the lock between the
 * check and the rename, and we just moved a LIVE lock. It is linked back; if
 * that fails (a third process created a new lock meanwhile) two holders could
 * exist, so this fails with a lock error instead of proceeding.
 *
 * @param lock - Lock path
 * @param judged - Contents of the lock when it was judged stale
 * @throws {Error} When a live lock was displaced and cannot be restored
 */
function breakStaleLock(lock: string, judged: string): void {
  const aside = `${lock}.${process.pid}.${randomUUID()}.stale`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return; // someone else broke it first
  }
  let moved: string | null;
  try {
    moved = fs.readFileSync(aside, 'utf8');
  } catch {
    moved = null;
  }
  if (moved === judged) {
    fs.rmSync(aside, { force: true });
    return;
  }
  try {
    fs.linkSync(aside, lock);
  } catch {
    fs.rmSync(aside, { force: true });
    throw new Error(
      `Controller lock ${lock} changed while it was being recovered; retry the command.`
    );
  }
  fs.rmSync(aside, { force: true });
}

/** releaseLock removes the lock only while it still holds this process's token. */
function releaseLock(lock: string, token: string): void {
  try {
    if (fs.readFileSync(lock, 'utf8') === token) {
      fs.rmSync(lock, { force: true });
    }
  } catch {
    // already gone
  }
}

/**
 * readStaleLock returns the lock's contents when it is stale, else null.
 * Stale means: the recorded holder PID is dead and the lock is at least
 * LOCK_MIN_STALE_MS old, or there is no readable PID and the lock is older
 * than LOCK_UNOWNED_STALE_MS.
 *
 * @param lock - Lock path
 * @returns Contents judged stale, or null
 */
function readStaleLock(lock: string): string | null {
  try {
    const contents = fs.readFileSync(lock, 'utf8');
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    const pid = Number(contents.split(':')[0]);
    const hasPid = contents !== '' && Number.isSafeInteger(pid) && pid > 0;
    if (hasPid) {
      const dead = pid !== process.pid && !processExists(pid);
      return dead && age >= LOCK_MIN_STALE_MS ? contents : null;
    }
    return age > LOCK_UNOWNED_STALE_MS ? contents : null;
  } catch {
    return null;
  }
}

/** processExists probes a PID with signal 0 (EPERM still means it exists). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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
 * skipCounterAhead moves the counter forward by `by` under the lock (§14.4
 * replay recovery): a verified `replay` means the FF1's window is ahead of
 * this file (a restored backup, a second copy of the keys), and the window
 * has no upper bound, so jumping ahead is always safe.
 *
 * @param deviceId - FF1 device ID
 * @param by - How far to move ctr
 * @param options - Optional directory override
 * @returns The updated record
 * @throws {Error} When the file is missing or corrupt, or ctr would overflow
 */
export function skipCounterAhead(
  deviceId: string,
  by: number,
  options: ControllerStoreOptions = {}
): ControllerRecord {
  const file = controllerFilePath(deviceId, options);
  return withControllerLock(file, () => {
    const record = loadController(deviceId, options);
    if (!record) {
      throw new Error(`No controller file for ${deviceId}; run \`ff-cli device pair\``);
    }
    if (!Number.isSafeInteger(record.ctr + by + 1)) {
      throw new Error('Controller counter exhausted; run `ff-cli device unpair` and pair again');
    }
    record.ctr += by;
    saveController(record, options);
    return record;
  });
}

/**
 * markEnrolled stores the grant from a successful enroll reply. It re-reads
 * under the lock so a counter allocated concurrently is not rolled back. A
 * grant without expiresAt clears any expiry the record had (§5.5: the grant
 * states its whole state).
 *
 * @param deviceId - FF1 device ID
 * @param grant - Role, nk and expiry from the reply
 * @param options - Optional directory override
 * @returns The updated record
 */
export function markEnrolled(
  deviceId: string,
  grant: { role: ControllerRole; nk: string; expiresAt?: number; now?: number },
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
    if (grant.expiresAt !== undefined) {
      record.expiresAt = grant.expiresAt;
    } else {
      delete record.expiresAt;
    }
    saveController(record, options);
    return record;
  });
}

/**
 * recordRelayV2 stores whether the FF1's latest verified status advertises
 * relay v2, under the controller lock so a concurrent counter allocation is
 * not lost. A missing file (unpaired meanwhile) is left alone.
 *
 * @param deviceId - Device ID
 * @param relayV2 - Whether `control.transports` contained "relayV2"
 * @param options - Store options
 */
export function recordRelayV2(
  deviceId: string,
  relayV2: boolean,
  options: ControllerStoreOptions = {}
): void {
  const file = controllerFilePath(deviceId, options);
  withControllerLock(file, () => {
    const record = loadController(deviceId, options);
    if (record && record.relayV2 !== relayV2) {
      record.relayV2 = relayV2;
      saveController(record, options);
    }
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
  role?: ControllerRole;
} {
  return {
    controllerId: controllerIdOf(record.keys),
    gen: record.profile.gen,
    sigPin: thumbprint(record.profile.sig),
    encPin: thumbprint(record.profile.enc),
    role: record.role,
  };
}
