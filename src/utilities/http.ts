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
  const signals: AbortSignal[] = [deadline];
  if (init.signal) {
    signals.push(init.signal);
  } else if (input instanceof Request && input.signal) {
    // A Request input carries its own abort signal; passing only the
    // deadline in init would silently REPLACE it (init wins over the
    // request's signal in fetch), stripping the caller's cancellation.
    signals.push(input.signal);
  }
  const signal = signals.length > 1 ? AbortSignal.any(signals) : deadline;
  return fetch(input, { ...init, signal });
}

/**
 * Drop-in `fetch` for production defaults of injectable-fetch modules:
 * identical signature, deadline attached. Modules that accept a `fetchFn`
 * override default to this instead of bare `globalThis.fetch`, so tests
 * keep full injection control while production can never hang.
 */
export const defaultDeadlineFetch: typeof fetch = (
  input: string | URL | Request,
  init?: RequestInit
) => fetchWithTimeout(input, init ?? {});
