/**
 * `fetch_feed` → `buildDP1Playlist` path: item-level `created` must be dropped.
 *
 * The DP-1 v1.1.0 PlaylistItem schema has no `created` field — `created` is a
 * playlist-level timestamp only. Feed playlists can carry a legacy item-level
 * `created`, so `extractPlaylistItems` must strip it before the items reach
 * PlaylistBuilder, otherwise the built playlist carries a non-schema field.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractPlaylistItems } = require('../src/utilities/feed-fetcher.js');
const { buildDP1Playlist, validateDP1Playlist } = require('../src/utilities/playlist-builder.js');

/** A feed playlist whose items still carry a legacy item-level `created`. */
function feedPlaylistWithCreated() {
  return {
    id: 'feed-playlist-1',
    title: 'Feed Playlist',
    created: '2024-01-01T00:00:00.000Z',
    items: [
      {
        source: 'https://example.com/artwork-1.html',
        title: 'Artwork 1',
        duration: 300,
        created: '2024-02-02T00:00:00.000Z',
      },
      {
        source: 'https://example.com/artwork-2.html',
        title: 'Artwork 2',
        created: '2024-03-03T00:00:00.000Z',
      },
    ],
  };
}

describe('extractPlaylistItems drops item-level created', () => {
  test('strips `created` from every extracted feed item', () => {
    const items = extractPlaylistItems(feedPlaylistWithCreated(), 10, undefined, false);

    assert.equal(items.length, 2);
    for (const item of items) {
      assert.equal('created' in item, false, 'extracted item must not carry `created`');
    }
    // Other item fields are preserved.
    assert.equal(items[0].source, 'https://example.com/artwork-1.html');
    assert.equal(items[0].duration, 300);
    assert.equal(items[1].title, 'Artwork 2');
  });

  test('extracted feed items build a schema-valid DP-1 playlist', async () => {
    const items = extractPlaylistItems(feedPlaylistWithCreated(), 10, undefined, false);
    const playlist = await buildDP1Playlist({ items, title: 'From Feed' });

    // No item-level `created` survives into the built playlist.
    for (const item of playlist.items) {
      assert.equal('created' in item, false, 'built playlist item must not carry `created`');
    }

    const result = validateDP1Playlist(playlist);
    assert.equal(result.valid, true, `expected valid playlist, got: ${result.errors.join('; ')}`);
  });
});
