import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { publishPlaylist } from '../src/utilities/playlist-publisher';
import { signPlaylist } from '../src/utilities/playlist-signer';
import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ff1-publish-'));
}

function makePrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
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
      const playlist = { ...basePlaylist, signatures: [{ sig: 'AAAA' }] };
      const path = join(dir, 'tampered.json');
      writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

      const result = await publishPlaylist(path, `http://127.0.0.1:${port}`);

      assert.equal(result.success, false);
      assert.match(result.error ?? '', /signature verification failed/i);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uploads a verified playlist after signature verification succeeds', async () => {
    const dir = makeTempDir();
    let deliveredBody = '';
    const server = createServer((req, res) => {
      req.setEncoding('utf-8');
      req.on('data', (chunk) => {
        deliveredBody += chunk;
      });
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'playlist-123' }));
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const privateKey = makePrivateKeyBase64();
      // Declare the signer as a curator BEFORE signing. The feed accepts a create only when a
      // signature's kid appears in the document's own curators[], and signing covers curators[], so
      // adding it afterwards would invalidate the signature this test then expects to upload.
      const withCurator = {
        ...basePlaylist,
        curators: [{ name: 'Test Curator', key: playlistSigningDidKey(privateKey) }],
      };
      const signature = await signPlaylist(withCurator, privateKey);
      const playlist = { ...withCurator, signature: undefined, signatures: [signature] };
      const path = join(dir, 'signed.json');
      writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

      const result = await publishPlaylist(path, `http://127.0.0.1:${address.port}`);

      assert.equal(result.success, true);
      assert.equal(result.playlistId, 'playlist-123');
      assert.match(result.message ?? '', /Published to feed server/i);
      assert.ok(deliveredBody, 'expected publish request body to be captured');

      const delivered = JSON.parse(deliveredBody) as {
        signatures?: unknown[];
        signature?: unknown;
      };
      assert.equal(Array.isArray(delivered.signatures), true);
      assert.ok((delivered.signatures?.length ?? 0) > 0);
      assert.equal(delivered.signature, undefined);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('publishPlaylist refuses a signed playlist whose signer is not a declared curator', async () => {
  // The feed's rule, checked locally: a signature's kid must appear in the document's own curators[].
  // Its server-side answer ("no valid curator signature found") reads as a signing problem and sends
  // people to check their key rather than their document, so the CLI answers first with the remedy.
  const dir = makeTempDir();
  try {
    const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const privateKey = makePrivateKeyBase64();
    const signature = await signPlaylist(basePlaylist, privateKey);
    const playlist = { ...basePlaylist, signature: undefined, signatures: [signature] };
    const path = join(dir, 'signed-no-curator.json');
    writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

    // A URL that would fail loudly if contacted: the point is that no request is made at all.
    const result = await publishPlaylist(path, 'http://127.0.0.1:1/api/v1');

    assert.equal(result.success, false);
    assert.match(String(result.error), /not declared as a curator/i);
    assert.match(String(result.message), /curators/);
    // The remedy has to carry the actual kid, or the user cannot act on it.
    assert.match(String(result.message), new RegExp(playlistSigningDidKey(privateKey)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishPlaylist refuses a legacy flat-signature playlist without uploading', async () => {
  // A flat `signature` string still verifies locally when the matching key is configured, but it carries
  // no kid — so the curator check has nothing to match and the document would reach the feed only to be
  // refused as unauthenticated. Verified against a running feed before this guard existed.
  const dir = makeTempDir();
  try {
    const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const playlist = { ...basePlaylist, signature: 'ed25519:deadbeef', signatures: undefined };
    const path = join(dir, 'legacy.json');
    writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

    // Port 1 would fail loudly if contacted; the point is that nothing is sent.
    const result = await publishPlaylist(path, 'http://127.0.0.1:1/api/v1');

    assert.equal(result.success, false);
    const text = `${result.error} ${result.message}`;
    assert.match(text, /legacy flat signature|signatures\[\]/i);
    // The remedy must name the concrete steps, not just the diagnosis.
    assert.match(text, /ff-cli sign/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
