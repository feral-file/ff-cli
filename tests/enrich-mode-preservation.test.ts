/**
 * The permission mode an atomic replacement ends up carrying.
 *
 * `writePlaylistAtomically` reads the destination's mode, applies it to the replacement before any
 * bytes are written, and carries the owner and group across. The mode half of that was not actually
 * true: chown clears set-user-ID and set-group-ID — POSIX requires it of any chown by an unprivileged
 * process, and Linux does it for an executable regardless — so a chown performed AFTER the chmod threw
 * away exactly the bits that decide whether a file runs as someone else. Nothing re-applied them, and
 * nothing checked, so the replacement quietly had less privilege than the file it replaced while the
 * code's own comment said the mode was preserved.
 *
 * The order matters in both directions and the tests pin both: the first chmod cannot move after the
 * chown, because it is what keeps the enriched contents from being briefly world-readable, and a second
 * one has to follow the chown to put back what it cleared.
 *
 * The interesting case cannot be produced on a real filesystem without root — an unprivileged chown to
 * another uid fails outright, which is a different branch — so the sequence is driven through an
 * injected filesystem. The on-disk test below is the non-vacuity pair: it proves the added verification
 * does not refuse an ordinary write.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writePlaylistAtomically, type AtomicWriteFs } from '../src/commands/enrich';

const CONTENTS = '{"dpVersion":"1.1.0","title":"after"}';

interface FakeRun {
  filesystem: AtomicWriteFs;
  /** Every handle operation on the temporary file, in order. */
  calls: string[];
  /** Mode the temporary file carried when it was renamed into place, if it was. */
  renamedMode: number | null;
}

/**
 * A filesystem whose chown behaves like a real one: it succeeds and clears the setuid/setgid bits.
 *
 * `chmodMask` models a chmod that cannot set every bit it is given — a caller outside the file's group
 * cannot restore set-group-ID, and some filesystems decline it outright. Both endings are "this
 * replacement would not carry the access the original had".
 */
function fakeFilesystem(sourceMode: number, chmodMask = 0o7777): FakeRun {
  const run: FakeRun = { filesystem: null as never, calls: [], renamedMode: null };
  let temporaryMode = 0;

  const handle = {
    async chmod(mode: number) {
      run.calls.push(`chmod:${mode.toString(8)}`);
      temporaryMode = mode & chmodMask;
    },
    async chown(uid: number, gid: number) {
      run.calls.push(`chown:${uid}:${gid}`);
      // POSIX: a chown clears set-user-ID and set-group-ID.
      temporaryMode &= ~0o6000;
    },
    async stat() {
      run.calls.push('stat');
      return { mode: temporaryMode };
    },
    async writeFile() {
      run.calls.push('writeFile');
      // POSIX permits a write to a regular file by an unprivileged process to
      // clear set-user-ID and set-group-ID, and Linux does it. Same clearing as
      // chown, at the other end of the sequence.
      temporaryMode &= ~0o6000;
    },
    async sync() {
      run.calls.push('sync');
    },
    async close() {
      run.calls.push('close');
    },
  };

  run.filesystem = {
    async lstat() {
      return { isSymbolicLink: () => false };
    },
    async realpath(path: string) {
      return path;
    },
    async stat() {
      // Owned by somebody else, so the chown branch runs at all.
      return { mode: 0o100000 | sourceMode, uid: 4242, gid: 4243 };
    },
    async open(_path: string, flags: string, mode?: number) {
      if (flags === 'r') {
        // syncDirectory opening the containing directory. Deliberately records nothing: it happens
        // after the rename and is best-effort, so letting it into the sequence would only make the
        // assertion below describe something other than the permission dance it is about.
        return {
          chmod: async () => {},
          chown: async () => {},
          stat: async () => ({ mode: 0 }),
          writeFile: async () => {},
          sync: async () => {},
          close: async () => {},
        } as never;
      }
      temporaryMode = mode ?? 0;
      return handle as never;
    },
    async rm() {
      run.calls.push('rm');
    },
    async readFile() {
      return Buffer.from('');
    },
    async rename() {
      run.calls.push('rename');
      run.renamedMode = temporaryMode;
    },
  };

  return run;
}

/** Where `process` reports a POSIX identity at all — the chown branch is skipped without one. */
const posix = typeof process.getuid === 'function';

describe('an atomic replacement restores the mode a chown clears', () => {
  test(
    'the sequence is chmod, chown, chmod, and the file keeps its setuid bits',
    { skip: posix ? false : 'no POSIX uid/gid on this platform' },
    async () => {
      const sourceMode = 0o6750; // setuid + setgid + rwxr-x---
      const run = fakeFilesystem(sourceMode);

      const written = await writePlaylistAtomically(
        '/tmp/does-not-matter/playlist.json',
        CONTENTS,
        undefined,
        run.filesystem
      );

      assert.equal(written, true);

      // The whole sequence, in order. Two operations clear the setuid bits — the chown and the write
      // — and each has to be followed by a restore and a check against the inode. The first chmod
      // cannot move: it is what keeps the contents from being briefly world-readable, and that
      // window opens the moment bytes exist.
      const chmod = `chmod:${sourceMode.toString(8)}`;
      assert.deepEqual(run.calls, [
        chmod,
        'chown:4242:4243',
        chmod,
        'stat',
        'writeFile',
        chmod,
        'stat',
        'sync',
        'close',
        'rename',
      ]);

      // Said again as the two properties the order exists for, so a future reshuffle that keeps the
      // sequence plausible but breaks the point fails on something legible.
      assert.ok(
        run.calls.indexOf('stat') < run.calls.indexOf('writeFile'),
        `the mode must be verified before any bytes: ${run.calls.join(', ')}`
      );
      const afterWrite = run.calls.slice(run.calls.indexOf('writeFile') + 1);
      assert.deepEqual(
        afterWrite.slice(0, 2),
        [chmod, 'stat'],
        `the write clears the bits too, so it must be followed by a restore and a check: ${afterWrite.join(', ')}`
      );

      // And the mode that actually reached the destination is the source's, setuid bits included.
      assert.equal(run.renamedMode, sourceMode);
    }
  );

  test(
    'a mode that cannot be restored refuses the replacement instead of completing it',
    { skip: posix ? false : 'no POSIX uid/gid on this platform' },
    async () => {
      // chmod cannot set set-group-ID here, which is what a caller outside the file's group meets.
      // Silently writing a replacement without the bit is the failure this check exists to prevent.
      const run = fakeFilesystem(0o6750, ~0o2000 & 0o7777);

      await assert.rejects(
        () =>
          writePlaylistAtomically(
            '/tmp/does-not-matter/playlist.json',
            CONTENTS,
            undefined,
            run.filesystem
          ),
        (error: Error) => {
          assert.equal(error.name, 'OwnershipError');
          assert.match(error.message, /cannot preserve permissions/);
          return true;
        }
      );

      assert.equal(run.renamedMode, null, 'nothing may be renamed into place');
      assert.equal(run.calls.includes('writeFile'), false, 'no bytes may be written');
      assert.ok(run.calls.includes('rm'), 'the temporary file must be removed');
    }
  );

  test(
    'a chown that fails still refuses as an ownership problem, not a permissions one',
    { skip: posix ? false : 'no POSIX uid/gid on this platform' },
    async () => {
      // Non-vacuity for the message split: the two refusals send an operator to different places, so
      // they must not collapse into one.
      const run = fakeFilesystem(0o640);
      const filesystem: AtomicWriteFs = {
        ...run.filesystem,
        async open(path: string, flags: string, mode?: number) {
          const handle = await run.filesystem.open(path, flags, mode);
          if (flags === 'r') {
            return handle;
          }
          return {
            ...handle,
            chmod: handle.chmod.bind(handle),
            chown: async () => {
              throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
            },
            stat: handle.stat.bind(handle),
            writeFile: handle.writeFile.bind(handle),
            sync: handle.sync.bind(handle),
            close: handle.close.bind(handle),
          };
        },
      };

      await assert.rejects(
        () =>
          writePlaylistAtomically(
            '/tmp/does-not-matter/playlist.json',
            CONTENTS,
            undefined,
            filesystem
          ),
        (error: Error) => {
          assert.equal(error.name, 'OwnershipError');
          assert.match(error.message, /cannot preserve ownership/);
          return true;
        }
      );
    }
  );
});

describe('the added verification does not refuse an ordinary write', () => {
  test(
    'a real file keeps its mode through an in-place replacement',
    { skip: process.platform === 'win32' ? 'POSIX modes only' : false },
    async () => {
      // The everyday path: same owner, so no chown runs, and the mode still has to survive and pass
      // the check. Without this the verification could be refusing every write and the fakes above
      // would not notice.
      const dir = mkdtempSync(join(tmpdir(), 'ff1-enrich-mode-'));
      const file = join(dir, 'playlist.json');
      try {
        writeFileSync(file, '{"dpVersion":"1.1.0","title":"before"}', 'utf-8');
        chmodSync(file, 0o640);

        const written = await writePlaylistAtomically(file, CONTENTS);

        assert.equal(written, true);
        assert.equal(readFileSync(file, 'utf-8'), CONTENTS);
        assert.equal(statSync(file).mode & 0o7777, 0o640);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
