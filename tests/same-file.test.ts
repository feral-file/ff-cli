/**
 * The rename predicate, which is the only "same file?" question left in the codebase.
 *
 * A rename replaces a directory entry and does not follow the final component, so a hard-link
 * destination is genuinely distinct — answering that with inode identity makes a safe write look
 * unsafe, and made enrich refuse a write that was never at risk.
 *
 * There used to be an inode predicate here for `sign`, which writes directly. It is gone: identity
 * cannot answer the question a destructive write actually has, because a path can be re-pointed
 * between any two syscalls. `sign` compares contents through the descriptor it writes instead.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSameEntryForRename } from '../src/utilities/same-file';

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
    }));

  test('is false for a destination that does not exist yet', async () =>
    withTempDir(async (dir) => {
      const file = join(dir, 'a.json');
      writeFileSync(file, '{}', 'utf-8');
      assert.equal(await isSameEntryForRename(join(dir, 'new.json'), file), false);
    }));
});
