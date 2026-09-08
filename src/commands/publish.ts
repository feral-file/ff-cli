import { Command } from 'commander';
import chalk from 'chalk';
import { selectFeedServer } from './helpers/feed-server';

export const publishCommand = new Command('publish')
  .description('Publish a playlist to a feed server')
  .argument('<file>', 'Path to the playlist file')
  .option('-s, --server <index>', 'Feed server index (use this if multiple servers configured)')
  .option(
    '--replace',
    'Replace the playlist already stored under this document id, instead of creating a new one'
  )
  .action(async (file: string, options: { server?: string; replace?: boolean }) => {
    try {
      console.log(chalk.blue(options.replace ? '\nReplace playlist\n' : '\nPublish playlist\n'));

      const { getFeedConfig } = await import('../config.js');
      const { publishPlaylist, replacePlaylist } = await import(
        '../utilities/playlist-publisher.js'
      );

      const feedConfig = getFeedConfig();
      const selection = await selectFeedServer(feedConfig.baseURLs, { serverArg: options.server });
      if (!selection.ok) {
        console.error(chalk.red(`\n${selection.error}`));
        if (selection.detail) {
          console.log(chalk.yellow(selection.detail));
        }
        console.log();
        process.exit(1);
      }

      // A create is never silently upgraded to a replace. They are different writes — a create fails
      // loudly on a duplicate id, a replace overwrites a published document — and an operator who typed
      // neither flag meant the safe one.
      const result = options.replace
        ? await replacePlaylist(file, selection.url)
        : await publishPlaylist(file, selection.url);

      if (result.success) {
        console.log(chalk.green(options.replace ? 'Replaced' : 'Published'));
        if (result.playlistId) {
          console.log(chalk.dim(`  Playlist ID: ${result.playlistId}`));
        }
        console.log(chalk.dim(`  Server: ${result.feedServer}`));
        if (result.message) {
          console.log(chalk.dim(`  Status: ${result.message}`));
        }
        console.log();
      } else {
        console.error(chalk.red(options.replace ? '\nReplace failed' : '\nPublish failed'));
        if (result.error) {
          console.error(chalk.red(`  ${result.error}`));
        }
        if (result.message) {
          console.log(chalk.yellow(`\n${result.message}`));
        }
        console.log();
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });
