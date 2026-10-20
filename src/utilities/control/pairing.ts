/**
 * Controller pairing for ff-cli (ff1-control-v1 §5.2-5.4, feral-file#3551 M6).
 *
 * Sequence, after the owner app handed over the device profile (v2 handoff):
 * 1. prepareController: reuse this machine's keys for the same control
 *    identity (same gen and pins), else generate new ones. Reuse matters: a
 *    re-pair after revocation or an interrupted pair keeps one controllerId
 *    on the device instead of orphaning grants.
 * 2. requestAccess over LAN (relayer fallback), signed with the new keys.
 * 3. Show approvalCode(ctl, thumb(pinned devSig)); the owner approves in the
 *    app only when the app shows the same code (§5.4 MITM binding).
 * 4. Poll op:enroll (no inv) every 2 s until ok; store role and nk.
 *
 * State is always consistent on interruption: the controller file is written
 * atomically before the first request, every counter is persisted before it
 * is sent, and the grant is written only from a verified enroll reply. A
 * pending file is picked up again by `ff-cli device pair --resume`.
 */

import os from 'node:os';
import type { FF1Device } from '../../types';
import {
  type ControlRole,
  type DeviceProfile,
  type EnrollObject,
  approvalCode,
  controllerIdOf,
  stripUnsafeLabelCharacters,
} from './codec';
import { publicOf, sameKey, thumbprint } from './jwk';
import {
  type ControllerRecord,
  type ControllerStoreOptions,
  createController,
  loadController,
  markEnrolled,
  stagingStore,
  updateLabel,
} from './controller-store';
import {
  type SecureOutcome,
  type SecureTransportDeps,
  sendSecureRequest,
} from './secure-transport';
import { type ControlFailure, describeControlCode } from './control-errors';
import { isB64uOfLength, isPlainObject } from './strict-json';

/** ENROLL_POLL_INTERVAL_MS is the op:enroll polling period. */
export const ENROLL_POLL_INTERVAL_MS = 2_000;
/** DEFAULT_PAIR_TIMEOUT_MS matches the device's 5-minute pending lifetime. */
export const DEFAULT_PAIR_TIMEOUT_MS = 5 * 60_000;

type PairDevice = FF1Device & { id: string };

/**
 * defaultControllerLabel is the label the owner sees in the approval sheet:
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
 * prepareController returns the record to pair with: the existing one when it
 * belongs to the same control identity (its keys, counter and any grant are
 * kept; the label is updated), else a new record with fresh keys. A record
 * for another identity (factory reset: new gen; or a stale handoff) is not
 * touched here: the new keys go to the staging store and replace it only
 * once the new pairing is enrolled, so a failed pairing never costs a grant.
 *
 * @param profile - Profile pinned from the handoff
 * @param label - Controller label
 * @param options - Store options
 * @returns The record, whether its keys are reused, and whether it is staged
 */
export function prepareController(
  profile: DeviceProfile,
  label: string,
  options: ControllerStoreOptions = {}
): { record: ControllerRecord; reused: boolean; staged: boolean } {
  let existing: ControllerRecord | null = null;
  try {
    existing = loadController(profile.dev, options);
  } catch {
    existing = null; // corrupt: replaced below with fresh keys
  }
  if (existing && sameIdentity(existing.profile, profile)) {
    return { record: updateLabel(profile.dev, label, options), reused: true, staged: false };
  }
  const staged = existing !== null;
  const record = createController({ profile, label }, staged ? stagingStore(options) : options);
  return { record, reused: false, staged };
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

/**
 * localApprovalCode is the code ff-cli shows: computed over the pin it holds,
 * never over anything the device sent.
 *
 * @param record - Controller record
 * @returns Six digits
 */
export function localApprovalCode(record: ControllerRecord): string {
  return approvalCode(controllerIdOf(record.keys), thumbprint(record.profile.sig));
}

/** AccessRequestResult is the outcome of op:requestAccess. */
export type AccessRequestResult =
  | { status: 'pending'; code: string; expiresAt?: number }
  | { status: 'approved'; role?: ControlRole }
  | { status: 'failed'; failure: ControlFailure };

/** failureFrom maps a non-success outcome to a failure. */
function failureFrom(outcome: SecureOutcome, label: string): ControlFailure {
  if (outcome.kind === 'failed') {
    return { code: outcome.code ?? 'failed', error: outcome.error, details: outcome.details };
  }
  const code = outcome.kind === 'public' ? outcome.code : (outcome.reply.code ?? 'unknown');
  return describeControlCode(code, label);
}

/**
 * requestAccess sends op:requestAccess (§5.2) over LAN with relayer fallback.
 * A `not_approved` answer here means the FF1 has no owner under secure
 * control yet (state `legacy`), which pairing cannot fix from the CLI.
 *
 * @param device - Device with ID
 * @param record - Pending or enrolled controller record
 * @param deps - Transport seams
 * @returns Pending (with the device's code), approved, or failed
 */
export async function requestAccess(
  device: PairDevice,
  record: ControllerRecord,
  deps: SecureTransportDeps = {}
): Promise<AccessRequestResult> {
  const label = device.name || device.id;
  const outcome = await sendSecureRequest(
    {
      device,
      op: 'requestAccess',
      enroll: enrollObject(record),
      relayerFallback: true,
      retry: false,
    },
    record,
    deps
  );
  if (outcome.kind === 'reply' && outcome.reply.ok && isPlainObject(outcome.reply.res)) {
    const res = outcome.reply.res;
    if (res.status === 'approved') {
      return { status: 'approved', role: asRole(res.role) };
    }
    if (res.status === 'pending' && typeof res.code === 'string') {
      return {
        status: 'pending',
        code: res.code,
        expiresAt: typeof res.expiresAt === 'number' ? res.expiresAt : undefined,
      };
    }
  }
  if (outcome.kind === 'reply' && outcome.reply.code === 'invalid_request') {
    return {
      status: 'failed',
      failure: {
        code: 'invalid_request',
        error: `The FF1 rejected the access request for "${record.label}" as invalid.`,
        details:
          'Its label may contain characters the FF1 does not accept. Run the pairing again with a plain label, e.g. `--label "studio-mac"`.',
      },
    };
  }
  if (outcome.kind === 'reply' && outcome.reply.code === 'not_approved') {
    return {
      status: 'failed',
      failure: {
        code: 'not_approved',
        error: 'This FF1 has no owner under secure control yet, so nobody can approve ff-cli.',
        details:
          'In the Feral File app, open this FF1 and choose "Secure this FF1" first, then run the pairing again. Until then ff-cli keeps using unpaired access.',
      },
    };
  }
  return { status: 'failed', failure: failureFrom(outcome, label) };
}

function asRole(value: unknown): ControlRole | undefined {
  return value === 'owner' || value === 'controller' ? value : undefined;
}

/** EnrollResult is the outcome of the enrollment poll. */
export type EnrollResult =
  | { status: 'enrolled'; record: ControllerRecord }
  | { status: 'failed'; failure: ControlFailure }
  | { status: 'timeout' }
  | { status: 'cancelled' };

/** EnrollPollOptions tune the poll; tests shorten the clock. */
export interface EnrollPollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  nowMsFn?: () => number;
  /** Returns true when the user interrupted (Ctrl-C). */
  cancelled?: () => boolean;
  storeOptions?: ControllerStoreOptions;
}

/**
 * parseGrant validates an enroll success `res` (§5.3): role, nk, and a
 * profile that must be the pinned one (a device whose profile changed under
 * the same keys is a bug or an attack; either way nothing is stored).
 */
function parseGrant(
  res: unknown,
  pinned: DeviceProfile
): { role: ControlRole; nk: string } | string {
  if (!isPlainObject(res)) {
    return 'enroll reply has no grant';
  }
  const role = asRole(res.role);
  if (!role || !isB64uOfLength(res.nk, 32)) {
    return 'enroll reply has an invalid role or nk';
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
    return 'enroll reply carries a different FF1 profile than the one paired';
  }
  return { role, nk: res.nk as string };
}

/**
 * pollEnrollment sends op:enroll (no inv) every interval until the owner
 * approves (ok), the request is denied or expires (`not_approved`), a fatal
 * error occurs, the timeout passes, or the user cancels. Each poll is a new
 * request with a new counter. Network failures and `pending`/`rate_limited`
 * keep polling.
 *
 * @param device - Device with ID
 * @param record - Pending controller record
 * @param deps - Transport seams
 * @param options - Poll tuning
 * @returns The enrolled record or why polling stopped
 */
export async function pollEnrollment(
  device: PairDevice,
  record: ControllerRecord,
  deps: SecureTransportDeps = {},
  options: EnrollPollOptions = {}
): Promise<EnrollResult> {
  const interval = options.intervalMs ?? ENROLL_POLL_INTERVAL_MS;
  const nowMs = options.nowMsFn ?? Date.now;
  const sleep = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = nowMs() + (options.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS);
  const label = device.name || device.id;
  while (nowMs() <= deadline) {
    if (options.cancelled?.()) {
      return { status: 'cancelled' };
    }
    const outcome = await sendSecureRequest(
      { device, op: 'enroll', enroll: enrollObject(record), relayerFallback: true, retry: false },
      record,
      { ...deps, noticeFn: () => undefined }
    );
    const step = interpretEnrollOutcome(outcome, record, label, options.storeOptions);
    if (step) {
      return step;
    }
    if (options.cancelled?.()) {
      return { status: 'cancelled' };
    }
    await sleep(interval);
  }
  return { status: 'timeout' };
}

/** interpretEnrollOutcome returns a final result, or null to keep polling. */
function interpretEnrollOutcome(
  outcome: SecureOutcome,
  record: ControllerRecord,
  label: string,
  storeOptions?: ControllerStoreOptions
): EnrollResult | null {
  if (outcome.kind === 'reply' && outcome.reply.ok) {
    const grant = parseGrant(outcome.reply.res, record.profile);
    if (typeof grant === 'string') {
      return { status: 'failed', failure: { code: 'invalid_grant', error: grant } };
    }
    return { status: 'enrolled', record: markEnrolled(record.deviceId, grant, storeOptions) };
  }
  // busy (§4.4): the FF1 was authenticating too many envelopes and did not
  // run this one; the next poll is a new request anyway.
  if (outcome.kind === 'public' && outcome.code === 'busy') {
    return null;
  }
  if (outcome.kind === 'reply') {
    const code = outcome.reply.code;
    if (code === 'pending' || code === 'rate_limited' || code === 'internal_error') {
      return null;
    }
    if (code === 'not_approved') {
      return {
        status: 'failed',
        failure: {
          code,
          error: 'The access request was denied or expired before it was approved.',
          details: `Run \`ff-cli device pair ${label}\` again and approve it in the Feral File app.`,
        },
      };
    }
  }
  // The FF1 or the relayer may come back (Wi-Fi blip, relayer restart); keep
  // trying until the deadline. Protocol answers (codes) are never transient.
  if (
    outcome.kind === 'failed' &&
    (outcome.unreachable || (outcome.transport === 'relayer' && !outcome.code))
  ) {
    return null;
  }
  return { status: 'failed', failure: failureFrom(outcome, label) };
}
