/**
 * Tests for the Neort resolver behind `ff-cli find`.
 *
 * Neort is off-chain and ff-source-resolver-service does not cover it, so it
 * is the one marketplace ff-cli still reads directly. These tests stub
 * `global.fetch` with canned responses to lock in the response-shape
 * assumptions without hitting Neort's API.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveNeortArt } from '../src/utilities/neort-marketplace';

type FetchFn = typeof global.fetch;

/**
 * Build a fetch mock that routes by URL substring. Each entry maps a
 * substring to `{ status, body }`; the first matching entry wins.
 * Anything unmatched returns 500 so unintended call paths fail loudly.
 */
function mockFetchByUrl(routes: Array<{ match: string; status?: number; body: unknown }>): FetchFn {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const route of routes) {
      if (url.includes(route.match)) {
        return new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: `unmocked: ${url}` }), { status: 500 });
  }) as FetchFn;
}

async function withMockedFetch<T>(mock: FetchFn, run: () => Promise<T>): Promise<T> {
  const original = global.fetch;
  global.fetch = mock;
  try {
    return await run();
  } finally {
    global.fetch = original;
  }
}

describe('resolveNeortArt', () => {
  test('happy (video, resourceFileName populated): builds artPreview URL', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'api.neort.io',
        body: {
          id: 'ce3lvgkn70rlpj69ccc0',
          title: 'Multiple Dimension',
          description: 'desc',
          user: { id: 'u', name: 'miwa maroon' },
          thumbFileName: '',
          selectedThumbFileName: 'ce3lvgkn70rlpj69ccc0.jpg',
          resourceFileName: 'ce3lvgkn70rlpj69ccc0.mp4',
          resourceType: 2,
          isPublic: true,
        },
      },
    ]);
    const art = await withMockedFetch(mock, () => resolveNeortArt('ce3lvgkn70rlpj69ccc0'));
    assert.equal(art.title, 'Multiple Dimension');
    assert.equal(art.artistName, 'miwa maroon');
    assert.equal(
      art.assetUrl,
      'https://d32h66pp7fue57.cloudfront.net/artPreview/ce3lvgkn70rlpj69ccc0.mp4'
    );
    assert.equal(
      art.thumbnailUrl,
      'https://d32h66pp7fue57.cloudfront.net/artThumb/ce3lvgkn70rlpj69ccc0.jpg'
    );
  });

  test('static image (empty resourceFileName, thumbFileName populated): falls back to thumb as asset', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'api.neort.io',
        body: {
          id: 'bjvbqlk3p9ff4349igig',
          title: 'Ocean',
          description: '',
          user: { id: 'u', name: 'JUST_ERROR' },
          thumbFileName: 'bjvbqlk3p9ff4349igig.png',
          selectedThumbFileName: '',
          resourceFileName: '',
          resourceType: 3,
          isPublic: true,
        },
      },
    ]);
    const art = await withMockedFetch(mock, () => resolveNeortArt('bjvbqlk3p9ff4349igig'));
    assert.equal(
      art.assetUrl,
      'https://d32h66pp7fue57.cloudfront.net/artThumb/bjvbqlk3p9ff4349igig.png'
    );
  });

  test('unknown id (Neort returns empty stub, not 404) → throws "no art found"', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'api.neort.io',
        body: {
          id: '',
          title: '',
          description: '',
          user: null,
          thumbFileName: '',
          selectedThumbFileName: '',
          resourceFileName: '',
          resourceType: 0,
          isPublic: false,
        },
      },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveNeortArt('definitely-not-real')),
      /no art found/
    );
  });

  test('private art → throws (do not include in playlists)', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'api.neort.io',
        body: {
          id: 'private123',
          title: 'Private Piece',
          description: '',
          user: { id: 'u', name: 'someone' },
          thumbFileName: 'private123.jpg',
          selectedThumbFileName: '',
          resourceFileName: 'private123.mp4',
          resourceType: 2,
          isPublic: false,
        },
      },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveNeortArt('private123')),
      /is not public/
    );
  });

  test('art with no displayable asset at all → throws', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'api.neort.io',
        body: {
          id: 'broken123',
          title: 'Broken',
          description: '',
          user: { id: 'u', name: 'x' },
          thumbFileName: '',
          selectedThumbFileName: '',
          resourceFileName: '',
          resourceType: 0,
          isPublic: true,
        },
      },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveNeortArt('broken123')),
      /no displayable asset/
    );
  });
});
