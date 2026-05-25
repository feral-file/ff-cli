/**
 * Tests for the async resolvers behind `ff-cli find`.
 *
 * Each marketplace resolver (and the Raster client) makes one or more HTTP
 * calls. These tests stub `global.fetch` with canned responses so we can
 * lock in the response-shape assumptions (field paths, error handling,
 * pagination, chain filtering) without hitting live APIs.
 *
 * Pattern (matches `tests/play-source.test.ts`):
 *   1. Save `global.fetch`
 *   2. Assign a mock returning canned Responses
 *   3. Run the resolver
 *   4. Restore `global.fetch` in finally
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveArtBlocksCollection } from '../src/utilities/ab-marketplace';
import { resolveObjktAlias } from '../src/utilities/objkt-marketplace';
import { resolveFxhashIteration, resolveFxhashProject } from '../src/utilities/fxhash-marketplace';
import { resolveNeortArt } from '../src/utilities/neort-marketplace';
import { resolveFeralFileToken } from '../src/utilities/ff-marketplace';
import { resolveTokenToArtwork, listArtworkTokens } from '../src/utilities/raster-client';

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

describe('resolveTokenToArtwork (Raster)', () => {
  test('200 → resolves to artworkId + title', async () => {
    const mock = mockFetchByUrl([
      {
        match: '/token/ethereum/0xabc/123',
        body: {
          id: 1,
          contract_address: '0xabc',
          token_id: '123',
          title: 'Token #123',
          artwork: {
            id: 42,
            title: 'Send/Receive',
            artists: [],
            is_edition: false,
            edition_size: 1,
          },
        },
      },
    ]);
    const result = await withMockedFetch(mock, () =>
      resolveTokenToArtwork('ethereum', '0xabc', '123')
    );
    assert.notEqual(result, null);
    assert.equal(result?.artworkId, 42);
    assert.equal(result?.artworkTitle, 'Send/Receive');
  });

  test('404 → returns null (caller falls back to single-token mode)', async () => {
    const mock = mockFetchByUrl([
      { match: '/token/', status: 404, body: { detail: 'Token not found' } },
    ]);
    const result = await withMockedFetch(mock, () =>
      resolveTokenToArtwork('ethereum', '0xabc', '123')
    );
    assert.equal(result, null);
  });

  test('500 → throws (non-404 errors propagate)', async () => {
    const mock = mockFetchByUrl([
      { match: '/token/', status: 500, body: { detail: 'internal error' } },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveTokenToArtwork('ethereum', '0xabc', '123')),
      /500/
    );
  });
});

describe('listArtworkTokens (Raster — pagination + chain filter)', () => {
  test('eth + tezos tokens pass through, unsupported chains counted in skippedUnsupported', async () => {
    const mock = mockFetchByUrl([
      {
        match: '/artwork/42/tokens',
        body: {
          tokens: [
            { chain_id: 'eip155:1', contract_address: 'eip155:1/0xeth', token_id: '1' },
            {
              chain_id: 'tezos:NetXdQprcVkpaWU',
              contract_address: 'tezos:NetXdQprcVkpaWU/KT1abc',
              token_id: '2',
            },
            { chain_id: 'eip155:137', contract_address: 'eip155:137/0xmatic', token_id: '3' },
            { chain_id: 'eip155:8453', contract_address: 'eip155:8453/0xbase', token_id: '4' },
          ],
          total_count: 4,
          cursor: 4,
        },
      },
    ]);
    const page = await withMockedFetch(mock, () => listArtworkTokens(42));
    assert.equal(page.tokens.length, 2);
    assert.equal(page.tokens[0].chain, 'ethereum');
    assert.equal(page.tokens[0].contractAddress, '0xeth');
    assert.equal(page.tokens[1].chain, 'tezos');
    assert.equal(page.tokens[1].contractAddress, 'KT1abc');
    assert.equal(page.skippedUnsupported, 2);
  });

  test('cursor === total_count → nextCursor null (end of stream)', async () => {
    const mock = mockFetchByUrl([
      {
        match: '/artwork/42/tokens',
        body: {
          tokens: [{ chain_id: 'eip155:1', contract_address: 'eip155:1/0xa', token_id: '1' }],
          total_count: 100,
          cursor: 100,
        },
      },
    ]);
    const page = await withMockedFetch(mock, () => listArtworkTokens(42));
    assert.equal(page.nextCursor, null);
  });

  test('cursor < total_count → nextCursor passes through for next page', async () => {
    const mock = mockFetchByUrl([
      {
        match: '/artwork/42/tokens',
        body: {
          tokens: [{ chain_id: 'eip155:1', contract_address: 'eip155:1/0xa', token_id: '1' }],
          total_count: 100,
          cursor: 50,
        },
      },
    ]);
    const page = await withMockedFetch(mock, () => listArtworkTokens(42));
    assert.equal(page.nextCursor, 50);
  });
});

describe('resolveArtBlocksCollection', () => {
  test('happy: slug → contract + first invocation tokenId', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'artblocks-mainnet.hasura.app',
        body: {
          data: {
            projects_metadata: [
              {
                contract_address: '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270',
                tokens: [{ token_id: '78000000' }],
              },
            ],
          },
        },
      },
    ]);
    const coords = await withMockedFetch(mock, () => resolveArtBlocksCollection('ringers'));
    assert.equal(coords.chain, 'ethereum');
    assert.equal(coords.contract, '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270');
    assert.equal(coords.tokenId, '78000000');
  });

  test('unknown slug → throws "no project found"', async () => {
    const mock = mockFetchByUrl([
      { match: 'artblocks-mainnet.hasura.app', body: { data: { projects_metadata: [] } } },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveArtBlocksCollection('does-not-exist')),
      /no project found/
    );
  });

  test('project with no minted tokens → throws "no minted tokens"', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'artblocks-mainnet.hasura.app',
        body: {
          data: {
            projects_metadata: [{ contract_address: '0xabc', tokens: [] }],
          },
        },
      },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveArtBlocksCollection('not-minted-yet')),
      /no minted tokens/
    );
  });

  test('GraphQL errors → throws with concatenated messages', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'artblocks-mainnet.hasura.app',
        body: { errors: [{ message: 'rate limited' }] },
      },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveArtBlocksCollection('ringers')),
      /rate limited/
    );
  });
});

describe('resolveObjktAlias', () => {
  test('happy: alias → KT1 contract', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'data.objkt.com',
        body: { data: { fa: [{ contract: 'KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton' }] } },
      },
    ]);
    const contract = await withMockedFetch(mock, () => resolveObjktAlias('hicetnunc'));
    assert.equal(contract, 'KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton');
  });

  test('unknown alias → throws with hint to paste KT1 directly', async () => {
    const mock = mockFetchByUrl([{ match: 'data.objkt.com', body: { data: { fa: [] } } }]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveObjktAlias('definitely-not-a-real-alias')),
      /did not resolve to a contract/
    );
  });
});

describe('resolveFxhashIteration', () => {
  test('happy: iteration slug → tezos coords', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'api.fxhash.xyz',
        body: {
          data: {
            objkt: {
              gentkContractAddress: 'KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE',
              onChainId: 146207,
            },
          },
        },
      },
    ]);
    const coords = await withMockedFetch(mock, () =>
      resolveFxhashIteration('garden-monoliths-215')
    );
    assert.equal(coords.chain, 'tezos');
    assert.equal(coords.contract, 'KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE');
    assert.equal(coords.tokenId, '146207');
  });

  test('unknown slug → throws', async () => {
    const mock = mockFetchByUrl([{ match: 'api.fxhash.xyz', body: { data: { objkt: null } } }]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveFxhashIteration('not-a-real-iteration')),
      /no iteration found/
    );
  });

  test('iteration missing on-chain fields (pre-reveal) → throws', async () => {
    const mock = mockFetchByUrl([
      {
        match: 'api.fxhash.xyz',
        body: { data: { objkt: { gentkContractAddress: null, onChainId: null } } },
      },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveFxhashIteration('pre-reveal-iteration')),
      /missing on-chain coordinates/
    );
  });
});

describe('resolveFxhashProject', () => {
  test('happy: project slug → first iteration coords (read from per-objkt contract)', async () => {
    // Regression guard: each Objkt has its own gentkContractAddress because
    // fxhash projects can span multiple gentk contracts (V1/V2/V3 mint
    // phases). Reading the contract off the project header would return
    // the wrong KT1 for first-iteration tokens.
    const mock = mockFetchByUrl([
      {
        match: 'api.fxhash.xyz',
        body: {
          data: {
            generativeToken: {
              objkts: [
                {
                  gentkContractAddress: 'KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE',
                  onChainId: 145971,
                },
              ],
            },
          },
        },
      },
    ]);
    const coords = await withMockedFetch(mock, () => resolveFxhashProject('garden-monoliths'));
    assert.equal(coords.chain, 'tezos');
    assert.equal(coords.contract, 'KT1KEa8z6vWXDJrVqtMrAeDVzsvxat3kHaCE');
    assert.equal(coords.tokenId, '145971');
  });

  test('unknown slug (or EVM-only project) → throws "no project found"', async () => {
    const mock = mockFetchByUrl([
      { match: 'api.fxhash.xyz', body: { data: { generativeToken: null } } },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveFxhashProject('not-a-camera')),
      /no project found/
    );
  });

  test('project with no minted iterations → throws "no minted iterations"', async () => {
    const mock = mockFetchByUrl([
      { match: 'api.fxhash.xyz', body: { data: { generativeToken: { objkts: [] } } } },
    ]);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveFxhashProject('pre-reveal-project')),
      /no minted iterations/
    );
  });
});

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

  test('art with no playable asset at all → throws', async () => {
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
      /no playable asset/
    );
  });
});

describe('resolveFeralFileToken', () => {
  test('artwork URL: resolves via /api/artworks/{id}, returns on-chain tokenID (handles swapped ids)', async () => {
    // The URL-id `f0240e04...` is a public hex hash; the on-chain tokenID
    // is a different integer string. The resolver must use the API's
    // tokenID, not the URL id.
    const mock = mockFetchByUrl([
      {
        match: '/api/artworks/f0240e04',
        body: {
          result: {
            id: 'f0240e04d64717e3...',
            chain: 'ethereum',
            contractAddress: '0xDB5f1aDCFFA1869B9711cBFBe3Bf46cc5d5319E5',
            tokenID: '92419109143972345624917924',
          },
        },
      },
    ]);
    const coords = await withMockedFetch(mock, () =>
      resolveFeralFileToken({ urlKind: 'artwork', identifier: 'f0240e04d64717e3' })
    );
    assert.equal(coords.chain, 'ethereum');
    assert.equal(coords.contract, '0xdb5f1adcffa1869b9711cbfbe3bf46cc5d5319e5'); // lowercased
    assert.equal(coords.tokenId, '92419109143972345624917924');
  });

  test('series URL: walks series → first artwork → /api/artworks/{id}', async () => {
    // Two API hops: /series?slug=... then /artworks?seriesID=...; the
    // representative artwork is then resolved through the same artwork
    // endpoint to get the correct on-chain tokenID.
    const mock = mockFetchByUrl([
      {
        match: '/api/series?slug=garden',
        body: { result: [{ id: 'series-1', exhibitionID: 'ex-1', slug: 'garden' }] },
      },
      {
        match: '/api/artworks?seriesID=series-1',
        body: { result: [{ id: 'artwork-1', seriesID: 'series-1' }] },
      },
      {
        match: '/api/artworks/artwork-1',
        body: {
          result: {
            id: 'artwork-1',
            chain: 'tezos',
            contractAddress: 'KT1abc',
            tokenID: '42',
          },
        },
      },
    ]);
    const coords = await withMockedFetch(mock, () =>
      resolveFeralFileToken({ urlKind: 'series', identifier: 'garden' })
    );
    assert.equal(coords.chain, 'tezos');
    assert.equal(coords.contract, 'KT1abc');
    assert.equal(coords.tokenId, '42');
  });

  test('show URL → throws (multi-series, out of scope for v1)', async () => {
    // No fetches expected; resolver rejects synchronously before any API
    // call. Mock returns 500 to fail loudly if a fetch slips through.
    const mock = mockFetchByUrl([]);
    await assert.rejects(
      () =>
        withMockedFetch(mock, () =>
          resolveFeralFileToken({ urlKind: 'show', identifier: 'some-show' })
        ),
      /shows.*span multiple series/
    );
  });

  test('series URL with no matching slug → throws', async () => {
    const mock = mockFetchByUrl([{ match: '/api/series?slug=', body: { result: [] } }]);
    await assert.rejects(
      () =>
        withMockedFetch(mock, () =>
          resolveFeralFileToken({ urlKind: 'series', identifier: 'does-not-exist' })
        ),
      /no series found/
    );
  });
});
