import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Config } from '../src/types';
import { persistDeviceRemoval } from '../src/commands/helpers/device-removal';

function testConfig(): Config {
  return {
    defaultDuration: 30,
    generativeDuration: 60,
    browser: { timeout: 30_000, sanitizationLevel: 'strict' },
    ff1Devices: {
      devices: [
        { name: 'office', host: 'http://ff1-office.local:1111', id: 'FF1-OFFICE' },
        { name: 'studio', host: 'http://ff1-studio.local:1111', id: 'FF1-STUDIO' },
      ],
    },
  };
}

describe('device remove credential cleanup', () => {
  for (const failurePoint of ['lookup', 'delete'] as const) {
    test(`persists removal when keyring ${failurePoint} fails`, async () => {
      const config = testConfig();
      let persistedNames: Array<string | undefined> = [];
      const warnings: string[] = [];

      const result = await persistDeviceRemoval(config, 0, {
        persistConfig: async (updated) => {
          persistedNames = updated.ff1Devices?.devices.map((device) => device.name) ?? [];
        },
        getTopicId: () => {
          if (failurePoint === 'lookup') {
            throw new Error('keyring locked');
          }
          return 'paired-topic';
        },
        deleteTopicId: () => {
          if (failurePoint === 'delete') {
            throw new Error('keyring unavailable');
          }
          return true;
        },
        warn: (message) => warnings.push(message),
      });

      assert.equal(result.removed.name, 'office');
      assert.deepEqual(persistedNames, ['studio']);
      assert.deepEqual(
        config.ff1Devices?.devices.map((device) => device.name),
        ['studio']
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /device was removed.*secure topic credential/i);
    });
  }
});
