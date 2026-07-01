import { Command } from 'commander';
import chalk from 'chalk';

// playlist-signer is still CommonJS; require keeps the interop simple.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { signPlaylistFile } = require('../utilities/playlist-signer');

export const signCommand = new Command('sign')
  .description('Sign a DP-1 playlist file with a DP-1 signature envelope')
  .argument('<file>', 'Path to the playlist file to sign')
  .option('-k, --key <privateKey>', 'Ed25519 private key in base64 format (overrides config)')
  .option('-r, --role <role>', 'DP-1 signing role (overrides config)')
  .option('-o, --output <file>', 'Output file path (defaults to overwriting input file)')
  .action(async (file: string, options: { key?: string; role?: string; output?: string }) => {
    try {
      console.log(chalk.blue('\nSign playlist\n'));

      const result = await signPlaylistFile(file, options.key, options.output, options.role);

      if (result.success) {
        console.log(chalk.green('\nPlaylist signed'));
        if (Array.isArray(result.playlist?.signatures)) {
          console.log(chalk.dim(`  Signatures: ${result.playlist.signatures.length}`));
        } else if (result.playlist?.signature) {
          console.log(chalk.dim(`  Signature: ${result.playlist.signature.substring(0, 30)}...`));
        }
        console.log();
      } else {
        console.error(chalk.red('\nSign failed:'), result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });
