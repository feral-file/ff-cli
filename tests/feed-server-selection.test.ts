/**
 * Guards the feed-server choice for every write path.
 *
 * The bug this file exists for: with two feed servers configured and no `-s`, `publish` printed a
 * "Select server" prompt, and under a pipe or a cron job readline resolved immediately with an empty
 * answer — so the command exited **0** having published nothing. A write that reports success without
 * writing is worse than any error, and it is invisible in a script's exit status.
 *
 * The CLI-level tests spawn the real entrypoint, because `spawnSync` gives the child no TTY: that is the
 * exact condition the unit tests cannot reproduce from inside a test runner that may or may not have one.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { selectFeedServer } from '../src/commands/helpers/feed-server';

const projectRoot = resolve(__dirname, '..');
// Spawn node directly with tsx's JS entry to avoid Windows .cmd shim limitations in spawnSync.
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

const TWO_SERVERS = ['https://feed.example.com/api/v1', 'http://127.0.0.1:8787/api/v1'];

describe('selectFeedServer', () => {
  test('uses the only configured server without asking', async () => {
    const selection = await selectFeedServer(['https://feed.example.com/api/v1']);
    assert.equal(selection.ok, true);
    assert.equal(selection.index, 0);
  });

  test('honours an explicit --server index', async () => {
    const selection = await selectFeedServer(TWO_SERVERS, { serverArg: '1' });
    assert.equal(selection.ok, true);
    assert.equal(selection.url, TWO_SERVERS[1]);
  });

  test('rejects a --server value that is not an in-range integer', async () => {
    // parseInt('0abc') truncates to 0 and would route to a server the user did not name.
    for (const bad of ['0abc', '-1', '2', '1.5', '']) {
      const selection = await selectFeedServer(TWO_SERVERS, { serverArg: bad });
      assert.equal(selection.ok, false, `expected "${bad}" to be rejected`);
      assert.match(String(selection.error), /Invalid --server value/);
    }
  });

  test('fails with the server list when the session cannot be asked', async () => {
    const selection = await selectFeedServer(TWO_SERVERS, { nonInteractive: true });
    assert.equal(selection.ok, false);
    assert.match(String(selection.error), /pass --server <index>/);
    // The list has to be in the message, or the operator cannot act on it without reading config.json.
    assert.match(String(selection.detail), /0: /);
    assert.match(String(selection.detail), /1: /);
  });

  test('a bare Enter at the prompt selects nothing', async () => {
    // `Number('')` is 0, so an empty answer used to select the FIRST configured server — usually
    // production — for an operator who was hesitating or who reflexively took a default that was never
    // offered. The prompt has no default by design: the CLI is asking because it cannot tell.
    const previousIsTTY = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    try {
      for (const answer of ['', '   ', '\n']) {
        const selection = await selectFeedServer(TWO_SERVERS, { ask: async () => answer });
        assert.equal(selection.ok, false, `expected ${JSON.stringify(answer)} to select nothing`);
        assert.match(String(selection.error), /No server selected/);
        // The list has to come back with the refusal, or the retry is a guess.
        assert.ok(String(selection.detail).includes(TWO_SERVERS[0]));
        assert.ok(String(selection.detail).includes(TWO_SERVERS[1]));
      }

      // Non-vacuity: a real answer at the same prompt still works.
      const chosen = await selectFeedServer(TWO_SERVERS, { ask: async () => '1' });
      assert.equal(chosen.ok, true);
      assert.equal(chosen.url, TWO_SERVERS[1]);
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = previousIsTTY;
    }
  });

  test('rejects a non-numeric answer at the prompt', async () => {
    const previousIsTTY = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    try {
      const selection = await selectFeedServer(TWO_SERVERS, { ask: async () => 'prod' });
      assert.equal(selection.ok, false);
      assert.match(String(selection.error), /Invalid selection: prod/);
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = previousIsTTY;
    }
  });

  test('reports missing configuration rather than choosing a default', async () => {
    const selection = await selectFeedServer([]);
    assert.equal(selection.ok, false);
    assert.match(String(selection.error), /No feed servers configured/);
  });
});

/** Run the CLI in a temp cwd whose config.json declares two feed servers. */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ff1-server-select-'));
  try {
    writeFileSync(
      join(dir, 'config.json'),
      `${JSON.stringify(
        {
          defaultDuration: 10,
          playlist: { privateKey: 'TESTKEY' },
          feedServers: TWO_SERVERS.map((baseUrl) => ({ baseUrl })),
        },
        null,
        2
      )}\n`,
      'utf-8'
    );
    const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
      cwd: dir,
      encoding: 'utf-8',
      // stdin is a pipe, so `process.stdin.isTTY` is undefined in the child — the condition under test.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PLAYLIST_PRIVATE_KEY: '' },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('non-TTY server selection at the CLI', () => {
  test('publish exits non-zero and lists the servers instead of publishing nothing', () => {
    const result = runCli(['publish', 'does-not-matter.json']);

    assert.notEqual(result.status, 0, 'a write that did nothing must not exit 0');
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /Multiple feed servers configured/);
    assert.match(output, /--server/);
    assert.ok(output.includes(TWO_SERVERS[0]), `expected ${TWO_SERVERS[0]} in output`);
    assert.ok(output.includes(TWO_SERVERS[1]), `expected ${TWO_SERVERS[1]} in output`);
    // It must fail on the ambiguity, not on the missing file: the file is never read.
    assert.doesNotMatch(output, /Playlist file not found/);
  });

  test('unpublish applies the same rule', () => {
    const result = runCli(['unpublish', 'some-playlist-id']);

    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /Multiple feed servers configured/);
    assert.match(output, /--server/);
  });

  test('unpublish refuses to delete without a confirmation it cannot ask for', () => {
    // With -s the server is unambiguous, so the next gate is the destructive-action confirmation. A
    // pipe cannot answer it, and assuming yes on an irreversible delete is not an option.
    const result = runCli(['unpublish', 'some-playlist-id', '-s', '0']);

    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /Refusing to delete without confirmation/);
    assert.match(output, /-y/);
  });
});
