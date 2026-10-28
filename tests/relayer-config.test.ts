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
      v2Endpoint: 'https://config.example',
    });
  });

  test('uses environment before the production default', () => {
    process.env.FF1_RELAYER_URL = 'https://env.example/';
    process.env.FF1_RELAYER_API_KEY = 'env-key';
    assert.deepEqual(getFF1RelayerConfig(), {
      baseUrl: 'https://env.example',
      apiKey: 'env-key',
      v2Endpoint: 'https://env.example',
    });
  });

  test('relay v2 defaults to the production relayer origin', () => {
    assert.equal(
      getFF1RelayerConfig().v2Endpoint,
      'https://tv-cast-coordination.autonomy-system.workers.dev'
    );
  });

  test('a relayer URL that is not a bare HTTPS origin turns v2 off', () => {
    for (const baseUrl of [
      'http://relay.lan:8080',
      'https://relay.example/legacy',
      'https://user:pass@relay.example',
      'https://relay.example/?q=1',
      'https://relay.example/#frag',
    ]) {
      process.env.FF1_RELAYER_URL = baseUrl;
      assert.equal(getFF1RelayerConfig().v2Endpoint, undefined, baseUrl);
    }
  });

  test('a bare HTTPS relayer origin with a port derives its own origin', () => {
    process.env.FF1_RELAYER_URL = 'https://relay.example:8443/';
    assert.equal(getFF1RelayerConfig().v2Endpoint, 'https://relay.example:8443');
  });

  test('there is no separate v2 setting: a v2Endpoint key or env var is ignored', () => {
    process.env.FF1_RELAY_V2_ENDPOINT = 'wss://other.example';
    writeFileSync(
      join(fixtureDir, 'config.json'),
      JSON.stringify({ ff1Relayer: { baseUrl: 'https://relay.example', v2Endpoint: '' } })
    );
    try {
      assert.deepEqual(getFF1RelayerConfig(), {
        baseUrl: 'https://relay.example',
        apiKey: undefined,
        v2Endpoint: 'https://relay.example',
      });
    } finally {
      delete process.env.FF1_RELAY_V2_ENDPOINT;
    }
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
