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
  .option(
    '--replace-signatures',
    'Discard the existing signatures and sign fresh (use after editing a signed playlist)'
  )
  .action(
    async (
      file: string,
      options: { key?: string; role?: string; output?: string; replaceSignatures?: boolean }
    ) => {
      try {
        console.log(chalk.blue('\nSign playlist\n'));

        const result = await signPlaylistFile(file, options.key, options.output, options.role, {
          replaceSignatures: !!options.replaceSignatures,
        });

        if (result.success) {
          console.log(chalk.green('\nPlaylist signed'));
          // Name every discarded entry, not just the count. Dropping your own earlier signature costs
          // nothing — this command replaces it. Dropping the feed's costs nothing either; it co-signs
          // again after verifying the replacement. Dropping another key's endorsement is the one that
          // cannot be recovered without asking that person to sign again, and the owner of a co-curated
          // playlist has to see which ones those were BEFORE they publish the replacement, not after
          // someone notices their name is missing.
          const dropped: Array<{ kind: string; label: string }> = result.dropped ?? [];
          if (dropped.length > 0) {
            const plural = dropped.length === 1 ? '' : 's';
            console.log(chalk.dim(`  Replaced ${dropped.length} existing signature${plural}:`));
            for (const entry of dropped) {
              console.log(chalk.dim(`    - ${entry.label}`));
            }

            const endorsements = dropped.filter((entry) => entry.kind === 'other').length;
            if (endorsements > 0) {
              // Only this class needs an action, so only this class gets a line about one.
              const noun = endorsements === 1 ? 'endorsement is' : 'endorsements are';
              console.log(
                chalk.yellow(
                  `  ${endorsements} ${noun} now void — a signature covers the content, and the content changed.\n` +
                    `  Ask those curators to sign the edited document if you want them back:\n` +
                    `    ff-cli sign <file> -r curator --key <their key>\n` +
                    `  Signing appends, so they can add to this file without disturbing your signature.`
                )
              );
            }
          }
          if (Array.isArray(result.playlist?.signatures)) {
            console.log(chalk.dim(`  Signatures: ${result.playlist.signatures.length}`));
          } else if (result.playlist?.signature) {
            console.log(chalk.dim(`  Signature: ${result.playlist.signature.substring(0, 30)}...`));
          }
          console.log();
        } else {
          console.error(chalk.red('\nSign failed:'), result.error);
          // The one failure whose remedy is not obvious: appending to an edited document can never
          // verify, because the earlier entries cover bytes that moved. Say so where it happens,
          // rather than leaving the operator to conclude their key is wrong.
          if (
            !options.replaceSignatures &&
            /verification failed|not verifiable/i.test(String(result.error))
          ) {
            console.log(
              chalk.yellow(
                '\nIf you edited this playlist after it was signed, the existing signatures no longer\n' +
                  '  cover it, and signing again cannot repair them — signing appends. Sign fresh instead:\n' +
                  `    ff-cli sign ${file} -r curator --replace-signatures\n` +
                  '  That discards every existing entry, including any feed signature, and signs the\n' +
                  '  document as it stands now. It is the path a feed replace expects.'
              )
            );
          }
          process.exit(1);
        }
      } catch (error) {
        console.error(chalk.red('\nError:'), (error as Error).message);
        process.exit(1);
      }
    }
  );
