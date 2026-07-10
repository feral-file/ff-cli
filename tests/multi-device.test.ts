import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { resolveConfiguredDevice } from '../src/utilities/ff1-compatibility';

interface FF1DeviceForTest {
  host?: string;
  name?: string;
  apiKey?: string;
  id?: string;
}

let fixtureDir: string;
const originalCwd = process.cwd();

const writeDeviceConfig = (devices: FF1DeviceForTest[]): void => {
  writeFileSync(
    path.join(process.cwd(), 'config.json'),
    JSON.stringify({ ff1Devices: { devices } }),
    'utf8'
  );
};

describe('multi-device resolution', () => {
  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'ff1-multi-device-test-'));
    process.chdir(fixtureDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('defaults to first device when multiple are configured', () => {
    writeDeviceConfig([
      { name: 'kitchen', host: 'http://192.168.1.10:1111' },
      { name: 'office', host: 'http://192.168.1.11:1111' },
      { name: 'bedroom', host: 'http://192.168.1.12:1111' },
    ]);

    const result = resolveConfiguredDevice();
    assert.equal(result.success, true);
    assert.equal(result.device?.name, 'kitchen');
    assert.equal(result.device?.host, 'http://192.168.1.10:1111');
  });

  test('selects specific device by name from multiple devices', () => {
    writeDeviceConfig([
      { name: 'kitchen', host: 'http://192.168.1.10:1111' },
      { name: 'office', host: 'http://192.168.1.11:1111' },
      { name: 'bedroom', host: 'http://192.168.1.12:1111' },
    ]);

    const result = resolveConfiguredDevice('bedroom');
    assert.equal(result.success, true);
    assert.equal(result.device?.name, 'bedroom');
    assert.equal(result.device?.host, 'http://192.168.1.12:1111');
  });

  test('returns error with available device names when requested device not found', () => {
    writeDeviceConfig([
      { name: 'kitchen', host: 'http://192.168.1.10:1111' },
      { name: 'office', host: 'http://192.168.1.11:1111' },
    ]);

    const result = resolveConfiguredDevice('garage');
    assert.equal(result.success, false);
    assert.match(result.error || '', /garage/);
    assert.match(result.error || '', /kitchen, office/);
  });

  test('selects middle device from list of many', () => {
    writeDeviceConfig([
      { name: 'device-1', host: 'http://10.0.0.1:1111' },
      { name: 'device-2', host: 'http://10.0.0.2:1111' },
      { name: 'device-3', host: 'http://10.0.0.3:1111' },
      { name: 'device-4', host: 'http://10.0.0.4:1111' },
      { name: 'device-5', host: 'http://10.0.0.5:1111' },
    ]);

    const result = resolveConfiguredDevice('device-3');
    assert.equal(result.success, true);
    assert.equal(result.device?.host, 'http://10.0.0.3:1111');
  });

  test('device name matching is exact (case-sensitive)', () => {
    writeDeviceConfig([
      { name: 'Kitchen', host: 'http://192.168.1.10:1111' },
      { name: 'kitchen', host: 'http://192.168.1.11:1111' },
    ]);

    const result = resolveConfiguredDevice('kitchen');
    assert.equal(result.success, true);
    assert.equal(result.device?.host, 'http://192.168.1.11:1111');
  });

  test('preserves device-specific apiKey and stable ID', () => {
    writeDeviceConfig([
      { name: 'kitchen', host: 'http://192.168.1.10:1111', apiKey: 'key-k', id: 'FF1-K' },
      { name: 'office', host: 'http://192.168.1.11:1111', apiKey: 'key-o', id: 'FF1-O' },
    ]);

    const result = resolveConfiguredDevice('office');
    assert.equal(result.success, true);
    assert.equal(result.device?.apiKey, 'key-o');
    assert.equal(result.device?.id, 'FF1-O');
  });

  test('works with device that has no name when selecting by default', () => {
    writeDeviceConfig([
      { host: 'http://192.168.1.10:1111' },
      { name: 'office', host: 'http://192.168.1.11:1111' },
    ]);

    const result = resolveConfiguredDevice();
    assert.equal(result.success, true);
    assert.equal(result.device?.host, 'http://192.168.1.10:1111');
    assert.equal(result.device?.name, undefined);
  });
});
