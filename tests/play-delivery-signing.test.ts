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
  args: string[],
  extraEnv: Record<string, string | undefined> = {}
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
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
    let deliveredBody = '';
    const deviceServer = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf-8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { command?: string };
        if (parsed.command === 'getDeviceStatus') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              message: {
                installedVersion: '1.0.0',
              },
            })
          );
          return;
        }

        if (parsed.command === 'displayPlaylist') {
          deliveredBody = body;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolvePromise) => deviceServer.listen(0, resolvePromise));
    const address = deviceServer.address();
    if (address === null || typeof address === 'string') {
      deviceServer.close();
      throw new Error('Failed to start device test server');
    }

    try {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify(
          {
            ff1Devices: {
              devices: [
                {
                  name: 'test-device',
                  host: `http://127.0.0.1:${address.port}`,
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

      const result = await runCli(dir, ['play', mediaUrl]);

      assert.equal(result.status, 0);
      assert.match(result.stdout + result.stderr, /Signed and verified/i);
      assert.match(result.stdout + result.stderr, /Playing/i);
      assert.ok(deliveredBody, 'expected device request body to be captured');

      const request = JSON.parse(deliveredBody) as {
        request?: {
          dp1_call?: {
            signatures?: unknown[];
            signature?: unknown;
          };
        };
      };

      assert.ok(request.request?.dp1_call);
      assert.equal(Array.isArray(request.request?.dp1_call?.signatures), true);
      assert.ok((request.request?.dp1_call?.signatures?.length ?? 0) > 0);
      assert.equal(request.request?.dp1_call?.signature, undefined);
    } finally {
      deviceServer.close();
    }
  });

  /**
   * Direct media is wrapped in an unsigned playlist and must be signed before delivery, so this path
   * needs the *resolved* key. `config init` leaves the YOUR_ED25519_PRIVATE_KEY... literal in the file,
   * which is truthy — reading config.playlist.privateKey directly picks the placeholder and signing
   * fails on a key the user never chose, while a valid PLAYLIST_PRIVATE_KEY sits unused.
   */
  test('signs media with PLAYLIST_PRIVATE_KEY when the config still holds the template placeholder', async () => {
    let deliveredBody = '';
    const deviceServer = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf-8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { command?: string };
        if (parsed.command === 'getDeviceStatus') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: { installedVersion: '1.0.0' } }));
          return;
        }
        if (parsed.command === 'displayPlaylist') {
          deliveredBody = body;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolvePromise) => deviceServer.listen(0, resolvePromise));
    const address = deviceServer.address();
    if (address === null || typeof address === 'string') {
      deviceServer.close();
      throw new Error('Failed to start device test server');
    }

    try {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          ff1Devices: {
            devices: [{ name: 'test-device', host: `http://127.0.0.1:${address.port}` }],
          },
          playlist: {
            privateKey:
              'YOUR_ED25519_PRIVATE_KEY__base64_PKCS8_DER_recommended__or_32byte_raw_seed_as_hex_or_base64__run_ff-cli_setup_to_generate',
          },
        }),
        'utf-8'
      );

      const envKey = makePrivateKeyBase64();
      const result = await runCli(dir, ['play', mediaUrl], { PLAYLIST_PRIVATE_KEY: envKey });
      const out = result.stdout + result.stderr;

      assert.equal(result.status, 0, out);
      // The placeholder must not have been handed to the signer.
      assert.doesNotMatch(out, /Unrecognized Ed25519 private key format/i);
      assert.match(out, /Signed and verified/i);
      assert.ok(deliveredBody, 'expected device request body to be captured');

      const request = JSON.parse(deliveredBody) as {
        request?: { dp1_call?: { signatures?: unknown[] } };
      };
      assert.equal(Array.isArray(request.request?.dp1_call?.signatures), true);
      assert.ok((request.request?.dp1_call?.signatures?.length ?? 0) > 0);
    } finally {
      deviceServer.close();
    }
  });

  test('fails closed when media playback has no signing key', async () => {
    let deviceHits = 0;
    const deviceServer = createServer((_req, res) => {
      deviceHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolvePromise) => deviceServer.listen(0, resolvePromise));
    const address = deviceServer.address();
    if (address === null || typeof address === 'string') {
      deviceServer.close();
      throw new Error('Failed to start device test server');
    }

    const isolatedDir = mkdtempSync(join(tmpdir(), 'ff-cli-play-no-key-'));
    try {
      writeFileSync(
        join(isolatedDir, 'config.json'),
        JSON.stringify(
          {
            ff1Devices: {
              devices: [
                {
                  name: 'test-device',
                  host: `http://127.0.0.1:${address.port}`,
                },
              ],
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      const result = await runCli(isolatedDir, ['play', mediaUrl]);

      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout + result.stderr,
        /Cannot sign playlist for playback: no playlist signing key is configured/i
      );
      assert.equal(deviceHits, 0);
    } finally {
      deviceServer.close();
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
