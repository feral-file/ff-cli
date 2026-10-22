import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createRequire } from 'node:module';
import {
  RASTER_CANNOT_LIST_CONTRACT,
  TokenSourceCapabilityError,
  type ListOptions,
  type ResolvedToken,
  type TokenCoordinate,
  type TokenSource,
} from '../src/utilities/token-source-contract';

const require = createRequire(import.meta.url);
const utilities = require('../src/utilities');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** resolved builds a successful result whose item id names the token. */
function resolved(coordinate: TokenCoordinate): ResolvedToken {
  return {
    success: true,
    coordinate,
    item: { id: `item-${coordinate.tokenId}`, source: `https://example.com/${coordinate.tokenId}` },
    still: '',
  };
}

interface FakeCalls {
  owner: Array<{ address: string; opts: ListOptions }>;
  contract: Array<{ address: string; opts: ListOptions }>;
  resolve: TokenCoordinate[][];
}

/**
 * fakeSource records every call. `ownerTokens` are what the owner listing
 * returns; `canListContracts` false makes it behave like Raster.
 */
function fakeSource(
  name: 'raster' | 'indexer',
  options: { ownerTokens?: string[]; canListContracts: boolean }
): { source: TokenSource; calls: FakeCalls } {
  const calls: FakeCalls = { owner: [], contract: [], resolve: [] };
  const toResult = (address: string) => (tokenId: string) =>
    resolved({ chain: 'ethereum', contractAddress: address, tokenId });
  const source: TokenSource = {
    name,
    async resolveTokens(coords) {
      calls.resolve.push(coords);
      return coords.map(resolved);
    },
    async listTokensByOwner(address, opts) {
      calls.owner.push({ address, opts });
      return { results: (options.ownerTokens ?? []).map(toResult(address)), skippedUnsupported: 0 };
    },
    async listTokensByContract(address, opts) {
      calls.contract.push({ address, opts });
      if (!options.canListContracts) {
        throw new TokenSourceCapabilityError(RASTER_CANNOT_LIST_CONTRACT);
      }
      return { results: [toResult(address)('101')], skippedUnsupported: 0 };
    },
  };
  return { source, calls };
}

const EVM_ADDRESS = '0xaeE022552B539dB18297D7481b6D547C622488B3';

describe('queryRequirement owner-to-contract fallback', () => {
  test('falls back to a contract listing for EVM addresses with no owned tokens', async () => {
    const { source, calls } = fakeSource('indexer', { canListContracts: true });
    const items = await utilities.queryRequirement(
      { type: 'query_address', ownerAddress: EVM_ADDRESS, quantity: 10 },
      10,
      source
    );
    assert.equal(calls.owner.length, 1);
    assert.deepEqual(calls.owner[0].opts, { limit: 10, duration: 10 });
    assert.equal(calls.contract.length, 1);
    assert.equal(calls.contract[0].address, EVM_ADDRESS);
    assert.deepEqual(
      items.map((item: { id: string }) => item.id),
      ['item-101']
    );
  });

  test('does not run the contract fallback for non-EVM addresses', async () => {
    const { source, calls } = fakeSource('indexer', { canListContracts: true });
    const items = await utilities.queryRequirement(
      { type: 'query_address', ownerAddress: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', quantity: 10 },
      10,
      source
    );
    assert.equal(calls.owner.length, 1);
    assert.equal(calls.contract.length, 0);
    assert.deepEqual(items, []);
  });

  test('on a source that cannot list contracts, the fallback ends empty instead of failing', async () => {
    const { source, calls } = fakeSource('raster', { canListContracts: false });
    const items = await utilities.queryRequirement(
      { type: 'query_address', ownerAddress: EVM_ADDRESS, quantity: 10 },
      10,
      source
    );
    assert.equal(calls.contract.length, 1);
    assert.deepEqual(items, []);
  });

  test('quantity "all" walks the whole wallet', async () => {
    const { source, calls } = fakeSource('raster', {
      ownerTokens: ['1', '2'],
      canListContracts: false,
    });
    const items = await utilities.queryRequirement(
      { type: 'query_address', ownerAddress: EVM_ADDRESS, quantity: 'all' },
      undefined,
      source
    );
    assert.equal(calls.owner[0].opts.limit, 'all');
    assert.equal(items.length, 2);
    assert.equal(calls.contract.length, 0);
  });
});

describe('queryRequirement build_playlist', () => {
  test('contract-only input fails with the reason on a source that cannot list contracts', async () => {
    const { source, calls } = fakeSource('raster', { canListContracts: false });
    await assert.rejects(
      () =>
        utilities.queryRequirement(
          { type: 'build_playlist', blockchain: 'ethereum', contractAddress: EVM_ADDRESS },
          10,
          source
        ),
      (error: unknown) =>
        error instanceof TokenSourceCapabilityError && error.message === RASTER_CANNOT_LIST_CONTRACT
    );
    assert.equal(calls.owner.length, 0);
  });

  test('token ids are resolved as coordinates in one call', async () => {
    const { source, calls } = fakeSource('raster', { canListContracts: false });
    const items = await utilities.queryRequirement(
      {
        type: 'build_playlist',
        blockchain: 'ethereum',
        contractAddress: EVM_ADDRESS,
        tokenIds: ['7', '8'],
      },
      undefined,
      source
    );
    assert.equal(calls.resolve.length, 1);
    assert.deepEqual(
      calls.resolve[0].map((coord) => coord.tokenId),
      ['7', '8']
    );
    assert.equal(items.length, 2);
  });
});

describe('queryRequirement Feral File artwork', () => {
  test('resolves artwork identity and fetches the returned token id', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            id: 'public-artwork-id',
            chain: 'ethereum',
            contractAddress: '0xDB5f1aDCFFA1869B9711cBFBe3Bf46cc5d5319E5',
            tokenID:
              '92419109143972345096969611651362597777388673613154609693448331487805624917924',
          },
        }),
      } as Response;
    };
    const { source } = fakeSource('raster', { canListContracts: false });

    const items = await utilities.queryRequirement(
      { type: 'feral_file_artwork', artworkId: 'public-artwork-id' },
      10,
      source
    );

    assert.deepEqual(calls, ['https://feralfile.com/api/artworks/public-artwork-id']);
    assert.equal(items.length, 1);
    assert.equal(
      items[0].id,
      'item-92419109143972345096969611651362597777388673613154609693448331487805624917924'
    );
  });
});

describe('queryRequirement named token ids', () => {
  test('reports how many named tokens did not resolve', async () => {
    // A source that resolves only token 1 of the two named.
    const source = {
      name: 'indexer',
      async resolveTokens(coords: TokenCoordinate[]) {
        return coords.map((coordinate) =>
          coordinate.tokenId === '1'
            ? resolved(coordinate)
            : { success: false, coordinate, error: 'not found' }
        );
      },
    } as unknown as TokenSource;
    const report: { missing?: number; wanted?: number } = {};
    const items = await utilities.queryRequirement(
      {
        type: 'build_playlist',
        blockchain: 'ethereum',
        contractAddress: '0x1111111111111111111111111111111111111111',
        tokenIds: ['1', '2'],
      },
      undefined,
      source,
      report
    );
    assert.equal(items.length, 1);
    assert.deepEqual(report, { missing: 1, wanted: 2 });
  });
});
