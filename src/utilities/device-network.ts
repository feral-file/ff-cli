/**
 * Network classification shared by the FF1 LAN delivery paths (legacy
 * plaintext casts in ff1-device.ts and the secure envelope transport in
 * control/secure-transport.ts), so both apply the same retry and relayer
 * fallback rules.
 */

/**
 * isTransientDeviceNetworkError returns true when a send failure is likely temporary.
 *
 * This classifier intentionally targets resolver and route-level failures that are
 * common on local mDNS/Wi-Fi environments. Permanent command errors should surface
 * immediately without retry loops.
 *
 * @param {unknown} error - Error thrown by fetch
 * @returns {boolean} True when retrying is likely to recover
 */
export function isTransientDeviceNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const networkCodes = new Set([
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNRESET',
  ]);

  const message = error.message || '';
  const messageLooksTransient =
    message.includes('fetch failed') ||
    message.includes('getaddrinfo') ||
    message.includes('EHOSTUNREACH') ||
    message.includes('ENOTFOUND') ||
    message.includes('ETIMEDOUT') ||
    message.includes('network timeout') ||
    message.includes('No route to host');

  if (messageLooksTransient) {
    return true;
  }

  const causeCode =
    error.cause &&
    typeof error.cause === 'object' &&
    'code' in error.cause &&
    typeof (error.cause as { code?: unknown }).code === 'string'
      ? (error.cause as { code: string }).code
      : undefined;

  return Boolean(causeCode && networkCodes.has(causeCode));
}

/**
 * parseRetryAfterMs converts an HTTP `Retry-After` header into milliseconds.
 *
 * Supports both forms from RFC 7231: a delta-seconds integer (e.g. "5") and an
 * HTTP-date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT"). Returns undefined when the
 * header is absent or unparseable, so callers can fall back to their own
 * backoff. A past date clamps to 0 (retry immediately).
 *
 * @param {string | null | undefined} headerValue - Raw Retry-After header value
 * @returns {number | undefined} Delay in milliseconds, or undefined if unknown
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // A valid HTTP-date always contains letters (month/day names, or the ISO
  // 'T'/'Z'). Requiring one rejects bare numeric junk (e.g. "-5", "5.5") that
  // Date.parse would otherwise misinterpret as a date.
  if (/[a-zA-Z]/.test(trimmed)) {
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }

  return undefined;
}
