import assert from 'node:assert/strict';
import { describe, test, before, after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMediaPlaySource, resolvePlaySource } from '../src/utilities/playlist-source';
import { validatePlaylist } from '../src/utilities/playlist-verifier';

const samplePlaylist = {
  dpVersion: '1.0.0',
  id: 'test-playlist',
  title: 'sample',
  items: [
    {
      id: 'item-1',
      title: 'item one',
      source: 'https://example.com/a.mp4',
      duration: 5,
      license: 'open',
    },
  ],
};

describe('resolvePlaySource', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ff-cli-play-source-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('rejects an empty source', async () => {
    await assert.rejects(() => resolvePlaySource('   ', 10), /required/i);
  });

  test('returns kind=playlist with sourceType=file for a local playlist file', async () => {
    const path = join(tmp, 'pl.json');
    writeFileSync(path, JSON.stringify(samplePlaylist), 'utf-8');

    const result = await resolvePlaySource(path, 10);
    assert.equal(result.kind, 'playlist');
    if (result.kind === 'playlist') {
      assert.equal(result.sourceType, 'file');
      assert.equal(result.source, path);
      assert.equal(result.playlist.id, 'test-playlist');
    }
  });

  test('throws when a non-URL file path cannot be loaded', async () => {
    await assert.rejects(
      () => resolvePlaySource(join(tmp, 'does-not-exist.json'), 10),
      /not found/i
    );
  });

  test('returns kind=playlist with sourceType=url for a hosted playlist', async () => {
    const original = global.fetch;
    global.fetch = async () =>
      new Response(JSON.stringify(samplePlaylist), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    try {
      const result = await resolvePlaySource('https://example.com/playlist.json', 10);
      assert.equal(result.kind, 'playlist');
      if (result.kind === 'playlist') {
        assert.equal(result.sourceType, 'url');
        assert.equal(result.playlist.id, 'test-playlist');
      }
    } finally {
      global.fetch = original;
    }
  });

  test('falls back to kind=media when a URL fails to load as a playlist', async () => {
    const original = global.fetch;
    global.fetch = async () =>
      new Response('binary-bytes', {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      });

    try {
      const result = await resolvePlaySource('https://example.com/clip.mp4', 7);
      assert.equal(result.kind, 'media');
      if (result.kind === 'media') {
        assert.equal(result.source, 'https://example.com/clip.mp4');
        assert.equal(result.playlist.items.length, 1);
        assert.equal(result.playlist.items[0].duration, 7);
        const validated = await validatePlaylist(result.playlist);
        assert.equal(
          validated.valid,
          true,
          'synthesized media playlist must pass the same structure check `play` uses'
        );
      }
    } finally {
      global.fetch = original;
    }
  });

  test('falls back to kind=media with a note when the server refuses the CLI', async () => {
    // Bot protection often answers 403 to a command-line client while the
    // device, fetching as a browser, gets the page. Send it, but say so.
    const original = global.fetch;
    global.fetch = async () => new Response('forbidden', { status: 403 });

    try {
      const result = await resolvePlaySource('https://example.com/clip.mp4', 10);
      assert.equal(result.kind, 'media');
      if (result.kind === 'media') {
        assert.match(result.note ?? '', /403/);
        assert.match(result.note ?? '', /sending it to the device anyway/);
      }
    } finally {
      global.fetch = original;
    }
  });

  test('an ordinary web page wraps as media with no note', async () => {
    const original = global.fetch;
    global.fetch = async () =>
      new Response('<html><body>art</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });

    try {
      const result = await resolvePlaySource('https://example.com/', undefined);
      assert.equal(result.kind, 'media');
      if (result.kind === 'media') {
        assert.equal(result.note, undefined);
        assert.equal(result.playlist.items[0].source, 'https://example.com/');
      }
    } finally {
      global.fetch = original;
    }
  });

  for (const status of [404, 410]) {
    test(`refuses a URL that answers ${status} instead of casting the error page`, async () => {
      const original = global.fetch;
      global.fetch = async () => new Response('gone', { status });

      try {
        await assert.rejects(
          () => resolvePlaySource('https://example.com/missing', 10),
          new RegExp(`Nothing at https://example\\.com/missing \\(HTTP ${status}\\)`)
        );
      } finally {
        global.fetch = original;
      }
    });
  }

  test('refuses a host that does not resolve', async () => {
    const original = global.fetch;
    global.fetch = async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), {
          code: 'ENOTFOUND',
        }),
      });
    };

    try {
      await assert.rejects(
        () => resolvePlaySource('https://nope.invalid/page', 10),
        /No such host for https:\/\/nope\.invalid\/page/
      );
    } finally {
      global.fetch = original;
    }
  });

  test('refuses a .json URL that cannot be loaded as a playlist', async () => {
    const original = global.fetch;
    global.fetch = async () => new Response('upstream down', { status: 502 });

    try {
      await assert.rejects(
        () => resolvePlaySource('https://cdn.example.com/playlist.json', 10),
        /looks like a playlist \(\.json\) but could not be loaded/
      );
    } finally {
      global.fetch = original;
    }
  });

  test('buildMediaPlaySource with text/html times the item as a page, like an ordinary page URL', async () => {
    // --web forces the page path for any URL. Its timing must match what an
    // extensionless page URL gets, not the static-image default.
    const forced = await buildMediaPlaySource('https://feralfile.com/artworks/a.png', {
      mimeType: 'text/html',
    });
    const page = await buildMediaPlaySource('https://example.com/');
    assert.equal(forced.kind, 'media');
    assert.equal(forced.playlist.items[0].source, 'https://feralfile.com/artworks/a.png');
    assert.equal(forced.playlist.items[0].duration, page.playlist.items[0].duration);
  });

  test('validatePlaylist rejects a structurally invalid playlist', async () => {
    const result = await validatePlaylist({
      dpVersion: '1.1.0',
      title: 'missing items',
    });

    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /items/i);
  });
});
