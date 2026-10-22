/**
 * setup never replaces a configured signing key without --force.
 *
 * The configured key is the curator identity that owns every playlist it
 * published; `publish --replace` and `unpublish` accept only that key, and
 * setup keeps no copy of the old one. The documented agent bootstrap
 * (`setup --non-interactive --generate-key`) used to swap it silently when run
 * on a machine that was already configured.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

/** newKey returns a fresh Ed25519 key as base64 PKCS#8 DER, the form setup writes. */
function newKey(): string {
  return generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
}

/**
 * runSetup runs `ff-cli setup <args>` in a temp dir whose config.json
 * already holds `key`, and hands back the run and the key setup left behind.
 */
function runSetup(
  key: string,
  args: string[]
): { status: number | null; output: string; keyAfter: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'ff-cli-setup-key-'));
  const configPath = join(cwd, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ playlist: { privateKey: key, role: 'curator' }, ff1Devices: { devices: [] } }),
    'utf8'
  );
  try {
    const run = spawnSync(
      process.execPath,
      [tsxCli, cliEntry, 'setup', '--non-interactive', ...args],
      {
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: join(cwd, '.xdg'), PLAYLIST_PRIVATE_KEY: '' },
        encoding: 'utf-8',
      }
    );
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
      playlist: { privateKey: string };
    };
    return {
      status: run.status,
      output: `${run.stdout}${run.stderr}`,
      keyAfter: written.playlist.privateKey,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('setup and an already configured signing key', () => {
  test('--generate-key refuses to replace it and names the identity it would lose', () => {
    const configured = newKey();
    const run = runSetup(configured, ['--generate-key']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /A signing key is already configured/);
    assert.ok(run.output.includes(playlistSigningDidKey(configured)), run.output);
    assert.match(run.output, /add --force to replace it/);
    assert.equal(run.keyAfter, configured, 'the configured key must be untouched');
  });

  test('--generate-key --force replaces it', () => {
    const configured = newKey();
    const run = runSetup(configured, ['--generate-key', '--force']);
    assert.equal(run.status, 0, run.output);
    assert.notEqual(run.keyAfter, configured);
  });

  test('--key with a different key refuses without --force', () => {
    const configured = newKey();
    const run = runSetup(configured, ['--key', newKey()]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /Re-run without --key to keep it/);
    assert.equal(run.keyAfter, configured);
  });

  test('--key with the same key is not a replacement', () => {
    const configured = newKey();
    const run = runSetup(configured, ['--key', configured]);
    assert.equal(run.status, 0, run.output);
    assert.equal(run.keyAfter, configured);
  });

  test('a run without key flags keeps the configured key', () => {
    const configured = newKey();
    const run = runSetup(configured, []);
    assert.equal(run.status, 0, run.output);
    assert.equal(run.keyAfter, configured);
  });
});
