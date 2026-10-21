import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { INDEXER_DEPRECATION_WARNING, createTokenSource } from '../src/utilities/token-source';

const ipfsGateways = {
  feralFile: 'https://ipfs.feralfile.com/ipfs/',
  default: 'https://ipfs.filebase.io/ipfs/',
};

describe('createTokenSource', () => {
  test('Raster is selected silently', () => {
    const warnings: string[] = [];
    const source = createTokenSource(
      { source: 'raster', ipfsGateways },
      { warn: (line) => warnings.push(line) }
    );
    assert.equal(source.name, 'raster');
    assert.deepEqual(warnings, []);
  });

  test('the indexer is selected with a deprecation warning', () => {
    const warnings: string[] = [];
    const source = createTokenSource(
      { source: 'indexer', ipfsGateways },
      { warn: (line) => warnings.push(line) }
    );
    assert.equal(source.name, 'indexer');
    assert.deepEqual(warnings, [INDEXER_DEPRECATION_WARNING]);
    assert.match(INDEXER_DEPRECATION_WARNING, /deprecated/);
  });
});
