/**
 * `display <page address>` displays the DP-1 playlist the page declares.
 *
 * A page names its playlist with
 * `<link rel="alternate" type="application/json" href="…" title="DP-1 playlist">`
 * (the form feralfile.com exhibition pages carry). These tests pin the rules
 * decided with the feature: the playlist is followed on any host, including
 * hosts the discovery parser claims; a channel link is never followed; a page
 * that declares nothing behaves as before; and a declared playlist that does
 * not load is an error, never a silent fall back to the page.
 */
import assert from 'node:assert/strict';
import { describe, test, afterEach } from 'node:test';
import { describeDiscoveryInput, probeDiscoveryUrlAsPlaylist } from '../src/commands/play';
import { findDeclaredPlaylistUrl } from '../src/utilities/page-playlist-link';
import { resolvePlaySource } from '../src/utilities/playlist-source';

const FF_PAGE = 'https://feralfile.com/exhibitions/e-volved-formulae-8an';
const FF_PLAYLIST = `${FF_PAGE}/playlist.json`;
const OTHER_PAGE = 'https://example.org/shows/chains/test-001.html';

const playlist = {
  dpVersion: '1.1.0',
  id: '8f0c2a8e-0000-4000-8000-000000000000',
  title: 'E-volved Formulae',
  items: [
    {
      id: 'item-1',
      title: 'item one',
      source: 'https://example.com/a.html',
      duration: 300,
      license: 'open',
    },
  ],
};

/** The head feralfile.com serves: channel first, then playlist. */
const ffPageHtml = `<!doctype html><html><head><title>E-volved Formulae</title>
<link rel="alternate" type="application/json" href="${FF_PAGE}/channel.json" title="DP-1 channel">
<link rel="alternate" type="application/json" href="${FF_PLAYLIST}" title="DP-1 playlist">
</head><body>exhibition</body></html>`;

/**
 * mockFetch answers each URL from `routes` and records what was asked for.
 * An unlisted URL answers 404 so a wrong request fails loudly.
 */
function mockFetch(routes: Record<string, { body: string; status?: number }>): string[] {
  const requested: string[] = [];
  global.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const route = routes[url];
    return new Response(route?.body ?? 'not found', {
      status: route ? (route.status ?? 200) : 404,
    });
  }) as unknown as typeof fetch;
  return requested;
}

describe('findDeclaredPlaylistUrl', () => {
  test('returns the playlist link and ignores the channel link', () => {
    assert.equal(findDeclaredPlaylistUrl(ffPageHtml, FF_PAGE), FF_PLAYLIST);
  });

  test('resolves a relative href against the page URL', () => {
    const html = `<link rel="alternate" type="application/json" href="../playlists/test-001.json" title="DP-1 playlist">`;
    assert.equal(
      findDeclaredPlaylistUrl(html, OTHER_PAGE),
      'https://example.org/shows/playlists/test-001.json'
    );
  });

  test('accepts single quotes, any attribute order, and title case differences', () => {
    const html = `<LINK title=' dp-1 Playlist ' href='/p.json?a=1&amp;b=2' rel='Alternate nofollow'>`;
    assert.equal(findDeclaredPlaylistUrl(html, OTHER_PAGE), 'https://example.org/p.json?a=1&b=2');
  });

  test('a page with only a channel link declares no playlist', () => {
    const html = `<link rel="alternate" type="application/json" href="/channel.json" title="DP-1 channel">`;
    assert.equal(findDeclaredPlaylistUrl(html, OTHER_PAGE), null);
  });

  test('a link that is not rel=alternate is ignored', () => {
    const html = `<link rel="stylesheet" href="/p.json" title="DP-1 playlist">`;
    assert.equal(findDeclaredPlaylistUrl(html, OTHER_PAGE), null);
  });

  test('a non-http(s) href is skipped', () => {
    const html = `<link rel="alternate" href="file:///etc/passwd" title="DP-1 playlist">
<link rel="alternate" href="javascript:alert(1)" title="DP-1 playlist">`;
    assert.equal(findDeclaredPlaylistUrl(html, OTHER_PAGE), null);
  });
});

describe('display follows the playlist a page declares', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('a feralfile.com exhibition address is discovery-classified (why the probe handles it)', () => {
    assert.notEqual(describeDiscoveryInput(FF_PAGE), null);
  });

  test('a discovery-claimed page that declares a playlist resolves to that playlist', async () => {
    const requested = mockFetch({
      [FF_PAGE]: { body: ffPageHtml },
      [FF_PLAYLIST]: { body: JSON.stringify(playlist) },
    });

    const resolved = await probeDiscoveryUrlAsPlaylist(FF_PAGE);
    assert.ok(resolved);
    assert.equal(resolved.kind, 'playlist');
    if (resolved.kind === 'playlist') {
      assert.equal(resolved.source, FF_PLAYLIST);
      assert.equal(resolved.declaredBy, FF_PAGE);
      assert.equal(resolved.playlist.title, 'E-volved Formulae');
    }
    // The page is fetched once; its text is reused to find the link.
    assert.deepEqual(requested, [FF_PAGE, FF_PLAYLIST]);
  });

  test('a discovery-claimed page that declares nothing still redirects to find', async () => {
    mockFetch({ [FF_PAGE]: { body: '<html><head></head><body>collection</body></html>' } });
    assert.equal(await probeDiscoveryUrlAsPlaylist(FF_PAGE), null);
  });

  test('a page on any other host that declares a playlist resolves to it', async () => {
    const declared = 'https://example.org/shows/playlists/test-001.json';
    mockFetch({
      [OTHER_PAGE]: {
        body: `<html><head><link rel="alternate" type="application/json" href="../playlists/test-001.json" title="DP-1 playlist"></head></html>`,
      },
      [declared]: { body: JSON.stringify(playlist) },
    });

    const resolved = await resolvePlaySource(OTHER_PAGE);
    assert.equal(resolved.kind, 'playlist');
    if (resolved.kind === 'playlist') {
      assert.equal(resolved.source, declared);
      assert.equal(resolved.declaredBy, OTHER_PAGE);
    }
  });

  test('a page that declares nothing is still sent as a web page', async () => {
    mockFetch({ [OTHER_PAGE]: { body: '<html><head><title>hi</title></head></html>' } });

    const resolved = await resolvePlaySource(OTHER_PAGE);
    assert.equal(resolved.kind, 'media');
    assert.equal(resolved.source, OTHER_PAGE);
  });

  test('a declared playlist that is missing is an error naming --web, not the page', async () => {
    mockFetch({ [FF_PAGE]: { body: ffPageHtml } });

    await assert.rejects(
      () => probeDiscoveryUrlAsPlaylist(FF_PAGE),
      (error: Error) => {
        assert.match(error.message, /declares a DP-1 playlist at .*playlist\.json/);
        assert.match(error.message, /could not be loaded/);
        assert.match(error.message, /Nothing was sent/);
        assert.match(error.message, /display --web/);
        return true;
      }
    );
  });

  test('a declared document without dpVersion is an error, not the page', async () => {
    mockFetch({
      [FF_PAGE]: { body: ffPageHtml },
      [FF_PLAYLIST]: { body: JSON.stringify({ hello: 'world' }) },
    });

    await assert.rejects(() => resolvePlaySource(FF_PAGE), /not a DP-1 playlist/);
  });
});
