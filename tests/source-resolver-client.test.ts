/**
 * Tests for the ff-source-resolver-service transport and route wrappers.
 *
 * The error split is the contract `find` degrades on: anything that means the
 * service cannot serve this run (unreachable, a body that dies mid-stream, a
 * 5xx, the service refusing ff-cli's key) is SourceResolverUnavailableError,
 * and an input the service rejects stays a plain Error with its message.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  DEFAULT_SOURCE_RESOLVER_URL,
  SourceResolverUnavailableError,
  isSourceResolverUnavailable,
  serviceRequest,
  sourceResolverUrl,
} from '../src/utilities/source-resolver-client';
import {
  feralFileArtworkLink,
  lookupFeralFileArtwork,
  lookupPageTokens,
  lookupRasterArtistWorks,
  lookupRasterTokens,
  lookupSeriesPage,
} from '../src/utilities/source-resolver-lookups';

type FetchFn = typeof fetch;

/** Seen is one request the mock fetch received. */
interface Seen {
  url: URL;
  init: RequestInit | undefined;
}

let seen: Seen[] = [];
const originalFetch = global.fetch;
const originalEnv = {
  url: process.env.SOURCE_RESOLVER_URL,
  key: process.env.FF_SOURCE_RESOLVER_API_KEY,
};

/** respondWith installs a fetch that records each request and answers from `answer`. */
function respondWith(answer: (url: URL) => Response | Promise<Response>): void {
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, init });
    return answer(url);
  }) as FetchFn;
}

/** json builds a JSON response. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  seen = [];
  process.env.SOURCE_RESOLVER_URL = 'http://resolver.test/';
  delete process.env.FF_SOURCE_RESOLVER_API_KEY;
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const [name, value] of [
    ['SOURCE_RESOLVER_URL', originalEnv.url],
    ['FF_SOURCE_RESOLVER_API_KEY', originalEnv.key],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('service location and key', () => {
  test('SOURCE_RESOLVER_URL overrides the production service, without a trailing slash', () => {
    assert.equal(sourceResolverUrl(), 'http://resolver.test');
    delete process.env.SOURCE_RESOLVER_URL;
    assert.equal(sourceResolverUrl(), DEFAULT_SOURCE_RESOLVER_URL);
  });

  test('FF_SOURCE_RESOLVER_API_KEY is sent as the API-KEY header with the CLI user agent', async () => {
    process.env.FF_SOURCE_RESOLVER_API_KEY = 'test-client-key';
    respondWith(() => json({ ok: true }));
    await serviceRequest({ path: '/work', query: { url: 'x', empty: '' } });
    const headers = seen[0].init?.headers as Record<string, string>;
    assert.equal(headers['API-KEY'], 'test-client-key');
    assert.match(headers['User-Agent'], /^ff-cli\//);
    // Unset and empty query values are not sent.
    assert.equal(seen[0].url.toString(), 'http://resolver.test/work?url=x');
  });
});

describe('serviceRequest error split', () => {
  test('a connect failure is unavailability naming the URL and the cause', async () => {
    global.fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { message: 'connect ECONNREFUSED' },
      });
    }) as unknown as FetchFn;
    await assert.rejects(
      () => serviceRequest({ path: '/work', query: { url: 'x' } }),
      (error: unknown) =>
        error instanceof SourceResolverUnavailableError &&
        /unreachable \(http:\/\/resolver\.test\/work\?url=x\): connect ECONNREFUSED/.test(
          (error as Error).message
        )
    );
  });

  test('a body that ends mid-stream is unavailability, not a parse error', async () => {
    respondWith(
      () => new Response('{"found": tr', { headers: { 'Content-Type': 'application/json' } })
    );
    await assert.rejects(
      () => serviceRequest({ path: '/work' }),
      (error: unknown) =>
        isSourceResolverUnavailable(error) && /response body failed/.test((error as Error).message)
    );
  });

  test('the service refusing the key (400 "Unauthorized.") is unavailability', async () => {
    respondWith(() =>
      json({ kind: 'error', code: 'INVALID_INPUT', message: 'Unauthorized.' }, 400)
    );
    await assert.rejects(
      () => serviceRequest({ path: '/work' }),
      (error: unknown) =>
        isSourceResolverUnavailable(error) &&
        /400 INVALID_INPUT: Unauthorized\. \(it refused this ff-cli's key\)/.test(
          (error as Error).message
        )
    );
  });

  for (const status of [401, 403, 429]) {
    test(`a gateway refusing with ${status} is unavailability`, async () => {
      respondWith(() => new Response('denied', { status }));
      await assert.rejects(() => serviceRequest({ path: '/work' }), isSourceResolverUnavailable);
    });
  }

  test('502 UPSTREAM_UNAVAILABLE is unavailability carrying the upstream', async () => {
    respondWith(() =>
      json({ kind: 'error', code: 'UPSTREAM_UNAVAILABLE', message: 'api.raster.art 429' }, 502)
    );
    await assert.rejects(
      () => serviceRequest({ path: '/series' }),
      (error: unknown) =>
        isSourceResolverUnavailable(error) &&
        /502 UPSTREAM_UNAVAILABLE: api\.raster\.art 429/.test((error as Error).message)
    );
  });

  test('any other 400 is an input error with the service message, never a degrade', async () => {
    respondWith(() =>
      json({ kind: 'error', code: 'INVALID_INPUT', message: 'address must be an address.' }, 400)
    );
    await assert.rejects(
      () => serviceRequest({ path: '/raster/artists' }),
      (error: unknown) =>
        !isSourceResolverUnavailable(error) &&
        /400 INVALID_INPUT: address must be an address\./.test((error as Error).message)
    );
  });

  test('an unknown series is null, not an error', async () => {
    respondWith(() => json({ kind: 'error', code: 'SERIES_NOT_FOUND', message: 'not found' }, 404));
    assert.equal(await lookupSeriesPage('missing'), null);
    assert.equal(seen[0].url.searchParams.get('slug'), 'missing');
  });
});

describe('route wrappers', () => {
  test('lookupRasterTokens refuses more than 40 refs and sends nothing for none', async () => {
    respondWith(() => json({ tokens: [] }));
    const ref = { chain: 'ethereum' as const, contract: '0x1', tokenId: '1' };
    await assert.rejects(() => lookupRasterTokens(Array(41).fill(ref)), /at most 40 refs/);
    assert.deepEqual(await lookupRasterTokens([]), []);
    assert.equal(seen.length, 0);
  });

  test('lookupRasterTokens posts the refs and aligns answers, null for a miss', async () => {
    respondWith(() => json({ tokens: [null] }));
    const ref = { chain: 'tezos' as const, contract: 'KT1', tokenId: '7' };
    assert.deepEqual(await lookupRasterTokens([ref, ref]), [null, null]);
    assert.equal(seen[0].url.pathname, '/raster/tokens');
    assert.equal(seen[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { refs: [ref, ref] });
  });

  test('lookupRasterArtistWorks walks every page of an artist catalog', async () => {
    const pages: Record<string, unknown> = {
      '': { works: [{ id: '1', slug: 'a', title: 'A' }], next: 'c1' },
      c1: { works: [{ id: '2', slug: 'b', title: 'B' }], next: '' },
    };
    respondWith((url) => json(pages[url.searchParams.get('after') ?? '']));
    const works = await lookupRasterArtistWorks('7');
    assert.deepEqual(
      works.map((w) => w.slug),
      ['a', 'b']
    );
    assert.equal(seen[0].url.searchParams.get('first'), '40');
    assert.equal(seen[1].url.searchParams.get('after'), 'c1');
  });

  test('lookupPageTokens reads Ethereum and Tezos coordinates off a /tokens playlist', async () => {
    respondWith(() =>
      json({
        title: 'A Collection',
        items: [
          { provenance: { contract: { chain: 'evm', address: '0xAbc', tokenId: '1' } } },
          { provenance: { contract: { chain: 'tezos', address: 'KT1x', tokenId: '2' } } },
          { provenance: { contract: { chain: 'bitmark', address: 'b', tokenId: '3' } } },
          { source: 'https://example.com/no-provenance.png' },
        ],
      })
    );
    assert.deepEqual(await lookupPageTokens('https://objkt.com/collections/KT1x'), {
      title: 'A Collection',
      coords: [
        { chain: 'ethereum', contract: '0xAbc', tokenId: '1' },
        { chain: 'tezos', contract: 'KT1x', tokenId: '2' },
      ],
    });
    assert.equal(seen[0].url.pathname, '/tokens');
  });
});

describe('Feral File artworks for `build`', () => {
  test('raw ids and both artwork URL forms become the artwork page link', () => {
    assert.equal(feralFileArtworkLink('abc12345'), 'https://feralfile.com/artworks/abc12345');
    assert.equal(
      feralFileArtworkLink('https://feralfile.com/exhibitions/artwork/abc12345/'),
      'https://feralfile.com/artworks/abc12345'
    );
    assert.equal(
      feralFileArtworkLink('https://www.feralfile.com/artworks/abc12345'),
      'https://feralfile.com/artworks/abc12345'
    );
    assert.throws(() => feralFileArtworkLink(' '), /artwork id is required/);
    assert.throws(() => feralFileArtworkLink('https://example.com/x'), /Unsupported .* host/);
    assert.throws(
      () => feralFileArtworkLink('https://feralfile.com/exhibitions/shows/x'),
      /Unsupported Feral File artwork URL path/
    );
  });

  test('the token comes from the service answer, which carries swapped ids', async () => {
    respondWith(() =>
      json({
        found: true,
        work: { chain: 'ethereum', contract: '0xC0ffee', tokenId: '42', title: 'T', artist: 'A' },
        diag: [],
      })
    );
    assert.deepEqual(await lookupFeralFileArtwork('abc12345'), {
      chain: 'ethereum',
      contractAddress: '0xC0ffee',
      tokenId: '42',
    });
    assert.equal(seen[0].url.searchParams.get('url'), 'https://feralfile.com/artworks/abc12345');
  });

  test('an artwork with no on-chain token is an error, never a guess', async () => {
    respondWith(() =>
      json({
        found: true,
        work: { chain: 'other', contract: '', tokenId: '', title: 'T', artist: 'A' },
        diag: [],
      })
    );
    await assert.rejects(() => lookupFeralFileArtwork('abc12345'), /no Ethereum or Tezos token/);
  });
});
