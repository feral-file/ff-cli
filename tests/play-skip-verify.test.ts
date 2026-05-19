import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

function runCli(
  cwd: string,
  args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(cwd, '.xdg'),
    },
  });

  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

describe('play --skip-verify', () => {
  test('bypasses playlist verification and still reaches delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-cli-play-skip-'));
    try {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify(
          {
            ff1Devices: {
              devices: [
                {
                  name: 'test-device',
                  host: 'http://127.0.0.1:65535',
                },
              ],
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      const playlistPath = join(dir, 'invalid-playlist.json');
      writeFileSync(
        playlistPath,
        JSON.stringify(
          {
            dpVersion: '1.1.0',
            title: 'broken',
          },
          null,
          2
        ),
        'utf-8'
      );

      const result = runCli(dir, ['play', playlistPath, '--skip-verify']);

      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout + result.stderr, /Playlist validation failed/i);
      assert.match(result.stdout + result.stderr, /Play failed|Could not reach device/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
