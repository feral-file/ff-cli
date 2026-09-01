import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import {
  enrichPlaylistManifests,
  type Dp1Playlist,
  type SkippedItem,
  type TokenLookup,
} from '../utilities/enrich-playlist';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNFTTokenInfoBatch } = require('../utilities/nft-indexer');

interface EnrichOptions {
  output?: string;
  force: boolean;
  verbose: boolean;
}

/**
 * SKIP_COPY explains each skip in the operator's terms rather than the code's.
 * `no-provenance` is the one a person can act on, so it says what to add.
 */
const SKIP_COPY: Record<SkippedItem['reason'], string> = {
  'already-labelled': 'already has a manifest (use --force to replace)',
  'no-provenance': 'no provenance.contract chain/address/tokenId to look up',
  // The indexer drops unresolved tokens from its response rather than
  // reporting why, so there is no per-item reason to relay here.
  'not-indexed': 'the indexer returned nothing for it',
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
      if (result.enriched > 0) {
        await fs.writeFile(destination, JSON.stringify(result.playlist, null, 2));
      }

      console.log(
        result.enriched > 0
          ? chalk.green(`\n${result.enriched} of ${total} item(s) enriched`)
          : chalk.yellow('\nNothing to enrich')
      );
      if (result.enriched > 0) {
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
