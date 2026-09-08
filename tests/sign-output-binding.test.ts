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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signPlaylist, signPlaylistFile } from '../src/utilities/playlist-signer';
import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

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

  test('a refusal removes an output this call created while binding it', async () => {
    // Binding the output can create it, and a refusal must not leave a zero-byte playlist waiting at
    // the name the operator was told to avoid. Here the create succeeds and the descriptor reports the
    // input's identity, which is the shape a swap takes when it wins the race the other way.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'fresh.json');
      const originalBytes = await writeCoSigned(input, own, makeKey());
      const inputStat = fs.statSync(input);

      const confused = {
        ...fs,
        fstatSync: (fd: number) => {
          const real = fs.fstatSync(fd);
          // Report the freshly created output as though it were the input.
          return real.size === 0 ? inputStat : real;
        },
      };

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', {
          replaceSignatures: true,
          fs: confused,
        })
      );

      assert.equal(result.success, false);
      assert.match(String(result.error), /would discard/);
      assert.equal(existsSync(output), false, 'the file created while binding must be removed');
      assert.equal(readFileSync(input, 'utf-8'), originalBytes);
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

  test('an existing --output is replaced, not appended to', async () => {
    // Opening without O_TRUNC is what makes the decision safe; the truncate has to happen on the
    // proceed path or a shorter document would leave the tail of a longer one behind.
    const dir = makeTempDir();
    const own = makeKey();
    try {
      const input = join(dir, 'playlist.json');
      const output = join(dir, 'out.json');
      await writeCoSigned(input, own, makeKey());
      writeFileSync(output, 'x'.repeat(50_000), 'utf-8');

      const result = await quietly(() =>
        signPlaylistFile(input, own, output, 'curator', { replaceSignatures: true })
      );

      assert.equal(result.success, true, result.error);
      const written = readFileSync(output, 'utf-8');
      assert.doesNotMatch(written, /xxxx/, 'no tail of the previous contents may survive');
      assert.equal((JSON.parse(written) as { signatures: unknown[] }).signatures.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
