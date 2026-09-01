/**
 * Unit tests for the playlist enrichment mapping.
 *
 * The token lookup is injected, so nothing here touches the FF indexer. That
 * is deliberate and not merely convenient: a suite that reaches a live service
 * fails for reasons unrelated to the code under test, and the release pipeline
 * runs this suite (see the hermetic fix in find-command.test.ts).
 *
 * The fakes below mimic the real contract exactly: `getNFTTokenInfoBatch`
 * FILTERS unresolved tokens out of its return rather than representing them,
 * so a fake that answers one entry per input would hide the correlation bug
 * these tests exist to prevent.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  enrichPlaylistManifests,
  type Dp1Playlist,
  type IndexerItem,
  type TokenCoordinate,
} from '../src/utilities/enrich-playlist';

function manifestNamed(title: string, artist: string) {
  return {
    refVersion: '1.1.0',
    id: `ref-${artist.toLowerCase().replace(/\s+/g, '-')}`,
    created: '2026-09-01T00:00:00Z',
    locale: 'en',
    metadata: {
      title,
      artists: [{ name: artist, id: '' }],
      thumbnails: { default: { uri: `https://example.com/${title}.png` } },
    },
  };
}

const MANIFEST = manifestNamed('Pre-Process #0', 'Casey REAS');

function provenance(address = '0xabc', tokenId = '1', chain = 'evm') {
  return { type: 'onChain', contract: { chain, standard: 'erc721', address, tokenId } };
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    title: 'Pre-Process',
    source: 'https://generator.example/1',
    duration: 300,
    provenance: provenance(),
    ...overrides,
  };
}

function playlistOf(...items: Record<string, unknown>[]): Dp1Playlist {
  return { dpVersion: '1.1.0', title: 'Test', items } as Dp1Playlist;
}

/**
 * indexerReturning answers only the coordinates it is told to resolve, echoing
 * provenance the way the indexer does — checksummed address, DP-1 chain name —
 * and omitting everything else, exactly as the production filter does.
 */
function indexerReturning(
  resolvable: Record<string, { manifest: unknown; address?: string }>,
  seen: TokenCoordinate[][] = []
) {
  return async (tokens: TokenCoordinate[]): Promise<IndexerItem[]> => {
    seen.push(tokens);
    return tokens
      .filter((token) => resolvable[token.tokenId])
      .map((token) => {
        const entry = resolvable[token.tokenId];
        return {
          title: 'from indexer',
          provenance: provenance(entry.address ?? token.contractAddress, token.tokenId, 'evm'),
          inlineManifest: entry.manifest,
        } as IndexerItem;
      });
  };
}

/** hit resolves every coordinate handed to it. */
function hit(seen: TokenCoordinate[][] = []) {
  return async (tokens: TokenCoordinate[]): Promise<IndexerItem[]> => {
    seen.push(tokens);
    return tokens.map((token) => ({
      provenance: provenance(token.contractAddress, token.tokenId, 'evm'),
      inlineManifest: MANIFEST,
    }));
  };
}

describe('enrichPlaylistManifests', () => {
  test('attaches a manifest to an item that has none', async () => {
    const playlist = playlistOf(item());
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.enriched, 1);
    assert.equal(result.skipped.length, 0);
    const metadata = playlist.items?.[0].inlineManifest?.metadata as Record<string, unknown>;
    assert.deepEqual(metadata.artists, MANIFEST.metadata.artists);
    assert.deepEqual(metadata.thumbnails, MANIFEST.metadata.thumbnails);
  });

  test('leaves source, duration and id untouched', async () => {
    const playlist = playlistOf(item());
    const before = JSON.parse(JSON.stringify(playlist.items?.[0]));
    await enrichPlaylistManifests(playlist, hit());
    const after = playlist.items?.[0] ?? {};
    for (const field of ['id', 'title', 'source', 'duration'] as const) {
      assert.deepEqual(after[field], before[field], `${field} must not change`);
    }
  });

  // F3: the tombstone reads the manifest before item.title, so an indexer
  // title would change the displayed label while item.title looked preserved.
  test("keeps the curator's title as the manifest title", async () => {
    const playlist = playlistOf(item({ title: 'Pre-Process' }));
    await enrichPlaylistManifests(playlist, hit());
    const metadata = playlist.items?.[0].inlineManifest?.metadata as Record<string, unknown>;
    assert.equal(metadata.title, 'Pre-Process', 'indexer title must not win');
  });

  test('uses the indexer title when the item has none', async () => {
    const playlist = playlistOf(item({ title: '' }));
    await enrichPlaylistManifests(playlist, hit());
    const metadata = playlist.items?.[0].inlineManifest?.metadata as Record<string, unknown>;
    assert.equal(metadata.title, 'Pre-Process #0');
  });

  test('does not mutate the manifest object the lookup returned', async () => {
    const playlist = playlistOf(item({ title: 'Curator Title' }));
    await enrichPlaylistManifests(playlist, hit());
    assert.equal(MANIFEST.metadata.title, 'Pre-Process #0', 'shared object was mutated');
  });

  // F1: the production lookup drops unresolved tokens, so results are neither
  // aligned nor complete. Correlation must be by coordinate.
  test('does not attach a manifest to the wrong item when a lookup fails', async () => {
    const playlist = playlistOf(
      item({ id: 'a', title: 'A', provenance: provenance('0xaaa', '1') }),
      item({ id: 'b', title: 'B', provenance: provenance('0xbbb', '2') })
    );
    // Only B resolves; the array comes back with one entry, not two.
    const lookup = indexerReturning({ '2': { manifest: manifestNamed('B work', 'Artist B') } });
    const result = await enrichPlaylistManifests(playlist, lookup);
    assert.equal(result.enriched, 1);
    assert.equal(playlist.items?.[0].inlineManifest, undefined, 'A must stay unlabelled');
    const bMeta = playlist.items?.[1].inlineManifest?.metadata as Record<string, unknown>;
    assert.deepEqual(bMeta.artists, [{ name: 'Artist B', id: '' }]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].title, 'A');
    assert.equal(result.skipped[0].reason, 'not-indexed');
  });

  test('correlates correctly when results come back out of order', async () => {
    const playlist = playlistOf(
      item({ id: 'a', title: 'A', provenance: provenance('0xaaa', '1') }),
      item({ id: 'b', title: 'B', provenance: provenance('0xbbb', '2') })
    );
    const lookup = async (tokens: TokenCoordinate[]): Promise<IndexerItem[]> =>
      [...tokens].reverse().map((token) => ({
        provenance: provenance(token.contractAddress, token.tokenId, 'evm'),
        inlineManifest: manifestNamed(`work ${token.tokenId}`, `Artist ${token.tokenId}`),
      }));
    await enrichPlaylistManifests(playlist, lookup);
    const a = playlist.items?.[0].inlineManifest?.metadata as Record<string, unknown>;
    const b = playlist.items?.[1].inlineManifest?.metadata as Record<string, unknown>;
    assert.deepEqual(a.artists, [{ name: 'Artist 1', id: '' }]);
    assert.deepEqual(b.artists, [{ name: 'Artist 2', id: '' }]);
  });

  test('matches a checksummed address against a lowercase one', async () => {
    const playlist = playlistOf(
      item({ provenance: provenance('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', '1') })
    );
    const lookup = indexerReturning({
      '1': { manifest: MANIFEST, address: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD' },
    });
    const result = await enrichPlaylistManifests(playlist, lookup);
    assert.equal(result.enriched, 1);
  });

  test('drops a response that carries no usable provenance', async () => {
    const playlist = playlistOf(item());
    const lookup = async (): Promise<IndexerItem[]> => [{ inlineManifest: MANIFEST }];
    const result = await enrichPlaylistManifests(playlist, lookup);
    assert.equal(result.enriched, 0);
    assert.equal(result.skipped[0].reason, 'not-indexed');
  });

  // F1: ref outranks inlineManifest at the device, so enriching a ref-backed
  // item writes a manifest nothing reads while still voiding the signature.
  test('treats an item with an external ref as already labelled', async () => {
    const playlist = playlistOf(item({ ref: 'https://example.com/manifest.json' }));
    playlist.signatures = [{ alg: 'ed25519' }];
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.enriched, 0);
    assert.equal(result.skipped[0].reason, 'external-ref');
    assert.equal(playlist.items?.[0].inlineManifest, undefined);
    assert.deepEqual(playlist.signatures, [{ alg: 'ed25519' }], 'signature must survive');
  });

  test('--force does not convert a ref-backed item', async () => {
    const playlist = playlistOf(
      item({ ref: 'https://example.com/manifest.json', refHash: 'sha256:abc' })
    );
    const result = await enrichPlaylistManifests(playlist, hit(), { force: true });
    assert.equal(result.enriched, 0);
    assert.equal(result.skipped[0].reason, 'external-ref');
    assert.equal(playlist.items?.[0].ref, 'https://example.com/manifest.json');
    assert.equal(playlist.items?.[0].refHash, 'sha256:abc');
  });

  test('an empty ref string does not count as a reference', async () => {
    const playlist = playlistOf(item({ ref: '   ' }));
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.enriched, 1);
  });

  // F3: a repeated work must not enqueue a separate indexing job per copy.
  test('looks a repeated coordinate up once and applies it to every copy', async () => {
    const seen: TokenCoordinate[][] = [];
    const playlist = playlistOf(
      item({ id: 'a', title: 'A', provenance: provenance('0xaaa', '1') }),
      item({ id: 'b', title: 'B', provenance: provenance('0xbbb', '2') }),
      item({ id: 'c', title: 'C', provenance: provenance('0xAAA', '1') })
    );
    const result = await enrichPlaylistManifests(playlist, hit(seen));
    assert.equal(seen[0].length, 2, 'the repeated coordinate must be looked up once');
    assert.equal(result.enriched, 3, 'every copy still gets the manifest');
    assert.ok(playlist.items?.[0].inlineManifest);
    assert.ok(playlist.items?.[2].inlineManifest);
  });

  test('skips an item that already carries a manifest', async () => {
    const existing = manifestNamed('hand written', 'Someone');
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
    const metadata = playlist.items?.[0].inlineManifest?.metadata as Record<string, unknown>;
    assert.deepEqual(metadata.artists, MANIFEST.metadata.artists);
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

  test("translates the DP-1 chain name into the indexer's", async () => {
    const seen: TokenCoordinate[][] = [];
    await enrichPlaylistManifests(playlistOf(item()), hit(seen));
    assert.equal(seen[0][0].chain, 'ethereum');
  });

  test('passes an unaliased chain through untranslated', async () => {
    const seen: TokenCoordinate[][] = [];
    const playlist = playlistOf(item({ provenance: provenance('KT1abc', '7', 'tezos') }));
    await enrichPlaylistManifests(playlist, hit(seen));
    assert.equal(seen[0][0].chain, 'tezos');
  });

  test('looks every unresolved item up in one batch', async () => {
    const seen: TokenCoordinate[][] = [];
    const playlist = playlistOf(
      item({ id: 'a', provenance: provenance('0xaaa', '1') }),
      item({ id: 'b', provenance: provenance('0xbbb', '2') }),
      item({ id: 'c', provenance: provenance('0xccc', '3') })
    );
    await enrichPlaylistManifests(playlist, hit(seen));
    assert.equal(seen.length, 1, 'one call, not one per item');
    assert.equal(seen[0].length, 3);
  });

  test('drops the v1.1.0 signature envelope when the document changed', async () => {
    const playlist = playlistOf(item());
    playlist.signatures = [{ alg: 'ed25519' }];
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.signatureInvalidated, true);
    assert.equal(playlist.signatures, undefined);
  });

  // F2: verify and sign in this repo still read a legacy flat `signature`.
  test('drops the legacy flat signature when the document changed', async () => {
    const playlist = playlistOf(item());
    playlist.signature = 'ed25519:deadbeef';
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.signatureInvalidated, true);
    assert.equal(playlist.signature, undefined);
  });

  test('drops both signature forms together', async () => {
    const playlist = playlistOf(item());
    playlist.signature = 'ed25519:deadbeef';
    playlist.signatures = [{ alg: 'ed25519' }];
    await enrichPlaylistManifests(playlist, hit());
    assert.equal(playlist.signature, undefined);
    assert.equal(playlist.signatures, undefined);
  });

  test('keeps signatures when nothing changed', async () => {
    const signatures = [{ alg: 'ed25519' }];
    const playlist = playlistOf(item({ inlineManifest: MANIFEST }));
    playlist.signatures = signatures;
    playlist.signature = 'ed25519:deadbeef';
    const result = await enrichPlaylistManifests(playlist, hit());
    assert.equal(result.signatureInvalidated, false);
    assert.deepEqual(playlist.signatures, signatures);
    assert.equal(playlist.signature, 'ed25519:deadbeef');
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
