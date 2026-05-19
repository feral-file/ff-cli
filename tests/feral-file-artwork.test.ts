import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  parseFeralFileArtworkId,
  resolveFeralFileArtwork,
} from '../src/utilities/feral-file-artwork';

/**
 * jsonResponse creates the minimal fetch Response surface used by the Feral
 * File artwork resolver tests.
 *
 * @param body - JSON body returned by response.json().
 * @param ok - Whether the HTTP response is successful.
 * @param status - HTTP status code.
 * @returns Minimal Response object.
 */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('parseFeralFileArtworkId', () => {
  test('extracts public artwork id from Feral File artwork URL', () => {
    assert.equal(
      parseFeralFileArtworkId(
        'https://feralfile.com/exhibitions/artwork/f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf'
      ),
      'f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf'
    );
  });

  test('passes raw public artwork ids through', () => {
    assert.equal(parseFeralFileArtworkId('abc123'), 'abc123');
  });
});

describe('resolveFeralFileArtwork', () => {
  test('uses artwork identity fields from one public API call', async () => {
    const calls: string[] = [];
    const coords = await resolveFeralFileArtwork('native-token-id', async (input) => {
      calls.push(String(input));
      return jsonResponse({
        result: {
          id: 'native-token-id',
          chain: 'ethereum',
          contractAddress: '0xBE0A4E26a156B2a60cF515E86b3Df9756DEE1952',
          tokenID: 'native-token-id',
        },
      });
    });

    assert.deepEqual(coords, {
      chain: 'ethereum',
      contractAddress: '0xBE0A4E26a156B2a60cF515E86b3Df9756DEE1952',
      tokenId: 'native-token-id',
    });
    assert.deepEqual(calls, ['https://feralfile.com/api/artworks/native-token-id']);
  });

  test('uses response tokenID for swapped public artwork ids', async () => {
    const coords = await resolveFeralFileArtwork('public-swap-id', async () =>
      jsonResponse({
        result: {
          id: 'public-swap-id',
          chain: 'ethereum',
          contractAddress: '0xDB5f1aDCFFA1869B9711cBFBe3Bf46cc5d5319E5',
          tokenID: '92419109143972345096969611651362597777388673613154609693448331487805624917924',
        },
      })
    );

    assert.equal(
      coords.tokenId,
      '92419109143972345096969611651362597777388673613154609693448331487805624917924'
    );
  });

  test('rejects missing token identity fields', async () => {
    await assert.rejects(
      resolveFeralFileArtwork('missing-token', async () =>
        jsonResponse({
          result: {
            id: 'missing-token',
            chain: 'ethereum',
            contractAddress: '0xDB5f1aDCFFA1869B9711cBFBe3Bf46cc5d5319E5',
          },
        })
      ),
      /tokenID/
    );
  });

  test('surfaces API 404 messages', async () => {
    await assert.rejects(
      resolveFeralFileArtwork('not-real', async () =>
        jsonResponse({ error: { message: 'artwork not found' } }, false, 404)
      ),
      /artwork not found/
    );
  });
});
