import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RASTER_TOKEN_BATCH_SIZE,
  RasterUnreachableError,
  buildTokenByRefBatchQuery,
  fetchTokensByRef,
  fetchTokensOwned,
  listArtworkTokens,
} from '../src/utilities/raster-client';

type FetchFn = typeof fetch;

interface Captured {
  query: string;
  variables: Record<string, unknown>;
}

/** mockRaster serves one JSON payload per request and records each request body. */
function mockRaster(
  handler: (query: string, variables: Record<string, unknown>) => unknown,
  captured: Captured[] = []
): FetchFn {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Captured;
    captured.push({ query: body.query, variables: body.variables ?? {} });
    return new Response(JSON.stringify(handler(body.query, body.variables ?? {})), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
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

function rasterToken(tokenId: string, overrides: Record<string, unknown> = {}) {
  return {
    chainId: 'eip155:1',
    contractAddress: '0xabc',
    tokenId,
    tokenStandard: 'ERC721',
    name: `Token ${tokenId}`,
    description: '',
    media: null,
    artworks: [],
    artists: [],
    ...overrides,
  };
}

describe('buildTokenByRefBatchQuery', () => {
  test('aliases one tokenByRef per ref against numbered variables and one fragment', () => {
    const query = buildTokenByRefBatchQuery(3);
    assert.match(query, /\$r0: TokenRefInput!, \$r1: TokenRefInput!, \$r2: TokenRefInput!/);
    assert.match(query, /t0: tokenByRef\(ref: \$r0\) \{ \.\.\.TokenFields \}/);
    assert.match(query, /t2: tokenByRef\(ref: \$r2\) \{ \.\.\.TokenFields \}/);
    assert.equal(query.match(/fragment TokenFields on Token/g)?.length, 1);
    assert.match(query, /platform \{ id name \}/);
  });
});

describe('fetchTokensByRef', () => {
  test('sends CAIP-2 refs and returns results aligned with the input, null per miss', async () => {
    const captured: Captured[] = [];
    const mock = mockRaster(
      () => ({ data: { t0: rasterToken('1'), t1: null, t2: rasterToken('3') } }),
      captured
    );
    const result = await withMockedFetch(mock, () =>
      fetchTokensByRef([
        { chain: 'ethereum', contractAddress: '0xABC', tokenId: '1' },
        { chain: 'tezos', contractAddress: 'KT1Case', tokenId: '2' },
        { chain: 'ethereum', contractAddress: '0xabc', tokenId: '3' },
      ])
    );
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].variables.r1, {
      chainId: 'tezos:NetXdQprcVkpaWU',
      contractAddress: 'KT1Case',
      tokenId: '2',
    });
    assert.equal(result.length, 3);
    assert.equal(result[0]?.tokenId, '1');
    assert.equal(result[1], null);
    assert.equal(result[2]?.tokenId, '3');
  });

  test('refuses more refs than one request may carry', async () => {
    const refs = Array.from({ length: RASTER_TOKEN_BATCH_SIZE + 1 }, (_, i) => ({
      chain: 'ethereum' as const,
      contractAddress: '0xabc',
      tokenId: String(i),
    }));
    await assert.rejects(() => fetchTokensByRef(refs), /at most 40/);
  });

  test('an empty input makes no request', async () => {
    const captured: Captured[] = [];
    const result = await withMockedFetch(
      mockRaster(() => ({ data: {} }), captured),
      () => fetchTokensByRef([])
    );
    assert.deepEqual(result, []);
    assert.equal(captured.length, 0);
  });

  test('a network failure surfaces as RasterUnreachableError', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchFn;
    await assert.rejects(
      () =>
        withMockedFetch(failing, () =>
          fetchTokensByRef([{ chain: 'ethereum', contractAddress: '0xabc', tokenId: '1' }])
        ),
      RasterUnreachableError
    );
  });
});

describe('fetchTokensOwned', () => {
  test('passes first/after and returns tokens with the next cursor', async () => {
    const captured: Captured[] = [];
    const mock = mockRaster(
      () => ({
        data: {
          address: {
            tokensOwned: {
              totalCount: 3,
              nodes: [{ token: rasterToken('1') }, { token: rasterToken('2') }],
              pageInfo: { hasNextPage: true, endCursor: 'c2' },
            },
          },
        },
      }),
      captured
    );
    const page = await withMockedFetch(mock, () =>
      fetchTokensOwned('0xOwner', { first: 2, after: 'c0' })
    );
    assert.deepEqual(captured[0].variables, { address: '0xOwner', first: 2, after: 'c0' });
    assert.match(captured[0].query, /tokensOwned\(first: \$first, after: \$after\)/);
    assert.equal(page.tokens.length, 2);
    assert.equal(page.nextCursor, 'c2');
    assert.equal(page.totalCount, 3);
  });

  test('the last page reports a null cursor', async () => {
    const mock = mockRaster(() => ({
      data: {
        address: {
          tokensOwned: {
            totalCount: 1,
            nodes: [{ token: rasterToken('1') }],
            pageInfo: { hasNextPage: false, endCursor: 'end' },
          },
        },
      },
    }));
    const page = await withMockedFetch(mock, () => fetchTokensOwned('0xOwner', { first: 50 }));
    assert.equal(page.nextCursor, null);
  });
});

describe('listArtworkTokens with full token fields', () => {
  test('selects the shared fragment and carries the raw token beside the coordinates', async () => {
    const captured: Captured[] = [];
    const mock = mockRaster(
      () => ({
        data: {
          artwork: {
            tokens: {
              nodes: [rasterToken('7', { name: 'Seven' })],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
      captured
    );
    const page = await withMockedFetch(mock, () => listArtworkTokens('42'));
    assert.match(captured[0].query, /\.\.\.TokenFields/);
    assert.equal(page.tokens[0].tokenId, '7');
    assert.equal(page.tokens[0].token.name, 'Seven');
  });
});
