/**
 * DP-1 §4.1 playback-timing conformance for item builders.
 *
 * `duration` is OPTIONAL in the DP-1 v1.1.0 schema (PlaylistItem requires only
 * `source`). Absence is meaningful: a time-based source (video/audio) with
 * `display.loop: false` and no duration MUST advance at end-of-stream — the
 * media plays its natural length. These tests pin the auto-timing contract:
 * omitted duration → video/audio items carry no duration and loop=false,
 * static items fall back to the configured default, generative/interactive
 * (HTML) works carry the configured `generativeDuration` (default 60, or
 * omitted when set to 0), and an explicit duration always wins regardless of
 * media type.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  applyItemTiming,
  isTimeBasedMedia,
  isInteractiveWeb,
  detectMimeType,
  buildUrlItem,
  convertTokenToDP1ItemSingle,
  validateDP1Playlist,
  buildDP1Playlist,
} = require('../src/utilities/playlist-builder.js');
const nftIndexer = require('../src/utilities/nft-indexer');

/** Minimal token info in the standard format both converters consume. */
function tokenInfo(
  overrides: {
    mimeType?: string;
    animationUrl?: string;
    description?: string;
    artistName?: string;
    imageUrl?: string;
  } = {}
) {
  return {
    success: true,
    token: {
      chain: 'ethereum',
      contractAddress: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
      tokenId: '1',
      standard: 'erc721',
      name: 'Chapter #1',
      description: overrides.description,
      metadata: { artistName: overrides.artistName },
      image: {
        url: overrides.imageUrl ?? 'https://example.com/thumb.png',
        mimeType: overrides.mimeType ?? 'image/png',
        thumbnail: '',
      },
      animation_url: overrides.animationUrl,
    },
  };
}

describe('isTimeBasedMedia', () => {
  test('detects video and audio by MIME type', () => {
    assert.equal(isTimeBasedMedia('video/mp4', 'https://example.com/a'), true);
    assert.equal(isTimeBasedMedia('audio/mpeg', 'https://example.com/a'), true);
    assert.equal(isTimeBasedMedia('image/png', 'https://example.com/a.png'), false);
  });

  test('falls back to URL extension when MIME is missing or defaulted', () => {
    assert.equal(isTimeBasedMedia(undefined, 'https://example.com/clip.mp4'), true);
    // Upstream defaults missing mime_type to image/png; the extension must still win.
    assert.equal(isTimeBasedMedia('image/png', 'https://example.com/clip.webm?x=1'), true);
    assert.equal(isTimeBasedMedia(undefined, 'https://example.com/page.html'), false);
  });
});

describe('applyItemTiming', () => {
  test('explicit duration wins for any media type', () => {
    const item: Record<string, unknown> = {};
    applyItemTiming(item, { mimeType: 'video/mp4', sourceUrl: 'https://e.com/v.mp4' }, 25);
    assert.equal(item.duration, 25);
    assert.equal(item.display, undefined);
  });

  test('auto + video: no duration, display.loop=false (end-of-stream advance)', () => {
    const item: Record<string, unknown> = { display: { scaling: 'fit' } };
    applyItemTiming(item, { mimeType: 'video/mp4', sourceUrl: 'https://e.com/v.mp4' });
    assert.equal('duration' in item, false);
    assert.deepEqual(item.display, { scaling: 'fit', loop: false });
  });

  test('auto + static: configured default duration is stamped', () => {
    const item: Record<string, unknown> = {};
    applyItemTiming(item, { mimeType: 'image/png', sourceUrl: 'https://e.com/i.png' });
    assert.equal(typeof item.duration, 'number');
    assert.ok((item.duration as number) >= 1);
  });

  test('auto + interactive HTML: carries the generative duration (drives rotation)', () => {
    const item: Record<string, unknown> = { display: { scaling: 'fit' } };
    applyItemTiming(item, { mimeType: 'text/html', sourceUrl: 'https://e.com/art' });
    assert.equal(typeof item.duration, 'number');
    assert.ok((item.duration as number) >= 1);
    // Unlike video, no loop:false — an HTML page has no end-of-stream event.
    assert.deepEqual(item.display, { scaling: 'fit' });
  });

  test('auto + interactive HTML by .html extension: carries the generative duration', () => {
    const item: Record<string, unknown> = {};
    applyItemTiming(item, { sourceUrl: 'https://e.com/page.html' });
    assert.equal(typeof item.duration, 'number');
    assert.ok((item.duration as number) >= 1);
  });

  test('generativeDuration config controls the stamped value', () => {
    const prev = process.env.DEFAULT_GENERATIVE_DURATION;
    process.env.DEFAULT_GENERATIVE_DURATION = '75';
    try {
      const item: Record<string, unknown> = {};
      applyItemTiming(item, { mimeType: 'text/html', sourceUrl: 'https://e.com/art' });
      assert.equal(item.duration, 75);
    } finally {
      if (prev === undefined) {
        delete process.env.DEFAULT_GENERATIVE_DURATION;
      } else {
        process.env.DEFAULT_GENERATIVE_DURATION = prev;
      }
    }
  });

  test('generativeDuration=0 omits duration (open-ended escape hatch)', () => {
    const prev = process.env.DEFAULT_GENERATIVE_DURATION;
    process.env.DEFAULT_GENERATIVE_DURATION = '0';
    try {
      const item: Record<string, unknown> = { display: { scaling: 'fit' } };
      applyItemTiming(item, { mimeType: 'text/html', sourceUrl: 'https://e.com/art' });
      assert.equal('duration' in item, false);
      assert.deepEqual(item.display, { scaling: 'fit' });
    } finally {
      if (prev === undefined) {
        delete process.env.DEFAULT_GENERATIVE_DURATION;
      } else {
        process.env.DEFAULT_GENERATIVE_DURATION = prev;
      }
    }
  });
});

describe('detectMimeType / isInteractiveWeb', () => {
  test('detectMimeType maps .html/.htm to text/html', () => {
    assert.equal(detectMimeType('https://e.com/art.html'), 'text/html');
    assert.equal(detectMimeType('https://e.com/art.htm'), 'text/html');
  });

  test('detectMimeType returns empty string for unknown/extensionless URLs', () => {
    assert.equal(detectMimeType('https://e.com/output/abc123'), '');
    assert.equal(detectMimeType('https://whorl.app'), '');
    assert.equal(detectMimeType(''), '');
  });

  test('detectMimeType ignores query strings and fragments (extension from pathname)', () => {
    // A dot inside ?sig=a.b or #v=1 must not be mistaken for the extension.
    assert.equal(detectMimeType('https://e.com/art.png?sig=a.b'), 'image/png');
    assert.equal(detectMimeType('https://e.com/art.png#v=1'), 'image/png');
    assert.equal(detectMimeType('https://e.com/v.mp4?X-Amz-Credential=a.b'), 'video/mp4');
    assert.equal(detectMimeType('https://e.com/v.mp4#t=1'), 'video/mp4');
  });

  test('isInteractiveWeb detects HTML by MIME hint or extension, not media', () => {
    assert.equal(isInteractiveWeb('text/html', 'https://e.com/x'), true);
    assert.equal(isInteractiveWeb(undefined, 'https://e.com/page.html'), true);
    assert.equal(isInteractiveWeb('video/mp4', 'https://e.com/v.mp4'), false);
    assert.equal(isInteractiveWeb('image/png', 'https://e.com/i.png'), false);
  });
});

describe('item builders honor auto timing', () => {
  test('buildUrlItem: video URL gets no duration and loop=false', () => {
    const item = buildUrlItem('https://example.com/chapter-1.mp4');
    assert.equal('duration' in item, false);
    assert.equal(item.display.loop, false);
  });

  test('buildUrlItem: static URL keeps a numeric duration', () => {
    const item = buildUrlItem('https://example.com/art.png');
    assert.equal(typeof item.duration, 'number');
    assert.equal(item.display.loop, undefined);
  });

  test('buildUrlItem: signed image URL (dotted query) still gets a numeric duration', () => {
    // Regression: a `.png?sig=a.b` URL must not be mistaken for an interactive
    // web page and lose its static-image duration.
    const item = buildUrlItem('https://example.com/art.png?sig=a.b');
    assert.equal(typeof item.duration, 'number');
    assert.equal(item.display.loop, undefined);
  });

  test('buildUrlItem: signed video URL (dotted query) stays time-based (no duration)', () => {
    const item = buildUrlItem('https://example.com/clip.mp4?X-Amz-Credential=a.b');
    assert.equal('duration' in item, false);
    assert.equal(item.display.loop, false);
  });

  test('buildUrlItem: .html URL carries the generative duration', () => {
    const item = buildUrlItem('https://whorl.app/index_launch.html');
    assert.equal(typeof item.duration, 'number');
    assert.ok(item.duration >= 1);
    assert.equal(item.display.loop, undefined);
  });

  test('buildUrlItem: extensionless URL is treated as interactive web (generative duration)', () => {
    const item = buildUrlItem('https://whorl.app/output/abc123');
    assert.equal(typeof item.duration, 'number');
    assert.ok(item.duration >= 1);
  });

  test('buildUrlItem: explicit duration still wins for an HTML page', () => {
    const item = buildUrlItem('https://whorl.app/index_launch.html', 30);
    assert.equal(item.duration, 30);
  });

  test('buildUrlItem: explicit duration is stamped as-is on video', () => {
    const item = buildUrlItem('https://example.com/chapter-1.mp4', 30);
    assert.equal(item.duration, 30);
  });

  test('convertTokenToDP1ItemSingle: video token (indexer MIME) → natural length', () => {
    const item = convertTokenToDP1ItemSingle(
      tokenInfo({ mimeType: 'video/mp4', animationUrl: 'https://example.com/chapter-1.mp4' })
    );
    assert.equal('duration' in item, false);
    assert.equal(item.display.loop, false);
  });

  test('convertTokenToDP1ItemSingle: static token keeps default duration', () => {
    const item = convertTokenToDP1ItemSingle(tokenInfo());
    assert.equal(typeof item.duration, 'number');
    assert.equal(item.display.loop, undefined);
  });

  test('convertTokenToDP1ItemSingle: a title-only token carries no inline manifest', () => {
    // Static token: image.url IS the source, so there is no distinct still and
    // nothing beyond the title. Thin tokens must stay thin — a manifest that
    // only repeats `title` costs payload on every FF1 transfer.
    const item = convertTokenToDP1ItemSingle(tokenInfo());
    assert.equal(item.inlineManifest, undefined);
  });

  test('convertTokenToDP1ItemSingle: a dynamic item carries the still in both ref and the manifest', () => {
    // DP-1 Playlist Extension §3.6 makes `ref` and `inlineManifest`
    // complementary — resolution runs defaults → inlineManifest → ref →
    // item.local, so `ref` is authoritative and the inline copy is the
    // fallback. Emitting both preserves the poster frame FF1 builds read from
    // `ref` without withholding structured metadata from manifest-aware
    // players. Dropping either side is the regression this pins.
    const item = convertTokenToDP1ItemSingle(
      tokenInfo({
        mimeType: 'video/mp4',
        animationUrl: 'https://example.com/chapter-1.mp4',
        imageUrl: 'https://example.com/still.png',
      })
    );
    assert.equal(item.ref, 'https://example.com/still.png');
    assert.deepEqual(item.inlineManifest.metadata.thumbnails, {
      default: { uri: 'https://example.com/still.png' },
    });
  });

  test('nft-indexer convertToDP1Item: video token → natural length, explicit wins', () => {
    const video = tokenInfo({
      mimeType: 'video/mp4',
      animationUrl: 'https://example.com/chapter-1.mp4',
    });
    const auto = nftIndexer.convertToDP1Item(video);
    assert.equal(auto.success, true);
    assert.equal('duration' in auto.item, false);
    assert.equal(auto.item.display.loop, false);

    const explicit = nftIndexer.convertToDP1Item(video, 30);
    assert.equal(explicit.item.duration, 30);
  });
});

describe('playlist-level conformance', () => {
  test('validateDP1Playlist accepts items without duration (spec-optional)', () => {
    const result = validateDP1Playlist({
      dpVersion: '1.1.0',
      title: 'No-duration video',
      items: [
        {
          source: 'https://example.com/chapter-1.mp4',
          license: 'open',
          display: { loop: false },
        },
      ],
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  test('validateDP1Playlist rejects negative duration but allows 0', () => {
    const base = {
      dpVersion: '1.1.0',
      title: 'Durations',
      items: [{ source: 'https://example.com/a.png', license: 'open', duration: -1 }],
    };
    assert.equal(validateDP1Playlist(base).valid, false);
    base.items[0].duration = 0;
    assert.equal(validateDP1Playlist(base).valid, true);
  });

  test('buildDP1Playlist emits no defaults.duration (would time-cut no-duration items)', async () => {
    const playlist = await buildDP1Playlist({
      items: [buildUrlItem('https://example.com/chapter-1.mp4')],
      title: 'Natural length',
      slug: 'natural-length',
      deterministicMode: true,
      fixedTimestamp: '2026-06-01T12:00:00.000Z',
      fixedId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
    assert.equal('duration' in playlist.defaults, false);
  });

  test('buildUrlItem and buildDP1Playlist emit schema-valid DP-1 shapes', async () => {
    const { ValidatePlaylist } = require('dp1-js');
    const item = buildUrlItem('https://example.com/art.png');
    assert.equal(item.display.background, '#111111');
    assert.equal(item.created, undefined);
    assert.equal(item.provenance.type, 'offChainURI');
    assert.equal(item.provenance.uri, undefined);

    const playlist = await buildDP1Playlist({
      items: [item],
      title: 'Schema check',
      slug: 'schema-check',
      deterministicMode: true,
      fixedTimestamp: '2026-06-01T12:00:00.000Z',
      fixedId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
    assert.equal(playlist.defaults.display.background, '#111111');
    assert.doesNotThrow(() => ValidatePlaylist(playlist, { requireSignatures: false }));
  });

  test('NFT converters emit schema-valid on-chain items without deprecated fields', () => {
    const { ValidatePlaylistItem } = require('dp1-js');
    const fromBuilder = convertTokenToDP1ItemSingle(tokenInfo());
    assert.equal(fromBuilder.created, undefined);
    assert.equal(fromBuilder.display.background, '#111111');
    assert.equal(fromBuilder.provenance.type, 'onChain');
    assert.doesNotThrow(() => ValidatePlaylistItem(fromBuilder));

    const fromIndexer = nftIndexer.convertToDP1Item(tokenInfo());
    assert.equal(fromIndexer.success, true);
    assert.equal(fromIndexer.item.created, undefined);
    assert.equal(fromIndexer.item.display.background, '#111111');
    assert.doesNotThrow(() => ValidatePlaylistItem(fromIndexer.item));
  });

  test('both converters emit schema-valid items when an inline manifest is present', () => {
    // The manifest is a nested document with its own schema, so it needs its
    // own validation pass on both converter paths — an item that validates
    // without one proves nothing about one that carries it.
    const { ValidatePlaylistItem } = require('dp1-js');
    const rich = tokenInfo({
      description: 'An essay in motion.',
      artistName: 'Larva Labs',
      animationUrl: 'https://example.com/chapter-1.mp4',
      mimeType: 'video/mp4',
      imageUrl: 'https://example.com/still.png',
    });

    const fromBuilder = convertTokenToDP1ItemSingle(rich);
    assert.equal(fromBuilder.inlineManifest.metadata.description, 'An essay in motion.');
    assert.doesNotThrow(() => ValidatePlaylistItem(fromBuilder));

    const fromIndexer = nftIndexer.convertToDP1Item(rich);
    assert.equal(fromIndexer.success, true);
    assert.deepEqual(fromIndexer.item.inlineManifest.metadata.artists, [{ name: 'Larva Labs' }]);
    assert.doesNotThrow(() => ValidatePlaylistItem(fromIndexer.item));
  });

  test('buildDP1Playlist validates a playlist whose items carry inline manifests', async () => {
    const { ValidatePlaylist } = require('dp1-js');
    const item = convertTokenToDP1ItemSingle(
      tokenInfo({ description: 'An essay in motion.', artistName: 'Larva Labs' })
    );
    const playlist = await buildDP1Playlist({
      items: [item],
      title: 'Manifest check',
      slug: 'manifest-check',
      deterministicMode: true,
      fixedTimestamp: '2026-06-01T12:00:00.000Z',
      fixedId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
    assert.equal(playlist.items[0].inlineManifest.refVersion, '1.1.0');
    assert.doesNotThrow(() => ValidatePlaylist(playlist, { requireSignatures: false }));
  });

  test('validateDP1Playlist maps AJV failures to path: message strings', () => {
    const result = validateDP1Playlist({
      dpVersion: '1.1.0',
      title: 'Bad duration',
      items: [{ source: 'https://example.com/a.png', license: 'open', duration: -1 }],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 1);
    assert.match(result.errors[0], /: /);
  });
});
