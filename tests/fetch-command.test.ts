/**
 * `ff-cli fetch` — the step that makes the documented replace loop runnable.
 *
 * `--replace` requires `id`, `slug`, and `created` to equal the stored row's, so an edit has to start
 * from the published document. Nothing produced that file: the recovery advice pointed at `verify`,
 * which validates and prints a summary but neither prints nor saves the JSON. These tests pin what the
 * command has to guarantee — the saved bytes are the served document, and the document never mixes with
 * the status lines on stdout.
 *
 * The CLI is spawned rather than called, because the stdout/stderr split is the contract and it only
 * exists at the process boundary.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
// Spawn node directly with tsx's JS entry to avoid Windows .cmd shim limitations in spawnSync.
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

const STORED = {
  dpVersion: '1.1.0',
  id: '019852a0-3fc9-7f0a-9b6e-5f3f0f2e1a11',
  slug: 'fetch-fixture',
  title: 'Fetch fixture',
  created: '2026-09-07T10:00:00Z',
  curators: [{ name: 'Owner', key: 'did:key:z6MkTestOwnerKey' }],
  items: [],
  signatures: [{ alg: 'ed25519', kid: 'did:key:z6MkTestOwnerKey', role: 'curator' }],
};

/** Start a loopback feed that serves STORED on GET, or 404s when `found` is false. */
async function startFeed(found = true): Promise<{ baseUrl: string; close: () => void }> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found', message: 'playlist not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(STORED));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to start test feed');
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/api/v1`, close: () => server.close() };
}

/**
 * Run the CLI in a temp cwd whose config.json points at `baseUrl` as the only feed.
 *
 * Deliberately `spawn` and not `spawnSync`: the feed these tests point the CLI at is an HTTP server on
 * this process's own event loop, and `spawnSync` blocks that loop until the child exits — so the server
 * could never answer and every request died on the 30s client timeout.
 */
async function runCli(
  baseUrl: string,
  args: string[]
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  dir: string;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'ff1-fetch-'));
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify({ defaultDuration: 10, feedServers: [{ baseUrl }] }, null, 2)}\n`,
    'utf-8'
  );

  const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const status = await new Promise<number | null>((resolvePromise) => {
    child.on('close', (code) => resolvePromise(code));
  });

  return {
    status,
    stdout,
    stderr,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('ff-cli fetch', () => {
  test('saves the served document verbatim', async () => {
    const feed = await startFeed();
    const run = await runCli(feed.baseUrl, ['fetch', STORED.id, '-o', 'playlist.json']);
    try {
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      const saved = JSON.parse(readFileSync(join(run.dir, 'playlist.json'), 'utf-8'));
      // Byte-for-byte content equality: a replace fails on any drift in id, slug, or created, and the
      // signatures cover the whole document, so this file must be the stored one and not a rendering.
      assert.deepEqual(saved, STORED);
      assert.match(run.stderr, /Fetched/);
      assert.match(run.stderr, /Saved to: playlist\.json/);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('writes only the document to stdout when no output file is given', async () => {
    // Status lines go to stderr so `ff-cli fetch <id> > playlist.json` is a valid way to get the file.
    const feed = await startFeed();
    const run = await runCli(feed.baseUrl, ['fetch', STORED.id]);
    try {
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      assert.deepEqual(JSON.parse(run.stdout), STORED);
      assert.match(run.stderr, /Fetched/);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('accepts a feed URL as well as a bare id', async () => {
    const feed = await startFeed();
    const run = await runCli(feed.baseUrl, [
      'fetch',
      `https://feed.example.com/api/v1/playlists/${STORED.id}`,
      '-o',
      'playlist.json',
    ]);
    try {
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      const saved = JSON.parse(readFileSync(join(run.dir, 'playlist.json'), 'utf-8'));
      assert.equal(saved.id, STORED.id);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('exits non-zero and writes no file when the feed has no such playlist', async () => {
    const feed = await startFeed(false);
    const run = await runCli(feed.baseUrl, ['fetch', 'missing-playlist', '-o', 'playlist.json']);
    try {
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /No playlist missing-playlist/);
      assert.match(run.stderr, /tombstoned/);
      assert.throws(() => readFileSync(join(run.dir, 'playlist.json'), 'utf-8'));
      // Nothing may reach stdout on failure, or a redirect would capture a truncated file.
      assert.equal(run.stdout, '');
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});
