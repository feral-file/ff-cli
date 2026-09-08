import { Command } from 'commander';
import chalk from 'chalk';
import { selectFeedServer } from './helpers/feed-server';
import { createPrompt, promptYesNo } from './helpers/prompt';

/**
 * `ff-cli unpublish <id-or-url>` — delete a playlist this key owns from a feed.
 *
 * The delete is irreversible in a way most deletes are not: the feed tombstones the id, so the playlist
 * cannot be restored and the id can never be reused. Hence the confirmation, which shows the title and
 * server first, and defaults to no. `-y` skips it for scripts; without a terminal and without `-y` the
 * command refuses rather than assuming consent.
 */
export const unpublishCommand = new Command('unpublish')
  .description('Delete a playlist from a feed server (signed delete; owner key required)')
  .argument('<id-or-url>', 'Playlist id, slug, or feed URL')
  .option('-s, --server <index>', 'Feed server index (use this if multiple servers configured)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option(
    '-k, --key <privateKey>',
    'Ed25519 private key that signs the delete authorization (overrides config)'
  )
  .action(async (idOrUrl: string, options: { server?: string; yes?: boolean; key?: string }) => {
    try {
      console.log(chalk.blue('\nUnpublish playlist\n'));

      const { getFeedConfig } = await import('../config.js');
      const { unpublishPlaylist, fetchPlaylistForUnpublish } = await import(
        '../utilities/playlist-unpublisher.js'
      );

      const feedConfig = getFeedConfig();
      const selection = await selectFeedServer(feedConfig.baseURLs, {
        serverArg: options.server,
        nonInteractive: !!options.yes,
      });
      if (!selection.ok) {
        console.error(chalk.red(`\n${selection.error}`));
        if (selection.detail) {
          console.log(chalk.yellow(selection.detail));
        }
        console.log();
        process.exit(1);
      }

      if (!options.yes) {
        if (!process.stdin.isTTY) {
          console.error(chalk.red('\nRefusing to delete without confirmation'));
          console.log(
            chalk.yellow('  This session has no terminal to confirm on. Pass -y to proceed.\n')
          );
          process.exit(1);
        }

        // Show what is about to go before asking. A bare id says nothing about which playlist it is, and
        // the answer cannot be taken back. A lookup failure is not fatal here: the delete path repeats
        // the fetch and reports it properly, so the prompt just falls back to the identifier.
        let label = idOrUrl;
        try {
          const stored = await fetchPlaylistForUnpublish(idOrUrl, selection.url);
          const title = typeof stored.title === 'string' ? stored.title : '';
          label = title ? `"${title}" (${stored.id ?? idOrUrl})` : String(stored.id ?? idOrUrl);
        } catch {
          label = idOrUrl;
        }

        console.log(chalk.yellow(`  ${label}`));
        console.log(chalk.dim(`  Server: ${selection.url}`));
        console.log(
          chalk.dim('  This cannot be undone; the id is tombstoned and cannot be reused.')
        );
        console.log();

        const prompt = createPrompt();
        const confirmed = await promptYesNo(prompt.ask, 'Delete this playlist?', false);
        prompt.close();
        console.log();

        if (!confirmed) {
          console.log(chalk.dim('Cancelled.\n'));
          return;
        }
      }

      const result = await unpublishPlaylist(idOrUrl, selection.url, { privateKey: options.key });

      if (result.success) {
        console.log(chalk.green('Unpublished'));
        if (result.playlistId) {
          console.log(chalk.dim(`  Playlist ID: ${result.playlistId}`));
        }
        if (result.slug) {
          console.log(chalk.dim(`  Slug: ${result.slug}`));
        }
        console.log(chalk.dim(`  Server: ${result.feedServer}`));
        if (result.message) {
          console.log(chalk.dim(`  Status: ${result.message}`));
        }
        console.log();
        return;
      }

      console.error(chalk.red('\nUnpublish failed'));
      if (result.error) {
        console.error(chalk.red(`  ${result.error}`));
      }
      if (result.message) {
        console.log(chalk.yellow(`\n${result.message}`));
      }
      console.log();
      process.exit(1);
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });
