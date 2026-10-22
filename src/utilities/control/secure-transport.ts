/**
 * Secure command transport (ffos-user docs/ff1-control-v1.md §10): sends one
 * request as `{"command":"ff1Envelope","request":{"v":1,"jwe":…}}` to the
 * FF1's LAN `POST /api/cast`, and, where today's plaintext path falls back,
 * through the relayer topic cast.
 *
 * Rules this module owns (keep them when changing it):
 * - Every attempt is sealed afresh with a newly allocated counter, rid, rk,
 *   epk and IV. The same ctr is never sent twice, so a retry after an
 *   ambiguous failure (timeout, empty body) is a NEW request. The device's
 *   replay window would reject a resend anyway; resending would also let a
 *   lost-but-executed command run twice.
 * - Retries happen only where the legacy path already retries
 *   (displayPlaylist: transient network errors, HTTP 429, empty or non-JSON
 *   2xx bodies), plus the two encrypted codes the spec says to retry with a
 *   new ctr (internal_error) or after a pause (rate_limited).
 * - The relayer is used only after LAN reachability is exhausted, never after
 *   an HTTP or protocol answer, exactly like the legacy fallback.
 * - A reply that fails §4.2 verification is discarded whole and not retried:
 *   on the relayer a forged "first reply wins" answer costs availability
 *   only, and retrying would hand an attacker a free oracle.
 * - A `replay` in a reply that VERIFIED under the pinned devSig is the one
 *   answer that moves the counter: it proves the request did not run, so the
 *   counter jumps past the FF1's window and the command is sent once more
 *   (§14.4). A public error is never evidence of this.
 */

import { RelayClient } from '../relay-client';
import { defaultDeadlineFetch } from '../http';
import * as logger from '../../logger';
import { getFF1RelayerConfig } from '../../config';
import type { FF1Device } from '../../types';
import { getTopicId } from '../topic-store';
import { sendCastViaRelayer } from '../ff1-relayer';
import {
  isConnectPhaseNetworkError,
  isTransientDeviceNetworkError,
  parseRetryAfterMs,
} from '../device-network';
import {
  type EnrollObject,
  type ReplyClaims,
  type RequestOp,
  type SealedRequest,
  controllerIdOf,
  envelopeCastBody,
  openReply,
  sealRequest,
} from './codec';
import {
  type ControllerRecord,
  type ControllerStoreOptions,
  isEnrolled,
  loadController,
  nextCounter,
  skipCounterAhead,
} from './controller-store';
import {
  type ControlFailure,
  describeControlCode,
  pairCommand,
  replayAfterJumpFailure,
  unpairCommand,
  unverifiedReplyFailure,
} from './control-errors';

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 30_000;
// §4.4 public errors come back as LAN 401/403, and `busy` (the device was
// authenticating too many envelopes at once; nothing was executed) as 503.
const PUBLIC_ERROR_STATUSES = new Set([401, 403, 503]);
/**
 * REPLAY_COUNTER_JUMP is how far a verified `replay` moves the counter. The
 * spec asks for at least the 64-entry window; a restored backup can be many
 * requests behind, and skipped counters cost nothing, so one jump covers it.
 */
export const REPLAY_COUNTER_JUMP = 1024;

export type Transport = 'lan' | 'relayer';

/** SecureTransportDeps are injectable for tests; production uses the defaults. */
export interface SecureTransportDeps {
  fetchFn?: typeof fetch;
  getTopicIdFn?: (deviceId: string) => string | null;
  getRelayerConfigFn?: () => { baseUrl: string; apiKey?: string; v2Endpoint?: string };
  waitFn?: (delayMs: number) => Promise<void>;
  noticeFn?: (message: string) => void;
  controllerStore?: ControllerStoreOptions;
  /** Unix seconds; tests pin the clock. */
  nowFn?: () => number;
}

type ResolvedDeps = Required<Omit<SecureTransportDeps, 'controllerStore'>> & {
  controllerStore: ControllerStoreOptions;
};

/** SecureRequest describes one logical command; attempts are sealed from it. */
export interface SecureRequest {
  device: FF1Device & { id: string };
  op: RequestOp;
  cmd?: string;
  req?: Record<string, unknown>;
  enroll?: EnrollObject;
  /** Fall back to the relayer when the LAN is unreachable (Play path only). */
  relayerFallback: boolean;
  /** Apply the legacy retry budget (Play path only). */
  retry: boolean;
}

/**
 * SecureOutcome is what one logical command produced: a verified reply
 * (which may itself be ok:false), a public error (§4.4), or a local failure.
 */
export type SecureOutcome =
  | {
      kind: 'reply';
      reply: ReplyClaims;
      transport: Transport;
      /** The FF1 answered replay again after the counter jump and its one retry. */
      replayRetried?: boolean;
    }
  | { kind: 'public'; code: string; transport: Transport }
  | {
      kind: 'failed';
      error: string;
      details?: string;
      transport?: Transport;
      code?: string;
      /** The LAN could not be reached (and no relayer route was taken). */
      unreachable?: boolean;
      /**
       * The LAN request hit its deadline: it may or may not have reached the
       * FF1, so only an idempotent request (the enroll poll) may treat it as
       * transient.
       */
      timedOut?: boolean;
    };

/** AttemptResult classifies one LAN attempt for the retry loop. */
type AttemptResult =
  | SecureOutcome
  | { kind: 'retryable'; reason: string; delayMs?: number; final: SecureOutcome };

function resolveDeps(deps: SecureTransportDeps): ResolvedDeps {
  return {
    fetchFn: deps.fetchFn ?? defaultDeadlineFetch,
    getTopicIdFn: deps.getTopicIdFn ?? getTopicId,
    getRelayerConfigFn: deps.getRelayerConfigFn ?? getFF1RelayerConfig,
    waitFn: deps.waitFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    noticeFn: deps.noticeFn ?? logger.always,
    nowFn: deps.nowFn ?? (() => Math.floor(Date.now() / 1000)),
    controllerStore: deps.controllerStore ?? {},
  };
}

/**
 * findSecureController returns the controller record to use for a device, or
 * null when the device has none (legacy path). A pending (not yet approved)
 * record is reported as a failure instead of being used: the device would
 * answer `pending`/`not_approved` and the legacy path is not an option for a
 * device the app already handed a control profile for.
 *
 * @param device - Configured device
 * @param options - Controller store options
 * @returns The record, null for legacy, or a failure
 */
export function findSecureController(
  device: FF1Device,
  options: ControllerStoreOptions = {}
): { record: ControllerRecord | null; failure?: ControlFailure } {
  if (!device.id) {
    return { record: null };
  }
  let record: ControllerRecord | null;
  try {
    record = loadController(device.id, options);
  } catch (error) {
    return { record: null, failure: { code: 'store', error: (error as Error).message } };
  }
  if (record && !isEnrolled(record)) {
    return {
      record: null,
      failure: {
        code: 'pending',
        error: 'Pairing ff-cli with this FF1 is not finished.',
        details: `Run \`${pairCommand(device.name ?? device.id)} --resume\` to finish it, or run \`${unpairCommand(device.name ?? device.id)}\` to go back to unpaired access.`,
      },
    };
  }
  return { record };
}

/**
 * sealNext allocates a counter (persisted before returning) and seals the
 * request with it.
 */
async function sealNext(request: SecureRequest, deps: ResolvedDeps): Promise<SealedRequest> {
  const { record, ctr } = nextCounter(request.device.id, deps.controllerStore);
  return sealRequest({
    profile: record.profile,
    keys: record.keys,
    ctr,
    op: request.op,
    cmd: request.cmd,
    req: request.req,
    enroll: request.enroll,
    now: deps.nowFn(),
  });
}

/**
 * findEnvelopeAnswer locates the device's answer in a response body: the LAN
 * returns it at top level, the relayer wraps the RPC `message` one or two
 * levels down. The answer is `{v:1,jwe}` or a public `{error:{code}}`.
 *
 * @param value - Parsed response body
 * @returns The compact JWE, a public code, or null when absent
 */
export function findEnvelopeAnswer(value: unknown): { jwe?: string; code?: string } | null {
  let current: unknown = value;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    const record = current as Record<string, unknown>;
    if (record.v === 1 && typeof record.jwe === 'string') {
      return { jwe: record.jwe };
    }
    const error = record.error as Record<string, unknown> | undefined;
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      return { code: error.code };
    }
    current = record.message;
  }
  return null;
}

/**
 * openAnswer turns a located answer into an outcome, verifying a reply
 * against the PINNED profile and the request's binding (§4.2).
 */
async function openAnswer(
  answer: { jwe?: string; code?: string },
  sealed: SealedRequest,
  record: ControllerRecord,
  transport: Transport
): Promise<SecureOutcome> {
  if (answer.code) {
    return { kind: 'public', code: answer.code, transport };
  }
  try {
    const reply = await openReply(answer.jwe!, sealed.rk, record.profile.sig, {
      dev: sealed.claims.dev,
      gen: sealed.claims.gen,
      ctl: sealed.claims.ctl,
      rid: sealed.claims.rid,
    });
    return { kind: 'reply', reply, transport };
  } catch (error) {
    const failure = unverifiedReplyFailure((error as Error).message);
    return { kind: 'failed', ...failure, transport };
  }
}

/** attemptLan sends one sealed request over the LAN and classifies the result. */
async function attemptLan(
  request: SecureRequest,
  sealed: SealedRequest,
  record: ControllerRecord,
  deps: ResolvedDeps
): Promise<AttemptResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (request.device.apiKey) {
    headers['API-KEY'] = request.device.apiKey;
  }
  const response = await deps.fetchFn(`${request.device.host}/api/cast`, {
    method: 'POST',
    headers,
    body: JSON.stringify(envelopeCastBody(sealed.compact)),
  });
  const bodyText = (await response.text()).trim();
  if (response.status === 429) {
    const delayMs = parseRetryAfterMs(response.headers.get('retry-after'));
    return {
      kind: 'retryable',
      reason: 'Device rate-limited the command',
      delayMs,
      final: {
        kind: 'failed',
        error: `Device "${request.device.name || request.device.host}" is busy and rate-limited the command`,
        details: 'Wait a few seconds and try again.',
        transport: 'lan',
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    parsed = undefined;
  }
  const answer = findEnvelopeAnswer(parsed);
  if (answer && (response.ok || (answer.code && PUBLIC_ERROR_STATUSES.has(response.status)))) {
    return openAnswer(answer, sealed, record, 'lan');
  }
  if (!response.ok) {
    return {
      kind: 'failed',
      error: `Device returned error ${response.status}: ${response.statusText}`,
      details: bodyText.slice(0, 500),
      transport: 'lan',
    };
  }
  const issue = bodyText
    ? `device returned a response without a secure reply: ${bodyText.slice(0, 200)}`
    : 'device returned an empty response body';
  return {
    kind: 'retryable',
    reason: issue,
    final: {
      kind: 'failed',
      error: `Device "${request.device.name || request.device.host}" accepted the request (HTTP ${response.status}) but returned no secure reply`,
      details: `${issue}. Check that the device address still reaches this FF1; ff-cli keeps its keys. Only if you know this FF1 now runs firmware without secure control, run \`${unpairCommand(request.device.name ?? request.device.id)}\`.`,
      transport: 'lan',
    },
  };
}

/**
 * retryableReply reports whether an answer may be retried with a new
 * request: the public `busy` (§4.4: not executed), `internal_error` (§4.3: not executed, retry with a new ctr),
 * `rate_limited`, and a `command_failed` whose handler body is the router's
 * storm protection (`res.error == "rate_limited"`), which the plaintext path
 * sees as HTTP 429 and already retries.
 */
function retryableReply(outcome: SecureOutcome): boolean {
  if (outcome.kind === 'public') {
    return outcome.code === 'busy';
  }
  if (outcome.kind !== 'reply' || outcome.reply.ok) {
    return false;
  }
  const code = outcome.reply.code;
  if (code === 'internal_error' || code === 'rate_limited') {
    return true;
  }
  const res = outcome.reply.res as { error?: unknown } | undefined;
  return code === 'command_failed' && res?.error === 'rate_limited';
}

/** isDeadlineError reports a request aborted by its fetch deadline. */
function isDeadlineError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * sendSecureRequest delivers one logical command and returns its outcome.
 * A verified `replay` (the counter fell behind the FF1's window) moves the
 * counter ahead and sends the command once more as a new request (§14.4).
 *
 * @param request - The command and its routing rules
 * @param record - The device's enrolled (or, for pairing, pending) controller record
 * @param overrides - Test seams
 * @returns The outcome; never throws for network or protocol failures
 */
export async function sendSecureRequest(
  request: SecureRequest,
  record: ControllerRecord,
  overrides: SecureTransportDeps = {}
): Promise<SecureOutcome> {
  const deps = resolveDeps(overrides);
  const outcome = await sendOnce(request, record, deps);
  if (outcome.kind !== 'reply' || outcome.reply.ok || outcome.reply.code !== 'replay') {
    return outcome;
  }
  try {
    skipCounterAhead(request.device.id, REPLAY_COUNTER_JUMP, deps.controllerStore);
  } catch (error) {
    logger.debug(`Could not move the controller counter ahead: ${(error as Error).message}`);
    return outcome;
  }
  logger.debug(
    `The FF1 answered replay; counter moved ahead by ${REPLAY_COUNTER_JUMP}, retrying once`
  );
  const retried = await sendOnce(request, record, deps);
  if (retried.kind === 'reply' && !retried.reply.ok && retried.reply.code === 'replay') {
    return { ...retried, replayRetried: true };
  }
  return retried;
}

/**
 * sendOnce is one logical delivery: the LAN with its retry budget, then the
 * relayer when the LAN was unreachable.
 */
async function sendOnce(
  request: SecureRequest,
  record: ControllerRecord,
  deps: ResolvedDeps
): Promise<SecureOutcome> {
  const attempts = request.retry ? RETRY_ATTEMPTS : 1;
  let last: SecureOutcome | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result: AttemptResult;
    try {
      const sealed = await sealNext(request, deps);
      result = await attemptLan(request, sealed, record, deps);
    } catch (error) {
      if (!isTransientDeviceNetworkError(error)) {
        return {
          kind: 'failed',
          error: (error as Error).message,
          ...(isDeadlineError(error) ? { timedOut: true } : {}),
        };
      }
      // §14.4: a command may be sent again (new ctr, LAN or relayer) only when
      // the failure proves it never left this machine. enroll is idempotent
      // on the FF1 (§5.3), so it keeps retrying.
      if (request.op === 'cmd' && !isConnectPhaseNetworkError(error)) {
        return outcomeUnknown(request, error as Error);
      }
      if (attempt < attempts) {
        logger.warn(
          `Transient network error (attempt ${attempt}/${attempts}): ${(error as Error).message}`
        );
        await deps.waitFn(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      return fallbackOrUnreachable(request, record, deps, error as Error);
    }
    const retryable = result.kind === 'retryable' || retryableReply(result);
    if (!retryable) {
      return result as SecureOutcome;
    }
    last = result.kind === 'retryable' ? result.final : (result as SecureOutcome);
    if (attempt < attempts) {
      const delay = Math.min(
        (result.kind === 'retryable' && result.delayMs) || RETRY_BASE_DELAY_MS * attempt,
        MAX_RETRY_DELAY_MS
      );
      logger.warn(`Retrying with a new request in ${delay}ms (attempt ${attempt}/${attempts})`);
      await deps.waitFn(delay);
    }
  }
  return last!;
}

/**
 * outcomeUnknown reports a command whose LAN request may have reached the FF1
 * (the connection broke after it was opened). It is not sent again, so a
 * non-idempotent command cannot run twice.
 */
function outcomeUnknown(request: SecureRequest, lanError: Error): SecureOutcome {
  const label = request.device.name || request.device.host;
  logger.debug(`Ambiguous LAN failure: ${lanError.message}`);
  return {
    kind: 'failed',
    error: `Outcome unknown: the connection to "${label}" broke after the request was sent (${lanError.message})`,
    details:
      'The FF1 may already have run it, so ff-cli did not send it again. Check the FF1, then run the command again if it did not take effect.',
  };
}

/**
 * fallbackOrUnreachable sends a freshly sealed request through the relayer
 * when allowed and possible, else reports the LAN as unreachable.
 */
async function fallbackOrUnreachable(
  request: SecureRequest,
  record: ControllerRecord,
  deps: ResolvedDeps,
  lanError: Error
): Promise<SecureOutcome> {
  const label = request.device.name || request.device.host;
  const unreachable: SecureOutcome = {
    kind: 'failed',
    unreachable: true,
    error: `Could not reach device "${label}" at ${request.device.host}`,
    details:
      'Check that the device is powered on and reachable on your network. ' +
      'If the device IP changed (e.g. after a factory reset), run: ff-cli setup',
  };
  logger.debug(`LAN failure: ${lanError.message}`);
  if (!request.relayerFallback) {
    return unreachable;
  }
  try {
    const relay = deps.getRelayerConfigFn();
    if (relay.v2Endpoint && request.op === 'cmd') {
      const outcome = await sendViaV2(request, record, deps, relay.v2Endpoint);
      if (outcome.kind !== 'failed' || !outcome.unreachable) {
        return outcome;
      }
      // Only the binding probe ran. The user's command was never sent, so an
      // optional legacy topic can carry a fresh sealed request to older firmware.
    }
  } catch (error) {
    return {
      kind: 'failed',
      error: 'Invalid FF1 relayer configuration',
      details: (error as Error).message,
    };
  }
  let topicId: string | null;
  try {
    topicId = deps.getTopicIdFn(request.device.id);
  } catch (error) {
    return {
      ...unreachable,
      details: `${unreachable.details} Secure topic storage is unavailable: ${(error as Error).message}`,
    } as SecureOutcome;
  }
  if (!topicId) {
    return {
      ...unreachable,
      details: `${unreachable.details} The relayer route needs the topic the Feral File app sends during \`ff-cli device pair\`.`,
    } as SecureOutcome;
  }
  return sendViaRelayer(request, record, deps, topicId);
}

/** sendViaV2 binds this connection with a fresh sealed status request before
 * sending the caller's command. Neither a rejected candidate nor a receipt can
 * select the device. A lost result is reported without LAN/legacy resubmission.
 */
async function sendViaV2(
  request: SecureRequest,
  record: ControllerRecord,
  deps: ResolvedDeps,
  endpoint: string
): Promise<SecureOutcome> {
  let client: RelayClient;
  try {
    client = new RelayClient(endpoint, record.profile.dev);
  } catch (error) {
    return { kind: 'failed', unreachable: true, error: (error as Error).message };
  }
  let commandStarted = false;
  const exchange = async (next: SecureRequest): Promise<SecureOutcome> => {
    let accepted: SecureOutcome | undefined;
    const size = JSON.stringify(next.req ?? {}).length;
    await client.requestPrepared(
      async () => {
        const sealed = await sealNext(next, deps);
        return {
          command: 'ff1Envelope',
          request: { v: 1, jwe: sealed.compact },
          verify: async (body) => {
            const answer = findEnvelopeAnswer(body);
            if (!answer?.jwe) {
              return false;
            }
            const outcome = await openAnswer(answer, sealed, record, 'relayer');
            if (outcome.kind !== 'reply') {
              return false;
            }
            accepted = outcome;
            return true;
          },
        };
      },
      30000 + (size > 32768 ? Math.ceil(size / 24000) * 1000 : 0)
    );
    return accepted!;
  };
  try {
    if (request.op === 'cmd') {
      const bound = await exchange({ ...request, cmd: 'getDeviceStatus', req: {}, retry: false });
      if (bound.kind !== 'reply' || !bound.reply.ok) {
        return bound;
      }
    }
    commandStarted = true;
    return await exchange(request);
  } catch (error) {
    return {
      kind: 'failed',
      error: commandStarted
        ? 'Secure relay result unavailable; execution outcome may be unknown'
        : 'Secure relay binding unavailable; command not sent',
      unreachable: !commandStarted,
      details: (error as Error).message,
      transport: 'relayer',
    };
  } finally {
    client.close();
  }
}

/** sendViaRelayer seals a NEW request (new ctr) and casts it on the topic. */
async function sendViaRelayer(
  request: SecureRequest,
  record: ControllerRecord,
  deps: ResolvedDeps,
  topicId: string
): Promise<SecureOutcome> {
  deps.noticeFn(
    `Notice: LAN device is unreachable; falling back to the FF1 relayer for ${request.device.name ?? request.device.id}.`
  );
  let relayer: { baseUrl: string; apiKey?: string; v2Endpoint?: string };
  try {
    relayer = deps.getRelayerConfigFn();
  } catch (error) {
    return {
      kind: 'failed',
      error: 'Invalid FF1 relayer configuration',
      details: (error as Error).message,
      transport: 'relayer',
    };
  }
  let sealed: SealedRequest;
  try {
    sealed = await sealNext(request, deps);
  } catch (error) {
    return { kind: 'failed', error: (error as Error).message, transport: 'relayer' };
  }
  const result = await sendCastViaRelayer({
    ...relayer,
    topicId,
    body: envelopeCastBody(sealed.compact),
    fetchFn: deps.fetchFn,
  });
  if (!result.success) {
    return { kind: 'failed', error: result.error!, details: result.details, transport: 'relayer' };
  }
  const answer = findEnvelopeAnswer(result.response);
  if (!answer) {
    return {
      kind: 'failed',
      error: 'The FF1 relayer returned no secure reply',
      details: JSON.stringify(result.response).slice(0, 500),
      transport: 'relayer',
    };
  }
  return openAnswer(answer, sealed, record, 'relayer');
}

/** CommandResult is the shape the device command helpers already return. */
export interface SecureCommandResult {
  success: boolean;
  response?: Record<string, unknown>;
  error?: string;
  details?: string;
  transport?: Transport;
  /** Protocol code behind a failure, for callers that branch on it. */
  code?: string;
}

/**
 * outcomeToResult maps an outcome onto a command result with actionable copy.
 *
 * @param outcome - Secure outcome
 * @param device - Device, for the pair command in messages
 * @returns Command result
 */
export function outcomeToResult(outcome: SecureOutcome, device: FF1Device): SecureCommandResult {
  const label = device.name || device.id || device.host;
  if (outcome.kind === 'failed') {
    return {
      success: false,
      error: outcome.error,
      details: outcome.details,
      transport: outcome.transport,
      code: outcome.code,
    };
  }
  const code = outcome.kind === 'public' ? outcome.code : outcome.reply.code;
  if (outcome.kind === 'reply' && outcome.reply.ok) {
    const res = outcome.reply.res;
    return {
      success: true,
      response: res && typeof res === 'object' ? (res as Record<string, unknown>) : {},
      transport: outcome.transport,
    };
  }
  if (code === 'command_failed' && outcome.kind === 'reply') {
    // §4.3: res is the handler's error body, {ok:false,error,command,message}
    // for routed commands and {error:<reason>} for the owner commands.
    const res = outcome.reply.res as { message?: unknown } | undefined;
    return {
      success: false,
      error: `Device "${label}" rejected the command`,
      details: typeof res?.message === 'string' ? res.message : JSON.stringify(res ?? {}),
      transport: outcome.transport,
      code,
    };
  }
  const failure =
    outcome.kind === 'reply' && outcome.replayRetried
      ? replayAfterJumpFailure(label)
      : describeControlCode(code ?? 'unknown', label);
  return {
    success: false,
    error: failure.error,
    details: failure.details,
    transport: outcome.transport,
    code,
  };
}

/**
 * runSecureCommand sends `op:cmd` for an enrolled controller and maps the
 * outcome. It is the one entry point the three device commands use.
 *
 * @param input - Device, record, command and routing
 * @param overrides - Test seams
 * @returns Command result
 */
export async function runSecureCommand(
  input: {
    device: FF1Device & { id: string };
    record: ControllerRecord;
    cmd: string;
    req: Record<string, unknown>;
    relayerFallback: boolean;
    retry: boolean;
  },
  overrides: SecureTransportDeps = {}
): Promise<SecureCommandResult> {
  logger.debug(
    `Sending ${input.cmd} as controller ${controllerIdOf(input.record.keys)} (secure envelope)`
  );
  const outcome = await sendSecureRequest(
    {
      device: input.device,
      op: 'cmd',
      cmd: input.cmd,
      req: input.req,
      relayerFallback: input.relayerFallback,
      retry: input.retry,
    },
    input.record,
    overrides
  );
  return outcomeToResult(outcome, input.device);
}
