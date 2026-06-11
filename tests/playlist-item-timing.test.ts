/**
 * DP-1 §4.1 playback-timing conformance for item builders.
 *
 * `duration` is OPTIONAL in the DP-1 v1.1.0 schema (PlaylistItem requires only
 * `source`). Absence is meaningful: a time-based source (video/audio) with
 * `display.loop: false` and no duration MUST advance at end-of-stream — the
 * media plays its natural length. These tests pin the auto-timing contract:
 * omitted duration → video/audio items carry no duration and loop=false,
 * static items fall back to the configured default, and an explicit duration
 * always wins regardless of media type.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  applyItemTiming,
  isTimeBasedMedia,
  buildUrlItem,
  convertTokenToDP1ItemSingle,
  validateDP1Playlist,
  buildDP1Playlist,
} = require('../src/utilities/playlist-builder.js');
const nftIndexer = require('../src/utilities/nft-indexer');

/** Minimal token info in the standard format both converters consume. */
function tokenInfo(overrides: { mimeType?: string; animationUrl?: string } = {}) {
  return {
    success: true,
    token: {
      chain: 'ethereum',
      contractAddress: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
      tokenId: '1',
      standard: 'erc721',
      name: 'Chapter #1',
      image: {
        url: 'https://example.com/thumb.png',
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
});
