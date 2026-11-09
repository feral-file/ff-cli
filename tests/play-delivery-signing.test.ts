import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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

describe('display delivery signing contract', () => {
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

    // A real media response: OK, not JSON. A 404 here would now be refused
    // before signing (a URL that does not exist is not sent to the device).
    mediaServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
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

    const result = await runCli(dir, ['display', playlistPath]);

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Playlist signature verification failed/i);
    assert.doesNotMatch(result.stdout + result.stderr, /Could not reach device/i);
  });

  test('points an unsigned local file at sign with the configured key and a quoted path', async () => {
    const playlistPath = join(dir, "unsigned ' $playlist.json");
    const original = readFileSync(fixturePath, 'utf-8');
    writeFileSync(playlistPath, original, 'utf-8');

    const result = await runCli(dir, ['display', playlistPath]);
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 1, out);
    assert.match(out, /This playlist is unsigned/);
    assert.match(out, /configured signing key/);
    const posixFile = `'${playlistPath.replace(/'/g, "'\\''")}'`;
    const powershellFile = `'${playlistPath.replace(/'/g, "''")}'`;
    assert.ok(out.includes(`POSIX shell: ff-cli sign -- ${posixFile}`), out);
    assert.ok(out.includes(`PowerShell: ff-cli sign -- ${powershellFile}`), out);
    assert.ok(out.indexOf('ff-cli sign') < out.indexOf('--skip-verify'), out);
    assert.equal(readFileSync(playlistPath, 'utf-8'), original);

    if (process.platform !== 'win32') {
      // Parse the emitted argument with a real POSIX shell, preserving the quote and $ literally.
      const parsed = spawnSync('/bin/sh', ['-c', `set -- ${posixFile}; printf '%s' "$1"`], {
        encoding: 'utf-8',
      });
      assert.equal(parsed.status, 0, parsed.stderr);
      assert.equal(parsed.stdout, playlistPath);
    } else {
      // Windows CI supplies pwsh; capture the recovery command's path without rewriting the file.
      const parsed = spawnSync(
        'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `function ff-cli { ConvertTo-Json -InputObject $args[-1] -Compress }; ff-cli sign -- ${powershellFile}`,
        ],
        { encoding: 'utf-8' }
      );
      assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
      assert.equal(JSON.parse(parsed.stdout), playlistPath);
    }

    // The suggested argument separator must work with the real sign command.
    const signed = await runCli(dir, ['sign', '--', playlistPath]);
    assert.equal(signed.status, 0, signed.stdout + signed.stderr);
  });

  test('points an empty signatures array at signing after structure validation', async () => {
    const playlistPath = join(dir, 'empty-signatures.json');
    const playlist = { ...JSON.parse(readFileSync(fixturePath, 'utf-8')), signatures: [] };
    const original = JSON.stringify(playlist);
    writeFileSync(playlistPath, original);

    const validated = await runCli(dir, ['validate', playlistPath]);
    assert.equal(validated.status, 0, validated.stdout + validated.stderr);

    const result = await runCli(dir, ['display', playlistPath]);
    const out = result.stdout + result.stderr;
    assert.equal(result.status, 1, out);
    assert.match(out, /This playlist is unsigned/);
    assert.ok(out.indexOf('ff-cli sign') < out.indexOf('--skip-verify'), out);
    assert.equal(readFileSync(playlistPath, 'utf-8'), original);

    const signed = await runCli(dir, ['sign', '--', playlistPath]);
    assert.equal(signed.status, 0, signed.stdout + signed.stderr);
    const verified = await runCli(dir, ['verify', playlistPath]);
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  });

  test('points an unsigned hosted playlist at saving and signing a local file', async () => {
    const playlistServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(readFileSync(fixturePath, 'utf-8'));
    });
    await new Promise<void>((resolvePromise) => playlistServer.listen(0, resolvePromise));
    const address = playlistServer.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/playlist.json`;
    try {
      const result = await runCli(dir, ['display', url]);
      const out = result.stdout + result.stderr;
      assert.equal(result.status, 1, out);
      assert.match(out, /Save the hosted playlist to a local file/);
      assert.match(out, /ff-cli sign playlist.json/);
      assert.match(out, /upload the signed file|display the signed local file/);
      assert.doesNotMatch(out, /ff-cli sign[^\n]*http/);
    } finally {
      playlistServer.close();
    }
  });

  test('does not label a structurally invalid or already signed playlist as unsigned', async () => {
    for (const fixture of ['invalid-missing-title-v10.json', 'valid-signed-v11.json']) {
      const playlist = JSON.parse(
        readFileSync(join(__dirname, 'fixtures/playlists', fixture), 'utf-8')
      );
      if (fixture === 'valid-signed-v11.json') {
        playlist.title = 'Tampered after signing';
      } else {
        playlist.signatures = [];
      }
      const playlistPath = join(dir, fixture);
      writeFileSync(playlistPath, JSON.stringify(playlist));
      const result = await runCli(dir, ['display', playlistPath]);
      const out = result.stdout + result.stderr;
      assert.equal(result.status, 1, out);
      assert.doesNotMatch(out, /This playlist is unsigned|ff-cli sign/);
    }
  });

  test('uses the resolved environment key for the hint, but ignores an unset template key', async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'ff-cli-play-sign-hint-'));
    try {
      const playlistPath = join(isolatedDir, 'playlist.json');
      writeFileSync(playlistPath, readFileSync(fixturePath, 'utf-8'));
      writeFileSync(
        join(isolatedDir, 'config.json'),
        JSON.stringify({ playlist: { privateKey: 'YOUR_ED25519_PRIVATE_KEY' } })
      );
      const withKey = await runCli(isolatedDir, ['play', playlistPath], {
        PLAYLIST_PRIVATE_KEY: privateKeyBase64,
      });
      assert.equal(withKey.status, 1);
      assert.match(withKey.stdout + withKey.stderr, /configured signing key/);

      const withoutKey = await runCli(isolatedDir, ['display', playlistPath], {
        PLAYLIST_PRIVATE_KEY: '',
      });
      assert.equal(withoutKey.status, 1);
      assert.doesNotMatch(
        withoutKey.stdout + withoutKey.stderr,
        /configured signing key|ff-cli sign/
      );
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
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

      const result = await runCli(dir, ['display', mediaUrl]);

      assert.equal(result.status, 0);
      assert.match(result.stdout + result.stderr, /Signed and verified/i);
      assert.match(result.stdout + result.stderr, /Displaying/);
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
   * A cast never passes through a feed, so the delivered document carries no `feed` signature and its own
   * entry is all a player can judge. DP-1 §7.1.1 rule 1 has players verify a `feed` or `curator`
   * signature, so an `agent`-only envelope is one a role-aware player may refuse.
   *
   * Signing REPLACES `signatures[]` rather than appending, so the cast-time signature is the only one that
   * reaches the device — the builder's `curator` envelope is discarded on the way. Config here sets
   * `role: "agent"` (the value the CLI falls back to when `playlist.role` is absent) precisely so the
   * assertion fails if the delivery path ever falls back to the configured role again.
   */
  test('delivers a curator-role signature even when config sets role agent', async () => {
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
        JSON.stringify(
          {
            ff1Devices: {
              devices: [{ name: 'test-device', host: `http://127.0.0.1:${address.port}` }],
            },
            playlist: { privateKey: privateKeyBase64, role: 'agent' },
          },
          null,
          2
        ),
        'utf-8'
      );

      const result = await runCli(dir, ['display', mediaUrl]);

      assert.equal(result.status, 0);
      assert.ok(deliveredBody, 'expected device request body to be captured');

      const request = JSON.parse(deliveredBody) as {
        request?: { dp1_call?: { signatures?: Array<{ role?: string; kid?: string }> } };
      };
      const signatures = request.request?.dp1_call?.signatures ?? [];
      assert.ok(signatures.length > 0, 'expected a signature on the delivered playlist');
      assert.ok(
        signatures.some((signature) => signature.role === 'curator'),
        `expected a curator-role signature, got: ${signatures.map((s) => s.role).join(', ')}`
      );
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
      const result = await runCli(dir, ['display', mediaUrl], { PLAYLIST_PRIVATE_KEY: envKey });
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

  test('fails closed when displaying media has no signing key', async () => {
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

      const result = await runCli(isolatedDir, ['display', mediaUrl]);

      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout + result.stderr,
        /Cannot sign playlist for display: no playlist signing key is configured/i
      );
      assert.equal(deviceHits, 0);
    } finally {
      deviceServer.close();
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
