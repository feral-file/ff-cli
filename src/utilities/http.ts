/**
 * Shared fetch-with-timeout for every outbound HTTP call in the CLI.
 *
 * Bare `fetch` has no deadline: a stalled connect or an unanswered request
 * hangs the command silently — the failure mode agents can least diagnose,
 * and the one behind #97. Every resolver and indexer call goes through here
 * so "silent hang" is structurally impossible, not per-call-site discipline.
 *
 * Callers that pass their own `signal` keep it (composed with the deadline
 * via AbortSignal.any), so cancellation semantics are never silently
 * replaced by a timeout.
 */

export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

export function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(input, { ...init, signal });
}
