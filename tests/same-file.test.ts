/**
 * The two "same file?" predicates, which differ because the writes they guard differ.
 *
 * A direct write follows symlinks and hard links alike, so both are the same file for it. A rename
 * replaces a directory entry, so a hard link is a genuinely distinct destination — and answering that
 * one with inode identity makes a safe write look unsafe. Both directions are pinned here, because the
 * obvious refactor is to merge them and it is wrong.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isSameEntryForRename,
  isSameFileForDirectWrite,
  isSameFileForDirectWriteAsync,
  type SameFileFs,
} from '../src/utilities/same-file';

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'ff1-samefile-'));
  const done = () => rmSync(dir, { recursive: true, force: true });
  let result: void | Promise<void>;
  try {
    result = fn(dir);
  } catch (error) {
    done();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(done);
  }
  done();
  return result;
}

describe('isSameFileForDirectWrite', () => {
  test('recognizes the same path, however it is spelled', () =>
    withTempDir((dir) => {
      const file = join(dir, 'a.json');
      writeFileSync(file, '{}', 'utf-8');
      assert.equal(isSameFileForDirectWrite(file, file), true);
      assert.equal(isSameFileForDirectWrite(file, join(dir, '.', 'a.json')), true);
      assert.equal(isSameFileForDirectWrite(file, join(dir, 'sub', '..', 'a.json')), true);
    }));

  test('recognizes a symlink to the file', () =>
    withTempDir((dir) => {
      const file = join(dir, 'a.json');
      const link = join(dir, 'link.json');
      writeFileSync(file, '{}', 'utf-8');
      symlinkSync(file, link);
      assert.equal(isSameFileForDirectWrite(file, link), true);
    }));

  test('recognizes a hard link to the file', () =>
    withTempDir((dir) => {
      // The case realpath cannot see: two directory entries, one inode, two distinct real paths.
      const file = join(dir, 'a.json');
      const link = join(dir, 'hard.json');
      writeFileSync(file, '{}', 'utf-8');
      linkSync(file, link);
      assert.equal(isSameFileForDirectWrite(file, link), true);
    }));

  test('separates two genuinely different files, including identical copies', () =>
    withTempDir((dir) => {
      const a = join(dir, 'a.json');
      const b = join(dir, 'b.json');
      writeFileSync(a, '{}', 'utf-8');
      writeFileSync(b, '{}', 'utf-8');
      assert.equal(isSameFileForDirectWrite(a, b), false);
    }));

  test('treats a path that does not exist as a different file', () =>
    withTempDir((dir) => {
      // An --output naming a file yet to be created is the ordinary "write elsewhere" case, and must
      // not be mistaken for the in-place one.
      const file = join(dir, 'a.json');
      writeFileSync(file, '{}', 'utf-8');
      assert.equal(isSameFileForDirectWrite(file, join(dir, 'not-yet.json')), false);
      assert.equal(
        isSameFileForDirectWrite(join(dir, 'gone.json'), join(dir, 'also-gone.json')),
        false
      );
    }));
});

describe('isSameFileForDirectWrite on a volume with no usable inode', () => {
  // Windows can report `ino` as 0 when the volume supplies no file index. Returning false there and
  // falling back to a plain path comparison misses a symlinked --output, and the write then follows the
  // link straight through to the input while the command reports it untouched.
  function zeroInodeFs(): SameFileFs {
    return {
      statSync: (p: string) => {
        fs.statSync(p);
        return { dev: 0, ino: 0 };
      },
      realpathSync: (p: string) => fs.realpathSync(p),
      promises: {
        stat: async (p: string) => {
          await fs.promises.stat(p);
          return { dev: 0, ino: 0 };
        },
        realpath: (p: string) => fs.promises.realpath(p),
      },
    };
  }

  test('still recognizes a symlink, by falling back to realpath', () =>
    withTempDir((dir) => {
      const file = join(dir, 'a.json');
      const link = join(dir, 'link.json');
      writeFileSync(file, '{}', 'utf-8');
      symlinkSync(file, link);

      assert.equal(isSameFileForDirectWrite(file, link, zeroInodeFs()), true);
    }));

  test('still separates two different files', () =>
    withTempDir((dir) => {
      // The failure mode the guard exists for: two zeros must not make every pair look identical.
      const a = join(dir, 'a.json');
      const b = join(dir, 'b.json');
      writeFileSync(a, '{}', 'utf-8');
      writeFileSync(b, '{}', 'utf-8');

      assert.equal(isSameFileForDirectWrite(a, b, zeroInodeFs()), false);
    }));

  test('falls back in the async form too', async () =>
    withTempDir(async (dir) => {
      const file = join(dir, 'a.json');
      const link = join(dir, 'link.json');
      const other = join(dir, 'b.json');
      writeFileSync(file, '{}', 'utf-8');
      writeFileSync(other, '{}', 'utf-8');
      symlinkSync(file, link);

      assert.equal(await isSameFileForDirectWriteAsync(file, link, zeroInodeFs()), true);
      assert.equal(await isSameFileForDirectWriteAsync(file, other, zeroInodeFs()), false);
    }));
});

describe('isSameEntryForRename', () => {
  // A rename replaces a directory entry and does not follow the final component, so the question is
  // which NAME the caller reads back from — not which inode the bytes live in.
  test('is true for the same path and for a symlink alias', async () =>
    withTempDir(async (dir) => {
      const file = join(dir, 'a.json');
      const link = join(dir, 'link.json');
      writeFileSync(file, '{}', 'utf-8');
      symlinkSync(file, link);

      assert.equal(await isSameEntryForRename(file, file), true);
      assert.equal(await isSameEntryForRename(link, file), true);
    }));

  test('is FALSE for a hard link, unlike the direct-write predicate', async () =>
    withTempDir(async (dir) => {
      // The distinction this file exists for. Renaming onto `hard` repoints that one name; `file`
      // keeps its own entry on the untouched original inode, so the write is safe and must not be
      // treated as in-place — doing so made enrich refuse it with "Nothing was written".
      const file = join(dir, 'a.json');
      const hard = join(dir, 'hard.json');
      writeFileSync(file, '{}', 'utf-8');
      linkSync(file, hard);

      assert.equal(await isSameEntryForRename(hard, file), false);
      // ...while a direct write to the same path does land on the input.
      assert.equal(isSameFileForDirectWrite(hard, file), true);
    }));

  test('is false for a destination that does not exist yet', async () =>
    withTempDir(async (dir) => {
      const file = join(dir, 'a.json');
      writeFileSync(file, '{}', 'utf-8');
      assert.equal(await isSameEntryForRename(join(dir, 'new.json'), file), false);
    }));
});

describe('isSameFileForDirectWriteAsync', () => {
  test('answers as the sync version does', async () =>
    withTempDir(async (dir) => {
      const file = join(dir, 'a.json');
      const symlink = join(dir, 'link.json');
      const hard = join(dir, 'hard.json');
      const other = join(dir, 'b.json');
      writeFileSync(file, '{}', 'utf-8');
      writeFileSync(other, '{}', 'utf-8');
      symlinkSync(file, symlink);
      linkSync(file, hard);

      assert.equal(await isSameFileForDirectWriteAsync(file, symlink), true);
      assert.equal(await isSameFileForDirectWriteAsync(file, hard), true);
      assert.equal(await isSameFileForDirectWriteAsync(file, other), false);
      assert.equal(await isSameFileForDirectWriteAsync(file, join(dir, 'missing.json')), false);
    }));
});
