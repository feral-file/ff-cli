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
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { writeBackup } = require('../src/utilities/playlist-signer');

const isWindows = process.platform === 'win32';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ff1-backup-'));
}

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

  test('falls back to the default mode when the source cannot be stat-ed', () => {
    // Guessing at something more permissive than the source is the failure worth avoiding; refusing to
    // write the backup at all would be worse, since the document is about to be overwritten regardless.
    const dir = makeTempDir();
    try {
      const file = join(dir, 'gone.json');
      const written = writeBackup(fs, file, 'CONTENT');
      assert.equal(readFileSync(written, 'utf-8'), 'CONTENT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
