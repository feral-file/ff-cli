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
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  mkdirSync,
  symlinkSync,
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
const isWindows = process.platform === 'win32';

/** Escape a filesystem path for use inside a RegExp; Windows separators and dots are metacharacters. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
        /another key's signature \(curator, \.\.\.[A-Za-z0-9]{8}\) — removed; still valid/
      );
      assert.match(out, /still verified over this content and was removed anyway/);
      // The previous document is preserved before the overwrite, so the report names a real file
      // rather than advising a copy the command has already destroyed.
      assert.match(out, /The document as it was is saved at .*before-resign\.json/);
      // Nothing was invalidated, so no one may be told to sign again.
      assert.doesNotMatch(out, /void/i);
      assert.doesNotMatch(out, /could not be verified/);
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

  test('an in-place re-sign preserves the original before overwriting it', async () => {
    // The report says a still-valid third-party signature was removed and the previous file is how to
    // get it back. On an in-place run that file was already gone by the time the sentence printed —
    // the command destroyed the remedy it was recommending. The backup is written first now.
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
      const originalBytes = JSON.stringify({ ...document, signatures: [sigA, sigB] }, null, 2);
      writeFileSync(path, originalBytes, 'utf-8');

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);

      const backup = `${path}.before-resign.json`;
      // Byte-for-byte: the signatures cover the exact document, so a reformatted copy would be a
      // backup in name only — B's signature would not verify against it.
      assert.equal(readFileSync(backup, 'utf-8'), originalBytes);
      // And the report points at the file that exists, not at a copy the operator was meant to have.
      assert.match(
        `${result.stdout ?? ''}`,
        new RegExp(`saved at ${backup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      );
      assert.doesNotMatch(`${result.stdout ?? ''}`, /Keep a copy of the previous file/);

      // A second run must not clobber the first backup — that is somebody's only copy too.
      const second = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      // The second run drops only the signer's own entry, so it needs no backup at all.
      assert.equal(second.status, 0, `${second.stdout ?? ''}${second.stderr ?? ''}`);
      assert.equal(readFileSync(backup, 'utf-8'), originalBytes, 'the first backup must survive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('numbers the backup rather than overwriting an existing one', async () => {
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
      const path = join(dir, 'p.json');
      const originalBytes = JSON.stringify({ ...document, signatures: [sigA, sigB] }, null, 2);
      writeFileSync(path, originalBytes, 'utf-8');
      // Something already occupies the first backup name — quite possibly an earlier run's only copy.
      writeFileSync(`${path}.before-resign.json`, 'PRECIOUS', 'utf-8');

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      assert.equal(readFileSync(`${path}.before-resign.json`, 'utf-8'), 'PRECIOUS');
      assert.equal(readFileSync(`${path}.before-resign.2.json`, 'utf-8'), originalBytes);
      assert.match(`${result.stdout ?? ''}`, /before-resign\.2\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writes no backup when nothing restorable is discarded', async () => {
    // Only the signer's own entry goes. It is replaced by this very run, so a backup would be litter —
    // and litter trains people to ignore the file that matters.
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();

    try {
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = { ...base, curators: [{ name: 'A', key: playlistSigningDidKey(keyA) }] };
      const sigA = await signPlaylist(document, keyA, 'curator');
      const path = join(dir, 'self-only.json');
      writeFileSync(path, JSON.stringify({ ...document, signatures: [sigA] }, null, 2), 'utf-8');

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      assert.equal(existsSync(`${path}.before-resign.json`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const linkKind of ['symlink', 'hard link'] as const) {
    test(`treats an --output that is a ${linkKind} of the input as in place`, async () => {
      // The write follows the link to the input's inode either way. Deciding by path string called it
      // a different file, so no backup was written AND the report said the input was untouched — the
      // one combination that loses the signature silently while claiming it did not.
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
        const path = join(dir, 'input.json');
        const originalBytes = JSON.stringify({ ...document, signatures: [sigA, sigB] }, null, 2);
        writeFileSync(path, originalBytes, 'utf-8');

        const alias = join(dir, 'alias.json');
        if (linkKind === 'symlink') {
          symlinkSync(path, alias);
        } else {
          linkSync(path, alias);
        }

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
            alias,
          ],
          { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );

        assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
        const out = `${result.stdout ?? ''}`;
        // The original must have been preserved before the write went through the link.
        assert.equal(readFileSync(`${path}.before-resign.json`, 'utf-8'), originalBytes);
        assert.match(out, /The document as it was is saved at .*before-resign\.json/);
        // And it must not claim the input survived, because it did not.
        assert.doesNotMatch(out, /input file is untouched/);
        // The input really was overwritten through the alias.
        assert.notEqual(readFileSync(path, 'utf-8'), originalBytes);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('writes no backup when --output leaves the input untouched', async () => {
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
      const path = join(dir, 'input.json');
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
      assert.equal(existsSync(`${path}.before-resign.json`), false, 'no backup is needed');
      // The input is the backup, so the report says so rather than naming a file it did not write.
      assert.equal(readFileSync(path, 'utf-8'), originalBytes);
      assert.match(`${result.stdout ?? ''}`, /input file is untouched/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a role change on the signing key is a loss, not a replacement', async () => {
    // Matching on the key alone quietly produced unpublishable documents: re-signing as `agent` with a
    // key that had signed as `curator` dropped the curator entry, called it "replaced", and left it out
    // of the backup — and the result then fails the publisher's declared-curator preflight with nothing
    // on disk to recover from. Ownership lives in the role as much as in the key.
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();

    try {
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = { ...base, curators: [{ name: 'A', key: playlistSigningDidKey(keyA) }] };
      const curatorSig = await signPlaylist(document, keyA, 'curator');
      const path = join(dir, 'role-change.json');
      const originalBytes = JSON.stringify({ ...document, signatures: [curatorSig] }, null, 2);
      writeFileSync(path, originalBytes, 'utf-8');

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'agent', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;
      // Reported as removed, and as this key's own — not as another key's, and not as replaced.
      assert.match(
        out,
        /your signature in another role \(curator, \.\.\.[A-Za-z0-9]{8}\) — removed/
      );
      assert.doesNotMatch(out, /replaced by this signing/);

      // It counts toward the backup trigger like any other loss, so the curator signature survives.
      const backup = `${path}.before-resign.json`;
      assert.equal(readFileSync(backup, 'utf-8'), originalBytes);

      // And the written document really has lost its curator entry — the state that fails a publish.
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

  test('the backup carries the source file permissions', { skip: isWindows }, async () => {
    // Skipped on Windows, where POSIX mode bits are not meaningful and chmod only moves the write bit.
    //
    // A playlist at 0600 is restricted deliberately. A backup of it at 0644 under the usual umask
    // publishes the document, and its signing history, to every local user — a disclosure created by
    // the command that was trying to protect them.
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
      const path = join(dir, 'private.json');
      writeFileSync(
        path,
        JSON.stringify({ ...document, signatures: [sigA, sigB] }, null, 2),
        'utf-8'
      );
      chmodSync(path, 0o600);

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', path, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const mode = statSync(`${path}.before-resign.json`).mode & 0o777;
      assert.equal(
        mode,
        0o600,
        `backup must not widen access; got 0${mode.toString(8)} (umask would give 0644)`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('signing through an input symlink backs up beside the target, not the link', async () => {
    // The command follows the link and writes to the target, so the backup has to live where the bytes
    // do. Beside the link it can sit in a directory other people may write to, and the only remaining
    // copy of a discarded signature can be removed there before the source is even overwritten.
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();
    const keyB = makePrivateKeyBase64();

    try {
      const targetDir = join(dir, 'private');
      const linkDir = join(dir, 'shared');
      mkdirSync(targetDir);
      mkdirSync(linkDir);

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
      const target = join(targetDir, 'playlist.json');
      const link = join(linkDir, 'playlist.json');
      const originalBytes = JSON.stringify({ ...document, signatures: [sigA, sigB] }, null, 2);
      writeFileSync(target, originalBytes, 'utf-8');
      symlinkSync(target, link);

      const result = spawnSync(
        process.execPath,
        [tsxCli, cliEntry, 'sign', link, '-r', 'curator', '-k', keyA, '--replace-signatures'],
        { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const out = `${result.stdout ?? ''}`;

      // The copy is beside the real file...
      assert.equal(readFileSync(`${target}.before-resign.json`, 'utf-8'), originalBytes);
      // ...and nothing was left in the link's directory.
      assert.equal(existsSync(`${link}.before-resign.json`), false);
      // The report names the path that actually holds it, or the advice sends people to an empty dir.
      assert.match(out, new RegExp(`saved at ${escapeForRegExp(`${target}.before-resign.json`)}`));
      // The signing really did write through the link to the target.
      assert.notEqual(readFileSync(target, 'utf-8'), originalBytes);
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
