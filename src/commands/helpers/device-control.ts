/**
 * Command actions for FF1 controller pairing and management
 * (`ff-cli device pair|controllers|revoke|unpair`, feral-file#3551).
 *
 * Copy rules: never print private key material or the relayer topic; print
 * the controllerId (a public thumbprint) freely. The controller QR and its
 * pasteable string carry the one-time pairing secret by design (§5.6): they
 * are shown for the owner to scan and are useless once this run ends.
 */

import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import qrcodeTerminal from 'qrcode-terminal';
import * as logger from '../../logger';
import { resolveConfiguredDevice } from '../../utilities/ff1-compatibility';
import { HandoffReceiver, type TopicHandoffPayload } from '../../utilities/handoff-client';
import { fetchWithTimeout } from '../../utilities/http';
import { storeTopicId } from '../../utilities/topic-store';
import { createPrompt, promptYesNo } from './prompt';
import type { FF1Device } from '../../types';
import { type DeviceProfile, controllerIdOf, labelProblem } from '../../utilities/control/codec';
import { isThumbprint } from '../../utilities/control/jwk';
import {
  type ControllerRecord,
  type ControllerStoreOptions,
  ControllerFileCorruptError,
  controllerFilePath,
  deleteController,
  deletePairingKeys,
  hasPairingKeys,
  loadPairingKeys,
  dropStagedController,
  isEnrolled,
  loadController,
  normalizeDeviceId,
  promoteStagedController,
  sameIdentity,
  stagingStore,
} from '../../utilities/control/controller-store';
import {
  DEFAULT_PAIR_TIMEOUT_MS,
  type EnrollResult,
  MAX_PAIR_TIMEOUT_MS,
  chooseControllerKeys,
  defaultControllerLabel,
  enrollRegistered,
  prepareRegisteredController,
  probeControlSupport,
  registrationRecordOf,
} from '../../utilities/control/pairing';
import {
  type PairingChannel,
  type PairingChannelOpener,
  PairingTransportUnavailableError,
  pairingChannelOpener,
} from '../../utilities/control/pairing-channel';
import {
  type PairingMaterial,
  type RegistrationResult,
  controllerQrCtl,
  controllerQrString,
  RegistrationForOtherDeviceError,
  generatePairingMaterial,
  isValidChannelId,
  openRegistration,
} from '../../utilities/control/registration';
import {
  type SecureCommandResult,
  type SecureTransportDeps,
  findSecureController,
  runSecureCommand,
} from '../../utilities/control/secure-transport';
import { pairCommand } from '../../utilities/control/control-errors';

type PairDevice = FF1Device & { id: string };

/** PairOptions are the `device pair` flags. */
export interface PairOptions {
  label?: string;
  timeout?: string;
  resume?: boolean;
  yes?: boolean;
  topicHandoff?: boolean;
}

/** PairDeps are the seams of `device pair`; production uses the defaults. */
export interface PairDeps extends SecureTransportDeps {
  /** Joins the relay pairing channel (default: the installed relay adapter). */
  openChannel?: PairingChannelOpener;
  /** Shows the controller QR payload (default: a terminal QR code). */
  showQr?: (payload: string) => void;
  /** Stores the relayer topic from the result (default: the OS keyring). */
  storeTopicFn?: (deviceId: string, topicId: string) => void;
  /** Asks a yes/no question (default: the TTY, refusing when not interactive). */
  confirmFn?: (question: string) => Promise<boolean>;
  /** Pause between enroll attempts. */
  enrollRetryMs?: number;
  /** Draws the pairing channel ID (default: crypto.randomUUID). */
  newChannelId?: () => string;
  /** Receives the legacy short-code topic handoff (default: the handoff broker). */
  receiveTopicHandoff?: (device: PairDevice, timeoutMs: number) => Promise<TopicHandoffPayload>;
}

/**
 * UNPAIR_REVOKE_TIMEOUT_MS bounds each request of unpair's best-effort
 * self-revoke, so an unreachable FF1 delays deleting the keys only briefly.
 */
export const UNPAIR_REVOKE_TIMEOUT_MS = 5_000;

/** CommandFailure is thrown by actions and printed by the command wrapper. */
export class CommandFailure extends Error {
  constructor(
    message: string,
    readonly details?: string
  ) {
    super(message);
  }
}

/**
 * requirePairableDevice resolves a configured device that has a stable ID.
 *
 * @param name - Optional device name
 * @returns The device
 * @throws {CommandFailure} When the device is missing or has no ID
 */
export function requirePairableDevice(name?: string): PairDevice {
  const selected = resolveConfiguredDevice(name);
  if (!selected.success || !selected.device) {
    throw new CommandFailure(selected.error || 'FF1 device is not configured correctly');
  }
  const device = selected.device;
  if (!device.id) {
    throw new CommandFailure(
      `Device "${device.name || device.host}" has no stable device ID. Re-add it with ff-cli device add before pairing.`
    );
  }
  return device as PairDevice;
}

function deviceLabel(device: FF1Device): string {
  return device.name || device.id || device.host;
}

/**
 * parseTimeoutMs validates `--timeout <seconds>` (10 s to 10 minutes).
 *
 * @param value - Flag value
 * @returns Milliseconds
 * @throws {CommandFailure} When out of range
 */
export function parseTimeoutMs(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PAIR_TIMEOUT_MS;
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds * 1000 > MAX_PAIR_TIMEOUT_MS) {
    throw new CommandFailure(
      `--timeout must be a whole number of seconds between 10 and ${MAX_PAIR_TIMEOUT_MS / 1000}`,
      'If an owner needs longer, run the pairing again to show a new code.'
    );
  }
  return seconds * 1000;
}

/**
 * parseLabel validates `--label`: 1-64 characters, no control or invisible
 * formatting characters (the FF1 answers such a label with invalid_request).
 *
 * @param value - Flag value
 * @returns The label
 * @throws {CommandFailure} When empty or too long
 */
export function parseLabel(value: string | undefined): string {
  if (value === undefined) {
    return defaultControllerLabel();
  }
  const label = value.trim();
  const problem = labelProblem(label);
  if (problem) {
    throw new CommandFailure(
      `--label ${problem}.`,
      'Use plain visible text, e.g. --label "studio-mac".'
    );
  }
  return label;
}

/**
 * runPair is `ff-cli device pair [name]`: show the controller QR, wait for an
 * owner to add ff-cli in the Feral File app, then enroll (§5.6), or finish an
 * interrupted pairing with --resume.
 *
 * @param name - Optional device name
 * @param options - Flags
 * @param deps - Seams (tests)
 */
export async function runPair(
  name: string | undefined,
  options: PairOptions,
  deps: PairDeps = {}
): Promise<void> {
  const device = requirePairableDevice(name);
  const timeoutMs = parseTimeoutMs(options.timeout);
  const label = parseLabel(options.label);
  await pairDevice(
    device,
    {
      label,
      timeoutMs,
      resume: options.resume,
      yes: options.yes,
      topicHandoff: options.topicHandoff,
    },
    deps
  );
}

/**
 * pairDevice is runPair after flag parsing. It picks the pairing path from
 * the FF1's LAN status: an FF1 without the control protocol (no `control`
 * block), or with it but no owner yet (`legacy`), accepts plaintext and gets
 * the legacy short-code topic handoff; a secured one gets owner-initiated
 * registration. An unreadable status falls back to registration, and
 * --topic-handoff forces the legacy path.
 *
 * @param device - Device with ID
 * @param options - Parsed label and wait, and the resume, yes and topicHandoff flags
 * @param deps - Seams (tests)
 */
export async function pairDevice(
  device: PairDevice,
  options: {
    label: string;
    timeoutMs: number;
    resume?: boolean;
    yes?: boolean;
    topicHandoff?: boolean;
  },
  deps: PairDeps = {}
): Promise<void> {
  if (options.resume) {
    await resumePairing(device, deps);
    return;
  }
  if (options.topicHandoff) {
    await pairByTopicHandoff(device, options.timeoutMs, deps);
    return;
  }
  // The status is unauthenticated, so it may never downgrade a device this
  // computer holds (or may hold) a grant for: any controller record or saved
  // pairing keys means the QR flow, whatever the LAN answers.
  if (holdsControlState(device.id, deps.controllerStore ?? {})) {
    await pairByRegistration(device, options, deps);
    return;
  }
  const support = await probeControlSupport(device, deps.fetchFn);
  if (support !== 'unknown') {
    console.log(
      chalk.dim(
        `\nChose ${support === 'plaintext' ? 'the one-time code (no secure control)' : 'secure pairing'} from the FF1’s LAN status, which is not authenticated. ` +
          `\`${pairCommand(deviceLabel(device))} --topic-handoff\` forces the one-time code.`
      )
    );
  }
  if (support === 'plaintext') {
    await pairByTopicHandoff(device, options.timeoutMs, deps);
    return;
  }
  if (support === 'unknown') {
    console.log(
      chalk.yellow(
        `\nCould not read the status of ${deviceLabel(device)} over the LAN, so ff-cli shows the secure pairing code. ` +
          `If this FF1 runs FF OS without secure control, run \`${pairCommand(deviceLabel(device))} --topic-handoff\` instead.`
      )
    );
  }
  await pairByRegistration(device, options, deps);
}

/**
 * holdsControlState reports whether this computer has a controller record
 * (main or staged, even corrupt) or saved pairing keys for the device. An
 * unreadable file throws: its keys may be fine.
 */
function holdsControlState(deviceId: string, store: ControllerStoreOptions): boolean {
  return (
    loadUnlessCorrupt(deviceId, store) !== null ||
    loadUnlessCorrupt(deviceId, stagingStore(store)) !== null ||
    hasPairingKeys(deviceId, store)
  );
}

/**
 * pairByRegistration is owner-initiated registration (§5.6): show the
 * controller QR, wait for an owner's sealed result, enroll.
 */
async function pairByRegistration(
  device: PairDevice,
  options: { label: string; timeoutMs: number; yes?: boolean },
  deps: PairDeps
): Promise<void> {
  const store = deps.controllerStore ?? {};
  // A staged replacement that already enrolled is this computer's confirmed
  // grant; a new pairing would overwrite or drop it. --resume promotes it.
  dropStagedController(device.id, true, store);
  // An unreadable controller file fails here, before the QR is shown.
  const existing = loadUnlessCorrupt(device.id, store);
  if (enrolledStagedPairing(device.id, store)) {
    throw new CommandFailure(
      `An earlier pairing with ${deviceLabel(device)} was approved but not finished.`,
      `Run \`${pairCommand(deviceLabel(device))} --resume\` to finish it.`
    );
  }
  const confirmFn = deps.confirmFn ?? confirmInteractively;
  if (existing === 'corrupt') {
    await confirmCorruptReplacement(device, options, confirmFn);
  }
  // The keys are chosen (and new pairing keys saved) only once the channel
  // is open, so a run that cannot reach the relay leaves no key file behind.
  let chosen: ReturnType<typeof chooseControllerKeys> | undefined;
  const prepare = (channelId: string) => {
    chosen = chooseControllerKeys(device.id, store);
    return {
      material: generatePairingMaterial(chosen.keys, options.label, channelId),
      keysNote: chosen.fromRecord
        ? 'this computer’s existing keys'
        : chosen.reused
          ? 'the same keys as the last attempt'
          : '',
    };
  };
  const nowFn = deps.nowFn ?? (() => Math.floor(Date.now() / 1000));
  const outcome = await withInterrupt((signal) =>
    waitForOwner(device, prepare, options.timeoutMs, signal, deps)
  );
  if (outcome.status === 'interrupted') {
    console.log(
      chalk.yellow(
        `\nPairing interrupted. Run \`${pairCommand(deviceLabel(device))}\` to show a new code; it keeps the same controller keys.`
      )
    );
    process.exitCode = 130;
    return;
  }
  if (outcome.status !== 'result') {
    throw new CommandFailure(
      `Pairing was not completed: no owner answered within ${Math.round(options.timeoutMs / 1000)}s.`,
      `Run \`${pairCommand(deviceLabel(device))}\` to show a new code. It keeps the same controller keys, so an owner who already added ff-cli only needs to scan the new code.`
    );
  }
  const result = outcome.result;
  if (result.outcome === 'rejected') {
    throw new CommandFailure(
      `An owner declined to add ff-cli to ${deviceLabel(device)}.`,
      `To try again, run \`${pairCommand(deviceLabel(device))}\`.`
    );
  }
  const profile = result.profile!;
  const { keys, fromRecord } = chosen!;
  noteReplacement(device, profile, store);
  // A topicId stays in the record until the enroll reply verifies under this
  // result's profile (finishEnrollment): it arrived with the same unverified
  // result, so until then it neither replaces the keyring topic nor routes
  // the enroll (whose relayer fallback only sees a topic stored earlier).
  const { record, staged } = prepareRegisteredController(
    { profile, keys, label: options.label, registration: registrationRecordOf(result, nowFn()) },
    store
  );
  if (!fromRecord) {
    deletePairingKeys(device.id, store); // the keys now live in the record
  }
  console.log(
    chalk.green(
      `\n✓ An owner added ff-cli to ${result.deviceName} as ${chalk.bold(result.role)}. Finishing the pairing...`
    )
  );
  console.log(
    chalk.dim(
      `Controller keys: ${controllerFilePath(device.id, staged ? stagingStore(store) : store)}`
    )
  );
  await finishEnrollment(device, record, staged, deps);
}

/**
 * pairByTopicHandoff is the legacy short-code handoff for an FF1 without
 * secure control: the owner's app sends the relayer topic end to end
 * encrypted, and ff-cli stores it in the OS keyring. No controller keys are
 * created; such an FF1 accepts plaintext commands.
 */
async function pairByTopicHandoff(
  device: PairDevice,
  timeoutMs: number,
  deps: PairDeps
): Promise<void> {
  const payload = await (deps.receiveTopicHandoff ?? receiveTopicHandoff)(device, timeoutMs);
  (deps.storeTopicFn ?? storeTopicId)(device.id, payload.topicId);
  console.log(chalk.green('\n✓ Relayer access stored in the operating system secure storage.\n'));
}

/** receiveTopicHandoff runs the broker handoff and always closes the channel. */
async function receiveTopicHandoff(
  device: PairDevice,
  timeoutMs: number
): Promise<TopicHandoffPayload> {
  let receiver: HandoffReceiver | undefined;
  try {
    receiver = await HandoffReceiver.create();
    console.log(chalk.blue('\nPair ff-cli with Feral File mobile\n'));
    console.log(`  Device: ${chalk.bold(device.name || device.id)}`);
    console.log(`  Device ID: ${chalk.dim(device.id)}`);
    console.log("\nIn the mobile app, open this Art Computer's options and choose");
    console.log(chalk.bold('“Pair with ff-cli”'), 'then enter:');
    console.log(`\n  ${chalk.bold(receiver.shortCode)}\n`);
    console.log('Before sharing, confirm the mobile security check matches:');
    console.log(`\n  ${chalk.bold(receiver.verificationCode)}\n`);
    console.log(chalk.dim(`This one-time code expires at ${receiver.expiresAt}. Waiting...`));
    return await receiver.receiveHandoff({ expectedDeviceId: device.id, maxWaitMs: timeoutMs });
  } finally {
    if (receiver) {
      try {
        await receiver.close();
      } catch {
        // The channel is short-lived and expires automatically. A close
        // failure must not erase or misreport an already received handoff.
      }
    }
  }
}

/**
 * resumePairing is `device pair --resume`: enroll the record that holds an
 * owner's verified result (no pairing channel is needed), then promote it
 * when it replaces an existing record.
 */
async function resumePairing(device: PairDevice, deps: PairDeps): Promise<void> {
  const store = deps.controllerStore ?? {};
  // A staged pairing (one that will replace an existing record) wins: it is
  // the one the last run was finishing. One whose keys the main file already
  // holds was promoted by a run that stopped before removing it; its counter
  // is stale, so the main file is used.
  dropStagedController(device.id, true, store);
  const staged = loadController(device.id, stagingStore(store));
  const record = staged ?? loadController(device.id, store);
  if (!record) {
    throw new CommandFailure(
      `There is no pairing to resume for ${deviceLabel(device)}.`,
      `Run \`${pairCommand(deviceLabel(device))}\` to start one.`
    );
  }
  await finishEnrollment(device, record, staged !== null, deps);
}

/**
 * waitForOwner joins the pairing channel, shows the controller QR and waits
 * for a sealed result that passes every §5.6.3 check. Messages that do not
 * open or fail a check are ignored: anyone who saw the QR can write to the
 * channel, and only a verified result ends the wait. The channel is always
 * closed.
 */
async function waitForOwner(
  device: PairDevice,
  prepare: (channelId: string) => { material: PairingMaterial; keysNote: string },
  timeoutMs: number,
  interrupt: AbortSignal,
  deps: PairDeps
): Promise<
  { status: 'result'; result: RegistrationResult } | { status: 'timeout' | 'interrupted' }
> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = AbortSignal.any([interrupt, timeout.signal]);
  const stopped = () =>
    interrupt.aborted ? ({ status: 'interrupted' } as const) : ({ status: 'timeout' } as const);
  let channel: PairingChannel | undefined;
  const channelId = (deps.newChannelId ?? randomUUID)();
  // §5.6.1: the relay accepts 1-128 characters, the QR only 16-64 of
  // [A-Za-z0-9_-]; a UUID fits, a future generator must too.
  if (!isValidChannelId(channelId)) {
    throw new CommandFailure(
      'ff-cli generated an invalid pairing channel ID; this is an ff-cli bug.',
      'Please report it with `ff-cli --version`.'
    );
  }
  try {
    try {
      channel = await (deps.openChannel ?? pairingChannelOpener())(channelId, signal);
    } catch (error) {
      if (signal.aborted) {
        return stopped();
      }
      throw new CommandFailure(
        error instanceof PairingTransportUnavailableError
          ? `Pairing is not available in this build of ff-cli: ${error.message}.`
          : `Could not open the pairing channel: ${(error as Error).message}`,
        'Pairing needs an internet connection to the Feral File relay. Check the connection and try again.'
      );
    }
    const { material, keysNote } = prepare(channelId);
    showPairingCode(device, material, timeoutMs, keysNote, deps.showQr);
    const wantDev = normalizeDeviceId(device.id);
    const now = deps.nowFn ?? (() => Math.floor(Date.now() / 1000));
    const messages = channel.messages()[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<Uint8Array> | null;
      try {
        next = await nextOrAbort(messages, signal);
      } catch (error) {
        if (signal.aborted) {
          return stopped();
        }
        throw new CommandFailure(
          `The pairing channel failed: ${(error as Error).message}`,
          `Run \`${pairCommand(deviceLabel(device))}\` to show a new code.`
        );
      }
      if (next === null) {
        return stopped();
      }
      if (next.done) {
        throw new CommandFailure(
          'The pairing channel closed before an owner answered.',
          `Run \`${pairCommand(deviceLabel(device))}\` to show a new code.`
        );
      }
      try {
        return { status: 'result', result: openRegistration(material, next.value, wantDev, now()) };
      } catch (error) {
        if (error instanceof RegistrationForOtherDeviceError) {
          // Only a holder of this QR's secret gets this far, normally the
          // owner, so say so instead of waiting silently.
          console.log(
            chalk.yellow(
              `An owner added ff-cli to a different FF1 (${JSON.stringify(error.dev)}), not ${deviceLabel(device)} (${wantDev}). Still waiting for an answer for ${deviceLabel(device)}...`
            )
          );
        }
        logger.debug(`Ignored a pairing channel message: ${(error as Error).message}`);
      }
    }
  } finally {
    clearTimeout(timer);
    if (channel) {
      try {
        await channel.close();
      } catch {
        // The relay keeps nothing; a close failure must not hide a result.
      }
    }
  }
}

/** nextOrAbort awaits the next channel message, or null once signal aborts. */
function nextOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal
): Promise<IteratorResult<T> | null> {
  if (signal.aborted) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** renderQr renders a QR payload for a terminal (half-height blocks, level M). */
function renderQr(payload: string): string {
  let rendered = '';
  qrcodeTerminal.setErrorLevel('M');
  qrcodeTerminal.generate(payload, { small: true }, (qr) => {
    rendered = qr;
  });
  return rendered;
}

/** showPairingCode prints what the owner scans or pastes, and what happens next. */
function showPairingCode(
  device: PairDevice,
  material: PairingMaterial,
  timeoutMs: number,
  keysNote: string,
  showQr: (payload: string) => void = (payload) => console.log(renderQr(payload))
): void {
  const payload = controllerQrString(material.qr);
  console.log(chalk.blue(`\nAdd ff-cli to ${deviceLabel(device)}\n`));
  console.log(
    'On an owner’s phone, open this FF1 in the Feral File app, choose “Add controller”, and scan this code:\n'
  );
  showQr(payload);
  console.log('\nOr paste this text into the app:\n');
  console.log(`  ${payload}\n`);
  console.log(chalk.dim(`Name the owner sees: ${material.qr.label}`));
  console.log(
    chalk.dim(`Controller ID: ${controllerQrCtl(material.qr)}${keysNote ? ` (${keysNote})` : ''}`)
  );
  console.log(
    chalk.dim(
      `Waiting up to ${Math.round(timeoutMs / 1000)}s for an owner. This needs an internet connection. Press Ctrl-C to stop.`
    )
  );
}

/**
 * finishEnrollment enrolls a record that holds a pinned profile, promotes a
 * staged one, and reports the result.
 */
async function finishEnrollment(
  device: PairDevice,
  record: ControllerRecord,
  staged: boolean,
  deps: PairDeps
): Promise<void> {
  const mainStore = deps.controllerStore ?? {};
  const pairDeps = staged ? { ...deps, controllerStore: stagingStore(mainStore) } : deps;
  const result = await withInterrupt(async (signal): Promise<EnrollResult> => {
    const enrolled = await enrollRegistered(device, record, pairDeps, {
      cancelled: () => signal.aborted,
      storeOptions: pairDeps.controllerStore,
      retryMs: deps.enrollRetryMs,
    });
    if (enrolled.status === 'enrolled' && staged) {
      return { status: 'enrolled', record: promoteStagedController(device.id, mainStore) };
    }
    return enrolled;
  });
  if (result.status === 'enrolled') {
    // Only now, with an enroll reply verified under the pinned profile, may
    // the topic from the owner's result replace the keyring topic.
    const topicId = result.record.registration?.topicId ?? record.registration?.topicId;
    if (topicId) {
      storeRelayerTopic(device.id, topicId, deps.storeTopicFn);
    }
  }
  reportEnrollment(device, result);
}

/**
 * loadUnlessCorrupt loads a controller file, mapping a corrupt one to the
 * string 'corrupt'. An unreadable file still throws: its keys may be fine,
 * so nothing may treat it as absent and write over it.
 */
function loadUnlessCorrupt(
  deviceId: string,
  options: ControllerStoreOptions = {}
): ControllerRecord | null | 'corrupt' {
  try {
    return loadController(deviceId, options);
  } catch (error) {
    if (error instanceof ControllerFileCorruptError) {
      return 'corrupt';
    }
    throw error;
  }
}

/** enrolledStagedPairing reports whether the staging store holds an enrolled record. */
function enrolledStagedPairing(deviceId: string, options: ControllerStoreOptions = {}): boolean {
  const staged = loadUnlessCorrupt(deviceId, stagingStore(options));
  return staged !== null && staged !== 'corrupt' && isEnrolled(staged);
}

/**
 * confirmCorruptReplacement asks before a pairing replaces a corrupt
 * controller file (it is moved aside, not deleted, once an owner's result
 * arrives). Asked before the QR is shown, so a refusal costs the owner
 * nothing. Ask on a TTY, or --yes.
 *
 * @param device - Device with ID
 * @param options - `yes` skips the confirmation
 * @param confirmFn - Confirmation prompt
 * @throws {CommandFailure} When declined
 */
export async function confirmCorruptReplacement(
  device: PairDevice,
  options: { yes?: boolean },
  confirmFn: (question: string) => Promise<boolean> = confirmInteractively
): Promise<void> {
  if (options.yes) {
    return;
  }
  console.log(
    chalk.yellow(
      `\nThe controller file for ${deviceLabel(device)} is corrupt. It is moved aside (not deleted) and replaced by the new pairing; ` +
        'if it held this computer’s only owner keys for this FF1, the FF1 may need another owner or a factory reset.'
    )
  );
  if (!(await confirmFn('Move it aside and pair again?'))) {
    throw new CommandFailure(
      'Pairing cancelled; the controller file was left as it is.',
      'Pass --yes to skip this check.'
    );
  }
}

/**
 * noteReplacement says when a pairing for another control identity will
 * replace an ENROLLED record (expected after a factory reset). It does not
 * ask: an owner has already added ff-cli, and the new pairing replaces the
 * old one only once its enroll reply verifies (the staging store), so a
 * failed enroll leaves the current pairing as it is.
 *
 * @param device - Device with ID
 * @param profile - Profile from the owner's verified result
 * @param storeOptions - Store options (tests)
 * @returns True when the notice was printed
 */
export function noteReplacement(
  device: PairDevice,
  profile: DeviceProfile,
  storeOptions: ControllerStoreOptions = {}
): boolean {
  const existing = loadUnlessCorrupt(device.id, storeOptions);
  if (
    existing === 'corrupt' ||
    !existing ||
    !isEnrolled(existing) ||
    sameIdentity(existing.profile, profile)
  ) {
    return false;
  }
  console.log(
    chalk.yellow(
      `\nff-cli is already paired with ${deviceLabel(device)} as ${existing.role}, under a different FF1 identity than the owner’s app just sent. ` +
        'That is expected after a factory reset. ' +
        'Once the new pairing is enrolled, the current pairing is replaced' +
        (existing.role === 'owner'
          ? '; if no other owner can reach this FF1, it is then left without a reachable owner until a factory reset.'
          : '.')
    )
  );
  return true;
}

/**
 * storeRelayerTopic stores the relayer topic an owner's registration result
 * carried (§5.6.2 topicId). It only enables the legacy relayer route; the
 * controller pairing works without it, so an unavailable keyring (headless
 * Linux has no secret service) is a warning, not a failed pairing. The topic
 * is never printed.
 *
 * @param deviceId - FF1 device ID
 * @param topicId - Relayer topic from the result
 * @param storeFn - Keyring writer (tests inject a failing one)
 * @param warnFn - Warning sink
 * @returns True when the topic was stored
 */
export function storeRelayerTopic(
  deviceId: string,
  topicId: string,
  storeFn: (deviceId: string, topicId: string) => void = storeTopicId,
  warnFn: (message: string) => void = (m) => console.warn(chalk.yellow(m))
): boolean {
  try {
    storeFn(deviceId, topicId);
    return true;
  } catch (error) {
    warnFn(
      `Warning: the operating system secure storage is unavailable (${(error as Error).message}). ` +
        'Pairing continues, but the relayer fallback for this FF1 will not be available until it is.'
    );
    return false;
  }
}

/**
 * formatCode renders a 6-digit approval code as "123 456" for reading aloud.
 *
 * @param code - Six digits
 * @returns Spaced code
 */
export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** reportEnrollment prints the final pairing state or throws a failure. */
function reportEnrollment(device: PairDevice, result: EnrollResult): void {
  const resume = `${pairCommand(deviceLabel(device))} --resume`;
  switch (result.status) {
    case 'enrolled': {
      const role = result.record.role!;
      console.log(
        chalk.green(`\n✓ ff-cli is paired with ${deviceLabel(device)} as ${chalk.bold(role)}.`)
      );
      if (result.record.expiresAt !== undefined) {
        console.log(
          chalk.dim(
            `This access expires at ${new Date(result.record.expiresAt * 1000).toISOString()}.`
          )
        );
      }
      console.log(
        chalk.dim(
          role === 'owner'
            ? 'Owner access covers every command, including ssh and controller management.\n'
            : 'Controller access covers playback and device status. SSH and controller management need an owner grant.\n'
        )
      );
      return;
    }
    case 'cancelled':
      console.log(
        chalk.yellow(
          `\nPairing interrupted. An owner already added ff-cli; run \`${resume}\` to finish.`
        )
      );
      process.exitCode = 130;
      return;
    default: {
      // The record with the owner's verified result is kept, so --resume
      // finishes it without a new code.
      const details = result.failure.details ?? '';
      throw new CommandFailure(
        result.failure.error,
        details.includes(pairCommand(deviceLabel(device)))
          ? details
          : `${details ? `${details} ` : ''}To finish the pairing, run \`${resume}\`.`
      );
    }
  }
}

/**
 * withInterrupt runs fn with an abort signal wired to the first Ctrl-C. A
 * second Ctrl-C exits immediately; that is safe because counter allocation
 * and grant storage are synchronous, so no signal handler can run in the
 * middle of a file update.
 */
async function withInterrupt<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) {
      process.exit(130);
    }
    controller.abort();
    console.log(chalk.yellow('\nStopping... (Ctrl-C again to quit now)'));
  };
  process.on('SIGINT', onSigint);
  try {
    return await fn(controller.signal);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/**
 * requireEnrolledController loads the device's enrolled controller record.
 *
 * @param device - Device with ID
 * @returns The record
 * @throws {CommandFailure} When ff-cli is not paired with the device
 */
function requireEnrolledController(device: PairDevice): ControllerRecord {
  const secure = findSecureController(device);
  if (secure.failure) {
    throw new CommandFailure(secure.failure.error, secure.failure.details);
  }
  if (!secure.record || !isEnrolled(secure.record)) {
    throw new CommandFailure(
      `ff-cli is not paired as a controller of ${deviceLabel(device)}.`,
      `Run \`${pairCommand(deviceLabel(device))}\` first.`
    );
  }
  return secure.record;
}

/** runOwnerCommand sends an owner-tier control command (LAN, relayer fallback, no retry). */
async function runOwnerCommand(
  device: PairDevice,
  record: ControllerRecord,
  cmd: string,
  req: Record<string, unknown>,
  deps: SecureTransportDeps = {}
): Promise<SecureCommandResult> {
  return runSecureCommand({ device, record, cmd, req, relayerFallback: true, retry: false }, deps);
}

/** OWNER_COMMAND_REASONS map §5.5 `res.error` reasons to copy. */
const OWNER_COMMAND_REASONS: Record<string, string> = {
  not_found: 'No active controller or pending request has that ID.',
  last_owner: 'That is the last owner of this FF1 and cannot be revoked.',
  not_pending: 'There is no pending request for that controller.',
  too_many_controllers: 'This FF1 already has the maximum number of controllers.',
  invalid_request: 'The FF1 rejected the request as malformed.',
};

/** ownerFailure turns a failed owner command into a CommandFailure. */
function ownerFailure(result: SecureCommandResult): CommandFailure {
  if (result.code === 'command_failed' && result.details) {
    try {
      const reason = (JSON.parse(result.details) as { error?: string }).error;
      if (reason && OWNER_COMMAND_REASONS[reason]) {
        return new CommandFailure(OWNER_COMMAND_REASONS[reason]);
      }
    } catch {
      // fall through to the generic message
    }
  }
  return new CommandFailure(result.error || 'The FF1 refused the request', result.details);
}

/** ControllerRow / PendingRow are the listControllers `res` entries (§5.5). */
interface ControllerRow {
  ctl: string;
  role: string;
  label: string;
  platform: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  self: boolean;
}

interface PendingRow {
  ctl: string;
  label: string;
  platform: string;
  code: string;
  expiresAt: number;
}

function formatTime(unix: number | undefined): string {
  return unix ? new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) : '-';
}

function rowStatus(row: ControllerRow, nowSeconds: number): string {
  if (row.revokedAt) {
    return `revoked ${formatTime(row.revokedAt)}`;
  }
  if (row.expiresAt && row.expiresAt <= nowSeconds) {
    return `expired ${formatTime(row.expiresAt)}`;
  }
  return row.expiresAt ? `active until ${formatTime(row.expiresAt)}` : 'active';
}

/**
 * formatControllerTable renders a listControllers result as text lines.
 *
 * @param res - listControllers `res`
 * @param nowSeconds - Current time for expiry display
 * @returns Lines to print
 */
export function formatControllerTable(
  res: { controllers?: ControllerRow[]; pending?: PendingRow[] },
  nowSeconds: number
): string[] {
  const lines: string[] = [];
  const rows = (res.controllers ?? []).map((row) => [
    row.self ? '*' : ' ',
    row.role,
    row.label,
    row.platform,
    formatTime(row.createdAt),
    rowStatus(row, nowSeconds),
    row.ctl,
  ]);
  lines.push(
    ...table(['', 'ROLE', 'LABEL', 'PLATFORM', 'ADDED (UTC)', 'STATUS', 'CONTROLLER ID'], rows)
  );
  const pending = res.pending ?? [];
  if (pending.length > 0) {
    lines.push('', 'Pending requests (approve in the Feral File app):');
    lines.push(
      ...table(
        ['', 'CODE', 'LABEL', 'PLATFORM', 'EXPIRES (UTC)', 'CONTROLLER ID'],
        pending.map((p) => [
          ' ',
          formatCode(p.code),
          p.label,
          p.platform,
          formatTime(p.expiresAt),
          p.ctl,
        ])
      )
    );
  }
  return lines;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => [...r[i]].length)));
  const render = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c + ' '.repeat(widths[i] - [...c].length)))
      .join('  ');
  return [render(header), ...rows.map(render)];
}

/**
 * runControllers is `ff-cli device controllers [name]` (owner only).
 *
 * @param name - Optional device name
 */
export async function runControllers(name: string | undefined): Promise<void> {
  const device = requirePairableDevice(name);
  const record = requireEnrolledController(device);
  const result = await runOwnerCommand(device, record, 'listControllers', {});
  if (!result.success) {
    throw ownerFailure(result);
  }
  console.log(chalk.blue(`\nControllers on ${deviceLabel(device)} (${device.id})\n`));
  const res = (result.response ?? {}) as { controllers?: ControllerRow[]; pending?: PendingRow[] };
  for (const line of formatControllerTable(res, Math.floor(Date.now() / 1000))) {
    console.log(`  ${line}`);
  }
  console.log(chalk.dim('\n  * = this ff-cli\n'));
}

/**
 * runRevoke is `ff-cli device revoke <ctl> [name]` (owner only). Revoking a
 * ctl that only has a pending request denies that request (§5.5).
 *
 * @param ctl - controllerId to revoke
 * @param name - Optional device name
 */
export async function runRevoke(ctl: string, name: string | undefined): Promise<void> {
  if (!isThumbprint(ctl)) {
    throw new CommandFailure(
      'Controller ID must be the 43-character ID shown by `ff-cli device controllers`.'
    );
  }
  const device = requirePairableDevice(name);
  const record = requireEnrolledController(device);
  const result = await runOwnerCommand(device, record, 'revokeController', { ctl });
  if (!result.success) {
    throw ownerFailure(result);
  }
  console.log(chalk.green(`\n✓ Revoked controller ${ctl} on ${deviceLabel(device)}.`));
  if (ctl === controllerIdOf(record.keys)) {
    console.log(chalk.dim('That was this ff-cli. Run `ff-cli device unpair` to delete its keys.'));
  }
  console.log();
}

/**
 * confirmInteractively asks a yes/no question on a TTY and refuses (false)
 * when stdin is not interactive, so scripts must pass --yes explicitly.
 *
 * @param question - Question text
 * @returns The answer
 */
async function confirmInteractively(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const prompt = createPrompt();
  try {
    return await promptYesNo(prompt.ask, question, false);
  } finally {
    prompt.close();
  }
}

/**
 * selfRevoke sends the best-effort sealed self-revoke of §14.7
 * (`revokeController` with this controller's own ctl) before its keys are
 * deleted. Every failure is ignored: old firmware answers permission_denied,
 * a sole owner gets last_owner, the FF1 may be offline. Each request is
 * bounded by UNPAIR_REVOKE_TIMEOUT_MS so an unreachable FF1 only briefly
 * delays the delete.
 *
 * @param device - Device with ID
 * @param record - Enrolled controller record
 * @param deps - Transport seams; controllerStore is the store the record is in
 * @returns True when the FF1 confirmed the revoke
 */
async function selfRevoke(
  device: PairDevice,
  record: ControllerRecord,
  deps: SecureTransportDeps
): Promise<boolean> {
  try {
    const result = await runOwnerCommand(
      device,
      record,
      'revokeController',
      { ctl: controllerIdOf(record.keys) },
      {
        ...deps,
        fetchFn:
          deps.fetchFn ??
          ((input, init) => fetchWithTimeout(input, init ?? {}, UNPAIR_REVOKE_TIMEOUT_MS)),
        v2TimeoutMs: deps.v2TimeoutMs ?? UNPAIR_REVOKE_TIMEOUT_MS,
        noticeFn: () => undefined,
      }
    );
    if (!result.success) {
      logger.debug(`Self-revoke was not confirmed: ${result.error ?? ''} ${result.details ?? ''}`);
    }
    return result.success;
  } catch (error) {
    logger.debug(`Self-revoke failed: ${(error as Error).message}`);
    return false;
  }
}

/**
 * runUnpair is `ff-cli device unpair [name]`: revoke this controller on the
 * FF1 (best effort, §14.7), then delete the local controller file whatever
 * the outcome.
 *
 * Deleting keys always asks first (or needs --yes), like Remove in the app
 * (§14.3). An OWNER grant gets a stronger warning: it is the device's
 * recovery path and the last reachable owner's keys cannot be recreated.
 *
 * @param name - Optional device name
 * @param options - `yes` skips the confirmation
 * @param confirmFn - Confirmation prompt (tests inject one)
 * @param deps - Transport seams for the self-revoke (tests)
 */
export async function runUnpair(
  name: string | undefined,
  options: { yes?: boolean } = {},
  confirmFn: (question: string) => Promise<boolean> = confirmInteractively,
  deps: SecureTransportDeps = {}
): Promise<void> {
  const device = requirePairableDevice(name);
  const store = deps.controllerStore ?? {};
  let record: ControllerRecord | null = null;
  let role: string | undefined;
  let present = false;
  try {
    record = loadController(device.id, store);
    role = record?.role;
    present = record !== null;
  } catch (error) {
    if (!(error instanceof ControllerFileCorruptError)) {
      throw error; // unreadable: deleting it may remove a working owner key
    }
    present = true; // corrupt file: delete it anyway
  }
  // An approved but unfinished replacement pairing is deleted too; its role
  // decides the warning as much as the main file's does.
  const staged = loadUnlessCorrupt(device.id, stagingStore(store));
  if (staged !== null) {
    present = true;
    if (staged !== 'corrupt' && staged.role === 'owner') {
      role = 'owner';
    }
  }
  if (present && !options.yes) {
    console.log(
      chalk.yellow(
        role === 'owner'
          ? `\nff-cli is an OWNER of ${deviceLabel(device)}. If no other owner can reach this FF1, deleting these keys leaves it without a reachable owner until a factory reset.`
          : `\nff-cli loses its access to ${deviceLabel(device)}. Pairing again needs an owner to add it in the Feral File app.`
      )
    );
    if (
      !(await confirmFn(
        role === 'owner' ? 'Delete the owner keys anyway?' : 'Delete the controller keys?'
      ))
    ) {
      throw new CommandFailure(
        'Unpair cancelled; nothing was deleted.',
        'Pass --yes to skip this check.'
      );
    }
  }
  if (staged !== null && staged !== 'corrupt' && isEnrolled(staged)) {
    await selfRevoke(device, staged, { ...deps, controllerStore: stagingStore(store) });
  }
  const revoked = record !== null && isEnrolled(record) && (await selfRevoke(device, record, deps));
  const shownKeys = loadPairingKeys(device.id, store);
  deleteController(device.id, stagingStore(store)); // an unfinished replacement pairing
  const deletedShown = deletePairingKeys(device.id, store); // keys an interrupted pairing showed
  if (!deleteController(device.id, store)) {
    if (deletedShown) {
      const shownCtl = shownKeys ? controllerIdOf(shownKeys) : undefined;
      console.log(
        chalk.yellow(
          `\nDeleted the keys an unfinished pairing with ${deviceLabel(device)} showed. If an owner already added them, the FF1 still lists that controller` +
            (shownCtl
              ? ` (${shownCtl}): ask an owner to remove it in the Feral File app (Controllers) or with \`ff-cli device revoke ${shownCtl}\`.\n`
              : ': ask an owner to remove it in the Feral File app (Controllers).\n')
        )
      );
      return;
    }
    console.log(chalk.dim(`\nff-cli has no controller keys for ${deviceLabel(device)}.\n`));
    return;
  }
  console.log(chalk.green(`\n✓ Deleted ff-cli's controller keys for ${deviceLabel(device)}.`));
  if (revoked) {
    console.log(chalk.dim('The FF1 revoked this controller’s access.'));
  } else if (record) {
    const ctl = controllerIdOf(record.keys);
    console.log(
      chalk.dim(
        `The FF1 may still list controller ${ctl} until an owner revokes it in the Feral File app or with \`ff-cli device revoke ${ctl}\`.`
      )
    );
  }
  console.log();
}
