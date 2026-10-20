/**
 * Command actions for FF1 controller pairing and management
 * (`ff-cli device pair|controllers|revoke|unpair`, feral-file#3551 M6).
 *
 * Copy rules: never print private key material or the relayer topic; print
 * the controllerId (a public thumbprint) and the approval code freely.
 */

import chalk from 'chalk';
import { resolveConfiguredDevice } from '../../utilities/ff1-compatibility';
import { type HandoffPayload, HandoffReceiver } from '../../utilities/handoff-client';
import { storeTopicId } from '../../utilities/topic-store';
import { createPrompt, promptYesNo } from './prompt';
import type { FF1Device } from '../../types';
import { controllerIdOf } from '../../utilities/control/codec';
import { isThumbprint } from '../../utilities/control/jwk';
import {
  type ControllerRecord,
  controllerFilePath,
  deleteController,
  isEnrolled,
  loadController,
} from '../../utilities/control/controller-store';
import {
  DEFAULT_PAIR_TIMEOUT_MS,
  defaultControllerLabel,
  localApprovalCode,
  pollEnrollment,
  prepareController,
  requestAccess,
} from '../../utilities/control/pairing';
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
}

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
 * parseTimeoutMs validates `--timeout <seconds>` (10 s to 1 h).
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
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) {
    throw new CommandFailure('--timeout must be a whole number of seconds between 10 and 3600');
  }
  return seconds * 1000;
}

/**
 * parseLabel validates `--label` against the protocol's 1-64 characters.
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
  const length = [...label].length;
  if (length < 1 || length > 64) {
    throw new CommandFailure('--label must be 1-64 characters');
  }
  return label;
}

/**
 * runPair is `ff-cli device pair [name]`: receive the app handoff (or resume
 * a pending pairing), then request access and wait for owner approval.
 *
 * @param name - Optional device name
 * @param options - Flags
 */
export async function runPair(name: string | undefined, options: PairOptions): Promise<void> {
  const device = requirePairableDevice(name);
  const timeoutMs = parseTimeoutMs(options.timeout);
  const label = parseLabel(options.label);
  if (options.resume) {
    const record = loadController(device.id);
    if (!record) {
      throw new CommandFailure(
        `There is no pairing to resume for ${deviceLabel(device)}.`,
        `Run \`${pairCommand(deviceLabel(device))}\` to start one.`
      );
    }
    await enrollController(device, record, timeoutMs, false);
    return;
  }
  const payload = await receiveHandoff(device);
  if (payload.v === 1) {
    storeTopicId(device.id, payload.topicId);
    console.log(chalk.green('\n✓ Relayer access stored in the operating system secure storage.\n'));
    return;
  }
  if (payload.topicId) {
    storeHandoffTopic(device.id, payload.topicId);
  }
  const { record, reused } = prepareController(payload.profile, label);
  console.log(
    chalk.dim(
      `\n${reused ? 'Using this computer’s existing' : 'Created new'} controller keys: ${controllerFilePath(device.id)}`
    )
  );
  await enrollController(device, record, timeoutMs, !reused);
}

/**
 * storeHandoffTopic stores the v2 handoff's relayer topic. On a v2 handoff
 * the topic only enables the relayer fallback; the controller pairing works
 * without it, so an unavailable keyring (headless Linux has no secret
 * service) is a warning, not a failed pairing. The topic is never printed.
 *
 * @param deviceId - FF1 device ID
 * @param topicId - Relayer topic from the handoff
 * @param storeFn - Keyring writer (tests inject a failing one)
 * @param warnFn - Warning sink
 * @returns True when the topic was stored
 */
export function storeHandoffTopic(
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

/** receiveHandoff runs the existing broker handoff and always closes the channel. */
async function receiveHandoff(device: PairDevice): Promise<HandoffPayload> {
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
    return await receiver.receiveHandoff({ expectedDeviceId: device.id });
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
 * formatCode renders a 6-digit approval code as "123 456" for reading aloud.
 *
 * @param code - Six digits
 * @returns Spaced code
 */
export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/**
 * enrollController requests access, shows the approval code, and polls until
 * the owner approves. Ctrl-C stops polling between requests (the controller
 * file is always consistent) and prints how to resume; a second Ctrl-C exits
 * at once.
 *
 * @param device - Device with ID
 * @param record - Controller record (pending or enrolled)
 * @param timeoutMs - Approval wait
 * @param createdNow - Whether this run created the record (deleted on refusal)
 * @param deps - Transport and store seams (tests)
 */
export async function enrollController(
  device: PairDevice,
  record: ControllerRecord,
  timeoutMs: number,
  createdNow: boolean,
  deps: SecureTransportDeps = {}
): Promise<void> {
  const ctl = controllerIdOf(record.keys);
  // A pending controller file switches every command to envelopes, so a file
  // created by THIS run is removed whenever the run ends without a request the
  // owner can approve: refused (an FF1 with no secure owner answers
  // not_approved), unreachable, a code mismatch, or Ctrl-C before the request
  // was confirmed. A reused file belonged to an earlier pairing; keep it.
  const discard = () => {
    if (createdNow) {
      deleteController(device.id, deps.controllerStore);
    }
  };
  // SIGINT handling is installed before requestAccess, so a Ctrl-C while the
  // request is in flight is seen and cleaned up instead of killing the process.
  const result = await withInterrupt(async (cancelled) => {
    console.log(
      `\nRequesting access to ${chalk.bold(deviceLabel(device))} as "${record.label}"...`
    );
    const access = await requestAccess(device, record, deps);
    if (access.status === 'failed') {
      discard();
      throw new CommandFailure(access.failure.error, access.failure.details);
    }
    if (cancelled()) {
      discard();
      return { status: 'interrupted-early' as const };
    }
    if (access.status === 'pending') {
      const code = localApprovalCode(record);
      // The device signs its code with the pinned devSig over the same
      // inputs, so a mismatch cannot be a man-in-the-middle; it is a bug.
      if (access.code !== code) {
        discard();
        throw new CommandFailure(
          'The FF1 reported a different approval code than ff-cli computed.'
        );
      }
      console.log('\nOn an owner’s phone, open the Feral File app and approve this request.');
      console.log('Approve it only if the app shows this code:');
      console.log(`\n  ${chalk.bold.cyan(formatCode(code))}\n`);
      console.log(chalk.dim(`Controller ID: ${ctl}`));
      console.log(chalk.dim(`Waiting up to ${Math.round(timeoutMs / 1000)}s for approval...`));
    }
    return pollEnrollment(device, record, deps, {
      timeoutMs,
      cancelled,
      storeOptions: deps.controllerStore,
    });
  });
  if (result.status === 'interrupted-early') {
    console.log(
      chalk.yellow(
        `\nPairing interrupted. Run \`${pairCommand(deviceLabel(device))}\` to start again.`
      )
    );
    process.exitCode = 130;
    return;
  }
  reportEnrollment(device, result);
}

/** reportEnrollment prints the final pairing state or throws a failure. */
function reportEnrollment(
  device: PairDevice,
  result: Awaited<ReturnType<typeof pollEnrollment>>
): void {
  const resume = `${pairCommand(deviceLabel(device))} --resume`;
  switch (result.status) {
    case 'enrolled': {
      const role = result.record.role!;
      console.log(
        chalk.green(`\n✓ ff-cli is paired with ${deviceLabel(device)} as ${chalk.bold(role)}.`)
      );
      console.log(
        chalk.dim(
          role === 'owner'
            ? 'Owner access covers every command, including ssh and controller management.\n'
            : 'Controller access covers playback and device status. SSH and controller management need an owner grant.\n'
        )
      );
      return;
    }
    case 'timeout':
      throw new CommandFailure(
        'Timed out waiting for approval.',
        `To ask again, run \`${resume}\`.`
      );
    case 'cancelled':
      console.log(
        chalk.yellow(
          `\nPairing interrupted. The request stays pending on the FF1 for a few minutes; run \`${resume}\` to continue.`
        )
      );
      process.exitCode = 130;
      return;
    default:
      throw new CommandFailure(result.failure.error, result.failure.details);
  }
}

/**
 * withInterrupt runs fn with a cancellation flag wired to the first Ctrl-C.
 * A second Ctrl-C exits immediately; that is safe because counter
 * allocation and grant storage are synchronous, so no signal handler can run
 * in the middle of a file update.
 */
async function withInterrupt<T>(fn: (cancelled: () => boolean) => Promise<T>): Promise<T> {
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) {
      process.exit(130);
    }
    interrupted = true;
    console.log(chalk.yellow('\nStopping after the current request... (Ctrl-C again to quit now)'));
  };
  process.on('SIGINT', onSigint);
  try {
    return await fn(() => interrupted);
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
  req: Record<string, unknown>
): Promise<SecureCommandResult> {
  return runSecureCommand({ device, record, cmd, req, relayerFallback: true, retry: false });
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
 * runUnpair is `ff-cli device unpair [name]`: delete the local controller
 * file. The FF1 keeps the grant until an owner revokes it, so the message
 * says so and prints the controller ID to revoke.
 *
 * An OWNER grant is the device's recovery path, so deleting it asks first
 * (or needs --yes): the last reachable owner's keys cannot be recreated.
 *
 * @param name - Optional device name
 * @param options - `yes` skips the owner confirmation
 * @param confirmFn - Confirmation prompt (tests inject one)
 */
export async function runUnpair(
  name: string | undefined,
  options: { yes?: boolean } = {},
  confirmFn: (question: string) => Promise<boolean> = confirmInteractively
): Promise<void> {
  const device = requirePairableDevice(name);
  let ctl: string | undefined;
  let role: string | undefined;
  try {
    const record = loadController(device.id);
    ctl = record ? controllerIdOf(record.keys) : undefined;
    role = record?.role;
  } catch {
    ctl = undefined; // corrupt file: delete it anyway
  }
  if (role === 'owner' && !options.yes) {
    console.log(
      chalk.yellow(
        `\nff-cli is an OWNER of ${deviceLabel(device)}. If no other owner can reach this FF1, deleting these keys leaves it without a reachable owner until a factory reset.`
      )
    );
    if (!(await confirmFn('Delete the owner keys anyway?'))) {
      throw new CommandFailure(
        'Unpair cancelled; nothing was deleted.',
        'Pass --yes to skip this check.'
      );
    }
  }
  if (!deleteController(device.id)) {
    console.log(chalk.dim(`\nff-cli has no controller keys for ${deviceLabel(device)}.\n`));
    return;
  }
  console.log(chalk.green(`\n✓ Deleted ff-cli's controller keys for ${deviceLabel(device)}.`));
  if (ctl) {
    console.log(
      chalk.dim(
        `The FF1 still lists controller ${ctl} until an owner revokes it in the Feral File app or with \`ff-cli device revoke ${ctl}\`.`
      )
    );
  }
  console.log();
}
