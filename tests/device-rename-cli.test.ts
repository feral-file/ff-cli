/**
 * Integration test for the `ff1 device rename <name> <new-name>` subcommand.
 *
 * Exercises the CLI wiring that reads and rewrites config.json — the
 * highest-risk regression point not covered by the pure-helper unit tests.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
// Spawn node directly with tsx's JS entry to avoid Windows .cmd shim
// limitations in spawnSync (Node refuses to execute .bat/.cmd without shell).
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

interface TestConfig {
  defaultDuration: number;
  playlist: { privateKey: string };
  ff1Devices: {
    devices: Array<{ name?: string; host: string; id?: string; apiKey?: string }>;
  };
  /** Arbitrary top-level field — must survive a rename. */
  experimental?: Record<string, unknown>;
}

function makeConfig(): TestConfig {
  return {
    defaultDuration: 10,
    playlist: { privateKey: 'TESTKEY' },
    ff1Devices: {
      devices: [
        { name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-kkk', apiKey: 'KEY-K' },
        { name: 'office', host: 'http://192.168.1.11:1111', id: 'ff1-ooo' },
        { name: 'studio', host: 'http://192.168.1.12:1111' },
      ],
    },
    experimental: { flagA: true, nested: { count: 3 } },
  };
}

function withTempConfig(fn: (dir: string, configPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ff1-device-rename-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(makeConfig(), null, 2)}\n`, 'utf-8');
  try {
    fn(dir, configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runDeviceRename(
  cwd: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, cliEntry, 'device', 'rename', ...args], {
    cwd,
    // XDG_CONFIG_HOME is redirected so the user's real ~/.config/ff1 is never touched
    // even if cwd-based local config resolution ever changes.
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, '.xdg') },
    encoding: 'utf-8',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('ff1 device rename <name> <new-name> — CLI integration', () => {
  test('renames the device in place and preserves all other fields and config', () => {
    withTempConfig((cwd, configPath) => {
      const { status, stdout } = runDeviceRename(cwd, 'kitchen', 'gallery');

      assert.equal(status, 0, `expected exit 0, got ${status}: ${stdout}`);
      assert.match(stdout, /Renamed device: kitchen → gallery/);

      const written = JSON.parse(readFileSync(configPath, 'utf-8')) as TestConfig;

      assert.deepEqual(
        written.ff1Devices.devices.map((d) => d.name),
        ['gallery', 'office', 'studio'],
        'name changes in place; order (and thus default status) is preserved'
      );

      // Sibling fields on the renamed entry must survive.
      const renamed = written.ff1Devices.devices[0];
      assert.equal(renamed.host, 'http://192.168.1.10:1111');
      assert.equal(renamed.id, 'ff1-kkk');
      assert.equal(renamed.apiKey, 'KEY-K');

      // Unrelated top-level fields must be preserved.
      assert.equal(written.defaultDuration, 10);
      assert.equal(written.playlist.privateKey, 'TESTKEY');
      assert.deepEqual(written.experimental, { flagA: true, nested: { count: 3 } });
    });
  });

  test('leaves config.json untouched when the name is already the requested one', () => {
    withTempConfig((cwd, configPath) => {
      const originalBytes = readFileSync(configPath);
      const originalMtime = statSync(configPath).mtimeMs;

      const { status, stdout } = runDeviceRename(cwd, 'kitchen', 'kitchen');

      assert.equal(status, 0, `expected exit 0, got ${status}: ${stdout}`);
      assert.match(stdout, /already named/i);

      const afterBytes = readFileSync(configPath);
      assert.ok(
        originalBytes.equals(afterBytes),
        'config.json bytes must be identical when nothing changes'
      );

      const afterMtime = statSync(configPath).mtimeMs;
      assert.equal(afterMtime, originalMtime, 'config.json must not be rewritten on no-op');
    });
  });

  test('exits non-zero and leaves config untouched when the device is not found', () => {
    withTempConfig((cwd, configPath) => {
      const originalBytes = readFileSync(configPath);

      const { status, stderr } = runDeviceRename(cwd, 'bathroom', 'gallery');

      assert.notEqual(status, 0, 'must exit non-zero on missing device');
      assert.match(stderr, /not found/i);

      const afterBytes = readFileSync(configPath);
      assert.ok(
        originalBytes.equals(afterBytes),
        'config.json must be untouched on not-found error'
      );
    });
  });

  test('exits non-zero when the new name belongs to another device', () => {
    withTempConfig((cwd, configPath) => {
      const originalBytes = readFileSync(configPath);

      const { status, stderr } = runDeviceRename(cwd, 'office', 'kitchen');

      assert.notEqual(status, 0, 'must exit non-zero on name conflict');
      assert.match(stderr, /already used/i);

      const afterBytes = readFileSync(configPath);
      assert.ok(originalBytes.equals(afterBytes), 'config.json must be untouched on conflict');
    });
  });
});
