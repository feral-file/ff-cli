import assert from 'node:assert/strict';
import { describe, test, before, after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePlaySource } from '../src/utilities/playlist-source';
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

  test('falls back to kind=media when a URL returns a non-OK status', async () => {
    const original = global.fetch;
    global.fetch = async () => new Response('not found', { status: 404 });

    try {
      const result = await resolvePlaySource('https://example.com/clip.mp4', 10);
      assert.equal(result.kind, 'media');
    } finally {
      global.fetch = original;
    }
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
