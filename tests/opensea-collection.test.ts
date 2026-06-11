/**
 * Tests for the OpenSea collection-slug resolver behind `ff-cli find`.
 *
 * `resolveOpenSeaCollection` scrapes the public collection page for embedded
 * relay-style item JSON. These tests stub `global.fetch` with canned HTML so
 * the extraction invariants are pinned without hitting opensea.io:
 * adjacency-based noise filtering, dominant-contract selection, lowest-seed
 * tokenId, BigInt-safe id comparison, the ethereum-only guard, and error
 * paths (HTTP failure, no items).
 *
 * Pattern matches `tests/find-resolvers.test.ts`: save global.fetch, assign
 * a mock, restore in finally.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveOpenSeaCollection } from '../src/utilities/opensea-marketplace';
import { parseFindInput } from '../src/utilities/marketplace-url';

type FetchFn = typeof global.fetch;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
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

/** One embedded collection item in the shape OpenSea's page renders. */
function item(chain: string, contract: string, tokenId: string): string {
  return (
    `{"id":"x","chain":{"identifier":"${chain}","__typename":"Chain","arch":"EVM",` +
    `"name":"Chain"},"contractAddress":"${contract}","tokenId":"${tokenId}","isFungible":false}`
  );
}

const COLLECTION_CONTRACT = '0xe293247b582759495d0320ee8a87f598cc052c5b';
const STRAY_CONTRACT = '0x1111111111111111111111111111111111111111';

/** Payment-token noise: contractAddress with no adjacent tokenId. */
const WETH_NOISE =
  '{"symbol":"WETH","contractAddress":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","decimals":18}';

describe('resolveOpenSeaCollection', () => {
  test('extracts dominant contract and lowest tokenId, ignoring payment-token noise', async () => {
    const html =
      '<html><script>' +
      WETH_NOISE +
      item('ethereum', COLLECTION_CONTRACT, '97') +
      item('ethereum', COLLECTION_CONTRACT, '15') +
      item('ethereum', COLLECTION_CONTRACT, '40') +
      item('ethereum', STRAY_CONTRACT, '7') + // stray adjacency loses on frequency
      '</script></html>';

    const coords = await withMockedFetch((async () => htmlResponse(html)) as FetchFn, () =>
      resolveOpenSeaCollection('a-eye-after-johannes-itten')
    );
    assert.deepEqual(coords, {
      chain: 'ethereum',
      contract: COLLECTION_CONTRACT,
      tokenId: '15',
    });
  });

  test('compares tokenIds as BigInt (ids beyond Number range)', async () => {
    const big = '106531167402379141148776360336529888293057364703212462867524098456103606550529';
    const html =
      item('ethereum', COLLECTION_CONTRACT, big) + item('ethereum', COLLECTION_CONTRACT, '9');
    const coords = await withMockedFetch((async () => htmlResponse(html)) as FetchFn, () =>
      resolveOpenSeaCollection('big-ids')
    );
    assert.equal(coords.tokenId, '9');
  });

  test('rejects non-ethereum collections with a chain-specific message', async () => {
    const html = item('matic', STRAY_CONTRACT, '1') + item('matic', STRAY_CONTRACT, '2');
    await assert.rejects(
      withMockedFetch((async () => htmlResponse(html)) as FetchFn, () =>
        resolveOpenSeaCollection('polygon-collection')
      ),
      /on matic/
    );
  });

  test('errors with fallback hint when the page embeds no items', async () => {
    await assert.rejects(
      withMockedFetch((async () => htmlResponse('<html>js shell only</html>')) as FetchFn, () =>
        resolveOpenSeaCollection('empty-or-changed')
      ),
      /no items found.*opensea\.io\/item\/ethereum/s
    );
  });

  test('errors with status code on HTTP failure', async () => {
    await assert.rejects(
      withMockedFetch((async () => htmlResponse('blocked', 403)) as FetchFn, () =>
        resolveOpenSeaCollection('blocked')
      ),
      /returned 403/
    );
  });
});

describe('parseFindInput: OpenSea collection URLs', () => {
  test('opensea.io/collection/{slug} parses to os-collection', () => {
    const r = parseFindInput('https://opensea.io/collection/a-eye-after-johannes-itten');
    assert.deepEqual(r, { kind: 'os-collection', slug: 'a-eye-after-johannes-itten' });
  });

  test('trailing slash is accepted', () => {
    const r = parseFindInput('https://opensea.io/collection/some-slug/');
    assert.deepEqual(r, { kind: 'os-collection', slug: 'some-slug' });
  });

  test('extra path segments stay unsupported with a clear reason', () => {
    const r = parseFindInput('https://opensea.io/collection/some-slug/activity');
    assert.equal(r?.kind, 'unsupported');
  });
});
