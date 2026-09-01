import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, basename, join } from 'path';
import {
  enrichPlaylistManifests,
  type Dp1Playlist,
  type SkippedItem,
  type TokenLookup,
} from '../utilities/enrich-playlist';
import { validatePlaylist } from '../utilities/playlist-verifier';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNFTTokenInfoBatch } = require('../utilities/nft-indexer');

interface EnrichOptions {
  output?: string;
  force: boolean;
  verbose: boolean;
}

/**
 * writePlaylistAtomically replaces a file only once the new bytes are safely on
 * disk.
 *
 * The default destination is the input file, and a plain write truncates it
 * first. Enrichment runs after a lookup that can take minutes while the indexer
 * warms tokens, so the window between truncation and a complete write is a
 * window in which an interruption, a full disk, or an I/O error leaves the
 * curator with an empty or half-written playlist and no copy of what they had.
 * A rename within the same directory is atomic, so the original file survives
 * intact until the replacement is complete.
 *
 * The temporary file is created alongside the destination rather than in the
 * system temp directory: rename is only atomic within a filesystem, and those
 * are not guaranteed to be the same one.
 */
async function writePlaylistAtomically(destination: string, contents: string): Promise<void> {
  // Follow a symlink to its target before replacing anything. rename() would
  // replace the link itself, silently detaching a playlist that other paths
  // reach through that name while reporting success.
  let target = destination;
  const existing = await fs.lstat(destination).catch(() => null);
  if (existing?.isSymbolicLink()) {
    target = await fs.realpath(destination);
  }

  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  );
  try {
    await fs.writeFile(temporary, contents);
    // A new file gets the default creation mode, so replacing a playlist a
    // curator had restricted to 0600 would quietly publish it as 0644.
    const current = await fs.stat(target).catch(() => null);
    if (current) {
      await fs.chmod(temporary, current.mode & 0o7777);
    }
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * reportInvalid prints structural validation diagnostics and exits non-zero.
 *
 * Enrichment refuses to work on a document DP-1 rejects, and refuses to write
 * one. Writing an invalid playlist would replace the operator's file with
 * something sign, publish, and play all reject later, having reported success.
 */
function reportInvalid(
  stage: string,
  result: { error?: string; details?: Array<{ path: string; message: string }> }
): never {
  console.error(chalk.red(`\n${stage}`));
  if (result.error) {
    console.error(chalk.dim(`  ${result.error}`));
  }
  for (const detail of result.details ?? []) {
    console.error(chalk.dim(`  ${detail.path}: ${detail.message}`));
  }
  console.error(chalk.dim('\n  The file was left unchanged.\n'));
  process.exit(1);
}

/**
 * SKIP_COPY explains each skip in the operator's terms rather than the code's.
 * `no-provenance` is the one a person can act on, so it says what to add.
 */
const SKIP_COPY: Record<SkippedItem['reason'], string> = {
  'already-labelled': 'already has a manifest (use --force to replace)',
  'external-ref': 'carries an external ref, which outranks an inline manifest',
  'no-provenance': 'no provenance.contract chain/address/tokenId to look up',
  // The indexer drops unresolved tokens from its response rather than
  // reporting why, so there is no per-item reason to relay here.
  'not-indexed': 'the indexer returned nothing for it',
  'no-metadata': 'the indexer resolved it but has no artist, description, or still image',
};

export const enrichCommand = new Command('enrich')
  .description('Add missing artist, title, and thumbnail metadata to a playlist')
  .argument('<file>', 'Path to the DP-1 playlist file')
  .option('-o, --output <filename>', 'Write here instead of overwriting the input')
  .option('--force', 'Replace manifests that already exist', false)
  .option('-v, --verbose', 'Show detailed output', false)
  .action(async (file: string, options: EnrichOptions) => {
    try {
      console.log(chalk.blue('\nEnrich playlist\n'));

      const playlist = JSON.parse(await fs.readFile(file, 'utf-8')) as Dp1Playlist;
      const total = Array.isArray(playlist.items) ? playlist.items.length : 0;
      if (total === 0) {
        console.error(chalk.red('That playlist has no items.'));
        process.exit(1);
      }

      // Validate before spending minutes on indexer lookups for a document
      // that was never going to be writable.
      const before = await validatePlaylist(playlist);
      if (!before.valid) {
        reportInvalid('That playlist is not valid DP-1:', before);
      }

      // Warming previously-unseen tokens can take minutes, so a human watching
      // this needs to see it move. Matches the progress line `find` prints.
      let printedProgress = false;
      const onProgress = (done: number, count: number): void => {
        printedProgress = true;
        process.stdout.write(chalk.dim(`\r  ${done}/${count} looked up...`));
      };

      // getNFTTokenInfoBatch is (tokens, duration, onProgress) — the second
      // positional is DP-1 display seconds, not the callback. Enrichment never
      // sets duration (the curator's timing is not ours to touch), so it is
      // passed undefined and the callback goes third. find.ts carries the same
      // warning; getting this wrong silently returns unusable results.
      const lookup: TokenLookup = (tokens, onProgressCallback) =>
        getNFTTokenInfoBatch(tokens, undefined, onProgressCallback);

      const result = await enrichPlaylistManifests(playlist, lookup, {
        force: options.force,
        onProgress,
      });
      if (printedProgress) {
        process.stdout.write('\n');
      }

      const destination = options.output ?? file;
      // --output names a file the caller expects to find afterwards, so it is
      // written even when nothing was enriched. Overwriting the input on a
      // no-op would be pure risk for no gain, so that case still writes
      // nothing.
      const shouldWrite = result.enriched > 0 || options.output !== undefined;
      if (shouldWrite) {
        // Re-validate the enriched candidate. An inline manifest is schema-
        // checked the same way a fetched one is (playlists extension §3.6), so
        // a malformed manifest from the indexer must not reach the file.
        const after = await validatePlaylist(result.playlist);
        if (!after.valid) {
          reportInvalid('Enrichment produced an invalid playlist:', after);
        }
        await writePlaylistAtomically(destination, JSON.stringify(result.playlist, null, 2));
      }

      console.log(
        result.enriched > 0
          ? chalk.green(`\n${result.enriched} of ${total} item(s) enriched`)
          : chalk.yellow('\nNothing to enrich')
      );
      if (shouldWrite) {
        console.log(chalk.dim(`  Output: ${destination}`));
      }

      if (result.skipped.length > 0) {
        const shown = options.verbose ? result.skipped : result.skipped.slice(0, 10);
        console.log(chalk.dim(`\n  Skipped ${result.skipped.length}:`));
        for (const skip of shown) {
          console.log(chalk.dim(`    ${skip.title} — ${SKIP_COPY[skip.reason]}`));
        }
        if (shown.length < result.skipped.length) {
          console.log(
            chalk.dim(`    ...and ${result.skipped.length - shown.length} more (-v to list)`)
          );
        }
      }

      // Say this loudly. A signed playlist that silently lost its envelope
      // fails at the device, which is the worst place to discover it.
      if (result.signatureInvalidated) {
        console.log(chalk.yellow('\n  Signature removed — the document changed.'));
        console.log(chalk.dim(`  Re-sign before playing: ff-cli sign ${destination}`));
      }
      console.log();
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      if (options.verbose) {
        console.error(chalk.dim((error as Error).stack));
      }
      process.exit(1);
    }
  });
