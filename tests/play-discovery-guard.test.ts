/**
 * `play` guards against discovery inputs.
 *
 * `play` casts an exact, already-playable source (playlist file, hosted
 * playlist URL, or a direct media/web URL). A marketplace URL, on-chain
 * coordinates, or a wallet address must be resolved through the indexer
 * first — that is `find`'s job. describeDiscoveryInput returns a label for
 * those inputs (so `play` redirects to `find`) and null for everything `play`
 * should handle itself. These pin that split so a future parser change can't
 * silently make `play` either swallow a collection URL or reject a real file.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeDiscoveryInput } from '../src/commands/play';

describe('describeDiscoveryInput — redirects discovery inputs to find', () => {
  test('Art Blocks collection URL is a discovery input', () => {
    assert.equal(
      describeDiscoveryInput('https://www.artblocks.io/collection/primitives-by-arandalasch'),
      'an Art Blocks collection'
    );
  });

  test('on-chain coordinates are a discovery input', () => {
    assert.equal(
      describeDiscoveryInput('ethereum:0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0:52932'),
      'an on-chain token reference'
    );
  });

  test('a bare wallet address is a discovery input', () => {
    assert.equal(
      describeDiscoveryInput('0xf3860788d1597cecf938424baabe976fac87dc26'),
      'a wallet address'
    );
  });

  test('an Objkt token URL is a discovery input', () => {
    assert.equal(
      describeDiscoveryInput('https://objkt.com/tokens/hicetnunc/111068'),
      'an Objkt token'
    );
  });

  test('a recognized-but-unsupported marketplace URL is still a discovery input', () => {
    // Legacy Art Blocks /projects/{id} and unsupported-chain OpenSea links
    // parse to `unsupported` — they must redirect to `find`, not get wrapped
    // as a web page by `play`.
    assert.equal(
      describeDiscoveryInput('https://www.artblocks.io/projects/123'),
      'a marketplace URL'
    );
    assert.equal(
      describeDiscoveryInput('https://opensea.io/assets/matic/0xabc/1'),
      'a marketplace URL'
    );
  });
});

describe('describeDiscoveryInput — leaves real play targets alone', () => {
  test('a direct media URL is NOT a discovery input', () => {
    assert.equal(describeDiscoveryInput('https://example.com/video.mp4'), null);
  });

  test('an interactive web page URL is NOT a discovery input', () => {
    assert.equal(describeDiscoveryInput('https://whorl.app/index_launch.html'), null);
  });

  test('a hosted playlist URL is NOT a discovery input', () => {
    assert.equal(describeDiscoveryInput('https://cdn.example.com/playlist.json'), null);
  });

  test('a local file path is NOT a discovery input', () => {
    assert.equal(describeDiscoveryInput('playlist.json'), null);
    assert.equal(describeDiscoveryInput('/tmp/my-playlist.json'), null);
  });
});
