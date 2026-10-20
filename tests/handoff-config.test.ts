import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { getFF1HandoffConfig, validateConfig } from '../src/config';

const originalCwd = process.cwd();
const originalUrl = process.env.FF1_HANDOFF_URL;
let fixtureDir: string;
beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'handoff-config-'));
  process.chdir(fixtureDir);
  writeFileSync('config.json', '{}');
  delete process.env.FF1_HANDOFF_URL;
});
afterEach(() => {
  process.chdir(originalCwd);
  if (originalUrl === undefined) {
    delete process.env.FF1_HANDOFF_URL;
  } else {
    process.env.FF1_HANDOFF_URL = originalUrl;
  }
  rmSync(fixtureDir, { recursive: true, force: true });
});
test('keeps the deployed broker default until explicit cutover', () => {
  assert.equal(getFF1HandoffConfig().baseUrl, 'https://handoff.feralfile.com');
});
test('uses config before environment for a merged local broker', () => {
  process.env.FF1_HANDOFF_URL = 'https://env.example';
  writeFileSync(
    'config.json',
    JSON.stringify({ ff1Handoff: { baseUrl: 'http://127.0.0.1:8787/' } })
  );
  assert.equal(getFF1HandoffConfig().baseUrl, 'http://127.0.0.1:8787');
});
test('uses the environment when no broker is configured', () => {
  process.env.FF1_HANDOFF_URL = 'https://merged.example/';
  assert.equal(getFF1HandoffConfig().baseUrl, 'https://merged.example');
});
test('rejects malformed or credential-bearing broker URLs without exposing them', () => {
  for (const baseUrl of [
    42,
    'file:///tmp/broker',
    'https://user:secret@example.com',
    'https://example.com?token=secret',
    'https://example.com/#secret',
  ]) {
    writeFileSync('config.json', JSON.stringify({ ff1Handoff: { baseUrl } }));
    assert.equal(validateConfig().valid, false);
    assert.throws(getFF1HandoffConfig, /ff1Handoff/);
    assert.doesNotMatch(validateConfig().errors.join('\n'), /secret/);
  }
});
