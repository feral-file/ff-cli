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
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
/**
 * A temp directory, resolved.
 *
 * macOS hands out `/var/folders/...`, which is itself a symlink to `/private/var/folders/...`. The
 * backup path is chosen with realpath — deliberately, so the copy lands beside the file rather than
 * beside a link — so an unresolved temp path here makes every path expectation disagree with the
 * implementation on exactly one platform.
 */
function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ff1-resign-')));
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
      // Neither survives the edit, so neither is credited to anybody: an entry that does not verify
      // has not established whose it is, including the signer's own.
      assert.deepEqual(signed.dropped.map((entry: { kind: string }) => entry.kind).sort(), [
        'other',
        'other',
      ]);
      // The document was edited, so nothing that was on it verifies against it now. The verdict is
      // exactly that — not "void", which would assert they verified against the PREVIOUS content, a
      // document this command never sees.
      assert.deepEqual(
        signed.dropped.map((entry: { verified: boolean }) => entry.verified),
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
      assert.match(freshOut, /a signature claiming your key \(curator, \.\.\.[A-Za-z0-9]{8}\)/);
      assert.match(
        freshOut,
        /another key's signature \(feed, \.\.\.[A-Za-z0-9]{8}\) — removed; could not be verified/
      );
      const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as { signatures: unknown[] };
      assert.equal(onDisk.signatures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('names each unverified signature with its own role, without diagnosing why', async () => {
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
      // The signer's own prior entry does not verify against the edited document either, so it is
      // reported as a claim rather than credited — the same rule that stops a forgery hiding as
      // "replaced".
      assert.match(
        out,
        /a signature claiming your key \(curator, \.\.\.[A-Za-z0-9]{8}\) — removed; could not be verified/
      );
      assert.match(
        out,
        /another key's signature \(curator, \.\.\.[A-Za-z0-9]{8}\) — removed; could not be verified/
      );
      assert.match(
        out,
        /another key's signature \(feed, \.\.\.[A-Za-z0-9]{8}\) — removed; could not be verified/
      );

      // All three failed to verify against the edited document, including the signer's own — an entry
      // that does not verify has not established whose it is, so none is credited or excluded. A
      // `feed` role gets no special treatment either: any key can emit one, and the CLI holds no feed
      // identity to check a kid against.
      assert.match(out, /3 other signatures could not be verified against this document/);
      // Each one is named, with its role, so the owner can see whose signatures are missing.
      assert.ok(out.includes(playlistSigningDidKey(keyB).slice(-8)));
      assert.match(out, /\.\.\.[A-Za-z0-9]{8} \(curator\)/);
      assert.match(out, /\.\.\.[A-Za-z0-9]{8} \(feed\)/);
      // Both explanations are offered, because only one of them can be true and this command cannot
      // tell which. Nothing may be asserted about the previous content.
      assert.match(out, /equally with their never having been valid/);
      assert.doesNotMatch(out, /void/i);
      // The feed's behaviour is stated generally, never as a claim about a specific entry.
      assert.match(out, /A feed appends its own signature again after it verifies a replacement/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an in-place run refuses to discard another key's still-valid signature", async () => {
    // The invariant: a still-valid endorsement from another key is never destroyed by an in-place run.
    // Only its holder could make another, so overwriting it costs something the command cannot restore.
    //
    // An earlier version kept a copy of the input instead. That sounds kinder and is much harder to get
    // right — a copy has to reproduce the source's access and cannot, because POSIX ACLs grant what
    // mode bits do not describe, macOS extended ACLs ignore the mask, and Windows mode bits constrain
    // nothing. Refusing needs no filesystem assumptions at all, so it holds everywhere.
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
      const path = join(dir, 'co-signed.json');
      // Written exactly as signed: B's signature still verifies over this content.
      const originalBytes = JSON.stringify({ ...document, signatures: [sigA, sigB] }, null, 2);
      writeFileSync(path, originalBytes, 'utf-8');
      const before = readdirSync(dir).sort();

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.notEqual(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      assert.match(output, /would discard 1 still-valid signature from other keys/);
      // The remedy has to be a command that works, not a description of the problem.
      assert.match(output, /--replace-signatures --output <new file>/);

      // Nothing moved: the input is byte-identical and no file was created beside it.
      assert.equal(readFileSync(path, 'utf-8'), originalBytes);
      assert.deepEqual(readdirSync(dir).sort(), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an in-place run proceeds when only your own signature would go', async () => {
    // The refusal is about what cannot be restored. Your own entry can be: sign again. So a role change
    // on your own key — a still-valid entry, dropped, and nobody else to ask — proceeds in place.
    // Refusing here would make the rule about signature counts rather than about recoverability.
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();

    try {
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = { ...base, curators: [{ name: 'A', key: playlistSigningDidKey(keyA) }] };
      const curatorSig = await signPlaylist(document, keyA, 'curator');
      const path = join(dir, 'role-change.json');
      writeFileSync(
        path,
        JSON.stringify({ ...document, signatures: [curatorSig] }, null, 2),
        'utf-8'
      );

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'agent', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;
      assert.match(
        out,
        /your signature in another role \(curator, \.\.\.[A-Za-z0-9]{8}\) — removed/
      );
      // The report says who can restore it, and it is the person reading.
      assert.match(out, /made by your own key in another role; sign again/);
      assert.doesNotMatch(out, /would discard/);

      // The written document really did lose its curator entry — the state that fails a publish.
      const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as {
        signatures: Array<{ role: string }>;
      };
      assert.deepEqual(
        onDisk.signatures.map((entry) => entry.role),
        ['agent']
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an in-place run proceeds when the entries that would go do not verify', async () => {
    // Nothing recoverable is lost: an entry that does not verify against this document cannot be put
    // back from the input either, so the input is worth no more than the result.
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
      const path = join(dir, 'edited.json');
      // Edited after signing, so neither entry verifies any more.
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
      assert.doesNotMatch(`${result.stdout ?? ''}`, /would discard/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--output to a different file proceeds and leaves the input alone', async () => {
    // The way through. The discard report is unchanged; only the input's fate differs.
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
      const path = join(dir, 'co-signed.json');
      const originalBytes = JSON.stringify({ ...document, signatures: [sigA, sigB] }, null, 2);
      writeFileSync(path, originalBytes, 'utf-8');

      const result = spawnSync(
        process.execPath,
        [
          tsxCli,
          cliEntry,
          'sign',
          path,
          '-r',
          'curator',
          '-k',
          keyA,
          '--replace-signatures',
          '-o',
          join(dir, 'out.json'),
        ],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;
      assert.match(
        out,
        /another key's signature \(curator, \.\.\.[A-Za-z0-9]{8}\) — removed; still valid/
      );
      assert.match(out, /Your input file is untouched/);

      // The input still holds both signatures; the new file holds one.
      assert.equal(readFileSync(path, 'utf-8'), originalBytes);
      const written = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8')) as {
        signatures: unknown[];
      };
      assert.equal(written.signatures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same document edited reports the same entry as unverified', async () => {
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
      assert.match(
        out,
        /another key's signature \(curator, \.\.\.[A-Za-z0-9]{8}\) — removed; could not be verified/
      );
      assert.match(out, /2 other signatures could not be verified against this document/);
      assert.ok(out.includes(playlistSigningDidKey(keyB).slice(-8)));
      assert.doesNotMatch(out, /still valid over this content/);
      assert.doesNotMatch(out, /void/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a tampered entry is reported as unverified, never as void', async () => {
    // A failed verification cannot distinguish an edit from an entry that was never valid. This one
    // was tampered with on an OTHERWISE UNCHANGED document, so "the content changed" would be a plain
    // falsehood — and it is reachable input, not a hypothetical.
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
      const path = join(dir, 'tampered.json');
      writeFileSync(
        path,
        JSON.stringify({ ...document, signatures: [sigA, { ...sigB, sig: 'AAAA' }] }, null, 2),
        'utf-8'
      );

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;
      assert.match(out, /could not be verified against this document/);
      // The content did NOT change here, so nothing may claim it did as the explanation.
      assert.doesNotMatch(out, /void/i);
      assert.match(out, /equally with their never having been valid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a forged entry carrying the signing key\'s kid and role is never "replaced"', async () => {
    // `kid` and `role` are claims the entry makes about itself. Trusting them meant a tampered entry
    // that copied the signer's identity was labelled "your own earlier signature, replaced" and
    // dropped out of the unverified summary — hiding, from the operator, exactly the signature most
    // worth showing them. Only a signature that verifies has established whose it is.
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();
    const keyB = makePrivateKeyBase64();

    try {
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = { ...base, curators: [{ name: 'A', key: playlistSigningDidKey(keyA) }] };
      // Signed by B, then relabelled with A's kid and the role A is about to sign under. The document
      // is otherwise UNCHANGED, so a genuine entry of A's would verify — only this one cannot.
      const forged = await signPlaylist(document, keyB, 'curator');
      const path = join(dir, 'forged.json');
      writeFileSync(
        path,
        JSON.stringify(
          {
            ...document,
            signatures: [{ ...forged, kid: playlistSigningDidKey(keyA), role: 'curator' }],
          },
          null,
          2
        ),
        'utf-8'
      );

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;
      assert.doesNotMatch(out, /replaced by this signing/);
      assert.doesNotMatch(out, /your own earlier signature/);
      // Reported as the claim it is, and surfaced in the unverified summary rather than hidden.
      assert.match(out, /a signature claiming your key \(curator, \.\.\.[A-Za-z0-9]{8}\)/);
      assert.match(out, /1 other signature could not be verified against this document/);
      assert.match(out, /claims your key, unverified/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a legacy flat signature is reported as not checkable, with no key or role invented', async () => {
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();

    try {
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = {
        ...base,
        curators: [{ name: 'A', key: playlistSigningDidKey(keyA) }],
        signature: 'ed25519:deadbeef',
      };
      const path = join(dir, 'legacy.json');
      writeFileSync(path, JSON.stringify(document, null, 2), 'utf-8');

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;
      assert.match(
        out,
        /a legacy flat signature \(no kid, no role\) — removed; not checkable here/
      );
      assert.match(out, /carries no kid or role, so nothing here can judge it/);
      // It carries no key, so it must not be counted among entries that failed verification.
      assert.doesNotMatch(out, /could not be verified against this document/);
      assert.doesNotMatch(out, /void/i);
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
