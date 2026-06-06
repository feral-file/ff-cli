import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { getFF1DeviceConfig } from '../src/config';
import { configuredFF1Devices, isMissingConfigValue } from '../src/utilities/config-placeholders';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

function withTempConfig<T>(config: Record<string, unknown>, fn: (dir: string) => T): T {
  const cwd = process.cwd();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const dir = mkdtempSync(join(tmpdir(), 'ff1-config-placeholders-'));
  try {
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    process.chdir(dir);
    process.env.XDG_CONFIG_HOME = join(dir, '.xdg');
    return fn(dir);
  } finally {
    process.chdir(cwd);
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseConfig(devices: Array<{ name?: string; host: string }>): Record<string, unknown> {
  return {
    defaultModel: 'grok',
    defaultDuration: 10,
    models: {
      grok: {
        apiKey: 'xai-test',
        baseURL: 'https://api.x.ai/v1',
        model: 'grok-beta',
        supportsFunctionCalling: true,
      },
    },
    browser: {
      timeout: 90000,
      sanitizationLevel: 'medium',
    },
    ff1Devices: {
      devices,
    },
  };
}

describe('config placeholder handling', () => {
  test('isMissingConfigValue treats bundled sample values as unset', () => {
    assert.equal(isMissingConfigValue(''), true);
    assert.equal(isMissingConfigValue('http://YOUR_FF1_IP_ADDRESS:1111'), true);
    assert.equal(isMissingConfigValue('your_api_key_here'), true);
    assert.equal(isMissingConfigValue('http://192.168.1.100:1111'), false);
  });

  test('configuredFF1Devices drops sample rows and keeps real devices', () => {
    const devices = configuredFF1Devices([
      {
        name: 'DISPLAY_NAME_FOR_YOUR_FF1_DEVICE',
        host: 'http://YOUR_FF1_IP_ADDRESS:1111',
      },
      { name: 'kitchen', host: 'http://192.168.1.100:1111' },
    ]);

    assert.deepEqual(devices, [{ name: 'kitchen', host: 'http://192.168.1.100:1111' }]);
  });

  test('getFF1DeviceConfig does not expose sample placeholder devices to play/send flows', () => {
    withTempConfig(
      baseConfig([
        {
          name: 'DISPLAY_NAME_FOR_YOUR_FF1_DEVICE',
          host: 'http://YOUR_FF1_IP_ADDRESS:1111',
        },
      ]),
      () => {
        assert.deepEqual(getFF1DeviceConfig().devices, []);
      }
    );
  });

  test('status reports zero configured devices for a sample placeholder row', () => {
    withTempConfig(
      baseConfig([
        {
          name: 'DISPLAY_NAME_FOR_YOUR_FF1_DEVICE',
          host: 'http://YOUR_FF1_IP_ADDRESS:1111',
        },
      ]),
      (dir) => {
        const result = spawnSync(process.execPath, [tsxCli, cliEntry, 'status'], {
          cwd: dir,
          env: { ...process.env, XDG_CONFIG_HOME: join(dir, '.xdg') },
          encoding: 'utf-8',
        });
        const output = `${result.stdout || ''}${result.stderr || ''}`;

        assert.equal(result.status, 1, output);
        assert.match(output, /FF1 devices \(0\)/);
        assert.doesNotMatch(output, /DISPLAY_NAME_FOR_YOUR_FF1_DEVICE/);
        assert.doesNotMatch(output, /YOUR_FF1_IP_ADDRESS/);
      }
    );
  });
});
