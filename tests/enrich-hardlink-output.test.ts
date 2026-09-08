/**
 * `enrich -o <hard link of the input>` must write, and must leave the input alone.
 *
 * This pins the pairing of a predicate with a write, which is the part that went wrong: the inode
 * predicate was shared with this command on the assumption that "same file" means one thing everywhere.
 * It does not. `writePlaylistAtomically` renames a temp file over the destination, and `rename()` does
 * not follow the final component — so onto a hard link it repoints that one name and leaves the input's
 * own name on the original inode. Treating that as in-place passed the stale-input digest, which then
 * refused a write that was never unsafe with "Nothing was written".
 *
 * The two lines under test are the ones at the command's call site, reproduced here rather than driven
 * through the CLI, because reaching them for real needs an indexer lookup over the network.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writePlaylistAtomically } from '../src/commands/enrich';
import { isSameEntryForRename } from '../src/utilities/same-file';

const ORIGINAL = '{"dpVersion":"1.1.0","title":"before"}';
const ENRICHED = '{"dpVersion":"1.1.0","title":"after"}';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ff1-enrich-link-'));
}

/** The command's decision, verbatim: pass the digest only when the rename replaces the input's name. */
async function writeAsCommandWould(
  destination: string,
  file: string,
  originalDigest: string
): Promise<boolean> {
  return writePlaylistAtomically(
    destination,
    ENRICHED,
    (await isSameEntryForRename(destination, file)) ? originalDigest : undefined
  );
}

describe('enrich --output as a link of the input', () => {
  test('a hard link is a distinct output: the write succeeds and the input is untouched', async () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      const hard = join(dir, 'out.json');
      writeFileSync(file, ORIGINAL, 'utf-8');
      linkSync(file, hard);

      // Digest taken before the "lookup", as the command does.
      const originalDigest = createHash('sha256').update(ORIGINAL).digest('hex');
      // ...and the input is edited while the lookup runs.
      writeFileSync(file, '{"dpVersion":"1.1.0","title":"edited by someone else"}', 'utf-8');

      const wrote = await writeAsCommandWould(hard, file, originalDigest);

      assert.equal(wrote, true, 'a hard-link destination must not be refused as a stale input');
      assert.equal(readFileSync(hard, 'utf-8'), ENRICHED);
      // The concurrent edit survives: the rename repointed `out.json` only.
      assert.equal(
        readFileSync(file, 'utf-8'),
        '{"dpVersion":"1.1.0","title":"edited by someone else"}'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a symlink IS the input: a concurrent edit still refuses the write', async () => {
    // The other half, and why the predicate is realpath equality rather than "never in place":
    // writePlaylistAtomically resolves a symlink to its target before replacing, so the input really
    // is overwritten through that name — the guard has to fire.
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      const link = join(dir, 'out.json');
      writeFileSync(file, ORIGINAL, 'utf-8');
      symlinkSync(file, link);

      const originalDigest = createHash('sha256').update(ORIGINAL).digest('hex');
      writeFileSync(file, '{"dpVersion":"1.1.0","title":"edited by someone else"}', 'utf-8');

      const wrote = await writeAsCommandWould(link, file, originalDigest);

      assert.equal(wrote, false, 'the concurrent edit must not be discarded');
      assert.equal(
        readFileSync(file, 'utf-8'),
        '{"dpVersion":"1.1.0","title":"edited by someone else"}'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unchanged input is still replaced in place', async () => {
    // Non-vacuity: the guard must refuse a stale input, not every in-place write.
    const dir = makeTempDir();
    try {
      const file = join(dir, 'playlist.json');
      writeFileSync(file, ORIGINAL, 'utf-8');
      const originalDigest = createHash('sha256').update(ORIGINAL).digest('hex');

      const wrote = await writeAsCommandWould(file, file, originalDigest);

      assert.equal(wrote, true);
      assert.equal(readFileSync(file, 'utf-8'), ENRICHED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
