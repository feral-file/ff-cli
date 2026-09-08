/**
 * The `--replace-signatures` transcripts in docs/EXAMPLES.md, checked against the real command.
 *
 * Those blocks drifted silently once already: a change to how a discarded signature is classified left
 * the docs describing an entry as "replaced" that the command now reports as an unverified claim, and
 * showing a count of two where it prints three. Nothing failed, because nothing compared them.
 *
 * `scripts/check-copy.js` cannot catch this — it lints banned spellings inside `src/` string literals
 * and never reads the docs. So the comparison lives here: build the documented situation, run the
 * command, and diff its output against the block the docs show.
 *
 * The `kid` fragments and the output path are generated fresh every run, so both sides are normalized
 * before comparison. Everything that carries meaning — the labels, the counts, the ordering, the
 * explanation — is compared verbatim.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { signPlaylist } from '../src/utilities/playlist-signer';
import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');
const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');
const examplesPath = join(projectRoot, 'docs/EXAMPLES.md');
const isWindows = process.platform === 'win32';

function makeKey(): string {
  return generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
}

/**
 * Reduce a transcript to the part that carries meaning.
 *
 * Key fragments and the saved-to path differ every run and between machines; the labels, counts and
 * ordering do not, and those are what a reader relies on.
 */
function normalize(text: string): string[] {
  const lines = text.split('\n');
  // Start at the standalone summary heading, not the "✓ Playlist signed and saved to:" line above it,
  // whose path is a temp directory in one and a placeholder in the other.
  const start = lines.findIndex((line) => line.trim() === 'Playlist signed');
  assert.notEqual(start, -1, `no "Playlist signed" summary in:\n${text}`);
  return lines
    .slice(start)
    .map((line) =>
      line
        .replace(/\.\.\.[A-Za-z0-9]{8}/g, '...KID')
        // The backup path is absolute and resolved — it has to be, since it may not sit beside the
        // name the operator typed — so it differs per machine while its presence and wording do not.
        .replace(
          /Backup written to \S+\.before-resign\.json/,
          'Backup written to <PATH>.before-resign.json'
        )
        .trimEnd()
    )
    .filter((line) => line.trim().length > 0);
}

/** Pull the fenced block from EXAMPLES.md that contains `marker`. */
function documentedBlock(marker: string): string {
  const doc = readFileSync(examplesPath, 'utf-8');
  const blocks = doc.split('```');
  const found = blocks.filter(
    (block) => block.includes(marker) && block.includes('Playlist signed')
  );
  assert.equal(found.length, 1, `expected exactly one documented block containing ${marker}`);
  return found[0];
}

/** Build a two-curator playlist, optionally with a feed co-signature, and write it to `path`. */
async function writeSigned(
  path: string,
  keys: { own: string; other: string; feed?: string },
  edited: boolean
): Promise<void> {
  const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
  const document = {
    ...base,
    curators: [
      { name: 'You', key: playlistSigningDidKey(keys.own) },
      { name: 'Co-curator', key: playlistSigningDidKey(keys.other) },
    ],
  };
  const signatures = [
    await signPlaylist(document, keys.own, 'curator'),
    await signPlaylist(document, keys.other, 'curator'),
  ];
  if (keys.feed) {
    signatures.push(await signPlaylist({ ...document, signatures }, keys.feed, 'feed'));
  }
  // Editing after signing is what makes every entry stop verifying — the documented situation.
  const finished = edited
    ? { ...document, title: 'Edited after publishing', signatures }
    : { ...document, signatures };
  writeFileSync(path, JSON.stringify(finished, null, 2), 'utf-8');
}

/** Invoked with a bare filename from the file's own directory, as the documented examples are. */
function runSign(dir: string, file: string, key: string): string {
  const result = spawnSync(
    process.execPath,
    [tsxCli, cliEntry, 'sign', file, '-r', 'curator', '-k', key, '--replace-signatures'],
    { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  return `${result.stdout ?? ''}`;
}

describe('EXAMPLES transcripts match the command', () => {
  test('the edited-document report is what the docs show', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff1-doc-drift-'));
    try {
      const own = makeKey();
      const file = join(dir, 'playlist.json');
      await writeSigned(file, { own, other: makeKey(), feed: makeKey() }, true);

      const actual = normalize(runSign(dir, 'playlist.json', own));
      const documented = normalize(documentedBlock('claiming your key'));

      assert.deepEqual(actual, documented);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the unchanged-document report is what the docs show', { skip: isWindows }, async () => {
    // Skipped on Windows: that scenario writes an owner-only backup, which cannot be promised there, so
    // the command refuses instead. The documented transcript is the POSIX one, and the docs say so.
    const dir = mkdtempSync(join(tmpdir(), 'ff1-doc-drift-'));
    try {
      const own = makeKey();
      const file = join(dir, 'unchanged.json');
      await writeSigned(file, { own, other: makeKey() }, false);

      const actual = normalize(runSign(dir, 'unchanged.json', own));
      const documented = normalize(documentedBlock('still valid over this content'));

      assert.deepEqual(actual, documented);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
