/** Integration coverage for manual device IDs used by secure relayer pairing. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

interface TestDevice {
  name?: string;
  host: string;
  id?: string;
}

function runDeviceAdd(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [tsxCli, cliEntry, 'device', 'add', ...args], {
    cwd,
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, '.xdg') },
    encoding: 'utf-8',
  });
}

function withConfig(devices: TestDevice[], run: (cwd: string, configPath: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'ff1-device-add-'));
  const configPath = join(cwd, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ff1Devices: { devices } }), 'utf8');
  try {
    run(cwd, configPath);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('ff1 device add manual ID — CLI integration', () => {
  test('stores a normalized stable ID for a manual host', () => {
    withConfig([], (cwd, configPath) => {
      const result = runDeviceAdd(
        cwd,
        '--host',
        '192.168.1.20',
        '--name',
        'office',
        '--id',
        'ff1-skyz2e3a'
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        ff1Devices: { devices: TestDevice[] };
      };
      assert.equal(config.ff1Devices.devices[0].id, 'FF1-SKYZ2E3A');
    });
  });

  test('manual host update without --id preserves the paired device ID', () => {
    withConfig(
      [{ name: 'office', host: 'http://192.168.1.20:1111', id: 'FF1-SKYZ2E3A' }],
      (cwd, configPath) => {
        const result = runDeviceAdd(cwd, '--host', '192.168.1.21', '--name', 'office');
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
          ff1Devices: { devices: TestDevice[] };
        };
        assert.equal(config.ff1Devices.devices[0].id, 'FF1-SKYZ2E3A');
      }
    );
  });
});
