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
import { resolveVerseSeries } from '../src/utilities/verse-marketplace';
import {
  resolveTokenToArtwork,
  listArtworkTokens,
  listArtistArtworks,
  resolveAddressToArtist,
} from '../src/utilities/raster-client';

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

/**
 * Build a fetch mock for the Raster GraphQL endpoint. All Raster calls POST
 * to one URL, so routing keys off the request body (query text + variables)
 * instead of the URL. The handler returns the JSON payload to serve
 * (`{ data }` or `{ errors }`); pass `status` to simulate HTTP failures.
 */
function mockRasterGraphQL(
  handler: (query: string, variables: Record<string, unknown>) => unknown,
  status = 200
): FetchFn {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    return new Response(JSON.stringify(handler(body.query ?? '', body.variables ?? {})), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as FetchFn;
}

describe('resolveTokenToArtwork (Raster GraphQL)', () => {
  test('indexed token → full summary (id, title, artists) in one query', async () => {
    let seenRef: Record<string, unknown> | undefined;
    const mock = mockRasterGraphQL((_query, variables) => {
      seenRef = variables.ref as Record<string, unknown>;
      return {
        data: {
          tokenByRef: {
            artworks: [
              {
                id: '42',
                title: 'Send/Receive',
                artists: [{ id: '7', name: 'Snowfro', slug: 'snowfro' }],
              },
            ],
          },
        },
      };
    });
    const result = await withMockedFetch(mock, () =>
      resolveTokenToArtwork('ethereum', '0xabc', '123')
    );
    assert.notEqual(result, null);
    assert.equal(result?.artworkId, '42');
    assert.equal(result?.title, 'Send/Receive');
    assert.equal(result?.artists[0]?.name, 'Snowfro');
    // Indexer chain slugs must be translated to CAIP-2 for the API.
    assert.deepEqual(seenRef, { chainId: 'eip155:1', contractAddress: '0xabc', tokenId: '123' });
  });

  test('unindexed token → tokenByRef null → returns null (caller falls back to single-token mode)', async () => {
    const mock = mockRasterGraphQL(() => ({ data: { tokenByRef: null } }));
    const result = await withMockedFetch(mock, () =>
      resolveTokenToArtwork('ethereum', '0xabc', '123')
    );
    assert.equal(result, null);
  });

  test('HTTP 500 → throws', async () => {
    const mock = mockRasterGraphQL(() => ({ detail: 'internal error' }), 500);
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveTokenToArtwork('ethereum', '0xabc', '123')),
      /500/
    );
  });

  test('GraphQL errors → throws with concatenated messages', async () => {
    const mock = mockRasterGraphQL(() => ({
      errors: [{ message: 'invalid API key' }, { message: 'rate limited' }],
    }));
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveTokenToArtwork('ethereum', '0xabc', '123')),
      /invalid API key; rate limited/
    );
  });
});

describe('listArtworkTokens (Raster GraphQL — pagination + chain filter)', () => {
  test('eth + tezos tokens pass through, unsupported chains counted in skippedUnsupported', async () => {
    const mock = mockRasterGraphQL(() => ({
      data: {
        artwork: {
          tokens: {
            nodes: [
              { chainId: 'eip155:1', contractAddress: '0xeth', tokenId: '1' },
              { chainId: 'tezos:NetXdQprcVkpaWU', contractAddress: 'KT1abc', tokenId: '2' },
              { chainId: 'eip155:137', contractAddress: '0xmatic', tokenId: '3' },
              { chainId: 'eip155:8453', contractAddress: '0xbase', tokenId: '4' },
            ],
            pageInfo: { hasNextPage: false, endCursor: 'opaque-end' },
          },
        },
      },
    }));
    const page = await withMockedFetch(mock, () => listArtworkTokens('42'));
    assert.equal(page.tokens.length, 2);
    assert.equal(page.tokens[0].chain, 'ethereum');
    assert.equal(page.tokens[0].contractAddress, '0xeth');
    assert.equal(page.tokens[1].chain, 'tezos');
    assert.equal(page.tokens[1].contractAddress, 'KT1abc');
    assert.equal(page.skippedUnsupported, 2);
  });

  test('hasNextPage false → nextCursor null (end of stream)', async () => {
    const mock = mockRasterGraphQL(() => ({
      data: {
        artwork: {
          tokens: {
            nodes: [{ chainId: 'eip155:1', contractAddress: '0xa', tokenId: '1' }],
            pageInfo: { hasNextPage: false, endCursor: 'cursor-a' },
          },
        },
      },
    }));
    const page = await withMockedFetch(mock, () => listArtworkTokens('42'));
    assert.equal(page.nextCursor, null);
  });

  test('hasNextPage true → endCursor passes through for next page', async () => {
    const mock = mockRasterGraphQL((_query, variables) => ({
      data: {
        artwork: {
          tokens: {
            nodes: [{ chainId: 'eip155:1', contractAddress: '0xa', tokenId: '1' }],
            pageInfo: {
              hasNextPage: true,
              endCursor: `cursor-after-${variables.after ?? 'start'}`,
            },
          },
        },
      },
    }));
    const page = await withMockedFetch(mock, () => listArtworkTokens('42'));
    assert.equal(page.nextCursor, 'cursor-after-start');

    const next = await withMockedFetch(mock, () =>
      listArtworkTokens('42', { cursor: page.nextCursor! })
    );
    assert.equal(next.nextCursor, 'cursor-after-cursor-after-start');
  });

  test('unknown artwork id → throws', async () => {
    const mock = mockRasterGraphQL(() => ({ data: { artwork: null } }));
    await assert.rejects(
      () => withMockedFetch(mock, () => listArtworkTokens('999')),
      /artwork 999 not found/
    );
  });
});

describe('resolveAddressToArtist (Raster GraphQL)', () => {
  test('claimed address → first associated artist', async () => {
    const mock = mockRasterGraphQL(() => ({
      data: { address: { artists: [{ id: '2', name: 'Snowfro', slug: 'snowfro' }] } },
    }));
    const artist = await withMockedFetch(mock, () =>
      resolveAddressToArtist('0xf3860788d1597cecf938424baabe976fac87dc26')
    );
    assert.deepEqual(artist, { id: '2', name: 'Snowfro', slug: 'snowfro' });
  });

  test('unclaimed address → empty artists list → null', async () => {
    const mock = mockRasterGraphQL(() => ({ data: { address: { artists: [] } } }));
    const artist = await withMockedFetch(mock, () => resolveAddressToArtist('0xdeadbeef'));
    assert.equal(artist, null);
  });
});

describe('listArtistArtworks (Raster GraphQL — full catalog walk)', () => {
  test('paginates until hasNextPage is false and concatenates rows', async () => {
    const mock = mockRasterGraphQL((_query, variables) => {
      if (!variables.after) {
        return {
          data: {
            artist: {
              artworks: {
                nodes: [{ id: '1', title: 'First' }],
                pageInfo: { hasNextPage: true, endCursor: 'page-2' },
              },
            },
          },
        };
      }
      assert.equal(variables.after, 'page-2');
      return {
        data: {
          artist: {
            artworks: {
              nodes: [{ id: '2', title: 'Second' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    });
    const rows = await withMockedFetch(mock, () => listArtistArtworks('7'));
    assert.deepEqual(rows, [
      { artworkId: '1', title: 'First' },
      { artworkId: '2', title: 'Second' },
    ]);
  });

  test('unknown artist id → throws', async () => {
    const mock = mockRasterGraphQL(() => ({ data: { artist: null } }));
    await assert.rejects(
      () => withMockedFetch(mock, () => listArtistArtworks('404')),
      /artist 404 not found/
    );
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

describe('resolveVerseSeries', () => {
  test('happy: series page → first Ethereum edition link coords', async () => {
    const mock = (async () =>
      new Response(
        '<html><a href="/items/ethereum/0x23b72f7458a204446983f544d655df10f70533e9/139">Quantizer</a></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      )) as FetchFn;

    const coords = await withMockedFetch(mock, () =>
      resolveVerseSeries('quantizer-by-harm-van-den-dorpel')
    );
    assert.equal(coords.chain, 'ethereum');
    assert.equal(coords.contract, '0x23b72f7458a204446983f544d655df10f70533e9');
    assert.equal(coords.tokenId, '139');
  });

  test('series page with no Ethereum edition links → throws with item URL hint', async () => {
    const mock = (async () =>
      new Response('<html>No items yet</html>', { status: 200 })) as FetchFn;
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveVerseSeries('empty-series')),
      /specific Verse item URL/
    );
  });

  test('HTTP error → throws with status', async () => {
    const mock = (async () => new Response('Not found', { status: 404 })) as FetchFn;
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveVerseSeries('does-not-exist')),
      /404/
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

describe('rasterQuery network resilience (#97)', () => {
  test('connect failure → RasterUnreachableError naming the endpoint and cause', async () => {
    const mock = (async () => {
      // Undici's opaque envelope: message says nothing, cause has the truth.
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('connect ETIMEDOUT 65.109.41.181:443'),
      });
    }) as FetchFn;
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveTokenToArtwork('ethereum', '0xabc', '1')),
      (error: Error) => {
        assert.equal(error.name, 'RasterUnreachableError');
        assert.match(error.message, /api\.raster\.art/);
        assert.match(error.message, /ETIMEDOUT/);
        return true;
      }
    );
  });

  test('abort (timeout) → RasterUnreachableError, not a hang or bare AbortError', async () => {
    const mock = (async () => {
      throw Object.assign(new DOMException('This operation was aborted', 'AbortError'), {});
    }) as FetchFn;
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveTokenToArtwork('ethereum', '0xabc', '1')),
      (error: Error) => {
        assert.equal(error.name, 'RasterUnreachableError');
        return true;
      }
    );
  });

  test('fetch carries an abort signal so a stalled request cannot hang forever', async () => {
    let sawSignal = false;
    const mock = (async (_input: string | URL | Request, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response(JSON.stringify({ data: { tokenByRef: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as FetchFn;
    await withMockedFetch(mock, () => resolveTokenToArtwork('ethereum', '0xabc', '1'));
    assert.equal(sawSignal, true);
  });
});

describe('rasterQuery body-read failures (#98 review)', () => {
  test('body that terminates mid-stream → RasterUnreachableError (fallback stays reachable)', async () => {
    const mock = (async () => {
      // Headers arrive fine; the body stream errors — response.json() rejects
      // outside fetch()'s own rejection path.
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('terminated'));
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as FetchFn;
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveTokenToArtwork('ethereum', '0xabc', '1')),
      (error: Error) => {
        assert.equal(error.name, 'RasterUnreachableError');
        assert.match(error.message, /response body failed/);
        return true;
      }
    );
  });

  test('HTTP error with unreadable body keeps the status error, not unreachable', async () => {
    const mock = (async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('terminated'));
        },
      });
      return new Response(body, { status: 502, statusText: 'Bad Gateway' });
    }) as FetchFn;
    await assert.rejects(
      () => withMockedFetch(mock, () => resolveTokenToArtwork('ethereum', '0xabc', '1')),
      (error: Error) => {
        // API-level failure: NOT the network-unreachable type, and the
        // status survives even though the body could not be read.
        assert.notEqual(error.name, 'RasterUnreachableError');
        assert.match(error.message, /Raster API 502/);
        return true;
      }
    );
  });
});

describe('fetchWithTimeout (shared HTTP deadline)', () => {
  test('every resolver-facing fetch carries a deadline signal', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetchWithTimeout } = require('../src/utilities/http');
    let sawSignal = false;
    const mock = (async (_input: string | URL | Request, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response('{}', { status: 200 });
    }) as FetchFn;
    await withMockedFetch(mock, () => fetchWithTimeout('https://example.com'));
    assert.equal(sawSignal, true);
  });

  test('caller-supplied signal is composed with the deadline, not replaced', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetchWithTimeout } = require('../src/utilities/http');
    const caller = new AbortController();
    let received: AbortSignal | undefined;
    const mock = (async (_input: string | URL | Request, init?: RequestInit) => {
      received = init?.signal ?? undefined;
      return new Response('{}', { status: 200 });
    }) as FetchFn;
    await withMockedFetch(mock, () =>
      fetchWithTimeout('https://example.com', { signal: caller.signal })
    );
    assert.ok(received instanceof AbortSignal);
    // Aborting the caller's controller must abort the composed signal.
    caller.abort();
    assert.equal(received?.aborted, true);
  });
});

describe('device request deadlines (#101 review)', () => {
  test('ssh access request carries a deadline signal', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sendSshAccessCommand } = require('../src/utilities/ssh-access');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');

    // sendSshAccessCommand resolves its device from the user config, so the
    // test must carry its own — a machine with a real ~/.config/ff-cli made
    // the original version of this test pass while CI (no config) failed.
    // XDG_CONFIG_HOME is read per-call, so a temp config keeps it hermetic
    // on every platform AND independent of the developer's real devices.
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cli-ssh-test-'));
    fs.mkdirSync(path.join(configHome, 'ff-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(configHome, 'ff-cli', 'config.json'),
      JSON.stringify({
        ff1Devices: { devices: [{ name: 'test', host: 'http://127.0.0.1:1111' }] },
      })
    );
    const originalXdg = process.env.XDG_CONFIG_HOME;

    const signals: boolean[] = [];
    const mock = (async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal instanceof AbortSignal);
      // First call is the compatibility probe (getDeviceStatus), second is
      // the sshAccess request itself; this reply shape satisfies both.
      return new Response(JSON.stringify({ ok: true, message: { installedVersion: '1.0.21' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as FetchFn;

    try {
      process.env.XDG_CONFIG_HOME = configHome;
      const result = await withMockedFetch(mock, () =>
        sendSshAccessCommand({
          enabled: true,
          publicKey: 'ssh-ed25519 AAAA test',
        })
      );
      // The command must have actually reached the device request — a
      // config-resolution early-out would pass a naive signal assertion
      // by never fetching at all.
      assert.equal(result.success, true);
      assert.ok(signals.length >= 2, `expected probe + request fetches, saw ${signals.length}`);
      assert.ok(
        signals.every(Boolean),
        'every device fetch (probe and ssh request) must carry a deadline signal'
      );
    } finally {
      if (originalXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdg;
      }
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });

  test('ff1 compatibility probe default fetch carries a deadline signal', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { assertFF1CommandCompatibility } = require('../src/utilities/ff1-compatibility');
    let sawSignal = false;
    const mock = (async (_input: string | URL | Request, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response(JSON.stringify({ message: { installedVersion: '1.0.21' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as FetchFn;
    await withMockedFetch(mock, () =>
      assertFF1CommandCompatibility({ name: 'test', host: 'http://127.0.0.1:1111' }, 'sshAccess')
    );
    assert.equal(sawSignal, true);
  });
});
