import { Command } from 'commander';
import chalk from 'chalk';
import { selectFeedServer } from './helpers/feed-server';

/**
 * `ff-cli fetch <id-or-url>` — save a published playlist as the document to edit.
 *
 * Editing a published playlist has to start from the stored document: `--replace` requires the `id`,
 * `slug`, and `created` to equal the stored row's, and rebuilding with `find` or `build` mints new ones.
 * Nothing in the CLI produced that starting file, so the recovery advice pointed at `verify`, which only
 * validates and prints a summary — it neither prints nor saves the JSON. That left the documented
 * edit → re-sign → replace loop starting with a `curl` the CLI could do itself.
 *
 * Writing the file is the point, so `-o` is the normal form; without it the document goes to stdout for
 * piping, and every status line goes to stderr so the two never mix.
 */
export const fetchCommand = new Command('fetch')
  .description('Save a published playlist from a feed server (the starting point for --replace)')
  .argument('<id-or-url>', 'Playlist id, slug, or feed URL')
  .option('-s, --server <index>', 'Feed server index (use this if multiple servers configured)')
  .option('-o, --output <file>', 'Write the playlist here (defaults to stdout)')
  .action(async (idOrUrl: string, options: { server?: string; output?: string }) => {
    try {
      console.error(chalk.blue('\nFetch playlist\n'));

      const { getFeedConfig } = await import('../config.js');
      const { fetchStoredPlaylist, resolvePlaylistIdentifier } = await import(
        '../utilities/feed-mutation.js'
      );

      const feedConfig = getFeedConfig();
      const selection = await selectFeedServer(feedConfig.baseURLs, { serverArg: options.server });
      if (!selection.ok) {
        console.error(chalk.red(selection.error));
        if (selection.detail) {
          console.error(chalk.yellow(selection.detail));
        }
        console.error();
        process.exit(1);
      }

      const identifier = resolvePlaylistIdentifier(idOrUrl);
      if (!identifier) {
        console.error(chalk.red('No playlist id or URL was given\n'));
        process.exit(1);
      }

      let stored;
      try {
        stored = await fetchStoredPlaylist(selection.url, identifier);
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status === 404) {
          console.error(chalk.red(`\nNo playlist ${identifier} on ${selection.url}`));
          console.error(
            chalk.yellow(
              '  Either the id or slug is wrong for this feed, or the playlist was deleted.\n' +
                '  Deleted ids are tombstoned and are never served again.\n'
            )
          );
        } else {
          console.error(chalk.red('\nFetch failed:'), (error as Error).message);
          console.error();
        }
        process.exit(1);
      }

      // Two spaces, matching what `sign` and `build` write, so a fetched document and a locally built
      // one produce the same diff shape when both are edited by hand.
      const document = `${JSON.stringify(stored, null, 2)}\n`;

      if (!options.output) {
        process.stdout.write(document);
        console.error(chalk.green('Fetched'));
        console.error(chalk.dim(`  Server: ${selection.url}`));
        console.error();
        return;
      }

      const fs = await import('fs');
      fs.writeFileSync(options.output, document, 'utf-8');

      console.error(chalk.green('Fetched'));
      console.error(chalk.dim(`  Playlist ID: ${stored.id ?? identifier}`));
      if (typeof stored.title === 'string') {
        console.error(chalk.dim(`  Title: ${stored.title}`));
      }
      console.error(chalk.dim(`  Server: ${selection.url}`));
      console.error(chalk.dim(`  Saved to: ${options.output}`));
      console.error();
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });
