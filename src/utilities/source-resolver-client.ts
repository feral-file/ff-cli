/**
 * Transport to ff-source-resolver-service, the one service that talks to
 * Raster and the marketplaces for Feral File's clients (owner decision,
 * 2026-11-18). ff-cli keeps no lookup code of its own for them: `find` asks
 * the service which work a link names and which tokens a series holds, and
 * the opt-in Raster token source reads Raster's records through it.
 * Raster's API key lives only in the service.
 *
 * Auth: ff-cli carries its own named client key (the service's
 * CLIENT_API_KEYS), sent as the `API-KEY` header. The key ships inside the
 * public npm package; that is accepted. It exists for attribution and so it
 * can be rotated without touching other clients, not as a secret. It is never
 * committed: the release workflow writes it into src/generated/ (gitignored)
 * before compiling, see scripts/write-source-resolver-key.js. Local builds and
 * tests carry an empty key, and FF_SOURCE_RESOLVER_API_KEY overrides either.
 *
 * Errors are split by what a caller can still do. A service that cannot be
 * reached, times out, fails (5xx, including 502 UPSTREAM_UNAVAILABLE), or
 * refuses this client throws SourceResolverUnavailableError: a caller that
 * holds token coordinates or a wallet address degrades instead of failing,
 * because the token source can still build from those alone. Any other 4xx is
 * a plain Error carrying the service's message, since it means the input is
 * wrong and retrying without the service would not make it right.
 */

import * as logger from '../logger';
import { fetchWithTimeout } from './http';
import { USER_AGENT } from './user-agent';

/** DEFAULT_SOURCE_RESOLVER_URL is the production service. SOURCE_RESOLVER_URL overrides it. */
export const DEFAULT_SOURCE_RESOLVER_URL =
  'https://ff-source-resolver-service.feral-file.workers.dev';

/**
 * LOOKUP_TIMEOUT_MS bounds one lookup round trip. Every lookup route has a
 * 30 s budget inside the service; the extra seconds cover the network so a
 * slow but answering service is not cut off just before it replies.
 */
const LOOKUP_TIMEOUT_MS = 35_000;

/**
 * TOKENS_TIMEOUT_MS bounds `GET /tokens`, which is not a lookup route: it
 * resolves the page and then polls the indexer for unseen tokens (a 45 s
 * budget of its own), so a cold collection legitimately takes longer than
 * any lookup.
 */
export const TOKENS_TIMEOUT_MS = 90_000;

/**
 * UNAUTHORIZED_MESSAGE is how the service refuses a missing or wrong key:
 * 400 INVALID_INPUT with this message, not a 401. It is matched exactly so a
 * real input error is never mistaken for a refusal.
 */
const UNAUTHORIZED_MESSAGE = 'Unauthorized.';

/** HTTP statuses with which a gateway in front of the service refuses a request. */
const REFUSAL_STATUSES = new Set([401, 403, 429]);

/**
 * SourceResolverUnavailableError means the service cannot serve this run:
 * unreachable, timed out, failing, or refusing this client's key. The request
 * itself was fine, so callers holding coordinates or an address degrade.
 */
export class SourceResolverUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceResolverUnavailableError';
  }
}

/**
 * isSourceResolverUnavailable reports whether an error is the one case in
 * which `find` continues without the service instead of failing.
 *
 * @param error - Any thrown value
 * @returns true for SourceResolverUnavailableError
 */
export function isSourceResolverUnavailable(error: unknown): boolean {
  return error instanceof SourceResolverUnavailableError;
}

/** ServiceErrorBody is the service's error envelope (lookup routes add `kind`). */
interface ServiceErrorBody {
  kind?: string;
  code?: string;
  message?: string;
}

/**
 * sourceResolverUrl returns the service origin, without a trailing slash.
 *
 * @returns SOURCE_RESOLVER_URL when set, else the production service
 */
export function sourceResolverUrl(): string {
  const configured = process.env.SOURCE_RESOLVER_URL?.trim();
  return (configured || DEFAULT_SOURCE_RESOLVER_URL).replace(/\/+$/, '');
}

/**
 * bakedClientKey returns the key the release build wrote, or ''.
 *
 * The generated module exists only in a release build (and locally after
 * running the generator), so it is required at run time inside a try: a
 * static import would make every local build and test depend on a file git
 * does not carry.
 */
function bakedClientKey(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const generated = require('../generated/source-resolver-key') as {
      SOURCE_RESOLVER_CLIENT_KEY?: unknown;
    };
    return typeof generated.SOURCE_RESOLVER_CLIENT_KEY === 'string'
      ? generated.SOURCE_RESOLVER_CLIENT_KEY
      : '';
  } catch {
    return '';
  }
}

/**
 * sourceResolverKey returns the client key to send, or '' for none.
 *
 * @returns FF_SOURCE_RESOLVER_API_KEY when set, else the baked release key
 */
export function sourceResolverKey(): string {
  const override = process.env.FF_SOURCE_RESOLVER_API_KEY?.trim();
  return override || bakedClientKey();
}

/** ServiceRequest describes one call: a GET with a query, or a POST with a JSON body. */
export interface ServiceRequest {
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Deadline for this call; LOOKUP_TIMEOUT_MS when omitted. */
  timeoutMs?: number;
}

/**
 * requestUrl joins the origin, path, and the query parameters that are set.
 *
 * @param request - The call to make
 * @returns The absolute URL
 */
function requestUrl(request: ServiceRequest): string {
  const url = new URL(`${sourceResolverUrl()}${request.path}`);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(name, String(value));
    }
  }
  return url.toString();
}

/**
 * requestHeaders builds the headers every call carries.
 *
 * @param hasBody - true when a JSON body is sent
 * @returns Headers with the client key when there is one
 */
function requestHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  const key = sourceResolverKey();
  if (key) {
    headers['API-KEY'] = key;
  }
  return headers;
}

/**
 * networkDetail names the real cause of a fetch or body-read failure.
 * Undici's "fetch failed" carries no cause in its message.
 *
 * @param error - The rejection
 * @returns The most specific message available
 */
function networkDetail(error: unknown): string {
  const cause = (error as { cause?: { message?: string } }).cause;
  return cause?.message ?? (error as Error).message;
}

/**
 * readJson reads a response body as JSON.
 *
 * A body that stalls or ends mid-stream rejects here, after fetch() already
 * resolved, so the failure is still reported as unavailability: otherwise a
 * caller could not perform the degrade it promises.
 *
 * @param response - The response
 * @param url - The request URL, for the message
 * @returns The parsed body
 * @throws SourceResolverUnavailableError when the body cannot be read or parsed
 */
async function readJson(response: Response, url: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new SourceResolverUnavailableError(
      `Feral File source resolver unreachable (${url}): response body failed: ${networkDetail(error)}`
    );
  }
}

/**
 * failureFor turns a non-2xx response into the error a caller acts on.
 *
 * @param status - HTTP status
 * @param body - The parsed error envelope, when there was one
 * @returns SourceResolverUnavailableError for refusals and service failures,
 *   Error for an input the service rejected
 */
function failureFor(status: number, body: ServiceErrorBody | null): Error {
  const code = body?.code ?? '';
  const message = body?.message ?? '';
  const described = `Feral File source resolver ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
  if (message === UNAUTHORIZED_MESSAGE || REFUSAL_STATUSES.has(status)) {
    return new SourceResolverUnavailableError(`${described} (it refused this ff-cli's key)`);
  }
  if (status >= 500) {
    return new SourceResolverUnavailableError(described);
  }
  return new Error(described);
}

/** ServiceResponse is a 2xx body with the headers it came with. */
export interface ServiceResponse<T> {
  body: T | null;
  headers: Headers | null;
}

/**
 * serviceRequest makes one call and returns the parsed 2xx body.
 *
 * `notFoundAsNull` lets a route whose 404 is an answer (an unknown series)
 * say so without an exception; everywhere else a 404 is an input error.
 *
 * @param request - The call to make
 * @param options - `notFoundAsNull` for routes whose 404 means "no such thing"
 * @returns The parsed body, or null for a 404 when asked
 * @throws SourceResolverUnavailableError or Error, see failureFor
 */
export async function serviceRequest<T>(
  request: ServiceRequest,
  options: { notFoundAsNull?: boolean } = {}
): Promise<T | null> {
  return (await serviceResponse<T>(request, options)).body;
}

/**
 * serviceResponse makes one call and returns the parsed 2xx body with its
 * response headers, for a route that says something outside the body:
 * `/tokens` reports the tokens a partial playlist still leaves out in
 * `X-Tokens-Pending`, which sits outside the signed playlist on purpose.
 *
 * @param request - The call to make
 * @param options - `notFoundAsNull` for routes whose 404 means "no such thing"
 * @returns The parsed body and headers; body and headers are null for a 404
 *   when asked
 * @throws SourceResolverUnavailableError or Error, see failureFor
 */
export async function serviceResponse<T>(
  request: ServiceRequest,
  options: { notFoundAsNull?: boolean } = {}
): Promise<ServiceResponse<T>> {
  const url = requestUrl(request);
  const hasBody = request.body !== undefined;
  logger.debug(`[source-resolver] ${hasBody ? 'POST' : 'GET'} ${url}`);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: hasBody ? 'POST' : 'GET',
        headers: requestHeaders(hasBody),
        body: hasBody ? JSON.stringify(request.body) : undefined,
      },
      request.timeoutMs ?? LOOKUP_TIMEOUT_MS
    );
  } catch (error) {
    throw new SourceResolverUnavailableError(
      `Feral File source resolver unreachable (${url}): ${networkDetail(error)}`
    );
  }
  if (response.ok) {
    return { body: (await readJson(response, url)) as T, headers: response.headers };
  }
  if (response.status === 404 && options.notFoundAsNull) {
    return { body: null, headers: null };
  }
  throw failureFor(response.status, await readErrorEnvelope(response, url));
}

/**
 * readErrorEnvelope reads an error response's envelope.
 *
 * A body that stalls or ends mid-stream is unavailability before it is
 * anything else: a truncated 400 "Unauthorized." would otherwise be classed
 * by its status as an input error and skip the degrade. A body that arrives
 * whole but is not JSON is only missing context, and the status decides.
 *
 * @param response - The non-2xx response
 * @param url - The request URL, for the message
 * @returns The envelope, or null when the complete body is not JSON
 * @throws SourceResolverUnavailableError when the body cannot be read
 */
async function readErrorEnvelope(
  response: Response,
  url: string
): Promise<ServiceErrorBody | null> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new SourceResolverUnavailableError(
      `Feral File source resolver unreachable (${url}): response body failed: ${networkDetail(error)}`
    );
  }
  try {
    return JSON.parse(text) as ServiceErrorBody;
  } catch {
    return null;
  }
}
