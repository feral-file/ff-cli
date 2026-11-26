/**
 * The ff-cli required-version floor (src/utilities/required-version.ts): what
 * one remote-config read stores, how often a read is attempted, when the kept
 * value refuses a command, and which commands are gated at all.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  FLOOR_READ_INTERVAL_MS,
  FLOOR_READ_TIMEOUT_MS,
  REQUIRED_VERSION_COMMANDS,
  unsupportedVersionMessage,
} from '../src/utilities/required-version';

const NOW = 1_800_000_000_000;
const MESSAGE = (installed: string) =>
  `ff-cli ${installed} is no longer supported. Update: npm i -g @feralfile/cli`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-cli-floor-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const keptFile = () => join(dir, 'required-version.json');
const kept = () => JSON.parse(readFileSync(keptFile(), 'utf-8'));
const keep = (value: unknown) =>
  writeFileSync(keptFile(), typeof value === 'string' ? value : JSON.stringify(value));

/** remote answers every read with one response and counts the reads. */
function remote(respond: () => Response | Promise<Response>) {
  const calls: { url: string; signal?: AbortSignal | null }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal });
    return respond();
  }) as typeof fetch;
  return { calls, fetchFn };
}

const document = (body: unknown) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });

function check(installed: string, fetchFn: typeof fetch, now = NOW) {
  return unsupportedVersionMessage(installed, {
    dir,
    baseUrl: 'https://config.test',
    now: () => now,
    fetchFn,
  });
}

describe('required-version read', () => {
  test('reads <base>/ff-app.json with the 2 s deadline', async () => {
    const { calls, fetchFn } = remote(document({ cli_update: { required_version: '4.0.0' } }));
    await unsupportedVersionMessage('4.3.0', {
      dir,
      baseUrl: 'https://config.test/',
      now: () => NOW,
      fetchFn,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://config.test/ff-app.json');
    assert.ok(calls[0].signal, 'the read carries a deadline');
    assert.equal(FLOOR_READ_TIMEOUT_MS, 2000);
  });

  const stored: { name: string; body: unknown; floor: string | null }[] = [
    { name: 'a version', body: { cli_update: { required_version: '4.4.0' } }, floor: '4.4.0' },
    { name: 'a document without the key', body: { app_update: {} }, floor: null },
    { name: 'a null section', body: { cli_update: null }, floor: null },
    { name: 'an unparsable version', body: { cli_update: { required_version: 'x' } }, floor: null },
    { name: 'a prerelease', body: { cli_update: { required_version: '4.4.0-rc.1' } }, floor: null },
    { name: 'a number', body: { cli_update: { required_version: 4 } }, floor: null },
    { name: 'a JSON array', body: [], floor: null },
  ];
  for (const { name, body, floor } of stored) {
    test(`a successful read of ${name} stores ${floor ?? 'no floor'}`, async () => {
      // Replace-on-success: whatever was kept is gone, so withdrawing a wrong
      // floor from the document unlocks every install on its next read.
      keep({ attemptedAt: NOW - FLOOR_READ_INTERVAL_MS, requiredVersion: '99.0.0' });
      const { fetchFn } = remote(document(body));
      const message = await check('4.3.0', fetchFn);
      assert.deepEqual(kept(), { attemptedAt: NOW, requiredVersion: floor });
      assert.equal(message, floor ? MESSAGE('4.3.0') : null);
    });
  }

  const failures: { name: string; respond: () => Response | Promise<Response> }[] = [
    { name: 'a network error', respond: () => Promise.reject(new Error('fetch failed')) },
    {
      name: 'a deadline',
      respond: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    },
    { name: 'HTTP 404', respond: () => new Response('{}', { status: 404 }) },
    { name: 'HTTP 500', respond: () => new Response('{}', { status: 500 }) },
    { name: 'a non-JSON body', respond: document('<html>sign in</html>') },
  ];
  for (const { name, respond } of failures) {
    test(`${name} keeps the stored floor and still counts as the day's attempt`, async () => {
      keep({ attemptedAt: NOW - FLOOR_READ_INTERVAL_MS, requiredVersion: '4.4.0' });
      const first = remote(respond);
      assert.equal(await check('4.3.0', first.fetchFn), MESSAGE('4.3.0'));
      assert.deepEqual(kept(), { attemptedAt: NOW, requiredVersion: '4.4.0' });
      const second = remote(respond);
      assert.equal(await check('4.3.0', second.fetchFn, NOW + 1000), MESSAGE('4.3.0'));
      assert.equal(second.calls.length, 0, 'a failed attempt is not repeated the same day');
    });

    test(`${name} with nothing ever read fails open`, async () => {
      const { calls, fetchFn } = remote(respond);
      assert.equal(await check('0.0.1', fetchFn), null);
      assert.equal(calls.length, 1);
      assert.deepEqual(kept(), { attemptedAt: NOW, requiredVersion: null });
    });
  }
});

describe('required-version daily limit', () => {
  const cases: { name: string; age: number; reads: number }[] = [
    { name: 'just attempted', age: 0, reads: 0 },
    { name: 'one millisecond short of a day', age: FLOOR_READ_INTERVAL_MS - 1, reads: 0 },
    { name: 'exactly a day', age: FLOOR_READ_INTERVAL_MS, reads: 1 },
    { name: 'a week', age: 7 * FLOOR_READ_INTERVAL_MS, reads: 1 },
    // A clock set back must not freeze the kept value for good.
    { name: 'an attempt stamped in the future', age: -60_000, reads: 1 },
  ];
  for (const { name, age, reads } of cases) {
    test(`${name}: ${reads} read(s)`, async () => {
      keep({ attemptedAt: NOW - age, requiredVersion: '4.4.0' });
      const { calls, fetchFn } = remote(document({ cli_update: { required_version: '4.5.0' } }));
      assert.equal(await check('4.4.0', fetchFn), reads ? MESSAGE('4.4.0') : null);
      assert.equal(calls.length, reads);
    });
  }

  test('the kept floor is enforced between attempts without a read', async () => {
    keep({ attemptedAt: NOW, requiredVersion: '4.4.0' });
    const { calls, fetchFn } = remote(() => Promise.reject(new Error('unreachable')));
    assert.equal(await check('4.3.9', fetchFn, NOW + 1000), MESSAGE('4.3.9'));
    assert.equal(calls.length, 0);
  });

  for (const corrupt of ['', '{', '[]', '{"attemptedAt":"today","requiredVersion":"4.4.0"}']) {
    test(`an unreadable kept value (${JSON.stringify(corrupt)}) is "nothing read"`, async () => {
      keep(corrupt);
      const { calls, fetchFn } = remote(() => Promise.reject(new Error('unreachable')));
      assert.equal(await check('0.0.1', fetchFn), null);
      assert.equal(calls.length, 1);
    });
  }

  test('a config directory that cannot be written fails open', async () => {
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, '');
    const { fetchFn } = remote(() => Promise.reject(new Error('unreachable')));
    const message = await unsupportedVersionMessage('0.0.1', {
      dir: join(file, 'ff-cli'),
      baseUrl: 'https://config.test',
      now: () => NOW,
      fetchFn,
    });
    assert.equal(message, null);
  });
});

describe('required-version comparison', () => {
  const cases: { installed: string; floor: unknown; refused: boolean }[] = [
    { installed: '4.3.0', floor: '4.3.1', refused: true },
    { installed: '4.3.0', floor: '4.10.0', refused: true },
    { installed: '4.9.9', floor: '10.0.0', refused: true },
    { installed: '4.3.0', floor: '4.3.0', refused: false },
    { installed: '4.10.0', floor: '4.9.0', refused: false },
    { installed: '5.0.0', floor: '4.99.99', refused: false },
    // Fail open: either version unparsable, or no floor.
    { installed: '4.3.0-beta.1', floor: '99.0.0', refused: false },
    { installed: 'dev', floor: '99.0.0', refused: false },
    { installed: '4.3.0', floor: 'latest', refused: false },
    { installed: '4.3.0', floor: 99, refused: false },
    { installed: '4.3.0', floor: null, refused: false },
  ];
  for (const { installed, floor, refused } of cases) {
    test(`${installed} against ${JSON.stringify(floor)}: ${refused ? 'refused' : 'allowed'}`, async () => {
      keep({ attemptedAt: NOW, requiredVersion: floor });
      const { fetchFn } = remote(() => Promise.reject(new Error('unreachable')));
      assert.equal(await check(installed, fetchFn), refused ? MESSAGE(installed) : null);
    });
  }
});

describe('required-version gated commands', () => {
  const projectRoot = resolve(__dirname, '..');
  const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
  const cliEntry = resolve(projectRoot, 'index.ts');
  const installed = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')).version;

  test('the gated list is exactly the commands that contact an FF1', () => {
    assert.deepEqual([...REQUIRED_VERSION_COMMANDS].sort(), [
      'device add',
      'device controllers',
      'device lan',
      'device pair',
      'device revoke',
      'device unpair',
      'display',
      'download',
      'report',
      'ssh',
    ]);
  });

  /** runCli runs the CLI from source with a kept floor no release can meet. */
  function runCli(args: string[], floor: string | null = '9999.0.0') {
    mkdirSync(join(dir, 'ff-cli'), { recursive: true });
    writeFileSync(
      join(dir, 'ff-cli', 'required-version.json'),
      JSON.stringify({ attemptedAt: Date.now(), requiredVersion: floor })
    );
    return spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
      cwd: dir,
      encoding: 'utf-8',
      // The kept value is fresh, so no read happens; the dead URL makes sure.
      env: { ...process.env, XDG_CONFIG_HOME: dir, REMOTE_CONFIG_URL: 'http://127.0.0.1:1' },
    });
  }

  // Every gated command line here would otherwise fail later, on a missing
  // config or device; the floor must answer first.
  const gated: string[][] = [
    ['display', 'playlist.json'],
    ['play', 'playlist.json'],
    ['download', 'playlist.json'],
    ['ssh', 'enable'],
    ['report'],
    ['device', 'pair'],
    ['device', 'controllers'],
    ['device', 'revoke', 'ctl'],
    ['device', 'lan', '--close'],
    ['device', 'unpair', '-y'],
    ['device', 'add', '--host', 'http://127.0.0.1:1', '--name', 'x'],
  ];
  for (const args of gated) {
    test(`\`${args.join(' ')}\` below the floor exits non-zero with the update line`, () => {
      const result = runCli(args);
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), MESSAGE(installed));
      assert.equal(result.stdout, '');
    });
  }

  // Commands that never contact an FF1 keep working below the floor.
  const ungated: string[][] = [
    ['status'],
    ['validate', 'missing.json'],
    ['verify', 'missing.json'],
    ['sign', 'missing.json'],
    ['build', 'missing.json'],
    ['enrich', 'missing.json'],
    ['config', 'validate'],
    ['device', 'list'],
    ['device', 'remove', 'x'],
    ['device', 'rename', 'x', 'y'],
    ['device', 'default', 'x'],
  ];
  for (const args of ungated) {
    test(`\`${args.join(' ')}\` is never gated`, () => {
      const result = runCli(args);
      assert.doesNotMatch(result.stderr + result.stdout, /no longer supported/);
    });
  }

  test('a gated command runs when the kept value is "no floor"', () => {
    const result = runCli(['device', 'controllers'], null);
    assert.doesNotMatch(result.stderr + result.stdout, /no longer supported/);
  });

  test('--help and --version are answered below the floor', () => {
    assert.equal(runCli(['display', '--help']).status, 0);
    assert.equal(runCli(['--version']).stdout.trim(), installed);
  });
});
