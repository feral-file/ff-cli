import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const utilities = require('../src/utilities');
const nftIndexer = require('../src/utilities/nft-indexer');

interface IndexerToken {
  contract_address: string;
  token_id: string;
}

interface MockCall {
  address: string;
  limit: number;
  offset: number;
}

let ownerCalls: MockCall[] = [];
let contractCalls: Array<{ address: string; limit: number }> = [];

const originalQueryTokensByOwner = nftIndexer.queryTokensByOwner;
const originalQueryTokensByContract = nftIndexer.queryTokensByContract;
const originalGetNFTTokenInfoBatch = nftIndexer.getNFTTokenInfoBatch;
const originalMapIndexerDataToStandardFormat = nftIndexer.mapIndexerDataToStandardFormat;
const originalConvertToDP1Item = nftIndexer.convertToDP1Item;
const originalFetch = globalThis.fetch;

/**
 * Build a deterministic DP1 item from minimal token input.
 *
 * @param {IndexerToken} token - Minimal token row from indexer
 * @returns {object} DP1 item used by tests
 */
function toItem(token: IndexerToken): object {
  return {
    id: `item-${token.token_id}`,
    title: `Token ${token.token_id}`,
    source: `https://example.com/${token.token_id}.mp4`,
    duration: 10,
    license: 'cc0',
  };
}

beforeEach(() => {
  ownerCalls = [];
  contractCalls = [];

  nftIndexer.queryTokensByOwner = async (address: string, limit: number, offset = 0) => {
    ownerCalls.push({ address, limit, offset });
    return {
      success: true,
      tokens: [],
    };
  };

  nftIndexer.queryTokensByContract = async (address: string, limit: number) => {
    contractCalls.push({ address, limit });
    return {
      success: true,
      tokens: [
        {
          contract_address: address,
          token_id: '101',
        },
      ],
    };
  };

  nftIndexer.mapIndexerDataToStandardFormat = (token: IndexerToken) => ({
    success: true,
    token,
  });

  nftIndexer.convertToDP1Item = (mapped: { token: IndexerToken }) => ({
    success: true,
    item: toItem(mapped.token),
  });

  nftIndexer.getNFTTokenInfoBatch = async (
    tokens: Array<{ contractAddress: string; tokenId: string }>,
    duration: number
  ) =>
    tokens.map((token) => ({
      ...toItem({ contract_address: token.contractAddress, token_id: token.tokenId }),
      duration,
    }));
});

afterEach(() => {
  nftIndexer.queryTokensByOwner = originalQueryTokensByOwner;
  nftIndexer.queryTokensByContract = originalQueryTokensByContract;
  nftIndexer.getNFTTokenInfoBatch = originalGetNFTTokenInfoBatch;
  nftIndexer.mapIndexerDataToStandardFormat = originalMapIndexerDataToStandardFormat;
  nftIndexer.convertToDP1Item = originalConvertToDP1Item;
  globalThis.fetch = originalFetch;
});

describe('queryRequirement owner-to-contract fallback', () => {
  test('falls back to contract lookup for EVM addresses with no owned tokens', async () => {
    const address = '0xaeE022552B539dB18297D7481b6D547C622488B3';

    const items = await utilities.queryRequirement(
      {
        type: 'query_address',
        ownerAddress: address,
        quantity: 10,
      },
      10
    );

    assert.equal(ownerCalls.length, 1);
    assert.equal(ownerCalls[0].address, address);
    assert.equal(contractCalls.length, 1);
    assert.equal(contractCalls[0].address, address);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'item-101');
  });

  test('does not run contract fallback for non-EVM addresses', async () => {
    const items = await utilities.queryRequirement(
      {
        type: 'query_address',
        ownerAddress: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb',
        quantity: 10,
      },
      10
    );

    assert.equal(ownerCalls.length, 1);
    assert.equal(contractCalls.length, 0);
    assert.deepEqual(items, []);
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

    const items = await utilities.queryRequirement(
      {
        type: 'feral_file_artwork',
        artworkId: 'public-artwork-id',
      },
      10
    );

    assert.deepEqual(calls, ['https://feralfile.com/api/artworks/public-artwork-id']);
    assert.equal(items.length, 1);
    assert.equal(
      items[0].id,
      'item-92419109143972345096969611651362597777388673613154609693448331487805624917924'
    );
  });
});
