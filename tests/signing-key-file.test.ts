/**
 * `--key-file` on every command that accepts `--key`.
 *
 * `--key` puts a private key in the shell history file and in the process list, where any local user
 * can read it while the command runs. Neither disclosure is recoverable: an Ed25519 signing key IS the
 * identity, and a playlist's owner set is immutable, so a leaked key cannot be rotated out of a
 * document that already names it. `--key-file` reads the same material from a file instead.
 *
 * The tests run the real CLI, for the same two reasons the `--key` tests do: the point is the flag
 * reaching the signing and preflight paths from the command line, and the same run can check that the
 * key never appears in the output. `spawn`, not `spawnSync`: the stub feed runs on this process's event
 * loop, which `spawnSync` would block until the child exits.
 *
 * The empty-file cases are the ones that matter most, and they mirror the presence-not-truthiness tests
 * in `mutation-key-override.test.ts`. A file that reads as empty — truncated, still being written, or
 * simply the wrong path in a directory of similar names — must never fall back to the configured key.
 * On `unpublish` that fallback tombstones an id under an identity nobody chose, and on `status` it
 * answers "which identity is this key?" with a different key's answer.
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

/** An Ed25519 key in every encoding the signing paths accept, all of one key. */
interface TestKey {
  /** base64 PKCS#8 DER — what `ff-cli setup` writes. */
  base64: string;
  /** PEM PKCS#8. */
  pem: string;
  /** The 32-byte seed as hex. */
  seedHex: string;
  /** The `did:key` all three assert. */
  did: string;
}

function makeKey(): TestKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const base64 = der.toString('base64');
  return {
    base64,
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    // RFC 8410 PKCS#8 for Ed25519 ends in the 32-byte seed.
    seedHex: der.subarray(der.length - 32).toString('hex'),
    did: playlistSigningDidKey(base64),
  };
}

/**
 * A key whose base64 contains `needle`.
 *
 * `/` appears in a 64-character base64 key more often than not, so this loop almost always returns on
 * its first try — but the test that needs it must be deterministic, not usually-right.
 */
function makeKeyContaining(needle: string): TestKey {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const key = makeKey();
    if (key.base64.includes(needle)) {
      return key;
    }
  }
  throw new Error(`could not generate a base64 key containing "${needle}"`);
}

/** A stored playlist owned by `owner`: declared in curators[] and signed as curator. */
async function storedPlaylist(owner: TestKey): Promise<Record<string, unknown>> {
  const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
  const body = { ...base, curators: [{ name: 'Owner', key: owner.did }] };
  const signature = await signPlaylist(body, owner.base64, 'curator');
  return { ...body, signatures: [signature] };
}

interface FeedRun {
  baseUrl: string;
  recorded: { method?: string; body?: string };
  close: () => void;
}

/** Loopback feed: serves `stored` on GET, records the write and answers it. */
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
  const dir = mkdtempSync(join(tmpdir(), 'ff1-keyfile-'));
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

  let output = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (c) => {
    output += c;
  });
  child.stderr.on('data', (c) => {
    output += c;
  });
  const status = await new Promise<number | null>((r) => child.on('close', (code) => r(code)));

  return {
    status,
    output,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Assert that no encoding of any key appears in the output.
 *
 * A key file exists to keep the material off the terminal, so an error that echoes the file's contents
 * would defeat the whole flag. The base64 is the obvious shape; the hex and the seed are what a
 * helpful message would print if someone ever normalized before reporting.
 */
function assertNoKeyLeak(output: string, ...keys: TestKey[]): void {
  for (const key of keys) {
    assert.equal(output.includes(key.base64), false, 'the private key must never be echoed');
    const der = Buffer.from(key.base64, 'base64');
    assert.equal(output.includes(der.toString('hex')), false, 'key hex must never be echoed');
    assert.equal(output.includes(key.seedHex), false, 'key seed must never be echoed');
    // PEM wraps at 64 characters, so the body would not appear whole; its first line is enough.
    const pemBody = key.pem.split('\n')[1];
    assert.equal(output.includes(pemBody), false, 'PEM key material must never be echoed');
  }
}

describe('--key-file signs with the key in the file', () => {
  test('sign: the signature carries the file key, not the configured one', async () => {
    const fileKey = makeKey();
    const configured = makeKey();
    const feed = await startFeed(await storedPlaylist(fileKey));
    const run = await runCli(
      feed.baseUrl,
      configured.base64,
      ['sign', 'playlist.json', '-r', 'curator', '-o', 'signed.json', '--key-file', 'signing.key'],
      {
        'playlist.json': readFileSync(fixturePath, 'utf-8'),
        // Trailing newline: what every editor and `printf '%s\n'` writes, and it must not matter.
        'signing.key': `${fileKey.base64}\n`,
      }
    );
    try {
      assert.equal(run.status, 0, run.output);
      const signed = JSON.parse(readFileSync(join(run.dir, 'signed.json'), 'utf-8')) as {
        signatures: Array<{ kid: string; role: string }>;
      };
      assert.equal(signed.signatures[0].kid, fileKey.did);
      assert.equal(signed.signatures[0].role, 'curator');
      assertNoKeyLeak(run.output, fileKey, configured);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('status: the identity reported is the file key', async () => {
    const fileKey = makeKey();
    const configured = makeKey();
    const feed = await startFeed(await storedPlaylist(fileKey));
    const run = await runCli(feed.baseUrl, configured.base64, ['status', '--key-file', 'k'], {
      k: `${fileKey.base64}\n`,
    });
    try {
      assert.equal(run.status, 0, run.output);
      assert.ok(run.output.includes(fileKey.did), run.output);
      assert.equal(
        run.output.includes(configured.did),
        false,
        'the configured did must not appear'
      );
      assertNoKeyLeak(run.output, fileKey, configured);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('unpublish: the delete intent is signed by the file key', async () => {
    const owner = makeKey();
    const configured = makeKey();
    const stored = await storedPlaylist(owner);
    const feed = await startFeed(stored);
    const run = await runCli(
      feed.baseUrl,
      configured.base64,
      ['unpublish', String(stored.id), '-y', '--key-file', 'owner.key'],
      { 'owner.key': `${owner.base64}\n` }
    );
    try {
      assert.equal(run.status, 0, run.output);
      assert.match(run.output, /Unpublished/);
      assert.equal(feed.recorded.method, 'DELETE');
      const body = JSON.parse(String(feed.recorded.body)) as {
        signatures: Array<{ kid: string; role: string }>;
      };
      assert.equal(body.signatures[0].kid, owner.did);
      assert.equal(body.signatures[0].role, 'curator');
      assertNoKeyLeak(run.output, owner, configured);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('publish --replace: the authorization intent is signed by the file key', async () => {
    const owner = makeKey();
    const configured = makeKey();
    const stored = await storedPlaylist(owner);
    const feed = await startFeed(stored);
    const run = await runCli(
      feed.baseUrl,
      configured.base64,
      ['publish', 'playlist.json', '--replace', '--key-file', 'owner.key'],
      {
        'playlist.json': `${JSON.stringify(stored, null, 2)}\n`,
        'owner.key': `${owner.base64}\n`,
      }
    );
    try {
      assert.equal(run.status, 0, run.output);
      assert.match(run.output, /Replaced/);
      assert.equal(feed.recorded.method, 'PUT');
      const body = JSON.parse(String(feed.recorded.body)) as {
        authorization: { signatures: Array<{ kid: string; role: string }> };
      };
      assert.equal(body.authorization.signatures[0].kid, owner.did);
      assert.equal(body.authorization.signatures[0].role, 'curator');
      assertNoKeyLeak(run.output, owner, configured);
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});

describe('a key file is a delivery mechanism, not a key format', () => {
  // The contents go through the same normalization `--key` does. If a file could only hold one of the
  // accepted encodings, an operator would have to convert a key they already have — and a conversion
  // step performed by hand on private key material is exactly what this flag exists to avoid.
  for (const encoding of ['pem', 'seedHex'] as const) {
    test(`a ${encoding === 'pem' ? 'PEM' : 'hex seed'} key file asserts the same identity`, async () => {
      const key = makeKey();
      const configured = makeKey();
      const feed = await startFeed(await storedPlaylist(key));
      const run = await runCli(feed.baseUrl, configured.base64, ['status', '--key-file', 'k'], {
        k: `${key[encoding]}\n`,
      });
      try {
        assert.equal(run.status, 0, run.output);
        assert.ok(run.output.includes(key.did), run.output);
        assertNoKeyLeak(run.output, key, configured);
      } finally {
        run.cleanup();
        feed.close();
      }
    });
  }
});

describe('--key and --key-file together is an error', () => {
  // No precedence rule, because every precedence rule silently ignores one of the two keys the operator
  // supplied — the same shape as the empty-`--key` fallback, and just as unrecoverable on a delete.
  const cases: Array<[string, string[], Record<string, string>]> = [
    ['sign', ['sign', 'playlist.json', '-r', 'curator', '-o', 'out.json'], {}],
    ['status', ['status'], {}],
    ['unpublish', ['unpublish', 'PLAYLIST_ID', '-y'], {}],
    ['publish --replace', ['publish', 'playlist.json', '--replace'], {}],
  ];

  for (const [label, args, extraFiles] of cases) {
    test(`${label} refuses both flags and sends nothing`, async () => {
      const owner = makeKey();
      const stored = await storedPlaylist(owner);
      const feed = await startFeed(stored);
      const run = await runCli(
        feed.baseUrl,
        owner.base64,
        args
          .map((arg) => (arg === 'PLAYLIST_ID' ? String(stored.id) : arg))
          .concat(['--key', owner.base64, '--key-file', 'owner.key']),
        {
          'playlist.json': `${JSON.stringify(stored, null, 2)}\n`,
          'owner.key': `${owner.base64}\n`,
          ...extraFiles,
        }
      );
      try {
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.output, /--key and --key-file both name a signing key/);
        assert.equal(feed.recorded.method, undefined, 'nothing may be sent');
      } finally {
        run.cleanup();
        feed.close();
      }
    });
  }
});

describe('an empty key file is a failed override, not an absent one', () => {
  // The critical case, and the reason this flag cannot simply hand its contents to the existing paths:
  // an empty string is falsy, and falling back to the configured key signs under an identity the
  // operator did not choose. On `unpublish` that tombstones an id, permanently.
  for (const [label, contents] of [
    ['empty', ''],
    ['whitespace-only', '   \n\t\n'],
  ] as const) {
    test(`unpublish refuses an ${label} key file and sends nothing`, async () => {
      const owner = makeKey();
      const stored = await storedPlaylist(owner);
      const feed = await startFeed(stored);
      // The configured key IS the owner, so a fallback would have SUCCEEDED — which is the danger: the
      // delete would have gone through, on an authority the operator never selected.
      const run = await runCli(
        feed.baseUrl,
        owner.base64,
        ['unpublish', String(stored.id), '-y', '--key-file', 'owner.key'],
        { 'owner.key': contents }
      );
      try {
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.output, /Cannot sign the delete/);
        assert.match(run.output, /holds no key material/);
        assert.match(run.output, /owner\.key/);
        assert.equal(feed.recorded.method, undefined, 'nothing may be sent');
      } finally {
        run.cleanup();
        feed.close();
      }
    });

    test(`publish --replace refuses an ${label} key file and writes nothing`, async () => {
      const owner = makeKey();
      const stored = await storedPlaylist(owner);
      const feed = await startFeed(stored);
      const run = await runCli(
        feed.baseUrl,
        owner.base64,
        ['publish', 'playlist.json', '--replace', '--key-file', 'owner.key'],
        { 'playlist.json': `${JSON.stringify(stored, null, 2)}\n`, 'owner.key': contents }
      );
      try {
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.output, /Cannot sign the replacement/);
        assert.match(run.output, /holds no key material/);
        assert.equal(feed.recorded.method, undefined, 'nothing may be written');
      } finally {
        run.cleanup();
        feed.close();
      }
    });

    test(`sign refuses an ${label} key file and writes no output`, async () => {
      const configured = makeKey();
      const feed = await startFeed(await storedPlaylist(configured));
      const run = await runCli(
        feed.baseUrl,
        configured.base64,
        ['sign', 'playlist.json', '-r', 'curator', '-o', 'signed.json', '--key-file', 'k'],
        { 'playlist.json': readFileSync(fixturePath, 'utf-8'), k: contents }
      );
      try {
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.output, /holds no key material/);
        assert.throws(() => readFileSync(join(run.dir, 'signed.json'), 'utf-8'));
      } finally {
        run.cleanup();
        feed.close();
      }
    });

    test(`status refuses an ${label} key file rather than answering about the configured key`, async () => {
      // The silent-fallback case with no network in it at all: `status --key-file` asks "whose key is
      // this?", and reporting the configured identity would be a confident wrong answer.
      const configured = makeKey();
      const feed = await startFeed(await storedPlaylist(configured));
      const run = await runCli(feed.baseUrl, configured.base64, ['status', '--key-file', 'k'], {
        k: contents,
      });
      try {
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.output, /holds no key material/);
        assert.equal(
          run.output.includes(configured.did),
          false,
          'it must not answer with the configured identity'
        );
      } finally {
        run.cleanup();
        feed.close();
      }
    });
  }
});

describe('an unreadable key file names the path', () => {
  test('unpublish: a missing key file fails before anything is requested', async () => {
    const owner = makeKey();
    const stored = await storedPlaylist(owner);
    const feed = await startFeed(stored);
    const run = await runCli(feed.baseUrl, owner.base64, [
      'unpublish',
      String(stored.id),
      '-y',
      '--key-file',
      'no-such-key.pem',
    ]);
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /Cannot sign the delete/);
      assert.match(run.output, /No key file at no-such-key\.pem/);
      assert.equal(feed.recorded.method, undefined, 'nothing may be sent');
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('status: a key file that is a directory says so', async () => {
    const configured = makeKey();
    const feed = await startFeed(await storedPlaylist(configured));
    const run = await runCli(feed.baseUrl, configured.base64, ['status', '--key-file', '.']);
    try {
      assert.notEqual(run.status, 0, run.output);
      // Windows reports EISDIR as EPERM/EACCES on a directory read, so accept either sentence.
      assert.match(run.output, /is a directory, not a key file|Cannot read the key file at/);
      assert.equal(run.output.includes(configured.did), false);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('sign: an empty --key-file path is rejected as a failed expansion', async () => {
    const configured = makeKey();
    const feed = await startFeed(await storedPlaylist(configured));
    const run = await runCli(
      feed.baseUrl,
      configured.base64,
      ['sign', 'playlist.json', '-r', 'curator', '-o', 'signed.json', '--key-file', ''],
      { 'playlist.json': readFileSync(fixturePath, 'utf-8') }
    );
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /--key-file path is empty/);
      assert.match(run.output, /did not expand/);
      assert.throws(() => readFileSync(join(run.dir, 'signed.json'), 'utf-8'));
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});

describe('refusals name the flag the operator actually used', () => {
  test('unpublish: a non-owner key file is not described as --key or as configured', async () => {
    // Telling someone who passed `--key-file` to "run it again with --key" points at a different
    // mechanism than the one they used — the same wrong turn as pointing them at config.json.
    const owner = makeKey();
    const other = makeKey();
    const stored = await storedPlaylist(owner);
    const feed = await startFeed(stored);
    const run = await runCli(
      feed.baseUrl,
      owner.base64,
      ['unpublish', String(stored.id), '-y', '--key-file', 'other.key'],
      { 'other.key': `${other.base64}\n` }
    );
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /The key you passed with --key-file is not an owner/);
      assert.match(run.output, /The identity you passed with --key-file:/);
      assert.match(run.output, /Run it again with an owner key: --key-file </);
      assert.doesNotMatch(run.output, /Point playlist\.privateKey/);
      assert.doesNotMatch(run.output, /Your configured identity/);
      assertNoKeyLeak(run.output, owner, other);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('a plain publish refuses --key-file by name', async () => {
    // A publish signs nothing at request time, so the flag would be a no-op. The refusal has to name
    // the flag that was typed, and it must not open the key file to do it.
    const owner = makeKey();
    const stored = await storedPlaylist(owner);
    const feed = await startFeed(stored);
    const run = await runCli(
      feed.baseUrl,
      owner.base64,
      ['publish', 'playlist.json', '--key-file', 'owner.key'],
      { 'playlist.json': `${JSON.stringify(stored, null, 2)}\n`, 'owner.key': `${owner.base64}\n` }
    );
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /--key-file has no effect on a plain publish/);
      assert.match(run.output, /ff-cli sign <file> -r curator --key-file/);
      assert.equal(feed.recorded.method, undefined, 'nothing may be uploaded');
      assertNoKeyLeak(run.output, owner);
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});

describe('a key passed to --key-file is never echoed', () => {
  // `--key-file "$SIGNING_KEY"` is one keystroke from `--key "$SIGNING_KEY"`, and it is the natural
  // typo for someone moving off `--key`. Key material never names a real file, so the read always
  // fails — and every read failure names the path it was given. Without a shape check first, the flag
  // whose entire purpose is keeping the key off the terminal would print it.
  const commands: Array<[string, string[]]> = [
    ['sign', ['sign', 'playlist.json', '-r', 'curator', '-o', 'signed.json']],
    ['status', ['status']],
    ['unpublish', ['unpublish', 'PLAYLIST_ID', '-y']],
    ['publish --replace', ['publish', 'playlist.json', '--replace']],
    // A plain publish refuses the flag before reading anything; it must not echo it either.
    ['publish', ['publish', 'playlist.json']],
  ];

  for (const [label, args] of commands) {
    test(`${label}: a key passed as the path is refused without printing it`, async () => {
      const owner = makeKey();
      const stored = await storedPlaylist(owner);
      const feed = await startFeed(stored);
      const run = await runCli(
        feed.baseUrl,
        owner.base64,
        args
          .map((arg) => (arg === 'PLAYLIST_ID' ? String(stored.id) : arg))
          .concat(['--key-file', owner.base64]),
        { 'playlist.json': `${JSON.stringify(stored, null, 2)}\n` }
      );
      try {
        assert.notEqual(run.status, 0, run.output);
        assert.equal(feed.recorded.method, undefined, 'nothing may be sent');
        // The whole point: not one encoding of the key anywhere in stdout or stderr.
        assertNoKeyLeak(run.output, owner);
      } finally {
        run.cleanup();
        feed.close();
      }
    });
  }

  for (const [label, encoding] of [
    ['a hex seed', 'seedHex'],
    ['base64 PKCS#8', 'base64'],
  ] as const) {
    test(`${label} passed as the path is named as a key, not looked up`, async () => {
      const owner = makeKey();
      const feed = await startFeed(await storedPlaylist(owner));
      const run = await runCli(feed.baseUrl, owner.base64, [
        'status',
        '--key-file',
        owner[encoding],
      ]);
      try {
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.output, /looks like a key, not a path/);
        // It must not have been treated as a filename: no "No key file at ..." line.
        assert.doesNotMatch(run.output, /No key file at/);
        assertNoKeyLeak(run.output, owner);
      } finally {
        run.cleanup();
        feed.close();
      }
    });
  }

  test('a PEM key passed as the path is refused without printing it', async () => {
    const owner = makeKey();
    const feed = await startFeed(await storedPlaylist(owner));
    const run = await runCli(feed.baseUrl, owner.base64, ['status', '--key-file', owner.pem]);
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /looks like a key, not a path/);
      assertNoKeyLeak(run.output, owner);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('an ordinary path is still named in the refusal', async () => {
    // Non-vacuity: the shape check must not swallow every path into one opaque message. A real path
    // that is wrong has to say which one, or the operator cannot find their typo.
    const owner = makeKey();
    const feed = await startFeed(await storedPlaylist(owner));
    const run = await runCli(feed.baseUrl, owner.base64, [
      'status',
      '--key-file',
      'keys/owner.key',
    ]);
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /No key file at keys\/owner\.key/);
      assert.doesNotMatch(run.output, /looks like a key/);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('a read failure does not pass the raw errno text through', async () => {
    // Node builds an ENOENT message by appending the path it was given, so interpolating
    // `error.message` would echo the argument a second time in a form this code does not control.
    const owner = makeKey();
    const feed = await startFeed(await storedPlaylist(owner));
    const run = await runCli(feed.baseUrl, owner.base64, ['status', '--key-file', 'missing.key']);
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /No key file at missing\.key/);
      assert.doesNotMatch(run.output, /ENOENT|no such file or directory/);
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});

describe('the path is used exactly as given', () => {
  // Trimming the path silently opened `owner.key` for `--key-file "owner.key "`, so a file that is not
  // the one named decided what signs. Trimming answers only "was anything passed at all".
  const trailingSpaceSupported = process.platform !== 'win32';

  test(
    'a file name with a trailing space is read, not silently redirected',
    {
      skip: trailingSpaceSupported ? false : 'Windows normalizes trailing spaces out of file names',
    },
    async () => {
      const named = makeKey();
      const configured = makeKey();
      const feed = await startFeed(await storedPlaylist(named));
      const run = await runCli(
        feed.baseUrl,
        configured.base64,
        ['status', '--key-file', 'owner '],
        {
          'owner ': `${named.base64}\n`,
        }
      );
      try {
        assert.equal(run.status, 0, run.output);
        assert.ok(run.output.includes(named.did), run.output);
        assertNoKeyLeak(run.output, named, configured);
      } finally {
        run.cleanup();
        feed.close();
      }
    }
  );

  test(
    'a trailing space does not fall back to the untrimmed name',
    {
      skip: trailingSpaceSupported ? false : 'Windows normalizes trailing spaces out of file names',
    },
    async () => {
      // `owner.key` exists and `owner.key ` does not. Trimming would sign with a key the operator did
      // not name — the same class as falling back to the configured one.
      const other = makeKey();
      const configured = makeKey();
      const feed = await startFeed(await storedPlaylist(other));
      const run = await runCli(
        feed.baseUrl,
        configured.base64,
        ['status', '--key-file', 'owner.key '],
        { 'owner.key': `${other.base64}\n` }
      );
      try {
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.output, /No key file at/);
        assert.equal(run.output.includes(other.did), false, 'it must not read the untrimmed name');
        assert.equal(run.output.includes(configured.did), false);
      } finally {
        run.cleanup();
        feed.close();
      }
    }
  );
});

describe('status refuses an explicit but empty key', () => {
  // The #122 class, in the one command that had it left: `--key ""` is falsy, the override was skipped,
  // and status answered "whose key is this?" with the CONFIGURED key's did:key. Nothing about that
  // answer looks wrong, so it would be copied into curators[] — and a wrong declaration fails exactly
  // like a missing one.
  for (const [label, value] of [
    ['empty', ''],
    ['whitespace', '   '],
  ] as const) {
    test(`status --key ${label} is refused and prints no identity`, async () => {
      const configured = makeKey();
      const feed = await startFeed(await storedPlaylist(configured));
      const run = await runCli(feed.baseUrl, configured.base64, ['status', '--key', value]);
      try {
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.output, /--key value is empty/);
        assert.match(run.output, /did not expand/);
        assert.doesNotMatch(run.output, /did:key/);
        assert.equal(
          run.output.includes(configured.did),
          false,
          'it must not answer with the configured identity'
        );
      } finally {
        run.cleanup();
        feed.close();
      }
    });
  }
});

describe('a key with a directory prefix is still a key', () => {
  // `--key-file "./$SIGNING_KEY"` is a real shell habit, and the prefix breaks every whole-value shape
  // test: the `.` and `/` fail base64 and hex alike, and the `/` then reads as "this is a path". The
  // key was one segment away the entire time.
  const commands: Array<[string, string[]]> = [
    ['sign', ['sign', 'playlist.json', '-r', 'curator', '-o', 'signed.json']],
    ['status', ['status']],
    ['unpublish', ['unpublish', 'PLAYLIST_ID', '-y']],
    ['publish --replace', ['publish', 'playlist.json', '--replace']],
    ['publish', ['publish', 'playlist.json']],
  ];

  /** Build the prefixed forms a key actually gets typed with. */
  function prefixedForms(key: TestKey): Array<[string, string]> {
    return [
      ['./<base64>', `./${key.base64}`],
      ['../<base64>', `../${key.base64}`],
      ['/tmp/<hex64>', `/tmp/${key.seedHex}`],
      ['./0x<hex64>', `./0x${key.seedHex}`],
    ];
  }

  for (const [label, args] of commands) {
    test(`${label}: a prefixed key is refused without printing it`, async () => {
      const owner = makeKey();
      const stored = await storedPlaylist(owner);
      for (const [form, argument] of prefixedForms(owner)) {
        const feed = await startFeed(stored);
        const run = await runCli(
          feed.baseUrl,
          owner.base64,
          args
            .map((arg) => (arg === 'PLAYLIST_ID' ? String(stored.id) : arg))
            .concat(['--key-file', argument]),
          { 'playlist.json': `${JSON.stringify(stored, null, 2)}\n` }
        );
        try {
          assert.notEqual(run.status, 0, `${form}: ${run.output}`);
          assert.equal(feed.recorded.method, undefined, `${form}: nothing may be sent`);
          assertNoKeyLeak(run.output, owner);
        } finally {
          run.cleanup();
          feed.close();
        }
      }
    });
  }

  test('a key whose own base64 contains a slash is not printed either', async () => {
    // The segment test cannot catch this one: split on `/`, the key is two fragments and neither has
    // the shape of a whole key. Length is what stops it — no key encoding is under 40 characters, so
    // the message layer refuses to print an argument that long regardless of shape.
    const owner = makeKeyContaining('/');
    const feed = await startFeed(await storedPlaylist(owner));
    const run = await runCli(feed.baseUrl, owner.base64, [
      'status',
      '--key-file',
      `./${owner.base64}`,
    ]);
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /not repeated here/);
      assertNoKeyLeak(run.output, owner);
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('a long but ordinary path is described rather than printed', async () => {
    // The length rule is blunt on purpose, and this is the cost: a genuinely long path is not echoed
    // back. Named here so the trade-off is visible rather than discovered.
    const owner = makeKey();
    const longPath = `keys/${'nested/'.repeat(6)}owner.key`;
    const feed = await startFeed(await storedPlaylist(owner));
    const run = await runCli(feed.baseUrl, owner.base64, ['status', '--key-file', longPath]);
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /not repeated here/);
      assert.equal(run.output.includes(longPath), false);
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});

describe('setup --key-file', () => {
  const deviceArgs = [
    '--device-host',
    'http://192.168.1.50:1111',
    '--device-name',
    'studio',
    '--role',
    'curator',
  ];

  test('provisions the same config --key would, without the key on the command line', async () => {
    const provisioned = makeKey();
    const configured = makeKey();

    // One feed for both runs: setup never contacts it, but its URL lands in each config, so two
    // loopback ports would make the two files differ for a reason that has nothing to do with keys.
    const feed = await startFeed(await storedPlaylist(provisioned));
    const viaFlag = await runCli(
      feed.baseUrl,
      configured.base64,
      ['setup', '--non-interactive', '--key', provisioned.base64, ...deviceArgs],
      {}
    );
    const viaFile = await runCli(
      feed.baseUrl,
      configured.base64,
      ['setup', '--non-interactive', '--key-file', 'provision.key', ...deviceArgs],
      { 'provision.key': `${provisioned.base64}\n` }
    );

    try {
      assert.equal(viaFlag.status, 0, viaFlag.output);
      assert.equal(viaFile.status, 0, viaFile.output);

      const fromFlag = JSON.parse(readFileSync(join(viaFlag.dir, 'config.json'), 'utf-8'));
      const fromFile = JSON.parse(readFileSync(join(viaFile.dir, 'config.json'), 'utf-8'));
      assert.deepEqual(fromFile, fromFlag, 'the two flags must provision identically');
      assert.equal(fromFile.playlist.privateKey, provisioned.base64);
      assert.equal(fromFile.playlist.role, 'curator');

      // The point of the flag: the key is in the file and the config, never in the output.
      assertNoKeyLeak(viaFile.output, provisioned, configured);
    } finally {
      viaFlag.cleanup();
      viaFile.cleanup();
      feed.close();
    }
  });

  test('refuses both flags and writes no key', async () => {
    const provisioned = makeKey();
    const configured = makeKey();
    const feed = await startFeed(await storedPlaylist(provisioned));
    const run = await runCli(
      feed.baseUrl,
      configured.base64,
      [
        'setup',
        '--non-interactive',
        '--key',
        provisioned.base64,
        '--key-file',
        'provision.key',
        ...deviceArgs,
      ],
      { 'provision.key': `${provisioned.base64}\n` }
    );
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /--key and --key-file both name a signing key/);
      const written = JSON.parse(readFileSync(join(run.dir, 'config.json'), 'utf-8'));
      assert.equal(written.playlist.privateKey, configured.base64, 'config must be untouched');
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('refuses an empty key file rather than generating a new identity', async () => {
    // The provisioning shape of the #122 class: falling through would give the machine a signing
    // identity nobody chose, and the operator would not learn it from a successful "Setup complete".
    const configured = makeKey();
    const feed = await startFeed(await storedPlaylist(configured));
    const run = await runCli(
      feed.baseUrl,
      configured.base64,
      ['setup', '--non-interactive', '--key-file', 'provision.key', ...deviceArgs],
      { 'provision.key': '   \n' }
    );
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /holds no key material/);
      const written = JSON.parse(readFileSync(join(run.dir, 'config.json'), 'utf-8'));
      assert.equal(written.playlist.privateKey, configured.base64, 'config must be untouched');
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('refuses an empty --key rather than generating a new identity', async () => {
    const configured = makeKey();
    const feed = await startFeed(await storedPlaylist(configured));
    const run = await runCli(feed.baseUrl, configured.base64, [
      'setup',
      '--non-interactive',
      '--key',
      '',
      ...deviceArgs,
    ]);
    try {
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.output, /Invalid --key/);
      const written = JSON.parse(readFileSync(join(run.dir, 'config.json'), 'utf-8'));
      assert.equal(written.playlist.privateKey, configured.base64, 'config must be untouched');
    } finally {
      run.cleanup();
      feed.close();
    }
  });

  test('a key passed as the key-file path is refused without printing it', async () => {
    const provisioned = makeKey();
    const configured = makeKey();
    const feed = await startFeed(await storedPlaylist(provisioned));
    const run = await runCli(feed.baseUrl, configured.base64, [
      'setup',
      '--non-interactive',
      '--key-file',
      provisioned.base64,
      ...deviceArgs,
    ]);
    try {
      assert.notEqual(run.status, 0, run.output);
      assertNoKeyLeak(run.output, provisioned, configured);
    } finally {
      run.cleanup();
      feed.close();
    }
  });
});
