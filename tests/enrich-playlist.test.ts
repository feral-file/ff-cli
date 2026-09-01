/**
 * Unit tests for the playlist enrichment mapping.
 *
 * The token lookup is injected, so nothing here touches the FF indexer. That
 * is deliberate and not merely convenient: a suite that reaches a live service
 * fails for reasons unrelated to the code under test, and the release pipeline
 * runs this suite (see the hermetic fix in find-command.test.ts).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  enrichPlaylistManifests,
  type Dp1Playlist,
  type IndexerResult,
  type TokenCoordinate,
} from '../src/utilities/enrich-playlist';

const MANIFEST = {
  refVersion: '1.1.0',
  id: 'ref-abc',
  created: '2026-09-01T00:00:00Z',
  locale: 'en',
  metadata: {
    title: 'Pre-Process',
    artists: [{ name: 'Casey Reas', id: '' }],
    thumbnails: { default: { uri: 'https://example.com/thumb.png' } },
  },
};

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    title: 'Pre-Process',
    source: 'https://generator.example/1',
    duration: 300,
    provenance: {
      type: 'onChain',
      contract: { chain: 'evm', standard: 'erc721', address: '0xabc', tokenId: '1' },
    },
    ...overrides,
  };
}

function playlistOf(...items: Record<string, unknown>[]): Dp1Playlist {
  return { dpVersion: '1.1.0', title: 'Test', items } as Dp1Playlist;
}

/** hit resolves every coordinate to MANIFEST and records what it was asked. */
function hit(seen: TokenCoordinate[][] = []) {
  return async (tokens: TokenCoordinate[]): Promise<IndexerResult[]> => {
    seen.push(tokens);
    // A resolved token comes back as the DP-1 item itself, not a wrapper.
    return tokens.map(() => ({ title: 'Pre-Process', inlineManifest: MANIFEST }));
  };
}

describe('enrichPlaylistManifests', () => {
  test('attaches a manifest to an item that has none', async () => {
    const playlist = playlistOf(item());
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.enriched, 1);
    assert.deepEqual(playlist.items?.[0].inlineManifest, MANIFEST);
    assert.equal(result.skipped.length, 0);
  });

  test('leaves source, duration, title and id untouched', async () => {
    const playlist = playlistOf(item());
    const before = JSON.parse(JSON.stringify(playlist.items?.[0]));
    await enrichPlaylistManifests(playlist, hit());
    const after = playlist.items?.[0] ?? {};
    for (const field of ['id', 'title', 'source', 'duration'] as const) {
      assert.deepEqual(after[field], before[field], `${field} must not change`);
    }
  });

  test('skips an item that already carries a manifest', async () => {
    const existing = { ...MANIFEST, id: 'ref-hand-written' };
    const playlist = playlistOf(item({ inlineManifest: existing }));
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.enriched, 0);
    assert.deepEqual(playlist.items?.[0].inlineManifest, existing);
    assert.equal(result.skipped[0].reason, 'already-labelled');
  });

  test('--force replaces an existing manifest', async () => {
    const playlist = playlistOf(item({ inlineManifest: { id: 'stale' } }));
    const result = await enrichPlaylistManifests(playlist, hit(), { force: true });
    assert.equal(result.enriched, 1);
    assert.deepEqual(playlist.items?.[0].inlineManifest, MANIFEST);
  });

  test('skips an item with no provenance rather than guessing', async () => {
    const playlist = playlistOf(item({ provenance: undefined }));
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.enriched, 0);
    assert.equal(result.skipped[0].reason, 'no-provenance');
    assert.equal(playlist.items?.[0].inlineManifest, undefined);
  });

  test('a contract with no tokenId identifies a collection, not a work', async () => {
    const playlist = playlistOf(
      item({ provenance: { contract: { chain: 'evm', address: '0xabc' } } })
    );
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.skipped[0].reason, 'no-provenance');
  });

  test('reports an unresolvable item and carries the indexer error', async () => {
    const playlist = playlistOf(item());
    const miss = async (): Promise<IndexerResult[]> => [
      { success: false, error: 'Token not found in indexer' },
    ];
    const result = await enrichPlaylistManifests(playlist, miss);
    assert.equal(result.enriched, 0);
    assert.equal(result.skipped[0].reason, 'not-indexed');
    assert.equal(result.skipped[0].detail, 'Token not found in indexer');
    assert.equal(playlist.items?.[0].inlineManifest, undefined);
  });

  test('results map back positionally across a mixed playlist', async () => {
    const playlist = playlistOf(
      item({ id: 'a', title: 'A' }),
      item({ id: 'b', title: 'B', provenance: undefined }),
      item({ id: 'c', title: 'C' })
    );
    const lookup = async (tokens: TokenCoordinate[]): Promise<IndexerResult[]> =>
      tokens.map((token) =>
        token.tokenId === '1'
          ? { inlineManifest: MANIFEST }
          : { success: false as const, error: 'nope' }
      );
    const result = await enrichPlaylistManifests(playlist, lookup);
    assert.equal(result.enriched, 2);
    assert.deepEqual(playlist.items?.[0].inlineManifest, MANIFEST);
    assert.equal(playlist.items?.[1].inlineManifest, undefined);
    assert.deepEqual(playlist.items?.[2].inlineManifest, MANIFEST);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].title, 'B');
  });

  test("translates the DP-1 chain name into the indexer's", async () => {
    const seen: TokenCoordinate[][] = [];
    // DP-1 core §6 names the EVM family "evm"; the indexer calls it "ethereum".
    const playlist = playlistOf(item());
    await enrichPlaylistManifests(playlist, hit(seen));
    assert.equal(seen[0][0].chain, 'ethereum');
  });

  test('passes an unaliased chain through untranslated', async () => {
    const seen: TokenCoordinate[][] = [];
    const playlist = playlistOf(
      item({ provenance: { contract: { chain: 'tezos', address: 'KT1abc', tokenId: '7' } } })
    );
    await enrichPlaylistManifests(playlist, hit(seen));
    assert.equal(seen[0][0].chain, 'tezos');
  });

  test('looks every unresolved item up in one batch', async () => {
    const seen: TokenCoordinate[][] = [];
    const playlist = playlistOf(item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' }));
    await enrichPlaylistManifests(playlist, hit(seen));
    assert.equal(seen.length, 1, 'one call, not one per item');
    assert.equal(seen[0].length, 3);
  });

  test('an item the indexer resolves without a manifest is not enriched', async () => {
    const playlist = playlistOf(item());
    const bare = async (): Promise<IndexerResult[]> => [{ title: '923 EMPTY ROOMS #0' }];
    const result = await enrichPlaylistManifests(playlist, bare);
    assert.equal(result.enriched, 0);
    assert.equal(result.skipped[0].reason, 'not-indexed');
  });

  test('drops the signature when the document changed', async () => {
    const playlist = playlistOf(item());
    playlist.signatures = [{ alg: 'ed25519' }];
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.signatureInvalidated, true);
    assert.equal(playlist.signatures, undefined);
  });

  test('keeps the signature when nothing changed', async () => {
    const signatures = [{ alg: 'ed25519' }];
    const playlist = playlistOf(item({ inlineManifest: MANIFEST }));
    playlist.signatures = signatures;
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.signatureInvalidated, false);
    assert.deepEqual(playlist.signatures, signatures);
  });

  test('does not call the indexer when there is nothing to resolve', async () => {
    const playlist = playlistOf(item({ inlineManifest: MANIFEST }));
    let called = false;
    await enrichPlaylistManifests(playlist, async () => {
      called = true;
      return [];
    });
    assert.equal(called, false);
  });

  test('tolerates a playlist whose items array is absent', async () => {
    const playlist = { dpVersion: '1.1.0' } as Dp1Playlist;
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.enriched, 0);
    assert.equal(result.skipped.length, 0);
  });
});
