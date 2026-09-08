/**
 * Deletes a playlist from a DP-1 feed.
 *
 * `curl -X DELETE` alone answers `401`: the feed has no API key, and a delete is authorized by a signed
 * **delete-intent** in the request body (dp1-feed-v2 `docs/api_design.md`, "DELETE — owner-bound, signed
 * delete-intent"). The intent must name the stored `id` and `slug` exactly, carry a `created` inside the
 * server's freshness window, and be signed by a key the stored playlist names as an owner.
 *
 * The delete is permanent in a stronger sense than most: it tombstones the id, and a later create naming
 * that id is refused. There is no undo, which is why the command layer confirms before calling this.
 */

import axios from 'axios';
import {
  buildDeleteIntent,
  describeFeedMutationError,
  fetchStoredPlaylist,
  intentTimestamp,
  mutationSignerIdentity,
  ownershipPreflight,
  resolvePlaylistIdentifier,
  signIntent,
  storedOwnerKeys,
  type KeySource,
  type StoredPlaylist,
} from './feed-mutation';

export interface UnpublishResult {
  success: boolean;
  playlistId?: string;
  slug?: string;
  title?: string;
  message?: string;
  error?: string;
  feedServer?: string;
}

export interface UnpublishOptions {
  /**
   * Exact signing key material to use. When the command resolved it already — which it does, so the
   * identity shown in the confirmation is the identity that signs — this is that same value, and no
   * config is read here. Omitted, the configured key is resolved instead.
   */
  privateKey?: string;
  /**
   * Where `privateKey` came from, so a refusal points at something the operator can change: the config
   * file, or the `--key` they just passed.
   */
  keySource?: KeySource;
}

/**
 * Look up a playlist on a feed without deleting it.
 *
 * Exposed so the command layer can show the operator what they are about to destroy — and so the
 * ownership refusal happens before any confirmation prompt, rather than after they have already said yes.
 */
export async function fetchPlaylistForUnpublish(
  idOrUrl: string,
  feedServerUrl: string
): Promise<StoredPlaylist> {
  return fetchStoredPlaylist(feedServerUrl, resolvePlaylistIdentifier(idOrUrl));
}

/**
 * Delete a playlist from a feed server.
 *
 * Flow:
 * 1. Resolve the id or URL the user supplied to a feed path segment.
 * 2. `GET` the stored playlist — the intent must carry the stored id and slug, and only the stored
 *    document says who owns it.
 * 3. Refuse locally when the signing key is not a stored owner.
 * 4. Build and sign the delete-intent in the `curator` role.
 * 5. `DELETE` with the intent as the body and report the outcome.
 *
 * @param idOrUrl - Playlist id, slug, or a feed URL ending in either
 * @param feedServerUrl - Feed server base URL, including `/api/v1`
 * @param options - Optional signing-key override
 * @returns Result carrying the deleted playlist's identity, or a diagnosis and a remedy
 * @example
 * const result = await unpublishPlaylist('9f...c1', 'https://feed.example.com/api/v1');
 * if (!result.success) console.error(result.error);
 */
export async function unpublishPlaylist(
  idOrUrl: string,
  feedServerUrl: string,
  options: UnpublishOptions = {}
): Promise<UnpublishResult> {
  const identifier = resolvePlaylistIdentifier(idOrUrl);
  if (!identifier) {
    return { success: false, error: 'No playlist id or URL was given' };
  }

  // Where the identity came from, resolved before the first request so every refusal — local or from
  // the feed — names the key the operator actually used rather than a config file this run may not
  // have read.
  const keySource: KeySource =
    options.keySource ?? (options.privateKey !== undefined ? 'supplied' : 'configured');

  // Resolve and validate together: `--key ""` is a failed override, not an absent one, and must never
  // fall through to the configured key on an operation that tombstones an id.
  let privateKey: string;
  let signerDidKey: string;
  try {
    ({ privateKey, didKey: signerDidKey } = mutationSignerIdentity(options.privateKey, 'delete'));
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  let stored: StoredPlaylist;
  try {
    stored = await fetchStoredPlaylist(feedServerUrl, identifier);
  } catch (error) {
    return {
      success: false,
      ...describeFeedMutationError(error, 'delete', keySource),
      feedServer: feedServerUrl,
    };
  }

  const id = typeof stored.id === 'string' ? stored.id : '';
  const slug = typeof stored.slug === 'string' ? stored.slug : '';
  if (!id || !slug) {
    // Both are stored verbatim from the signed document, so a feed serving one without the other is
    // serving something this envelope cannot target. Failing here beats sending a body the feed will
    // reject as a target mismatch, which reads like the operator's mistake.
    return {
      success: false,
      error: 'The stored playlist is missing an id or slug, so a delete intent cannot target it.',
      feedServer: feedServerUrl,
    };
  }

  const refusal = await ownershipPreflight(stored, signerDidKey, 'delete', keySource);
  if (refusal) {
    return { success: false, ...refusal, feedServer: feedServerUrl };
  }

  const created = intentTimestamp();
  const intent = buildDeleteIntent(id, slug, created);

  let body: Record<string, unknown>;
  try {
    const signature = await signIntent(intent, privateKey);
    body = { ...intent, signatures: [signature] };
  } catch (error) {
    return {
      success: false,
      error: `Failed to sign the delete intent: ${(error as Error).message}`,
    };
  }

  try {
    // axios sends a body on DELETE only when `data` is given explicitly; the feed requires one.
    const response = await axios.delete(`${feedServerUrl}/playlists/${encodeURIComponent(id)}`, {
      data: body,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    if (response.status !== 204 && response.status !== 200) {
      return {
        success: false,
        error: `Unexpected response status: ${response.status}`,
        feedServer: feedServerUrl,
      };
    }

    return {
      success: true,
      playlistId: id,
      slug,
      title: typeof stored.title === 'string' ? stored.title : undefined,
      message: 'Deleted from feed server (the id is now tombstoned and cannot be reused)',
      feedServer: feedServerUrl,
    };
  } catch (error) {
    return {
      success: false,
      ...describeFeedMutationError(error, 'delete', keySource),
      feedServer: feedServerUrl,
    };
  }
}

/** Owner keys the stored playlist declares, re-exported so the command layer can show them. */
export { storedOwnerKeys };
