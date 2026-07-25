/**
 * Integration test for the case-insensitive duplicate-name guard in
 * `ff1 device add --host --name`.
 *
 * Lookups (`-d`, remove, default, rename) ignore case, so allowing "Kitchen"
 * to be saved alongside "kitchen" would make one of them unreachable by name.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
// Spawn node directly with tsx's JS entry to avoid Windows .cmd shim
// limitations in spawnSync (Node refuses to execute .bat/.cmd without shell).
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

function makeConfig() {
  return {
    defaultDuration: 10,
    ff1Devices: {
      devices: [
        { name: 'kitchen', host: 'http://192.168.1.10:1111' },
        { name: 'office', host: 'http://192.168.1.11:1111' },
      ],
    },
  };
}

function withTempConfig(fn: (dir: string, configPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ff1-device-add-conflict-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(makeConfig(), null, 2)}\n`, 'utf-8');
  try {
    fn(dir, configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runDeviceAdd(
  cwd: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, cliEntry, 'device', 'add', ...args], {
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

describe('ff1 device add — case-insensitive duplicate-name guard', () => {
  test('rejects renaming a device to a name that differs only by case from another device', () => {
    withTempConfig((cwd, configPath) => {
      const originalBytes = readFileSync(configPath);

      // Host matches "office", so this is an update — but "Kitchen" collides
      // with the existing "kitchen" on the other row.
      const { status, stderr } = runDeviceAdd(
        cwd,
        '--host',
        'http://192.168.1.11:1111',
        '--name',
        'Kitchen'
      );

      assert.notEqual(status, 0, 'must exit non-zero on case-insensitive name conflict');
      assert.match(stderr, /already used/i);

      const afterBytes = readFileSync(configPath);
      assert.ok(originalBytes.equals(afterBytes), 'config.json must be untouched on conflict');
    });
  });

  test('still allows a case-only rename of the same device via add', () => {
    withTempConfig((cwd, configPath) => {
      const { status, stdout } = runDeviceAdd(
        cwd,
        '--host',
        'http://192.168.1.11:1111',
        '--name',
        'Office'
      );

      assert.equal(status, 0, `expected exit 0, got ${status}: ${stdout}`);

      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.deepEqual(
        written.ff1Devices.devices.map((d: { name?: string }) => d.name),
        ['kitchen', 'Office'],
        'same-row case change is not a conflict'
      );
    });
  });
});
