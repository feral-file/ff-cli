/**
 * `--key` on the commands that sign an owner-bound intent.
 *
 * `sign` and `status` already take an explicit key, and the feed mutations needed one for the same
 * reason: the configured key is one identity, and the key that owns a given playlist may be another.
 * Without this an operator holding a second owner key had to edit `config.json`, or run from a
 * directory with its own copy, to delete or replace something they own.
 *
 * The tests are driven through the real CLI because the point is the override reaching the signing and
 * preflight paths from the command line, and because the same run can check that the key never appears
 * in the output. `spawn`, not `spawnSync`: the stub feed runs on this process's event loop, which
 * `spawnSync` would block until the child exits.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { signPlaylist } from '../src/utilities/playlist-signer';
import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');
const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

function makePrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

/** A stored playlist owned by `ownerKey`: declared in curators[] and signed as curator. */
async function storedPlaylist(ownerKey: string): Promise<Record<string, unknown>> {
  const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
  const body = { ...base, curators: [{ name: 'Owner', key: playlistSigningDidKey(ownerKey) }] };
  const signature = await signPlaylist(body, ownerKey, 'curator');
  return { ...body, signatures: [signature] };
}

interface FeedRun {
  baseUrl: string;
  recorded: { method?: string; body?: string };
  close: () => void;
}

/** Loopback feed: serves `stored` on GET, records and accepts any write. */
async function startFeed(stored: Record<string, unknown>): Promise<FeedRun> {
  const recorded: { method?: string; body?: string } = {};
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stored));
        return;
      }
      recorded.method = req.method;
      recorded.body = body;
      if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stored));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to start test feed');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    recorded,
    close: () => server.close(),
  };
}

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  dir: string;
  cleanup: () => void;
}

/** Run the CLI in a temp cwd configured with `configuredKey` and a single feed at `baseUrl`. */
async function runCli(
  baseUrl: string,
  configuredKey: string,
  args: string[],
  files: Record<string, string> = {}
): Promise<CliRun> {
  const dir = mkdtempSync(join(tmpdir(), 'ff1-keyoverride-'));
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify(
      {
        defaultDuration: 10,
        playlist: { privateKey: configuredKey, role: 'curator', curatorName: 'Configured' },
        feedServers: [{ baseUrl }],
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, 'utf-8');
  }

  const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    // XDG_CONFIG_HOME points at the temp dir so a real user config can never leak into a test run.
    env: { ...process.env, XDG_CONFIG_HOME: dir, PLAYLIST_PRIVATE_KEY: '' },
  });
  child.stdin.end();

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (c) => {
    stdout += c;
  });
  child.stderr.on('data', (c) => {
    stderr += c;
  });
  const status = await new Promise<number | null>((r) => child.on('close', (code) => r(code)));

  return {
    status,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Assert that neither key appears anywhere in the output, in any encoding a leak would plausibly use.
 *
 * A private key reaching a terminal is not recoverable — it is in scrollback, in CI logs, and in
 * whatever ships those logs onward. The base64 the user typed is the obvious shape; the hex and the
 * raw seed are what a helpful error message would print if someone ever normalizes before reporting.
 */
function assertNoKeyLeak(output: string, ...keys: string[]): void {
  for (const key of keys) {
    assert.equal(output.includes(key), false, 'the private key must never be echoed');
    const der = Buffer.from(key, 'base64');
    assert.equal(output.includes(der.toString('hex')), false, 'key hex must never be echoed');
    // Last 32 bytes of a PKCS#8 Ed25519 key are the seed plus public half; check the seed itself.
    const seed = der.subarray(der.length - 32);
    assert.equal(output.includes(seed.toString('hex')), false, 'key seed must never be echoed');
  }
}

describe('unpublish --key', () => {
  test('an explicit owner key succeeds where the configured key is refused', async () => {
    const ownerKey = makePrivateKeyBase64();
    const configuredKey = makePrivateKeyBase64();
    const stored = await storedPlaylist(ownerKey);
    const id = String(stored.id);

    // First, without --key: the configured identity is not an owner, so this must be refused locally.
    const feedA = await startFeed(stored);
    const refused = await runCli(feedA.baseUrl, configuredKey, ['unpublish', id, '-y']);
    try {
      assert.notEqual(refused.status, 0);
      assert.match(refused.output, /not an owner/i);
      assert.match(refused.output, new RegExp(playlistSigningDidKey(configuredKey)));
      assert.equal(feedA.recorded.method, undefined, 'nothing may be sent');
      assertNoKeyLeak(refused.output, ownerKey, configuredKey);
    } finally {
      refused.cleanup();
      feedA.close();
    }

    // Then the same command with the owner's key: it must go through.
    const feedB = await startFeed(stored);
    const accepted = await runCli(feedB.baseUrl, configuredKey, [
      'unpublish',
      id,
      '-y',
      '--key',
      ownerKey,
    ]);
    try {
      assert.equal(accepted.status, 0, accepted.output);
      assert.match(accepted.output, /Unpublished/);
      assert.equal(feedB.recorded.method, 'DELETE');

      // The intent must be signed by the explicit key, not the configured one.
      const body = JSON.parse(String(feedB.recorded.body)) as {
        signatures: Array<{ kid: string; role: string }>;
      };
      assert.equal(body.signatures[0].kid, playlistSigningDidKey(ownerKey));
      assert.equal(body.signatures[0].role, 'curator');
      assertNoKeyLeak(accepted.output, ownerKey, configuredKey);
    } finally {
      accepted.cleanup();
      feedB.close();
    }
  });

  test('a malformed --key fails without echoing what was passed', async () => {
    const ownerKey = makePrivateKeyBase64();
    const stored = await storedPlaylist(ownerKey);
    const feed = await startFeed(stored);
    const secret = 'not-a-key-but-still-secret-material';
    const run = await runCli(feed.baseUrl, makePrivateKeyBase64(), [
      'unpublish',
      String(stored.id),
      '-y',
      '--key',
      secret,
    ]);
    try {
      assert.notEqual(run.status, 0);
      assert.match(run.output, /Ed25519|private key/i);
      assert.equal(run.output.includes(secret), false, 'the rejected key must not be echoed');
      assert.equal(feed.recorded.method, undefined);
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});

describe('an empty --key is a failed override, not an absent one', () => {
  // The critical case. `--key "$SIGNING_KEY"` with the variable unset expands to `--key ""`, which is
  // falsy — so the override was skipped and the CONFIGURED key signed instead. On `unpublish` that
  // tombstones the id under an identity the operator did not choose, and a tombstone is permanent.
  // Presence, not truthiness: anything actually passed must be validated and rejected.
  for (const [label, value] of [
    ['empty', ''],
    ['whitespace', '   '],
  ] as const) {
    test(`unpublish refuses an ${label} --key and sends nothing`, async () => {
      const ownerKey = makePrivateKeyBase64();
      const stored = await storedPlaylist(ownerKey);
      const feed = await startFeed(stored);
      // The configured key IS the owner here, so a fallback would have succeeded — which is exactly
      // the danger: the command would have worked, on the wrong authority, and destroyed the playlist.
      const run = await runCli(feed.baseUrl, ownerKey, [
        'unpublish',
        String(stored.id),
        '-y',
        '--key',
        value,
      ]);
      try {
        assert.notEqual(run.status, 0);
        assert.match(run.output, /--key value is empty/);
        assert.match(run.output, /did not expand/);
        assert.equal(feed.recorded.method, undefined, 'nothing may be sent');
      } finally {
        run.cleanup();
        feed.close();
      }
    });

    test(`publish --replace refuses an ${label} --key and sends nothing`, async () => {
      const ownerKey = makePrivateKeyBase64();
      const stored = await storedPlaylist(ownerKey);
      const feed = await startFeed(stored);
      const run = await runCli(
        feed.baseUrl,
        ownerKey,
        ['publish', 'playlist.json', '--replace', '--key', value],
        { 'playlist.json': `${JSON.stringify(stored, null, 2)}\n` }
      );
      try {
        assert.notEqual(run.status, 0);
        assert.match(run.output, /--key value is empty/);
        assert.equal(feed.recorded.method, undefined, 'nothing may be written');
      } finally {
        run.cleanup();
        feed.close();
      }
    });

    test(`a plain publish still refuses an ${label} --key`, async () => {
      // The refusal has to test presence too, or an empty value skipped the guard and published while
      // the user believed a key had been checked.
      const ownerKey = makePrivateKeyBase64();
      const stored = await storedPlaylist(ownerKey);
      const feed = await startFeed(stored);
      const run = await runCli(
        feed.baseUrl,
        ownerKey,
        ['publish', 'playlist.json', '--key', value],
        { 'playlist.json': `${JSON.stringify(stored, null, 2)}\n` }
      );
      try {
        assert.notEqual(run.status, 0);
        assert.match(run.output, /--key has no effect on a plain publish/);
        assert.equal(feed.recorded.method, undefined, 'nothing may be uploaded');
      } finally {
        run.cleanup();
        feed.close();
      }
    });
  }
});

describe('unpublish validates the key before it asks anything', () => {
  test('a malformed key fails before the playlist is even looked up', async () => {
    // Without -y the command fetches the playlist and prompts. Deriving the key afterwards meant the
    // operator was shown a playlist, asked to approve destroying it, and only then told their
    // credential was unusable.
    const ownerKey = makePrivateKeyBase64();
    const stored = await storedPlaylist(ownerKey);
    const feed = await startFeed(stored);
    const run = await runCli(feed.baseUrl, ownerKey, [
      'unpublish',
      String(stored.id),
      '--key',
      'not-a-key',
    ]);
    try {
      assert.notEqual(run.status, 0);
      assert.match(run.output, /Cannot sign the delete/);
      // No confirmation was reached, and no lookup was made.
      assert.doesNotMatch(run.output, /Delete this playlist\?/);
      assert.equal(feed.recorded.method, undefined);
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});

describe('publish --replace --key', () => {
  test('an explicit owner key signs the authorization intent', async () => {
    const ownerKey = makePrivateKeyBase64();
    const configuredKey = makePrivateKeyBase64();
    const stored = await storedPlaylist(ownerKey);
    const document = `${JSON.stringify(stored, null, 2)}\n`;

    const feedA = await startFeed(stored);
    const refused = await runCli(
      feedA.baseUrl,
      configuredKey,
      ['publish', 'playlist.json', '--replace'],
      { 'playlist.json': document }
    );
    try {
      assert.notEqual(refused.status, 0);
      assert.match(refused.output, /not an owner/i);
      assert.equal(feedA.recorded.method, undefined);
      assertNoKeyLeak(refused.output, ownerKey, configuredKey);
    } finally {
      refused.cleanup();
      feedA.close();
    }

    const feedB = await startFeed(stored);
    const accepted = await runCli(
      feedB.baseUrl,
      configuredKey,
      ['publish', 'playlist.json', '--replace', '--key', ownerKey],
      { 'playlist.json': document }
    );
    try {
      assert.equal(accepted.status, 0, accepted.output);
      assert.match(accepted.output, /Replaced/);
      assert.equal(feedB.recorded.method, 'PUT');

      const body = JSON.parse(String(feedB.recorded.body)) as {
        authorization: { signatures: Array<{ kid: string; role: string }> };
      };
      assert.equal(body.authorization.signatures[0].kid, playlistSigningDidKey(ownerKey));
      assert.equal(body.authorization.signatures[0].role, 'curator');
      assertNoKeyLeak(accepted.output, ownerKey, configuredKey);
    } finally {
      accepted.cleanup();
      feedB.close();
    }
  });

  test('--key on a plain publish is refused rather than ignored', async () => {
    // A publish signs nothing at request time, so accepting the flag would be a quiet lie: the user
    // believes their key was used and it never was.
    const ownerKey = makePrivateKeyBase64();
    const stored = await storedPlaylist(ownerKey);
    const feed = await startFeed(stored);
    const run = await runCli(
      feed.baseUrl,
      makePrivateKeyBase64(),
      ['publish', 'playlist.json', '--key', ownerKey],
      { 'playlist.json': `${JSON.stringify(stored, null, 2)}\n` }
    );
    try {
      assert.notEqual(run.status, 0);
      assert.match(run.output, /--key has no effect on a plain publish/);
      // The remedy has to name where the key does belong.
      assert.match(run.output, /ff-cli sign <file> -r curator --key/);
      assert.equal(feed.recorded.method, undefined, 'nothing may be uploaded');
      assertNoKeyLeak(run.output, ownerKey);
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});
