import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RasterToken } from '../src/utilities/raster-client';
import {
  createRasterTokenSource,
  rasterTimingMime,
  rasterTokenName,
  rasterTokenStandard,
  rasterTokenToStandardToken,
} from '../src/utilities/token-source-raster';
import {
  RASTER_CANNOT_LIST_CONTRACT,
  TokenSourceCapabilityError,
  isFailed,
  isResolved,
} from '../src/utilities/token-source-contract';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nftIndexer = require('../src/utilities/nft-indexer');

type FetchFn = typeof fetch;

const gateways = {
  feralFile: 'https://ipfs.feralfile.com/ipfs/',
  default: 'https://ipfs.filebase.io/ipfs/',
};

const FIDENZA_HASH = '40649125f58286b2227167bd860e25008669233e030b199bbf7b631493fdf040';

/** Fidenza #629 exactly as live Raster returned it on 2026-10-21. */
function fidenza(): RasterToken {
  return {
    chainId: 'eip155:1',
    contractAddress: '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270',
    tokenId: '78000629',
    tokenStandard: 'ERC721',
    name: '',
    description: '',
    media: {
      previewHash: FIDENZA_HASH,
      previewType: 'image/2.1',
      contentUrl:
        'https://generator.artblocks.io/1/0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270/78000629',
      normalizedContentUrl: null,
      contentType: 'webapp',
    },
    artworks: [
      {
        id: '14958',
        slug: 'fidenza-by-tyler-hobbs',
        title: 'Fidenza',
        description: 'Fidenza is by far my most versatile algorithm to date.',
        platform: { id: 'artblocks', name: 'Art Blocks' },
        artists: [{ id: '639', name: 'Tyler Hobbs', slug: 'tyler-hobbs' }],
      },
    ],
    artists: [{ id: '639', name: 'Tyler Hobbs', slug: null }],
  };
}

/** MVP 1, a Feral File token whose Raster source is a bare ipfs:// CID. */
function mvp(): RasterToken {
  return {
    chainId: 'eip155:1',
    contractAddress: '0xd1b52bee57fb7e31ed50122cc1eeb6a4673d9eae',
    tokenId: '89044669002029477186972338752421022172322124260495889909097208995704462066240',
    tokenStandard: 'ERC721',
    name: 'MVP 1',
    description: 'MVP (Most Valuable Painting) consists of 512 digital paintings.',
    media: {
      previewHash: 'f99df0dc08a2475cd2544dc8e7a612d8e23b1dae784ba8948fbdd7b78e03d254',
      previewType: 'image/2',
      contentUrl: 'ipfs://bafkreihztxynycfci5onevcnzdt2mewy4i5r3ltyjoujjd55263y4a6skq',
      normalizedContentUrl: null,
      contentType: '',
    },
    artworks: [
      {
        id: '1',
        slug: null,
        title: 'Most Valuable Painting',
        description: '',
        platform: { id: 'feralfile', name: 'Feral File' },
        artists: [{ id: '2', name: 'Jonas Lund', slug: null }],
      },
    ],
    artists: [],
  };
}

function mockRaster(handler: (variables: Record<string, unknown>) => unknown): FetchFn {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { variables?: Record<string, unknown> };
    return new Response(JSON.stringify(handler(body.variables ?? {})), {
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

describe('Raster field mapping', () => {
  test('Art Blocks tokens with an empty name get "<series> #<mint>"', () => {
    assert.equal(rasterTokenName(fidenza()), 'Fidenza #629');
  });

  test('a named token keeps its name; an unnamed non-Art-Blocks token uses its series', () => {
    assert.equal(rasterTokenName(mvp()), 'MVP 1');
    assert.equal(rasterTokenName({ ...mvp(), name: '' }), 'Most Valuable Painting');
    assert.equal(
      rasterTokenName({ ...mvp(), name: null, artworks: [] }),
      `Token #${mvp().tokenId}`
    );
  });

  test('standards map to DP-1 names; ones DP-1 cannot name become other', () => {
    assert.equal(rasterTokenStandard('ERC1155', 'ethereum', '0xa'), 'erc1155');
    assert.equal(rasterTokenStandard('FA2', 'tezos', 'KT1a'), 'fa2');
    assert.equal(rasterTokenStandard('CRYPTOPUNKS', 'ethereum', '0xa'), 'other');
    assert.equal(rasterTokenStandard(null, 'ethereum', '0xa', 'erc1155'), 'erc1155');
    assert.equal(rasterTokenStandard(null, 'tezos', 'KT1a'), 'fa2');
  });

  test('media categories become timing hints; previewType only counts when it says video', () => {
    const media = fidenza().media!;
    assert.equal(rasterTimingMime({ ...media, contentType: 'webapp' }), 'text/html');
    assert.equal(rasterTimingMime({ ...media, contentType: 'video' }), 'video/*');
    assert.equal(rasterTimingMime({ ...media, contentType: 'image' }), 'image/*');
    assert.equal(
      rasterTimingMime({ ...media, contentType: '', previewType: 'video/1' }),
      'video/*'
    );
    assert.equal(rasterTimingMime({ ...media, contentType: '', previewType: 'image/2.1' }), '');
    assert.equal(rasterTimingMime(null), '');
  });

  test('Raster items carry no still, so no dead preview reaches a signed manifest', () => {
    const image = rasterTokenToStandardToken(fidenza(), gateways).token?.image as {
      thumbnail: string;
    };
    assert.equal(image.thumbnail, '');
  });

  test('EVM addresses are checksummed so item ids match the indexer path', () => {
    const mapped = rasterTokenToStandardToken(fidenza(), gateways);
    assert.equal(mapped.token?.contractAddress, '0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270');
  });

  test('a Feral File ipfs source goes through the Feral File gateway', () => {
    const mapped = rasterTokenToStandardToken(mvp(), gateways);
    const image = mapped.token?.image as { url: string; mimeType: string };
    assert.equal(
      image.url,
      'https://ipfs.feralfile.com/ipfs/bafkreihztxynycfci5onevcnzdt2mewy4i5r3ltyjoujjd55263y4a6skq'
    );
    assert.equal(image.mimeType, '');
    assert.equal(mapped.token?.metadata?.artistName, 'Jonas Lund');
  });

  test('a token on an unsupported chain is a failure, not a guess', () => {
    const mapped = rasterTokenToStandardToken({ ...mvp(), chainId: 'eip155:8453' }, gateways);
    assert.equal(mapped.success, false);
    assert.match(mapped.error ?? '', /Unsupported chain eip155:8453/);
  });
});

describe('item parity with the indexer path', () => {
  test('Fidenza #629 yields the same id, provenance, title, source, and timing', () => {
    // The indexer row for the same token, as indexer.feralfile.com returned it.
    const indexerRow = {
      contract_address: '0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270',
      token_number: '78000629',
      chain: 'eip155:1',
      standard: 'erc721',
      display: {
        name: 'Fidenza #629',
        mime_type: 'text/html; charset=UTF-8',
        image_url: 'https://media-proxy.artblocks.io/1/0xa7d8/78000629.png',
        animation_url:
          'https://generator.artblocks.io/1/0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270/78000629',
        artists: [{ name: 'Tyler Hobbs' }],
      },
      media_assets: [{ source_url: 'https://media-proxy.artblocks.io/x.png' }],
    };
    const fromIndexer = nftIndexer.convertToDP1Item(
      nftIndexer.mapIndexerDataToStandardFormat(indexerRow, 'ethereum')
    ).item;
    const fromRaster = nftIndexer.convertToDP1Item(
      rasterTokenToStandardToken(fidenza(), gateways)
    ).item;

    for (const key of ['id', 'title', 'source', 'provenance', 'duration', 'display', 'license']) {
      assert.deepEqual(fromRaster[key], fromIndexer[key], `field ${key} differs`);
    }
    assert.equal(fromRaster.inlineManifest.metadata.artists[0].name, 'Tyler Hobbs');
  });
});

describe('createRasterTokenSource', () => {
  test('resolves one result per input in order, reporting misses and unsupported chains', async () => {
    const source = createRasterTokenSource(gateways);
    const progress: Array<[number, number]> = [];
    const mock = mockRaster(() => ({ data: { t0: fidenza(), t1: null } }));
    const results = await withMockedFetch(mock, () =>
      source.resolveTokens(
        [
          {
            chain: 'ethereum',
            contractAddress: '0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270',
            tokenId: '78000629',
          },
          {
            chain: 'ethereum',
            contractAddress: '0x0000000000000000000000000000000000000001',
            tokenId: '1',
          },
          {
            chain: 'polygon',
            contractAddress: '0x0000000000000000000000000000000000000002',
            tokenId: '2',
          },
        ],
        { onProgress: (done, total) => progress.push([done, total]) }
      )
    );
    assert.equal(results.length, 3);
    assert.ok(isResolved(results[0]));
    assert.equal(results[0].item.title, 'Fidenza #629');
    assert.ok(isFailed(results[1]));
    assert.match(results[1].error, /Raster has no record of this token/);
    assert.ok(isFailed(results[2]));
    assert.match(results[2].error, /Unsupported chain "polygon"/);
    assert.deepEqual(progress, [[3, 3]]);
  });

  test('splits more than 40 coordinates into batches and reports progress per batch', async () => {
    const source = createRasterTokenSource(gateways);
    let requests = 0;
    const mock = mockRaster((variables) => {
      requests += 1;
      const data: Record<string, unknown> = {};
      Object.keys(variables).forEach((key) => (data[key.replace('r', 't')] = null));
      return { data };
    });
    const progress: number[] = [];
    const coords = Array.from({ length: 41 }, (_, i) => ({
      chain: 'ethereum',
      contractAddress: '0x0000000000000000000000000000000000000001',
      tokenId: String(i),
    }));
    const results = await withMockedFetch(mock, () =>
      source.resolveTokens(coords, { onProgress: (done) => progress.push(done) })
    );
    assert.equal(requests, 2);
    assert.equal(results.length, 41);
    assert.deepEqual(progress, [40, 41]);
  });

  test('a non-decimal token id fails alone instead of poisoning its batch', async () => {
    const source = createRasterTokenSource(gateways);
    const sent: Record<string, unknown>[] = [];
    const mock = mockRaster((variables) => {
      sent.push(variables);
      return { data: { t0: fidenza() } };
    });
    const results = await withMockedFetch(mock, () =>
      source.resolveTokens([
        {
          chain: 'ethereum',
          contractAddress: '0x0000000000000000000000000000000000000001',
          tokenId: '0x1f',
        },
        {
          chain: 'ethereum',
          contractAddress: '0xa7d8d9ef8D8Ce8992Df33D8b8CF4Aebabd5bD270',
          tokenId: '78000629',
        },
      ])
    );
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0]), ['r0']);
    assert.ok(isFailed(results[0]));
    assert.match(results[0].error, /Invalid token id "0x1f"/);
    assert.ok(isResolved(results[1]));
  });

  test('a failed request fails every coordinate in its batch with the reason', async () => {
    const source = createRasterTokenSource(gateways);
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchFn;
    const results = await withMockedFetch(failing, () =>
      source.resolveTokens([
        {
          chain: 'ethereum',
          contractAddress: '0x0000000000000000000000000000000000000001',
          tokenId: '1',
        },
      ])
    );
    assert.ok(isFailed(results[0]));
    assert.match(results[0].error, /Raster API unreachable/);
  });

  test('the wallet walk pages until the limit and skips unsupported chains', async () => {
    const source = createRasterTokenSource(gateways);
    const pages = [
      { tokens: [fidenza(), { ...mvp(), chainId: 'eip155:8453' }], next: 'p2' },
      { tokens: [mvp(), fidenza()], next: null },
    ];
    let call = 0;
    const mock = mockRaster(() => {
      const page = pages[call++];
      return {
        data: {
          address: {
            tokensOwned: {
              totalCount: 4,
              nodes: page.tokens.map((token) => ({ token })),
              pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
            },
          },
        },
      };
    });
    const listing = await withMockedFetch(mock, () =>
      source.listTokensByOwner('0xOwner', { limit: 2 })
    );
    assert.equal(call, 2);
    assert.equal(listing.results.length, 2);
    assert.equal(listing.skippedUnsupported, 1);
    assert.ok(listing.results.every(isResolved));
  });

  test('listing a contract is refused with the user-facing reason', async () => {
    const source = createRasterTokenSource(gateways);
    await assert.rejects(
      () => source.listTokensByContract('0xabc', { limit: 5 }),
      (error: unknown) =>
        error instanceof TokenSourceCapabilityError && error.message === RASTER_CANNOT_LIST_CONTRACT
    );
  });
});
