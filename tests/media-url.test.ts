import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fixUpMediaUrl } from '../src/utilities/media-url';

const gateways = {
  feralFile: 'https://ipfs.feralfile.com/ipfs/',
  default: 'https://ipfs.filebase.io/ipfs/',
};

describe('fixUpMediaUrl', () => {
  test('maps a Feral File ipfs:// CID through the Feral File gateway', () => {
    assert.equal(
      fixUpMediaUrl('ipfs://bafkreihztx', 'feralfile', gateways),
      'https://ipfs.feralfile.com/ipfs/bafkreihztx'
    );
  });

  test('maps every other platform through the default gateway', () => {
    assert.equal(
      fixUpMediaUrl('ipfs://QmRv7/index.html?a=1', 'fxhash', gateways),
      'https://ipfs.filebase.io/ipfs/QmRv7/index.html?a=1'
    );
    assert.equal(
      fixUpMediaUrl('ipfs://QmRv7', null, gateways),
      'https://ipfs.filebase.io/ipfs/QmRv7'
    );
  });

  test('strips a redundant ipfs/ prefix after the scheme', () => {
    assert.equal(
      fixUpMediaUrl('ipfs://ipfs/QmX', 'hicetnunc', gateways),
      'https://ipfs.filebase.io/ipfs/QmX'
    );
  });

  test('rewrites the retired Feral File CDN host and keeps the path', () => {
    assert.equal(
      fixUpMediaUrl('https://cdn.feralfileassets.com/previews/a/b/0?x=1', 'feralfile', gateways),
      'https://cdn.artworks.feralfile.io/previews/a/b/0?x=1'
    );
  });

  test('moves the legacy Bitmark gateway onto the Feral File gateway', () => {
    assert.equal(
      fixUpMediaUrl('https://ipfs.bitmark.com/ipfs/QmfY7yhN64?', 'feralfile', gateways),
      'https://ipfs.feralfile.com/ipfs/QmfY7yhN64'
    );
    assert.equal(
      fixUpMediaUrl('https://ipfs.bitmark.com/ipfs/QmX/index.html?seed=1', null, gateways),
      'https://ipfs.feralfile.com/ipfs/QmX/index.html?seed=1'
    );
  });

  test('follows a configured Feral File gateway for the legacy Bitmark host', () => {
    assert.equal(
      fixUpMediaUrl('https://ipfs.bitmark.com/ipfs/QmX', 'feralfile', {
        ...gateways,
        feralFile: 'https://gw.example/ipfs/',
      }),
      'https://gw.example/ipfs/QmX'
    );
  });

  test('leaves a legacy Bitmark URL without an /ipfs/ path untouched', () => {
    const url = 'https://ipfs.bitmark.com/health';
    assert.equal(fixUpMediaUrl(url, 'feralfile', gateways), url);
  });

  test('leaves other https URLs untouched', () => {
    const url = 'https://generator.artblocks.io/1/0xa7d8/78000629';
    assert.equal(fixUpMediaUrl(url, 'artblocks', gateways), url);
  });

  test('returns empty for absent, empty, or non-http sources', () => {
    assert.equal(fixUpMediaUrl(null, 'feralfile', gateways), '');
    assert.equal(fixUpMediaUrl('   ', 'feralfile', gateways), '');
    assert.equal(fixUpMediaUrl('ipfs://', 'feralfile', gateways), '');
    assert.equal(fixUpMediaUrl('ar://abc', 'feralfile', gateways), '');
    assert.equal(fixUpMediaUrl('not a url', 'feralfile', gateways), '');
  });

  test('passes data URIs through so the item builder reports them precisely', () => {
    assert.equal(
      fixUpMediaUrl('data:image/png;base64,AA', null, gateways),
      'data:image/png;base64,AA'
    );
  });
});
