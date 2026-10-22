import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTokenSource } from '../src/utilities/token-source';

const ipfsGateways = {
  feralFile: 'https://ipfs.feralfile.com/ipfs/',
  default: 'https://ipfs.filebase.io/ipfs/',
};

describe('createTokenSource', () => {
  test('the indexer is selected for tokenSource "indexer"', () => {
    assert.equal(createTokenSource({ source: 'indexer', ipfsGateways }).name, 'indexer');
  });

  test('Raster is selected for tokenSource "raster"', () => {
    assert.equal(createTokenSource({ source: 'raster', ipfsGateways }).name, 'raster');
  });
});
