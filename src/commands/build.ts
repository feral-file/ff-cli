import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import { buildPlaylistDirect } from '../main';

export const buildCommand = new Command('build')
  .description('Build playlist from structured parameters (JSON file or stdin)')
  .argument('[params-file]', 'Path to JSON parameters file (or use stdin)')
  .option('-o, --output <filename>', 'Output filename for the playlist', 'playlist.json')
  .option('-v, --verbose', 'Show detailed output', false)
  .action(async (paramsFile: string | undefined, options: { output: string; verbose: boolean }) => {
    try {
      let params;

      if (paramsFile) {
        const content = await fs.readFile(paramsFile, 'utf-8');
        params = JSON.parse(content);
      } else {
        const stdin = await new Promise<string>((resolve, reject) => {
          let data = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => {
            data += chunk;
          });
          process.stdin.on('end', () => {
            resolve(data);
          });
          process.stdin.on('error', reject);
        });

        if (!stdin.trim()) {
          console.error(chalk.red('No parameters provided'));
          console.log(chalk.yellow('\nUsage:'));
          console.log('  ff-cli build params.json');
          console.log('  cat params.json | ff-cli build');
          console.log('  echo \'{"requirements":[...]}\' | ff-cli build');
          process.exit(1);
        }

        params = JSON.parse(stdin);
      }

      if (options.verbose) {
        console.log(chalk.blue('\nParameters:'));
        console.log(chalk.dim(JSON.stringify(params, null, 2)));
        console.log();
      }

      console.log(chalk.blue('\nBuild playlist from parameters\n'));

      const result = await buildPlaylistDirect(params, {
        verbose: options.verbose,
        outputPath: options.output,
      });

      if (result && result.playlist) {
        console.log(chalk.green('\nPlaylist saved'));
        console.log(chalk.dim(`  Title: ${result.playlist.title}`));
        console.log(chalk.dim(`  Items: ${result.playlist.items?.length || 0}`));
        console.log(chalk.dim(`  Output: ${options.output}\n`));
      }
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      if (options.verbose) {
        console.error(chalk.dim((error as Error).stack));
      }
      process.exit(1);
    }
  });
