/**
 * User-facing messages for FF1 control protocol v1 failures.
 *
 * Codes come from three places and are mapped here in one table so the three
 * device commands and `device pair` tell the user the same thing:
 * - public errors (§4.4): LAN HTTP 401/403 `{"error":{"code"}}`, or the
 *   relayer RPC `message`;
 * - encrypted reply codes (§4.3), only after the reply verified against the
 *   pinned devSig;
 * - local conditions (no controller file, reply failed verification).
 *
 * A public error is unauthenticated (anyone on the path can forge one), so
 * the advice it triggers is never destructive: it tells the user what to run,
 * it never deletes keys on its own.
 */

/** ControlFailure is a mapped failure ready for a command result. */
export interface ControlFailure {
  code: string;
  error: string;
  details?: string;
}

/** PAIRING_CODES are the codes whose fix is `ff-cli device pair` + owner approval. */
const PAIRING_CODES = new Set([
  'enrollment_required',
  'envelope_required',
  'unknown_controller',
  'access_revoked',
  'not_approved',
  'pending',
]);

/**
 * pairCommand renders the pair command for a device label.
 *
 * @param label - Device name or ID
 * @returns Shell-ready command text
 */
export function pairCommand(label: string): string {
  return `ff-cli device pair ${shellArg(label)}`;
}

/**
 * unpairCommand renders the unpair command for a device label.
 *
 * @param label - Device name or ID
 * @returns Shell-ready command text
 */
export function unpairCommand(label: string): string {
  return `ff-cli device unpair ${shellArg(label)}`;
}

function shellArg(label: string): string {
  return /[\s"'$`\\]/.test(label) ? JSON.stringify(label) : label;
}

const HEADLINES: Record<string, string> = {
  enrollment_required: 'This FF1 is secured and only accepts requests from paired controllers.',
  envelope_required: 'This FF1 is secured and only accepts requests from paired controllers.',
  unknown_controller: 'This FF1 does not know this ff-cli controller.',
  access_revoked: "This ff-cli controller's access to the FF1 was revoked or has expired.",
  not_approved: 'This ff-cli controller has not been approved on the FF1.',
  pending: 'This ff-cli controller is still waiting for approval.',
  permission_denied: 'This command needs owner access, and ff-cli is paired as a controller.',
  bad_envelope: 'The FF1 could not open the request.',
  bad_signature: 'The FF1 rejected the request signature.',
  locked: 'The FF1 control store is locked (its identity or grants could not be read).',
  rate_limited: 'The FF1 is rate-limiting requests.',
  busy: 'The FF1 is busy; try again.',
  expired: 'The FF1 rejected the request as expired.',
  replay: 'The FF1 rejected the request counter as already used.',
  invalid_request: 'The FF1 rejected the request as malformed.',
  internal_error:
    'The FF1 could not confirm it recorded the request; a command was not run, but a pairing or controller change may have been applied.',
  invitation_invalid: 'The FF1 rejected the invitation.',
  command_failed: 'The FF1 ran the command, but it failed.',
};

/**
 * describeControlCode maps a protocol code to an actionable message.
 *
 * @param code - Public or encrypted error code
 * @param deviceLabel - Device name used in commands
 * @returns The message and follow-up details
 */
export function describeControlCode(code: string, deviceLabel: string): ControlFailure {
  const headline = HEADLINES[code] ?? `The FF1 refused the request (${code}).`;
  const pair = pairCommand(deviceLabel);
  if (PAIRING_CODES.has(code)) {
    return {
      code,
      error: headline,
      details: `Run \`${pair}\` and approve the request in the Feral File app on an owner's phone.`,
    };
  }
  return { code, error: headline, details: followUp(code, pair) };
}

/** followUp returns the next step for codes that are not fixed by pairing. */
function followUp(code: string, pair: string): string | undefined {
  switch (code) {
    case 'permission_denied':
      return 'Ask an owner to give this controller the owner role in the Feral File app (Controllers), or run the command from an owner device.';
    case 'bad_envelope':
    case 'bad_signature':
      // Public errors are unauthenticated: anyone on the path can send one
      // (or the address now reaches another FF1), so the advice never
      // deletes keys: a new pairing keeps the current ones until approved.
      return `Check that the device address still reaches this FF1. If it was factory reset, run \`${pair}\`; the current keys are kept until the new pairing is approved. Do not unpair.`;
    case 'locked':
      return 'The FF1 needs attention: restart it, and if the problem stays, factory reset it from the Feral File app.';
    case 'rate_limited':
    case 'internal_error':
      return 'Wait a few seconds and try again.';
    case 'expired':
      return "Check that this computer's clock is correct, then try again.";
    case 'replay':
      return `If this keeps happening, the controller file was restored from an old copy: run \`${pair}\`; the current keys are kept until the new pairing is approved.`;
    case 'invalid_request':
      return 'Check that the clocks of this computer and the FF1 are correct (the FF1 refuses a request dated more than 5 minutes ahead of its clock). If they are, this is an ff-cli bug; please report it with `ff-cli --version`.';
    default:
      return undefined;
  }
}

/**
 * unverifiedReplyFailure is the message for a reply that failed §4.2 checks.
 * It is not retried and not trusted at all: on the relayer it may be a forged
 * "first reply wins" answer.
 *
 * @param reason - Verification failure reason
 * @returns The failure
 */
export function unverifiedReplyFailure(reason: string, deviceLabel?: string): ControlFailure {
  const pair = deviceLabel ? pairCommand(deviceLabel) : 'ff-cli device pair <name>';
  return {
    code: 'invalid_reply',
    error: 'The reply did not verify against the paired FF1 identity and was discarded.',
    details: `${reason}. Check that the device address still reaches this FF1. If it was factory reset, run \`${pair}\`; the current keys are kept until the new pairing is approved. Do not unpair.`,
  };
}
