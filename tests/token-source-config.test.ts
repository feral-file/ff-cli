import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getTokenSourceConfig, validateConfig } from '../src/config';

const ENV_KEYS = ['FF_TOKEN_SOURCE', 'IPFS_GATEWAY_FERAL_FILE', 'IPFS_GATEWAY_DEFAULT'] as const;
const originalCwd = process.cwd();
const originalEnv: Record<string, string | undefined> = {};
let fixtureDir: string;

function writeConfig(body: unknown): void {
  writeFileSync(join(fixtureDir, 'config.json'), JSON.stringify(body));
}

describe('token source configuration', () => {
  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'ff-token-source-config-'));
    process.chdir(fixtureDir);
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('defaults to Raster with the Feral File and Filebase gateways', () => {
    assert.deepEqual(getTokenSourceConfig(), {
      source: 'raster',
      ipfsGateways: {
        feralFile: 'https://ipfs.feralfile.com/ipfs/',
        default: 'https://ipfs.filebase.io/ipfs/',
      },
    });
  });

  test('uses config over environment', () => {
    process.env.FF_TOKEN_SOURCE = 'raster';
    process.env.IPFS_GATEWAY_DEFAULT = 'https://env.example/ipfs/';
    writeConfig({
      tokenSource: 'indexer',
      ipfsGateways: { default: 'https://config.example/ipfs' },
    });
    const resolved = getTokenSourceConfig();
    assert.equal(resolved.source, 'indexer');
    assert.equal(resolved.ipfsGateways.default, 'https://config.example/ipfs/');
    assert.equal(resolved.ipfsGateways.feralFile, 'https://ipfs.feralfile.com/ipfs/');
  });

  test('uses environment before the defaults', () => {
    process.env.FF_TOKEN_SOURCE = 'indexer';
    process.env.IPFS_GATEWAY_FERAL_FILE = 'https://gateway.example';
    const resolved = getTokenSourceConfig();
    assert.equal(resolved.source, 'indexer');
    // A bare origin is accepted and normalized to the /ipfs/ path form.
    assert.equal(resolved.ipfsGateways.feralFile, 'https://gateway.example/ipfs/');
  });

  test('rejects an unknown token source by name', () => {
    writeConfig({ tokenSource: 'blockscout' });
    assert.throws(() => getTokenSourceConfig(), /tokenSource must be one of: raster, indexer/);
    const result = validateConfig();
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((line) => line.includes('tokenSource must be one of')));
  });

  test('rejects a gateway that is not an HTTP(S) URL', () => {
    process.env.IPFS_GATEWAY_DEFAULT = 'ipfs://not-a-gateway';
    assert.throws(
      () => getTokenSourceConfig(),
      /ipfsGateways.default must be a valid HTTP\(S\) URL/
    );
    const result = validateConfig();
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((line) => line.includes('ipfsGateways.default')));
  });

  test('rejects a non-object ipfsGateways block', () => {
    writeConfig({ ipfsGateways: 'https://gateway.example' });
    assert.throws(() => getTokenSourceConfig(), /ipfsGateways must be an object/);
  });

  test('a valid configuration passes validateConfig', () => {
    writeConfig({ tokenSource: 'raster', ipfsGateways: { feralFile: 'https://a.example/ipfs/' } });
    assert.equal(validateConfig().valid, true);
  });
});
