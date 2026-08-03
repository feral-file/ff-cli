/**
 * `play` accepts DP-1 feed playlist URLs that the discovery parser claims.
 *
 * The discovery parser claims whole hosts — any *.feralfile.com URL parses
 * as a Feral File URL, and non-exhibition paths come back `unsupported` —
 * which wrongly redirected DP-1 feed playlist URLs
 * (https://feed.feralfile.com/api/v1/playlists/{slug}, exactly the URLs the
 * feed hands out) to `find`, which has no feed route either. The documented
 * "hosted playlist URL plays directly" contract was unreachable for them.
 *
 * probeDiscoveryUrlAsPlaylist pins the repair: a discovery-classified URL
 * that actually serves a DP-1 document (dpVersion marker) resolves as a
 * playlist; anything else still redirects to `find` — a marketplace *page*
 * must never be wrapped as a web item.
 */
import assert from 'node:assert/strict';
import { describe, test, afterEach } from 'node:test';
import { describeDiscoveryInput, probeDiscoveryUrlAsPlaylist } from '../src/commands/play';

const FEED_URL = 'https://feed.feralfile.com/api/v1/playlists/scott-night-91aa';

const feedPlaylist = {
  dpVersion: '1.1.0',
  id: '91aa260a-a71c-4a29-8f9a-000000000000',
  title: 'Scott — Night',
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

function mockFetchOnce(body: string, status = 200): void {
  global.fetch = (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('probeDiscoveryUrlAsPlaylist — feed playlist URLs play directly', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('the feed URL shape is still discovery-classified (why the probe exists)', () => {
    // If the discovery parser ever learns feed URLs, this pin fails and the
    // probe can likely be deleted — that is the desired outcome, not a bug.
    assert.notEqual(describeDiscoveryInput(FEED_URL), null);
  });

  test('a discovery-claimed URL serving a DP-1 document resolves as a playlist', async () => {
    mockFetchOnce(JSON.stringify(feedPlaylist));

    const resolved = await probeDiscoveryUrlAsPlaylist(FEED_URL);
    assert.ok(resolved);
    assert.equal(resolved.kind, 'playlist');
    if (resolved.kind === 'playlist') {
      assert.equal(resolved.sourceType, 'url');
      assert.equal(resolved.source, FEED_URL);
      assert.equal(resolved.playlist.title, 'Scott — Night');
    }
  });

  test('a marketplace page (non-JSON) fails the probe and keeps redirecting', async () => {
    mockFetchOnce('<html><body>collection page</body></html>');

    assert.equal(await probeDiscoveryUrlAsPlaylist(FEED_URL), null);
  });

  test('JSON without a dpVersion marker fails the probe', async () => {
    mockFetchOnce(JSON.stringify({ items: [], hello: 'world' }));

    assert.equal(await probeDiscoveryUrlAsPlaylist(FEED_URL), null);
  });

  test('an HTTP error fails the probe', async () => {
    mockFetchOnce('not found', 404);

    assert.equal(await probeDiscoveryUrlAsPlaylist(FEED_URL), null);
  });

  test('non-URL discovery inputs are never probed', async () => {
    // A wallet address must redirect to `find` without any network call.
    global.fetch = (async () => {
      throw new Error('probe must not fetch for non-URL inputs');
    }) as unknown as typeof fetch;

    assert.equal(
      await probeDiscoveryUrlAsPlaylist('0xf3860788d1597cecf938424baabe976fac87dc26'),
      null
    );
  });
});
