/** Integration coverage for manual device IDs used by secure relayer pairing. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/** runDeviceAddAsync spawns without blocking, so a status server in this process can answer. */
function runDeviceAddAsync(
  cwd: string,
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, 'device', 'add', ...args], {
      cwd,
      env: { ...process.env, XDG_CONFIG_HOME: join(cwd, '.xdg') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
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
  /** withStatusServer answers /api/status with deviceId and counts the requests. */
  async function withStatusServer(
    deviceId: string,
    run: (host: string, requests: () => number) => Promise<void>
  ): Promise<void> {
    let count = 0;
    const server = createServer((req, res) => {
      if (req.url === '/api/status') {
        count += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ device_id: deviceId, version: '2.0.11' }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => count);
    } finally {
      server.close();
    }
  }

  async function withConfigAsync(
    devices: TestDevice[],
    run: (cwd: string, read: () => TestDevice[]) => Promise<void>
  ): Promise<void> {
    const cwd = mkdtempSync(join(tmpdir(), 'ff1-device-add-'));
    const configPath = join(cwd, 'config.json');
    writeFileSync(configPath, JSON.stringify({ ff1Devices: { devices } }), 'utf8');
    try {
      await run(
        cwd,
        () =>
          (
            JSON.parse(readFileSync(configPath, 'utf8')) as {
              ff1Devices: { devices: TestDevice[] };
            }
          ).ff1Devices.devices
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  // Without an ID, `device controllers` and `device pair` sent the user back to `device add`,
  // and `device add --host` again stored none: a loop. The FF1's LAN status names it.
  test('a manual host without --id takes the ID from the FF1 status', async () => {
    await withStatusServer('ff1-skyz2e3a', (host) =>
      withConfigAsync([], async (cwd, read) => {
        const result = await runDeviceAddAsync(cwd, '--host', host, '--name', 'office');
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(read()[0].id, 'FF1-SKYZ2E3A');
      })
    );
  });

  test('a learned ID never replaces the stored ID of the row being updated', async () => {
    await withStatusServer('FF1-OTHER0001', (host, requests) =>
      withConfigAsync(
        [{ name: 'office', host: 'http://192.168.1.20:1111', id: 'FF1-SKYZ2E3A' }],
        async (cwd, read) => {
          const result = await runDeviceAddAsync(cwd, '--host', host, '--name', 'office');
          assert.equal(result.status, 0, result.stderr || result.stdout);
          assert.equal(requests(), 0);
          assert.equal(read()[0].id, 'FF1-SKYZ2E3A');
        }
      )
    );
  });

  test('an ID another row holds is not recorded, and that row is left alone', async () => {
    const kitchen = { name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'FF1-KITCHEN1' };
    await withStatusServer('FF1-KITCHEN1', (host) =>
      withConfigAsync([kitchen], async (cwd, read) => {
        const result = await runDeviceAddAsync(cwd, '--host', host, '--name', 'office');
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /already configured as "kitchen"/);
        const devices = read();
        assert.deepEqual(devices[0], kitchen);
        assert.equal(devices[1].name, 'office');
        assert.equal(devices[1].id, undefined);
      })
    );
  });
});
