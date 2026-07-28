import { defaultDeadlineFetch } from './http';
import type { Playlist } from '../types';

export interface RelayerCastResult {
  success: boolean;
  response?: Record<string, unknown>;
  error?: string;
  details?: string;
}

function nestedOk(value: unknown): boolean | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ok === 'boolean') {
    return record.ok;
  }
  return nestedOk(record.message);
}

/**
 * sendPlaylistViaRelayer sends a display command through the mobile-compatible
 * FF1 relayer contract.
 *
 * The result preserves the relayer's HTTP failure status before interpreting
 * any response body. Successful responses must contain JSON when non-empty;
 * non-2xx responses may use plain text or HTML without obscuring the original
 * gateway failure.
 *
 * @param input - Relayer endpoint, optional compatibility key, paired topic,
 * playlist, and optional fetch implementation.
 * @returns A structured result for handled request failures, HTTP statuses,
 * and JSON parsing errors.
 */
export async function sendPlaylistViaRelayer(input: {
  baseUrl: string;
  apiKey?: string;
  topicId: string;
  playlist: Playlist;
  fetchFn?: typeof fetch;
}): Promise<RelayerCastResult> {
  // Production default rides the shared deadline (#101 review).
  const fetchFn = input.fetchFn ?? defaultDeadlineFetch;
  let url: URL;
  try {
    url = new URL('/api/cast', input.baseUrl);
  } catch {
    return {
      success: false,
      error: 'Invalid FF1 relayer configuration',
      details: 'ff1Relayer.baseUrl must be a valid HTTP(S) URL',
    };
  }
  url.searchParams.set('topicID', input.topicId);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.apiKey) {
    headers['API-KEY'] = input.apiKey;
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      // The relayer accepts GET or POST with the same body. Node's standards-
      // compliant fetch rejects GET bodies, so CLI uses POST while preserving
      // the mobile request shape and topic query parameter.
      method: 'POST',
      headers,
      body: JSON.stringify({
        command: 'displayPlaylist',
        request: {
          dp1_call: input.playlist,
          intent: { action: 'now_display' },
        },
      }),
    });
  } catch (error) {
    return {
      success: false,
      error: 'Could not reach the FF1 relayer',
      details: (error as Error).message,
    };
  }

  const bodyText = (await response.text()).trim();
  // HTTP status is authoritative for gateway failures. Parse only successful
  // responses so an HTML/plain-text 401 cannot hide the actionable missing-key
  // diagnosis behind a secondary JSON parsing error.
  if (!response.ok) {
    const needsCompatibilityKey = response.status === 401 && !input.apiKey;
    return {
      success: false,
      error: `FF1 relayer returned HTTP ${response.status}`,
      details: needsCompatibilityKey
        ? 'This relayer deployment still requires its optional FF1_RELAYER_API_KEY compatibility gate.'
        : bodyText || response.statusText,
    };
  }

  let data: Record<string, unknown> = {};
  if (bodyText) {
    try {
      data = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return {
        success: false,
        error: `FF1 relayer returned non-JSON HTTP ${response.status}`,
        details: bodyText.slice(0, 200),
      };
    }
  }
  if (nestedOk(data) === false) {
    return {
      success: false,
      error: 'FF1 rejected the relayer display command',
      details: bodyText,
    };
  }
  return { success: true, response: data };
}
