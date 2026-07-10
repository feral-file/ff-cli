import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getFF1RelayerConfig, validateConfig } from '../src/config';

const originalCwd = process.cwd();
const originalUrl = process.env.FF1_RELAYER_URL;
const originalKey = process.env.FF1_RELAYER_API_KEY;
let fixtureDir: string;

describe('FF1 relayer configuration', () => {
  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'ff1-relayer-config-'));
    process.chdir(fixtureDir);
    delete process.env.FF1_RELAYER_URL;
    delete process.env.FF1_RELAYER_API_KEY;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalUrl === undefined) {
      delete process.env.FF1_RELAYER_URL;
    } else {
      process.env.FF1_RELAYER_URL = originalUrl;
    }
    if (originalKey === undefined) {
      delete process.env.FF1_RELAYER_API_KEY;
    } else {
      process.env.FF1_RELAYER_API_KEY = originalKey;
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('uses config over environment and strips one trailing slash', () => {
    process.env.FF1_RELAYER_URL = 'https://env.example';
    process.env.FF1_RELAYER_API_KEY = 'env-key';
    writeFileSync(
      join(fixtureDir, 'config.json'),
      JSON.stringify({
        ff1Relayer: { baseUrl: 'https://config.example/', apiKey: 'config-key' },
      })
    );

    assert.deepEqual(getFF1RelayerConfig(), {
      baseUrl: 'https://config.example',
      apiKey: 'config-key',
    });
  });

  test('uses environment before the production default', () => {
    process.env.FF1_RELAYER_URL = 'https://env.example/';
    process.env.FF1_RELAYER_API_KEY = 'env-key';
    assert.deepEqual(getFF1RelayerConfig(), {
      baseUrl: 'https://env.example',
      apiKey: 'env-key',
    });
  });

  test('rejects malformed relayer configuration during validation and use', () => {
    writeFileSync(
      join(fixtureDir, 'config.json'),
      JSON.stringify({ ff1Relayer: { baseUrl: 42, apiKey: ['bad'] } })
    );

    const validation = validateConfig();
    assert.equal(validation.valid, false);
    assert.match(validation.errors.join('\n'), /ff1Relayer\.baseUrl must be a string/);
    assert.throws(getFF1RelayerConfig, /ff1Relayer\.baseUrl must be a string/);
  });
});
