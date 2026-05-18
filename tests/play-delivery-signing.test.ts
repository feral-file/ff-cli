import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, describe, test } from 'node:test';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');
const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

function runCli(
  cwd: string,
  args: string[]
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
      cwd,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(cwd, '.xdg'),
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', (status) => {
      resolvePromise({ status: status ?? 0, stdout, stderr });
    });
  });
}

function makePrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

describe('play delivery signing contract', () => {
  let dir: string;
  let mediaServer: ReturnType<typeof createServer>;
  let mediaUrl: string;
  let privateKeyBase64: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ff-cli-play-delivery-'));
    privateKeyBase64 = makePrivateKeyBase64();

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
          playlist: {
            privateKey: privateKeyBase64,
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    mediaServer = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });

    await new Promise<void>((resolvePromise) => mediaServer.listen(0, resolvePromise));
    const address = mediaServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to start media test server');
    }

    mediaUrl = `http://127.0.0.1:${address.port}/clip.mp4`;
  });

  after(() => {
    mediaServer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('does not auto-sign a local playlist file', async () => {
    const playlistPath = join(dir, 'unsigned-playlist.json');
    writeFileSync(playlistPath, readFileSync(fixturePath, 'utf-8'), 'utf-8');

    const result = await runCli(dir, ['play', playlistPath]);

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Playlist signature verification failed/i);
    assert.doesNotMatch(result.stdout + result.stderr, /Could not reach device/i);
  });

  test('auto-signs the synthesized media fallback before delivery', async () => {
    const result = await runCli(dir, ['play', mediaUrl]);

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /Playlist signature verification failed/i);
    assert.match(result.stdout + result.stderr, /Could not reach device/i);
  });
});
