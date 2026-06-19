import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { validateConfig } from '../src/config';

function withIsolatedConfig<T>(fn: () => T): T {
  const cwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'ff1-config-validate-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  try {
    process.chdir(tempDir);
    process.env.XDG_CONFIG_HOME = tempDir;
    return fn();
  } finally {
    process.chdir(cwd);
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeValidBaseConfig(tempDir: string, playlist?: Record<string, unknown>): void {
  writeFileSync(
    join(tempDir, 'config.json'),
    JSON.stringify(
      {
        playlist,
      },
      null,
      2
    ),
    'utf-8'
  );
}

function runCli(cwd: string, args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const projectRoot = join(__dirname, '..');
  const result = spawnSync(
    process.execPath,
    [join(projectRoot, 'node_modules/tsx/dist/cli.mjs'), join(projectRoot, 'index.ts'), ...args],
    {
      cwd,
      env: { ...process.env, XDG_CONFIG_HOME: tempDirConfigHome(cwd), ...extraEnv },
      encoding: 'utf-8',
    }
  );

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function tempDirConfigHome(cwd: string): string {
  return join(cwd, '.xdg');
}

describe('config validation playlist role contract', () => {
  test('config.json role overrides PLAYLIST_ROLE for validateConfig and CLI status/sign flows', () => {
    withIsolatedConfig(() => {
      const tempDir = process.cwd();
      const originalRole = process.env.PLAYLIST_ROLE;
      const { privateKey } = generateKeyPairSync('ed25519');
      const privateKeyBase64 = privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64');

      try {
        writeValidBaseConfig(tempDir, { privateKey: privateKeyBase64, role: 'feed' });
        process.env.PLAYLIST_ROLE = 'owner';

        const configResult = validateConfig();
        assert.equal(configResult.valid, true);

        const statusResult = runCli(tempDir, ['status'], { PLAYLIST_ROLE: 'owner' });
        assert.equal(statusResult.status, 1, `${statusResult.stdout}${statusResult.stderr}`);
        assert.match(statusResult.stdout + statusResult.stderr, /OK Playlist signing role/);
        assert.match(statusResult.stdout + statusResult.stderr, /feed/);
        assert.doesNotMatch(
          statusResult.stdout + statusResult.stderr,
          /Invalid Playlist signing role/
        );

        const configValidateResult = runCli(tempDir, ['config', 'validate'], {
          PLAYLIST_ROLE: 'owner',
        });
        assert.equal(
          configValidateResult.status,
          0,
          `${configValidateResult.stdout}${configValidateResult.stderr}`
        );
        assert.match(configValidateResult.stdout, /Configuration is valid/i);

        const playlistPath = join(tempDir, 'playlist.json');
        writeFileSync(
          playlistPath,
          JSON.stringify(
            {
              dpVersion: '1.1.0',
              title: 'Precedence',
              items: [
                {
                  source: 'https://example.com/art.mp4',
                  duration: 10,
                  license: 'token',
                },
              ],
            },
            null,
            2
          ),
          'utf-8'
        );

        const signResult = runCli(
          tempDir,
          ['sign', playlistPath, '-o', join(tempDir, 'signed.json')],
          {
            PLAYLIST_ROLE: 'owner',
          }
        );
        assert.equal(signResult.status, 0, `${signResult.stdout}${signResult.stderr}`);

        const signed = JSON.parse(readFileSync(join(tempDir, 'signed.json'), 'utf-8')) as {
          signatures?: Array<{ role?: string }>;
        };
        assert.equal(signed.signatures?.at(-1)?.role, 'feed');
      } finally {
        if (originalRole === undefined) {
          delete process.env.PLAYLIST_ROLE;
        } else {
          process.env.PLAYLIST_ROLE = originalRole;
        }
      }
    });
  });

  test('validateConfig uses PLAYLIST_ROLE when it is the effective runtime role', () => {
    withIsolatedConfig(() => {
      const tempDir = process.cwd();
      const previousRole = process.env.PLAYLIST_ROLE;
      try {
        writeValidBaseConfig(tempDir);
        process.env.PLAYLIST_ROLE = 'owner';

        const result = validateConfig();

        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /playlist\.role must be one of:/);
      } finally {
        if (previousRole === undefined) {
          delete process.env.PLAYLIST_ROLE;
        } else {
          process.env.PLAYLIST_ROLE = previousRole;
        }
      }
    });
  });

  test('validateConfig accepts whitespace-padded playlist.role values after trimming', () => {
    withIsolatedConfig(() => {
      const tempDir = process.cwd();
      writeValidBaseConfig(tempDir, { role: '  feed  ' });

      const result = validateConfig();

      assert.equal(result.valid, true);
      assert.deepEqual(result.errors, []);
    });
  });

  test('validateConfig rejects an unsupported playlist.role from config.json even when PLAYLIST_ROLE is valid', () => {
    withIsolatedConfig(() => {
      const tempDir = process.cwd();
      const previousRole = process.env.PLAYLIST_ROLE;
      try {
        writeValidBaseConfig(tempDir, { role: 'owner' });
        process.env.PLAYLIST_ROLE = 'feed';

        const result = validateConfig();

        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /playlist\.role must be one of:/);
      } finally {
        if (previousRole === undefined) {
          delete process.env.PLAYLIST_ROLE;
        } else {
          process.env.PLAYLIST_ROLE = previousRole;
        }
      }
    });
  });
});
