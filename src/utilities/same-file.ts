/**
 * "Am I about to destroy my own input?" — answered separately for the two ways this CLI writes files.
 *
 * There is no single correct answer, and merging these two predicates is the mistake this file exists
 * to prevent. What counts as "the same file" depends entirely on how the write lands.
 *
 * **A direct write** (`sign`, writing to `--output`) opens the path and writes through it. It follows
 * symlinks, and a hard link is the same inode by definition, so both aliases carry the bytes back to
 * the input. The right question is inode identity.
 *
 * **A rename** (`enrich`, writing a temp file and renaming it over the destination) replaces a
 * *directory entry*. `rename()` does not follow the final component, so renaming onto a hard link
 * repoints that one name and leaves the input's own name pointing at the untouched original inode — a
 * hard-link destination is a genuinely distinct output there. The right question is which name the
 * caller will read back from, which is `realpath` equality.
 *
 * Getting this backwards is harmful in both directions. Using the rename predicate for a direct write
 * misses hard links and overwrites the input while reporting it untouched. Using the inode predicate
 * for a rename flags a safe write as in-place, and enrich's stale-input guard then refuses it with
 * "Nothing was written" — a refusal with nothing behind it.
 *
 * Windows is why the inode path has a fallback. Node exposes `ino` there from the file index, but it
 * can be `0` when the volume supplies none, and two zeros would make every pair of files look
 * identical. An inode match therefore counts only when the inode is real; when it is not, the question
 * degrades to `realpath` equality — which still catches symlinks, and loses only hard links, on the one
 * platform where hard links are rare and inode identity was unavailable anyway.
 */

import nodeFs from 'fs';
import path from 'path';

/**
 * The filesystem operations these predicates need.
 *
 * Injectable because the interesting cases — a zero inode, a stat that fails — are properties of the
 * filesystem rather than of this code, and cannot be produced on demand from a test otherwise.
 */
export interface SameFileFs {
  statSync: (p: string) => { dev: number; ino: number };
  realpathSync: (p: string) => string;
  promises: {
    stat: (p: string) => Promise<{ dev: number; ino: number }>;
    realpath: (p: string) => Promise<string>;
  };
}

/** True when both stats name the same file by inode. */
function sameInode(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** True when either stat lacks a real inode, so inode identity cannot be established. */
function inodeUnavailable(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number }
): boolean {
  return left.ino === 0 || right.ino === 0;
}

/** Cheap check both predicates share: the same name, however it is spelled. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * isSameFileForDirectWrite reports whether writing to `a` would modify the bytes of `b`.
 *
 * Use this before an `open`/`write` that targets a path the caller also read from. It is true for the
 * same path, for a symlink alias, and for a hard link, because a direct write reaches the inode through
 * all three.
 *
 * A path that cannot be stat-ed is not the same file as anything: an `--output` naming a file yet to be
 * created is the ordinary write-elsewhere case, and must not be mistaken for the in-place one.
 *
 * @param a - Path about to be written
 * @param b - Path whose contents matter
 * @param fsLike - Filesystem operations, for tests
 * @returns True when a direct write to `a` lands on `b`
 */
export function isSameFileForDirectWrite(
  a: string,
  b: string,
  fsLike: SameFileFs = nodeFs as unknown as SameFileFs
): boolean {
  if (samePath(a, b)) {
    return true;
  }
  try {
    const left = fsLike.statSync(a);
    const right = fsLike.statSync(b);
    if (inodeUnavailable(left, right)) {
      // No usable inode. Fall back to realpath, which still resolves symlinks — otherwise a symlinked
      // --output on such a volume reads as a separate file while the write follows the link straight
      // through to the input.
      return fsLike.realpathSync(a) === fsLike.realpathSync(b);
    }
    return sameInode(left, right);
  } catch {
    return false;
  }
}

/**
 * isSameFileAsOpenDescriptor answers {@link isSameFileForDirectWrite} for an output already opened.
 *
 * Deciding from a path and then writing to that path is two lookups, and a shared directory is where
 * they disagree: a `--output` that does not exist when it is checked can be a symlink to the input by
 * the time it is written, so the preflight says "different file", nothing refuses, and the write
 * follows the link straight through the input while the report calls it untouched. Binding the output
 * to a descriptor first and judging *that* removes the window — the fd cannot be re-pointed.
 *
 * The output's stat comes from `fstat` on the bound descriptor; only the source is looked up by name,
 * and it is the file this call is protecting rather than the one being written.
 *
 * @param outputStat - `fstatSync` of the descriptor the write will use
 * @param outputPath - The name that descriptor was opened from, for the zero-inode fallback
 * @param sourcePath - Path whose contents matter
 * @param fsLike - Filesystem operations, for tests
 * @returns True when writing through the descriptor lands on `sourcePath`
 */
export function isSameFileAsOpenDescriptor(
  outputStat: { dev: number; ino: number },
  outputPath: string,
  sourcePath: string,
  fsLike: SameFileFs = nodeFs as unknown as SameFileFs
): boolean {
  if (samePath(outputPath, sourcePath)) {
    return true;
  }
  try {
    const source = fsLike.statSync(sourcePath);
    if (inodeUnavailable(outputStat, source)) {
      // No usable inode, so fall back to names as the path-taking form does. This is the one branch
      // that cannot benefit from the descriptor, and it is also the one platform where the symlink
      // swap it guards against is least available.
      return fsLike.realpathSync(outputPath) === fsLike.realpathSync(sourcePath);
    }
    return sameInode(outputStat, source);
  } catch {
    return false;
  }
}

/** {@link isSameFileForDirectWrite}, for callers already working asynchronously. */
export async function isSameFileForDirectWriteAsync(
  a: string,
  b: string,
  fsLike: SameFileFs = nodeFs as unknown as SameFileFs
): Promise<boolean> {
  if (samePath(a, b)) {
    return true;
  }
  try {
    const [left, right] = await Promise.all([fsLike.promises.stat(a), fsLike.promises.stat(b)]);
    if (inodeUnavailable(left, right)) {
      const [leftReal, rightReal] = await Promise.all([
        fsLike.promises.realpath(a),
        fsLike.promises.realpath(b),
      ]);
      return leftReal === rightReal;
    }
    return sameInode(left, right);
  } catch {
    return false;
  }
}

/**
 * isSameEntryForRename reports whether renaming onto `a` would replace the name `b` is read from.
 *
 * Use this before a temp-file-plus-rename write. It is true for the same path and for a symlink alias —
 * both cases where the caller reads back changed content at the name they gave — and deliberately
 * **false** for a hard link, because a rename repoints one directory entry and leaves the other name on
 * the original inode.
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
  if (samePath(a, b)) {
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
