import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { publishPlaylist } from '../src/utilities/playlist-publisher';
import { signPlaylist } from '../src/utilities/playlist-signer';

const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ff1-publish-'));
}

describe('publishPlaylist validation contract', () => {
  test('rejects a structurally invalid playlist before upload', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'invalid.json');
      writeFileSync(path, JSON.stringify({ dpVersion: '1.1.0', title: 'bad' }, null, 2), 'utf-8');

      const result = await publishPlaylist(path, 'http://127.0.0.1:0');

      assert.equal(result.success, false);
      assert.match(result.error ?? '', /verification failed|dp1:/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a playlist with a broken signature envelope before upload', async () => {
    const dir = makeTempDir();
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const previousPk = process.env.PLAYLIST_PRIVATE_KEY;
    process.env.PLAYLIST_PRIVATE_KEY = privateKeyBase64;
    const server = createServer((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'playlist-123' }));
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const port = address.port;
      const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const signature = await signPlaylist(basePlaylist, privateKeyBase64);
      const playlist = { ...basePlaylist, signatures: [{ ...signature, sig: 'AAAA' }] };
      const path = join(dir, 'tampered.json');
      writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

      const result = await publishPlaylist(path, `http://127.0.0.1:${port}`);

      assert.equal(result.success, false);
      assert.match(result.error ?? '', /signature verification failed/i);
    } finally {
      if (previousPk === undefined) {
        delete process.env.PLAYLIST_PRIVATE_KEY;
      } else {
        process.env.PLAYLIST_PRIVATE_KEY = previousPk;
      }
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
