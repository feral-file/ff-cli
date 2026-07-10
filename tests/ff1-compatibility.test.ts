import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  assertFF1CommandCompatibility,
  resolveConfiguredDevice,
} from '../src/utilities/ff1-compatibility';

interface FF1DeviceForTest {
  host?: string;
  name?: string;
  apiKey?: string;
  id?: string;
}

interface MockApiResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}

type FetchHandler = (url: string, options?: RequestInit) => MockApiResponse;

let fixtureDir: string;
const originalCwd = process.cwd();
const originalFetch = global.fetch;
let requests: { method: string; url: string; body?: unknown }[] = [];

const installFetchMock = (handler: FetchHandler): void => {
  global.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
    const requestUrl = typeof url === 'string' ? url : url.toString();
    const body = options?.body ? JSON.parse(options.body as string) : undefined;
    requests.push({ method: options?.method || 'GET', url: requestUrl, body });
    return handler(requestUrl, options) as unknown as Response;
  }) as unknown as typeof global.fetch;
};

const clearFetchMock = (): void => {
  global.fetch = originalFetch;
  requests = [];
};

const writeDeviceConfig = (devices: FF1DeviceForTest[]): void => {
  writeFileSync(
    path.join(process.cwd(), 'config.json'),
    JSON.stringify({
      ff1Devices: {
        devices,
      },
    }),
    'utf8'
  );
};

/**
 * Build a mock getDeviceStatus response matching the real API shape.
 *
 * @param {string} installedVersion - Version to report
 * @returns {object} Mock response body
 */
const deviceStatusResponse = (installedVersion: string) => ({
  message: {
    screenRotation: 'landscape',
    connectedWifi: 'test_wifi',
    installedVersion,
    latestVersion: installedVersion,
    timezone: 'UTC',
    currentTime: '2026-01-01 00:00:00',
    volume: 25,
    isMuted: false,
  },
});

describe('resolveConfiguredDevice', () => {
  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'ff1-compatibility-test-'));
    process.chdir(fixtureDir);
    requests = [];
  });

  afterEach(() => {
    clearFetchMock();
    // Windows keeps the current working directory locked, so move back out of
    // the temp fixture before attempting recursive cleanup.
    process.chdir(originalCwd);
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('returns the first configured device when no deviceName is provided', () => {
    writeDeviceConfig([
      { name: 'Frame 1', host: 'http://ff1-frame-1.local' },
      { name: 'Frame 2', host: 'http://ff1-frame-2.local' },
    ]);

    const result = resolveConfiguredDevice();

    assert.equal(result.success, true);
    assert.equal(result.device?.host, 'http://ff1-frame-1.local');
    assert.equal(result.device?.name, 'Frame 1');
  });

  test('finds the named device when a deviceName is provided', () => {
    writeDeviceConfig([
      { name: 'Frame 1', host: 'http://ff1-frame-1.local' },
      { name: 'Frame 2', host: 'http://ff1-frame-2.local' },
    ]);

    const result = resolveConfiguredDevice('Frame 2');

    assert.equal(result.success, true);
    assert.equal(result.device?.host, 'http://ff1-frame-2.local');
  });

  test('returns a clear error when no devices are configured', () => {
    writeDeviceConfig([]);

    const result = resolveConfiguredDevice();

    assert.equal(result.success, false);
    assert.equal(
      result.error,
      'No FF1 devices configured. Add devices to config.json under "ff1Devices"'
    );
  });

  test('returns a clear error when the requested device name does not exist', () => {
    writeDeviceConfig([{ name: 'Frame 1', host: 'http://ff1-frame-1.local' }]);

    const result = resolveConfiguredDevice('Missing');

    assert.equal(result.success, false);
    assert.equal(result.error, 'Device "Missing" not found. Available devices: Frame 1');
  });
});

describe('assertFF1CommandCompatibility', () => {
  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'ff1-compatibility-test-'));
    process.chdir(fixtureDir);
    requests = [];
  });

  afterEach(() => {
    clearFetchMock();
    // Windows keeps the current working directory locked, so move back out of
    // the temp fixture before attempting recursive cleanup.
    process.chdir(originalCwd);
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('returns compatible when getDeviceStatus call fails', async () => {
    installFetchMock(() => ({
      status: 500,
      ok: false,
      json: async () => ({ error: 'not available' }),
    }));

    const result = await assertFF1CommandCompatibility(
      { host: 'http://ff1.local' },
      'displayPlaylist'
    );

    assert.equal(result.compatible, true);
    assert.equal(result.version, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, 'http://ff1.local/api/cast');
    assert.deepEqual(requests[0].body, { command: 'getDeviceStatus', request: {} });
  });

  test('flags device versions that are below minimum', async () => {
    installFetchMock(() => ({
      status: 200,
      ok: true,
      json: async () => deviceStatusResponse('0.9.0'),
    }));

    const result = await assertFF1CommandCompatibility({ host: 'http://ff1.local' }, 'sshAccess');

    assert.equal(result.compatible, false);
    assert.equal(result.version, '0.9.0');
    assert.match(result.error || '', /Unsupported FF1 OS 0\.9\.0 for sshAccess/);
  });

  test('accepts supported versions from getDeviceStatus', async () => {
    installFetchMock(() => ({
      status: 200,
      ok: true,
      json: async () => deviceStatusResponse('2.1.0'),
    }));

    const result = await assertFF1CommandCompatibility(
      { host: 'http://ff1.local' },
      'displayPlaylist'
    );

    assert.equal(result.compatible, true);
    assert.equal(result.version, '2.1.0');
  });

  test('returns compatible when installedVersion is missing from response', async () => {
    installFetchMock(() => ({
      status: 200,
      ok: true,
      json: async () => ({ message: { connectedWifi: 'test' } }),
    }));

    const result = await assertFF1CommandCompatibility(
      { host: 'http://ff1.local' },
      'displayPlaylist'
    );

    assert.equal(result.compatible, true);
    assert.equal(result.version, undefined);
  });

  test('normalizes two-segment versions from device', async () => {
    installFetchMock(() => ({
      status: 200,
      ok: true,
      json: async () => deviceStatusResponse('2.1'),
    }));

    const result = await assertFF1CommandCompatibility(
      { host: 'http://ff1.local' },
      'displayPlaylist'
    );

    assert.equal(result.compatible, true);
    assert.equal(result.version, '2.1.0');
  });
});
