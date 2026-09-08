/**
 * Decide whether two paths name the same file, by filesystem identity rather than by string.
 *
 * Every "am I about to overwrite my own input?" check in this repo is really a question about inodes,
 * and answering it with paths gets two cases wrong in the same direction — the dangerous one.
 *
 * A resolved-path comparison misses a **hard link**: two directory entries, one inode, and no amount of
 * normalizing either name reveals it. A `realpath` comparison additionally handles symlinks but still
 * misses hard links, because `realpath` resolves symbolic indirection only. In both cases the code
 * concludes "different files", skips whatever protection it owed the input, and then writes through to
 * the very inode it believed it was leaving alone.
 *
 * `dev` + `ino` is the identity the filesystem itself uses, and `stat` follows symlinks, so one
 * comparison covers both cases.
 *
 * Windows is why this is not simply `dev`/`ino`. Node exposes `ino` there from the file index, but it
 * can be `0` when the underlying volume does not supply one — and two zeros would make every pair of
 * files look identical, which is this same bug with the sign flipped and no way to notice. So an inode
 * match counts only when the inode is real, and the path comparison stays as an independent sufficient
 * condition rather than being replaced by it.
 */

import fs from 'fs';
import path from 'path';

/** True when both stats carry a usable inode and name the same file. */
function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  if (left.ino === 0 || right.ino === 0) {
    return false;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * isSameFileSync reports whether `a` and `b` are the same file on disk.
 *
 * A path that does not exist is not the same file as anything: an `--output` naming a file yet to be
 * created is the ordinary "write somewhere else" case, and must not be mistaken for the in-place one.
 *
 * @param a - First path
 * @param b - Second path
 * @returns True when the two names resolve to one file
 */
export function isSameFileSync(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) {
    return true;
  }
  try {
    return sameInode(fs.statSync(a), fs.statSync(b));
  } catch {
    // One of them does not exist, or cannot be stat'ed. Either way there is no identity to establish.
    return false;
  }
}

/**
 * isSameFile is {@link isSameFileSync} for callers already working asynchronously.
 *
 * @param a - First path
 * @param b - Second path
 * @returns True when the two names resolve to one file
 */
export async function isSameFile(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) {
    return true;
  }
  try {
    const [left, right] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
    return sameInode(left, right);
  } catch {
    return false;
  }
}
