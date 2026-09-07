import { Command } from 'commander';
import chalk from 'chalk';
import { createPrompt } from './helpers/prompt';

export const publishCommand = new Command('publish')
  .description('Publish a playlist to a feed server')
  .argument('<file>', 'Path to the playlist file')
  .option('-s, --server <index>', 'Feed server index (use this if multiple servers configured)')
  .action(async (file: string, options: { server?: string }) => {
    try {
      console.log(chalk.blue('\nPublish playlist\n'));

      const { getFeedConfig } = await import('../config');
      const { publishPlaylist } = await import('../utilities/playlist-publisher');

      const feedConfig = getFeedConfig();

      if (!feedConfig.baseURLs || feedConfig.baseURLs.length === 0) {
        console.error(chalk.red('\nNo feed servers configured'));
        console.log(chalk.yellow('  Add feed server URLs to config.json: feed.baseURLs\n'));
        process.exit(1);
      }

      let serverUrl = feedConfig.baseURLs[0];

      if (feedConfig.baseURLs.length > 1) {
        if (!options.server) {
          console.log(chalk.yellow('Multiple feed servers found. Select one:'));
          console.log();
          feedConfig.baseURLs.forEach((url, index) => {
            console.log(chalk.cyan(`  ${index}: ${url}`));
          });
          console.log();

          const prompt = createPrompt();
          const selection = await prompt.ask('Select server (0-based index): ');
          prompt.close();
          console.log();

          options.server = selection;
        }

        const serverIndex = parseInt(options.server || '0', 10);
        if (isNaN(serverIndex) || serverIndex < 0 || serverIndex >= feedConfig.baseURLs.length) {
          console.error(chalk.red('\nInvalid server index'));
          process.exit(1);
        }

        serverUrl = feedConfig.baseURLs[serverIndex];
      }

      const result = await publishPlaylist(file, serverUrl);

      if (result.success) {
        console.log(chalk.green('Published'));
        if (result.playlistId) {
          console.log(chalk.dim(`  Playlist ID: ${result.playlistId}`));
        }
        console.log(chalk.dim(`  Server: ${result.feedServer}`));
        if (result.message) {
          console.log(chalk.dim(`  Status: ${result.message}`));
        }
        console.log();
      } else {
        console.error(chalk.red('\nPublish failed'));
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
