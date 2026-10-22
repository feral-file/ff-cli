import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import { buildPlaylistDirect } from '../main';

/**
 * BUILD_PARAMS_HELP documents the params file in `build --help`.
 *
 * The schema used to live only in docs/README.md and the agent skill, so a
 * caller working from `--help` (the first thing an agent reads) had to guess
 * requirement types. Keep it in step with validateRequirements in src/main.ts.
 */
const BUILD_PARAMS_HELP = `
Params (JSON file, or piped on stdin):
  {"requirements": [ ...one or more... ], "playlistSettings": { ... }}

Requirement types:
  query_address       What a wallet owns. ownerAddress (0x… or tz…), optional quantity (number up to 100, or "all").
                      {"type":"query_address","ownerAddress":"0x…","quantity":5}
  build_playlist      Tokens from a contract. blockchain ("ethereum" or "tezos"), contractAddress, tokenIds.
                      {"type":"build_playlist","blockchain":"ethereum","contractAddress":"0x…","tokenIds":["1","2"]}
  fetch_feed          A feed playlist by title. playlistName, optional quantity.
                      {"type":"fetch_feed","playlistName":"Unsupervised","quantity":3}
  feral_file_artwork  One Feral File artwork. artworkId (public id or /exhibitions/artwork/{id} URL).

playlistSettings (all optional):
  title, durationPerItem (seconds), preserveOrder (default true; false shuffles),
  deviceName (play on that FF1 after building)

Exit status: 1 when any requirement, or the send to deviceName, fails. The
playlist file is still saved with whatever was collected.

Example:
  echo '{"requirements":[{"type":"query_address","ownerAddress":"0x…","quantity":5}]}' | ff-cli build -o wallet.json
`;

export const buildCommand = new Command('build')
  .description('Build playlist from structured parameters (JSON file or stdin)')
  .argument('[params-file]', 'Path to JSON parameters file (or use stdin)')
  .option('-o, --output <filename>', 'Output filename for the playlist', 'playlist.json')
  .option('-v, --verbose', 'Show detailed output', false)
  .addHelpText('after', BUILD_PARAMS_HELP)
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

      const failures = result?.failures ?? [];
      if (failures.length > 0) {
        console.error(chalk.red('Not everything you asked for happened:'));
        for (const failure of failures) {
          console.error(chalk.red(`  ${failure}`));
        }
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      if (options.verbose) {
        console.error(chalk.dim((error as Error).stack));
      }
      process.exit(1);
    }
  });
