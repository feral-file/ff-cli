/**
 * Pins which DP-1 schema the structure-only `validate` path applies. dp1-js
 * 2.8.0 picks it from the fields a playlist carries, and ff-cli relies on that:
 * `validate`, `sign`, `verify`, `display` and `publish` all parse through it.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validatePlaylist } from '../src/utilities/playlist-verifier';

const base = {
  dpVersion: '1.1.0',
  id: '385f79b6-a45f-4c1c-8080-e93a192adccc',
  title: 'Fields',
  created: '2026-01-01T00:00:00Z',
  items: [
    {
      id: '385f79b6-a45f-4c1c-8080-e93a192adccd',
      source: 'https://example.com/a',
      duration: 10,
    },
  ],
};

describe('validatePlaylist schema selection', () => {
  test('accepts a dynamic playlist with no static items', async () => {
    const result = await validatePlaylist({
      ...base,
      items: [],
      dynamicQuery: {
        profile: 'https-json-v1',
        endpoint: 'https://example.com/q',
        responseMapping: { itemsPath: 'data.items', itemSchema: 'dp1/1.1' },
      },
    });
    assert.equal(result.valid, true, JSON.stringify(result.details));
  });

  test('rejects an empty items list without dynamicQuery', async () => {
    const result = await validatePlaylist({ ...base, items: [] });
    assert.equal(result.valid, false);
  });

  test('rejects a malformed playlists extension field', async () => {
    const result = await validatePlaylist({ ...base, note: 5 });
    assert.equal(result.valid, false);
    assert.ok(result.details?.some((detail) => detail.path === '/note'));
  });
});
