import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');
const fixtureConfig = resolve(projectRoot, 'tests/fixtures/config.test.json');

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv, XDG_CONFIG_HOME: join(cwd, '.xdg') },
    encoding: 'utf-8',
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('ff1 status playlist role health', () => {
  test('marks an unsupported playlist signing role as invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff1-status-role-'));
    try {
      copyFileSync(fixtureConfig, join(dir, 'config.json'));
      const original = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as {
        playlist?: { role?: string };
      };
      original.playlist = { ...(original.playlist || {}), role: 'owner' };
      writeFileSync(join(dir, 'config.json'), JSON.stringify(original, null, 2), 'utf-8');

      const result = runCli(dir, ['status']);

      assert.notEqual(result.status, null);
      assert.match(result.stdout + result.stderr, /Playlist signing role/);
      assert.match(result.stdout + result.stderr, /Invalid Playlist signing role/);
      assert.match(result.stdout + result.stderr, /owner/);
      assert.doesNotMatch(result.stdout + result.stderr, /Not set Playlist signing role/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks an unsupported playlist signing role from config.json as invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff1-status-role-file-invalid-'));
    try {
      copyFileSync(fixtureConfig, join(dir, 'config.json'));
      const original = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as {
        playlist?: { role?: string };
      };
      original.playlist = { ...(original.playlist || {}), role: 'owner' };
      writeFileSync(join(dir, 'config.json'), JSON.stringify(original, null, 2), 'utf-8');

      const result = runCli(dir, ['status']);

      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /Invalid Playlist signing role/);
      assert.match(result.stdout + result.stderr, /owner/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts a whitespace-padded supported playlist signing role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff1-status-role-ok-'));
    try {
      copyFileSync(fixtureConfig, join(dir, 'config.json'));
      const original = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as {
        playlist?: { role?: string };
      };
      original.playlist = { ...(original.playlist || {}), role: '  feed  ' };
      writeFileSync(join(dir, 'config.json'), JSON.stringify(original, null, 2), 'utf-8');

      const result = runCli(dir, ['status']);

      assert.notEqual(result.status, null);
      assert.match(result.stdout + result.stderr, /OK Playlist signing role/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses PLAYLIST_ROLE when config.json omits the role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff1-status-role-env-'));
    try {
      copyFileSync(fixtureConfig, join(dir, 'config.json'));
      const original = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as {
        playlist?: { role?: string };
      };
      if (original.playlist) {
        delete original.playlist.role;
      }
      writeFileSync(join(dir, 'config.json'), JSON.stringify(original, null, 2), 'utf-8');

      const result = runCli(dir, ['status'], { PLAYLIST_ROLE: 'curator' });

      assert.notEqual(result.status, null);
      assert.match(result.stdout + result.stderr, /OK Playlist signing role/);
      assert.match(result.stdout + result.stderr, /curator/);
      assert.doesNotMatch(result.stdout + result.stderr, /used when signing playlists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses PLAYLIST_PRIVATE_KEY when config.json omits the key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff1-status-key-env-'));
    try {
      copyFileSync(fixtureConfig, join(dir, 'config.json'));
      const original = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as {
        playlist?: { privateKey?: string };
      };
      if (original.playlist) {
        delete original.playlist.privateKey;
      }
      writeFileSync(join(dir, 'config.json'), JSON.stringify(original, null, 2), 'utf-8');

      const result = runCli(dir, ['status'], { PLAYLIST_PRIVATE_KEY: 'env-private-key' });

      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout + result.stderr,
        /Invalid Playlist signing key|Missing Playlist signing key/
      );
      assert.match(result.stdout + result.stderr, /from config\/env/);
      assert.match(result.stdout + result.stderr, /needed for signing and legacy verification/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks an unsupported PLAYLIST_ROLE as invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff1-status-role-env-invalid-'));
    try {
      copyFileSync(fixtureConfig, join(dir, 'config.json'));
      const original = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as {
        playlist?: { role?: string };
      };
      if (original.playlist) {
        delete original.playlist.role;
      }
      writeFileSync(join(dir, 'config.json'), JSON.stringify(original, null, 2), 'utf-8');

      const result = runCli(dir, ['status'], { PLAYLIST_ROLE: 'owner' });

      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /Invalid Playlist signing role/);
      assert.match(result.stdout + result.stderr, /owner/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * PLAYLIST_PRIVATE_KEY is a supported signing source by itself, and the did:key it implies has to be
 * known *before* signing — it must be declared in curators[], which the signature then covers. If status
 * only spoke when a config file existed, an environment-only user could not obtain that value anywhere.
 */
describe('status signing identity without a config file', () => {
  test('reports the did:key from PLAYLIST_PRIVATE_KEY when no config exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff1-status-envonly-'));
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const material = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString(
        'base64'
      );
      const expected = playlistSigningDidKey(material);

      const result = runCli(dir, ['status'], { PLAYLIST_PRIVATE_KEY: material });
      const out = result.stdout + result.stderr;

      assert.match(out, /config\.json not found/);
      assert.ok(out.includes(expected), `status should surface ${expected}; got:\n${out}`);
      // Still "not configured" for scripts that check the status code.
      assert.equal(result.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('says so rather than crashing when the environment key is unusable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff1-status-envbad-'));
    try {
      const result = runCli(dir, ['status'], { PLAYLIST_PRIVATE_KEY: 'not-a-key' });
      const out = result.stdout + result.stderr;
      assert.match(out, /PLAYLIST_PRIVATE_KEY unusable/);
      assert.equal(result.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
