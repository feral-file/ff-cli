/**
 * Filesystem identity, which every "am I overwriting my own input?" check in this repo depends on.
 *
 * The two cases worth pinning are the ones a path comparison gets wrong in the dangerous direction: a
 * symlink, and a hard link. Both name one inode under two paths, and code that concludes "different
 * files" skips whatever protection it owed the input and then writes straight through it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSameFile, isSameFileSync } from '../src/utilities/same-file';

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

describe('isSameFileSync', () => {
  test('recognizes the same path, however it is spelled', () =>
    withTempDir((dir) => {
      const file = join(dir, 'a.json');
      writeFileSync(file, '{}', 'utf-8');
      assert.equal(isSameFileSync(file, file), true);
      assert.equal(isSameFileSync(file, join(dir, '.', 'a.json')), true);
      assert.equal(isSameFileSync(file, join(dir, 'sub', '..', 'a.json')), true);
    }));

  test('recognizes a symlink to the file', () =>
    withTempDir((dir) => {
      const file = join(dir, 'a.json');
      const link = join(dir, 'link.json');
      writeFileSync(file, '{}', 'utf-8');
      symlinkSync(file, link);
      assert.equal(isSameFileSync(file, link), true);
    }));

  test('recognizes a hard link to the file', () =>
    withTempDir((dir) => {
      // The case realpath cannot see: two directory entries, one inode, two distinct real paths.
      const file = join(dir, 'a.json');
      const link = join(dir, 'hard.json');
      writeFileSync(file, '{}', 'utf-8');
      linkSync(file, link);
      assert.equal(isSameFileSync(file, link), true);
    }));

  test('separates two genuinely different files, including identical copies', () =>
    withTempDir((dir) => {
      const a = join(dir, 'a.json');
      const b = join(dir, 'b.json');
      writeFileSync(a, '{}', 'utf-8');
      writeFileSync(b, '{}', 'utf-8');
      assert.equal(isSameFileSync(a, b), false);
    }));

  test('treats a path that does not exist as a different file', () =>
    withTempDir((dir) => {
      // An --output naming a file yet to be created is the ordinary "write elsewhere" case, and must
      // not be mistaken for the in-place one.
      const file = join(dir, 'a.json');
      writeFileSync(file, '{}', 'utf-8');
      assert.equal(isSameFileSync(file, join(dir, 'not-yet.json')), false);
      assert.equal(isSameFileSync(join(dir, 'gone.json'), join(dir, 'also-gone.json')), false);
    }));
});

describe('isSameFile', () => {
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

      assert.equal(await isSameFile(file, symlink), true);
      assert.equal(await isSameFile(file, hard), true);
      assert.equal(await isSameFile(file, other), false);
      assert.equal(await isSameFile(file, join(dir, 'missing.json')), false);
    }));
});
