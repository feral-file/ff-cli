/**
 * The documented edit → re-sign → replace workflow, end to end.
 *
 * This file deliberately starts from a **stored** document — the shape a feed serves, carrying the
 * curator's signature and the feed's own — rather than from a freshly signed fixture. That distinction
 * is the bug it exists for: a fixture signed after the edit hides the fact that the documented path did
 * not work. Editing a signed document invalidates every signature on it, `sign` appends rather than
 * replaces, and `signPlaylistFile` verifies the combined envelope before writing — so the edited
 * document could not be re-signed at all, and `publish --replace` had no reachable input.
 *
 * Hermetic: the "feed" is a loopback HTTP server started by the test.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { replacePlaylist } from '../src/utilities/playlist-publisher';
import { signPlaylist, signPlaylistFile } from '../src/utilities/playlist-signer';
import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

const projectRoot = resolve(__dirname, '..');
// Spawn node directly with tsx's JS entry to avoid Windows .cmd shim limitations in spawnSync.
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ff1-resign-'));
}

function makePrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

/** Run `fn` with `console.log` silenced; `signPlaylistFile` prints on success. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const previous = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = previous;
  }
}

/**
 * A playlist as the feed stores and serves it: signed by its curator, then co-signed by the feed.
 *
 * The feed appends its own entry after verifying, and the payload hash excludes `signatures`, so both
 * entries are valid over the same bytes. Reproducing that here is what makes the test meaningful — the
 * feed's entry is stale the moment the document is edited, exactly like the curator's.
 */
async function storedDocument(
  curatorKey: string,
  feedKey: string
): Promise<Record<string, unknown>> {
  const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
  const document = {
    ...base,
    curators: [{ name: 'Owner', key: playlistSigningDidKey(curatorKey) }],
  };
  const curatorSignature = await signPlaylist(document, curatorKey, 'curator');
  const withCurator = { ...document, signatures: [curatorSignature] };
  const feedSignature = await signPlaylist(withCurator, feedKey, 'feed');
  return { ...withCurator, signatures: [curatorSignature, feedSignature] };
}

/** Start a loopback feed that serves `stored` on GET and records the PUT. */
async function startFeed(stored: Record<string, unknown>): Promise<{
  baseUrl: string;
  recorded: { method?: string; body?: string };
  close: () => void;
}> {
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(JSON.parse(body).document));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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

describe('edit a published playlist, re-sign, replace', () => {
  test('the documented workflow succeeds from the stored document', async () => {
    const dir = makeTempDir();
    const curatorKey = makePrivateKeyBase64();
    const feedKey = makePrivateKeyBase64();
    const stored = await storedDocument(curatorKey, feedKey);
    const feed = await startFeed(stored);

    try {
      // 1. What an operator has in hand after fetching the published playlist.
      const path = join(dir, 'published.json');
      writeFileSync(path, JSON.stringify(stored, null, 2), 'utf-8');

      // 2. Edit it.
      const edited = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      edited.title = 'Edited after publishing';
      writeFileSync(path, JSON.stringify(edited, null, 2), 'utf-8');

      // 3. Re-sign fresh. This is the step that did not exist.
      const signed = await quiet(() =>
        signPlaylistFile(path, curatorKey, undefined, 'curator', { replaceSignatures: true })
      );
      assert.equal(signed.success, true, signed.error);
      assert.equal(signed.dropped.length, 2, 'both the curator and feed entries must be dropped');
      // The classification is what the owner acts on, so it is pinned here rather than only in the
      // command's output. A `feed` role gets no special treatment: any key can emit one, and the CLI
      // holds no feed identity to check a kid against, so it is another key's signature like any other.
      assert.deepEqual(signed.dropped.map((entry: { kind: string }) => entry.kind).sort(), [
        'other',
        'self',
      ]);
      // The document was edited, so nothing that was on it still covers it.
      assert.deepEqual(
        signed.dropped.map((entry: { valid: boolean }) => entry.valid),
        [false, false]
      );

      const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as {
        title: string;
        signatures: Array<{ role: string; kid: string }>;
      };
      assert.equal(onDisk.title, 'Edited after publishing');
      assert.equal(
        onDisk.signatures.length,
        1,
        'the fresh envelope carries only the new signature'
      );
      assert.equal(onDisk.signatures[0].role, 'curator');
      assert.equal(onDisk.signatures[0].kid, playlistSigningDidKey(curatorKey));
      // The feed's stale entry must be gone: it covers the pre-edit content, and the feed appends a new
      // one after verifying the replacement.
      assert.equal(
        onDisk.signatures.some((s) => s.role === 'feed'),
        false
      );

      // 4. Replace.
      const result = await replacePlaylist(path, feed.baseUrl, { privateKey: curatorKey });
      assert.equal(result.success, true, `${result.error}\n${result.message}`);
      assert.equal(feed.recorded.method, 'PUT');

      const sent = JSON.parse(String(feed.recorded.body)) as {
        document: { title: string; signatures: unknown[] };
      };
      assert.equal(sent.document.title, 'Edited after publishing');
      assert.equal(sent.document.signatures.length, 1);
    } finally {
      feed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('plain sign still refuses an edited signed document', async () => {
    // Non-vacuity guard for the flag, and the reason it had to exist. Appending leaves the earlier
    // entries covering bytes that moved, and the envelope check refuses to write that.
    const dir = makeTempDir();
    const curatorKey = makePrivateKeyBase64();
    const feedKey = makePrivateKeyBase64();

    try {
      const stored = await storedDocument(curatorKey, feedKey);
      const path = join(dir, 'edited.json');
      writeFileSync(
        path,
        JSON.stringify({ ...stored, title: 'Edited after publishing' }, null, 2),
        'utf-8'
      );

      const appended = await quiet(() => signPlaylistFile(path, curatorKey, undefined, 'curator'));

      assert.equal(appended.success, false);
      assert.match(String(appended.error), /verification failed|not verifiable/i);
      // The file must be left as it was, not half-written.
      const untouched = JSON.parse(readFileSync(path, 'utf-8')) as { signatures: unknown[] };
      assert.equal(untouched.signatures.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the CLI points at the flag when an edited document cannot be re-signed', async () => {
    // The refusal above is correct but its remedy is not guessable: "signed playlist verification
    // failed" reads as a key problem, and the natural next move — sign again — cannot work, because
    // signing appends. The command has to name the flag where the failure appears.
    const dir = makeTempDir();
    const curatorKey = makePrivateKeyBase64();
    const feedKey = makePrivateKeyBase64();

    try {
      const stored = await storedDocument(curatorKey, feedKey);
      const path = join(dir, 'edited.json');
      writeFileSync(
        path,
        JSON.stringify({ ...stored, title: 'Edited after publishing' }, null, 2),
        'utf-8'
      );

      const appended = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', curatorKey],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.notEqual(appended.status, 0);
      const output = `${appended.stdout ?? ''}${appended.stderr ?? ''}`;
      assert.match(output, /--replace-signatures/);
      assert.match(output, /signing appends/i);

      // And following that hint has to actually work, or the remedy is worse than none.
      const fresh = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', curatorKey, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(fresh.status, 0, `${fresh.stdout ?? ''}${fresh.stderr ?? ''}`);
      const freshOut = `${fresh.stdout ?? ''}`;
      assert.match(freshOut, /Replaced 2 existing signatures:/);
      // Each entry has to be named, with enough of the kid to match a curators[] row at a glance.
      assert.match(freshOut, /your own earlier signature \(curator, \.\.\.[A-Za-z0-9]{8}\)/);
      assert.match(freshOut, /another key's signature \(feed, \.\.\.[A-Za-z0-9]{8}\) — void/);
      const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as { signatures: unknown[] };
      assert.equal(onDisk.signatures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('names each lost signature with its own role, and who has to restore it', async () => {
    // The case the classification exists for. Dropping your own signature or the feed's costs nothing;
    // dropping someone else's endorsement cannot be undone without asking them to sign again, and the
    // owner has to learn that before they publish the replacement, not after someone notices.
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();
    const keyB = makePrivateKeyBase64();
    const feedKey = makePrivateKeyBase64();

    try {
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = {
        ...base,
        curators: [
          { name: 'A', key: playlistSigningDidKey(keyA) },
          { name: 'B', key: playlistSigningDidKey(keyB) },
        ],
      };
      const sigA = await signPlaylist(document, keyA, 'curator');
      const sigB = await signPlaylist(document, keyB, 'curator');
      const feedSig = await signPlaylist(document, feedKey, 'feed');
      const path = join(dir, 'co-curated.json');
      writeFileSync(
        path,
        JSON.stringify(
          { ...document, title: 'Edited', signatures: [sigA, sigB, feedSig] },
          null,
          2
        ),
        'utf-8'
      );

      // A re-signs the edited document; B's endorsement and the feed's are void.
      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;
      assert.match(out, /Replaced 3 existing signatures:/);
      assert.match(out, /your own earlier signature \(curator, \.\.\.[A-Za-z0-9]{8}\) — replaced/);
      assert.match(out, /another key's signature \(curator, \.\.\.[A-Za-z0-9]{8}\) — void/);
      assert.match(out, /another key's signature \(feed, \.\.\.[A-Za-z0-9]{8}\) — void/);
      // B's kid must be identifiable, or "another key" names nobody.
      assert.ok(out.includes(playlistSigningDidKey(keyB).slice(-8)));

      // Both non-self entries are losses; the signer's own is not. A `feed` role is not assumed to
      // return on its own — any key can emit one, and the CLI has no feed identity to verify against.
      assert.match(out, /2 other signatures are now void/);
      // Each loss is addressed to its holder IN ITS OWN ROLE: `agent`, `institution` and `licensor`
      // are valid, so a blanket "sign again as curator" would be wrong.
      assert.match(
        out,
        new RegExp(`ask \\.\\.\\.${playlistSigningDidKey(keyB).slice(-8)} to sign again as curator`)
      );
      assert.match(out, /ask \.\.\.[A-Za-z0-9]{8} to sign again as feed/);
      // The feed's behaviour is stated generally, never as a claim about a specific entry.
      assert.match(out, /A feed appends its own signature again after it verifies a replacement/);
      assert.doesNotMatch(out, /3 other signatures are now void/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unchanged document reports removal, not loss', async () => {
    // The DP-1 signing payload excludes `signature`/`signatures`, so re-signing a document nobody
    // edited leaves every existing entry perfectly valid over the same bytes. Reporting those as void
    // and telling the owner to go ask their co-curators again would send them chasing signatures that
    // are still sitting in the previous file.
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();
    const keyB = makePrivateKeyBase64();

    try {
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = {
        ...base,
        curators: [
          { name: 'A', key: playlistSigningDidKey(keyA) },
          { name: 'B', key: playlistSigningDidKey(keyB) },
        ],
      };
      const sigA = await signPlaylist(document, keyA, 'curator');
      const sigB = await signPlaylist(document, keyB, 'curator');
      const path = join(dir, 'unchanged.json');
      // Written exactly as signed: no edit at all.
      writeFileSync(
        path,
        JSON.stringify({ ...document, signatures: [sigA, sigB] }, null, 2),
        'utf-8'
      );

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;
      assert.match(
        out,
        /another key's signature \(curator, \.\.\.[A-Za-z0-9]{8}\) — removed, still valid/
      );
      assert.match(out, /still verified over this content and was removed anyway/);
      assert.match(out, /Keep a copy of the previous file/);
      // Nothing was invalidated, so no one may be told to sign again.
      assert.doesNotMatch(out, /now void/);
      assert.doesNotMatch(out, /to sign again as/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same document edited reports the same entry as void', async () => {
    // Non-vacuity pair for the test above: one byte of content decides which branch is right, so both
    // have to be pinned or the verification could silently stop happening.
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();
    const keyB = makePrivateKeyBase64();

    try {
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = {
        ...base,
        curators: [
          { name: 'A', key: playlistSigningDidKey(keyA) },
          { name: 'B', key: playlistSigningDidKey(keyB) },
        ],
      };
      const sigA = await signPlaylist(document, keyA, 'curator');
      const sigB = await signPlaylist(document, keyB, 'curator');
      const path = join(dir, 'changed.json');
      writeFileSync(
        path,
        JSON.stringify({ ...document, title: 'Edited', signatures: [sigA, sigB] }, null, 2),
        'utf-8'
      );

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;
      assert.match(out, /another key's signature \(curator, \.\.\.[A-Za-z0-9]{8}\) — void/);
      assert.match(out, /1 other signature is now void/);
      assert.match(
        out,
        new RegExp(`ask \\.\\.\\.${playlistSigningDidKey(keyB).slice(-8)} to sign again as curator`)
      );
      assert.doesNotMatch(out, /still valid over this content/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appending is still the default when nothing was edited', async () => {
    // --replace-signatures must not become the only behaviour: co-signing an unchanged document is the
    // case the append default exists for, and it stays correct because the payload did not move.
    const dir = makeTempDir();
    const curatorA = makePrivateKeyBase64();
    const curatorB = makePrivateKeyBase64();

    try {
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = {
        ...base,
        curators: [
          { name: 'A', key: playlistSigningDidKey(curatorA) },
          { name: 'B', key: playlistSigningDidKey(curatorB) },
        ],
      };
      const first = await signPlaylist(document, curatorA, 'curator');
      const path = join(dir, 'co-signed.json');
      writeFileSync(path, JSON.stringify({ ...document, signatures: [first] }, null, 2), 'utf-8');

      const result = await quiet(() => signPlaylistFile(path, curatorB, undefined, 'curator'));

      assert.equal(result.success, true, result.error);
      assert.deepEqual(result.dropped, []);
      const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as { signatures: unknown[] };
      assert.equal(onDisk.signatures.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
