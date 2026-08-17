/**
 * Inline Ref Manifest construction (DP-1 Playlist Extension §3.6).
 *
 * These tests pin three things that are easy for a later agent to break:
 *
 *  1. The emission threshold. A manifest is only worth its bytes when it
 *     carries something a PlaylistItem cannot. `title` already has an item
 *     field, so a title-only manifest is duplication that costs payload on
 *     every FF1 transfer and every signed envelope.
 *  2. What is deliberately NOT mapped. `creditLine`, `tags`, `collection`,
 *     `owner`, `controls`, and `i18n` are absent on purpose — see the
 *     rationale comments in src/utilities/ref-manifest.ts. The assertions
 *     here exist to stop a future "enrichment" pass from laundering guessed
 *     data into a signed document.
 *  3. Determinism. `id` is content-derived and namespaced away from the
 *     PlaylistItem id; `created` is frozen per process so one build stamps
 *     one timestamp across every item in a playlist.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildInlineManifestForToken } = require('../src/utilities/ref-manifest');
const { ValidateRefManifest } = require('dp1-js');
const nftIndexer = require('../src/utilities/nft-indexer');

const SOURCE = 'https://example.com/chapter-1.mp4';
const STILL = 'https://example.com/still.png';

/** Token in the standard format both item factories consume. */
function token(overrides: Record<string, unknown> = {}) {
  return {
    chain: 'ethereum',
    contractAddress: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
    tokenId: '1',
    standard: 'erc721',
    name: 'Chapter #1',
    image: { url: SOURCE, mimeType: 'video/mp4', thumbnail: '' },
    ...overrides,
  };
}

describe('buildInlineManifestForToken threshold', () => {
  test('title alone never qualifies (the item already carries it)', () => {
    const manifest = buildInlineManifestForToken(token(), { sourceUrl: SOURCE });
    assert.equal(manifest, undefined);
  });

  test('a very long title still does not qualify', () => {
    const manifest = buildInlineManifestForToken(token({ name: 'A'.repeat(400) }), {
      sourceUrl: SOURCE,
    });
    assert.equal(manifest, undefined);
  });

  test('description qualifies', () => {
    const manifest = buildInlineManifestForToken(token({ description: 'An essay in motion.' }), {
      sourceUrl: SOURCE,
    });
    assert.equal(manifest?.metadata?.description, 'An essay in motion.');
    assert.equal(manifest?.metadata?.title, 'Chapter #1');
  });

  test('artist name qualifies', () => {
    const manifest = buildInlineManifestForToken(token({ metadata: { artistName: 'Ada' } }), {
      sourceUrl: SOURCE,
    });
    assert.deepEqual(manifest?.metadata?.artists, [{ name: 'Ada' }]);
  });

  test('a still image distinct from the source qualifies', () => {
    const manifest = buildInlineManifestForToken(
      token({ image: { url: SOURCE, thumbnail: STILL } }),
      { sourceUrl: SOURCE }
    );
    assert.deepEqual(manifest?.metadata?.thumbnails, { default: { uri: STILL } });
  });

  test('whitespace-only description does not qualify', () => {
    const manifest = buildInlineManifestForToken(token({ description: '   ' }), {
      sourceUrl: SOURCE,
    });
    assert.equal(manifest, undefined);
  });
});

describe('buildInlineManifestForToken thumbnail rules', () => {
  test('a still equal to the source is dropped (static tokens reuse image.url)', () => {
    const manifest = buildInlineManifestForToken(
      token({ image: { url: SOURCE, thumbnail: SOURCE }, description: 'd' }),
      { sourceUrl: SOURCE }
    );
    assert.equal(manifest?.metadata?.thumbnails, undefined);
  });

  test('a data: URI still is dropped (payload bloat, and the factories reject them)', () => {
    const manifest = buildInlineManifestForToken(
      token({ image: { url: SOURCE, thumbnail: 'data:image/png;base64,AAAA' }, description: 'd' }),
      { sourceUrl: SOURCE }
    );
    assert.equal(manifest?.metadata?.thumbnails, undefined);
  });

  test('a non-http still is dropped', () => {
    const manifest = buildInlineManifestForToken(
      token({ image: { url: SOURCE, thumbnail: 'ipfs://Qm123' }, description: 'd' }),
      { sourceUrl: SOURCE }
    );
    assert.equal(manifest?.metadata?.thumbnails, undefined);
  });

  test('the emitted thumbnail is exactly { uri } — no w/h keys', () => {
    const manifest = buildInlineManifestForToken(
      token({ image: { url: SOURCE, thumbnail: STILL } }),
      { sourceUrl: SOURCE }
    );
    const thumb = manifest.metadata.thumbnails.default;
    assert.deepEqual(Object.keys(thumb), ['uri']);
    assert.equal(JSON.stringify(thumb), JSON.stringify({ uri: STILL }));
  });

  test('image given as a bare string is handled (playlist-builder token shape)', () => {
    const manifest = buildInlineManifestForToken(token({ image: STILL, description: 'd' }), {
      sourceUrl: SOURCE,
    });
    assert.deepEqual(manifest?.metadata?.thumbnails, { default: { uri: STILL } });
  });

  test('image.url is the fallback still when no thumbnail is present', () => {
    const manifest = buildInlineManifestForToken(
      token({ image: { url: STILL, thumbnail: '' }, description: 'd' }),
      { sourceUrl: SOURCE }
    );
    assert.deepEqual(manifest?.metadata?.thumbnails, { default: { uri: STILL } });
  });
});

describe('buildInlineManifestForToken deliberate omissions', () => {
  test('collection, owner, and attributes never reach the manifest', () => {
    const manifest = buildInlineManifestForToken(
      token({
        description: 'An essay in motion.',
        metadata: { artistName: 'Ada', attributes: [{ trait_type: 'Hat', value: 'Blue' }] },
        collection: { name: 'Chapter', description: 'A series' },
        owner: '0x1111111111111111111111111111111111111111',
      }),
      { sourceUrl: SOURCE }
    );
    assert.equal(manifest.metadata.creditLine, undefined);
    assert.equal(manifest.metadata.tags, undefined);
    assert.equal(manifest.controls, undefined);
    assert.equal(manifest.i18n, undefined);
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes('0x1111111111111111111111111111111111111111'), false);
    assert.equal(serialized.includes('A series'), false);
  });
});

describe('buildInlineManifestForToken required fields', () => {
  test('refVersion, locale, created, and id are set explicitly', () => {
    const manifest = buildInlineManifestForToken(token({ description: 'd' }), {
      sourceUrl: SOURCE,
    });
    // The builder falls back to refVersion 0.1.0 when unset; the CLI emits
    // dpVersion 1.1.0 envelopes, so the manifest must match.
    assert.equal(manifest.refVersion, '1.1.0');
    assert.equal(manifest.locale, 'en');
    assert.match(manifest.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.match(manifest.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('the result passes the dp1-js ref-manifest schema', () => {
    const manifest = buildInlineManifestForToken(
      token({ description: 'd', metadata: { artistName: 'Ada' }, image: { thumbnail: STILL } }),
      { sourceUrl: SOURCE }
    );
    assert.doesNotThrow(() => ValidateRefManifest(manifest));
  });
});

describe('buildInlineManifestForToken determinism', () => {
  test('the same token yields the same id across calls', () => {
    const a = buildInlineManifestForToken(token({ description: 'd' }), { sourceUrl: SOURCE });
    const b = buildInlineManifestForToken(token({ description: 'd' }), { sourceUrl: SOURCE });
    assert.equal(a.id, b.id);
  });

  test('a different tokenId yields a different id', () => {
    const a = buildInlineManifestForToken(token({ description: 'd' }), { sourceUrl: SOURCE });
    const b = buildInlineManifestForToken(token({ tokenId: '2', description: 'd' }), {
      sourceUrl: SOURCE,
    });
    assert.notEqual(a.id, b.id);
  });

  test('the manifest id never collides with the PlaylistItem id for the same token', () => {
    // convertToDP1Item derives the item id from the bare `${contract}-${tokenId}`
    // string. A consumer keying a manifest cache must not alias a playlist-item
    // cache, so the manifest seed is namespaced.
    const t = token({ description: 'd' });
    const manifest = buildInlineManifestForToken(t, { sourceUrl: SOURCE });
    const converted = nftIndexer.convertToDP1Item({ success: true, token: t });
    assert.equal(converted.success, true);
    assert.notEqual(manifest.id, converted.item.id);
  });

  test('a token without contract coordinates falls back to the source URL', () => {
    const a = buildInlineManifestForToken(
      { name: 'X', description: 'd', image: { url: SOURCE } },
      { sourceUrl: SOURCE }
    );
    const b = buildInlineManifestForToken(
      { name: 'Y', description: 'e', image: { url: SOURCE } },
      { sourceUrl: SOURCE }
    );
    assert.equal(a.id, b.id);
  });

  test('created is stable across calls in one process, and overridable', () => {
    const a = buildInlineManifestForToken(token({ description: 'd' }), { sourceUrl: SOURCE });
    const b = buildInlineManifestForToken(token({ description: 'e' }), { sourceUrl: SOURCE });
    assert.equal(a.created, b.created);

    const pinned = buildInlineManifestForToken(token({ description: 'd' }), {
      sourceUrl: SOURCE,
      created: '2026-06-01T12:00:00.000Z',
    });
    assert.equal(pinned.created, '2026-06-01T12:00:00.000Z');
  });
});

describe('buildInlineManifestForToken resilience', () => {
  test('a token that cannot produce a valid manifest returns undefined, never throws', () => {
    // A description long enough to break a schema bound must degrade to "no
    // manifest", not to a skipped item: nft-indexer turns a builder throw into
    // { success: false }, which the build pipeline counts as a dropped token.
    assert.doesNotThrow(() => {
      const manifest = buildInlineManifestForToken(token({ description: 'd'.repeat(200000) }), {
        sourceUrl: SOURCE,
      });
      if (manifest !== undefined) {
        assert.doesNotThrow(() => ValidateRefManifest(manifest));
      }
    });
  });

  test('a null token returns undefined', () => {
    assert.equal(buildInlineManifestForToken(null, { sourceUrl: SOURCE }), undefined);
  });

  test('a missing opts.sourceUrl does not throw', () => {
    assert.doesNotThrow(() => buildInlineManifestForToken(token({ description: 'd' }), {}));
  });
});
