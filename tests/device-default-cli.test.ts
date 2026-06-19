/**
 * Integration test for the `ff1 device default <name>` subcommand.
 *
 * Exercises the CLI wiring in index.ts that reads and rewrites config.json —
 * the highest-risk regression point not covered by the pure-helper unit tests.
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
  /** Arbitrary top-level field — must survive a reorder. */
  experimental?: Record<string, unknown>;
}

function makeConfig(): TestConfig {
  return {
    defaultDuration: 10,
    playlist: { privateKey: 'TESTKEY' },
    ff1Devices: {
      devices: [
        { name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-kkk' },
        { name: 'office', host: 'http://192.168.1.11:1111', id: 'ff1-ooo' },
        { name: 'studio', host: 'http://192.168.1.12:1111' },
      ],
    },
    experimental: { flagA: true, nested: { count: 3 } },
  };
}

function withTempConfig(fn: (dir: string, configPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ff1-device-default-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(makeConfig(), null, 2)}\n`, 'utf-8');
  try {
    fn(dir, configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runDeviceDefault(
  cwd: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, cliEntry, 'device', 'default', ...args], {
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

describe('ff1 device default <name> — CLI integration', () => {
  test('promotes the named device and preserves unrelated top-level config fields', () => {
    withTempConfig((cwd, configPath) => {
      const before = statSync(configPath).mtimeMs;
      const { status, stdout } = runDeviceDefault(cwd, 'office');

      assert.equal(status, 0, `expected exit 0, got ${status}: ${stdout}`);
      assert.match(stdout, /Default device: office/);

      const written = JSON.parse(readFileSync(configPath, 'utf-8')) as TestConfig;

      assert.deepEqual(
        written.ff1Devices.devices.map((d) => d.name),
        ['office', 'kitchen', 'studio'],
        'target device must move to index 0'
      );

      // Unrelated top-level fields must be preserved.
      assert.equal(written.defaultDuration, 10);
      assert.equal(written.playlist.privateKey, 'TESTKEY');
      assert.deepEqual(written.experimental, { flagA: true, nested: { count: 3 } });

      // File actually changed.
      const after = statSync(configPath).mtimeMs;
      assert.ok(after >= before, 'mtime should advance on reorder');
    });
  });

  test('leaves config.json untouched when the target is already the default', () => {
    withTempConfig((cwd, configPath) => {
      const originalBytes = readFileSync(configPath);
      const originalMtime = statSync(configPath).mtimeMs;

      const { status, stdout } = runDeviceDefault(cwd, 'kitchen');

      assert.equal(status, 0, `expected exit 0, got ${status}: ${stdout}`);
      assert.match(stdout, /already the default/i);

      const afterBytes = readFileSync(configPath);
      assert.ok(
        originalBytes.equals(afterBytes),
        'config.json bytes must be identical when no reorder is needed'
      );

      // Stronger: mtime should not advance when the CLI skips the write.
      const afterMtime = statSync(configPath).mtimeMs;
      assert.equal(afterMtime, originalMtime, 'config.json must not be rewritten on no-op');
    });
  });

  test('exits non-zero and leaves config untouched when the device is not found', () => {
    withTempConfig((cwd, configPath) => {
      const originalBytes = readFileSync(configPath);

      const { status, stderr } = runDeviceDefault(cwd, 'bathroom');

      assert.notEqual(status, 0, 'must exit non-zero on missing device');
      assert.match(stderr, /not found/i);

      const afterBytes = readFileSync(configPath);
      assert.ok(
        originalBytes.equals(afterBytes),
        'config.json must be untouched on not-found error'
      );
    });
  });
});
