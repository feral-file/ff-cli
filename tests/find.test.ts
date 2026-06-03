/**
 * Tests for `ff-cli find` pure logic: input parsing, limit validation, and
 * post-build action selection. These are the surfaces flagged by review on
 * PR #67; covering them prevents regressions in the URL-recognition table
 * and the flag-vs-prompt branching that drives whether `--yes` plays,
 * saves, publishes, or some combination.
 *
 * Tests stay synchronous where possible — the only async path here is
 * `decideActions`, whose flag-driven branches never touch stdin.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseFindInput } from '../src/utilities/marketplace-url';
import { parseLimitOption, decideActions } from '../src/commands/find';

describe('parseFindInput', () => {
  test('Ethereum wallet address → address kind', () => {
    const r = parseFindInput('0xf3860788d1597cecf938424baabe976fac87dc26');
    assert.equal(r?.kind, 'address');
    if (r?.kind !== 'address') {
      throw new Error('narrowing');
    }
    assert.equal(r.chain, 'ethereum');
    assert.equal(r.address, '0xf3860788d1597cecf938424baabe976fac87dc26');
  });

  test('Tezos tz1 address → address kind', () => {
    const r = parseFindInput('tz1fQTvvcCy5PTt8HcUSQTu64dH9mJjjDudi');
    assert.equal(r?.kind, 'address');
    if (r?.kind !== 'address') {
      throw new Error('narrowing');
    }
    assert.equal(r.chain, 'tezos');
  });

  test('raw ethereum:contract:tokenId → token kind, source raw', () => {
    const r = parseFindInput('ethereum:0xababababab20053426ad1c782de9ea8444358070:5001410');
    assert.equal(r?.kind, 'token');
    if (r?.kind !== 'token') {
      throw new Error('narrowing');
    }
    assert.equal(r.source, 'raw');
    assert.equal(r.coords.chain, 'ethereum');
    assert.equal(r.coords.contract, '0xababababab20053426ad1c782de9ea8444358070');
    assert.equal(r.coords.tokenId, '5001410');
  });

  test('raw tezos:KT1:tokenId → token kind, source raw', () => {
    const r = parseFindInput('tezos:KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton:9201');
    assert.equal(r?.kind, 'token');
    if (r?.kind !== 'token') {
      throw new Error('narrowing');
    }
    assert.equal(r.coords.chain, 'tezos');
    assert.equal(r.coords.contract, 'KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton');
  });

  test('Objkt token URL with KT1 contract → token kind, source objkt', () => {
    const r = parseFindInput('https://objkt.com/tokens/KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton/9201');
    assert.equal(r?.kind, 'token');
    if (r?.kind !== 'token') {
      throw new Error('narrowing');
    }
    assert.equal(r.source, 'objkt');
    assert.equal(r.coords.chain, 'tezos');
  });

  test('Objkt token URL with alias → objkt-alias kind (needs async resolve)', () => {
    const r = parseFindInput('https://objkt.com/tokens/hicetnunc/111068');
    assert.equal(r?.kind, 'objkt-alias');
    if (r?.kind !== 'objkt-alias') {
      throw new Error('narrowing');
    }
    assert.equal(r.alias, 'hicetnunc');
    assert.equal(r.tokenId, '111068');
  });

  test('Objkt legacy /asset/ URL → token kind, source objkt', () => {
    const r = parseFindInput('https://objkt.com/asset/KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton/9201');
    assert.equal(r?.kind, 'token');
  });

  test('Objkt collection URL → unsupported', () => {
    const r = parseFindInput('https://objkt.com/collections/KT1Whatever');
    assert.equal(r?.kind, 'unsupported');
  });

  test('Art Blocks token URL → token kind, source artblocks', () => {
    const r = parseFindInput(
      'https://www.artblocks.io/token/0xababababab20053426ad1c782de9ea8444358070-5001410'
    );
    assert.equal(r?.kind, 'token');
    if (r?.kind !== 'token') {
      throw new Error('narrowing');
    }
    assert.equal(r.source, 'artblocks');
    assert.equal(r.coords.chain, 'ethereum');
  });

  test('Art Blocks marketplace token URL → token kind', () => {
    const r = parseFindInput(
      'https://www.artblocks.io/marketplace/collections/0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270/tokens/78000123'
    );
    assert.equal(r?.kind, 'token');
  });

  test('Art Blocks collection slug → ab-collection kind (needs async resolve)', () => {
    const r = parseFindInput('https://www.artblocks.io/collection/ringers-by-dmitri-cherniak');
    assert.equal(r?.kind, 'ab-collection');
    if (r?.kind !== 'ab-collection') {
      throw new Error('narrowing');
    }
    assert.equal(r.slug, 'ringers-by-dmitri-cherniak');
  });

  test('Art Blocks legacy /projects/{id} URL → unsupported with helpful message', () => {
    const r = parseFindInput('https://www.artblocks.io/projects/13');
    assert.equal(r?.kind, 'unsupported');
    if (r?.kind !== 'unsupported') {
      throw new Error('narrowing');
    }
    assert.ok(r.reason.includes('/projects/'));
  });

  test('fxhash FX1 gentk URL → token kind, source fxhash', () => {
    const r = parseFindInput(
      'https://www.fxhash.xyz/gentk/FX1-KT1U6EHmNxJTkvaWJ4ThczG4FSDaHC21ssvi-1234'
    );
    assert.equal(r?.kind, 'token');
    if (r?.kind !== 'token') {
      throw new Error('narrowing');
    }
    assert.equal(r.source, 'fxhash');
    assert.equal(r.coords.chain, 'tezos');
  });

  test('fxhash /iteration/{slug} URL → fxhash-iteration kind (needs async resolve)', () => {
    const r = parseFindInput('https://www.fxhash.xyz/iteration/garden-monoliths-215');
    assert.equal(r?.kind, 'fxhash-iteration');
    if (r?.kind !== 'fxhash-iteration') {
      throw new Error('narrowing');
    }
    assert.equal(r.slug, 'garden-monoliths-215');
  });

  test('fxhash /iteration/ bare (no slug) → unsupported', () => {
    const r = parseFindInput('https://www.fxhash.xyz/iteration/');
    assert.equal(r?.kind, 'unsupported');
  });

  test('fxhash FX2 gentk → unsupported (EVM out of scope)', () => {
    const r = parseFindInput('https://www.fxhash.xyz/gentk/FX2-0xabc-12');
    assert.equal(r?.kind, 'unsupported');
  });

  test('fxhash legacy numeric gentk → unsupported with hint', () => {
    const r = parseFindInput('https://www.fxhash.xyz/gentk/12345');
    assert.equal(r?.kind, 'unsupported');
  });

  test('fxhash /generative/{slug} URL → fxhash-project kind (needs async resolve)', () => {
    const r = parseFindInput('https://www.fxhash.xyz/generative/garden-monoliths');
    assert.equal(r?.kind, 'fxhash-project');
    if (r?.kind !== 'fxhash-project') {
      throw new Error('narrowing');
    }
    assert.equal(r.slug, 'garden-monoliths');
  });

  test('fxhash /project/{slug} URL → fxhash-project kind (current UI form)', () => {
    const r = parseFindInput('https://www.fxhash.xyz/project/garden-monoliths');
    assert.equal(r?.kind, 'fxhash-project');
    if (r?.kind !== 'fxhash-project') {
      throw new Error('narrowing');
    }
    assert.equal(r.slug, 'garden-monoliths');
  });

  test('OpenSea Ethereum token URL → token kind, source opensea', () => {
    const r = parseFindInput(
      'https://opensea.io/assets/ethereum/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1'
    );
    assert.equal(r?.kind, 'token');
    if (r?.kind !== 'token') {
      throw new Error('narrowing');
    }
    assert.equal(r.source, 'opensea');
  });

  test('OpenSea matic token URL → unsupported (FF indexer covers ETH/Tezos only)', () => {
    const r = parseFindInput(
      'https://opensea.io/assets/matic/0xabc1230000000000000000000000000000000000/1'
    );
    assert.equal(r?.kind, 'unsupported');
    if (r?.kind !== 'unsupported') {
      throw new Error('narrowing');
    }
    assert.ok(r.reason.includes('matic'));
  });

  test('OpenSea collection URL → unsupported with hint', () => {
    const r = parseFindInput('https://opensea.io/collection/azuki');
    assert.equal(r?.kind, 'unsupported');
  });

  test('SuperRare /artwork/eth/{contract}/{tokenId} → token kind, source superrare', () => {
    const r = parseFindInput(
      'https://superrare.com/artwork/eth/0x3e930455dcBf4bC69DE9926bDAF8ef782398786f/1'
    );
    assert.equal(r?.kind, 'token');
    if (r?.kind !== 'token') {
      throw new Error('narrowing');
    }
    assert.equal(r.source, 'superrare');
    assert.equal(r.coords.chain, 'ethereum');
    assert.equal(r.coords.contract, '0x3e930455dcbf4bc69de9926bdaf8ef782398786f');
    assert.equal(r.coords.tokenId, '1');
  });

  test('SuperRare artist-slug URL → unsupported with hint', () => {
    const r = parseFindInput('https://superrare.com/louisdazy/disassociative-1');
    assert.equal(r?.kind, 'unsupported');
    if (r?.kind !== 'unsupported') {
      throw new Error('narrowing');
    }
    assert.ok(r.reason.includes('/artwork/eth/'));
  });

  test('Neort /art/{id} URL → neort-art kind', () => {
    const r = parseFindInput('https://neort.io/art/ce3lvgkn70rlpj69ccc0');
    assert.equal(r?.kind, 'neort-art');
    if (r?.kind !== 'neort-art') {
      throw new Error('narrowing');
    }
    assert.equal(r.id, 'ce3lvgkn70rlpj69ccc0');
  });

  test('Neort /art/{id} URL with query params → neort-art kind (params ignored)', () => {
    const r = parseFindInput('https://neort.io/art/ce3lvgkn70rlpj69ccc0?index=-1&origin=');
    assert.equal(r?.kind, 'neort-art');
    if (r?.kind !== 'neort-art') {
      throw new Error('narrowing');
    }
    assert.equal(r.id, 'ce3lvgkn70rlpj69ccc0');
  });

  test('Neort root URL → unsupported with /art/{id} hint', () => {
    const r = parseFindInput('https://neort.io/');
    assert.equal(r?.kind, 'unsupported');
    if (r?.kind !== 'unsupported') {
      throw new Error('narrowing');
    }
    assert.ok(r.reason.includes('/art/'));
  });

  test('Verse item URL → token kind, source verse', () => {
    const r = parseFindInput(
      'https://verse.works/items/ethereum/0x23b72f7458a204446983f544d655df10f70533e9/139'
    );
    assert.equal(r?.kind, 'token');
    if (r?.kind !== 'token') {
      throw new Error('narrowing');
    }
    assert.equal(r.source, 'verse');
    assert.equal(r.coords.chain, 'ethereum');
    assert.equal(r.coords.contract, '0x23b72f7458a204446983f544d655df10f70533e9');
    assert.equal(r.coords.tokenId, '139');
  });

  test('Verse series URL → verse-series kind', () => {
    const r = parseFindInput('https://verse.works/series/quantizer-by-harm-van-den-dorpel');
    assert.equal(r?.kind, 'verse-series');
    if (r?.kind !== 'verse-series') {
      throw new Error('narrowing');
    }
    assert.equal(r.slug, 'quantizer-by-harm-van-den-dorpel');
  });

  test('Verse unsupported item chain → unsupported with chain hint', () => {
    const r = parseFindInput('https://verse.works/items/base/0xabc/1');
    assert.equal(r?.kind, 'unsupported');
    if (r?.kind !== 'unsupported') {
      throw new Error('narrowing');
    }
    assert.ok(r.reason.includes('base'));
  });

  test('SuperRare /collection/{contract} URL → unsupported with specific message', () => {
    const r = parseFindInput(
      'https://superrare.com/collection/0x3e930455dcBf4bC69DE9926bDAF8ef782398786f'
    );
    assert.equal(r?.kind, 'unsupported');
    if (r?.kind !== 'unsupported') {
      throw new Error('narrowing');
    }
    assert.ok(r.reason.includes('/collection/'));
    assert.ok(r.reason.includes('/artwork/eth/'));
  });

  test('Feral File /exhibitions/artwork/{tokenId} → ff-url kind, urlKind artwork', () => {
    const r = parseFindInput('https://feralfile.com/exhibitions/artwork/12345');
    assert.equal(r?.kind, 'ff-url');
    if (r?.kind !== 'ff-url') {
      throw new Error('narrowing');
    }
    assert.equal(r.urlKind, 'artwork');
    assert.equal(r.identifier, '12345');
  });

  test('Feral File /exhibitions/artwork/{hex-id} → ff-url (swapped-id form)', () => {
    const r = parseFindInput(
      'https://feralfile.com/exhibitions/artwork/f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf'
    );
    assert.equal(r?.kind, 'ff-url');
    if (r?.kind !== 'ff-url') {
      throw new Error('narrowing');
    }
    assert.equal(r.urlKind, 'artwork');
    assert.equal(r.identifier, 'f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf');
  });

  test('Feral File /exhibitions/series/{slug} → ff-url kind, urlKind series', () => {
    const r = parseFindInput('https://feralfile.com/exhibitions/series/some-slug');
    assert.equal(r?.kind, 'ff-url');
    if (r?.kind !== 'ff-url') {
      throw new Error('narrowing');
    }
    assert.equal(r.urlKind, 'series');
  });

  test('Feral File /exhibitions/shows/{slug} → ff-url kind, urlKind show', () => {
    const r = parseFindInput('https://feralfile.com/exhibitions/shows/some-slug');
    assert.equal(r?.kind, 'ff-url');
    if (r?.kind !== 'ff-url') {
      throw new Error('narrowing');
    }
    assert.equal(r.urlKind, 'show');
  });

  test('empty input → null', () => {
    assert.equal(parseFindInput(''), null);
  });

  test('non-URL junk → null', () => {
    assert.equal(parseFindInput('hello world'), null);
  });

  test('URL from an unrecognized host → null', () => {
    assert.equal(parseFindInput('https://example.com/foo'), null);
  });
});

describe('parseLimitOption', () => {
  test('undefined → POSITIVE_INFINITY', () => {
    assert.equal(parseLimitOption(undefined), Number.POSITIVE_INFINITY);
  });

  test('positive integer string → integer', () => {
    assert.equal(parseLimitOption('5'), 5);
    assert.equal(parseLimitOption('100'), 100);
  });

  test('trailing garbage ("5abc") → throws (no silent truncation)', () => {
    assert.throws(() => parseLimitOption('5abc'), /Invalid --limit/);
  });

  test('zero → throws', () => {
    assert.throws(() => parseLimitOption('0'), /Invalid --limit/);
  });

  test('negative → throws', () => {
    assert.throws(() => parseLimitOption('-3'), /Invalid --limit/);
  });

  test('non-numeric → throws', () => {
    assert.throws(() => parseLimitOption('abc'), /Invalid --limit/);
  });

  test('floating point → throws', () => {
    assert.throws(() => parseLimitOption('5.5'), /Invalid --limit/);
  });

  test('empty string → throws', () => {
    assert.throws(() => parseLimitOption(''), /Invalid --limit/);
  });

  test('1024 (DP-1 max) → accepted', () => {
    assert.equal(parseLimitOption('1024'), 1024);
  });

  test('1025 (one over DP-1 max) → throws with spec reference', () => {
    assert.throws(() => parseLimitOption('1025'), /exceeds DP-1 playlist max of 1024/);
  });

  test('5000 (well over DP-1 max) → throws', () => {
    assert.throws(() => parseLimitOption('5000'), /exceeds DP-1 playlist max/);
  });
});

describe('decideActions', () => {
  test('--play alone → [play]', async () => {
    const actions = await decideActions({ play: true });
    assert.deepEqual(actions, ['play']);
  });

  test('--publish alone → [publish]', async () => {
    const actions = await decideActions({ publish: true });
    assert.deepEqual(actions, ['publish']);
  });

  test('--play --publish → [play, publish] (combined actions)', async () => {
    const actions = await decideActions({ play: true, publish: true });
    assert.deepEqual(actions, ['play', 'publish']);
  });

  test('--output alone (with --yes) → [] (save-only, no extra action)', async () => {
    const actions = await decideActions({ output: '/tmp/x.json', yes: true });
    assert.deepEqual(actions, []);
  });

  test('--output --play → [play] (action flag wins; save happens unconditionally upstream)', async () => {
    const actions = await decideActions({ output: '/tmp/x.json', play: true });
    assert.deepEqual(actions, ['play']);
  });

  test('--yes alone → [play] (default action for non-interactive use)', async () => {
    const actions = await decideActions({ yes: true });
    assert.deepEqual(actions, ['play']);
  });

  test('--yes --publish → [publish] (publish flag overrides default Play)', async () => {
    const actions = await decideActions({ yes: true, publish: true });
    assert.deepEqual(actions, ['publish']);
  });
});
