import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getFF1RelayerConfig, validateConfig } from '../src/config';

const originalCwd = process.cwd();
const originalUrl = process.env.FF1_RELAYER_URL;
const originalKey = process.env.FF1_RELAYER_API_KEY;
const originalV2 = process.env.FF1_RELAY_V2_ENDPOINT;
let fixtureDir: string;

describe('FF1 relayer configuration', () => {
  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'ff1-relayer-config-'));
    process.chdir(fixtureDir);
    delete process.env.FF1_RELAYER_URL;
    delete process.env.FF1_RELAYER_API_KEY;
    delete process.env.FF1_RELAY_V2_ENDPOINT;
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
    if (originalV2 === undefined) {
      delete process.env.FF1_RELAY_V2_ENDPOINT;
    } else {
      process.env.FF1_RELAY_V2_ENDPOINT = originalV2;
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

  test('a plain-HTTP or path-bearing relayer gets no default v2 endpoint', () => {
    for (const baseUrl of ['http://relay.lan:8080', 'https://relay.example/legacy']) {
      process.env.FF1_RELAYER_URL = baseUrl;
      assert.equal(getFF1RelayerConfig().v2Endpoint, undefined, baseUrl);
    }
  });

  test('an explicit v2 endpoint wins and an empty one turns v2 off', () => {
    assert.equal(getFF1RelayerConfig().v2Explicit, undefined, 'a derived endpoint is not explicit');
    process.env.FF1_RELAY_V2_ENDPOINT = 'wss://v2.example';
    assert.equal(getFF1RelayerConfig().v2Endpoint, 'wss://v2.example');
    assert.equal(getFF1RelayerConfig().v2Explicit, true);
    writeFileSync(
      join(fixtureDir, 'config.json'),
      JSON.stringify({ ff1Relayer: { v2Endpoint: '' } })
    );
    assert.equal(getFF1RelayerConfig().v2Endpoint, undefined);
  });

  test('rejects a v2 endpoint that is not a secure bare origin', () => {
    for (const v2Endpoint of [
      'http://v2.example',
      'https://v2.example/path',
      'https://user@v2.example',
      'not a url',
    ]) {
      process.env.FF1_RELAY_V2_ENDPOINT = v2Endpoint;
      assert.throws(getFF1RelayerConfig, /v2Endpoint/, v2Endpoint);
    }
    process.env.FF1_RELAY_V2_ENDPOINT = 'http://127.0.0.1:8787';
    assert.equal(getFF1RelayerConfig().v2Endpoint, 'http://127.0.0.1:8787');
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
