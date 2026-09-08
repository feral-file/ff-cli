/**
 * The pre-re-sign backup's guarantees, tested directly.
 *
 * The backup exists because `--replace-signatures` can discard a signature this command cannot
 * reproduce — only its holder could. So the file it writes has to be at least as safe as the document
 * it is protecting: it must never destroy an existing backup, it must claim its name atomically rather
 * than checking and then writing, and it must not widen who can read the document.
 *
 * These are properties of the write itself, which is why they are pinned here rather than only through
 * a signing run: a `existsSync`-then-write implementation passes every end-to-end test and still loses a
 * file to a concurrent creator.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { writeBackup, signPlaylistFile, signPlaylist } = require('../src/utilities/playlist-signer');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { playlistSigningDidKey } = require('../src/utilities/signing-identity');

function makePrivateKeyBase64(): string {
  return generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
}

/** signPlaylistFile prints on success; keep the test output readable. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const previous = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = previous;
  }
}

const isWindows = process.platform === 'win32';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ff1-backup-'));
}

describe('durability ordering', () => {
  test('the backup is written and synced before the source is touched', async () => {
    // The guarantee is the ORDER. A backup synced after the source was truncated protects nothing —
    // a crash in that window loses the original AND the copy, which is the one outcome the backup
    // exists to make impossible. No assertion about either write on its own can catch that, so the
    // whole sequence is recorded through one injected fs.
    const dir = makeTempDir();
    const keyA = makePrivateKeyBase64();
    const keyB = makePrivateKeyBase64();

    try {
      const base = JSON.parse(
        readFileSync(join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json'), 'utf-8')
      ) as Record<string, unknown>;
      const document = {
        ...base,
        curators: [
          { name: 'A', key: playlistSigningDidKey(keyA) },
          { name: 'B', key: playlistSigningDidKey(keyB) },
        ],
      };
      const sigA = await signPlaylist(document, keyA, 'curator');
      const sigB = await signPlaylist(document, keyB, 'curator');
      const file = join(dir, 'playlist.json');
      writeFileSync(
        file,
        JSON.stringify({ ...document, signatures: [sigA, sigB] }, null, 2),
        'utf-8'
      );

      const backup = `${file}.before-resign.json`;
      const events: string[] = [];
      const label = (p: unknown) => {
        if (p === backup) {
          return 'backup';
        }
        if (p === file) {
          return 'source';
        }
        if (p === dir) {
          return 'dir';
        }
        return String(p);
      };
      const fdNames = new Map<number, string>();

      const recordingFs = {
        ...fs,
        openSync: (p: string, flags: string, mode?: number) => {
          const fd = fs.openSync(p, flags as never, mode);
          fdNames.set(fd, label(p));
          events.push(`open:${label(p)}`);
          return fd;
        },
        writeFileSync: (target: unknown, contents: string, encoding?: unknown) => {
          const name = typeof target === 'number' ? fdNames.get(target) : label(target);
          events.push(`write:${name}`);
          return fs.writeFileSync(target as never, contents, encoding as never);
        },
        fsyncSync: (fd: number) => {
          events.push(`fsync:${fdNames.get(fd)}`);
          return fs.fsyncSync(fd);
        },
      };

      const result = await quietly(() =>
        signPlaylistFile(file, keyA, undefined, 'curator', {
          replaceSignatures: true,
          fs: recordingFs,
        })
      );
      assert.equal(result.success, true, result.error);

      // Everything the backup needs must be finished before a single byte of the source moves.
      const sourceWrite = events.indexOf('write:source');
      assert.notEqual(sourceWrite, -1, 'the source must actually be written');
      for (const required of ['open:backup', 'write:backup', 'fsync:backup']) {
        const at = events.indexOf(required);
        assert.notEqual(at, -1, `expected ${required} in ${events.join(' -> ')}`);
        assert.ok(
          at < sourceWrite,
          `${required} must precede the source write: ${events.join(' -> ')}`
        );
      }
      // The directory entry is synced too, so a crash cannot leave the backup nameless — but opening a
      // directory is not portable and Windows refuses it, which the implementation treats as
      // best-effort. Assert the ordering where it happens rather than requiring it everywhere; the
      // data sync above is the part that must always precede the source write.
      const dirSync = events.indexOf('fsync:dir');
      if (dirSync !== -1) {
        assert.ok(
          dirSync < sourceWrite,
          `dir sync must precede the source write: ${events.join(' -> ')}`
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeBackup', () => {
  test('writes the exact bytes to the first free name', () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      writeFileSync(file, '{"a":1}', 'utf-8');

      const written = writeBackup(fs, file, '{"a":1}');

      assert.equal(written, `${file}.before-resign.json`);
      assert.equal(readFileSync(written, 'utf-8'), '{"a":1}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never overwrites an existing backup, and numbers from there', () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      writeFileSync(file, '{}', 'utf-8');
      // Two earlier backups already exist. Both are somebody's only copy of something.
      writeFileSync(`${file}.before-resign.json`, 'FIRST', 'utf-8');
      writeFileSync(`${file}.before-resign.2.json`, 'SECOND', 'utf-8');

      const written = writeBackup(fs, file, 'THIRD');

      assert.equal(written, `${file}.before-resign.3.json`);
      assert.equal(readFileSync(`${file}.before-resign.json`, 'utf-8'), 'FIRST');
      assert.equal(readFileSync(`${file}.before-resign.2.json`, 'utf-8'), 'SECOND');
      assert.equal(readFileSync(written, 'utf-8'), 'THIRD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('repeated calls each land on their own file', () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      writeFileSync(file, '{}', 'utf-8');

      const paths = [
        writeBackup(fs, file, 'one'),
        writeBackup(fs, file, 'two'),
        writeBackup(fs, file, 'three'),
      ];

      assert.equal(new Set(paths).size, 3, 'each call must claim a distinct name');
      assert.deepEqual(
        paths.map((p) => readFileSync(p, 'utf-8')),
        ['one', 'two', 'three']
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('claims the name with an exclusive create, not a check followed by a write', () => {
    // The distinguishing test. A file that appears BETWEEN the existence check and the write is exactly
    // what `existsSync` + `writeFileSync` loses, and no end-to-end test can produce that interleaving.
    // Here the candidate is created by the `open` call itself being raced: the stub reports the file as
    // absent, so an implementation that trusts a prior check would truncate it.
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      writeFileSync(file, '{}', 'utf-8');
      const first = `${file}.before-resign.json`;
      writeFileSync(first, 'A CONCURRENT WRITER GOT HERE', 'utf-8');

      // `existsSync` lies: it says the first candidate is free. Only an exclusive open can still refuse.
      const lyingFs = {
        ...fs,
        existsSync: (path: string) => (path === first ? false : fs.existsSync(path)),
      };

      const written = writeBackup(lyingFs, file, 'MINE');

      assert.equal(written, `${file}.before-resign.2.json`, 'must fall through on EEXIST');
      assert.equal(
        readFileSync(first, 'utf-8'),
        'A CONCURRENT WRITER GOT HERE',
        'the file created by the other writer must survive'
      );
      assert.equal(readFileSync(written, 'utf-8'), 'MINE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('carries the source mode, defeating umask', { skip: isWindows }, () => {
    // Skipped on Windows: mode bits are not meaningful there and chmod only moves the write bit.
    //
    // `open(mode)` filters through umask, so a 0600 source under the usual 022 would land at 0600
    // anyway — but a 0666 source would land at 0644. The fchmod after the open is what makes the
    // backup match the source rather than match the umask.
    const dir = makeTempDir();
    const previousUmask = process.umask(0o022);
    try {
      const file = join(dir, 'playlist.json');
      writeFileSync(file, '{}', 'utf-8');
      fs.chmodSync(file, 0o640);

      const written = writeBackup(fs, file, '{}');

      assert.equal(statSync(written).mode & 0o777, 0o640);
    } finally {
      process.umask(previousUmask);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses when the source cannot be stat-ed, rather than writing a default-mode copy', () => {
    // With no mode and no ownership to reproduce, the only alternative is a world-readable copy of a
    // document that may have been deliberately restricted — the exact disclosure this guards against.
    // Refusing costs the operator a flag; the fallback would cost them the restriction.
    const dir = makeTempDir();
    try {
      const file = join(dir, 'gone.json');
      assert.throws(
        () => writeBackup(fs, file, 'CONTENT'),
        /Cannot read the permissions[\s\S]*--output/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses, and leaves nothing behind, when ownership cannot be reproduced', () => {
    // A 0640 alice:curators playlist re-signed by someone in another primary group yields a
    // 0640 bob:users copy: the mode is preserved and the access is still wider. That is the failure a
    // mode-only copy hides, so a chown that cannot be performed is a refusal, not a warning.
    //
    // The process identity is injected rather than read from `process`, so this runs everywhere. The
    // production gate on `process.getuid` existing is right — Windows has no POSIX identity to compare
    // — but reading it directly made this branch unreachable there, and a test that asserts nothing on
    // one platform is worse than no test, because the suite still reports green.
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      writeFileSync(file, '{}', 'utf-8');
      const source = statSync(file);

      const refusesChown = {
        ...fs,
        fchownSync: () => {
          throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        },
      };
      // A process identity that differs from the file's owner, so the chown branch is taken.
      const otherUser = { uid: source.uid + 1, gid: source.gid + 1 };

      assert.throws(
        () => writeBackup(refusesChown, file, '{}', otherUser),
        /same owner[\s\S]*--output/
      );
      // No half-made backup may survive: a copy that exists looks like a safe one.
      assert.equal(existsSync(`${file}.before-resign.json`), false);
      // And the source is untouched.
      assert.equal(readFileSync(file, 'utf-8'), '{}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not chown when the process already owns the source', () => {
    // Non-vacuity for the branch above, and the reason the gate exists: an identity that matches must
    // not trigger a chown at all, on any platform.
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      writeFileSync(file, '{}', 'utf-8');
      const source = statSync(file);

      let chowned = false;
      const recording = {
        ...fs,
        fchownSync: () => {
          chowned = true;
          throw new Error('must not be called');
        },
      };

      const written = writeBackup(recording, file, '{}', { uid: source.uid, gid: source.gid });

      assert.equal(chowned, false, 'ownership already matches; nothing to reproduce');
      assert.equal(readFileSync(written, 'utf-8'), '{}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips the ownership step entirely without a POSIX identity', () => {
    // What Windows sees. `undefined` uid/gid means there is nothing to compare, so no chown is
    // attempted and the backup is still written — the platform has no POSIX ownership to preserve.
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      writeFileSync(file, '{}', 'utf-8');

      let chowned = false;
      const recording = {
        ...fs,
        fchownSync: () => {
          chowned = true;
          throw new Error('must not be called');
        },
      };

      const written = writeBackup(recording, file, '{}', { uid: undefined, gid: undefined });

      assert.equal(chowned, false);
      assert.equal(readFileSync(written, 'utf-8'), '{}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
