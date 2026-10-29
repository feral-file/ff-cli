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
 *   an HTTP or protocol answer, exactly like the legacy fallback. With a
 *   configured v2 endpoint, or for an FF1 whose verified status advertised
 *   relay v2, the v2 device channel is tried first; the legacy topic follows
 *   only when v2 proves the command undelivered (§10). One exception: a
 *   registration enroll tries a topic held from before the pairing first,
 *   and moves on only on the relayer's 1003, 410 or 404 (sendOnce). And an
 *   ordinary command whose topic is gone may still try v2 (C2,
 *   fallbackOrUnreachable).
 * - A reply that fails §4.2 verification is discarded whole and not retried:
 *   on the relayer a forged "first reply wins" answer costs availability
 *   only, and retrying would hand an attacker a free oracle.
 * - A `replay` in a reply that VERIFIED under the pinned devSig is the one
 *   answer that moves the counter: it proves the request did not run, so the
 *   counter jumps past the FF1's window and the command is sent once more
 *   (§14.4). A public error is never evidence of this, and neither is a
 *   `replay` over relay v2, where the FF1 may have received two copies of
 *   the same bytes: that is an unknown outcome (v2Answer).
 */

import { RelayAmbiguousError, RelayClient, RelayUndeliveredError } from '../relay-client';
import { defaultDeadlineFetch } from '../http';
import * as logger from '../../logger';
import { type FF1RelayerSettings, getFF1RelayerConfig } from '../../config';
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
  recordRelayV2,
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
/** V2_TIMEOUT_MS is the default deadline of one relay v2 command. */
const V2_TIMEOUT_MS = 30_000;

export type Transport = 'lan' | 'relayer';

/** SecureTransportDeps are injectable for tests; production uses the defaults. */
export interface SecureTransportDeps {
  fetchFn?: typeof fetch;
  getTopicIdFn?: (deviceId: string) => string | null;
  getRelayerConfigFn?: () => FF1RelayerSettings;
  waitFn?: (delayMs: number) => Promise<void>;
  noticeFn?: (message: string) => void;
  controllerStore?: ControllerStoreOptions;
  /** Unix seconds; tests pin the clock. */
  nowFn?: () => number;
  /**
   * Deadline of one relay v2 request, connecting included. Unpair's
   * self-revoke sets it so v2 honors the same bound as its LAN request.
   */
  v2TimeoutMs?: number;
  /** Creates the relay v2 client; tests drive replies through a fake. */
  relayClientFn?: (endpoint: string, deviceId: string) => V2Client;
}

/** V2Client is the part of RelayClient that sendViaV2 uses. */
export type V2Client = Pick<RelayClient, 'requestPrepared' | 'close'>;

type ResolvedDeps = Required<Omit<SecureTransportDeps, 'controllerStore' | 'v2TimeoutMs'>> & {
  controllerStore: ControllerStoreOptions;
  v2TimeoutMs?: number;
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
      /** HTTP status of the relayer's own non-2xx answer (see heldTopicGone). */
      relayerStatus?: number;
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
    v2TimeoutMs: deps.v2TimeoutMs,
    relayClientFn:
      deps.relayClientFn ?? ((endpoint, deviceId) => new RelayClient(endpoint, deviceId)),
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
  noteTransports(request, record, outcome, deps);
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
 * advertisedRelayV2 reads `control.transports` from a getDeviceStatus body
 * (bare, or in the `{message:{…}}` wrapper the LAN reply uses). An absent
 * transports member means lan and relayer only; an absent control block
 * says nothing, so it returns undefined.
 */
export function advertisedRelayV2(res: unknown): boolean | undefined {
  const body = res as { control?: unknown; message?: { control?: unknown } } | undefined;
  const control = (body?.control ?? body?.message?.control) as { transports?: unknown } | undefined;
  if (!control || typeof control !== 'object') {
    return undefined;
  }
  return Array.isArray(control.transports) && control.transports.includes('relayV2');
}

/**
 * noteTransports caches, from a VERIFIED getDeviceStatus reply only, whether
 * the FF1 advertises relay v2; fallbackOrUnreachable reads it when the LAN is
 * down. A plaintext status is never used: on the LAN anyone can forge it.
 */
function noteTransports(
  request: SecureRequest,
  record: ControllerRecord,
  outcome: SecureOutcome,
  deps: ResolvedDeps
): void {
  if (request.cmd !== 'getDeviceStatus' || outcome.kind !== 'reply' || !outcome.reply.ok) {
    return;
  }
  const relayV2 = advertisedRelayV2(outcome.reply.res);
  if (relayV2 === undefined || relayV2 === record.relayV2) {
    return;
  }
  record.relayV2 = relayV2;
  try {
    recordRelayV2(request.device.id, relayV2, deps.controllerStore);
  } catch (error) {
    logger.debug(`Could not record the FF1's relay transports: ${(error as Error).message}`);
  }
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
  // §10 newcomer order: a topic held from BEFORE the pairing goes first. It
  // reaches the real FF1's authenticated legacy socket, which cannot open an
  // enroll sealed to a profile forged by someone holding the QR's ps, so a
  // forgery fails there; over the LAN or the public v2 channel the forger
  // could answer it. Only the relayer's own 1003 (no device on the topic),
  // 410 (legacy retired) or 404 (legacy host shut down) lets the enroll go
  // on to the LAN and v2 (heldTopicGone).
  const held = registrationHeldTopic(request, record, deps);
  const heldTopic = held === UNKNOWN_HELD_TOPIC ? null : held;
  if (heldTopic) {
    const viaTopic = await sendViaRelayer(request, record, deps, heldTopic);
    if (!heldTopicGone(viaTopic)) {
      return viaTopic;
    }
  }
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
      return fallbackOrUnreachable(request, record, deps, error as Error, {
        topicTried: heldTopic !== null,
        heldTopicUnknown: held === UNKNOWN_HELD_TOPIC,
      });
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
  lanError: Error,
  held: { topicTried?: boolean; heldTopicUnknown?: boolean } = {}
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
  let v2Endpoint: string | undefined;
  let v2Tried = false;
  try {
    const relay = deps.getRelayerConfigFn();
    v2Endpoint = relay.v2Endpoint;
    // A derived endpoint is used only for an FF1 whose verified status
    // advertised relay v2; otherwise a stranger's ACK on the device channel
    // could strand a command the topic would have delivered (config.ts).
    // The flag changes only with a verified status or a verified v2 reply
    // (noteV2Reply), never on a failed send: one ambiguous v2 failure must
    // not cut a v2-only FF1 off until the next LAN visit. The cost is the other way round: an FF1 that
    // really left v2 is reached as "outcome unknown" (never resent) until
    // its next verified status clears the flag.
    // A registration enroll whose held topic could not be read stays off
    // v2: the topic it may hold would have to go first (§10), and the public
    // channel is where a forged profile is answered from anywhere.
    if (
      relay.v2Endpoint &&
      !held.heldTopicUnknown &&
      v2Allowed(request, record, relay.v2Explicit === true)
    ) {
      v2Tried = true;
      const outcome = await sendViaV2(request, record, deps, relay.v2Endpoint);
      noteV2Reply(request, record, outcome, deps);
      if (outcome.kind !== 'failed' || !outcome.unreachable) {
        return outcome;
      }
      // Proven undelivered: no chunk reached a peer, so an optional legacy
      // topic may carry a freshly sealed request (new ctr) instead.
    }
  } catch (error) {
    return {
      kind: 'failed',
      error: 'Invalid FF1 relayer configuration',
      details: (error as Error).message,
    };
  }
  if (held.topicTried) {
    // The held topic already answered 1003/410/404 in sendOnce.
    return unreachable;
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
  const viaTopic = await sendViaRelayer(request, record, deps, topicId);
  if (request.op === 'cmd' && !v2Tried && v2Endpoint && heldTopicGone(viaTopic)) {
    // The topic leads nowhere (the legacy host is gone, or no device is on
    // it) and v2 was not tried because no verified status has listed
    // relayV2 yet. The "v2 only when listed" rule exists to avoid an
    // ambiguous v2 send INSTEAD of a working topic; with the topic gone
    // there is nothing left to lose, and without this a CLI paired before
    // its FF1 listed relayV2 and used off the LAN would stay on the dead
    // topic forever (G3 fix handoff C2). The topic answer proved this
    // request undelivered, so it may go out again, freshly sealed.
    const outcome = await sendViaV2(request, record, deps, v2Endpoint);
    noteV2Reply(request, record, outcome, deps);
    if (outcome.kind !== 'failed' || !outcome.unreachable) {
      return outcome;
    }
  }
  return viaTopic;
}

/** The keyring could not be read: whether a topic is held is unknown. */
const UNKNOWN_HELD_TOPIC = Symbol('unknown held topic');

/**
 * registrationHeldTopic returns the keyring topic for a §5.6 registration
 * enroll (no `inv`, profile from a verified result), null when none is held
 * or the request is not one, or UNKNOWN_HELD_TOPIC when the keyring could
 * not be read. The keyring topic predates the pairing: the result's own
 * topic is stored only after the enroll verifies (device-control.ts).
 *
 * An unreadable keyring is not proof that no topic is held, so such an
 * enroll never goes over relay v2 (fallbackOrUnreachable). The LAN stays
 * open: Linux without a secret service can never store a topic, pairing
 * there is supported (storeRelayerTopic), and the LAN leg is what a pairing
 * had before relay v2.
 */
function registrationHeldTopic(
  request: SecureRequest,
  record: ControllerRecord,
  deps: ResolvedDeps
): string | null | typeof UNKNOWN_HELD_TOPIC {
  if (
    request.op !== 'enroll' ||
    request.enroll?.inv ||
    record.registration === undefined ||
    !request.relayerFallback
  ) {
    return null;
  }
  try {
    return deps.getTopicIdFn(request.device.id) || null;
  } catch (error) {
    logger.debug(`Secure topic storage is unavailable: ${(error as Error).message}`);
    return UNKNOWN_HELD_TOPIC;
  }
}

/**
 * noteV2Reply records relay v2 for the FF1 after a reply that verified under
 * the pinned profile arrived over v2 (an enroll's only when it succeeded):
 * the FF1 itself answered there, which is what a status listing relayV2
 * stands for. A newcomer paired off the LAN after legacy retirement, or a
 * CLI whose topic died before it saw such a status, has no other way to
 * learn it, and without it its commands would never try v2 (v2Allowed).
 */
function noteV2Reply(
  request: SecureRequest,
  record: ControllerRecord,
  outcome: SecureOutcome,
  deps: ResolvedDeps
): void {
  if (outcome.kind !== 'reply' || (request.op === 'enroll' && !outcome.reply.ok)) {
    return;
  }
  if (record.relayV2 === true) {
    return;
  }
  record.relayV2 = true;
  try {
    recordRelayV2(request.device.id, true, deps.controllerStore);
  } catch (error) {
    logger.debug(`Could not record the FF1's relay transports: ${(error as Error).message}`);
  }
}

/** RELAYER_NO_DEVICE_SOCKET is ff-relayer's `/api/cast` error id for "no device on this topic". */
const RELAYER_NO_DEVICE_SOCKET = 1003;
/** ff-relayer's 410 error strings for a retired legacy route. */
const RELAYER_LEGACY_RETIRED = new Set(['legacy_controller_api_retired', 'legacy_api_retired']);

/**
 * heldTopicGone reports whether a topic cast failed with the relayer's own
 * answer that the topic leads nowhere: 1003 (no device socket on it), 410
 * (the legacy route is retired) or 404 (the legacy host is shut down: a
 * deleted workers.dev worker answers `404 error code: 1042`, while a live
 * relayer never 404s `/api/cast`). All are given over TLS before anything
 * reaches a device. Anything else (no answer, a timeout, a 5xx, a DNS
 * failure) is not evidence: someone able to cut this machine's internet or
 * spoof its DNS could force it. A legacy host whose zone is removed answers
 * NXDOMAIN and so is never read as gone; a CLI release with the legacy
 * relayer off covers that case.
 */
function heldTopicGone(outcome: SecureOutcome): boolean {
  if (outcome.kind !== 'failed' || outcome.relayerStatus === undefined) {
    return false;
  }
  if (outcome.relayerStatus === 404) {
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(outcome.details ?? '');
  } catch {
    return false;
  }
  const error = (body as { error?: unknown } | null)?.error;
  if (outcome.relayerStatus === 410) {
    return typeof error === 'string' && RELAYER_LEGACY_RETIRED.has(error);
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { id?: unknown }).id === RELAYER_NO_DEVICE_SOCKET
  );
}

/**
 * v2Allowed is the §10 route rule for relay v2. A command goes there on an
 * explicit endpoint or to an FF1 whose verified status advertised relayV2.
 * An enroll goes there only without `inv` and only when the profile was
 * pinned from an owner's verified §5.6 registration result (record.registration):
 * that result is sealed under `ps`, so the profile is the owner's verified view
 * of the FF1, and a stranger on the public device channel cannot answer under
 * it. Such an enroll is tried on v2 even before any status has advertised
 * relayV2, since a newcomer has never read one; an ambiguous outcome is safe
 * because enroll is idempotent (§5.3). A first-owner enroll with `inv` never
 * goes over v2 (the FF1 refuses it there, §5.1).
 */
function v2Allowed(request: SecureRequest, record: ControllerRecord, explicit: boolean): boolean {
  if (request.op === 'cmd') {
    return explicit || record.relayV2 === true;
  }
  return request.op === 'enroll' && !request.enroll?.inv && record.registration !== undefined;
}

/**
 * sendViaV2 carries one freshly sealed command on the relay v2 device channel
 * (§10). The relay client fans the first envelope out and accepts only a reply
 * that verifies under the pinned profile, so neither a stranger's reply nor a
 * receipt can answer it. It is not followed by a status probe: notifications
 * are not consumed here, and a probe would cost a ctr and a round trip.
 *
 * Failures keep the §14.4 split: RelayUndeliveredError (no chunk reached a
 * peer) is reported `unreachable` so the caller may use the legacy topic;
 * anything else may have run on the FF1 and is never resent.
 */
async function sendViaV2(
  request: SecureRequest,
  record: ControllerRecord,
  deps: ResolvedDeps,
  endpoint: string
): Promise<SecureOutcome> {
  let client: V2Client;
  try {
    client = deps.relayClientFn(endpoint, record.profile.dev);
  } catch (error) {
    return { kind: 'failed', unreachable: true, error: (error as Error).message };
  }
  // Outcomes by the reply object that produced them: two replies may verify
  // (an FF1 answering two copies), and only the one that settled the request
  // is the answer.
  const verified = new WeakMap<object, SecureOutcome>();
  try {
    const settled = await client.requestPrepared(
      async () => {
        const sealed = await sealNext(request, deps);
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
            verified.set(body, outcome);
            return true;
          },
        };
      },
      deps.v2TimeoutMs ?? v2Deadline(request)
    );
    return v2Answer(request, verified.get(settled)!);
  } catch (error) {
    return v2Failure(request, error as Error);
  } finally {
    client.close();
  }
}

/**
 * v2Answer passes a verified v2 reply through, except `replay` (§14.4): on v2
 * the same sealed bytes may have reached the FF1 twice (a fan-out plus a copy
 * to a late joiner), so a `replay` may answer the duplicate of a request that
 * ran. It is an unknown outcome and never moves the counter or resends.
 */
function v2Answer(request: SecureRequest, outcome: SecureOutcome): SecureOutcome {
  if (outcome.kind === 'reply' && !outcome.reply.ok && outcome.reply.code === 'replay') {
    return v2Failure(
      request,
      new RelayAmbiguousError('the FF1 answered replay; it may have received this request twice')
    );
  }
  return outcome;
}

/** v2Deadline gives a large command time to cross the relay's byte ceiling. */
function v2Deadline(request: SecureRequest): number {
  const size = JSON.stringify(request.req ?? {}).length;
  return V2_TIMEOUT_MS + (size > 32768 ? Math.ceil(size / 24000) * 1000 : 0);
}

/** v2Failure maps a typed relay error to an outcome (§10, §14.4). */
function v2Failure(request: SecureRequest, error: Error): SecureOutcome {
  if (error instanceof RelayUndeliveredError) {
    logger.debug(`Relay v2 did not deliver the command: ${error.message}`);
    return {
      kind: 'failed',
      unreachable: true,
      error: 'The FF1 relay did not deliver the command',
      details: error.message,
      transport: 'relayer',
    };
  }
  const label = request.device.name || request.device.id;
  return {
    kind: 'failed',
    error: `Outcome unknown: the relay result from "${label}" was lost (${error.message})`,
    details:
      'The FF1 may already have run it, so ff-cli did not send it again. Check the FF1, then run the command again if it did not take effect.',
    transport: 'relayer',
  };
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
  let relayer: FF1RelayerSettings;
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
    return {
      kind: 'failed',
      error: result.error!,
      details: result.details,
      transport: 'relayer',
      ...(result.status !== undefined ? { relayerStatus: result.status } : {}),
    };
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
