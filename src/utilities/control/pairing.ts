/**
 * Controller pairing for ff-cli: owner-initiated registration
 * (ffos-user docs/ff1-control-v1.md §5.6, §14.8; feral-file#3551).
 *
 * Sequence:
 * 1. chooseControllerKeys: this computer's existing keys for the FF1 when it
 *    has a readable controller file (so a re-pair after revocation, a role
 *    change or a factory reset keeps one controllerId on the device instead
 *    of orphaning a grant), else fresh ones.
 * 2. The caller shows the controller QR (registration.ts) and waits on the
 *    pairing channel for a sealed result that passes every §5.6.3 check.
 * 3. prepareRegisteredController pins the result's profile: on the existing
 *    record when it is the same keys and identity, else on a new record that
 *    replaces an existing one only once enrolled (the staging store).
 * 4. enrollRegistered sends a protected op:enroll without inv (§5.3) and
 *    stores role, nk and expiry from the verified reply.
 *
 * State is always consistent on interruption: nothing is written before a
 * verified result, the record is written atomically before the first
 * request, every counter is persisted before it is sent, and the grant is
 * written only from a verified enroll reply. A record with a verified result
 * that has not enrolled yet is finished by `ff-cli device pair --resume`.
 */

import os from 'node:os';
import type { FF1Device } from '../../types';
import {
  type ControlRole,
  type ControllerKeys,
  type DeviceProfile,
  type EnrollObject,
  stripUnsafeLabelCharacters,
} from './codec';
import { generatePrivateJwk, publicOf, sameKey } from './jwk';
import {
  type ControllerRecord,
  type ControllerStoreOptions,
  type RegistrationRecord,
  ControllerFileCorruptError,
  createController,
  dropStagedController,
  loadController,
  markEnrolled,
  recordRegistration,
  sameIdentity,
  setAsideCorruptController,
  stagingStore,
} from './controller-store';
import {
  type SecureOutcome,
  type SecureTransportDeps,
  sendSecureRequest,
} from './secure-transport';
import { type ControlFailure, describeControlCode, pairCommand } from './control-errors';
import type { RegistrationResult } from './registration';
import { isB64uOfLength, isPlainObject } from './strict-json';

/** DEFAULT_PAIR_TIMEOUT_MS is how long `device pair` waits for an owner by default. */
export const DEFAULT_PAIR_TIMEOUT_MS = 5 * 60_000;
/** MAX_PAIR_TIMEOUT_MS bounds `--timeout`: the relay keeps nothing, so a QR is a short-lived offer. */
export const MAX_PAIR_TIMEOUT_MS = 10 * 60_000;
/** ENROLL_ATTEMPTS bounds the enroll retries after a verified result (network blips). */
export const ENROLL_ATTEMPTS = 5;
/** ENROLL_RETRY_MS is the pause between enroll attempts. */
export const ENROLL_RETRY_MS = 2_000;

type PairDevice = FF1Device & { id: string };

/**
 * defaultControllerLabel is the label the owner sees when adding ff-cli:
 * this machine's hostname, trimmed to the protocol's 64 characters.
 *
 * @returns A 1-64 character label
 */
export function defaultControllerLabel(): string {
  const cleaned = stripUnsafeLabelCharacters(os.hostname()).trim();
  const label = [...cleaned].slice(0, 64).join('').trim();
  return label || 'ff-cli';
}

/**
 * chooseControllerKeys picks the keys the controller QR shows: those of the
 * device's controller file when it is readable (enrolled or not), else fresh
 * ones. A corrupt file yields fresh keys; it is moved aside, never written
 * over, once a result arrives. An unreadable file throws: its keys may be
 * fine, so nothing may pair past it.
 *
 * @param deviceId - FF1 device ID
 * @param options - Main store options
 * @returns The keys and whether they are the existing record's
 */
export function chooseControllerKeys(
  deviceId: string,
  options: ControllerStoreOptions = {}
): { keys: ControllerKeys; reused: boolean } {
  let existing: ControllerRecord | null = null;
  try {
    existing = loadController(deviceId, options);
  } catch (error) {
    if (!(error instanceof ControllerFileCorruptError)) {
      throw error;
    }
  }
  if (existing) {
    return { keys: existing.keys, reused: true };
  }
  return { keys: { sig: generatePrivateJwk(), enc: generatePrivateJwk() }, reused: false };
}

/**
 * registrationRecordOf keeps the facts of a verified approved result.
 *
 * @param result - Verified approved result
 * @param now - Unix seconds
 * @returns The facts stored in the controller file
 */
export function registrationRecordOf(result: RegistrationResult, now: number): RegistrationRecord {
  const registration: RegistrationRecord = {
    channelId: result.channelId,
    deviceName: result.deviceName!,
    role: result.role!,
    receivedAt: now,
  };
  if (result.expiresAt !== undefined) {
    registration.expiresAt = result.expiresAt;
  }
  return registration;
}

/**
 * prepareRegisteredController pins a verified approved result. The existing
 * record keeps its file (and counter) when it is the same keys under the same
 * identity. Otherwise the result goes to a new record: the main file when
 * there is none (a corrupt one is moved aside first, it may hold the only
 * copy of an owner key), else the staging store, which replaces the existing
 * record only once enrolled, so a failed pairing never costs a grant.
 *
 * @param input - Pinned profile, the keys the owner registered, label and result facts
 * @param options - Main store options
 * @returns The record and whether it is staged
 */
export function prepareRegisteredController(
  input: {
    profile: DeviceProfile;
    keys: ControllerKeys;
    label: string;
    registration: RegistrationRecord;
  },
  options: ControllerStoreOptions = {}
): { record: ControllerRecord; staged: boolean } {
  const deviceId = input.profile.dev;
  let existing: ControllerRecord | null = null;
  try {
    existing = loadController(deviceId, options);
  } catch (error) {
    if (!(error instanceof ControllerFileCorruptError)) {
      throw error; // unreadable: its keys may be fine, never write over them
    }
    setAsideCorruptController(deviceId, options);
  }
  if (
    existing &&
    sameKey(existing.keys.sig, input.keys.sig) &&
    sameKey(existing.keys.enc, input.keys.enc) &&
    sameIdentity(existing.profile, input.profile)
  ) {
    // A staged record left by an abandoned replacement pairing is superseded
    // by this result, and --resume must not pick it up later.
    dropStagedController(deviceId, false, options);
    const record = recordRegistration(
      deviceId,
      { label: input.label, registration: input.registration },
      options
    );
    return { record, staged: false };
  }
  const staged = existing !== null;
  const record = createController(
    {
      profile: input.profile,
      label: input.label,
      keys: input.keys,
      registration: input.registration,
    },
    staged ? stagingStore(options) : options
  );
  return { record, staged };
}

/** enrollObject builds the §5 enroll claim for this controller. */
function enrollObject(record: ControllerRecord): EnrollObject {
  return {
    sig: publicOf(record.keys.sig),
    enc: publicOf(record.keys.enc),
    label: record.label,
    platform: 'cli',
  };
}

function asRole(value: unknown): ControlRole | undefined {
  return value === 'owner' || value === 'controller' ? value : undefined;
}

/** EnrollResult is the outcome of enrolling after a verified result. */
export type EnrollResult =
  | { status: 'enrolled'; record: ControllerRecord }
  | { status: 'failed'; failure: ControlFailure }
  | { status: 'cancelled' };

/** EnrollOptions tune the attempts; tests shorten the clock. */
export interface EnrollOptions {
  attempts?: number;
  retryMs?: number;
  /** Returns true when the user interrupted (Ctrl-C). */
  cancelled?: () => boolean;
  storeOptions?: ControllerStoreOptions;
}

/**
 * parseGrant validates an enroll success `res` (§5.3): role, nk, optional
 * expiresAt, and a profile that must be the pinned one (a device whose
 * profile changed under the same keys is a bug or an attack; either way
 * nothing is stored).
 */
function parseGrant(
  res: unknown,
  pinned: DeviceProfile
): { role: ControlRole; nk: string; expiresAt?: number } | string {
  if (!isPlainObject(res)) {
    return 'enroll reply has no grant';
  }
  const role = asRole(res.role);
  if (!role || !isB64uOfLength(res.nk, 32)) {
    return 'enroll reply has an invalid role or nk';
  }
  const expiresAt = res.expiresAt;
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 0)) {
    return 'enroll reply has an invalid expiresAt';
  }
  const profile = res.profile as Partial<DeviceProfile> | undefined;
  if (
    !profile ||
    profile.gen !== pinned.gen ||
    profile.dev !== pinned.dev ||
    !profile.sig ||
    !sameKey(profile.sig, pinned.sig) ||
    !profile.enc ||
    !sameKey(profile.enc, pinned.enc)
  ) {
    return 'enroll reply carries a different FF1 profile than the one the owner sent';
  }
  const grant: { role: ControlRole; nk: string; expiresAt?: number } = {
    role,
    nk: res.nk as string,
  };
  if (expiresAt !== undefined) {
    grant.expiresAt = expiresAt as number;
  }
  return grant;
}

/** failureFrom maps a non-success outcome to a failure. */
function failureFrom(outcome: SecureOutcome, label: string): ControlFailure {
  if (outcome.kind === 'failed') {
    return { code: outcome.code ?? 'failed', error: outcome.error, details: outcome.details };
  }
  const code = outcome.kind === 'public' ? outcome.code : (outcome.reply.code ?? 'unknown');
  return describeControlCode(code, label);
}

/**
 * enrollRegistered sends op:enroll (no inv) until the FF1 returns the grant
 * an owner registered, a definite refusal arrives, the attempts run out, or
 * the user cancels. Each attempt is a new request with a new counter; enroll
 * is idempotent (§5.3), so a lost reply is simply asked again.
 *
 * @param device - Device with ID
 * @param record - Controller record with a pinned profile
 * @param deps - Transport seams; controllerStore is the store the record is in
 * @param options - Attempt tuning
 * @returns The enrolled record or why enrollment stopped
 */
export async function enrollRegistered(
  device: PairDevice,
  record: ControllerRecord,
  deps: SecureTransportDeps = {},
  options: EnrollOptions = {}
): Promise<EnrollResult> {
  const attempts = options.attempts ?? ENROLL_ATTEMPTS;
  const wait = deps.waitFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const label = device.name || device.id;
  let last: EnrollResult | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.cancelled?.()) {
      return { status: 'cancelled' };
    }
    const outcome = await sendSecureRequest(
      { device, op: 'enroll', enroll: enrollObject(record), relayerFallback: true, retry: false },
      record,
      { ...deps, noticeFn: () => undefined }
    );
    const step = interpretEnrollOutcome(outcome, record, label, options.storeOptions);
    if (step.status !== 'transient') {
      return step;
    }
    last = { status: 'failed', failure: step.failure };
    if (attempt < attempts) {
      await wait(options.retryMs ?? ENROLL_RETRY_MS);
    }
  }
  return last!;
}

/** interpretEnrollOutcome returns a final result, or a transient failure worth asking again. */
function interpretEnrollOutcome(
  outcome: SecureOutcome,
  record: ControllerRecord,
  label: string,
  storeOptions?: ControllerStoreOptions
): EnrollResult | { status: 'transient'; failure: ControlFailure } {
  if (outcome.kind === 'reply' && outcome.reply.ok) {
    const grant = parseGrant(outcome.reply.res, record.profile);
    if (typeof grant === 'string') {
      return { status: 'failed', failure: { code: 'invalid_grant', error: grant } };
    }
    return { status: 'enrolled', record: markEnrolled(record.deviceId, grant, storeOptions) };
  }
  // busy (§4.4): the FF1 was authenticating too many envelopes and did not
  // run this one; the next attempt is a new request anyway.
  if (outcome.kind === 'public' && outcome.code === 'busy') {
    return { status: 'transient', failure: failureFrom(outcome, label) };
  }
  if (outcome.kind === 'reply') {
    const code = outcome.reply.code;
    if (code === 'rate_limited' || code === 'internal_error') {
      return { status: 'transient', failure: failureFrom(outcome, label) };
    }
    if (code === 'not_approved' || code === 'pending') {
      return {
        status: 'failed',
        failure: {
          code,
          error:
            'The FF1 has no grant for ff-cli, although an owner’s Feral File app reported adding it.',
          details: `An owner may have removed it again. Run \`${pairCommand(label)}\` to show a new code.`,
        },
      };
    }
  }
  // The FF1 or the relayer may come back (Wi-Fi blip, relayer restart).
  // Protocol answers (codes) are never transient.
  if (
    outcome.kind === 'failed' &&
    (outcome.unreachable ||
      outcome.timedOut || // enroll is idempotent (§5.3): asking again is safe
      (outcome.transport === 'relayer' && !outcome.code))
  ) {
    return { status: 'transient', failure: failureFrom(outcome, label) };
  }
  return { status: 'failed', failure: failureFrom(outcome, label) };
}
