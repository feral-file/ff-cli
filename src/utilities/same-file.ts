/**
 * "Would renaming onto this destination replace the file the caller read?"
 *
 * One predicate, for one caller. `enrich` writes a temp file and renames it over the destination, and
 * `rename()` does not follow the final component — so onto a hard link it repoints that one name and
 * leaves the input's own name on the untouched original inode. A hard-link destination is a genuinely
 * distinct output there, and treating it as in-place makes enrich's stale-input guard refuse a write
 * that was never unsafe.
 *
 * There used to be an inode-identity predicate here too, for `sign`, which writes directly rather than
 * by rename. It is gone, and deliberately: identity answers "is this the same file", when the question
 * `sign` actually has is "are these the same bytes". A path can be re-pointed between any two calls, so
 * no amount of stat comparison can promise that the thing about to be truncated is the thing that was
 * read — while comparing contents through the descriptor being written can, and does. That check lives
 * in playlist-signer.js, where the bytes are.
 */

import nodeFs from 'fs';
import path from 'path';

/** The filesystem operations this predicate needs. Injectable for tests. */
export interface SameFileFs {
  promises: {
    realpath: (p: string) => Promise<string>;
  };
}

/**
 * isSameEntryForRename reports whether renaming onto `a` would replace the name `b` is read from.
 *
 * True for the same path and for a symlink alias — both cases where the caller reads back changed
 * content at the name they gave, since `writePlaylistAtomically` resolves a symlink to its target
 * before replacing. Deliberately **false** for a hard link, because a rename repoints one directory
 * entry and leaves the other name on the original inode.
 *
 * @param a - Destination of the rename
 * @param b - Path whose contents matter
 * @param fsLike - Filesystem operations, for tests
 * @returns True when the rename would replace what `b` names
 */
export async function isSameEntryForRename(
  a: string,
  b: string,
  fsLike: SameFileFs = nodeFs as unknown as SameFileFs
): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) {
    return true;
  }
  try {
    const [left, right] = await Promise.all([
      fsLike.promises.realpath(a),
      fsLike.promises.realpath(b),
    ]);
    return left === right;
  } catch {
    return false;
  }
}
