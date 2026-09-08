/**
 * `sign` decides in-place from the descriptor it will write through, not from a path it looked up.
 *
 * Checking a path and then writing to it is two lookups, and in a directory someone else can write to
 * they disagree. An `--output` that does not exist when it is checked can be a symlink to the input by
 * the time it is written: the preflight says "different file", the refusal never fires, and the write
 * follows the link into the input while the report calls it untouched — the exact outcome the refusal
 * exists to prevent, reached by a name.
 *
 * The window is not reachable from a test by timing, so it is reached by injection: the filesystem
 * these tests hand the signer behaves as it would if the swap had already happened.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signPlaylist, signPlaylistFile } from '../src/utilities/playlist-signer';
import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');
const isWindows = process.platform === 'win32';

function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ff1-bind-')));
}

function makeKey(): string {
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

/**
 * A playlist carrying a co-curator's signature that still verifies — the case an in-place run refuses,
 * because only that co-curator could produce it again.
 */
async function writeCoSigned(path: string, own: string, other: string): Promise<string> {
  const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
  const document = {
    ...base,
    curators: [
      { name: 'You', key: playlistSigningDidKey(own) },
      { name: 'Co-curator', key: playlistSigningDidKey(other) },
    ],
  };
  const signatures = [
    await signPlaylist(document, own, 'curator'),
    await signPlaylist(document, other, 'curator'),
  ];
  const bytes = JSON.stringify({ ...document, signatures }, null, 2);
  writeFileSync(path, bytes, 'utf-8');
  return bytes;
}

describe('sign binds the output before deciding', () => {
  test('an --output swapped to a symlink of the input is still refused', async () => {
    // The swap: the name is free when a path-based check would look, and resolves to the input by the
    // time the file is opened. The signer never looks by path, so the substitution changes nothing.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'out.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());

      const swapped = {
        ...fs,
        openSync: (p: string, flags: number | string, mode?: number) => {
          if (p === output) {
            if (typeof flags === 'number' && (flags & fs.constants.O_EXCL) !== 0) {
              // Something appeared at this name between the check and the open.
              throw Object.assign(new Error('file already exists'), { code: 'EEXIST' });
            }
            // ...and it is a symlink to the input, so the retry binds the input's inode.
            return fs.openSync(input, 'r+');
          }
          return fs.openSync(p, flags as never, mode);
        },
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', {
          replaceSignatures: true,
          fs: swapped,
        })
      );

      assert.equal(result.success, false);
      assert.match(String(result.error), /would discard 1 still-valid signature from other keys/);
      // The whole point: the input still holds both signatures.
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      assert.equal(existsSync(output), false, 'the refused output must not exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed write leaves the output it created, and says so, rather than unlinking a name', async () => {
    // The empty file a failure leaves behind is litter, and removing it would mean unlinking by name —
    // the one thing this function stopped trusting. Between closing the descriptor and the unlink the
    // name can be a different file, and deleting somebody else's document to tidy up after ourselves
    // is far worse than the litter. So it is left, and named, so nobody is surprised by it.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'fresh.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());

      const removals: string[] = [];
      const stalled = {
        ...fs,
        writeSync: () => 0,
        rmSync: (...args: unknown[]) => {
          removals.push('rmSync');
          return (fs.rmSync as (...a: unknown[]) => unknown)(...args);
        },
        unlinkSync: (...args: unknown[]) => {
          removals.push('unlinkSync');
          return (fs.unlinkSync as (...a: unknown[]) => unknown)(...args);
        },
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true, fs: stalled })
      );

      assert.equal(result.success, false);
      // Nothing is removed by name, ever.
      assert.deepEqual(removals, [], 'no file may be unlinked by name on the failure path');
      // The file it created is still there, empty, and the message says so.
      assert.equal(existsSync(output), true);
      assert.equal(readFileSync(output, 'utf-8'), '');
      assert.match(String(result.error), /An incomplete output may remain at/);
      assert.ok(String(result.error).includes(output));
      // And the input is untouched.
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a refusal on a pre-existing output makes no claim about leftovers', async () => {
    // Nothing was created, so there is nothing to warn about — and saying so anyway would train people
    // to ignore the sentence in the case where it matters.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      await writeCoSigned(input, own, makeKey());

      const result = await quietly(() =>
        signPlaylistFile(input, own, undefined, 'curator', { replaceSignatures: true })
      );

      assert.equal(result.success, false);
      assert.match(String(result.error), /would discard/);
      assert.doesNotMatch(String(result.error), /incomplete output may remain/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the input is never truncated before the decision is made', async () => {
    // Ordering, not outcome: a truncation that happens before the refusal has already destroyed the
    // file, whatever the exit status says afterwards.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());

      let truncated = false;
      const watching = {
        ...fs,
        ftruncateSync: (fd: number, len: number) => {
          truncated = true;
          return fs.ftruncateSync(fd, len);
        },
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, undefined, 'curator', {
          replaceSignatures: true,
          fs: watching,
        })
      );

      assert.equal(result.success, false);
      assert.equal(truncated, false, 'nothing may be truncated on the refusing path');
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a short write is an error, not a signed playlist', async () => {
    // write(2) may write fewer bytes than asked; that is the contract, not a fault. Ignoring the return
    // value left a partial document on disk under a "Playlist signed" report — the failure the operator
    // cannot see, because the command told them it worked. This runs right after the truncate, so the
    // partial file is all there is.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'out.json');
      await writeCoSigned(input, own, makeKey());

      // Accepts 10 bytes at a time, so a single call can never finish the document.
      const trickle = {
        ...fs,
        writeSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
          fs.writeSync(fd, buffer, offset, Math.min(length, 10), position),
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true, fs: trickle })
      );

      assert.equal(result.success, true, result.error);
      // Every byte has to arrive, however many calls it took.
      const written = readFileSync(output, 'utf-8');
      assert.equal(
        JSON.stringify(result.playlist, null, 2),
        written,
        'the file must hold the whole document'
      );
      assert.equal((JSON.parse(written) as { signatures: unknown[] }).signatures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a descriptor that stops accepting bytes fails loudly', async () => {
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'out.json');
      await writeCoSigned(input, own, makeKey());

      const stalled = {
        ...fs,
        writeSync: () => 0,
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true, fs: stalled })
      );

      assert.equal(result.success, false, 'a zero-byte write must not report success');
      assert.match(String(result.error), /Wrote only 0 of \d+ bytes/);
      assert.match(String(result.error), /incomplete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    'a source replaced while the command runs is not overwritten',
    { skip: isWindows },
    async () => {
      // The document, its signatures and the decision about what may be discarded all describe the file
      // that was READ. A replacement by rename leaves the path pointing at a new inode, so applying that
      // reasoning would truncate a document nothing here has looked at.
      //
      // The playlist has only the signer's own signature, so an in-place run would ordinarily proceed —
      // isolating the freshness check as the thing that stops it.
      //
      // Skipped on Windows, where the scenario cannot arise: renaming over a file with an open handle
      // fails with EPERM, and this command holds the source open for exactly that span. The protection
      // the test asserts is enforced by the operating system there rather than by the check below, so
      // the setup fails before the assertion is reached. The in-place-rewrite variant that follows does
      // run everywhere — Windows permits that one, and it is the failure the descriptor itself catches.
      const dir = makeTempDir();
      const own = makeKey();
      try {
        const input = join(dir, 'playlist.json');
        const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
        const document = { ...base, curators: [{ name: 'You', key: playlistSigningDidKey(own) }] };
        const signature = await signPlaylist(document, own, 'curator');
        writeFileSync(
          input,
          JSON.stringify({ ...document, signatures: [signature] }, null, 2),
          'utf-8'
        );

        // Swap the file after it has been read, before the output is bound to it. Hooked on the open,
        // because that is the point in the sequence the race occupies — and because identity is no
        // longer consulted, there is no stat left to hook.
        const replacement = '{"dpVersion":"1.1.0","title":"someone else\'s document"}';
        let opens = 0;
        const replacing = {
          ...fs,
          openSync: (p: string, flags: number | string, mode?: number) => {
            opens += 1;
            if (opens === 2) {
              const staging = join(dir, 'staging.json');
              writeFileSync(staging, replacement, 'utf-8');
              fs.renameSync(staging, input);
            }
            return fs.openSync(p, flags as never, mode);
          },
        };

        const result = await quietly(() =>
          signPlaylistFile(input, own, undefined, 'curator', {
            replaceSignatures: true,
            fs: replacing,
          })
        );

        assert.equal(result.success, false, 'the replacement must not be overwritten');
        // Under the content rule this is simply a destination holding a document that was never read.
        // No identity check is involved, and none could have helped: a stat taken before the write
        // says nothing about what the write lands on. The descriptor's bytes are the whole answer.
        assert.match(String(result.error), /is not the playlist being signed/);
        assert.match(String(result.error), /--force/);
        // The document that arrived is untouched: it was never what this run reasoned about.
        assert.equal(readFileSync(input, 'utf-8'), replacement);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test('a source rewritten in place while the command runs is not overwritten', async () => {
    // The other shape: same inode, different bytes. The held descriptor cannot see a rename, and it is
    // the only thing that can see this — so both checks exist and neither covers the other.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = { ...base, curators: [{ name: 'You', key: playlistSigningDidKey(own) }] };
      const signature = await signPlaylist(document, own, 'curator');
      writeFileSync(
        input,
        JSON.stringify({ ...document, signatures: [signature] }, null, 2),
        'utf-8'
      );

      let opens = 0;
      const rewriting = {
        ...fs,
        openSync: (p: string, flags: number | string, mode?: number) => {
          opens += 1;
          if (opens === 2) {
            // Rewritten in place: the inode is unchanged, the contents are not — which is the only
            // thing that matters now.
            writeFileSync(input, '{"dpVersion":"1.1.0","title":"edited by someone else"}', 'utf-8');
          }
          return fs.openSync(p, flags as never, mode);
        },
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, undefined, 'curator', {
          replaceSignatures: true,
          fs: rewriting,
        })
      );

      assert.equal(result.success, false);
      assert.match(String(result.error), /is not the playlist being signed/);
      assert.equal(
        readFileSync(input, 'utf-8'),
        '{"dpVersion":"1.1.0","title":"edited by someone else"}'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a same-length rewrite is refused where timestamps are coarse', async () => {
    // The case metadata cannot see, reproduced rather than approximated. Plenty of filesystems record
    // mtime to the second, so an edit landing in the same second as the read is ordinary — and with
    // the length unchanged, size and mtime both match while every byte has changed. The stats here are
    // floored to the second to be that filesystem; the digest is the only thing left that can answer.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = { ...base, curators: [{ name: 'You', key: playlistSigningDidKey(own) }] };
      const signature = await signPlaylist(document, own, 'curator');
      const originalBytes = JSON.stringify({ ...document, signatures: [signature] }, null, 2);
      writeFileSync(input, originalBytes, 'utf-8');

      const rewritten = 'x'.repeat(originalBytes.length);
      const toSecond = <T extends { mtimeMs: number }>(stat: T): T => ({
        ...stat,
        mtimeMs: Math.floor(stat.mtimeMs / 1000) * 1000,
      });

      let opens = 0;
      const coarse = {
        ...fs,
        statSync: (p: string) => toSecond(fs.statSync(p)),
        fstatSync: (fd: number) => toSecond(fs.fstatSync(fd)),
        openSync: (p: string, flags: number | string, mode?: number) => {
          opens += 1;
          if (opens === 2) {
            // Same length, same second, different bytes.
            writeFileSync(input, rewritten, 'utf-8');
          }
          return fs.openSync(p, flags as never, mode);
        },
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, undefined, 'curator', {
          replaceSignatures: true,
          fs: coarse,
        })
      );

      assert.equal(result.success, false, 'a same-length rewrite must not slip past');
      assert.match(String(result.error), /is not the playlist being signed/);
      assert.equal(readFileSync(input, 'utf-8'), rewritten);

      // The premise: on this filesystem the metadata is identical, so nothing but the contents could
      // have told. Asserted rather than assumed, or the test would pass for the wrong reason.
      assert.equal(coarse.statSync(input).size, originalBytes.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an ordinary in-place sign works where the filesystem reports no identities', async () => {
    // Refusing on a missing inode made `sign <file>` unusable on such a filesystem for every run, not
    // only the dangerous ones. Nothing unrecoverable is discarded here, so the digest is the whole
    // check and it has everything it needs.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = { ...base, curators: [{ name: 'You', key: playlistSigningDidKey(own) }] };
      const signature = await signPlaylist(document, own, 'curator');
      writeFileSync(
        input,
        JSON.stringify({ ...document, signatures: [signature] }, null, 2),
        'utf-8'
      );

      const anonymous = {
        ...fs,
        fstatSync: (fd: number) => ({ ...fs.fstatSync(fd), dev: 0, ino: 0 }),
        statSync: (p: string) => ({ ...fs.statSync(p), dev: 0, ino: 0 }),
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, undefined, 'curator', {
          replaceSignatures: true,
          fs: anonymous,
        })
      );

      assert.equal(result.success, true, result.error);
      const onDisk = JSON.parse(readFileSync(input, 'utf-8')) as { signatures: unknown[] };
      assert.equal(onDisk.signatures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a fresh --output works where the filesystem reports no identities', async () => {
    // An exclusive create proves the file is new: the source was already open, so the name was free
    // and this inode cannot be it. No comparison is needed, which matters because the comparison is
    // unavailable here — and refusing would have blocked the exact path the refusal tells people to
    // take, leaving an empty file behind as it went.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'out.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());

      const anonymous = {
        ...fs,
        fstatSync: (fd: number) => ({ ...fs.fstatSync(fd), dev: 0, ino: 0 }),
        statSync: (p: string) => ({ ...fs.statSync(p), dev: 0, ino: 0 }),
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', {
          replaceSignatures: true,
          fs: anonymous,
        })
      );

      assert.equal(result.success, true, result.error);
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      assert.equal(
        (JSON.parse(readFileSync(output, 'utf-8')) as { signatures: unknown[] }).signatures.length,
        1
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pre-existing output holding another document is refused, identities or not', async () => {
    // Zero inodes everywhere, and it changes nothing: identity is not consulted at all now. The
    // destination holds bytes that are not the signed document, which is the whole of the answer.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'out.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());
      writeFileSync(output, 'something that was already here', 'utf-8');

      const anonymous = {
        ...fs,
        fstatSync: (fd: number) => ({ ...fs.fstatSync(fd), dev: 0, ino: 0 }),
        statSync: (p: string) => ({ ...fs.statSync(p), dev: 0, ino: 0 }),
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', {
          replaceSignatures: true,
          fs: anonymous,
        })
      );

      assert.equal(result.success, false);
      assert.match(String(result.error), /is not the playlist being signed/);
      assert.match(String(result.error), /--force/);
      // Neither file is touched.
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      assert.equal(readFileSync(output, 'utf-8'), 'something that was already here');
      // Nothing was created, so no leftover is claimed.
      assert.doesNotMatch(String(result.error), /incomplete output may remain/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    'a dangling --output symlink has its target created and written',
    { skip: isWindows },
    async () => {
      // O_EXCL refuses to follow a symlink, so the exclusive create returns EEXIST for a link that
      // points at nothing. Retrying without O_CREAT then followed the link to a file that does not
      // exist and failed ENOENT — turning the documented safe path into an error for anyone whose
      // output name is a symlink into another directory. The retry keeps O_CREAT.
      const dir = makeTempDir();
      const own = makeKey();
      try {
        const input = join(dir, 'playlist.json');
        const target = join(dir, 'target.json');
        const link = join(dir, 'out.json');
        const originalBytes = await writeCoSigned(input, own, makeKey());
        symlinkSync(target, link); // target does not exist yet

        const result = await quietly(() =>
          signPlaylistFile(input, own, link, 'curator', { replaceSignatures: true })
        );

        assert.equal(result.success, true, result.error);
        // The link's target is what got created and written.
        assert.equal(existsSync(target), true);
        assert.equal(
          (JSON.parse(readFileSync(target, 'utf-8')) as { signatures: unknown[] }).signatures
            .length,
          1
        );
        assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test(
    'an --output symlink pointing at the input is still refused',
    { skip: isWindows },
    async () => {
      // The other half of the same retry: keeping O_CREAT must not make the link a way past the
      // refusal. The descriptor it binds is the input's, and the identity check runs on the descriptor.
      const dir = makeTempDir();
      const own = makeKey();
      try {
        const input = join(dir, 'playlist.json');
        const link = join(dir, 'out.json');
        const originalBytes = await writeCoSigned(input, own, makeKey());
        symlinkSync(input, link);

        const result = await quietly(() =>
          signPlaylistFile(input, own, link, 'curator', { replaceSignatures: true })
        );

        assert.equal(result.success, false, 'a link to the input is the input');
        assert.match(String(result.error), /would discard 1 still-valid signature from other keys/);
        assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test(
    'a write-only destination that already exists is refused with the reason',
    { skip: isWindows },
    async () => {
      // A deliberate loss, stated rather than hidden. The destination is read back before it is
      // destroyed — that read IS the safety rule — so a pre-existing file this process cannot read is no
      // longer a usable target. The errno alone would read like a bug, so it says what the rule is.
      const dir = makeTempDir();
      const own = makeKey();
      try {
        const input = join(dir, 'playlist.json');
        const output = join(dir, 'out.json');
        await writeCoSigned(input, own, makeKey());
        writeFileSync(output, 'existing', 'utf-8');
        fs.chmodSync(output, 0o200);

        const result = await quietly(() =>
          signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true })
        );

        fs.chmodSync(output, 0o600);
        assert.equal(result.success, false);
        assert.match(String(result.error), /needs read permission/);
        assert.match(String(result.error), /new name/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test('a newly created destination needs no read permission', async () => {
    // The O_EXCL path stays O_WRONLY, because a file this call just created holds nothing to read.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'out.json');
      await writeCoSigned(input, own, makeKey());

      const flags: number[] = [];
      const recording = {
        ...fs,
        openSync: (p: string, f: number | string, mode?: number) => {
          if (p === output && typeof f === 'number') {
            flags.push(f);
          }
          return fs.openSync(p, f as never, mode);
        },
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true, fs: recording })
      );

      assert.equal(result.success, true, result.error);
      assert.equal(flags.length, 1, 'the exclusive create must have succeeded outright');
      assert.equal(
        (flags[0] & fs.constants.O_RDWR) === fs.constants.O_RDWR,
        false,
        'a created output must not ask for read access'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a byte-identical copy at --output is refused, with advice that fits', async () => {
    // Without identity a copy and an alias are the same thing — the bytes are all there is — so the
    // refusal has to stand. What can change is the advice: telling someone who already passed --output
    // to "write it elsewhere" is not advice, it is what they did.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const copy = join(dir, 'out.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());
      // A separate file, same bytes: a plain `cp`.
      writeFileSync(copy, originalBytes, 'utf-8');

      const result = await quietly(() =>
        signPlaylistFile(input, own, copy, 'curator', { replaceSignatures: true })
      );

      assert.equal(result.success, false);
      assert.match(String(result.error), /holds the same document as the input/);
      // The two ways out, both of which work.
      assert.match(String(result.error), /delete it and re-run/);
      assert.match(String(result.error), /another\s+--output name/);
      // And the one that does not.
      assert.match(String(result.error), /--force does not override this/);

      // Neither file is touched.
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      assert.equal(readFileSync(copy, 'utf-8'), originalBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a copy holding only your own signature is written, not refused', async () => {
    // The refusal protects signatures only their holder could remake. Nothing here is in that
    // position, so there is nothing to protect and the copy is simply written — and the input, being a
    // separate file, is not touched either way.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const copy = join(dir, 'out.json');
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = { ...base, curators: [{ name: 'You', key: playlistSigningDidKey(own) }] };
      const signature = await signPlaylist(document, own, 'curator');
      const originalBytes = JSON.stringify({ ...document, signatures: [signature] }, null, 2);
      writeFileSync(input, originalBytes, 'utf-8');
      writeFileSync(copy, originalBytes, 'utf-8');

      const result = await quietly(() =>
        signPlaylistFile(input, own, copy, 'curator', { replaceSignatures: true })
      );

      assert.equal(result.success, true, result.error);
      // No --force was needed, and nothing claims a foreign document was replaced.
      assert.equal(result.overwroteAnother, false);
      // Only the copy moved.
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      assert.equal(
        (JSON.parse(readFileSync(copy, 'utf-8')) as { signatures: unknown[] }).signatures.length,
        1
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a copy whose other signature no longer verifies is written, not refused', async () => {
    // The second half of the same rule. A co-curator's entry is there, but the document was edited
    // after it was made, so it does not verify — and an entry that cannot be checked could not have
    // been restored from this file either. Nothing recoverable is at stake.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const copy = join(dir, 'out.json');
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const other = makeKey();
      const document = {
        ...base,
        curators: [
          { name: 'You', key: playlistSigningDidKey(own) },
          { name: 'Co-curator', key: playlistSigningDidKey(other) },
        ],
      };
      const signatures = [
        await signPlaylist(document, own, 'curator'),
        await signPlaylist(document, other, 'curator'),
      ];
      // Edited after signing: neither entry verifies against these bytes any more.
      const originalBytes = JSON.stringify(
        { ...document, title: 'Edited after signing', signatures },
        null,
        2
      );
      writeFileSync(input, originalBytes, 'utf-8');
      writeFileSync(copy, originalBytes, 'utf-8');

      const result = await quietly(() =>
        signPlaylistFile(input, own, copy, 'curator', { replaceSignatures: true })
      );

      assert.equal(result.success, true, result.error);
      assert.equal(result.overwroteAnother, false);
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      assert.equal(
        (JSON.parse(readFileSync(copy, 'utf-8')) as { signatures: unknown[] }).signatures.length,
        1
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--force does not override the same-document refusal', async () => {
    // The line between the two refusals. --force replaces a document the operator has decided to
    // discard; it is not a way to destroy a signature only its holder could make again, and a flag
    // that did both would be indistinguishable from the second at the moment it mattered.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const copy = join(dir, 'out.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());
      writeFileSync(copy, originalBytes, 'utf-8');

      const result = await quietly(() =>
        signPlaylistFile(input, own, copy, 'curator', { replaceSignatures: true, force: true })
      );

      assert.equal(result.success, false, 'force must not reach this branch');
      assert.match(String(result.error), /holds the same document as the input/);
      assert.equal(readFileSync(copy, 'utf-8'), originalBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deleting the copy is advice that works', async () => {
    // The remedy is asserted, not just printed: a name that does not exist takes the O_EXCL path and
    // is written with no check at all.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const copy = join(dir, 'out.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());

      const result = await quietly(() =>
        signPlaylistFile(input, own, copy, 'curator', { replaceSignatures: true })
      );

      assert.equal(result.success, true, result.error);
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      assert.equal(
        (JSON.parse(readFileSync(copy, 'utf-8')) as { signatures: unknown[] }).signatures.length,
        1
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--force is what allows overwriting a document that was never read', async () => {
    // Without it the destination is left alone and the operator picks a name; with it the overwrite is
    // deliberate, and the report names the file, because that line is the only record the other
    // document existed.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'someone-elses.json');
      await writeCoSigned(input, own, makeKey());
      writeFileSync(output, '{"dpVersion":"1.1.0","title":"not mine"}', 'utf-8');

      const refused = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true })
      );
      assert.equal(refused.success, false);
      assert.match(String(refused.error), /is not the playlist being signed/);
      assert.match(String(refused.error), /--force/);
      assert.equal(
        readFileSync(output, 'utf-8'),
        '{"dpVersion":"1.1.0","title":"not mine"}',
        'the refusal must leave it alone'
      );

      const forced = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true, force: true })
      );
      assert.equal(forced.success, true, forced.error);
      assert.equal(forced.overwroteAnother, true);
      assert.equal(
        (JSON.parse(readFileSync(output, 'utf-8')) as { signatures: unknown[] }).signatures.length,
        1
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--force is not needed, and claims nothing, when the destination is the signed document', async () => {
    // The in-place case is not an overwrite of somebody else's work, so it must not be reported as one.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
      const document = { ...base, curators: [{ name: 'You', key: playlistSigningDidKey(own) }] };
      const signature = await signPlaylist(document, own, 'curator');
      writeFileSync(
        input,
        JSON.stringify({ ...document, signatures: [signature] }, null, 2),
        'utf-8'
      );

      const result = await quietly(() =>
        signPlaylistFile(input, own, undefined, 'curator', { replaceSignatures: true })
      );

      assert.equal(result.success, true, result.error);
      assert.equal(result.inPlace, true);
      assert.equal(result.overwroteAnother, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an ordinary --output to a new file still writes, and leaves the input alone', async () => {
    // Non-vacuity: the binding must not turn every run into a refusal.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'out.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true })
      );

      assert.equal(result.success, true, result.error);
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
      const written = JSON.parse(readFileSync(output, 'utf-8')) as { signatures: unknown[] };
      assert.equal(written.signatures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an existing --output is replaced, not appended to, under --force', async () => {
    // Opening without O_TRUNC is what makes the decision safe; the truncate has to happen on the
    // proceed path or a shorter document would leave the tail of a longer one behind. --force is what
    // authorizes destroying a document this command never read.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'out.json');
      await writeCoSigned(input, own, makeKey());
      writeFileSync(output, 'x'.repeat(50_000), 'utf-8');

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true, force: true })
      );

      assert.equal(result.success, true, result.error);
      assert.equal(result.overwroteAnother, true, 'the report must name what --force destroyed');
      const written = readFileSync(output, 'utf-8');
      assert.doesNotMatch(written, /xxxx/, 'no tail of the previous contents may survive');
      assert.equal((JSON.parse(written) as { signatures: unknown[] }).signatures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
