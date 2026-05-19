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
import type { Playlist } from '../src/types';
import { parseFindInput } from '../src/utilities/marketplace-url';
import { resolveFeralFileToken } from '../src/utilities/ff-marketplace';
import {
  parseLimitOption,
  parseServerIndexOption,
  decideActions,
  prepareGeneratedPlaylistForPlayback,
  doPlay,
} from '../src/commands/find';

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

  test('fxhash FX2 gentk → unsupported (EVM out of scope)', () => {
    const r = parseFindInput('https://www.fxhash.xyz/gentk/FX2-0xabc-12');
    assert.equal(r?.kind, 'unsupported');
  });

  test('fxhash legacy numeric gentk → unsupported with hint', () => {
    const r = parseFindInput('https://www.fxhash.xyz/gentk/12345');
    assert.equal(r?.kind, 'unsupported');
  });

  test('fxhash generative URL (series) → unsupported', () => {
    const r = parseFindInput('https://www.fxhash.xyz/generative/slug');
    assert.equal(r?.kind, 'unsupported');
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

  test('Feral File /exhibitions/artwork/{id} → ff-url kind, urlKind artwork', () => {
    const r = parseFindInput('https://feralfile.com/exhibitions/artwork/12345');
    assert.equal(r?.kind, 'ff-url');
    if (r?.kind !== 'ff-url') {
      throw new Error('narrowing');
    }
    assert.equal(r.urlKind, 'artwork');
    assert.equal(r.identifier, '12345');
  });

  test('Feral File swapped artwork IDs can be non-numeric public tokens', () => {
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

describe('resolveFeralFileToken', () => {
  test('artwork URL resolves from one self-describing artwork API call', async () => {
    await withMockFetch(async (calls) => {
      const coords = await resolveFeralFileToken({
        urlKind: 'artwork',
        identifier: 'f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf',
      });

      assert.deepEqual(calls, [
        'https://feralfile.com/api/artworks/f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf',
      ]);
      assert.deepEqual(coords, {
        chain: 'ethereum',
        contract: '0xdb5f1adcffa1869b9711cbfbe3bf46cc5d5319e5',
        tokenId: '92419109143972345096969611651362597777388673613154609693448331487805624917924',
      });
    });
  });

  test('series URL uses artwork list identity without exhibition contract walk', async () => {
    await withMockFetch(async (calls) => {
      const coords = await resolveFeralFileToken({
        urlKind: 'series',
        identifier: 'e-volved-formula-02-u9c',
      });

      assert.deepEqual(calls, [
        'https://feralfile.com/api/series?slug=e-volved-formula-02-u9c',
        'https://feralfile.com/api/artworks?seriesID=a2ec59c2-a56e-488c-9fdf-a67e04117337',
      ]);
      assert.deepEqual(coords, {
        chain: 'ethereum',
        contract: '0xffe213c3faa18b4b80ac1658c363d471dc745886',
        tokenId: '54927077953071573898060197382410853987230099039252111790486496240282061669504',
      });
    });
  });

  test('series URL rejects duplicate slug matches instead of guessing', async () => {
    await withMockFetch(
      async () => {
        await assert.rejects(
          resolveFeralFileToken({
            urlKind: 'series',
            identifier: 'duplicate-slug',
          }),
          /matched 2 series/
        );
      },
      { duplicateSeriesSlug: true }
    );
  });

  test('artwork identity requires tokenID so swapped IDs cannot index the wrong token', async () => {
    await withMockFetch(
      async () => {
        await assert.rejects(
          resolveFeralFileToken({ urlKind: 'artwork', identifier: '12345' }),
          /missing tokenID/
        );
      },
      { omitArtworkTokenID: true }
    );
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
});

describe('parseServerIndexOption', () => {
  test('zero-based integer string → server index', () => {
    assert.equal(parseServerIndexOption('0', 2), 0);
    assert.equal(parseServerIndexOption('1', 2), 1);
  });

  test('prefix-numeric value rejects instead of truncating', () => {
    assert.throws(() => parseServerIndexOption('1abc', 3), /Invalid server index/);
  });

  test('decimal value rejects instead of truncating', () => {
    assert.throws(() => parseServerIndexOption('1.5', 3), /Invalid server index/);
  });

  test('out-of-range value rejects', () => {
    assert.throws(() => parseServerIndexOption('2', 2), /Invalid server index/);
  });

  test('negative value rejects', () => {
    assert.throws(() => parseServerIndexOption('-1', 2), /Invalid server index/);
  });
});

interface MockFetchOptions {
  duplicateSeriesSlug?: boolean;
  omitArtworkTokenID?: boolean;
}

async function withMockFetch(
  run: (calls: string[]) => Promise<void>,
  options: MockFetchOptions = {}
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/series?slug=e-volved-formula-02-u9c')) {
      return jsonResponse({
        result: [
          {
            id: 'a2ec59c2-a56e-488c-9fdf-a67e04117337',
            exhibitionID: '796f9fd9-d405-451c-a584-d9f21222c6dd',
            slug: 'e-volved-formula-02-u9c',
          },
        ],
      });
    }
    if (url.endsWith('/api/series?slug=duplicate-slug')) {
      return jsonResponse({
        result: options.duplicateSeriesSlug
          ? [
              {
                id: 'first-series-id',
                exhibitionID: 'first-exhibition-id',
                slug: 'duplicate-slug',
              },
              {
                id: 'second-series-id',
                exhibitionID: 'second-exhibition-id',
                slug: 'duplicate-slug',
              },
            ]
          : [],
      });
    }
    if (url.endsWith('/api/artworks?seriesID=a2ec59c2-a56e-488c-9fdf-a67e04117337')) {
      return jsonResponse({
        result: [
          {
            id: '54927077953071573898060197382410853987230099039252111790486496240282061669504',
            seriesID: 'a2ec59c2-a56e-488c-9fdf-a67e04117337',
            chain: 'ethereum',
            contractAddress: '0xFfE213c3faA18B4B80aC1658C363D471dC745886',
            tokenID:
              '54927077953071573898060197382410853987230099039252111790486496240282061669504',
          },
        ],
      });
    }
    if (url.includes('/api/artworks/')) {
      return jsonResponse({
        result: {
          id: 'f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf',
          seriesID: '1b1ffd48-5fc2-4d19-a563-364e00ddfb01',
          chain: 'ethereum',
          contractAddress: '0xDB5f1aDCFFA1869B9711cBFBe3Bf46cc5d5319E5',
          ...(options.omitArtworkTokenID
            ? {}
            : {
                tokenID:
                  '92419109143972345096969611651362597777388673613154609693448331487805624917924',
              }),
        },
      });
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  };

  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

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

describe('find playback signing gate', () => {
  test('prepareGeneratedPlaylistForPlayback fails unsigned generated playlists without a signing key', async () => {
    let signCalled = false;
    const result = await prepareGeneratedPlaylistForPlayback(makeUnsignedPlaylist(), {
      getPrivateKey: () => undefined,
      signPlaylist: async () => {
        signCalled = true;
        throw new Error('sign should not be called without a key');
      },
      verifyPlaylist: async () => ({
        valid: false,
        error: 'Playlist signature verification failed',
      }),
    });

    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /no playlist signing key is configured/i);
    assert.equal(signCalled, false);
  });

  test('doPlay fails before device transport when generated playlist cannot be signed', async () => {
    const previousExitCode = process.exitCode;
    let sendCalled = false;
    process.exitCode = undefined;

    try {
      await doPlay(makeUnsignedPlaylist(), 'studio', {
        preparePlaylistForPlayback: async () => ({
          valid: false,
          error: 'Cannot sign playlist for playback: no playlist signing key is configured',
        }),
        sendPlaylistToDevice: async () => {
          sendCalled = true;
          return { success: true };
        },
      });

      assert.equal(sendCalled, false);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test('doPlay signs, verifies, and sends the signed generated playlist', async () => {
    const previousExitCode = process.exitCode;
    let signedPayload: Playlist | undefined;
    process.exitCode = undefined;

    try {
      await doPlay(makeUnsignedPlaylist(), 'studio', {
        preparePlaylistForPlayback: async (playlist) => ({
          valid: true,
          playlist: {
            ...playlist,
            signatures: [{ role: 'creator', publicKey: 'pub', sig: 'sig' }],
          } as unknown as Playlist,
        }),
        sendPlaylistToDevice: async ({ playlist, deviceName }) => {
          assert.equal(deviceName, 'studio');
          signedPayload = playlist;
          return { success: true, deviceName, device: 'http://127.0.0.1:1111' };
        },
      });

      const signatures = (signedPayload as unknown as { signatures?: unknown[] })?.signatures;
      assert.equal(Array.isArray(signatures), true);
      assert.equal(signatures?.length, 1);
      assert.equal(process.exitCode, undefined);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

function makeUnsignedPlaylist(): Playlist {
  return {
    id: 'find-playback-test',
    title: 'Find Playback Test',
    slug: 'find-playback-test',
    created: '2026-05-19T00:00:00.000Z',
    dpVersion: '1.1.0',
    items: [
      {
        id: 'item-1',
        title: 'Item 1',
        source: {
          type: 'url',
          url: 'https://example.com/item-1.mp4',
        },
        display: {
          duration: 10,
        },
        created: '2026-05-19T00:00:00.000Z',
      },
    ],
  } as unknown as Playlist;
}
