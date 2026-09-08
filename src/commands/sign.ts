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
          // Name every discarded entry, not just the count, and separate the ones that cost
          // something from the ones that do not.
          //
          // Your own earlier signature is free: this command replaces it. Another key's entry that
          // still verifies is free too — the payload excludes signatures, so re-signing an unchanged
          // document invalidates nothing, and that entry is merely removed from this file. Only an
          // entry that no longer verifies is a real loss, and only its holder can restore it.
          //
          // Roles are carried through rather than assumed. A document may hold `agent`,
          // `institution`, or `licensor` entries, and asking their holders to come back as `curator`
          // would be wrong. A `feed` role is not special-cased either: any key can emit one and this
          // CLI has no feed identity to check a kid against.
          const dropped: Array<{
            kind: string;
            role: string | null;
            kid: string | null;
            valid: boolean;
            label: string;
          }> = result.dropped ?? [];
          if (dropped.length > 0) {
            const plural = dropped.length === 1 ? '' : 's';
            console.log(chalk.dim(`  Replaced ${dropped.length} existing signature${plural}:`));
            for (const entry of dropped) {
              console.log(chalk.dim(`    - ${entry.label}`));
            }

            const lost = dropped.filter((entry) => entry.kind === 'other' && !entry.valid);
            const removedStillValid = dropped.filter(
              (entry) => entry.kind === 'other' && entry.valid
            );

            if (lost.length > 0) {
              const noun = lost.length === 1 ? 'signature is' : 'signatures are';
              console.log(
                chalk.yellow(
                  `  ${lost.length} other ${noun} now void — a signature covers the content, and the content changed.\n` +
                    `  Only their holders can restore them, by signing the edited document:`
                )
              );
              for (const entry of lost) {
                const who = entry.kid ? `...${entry.kid.slice(-8)}` : 'the holder';
                const role = entry.role ?? 'their role';
                console.log(chalk.yellow(`    ask ${who} to sign again as ${role}`));
              }
              console.log(
                chalk.yellow(
                  `  Signing appends, so they can add to this file without disturbing your signature.`
                )
              );
            }

            if (removedStillValid.length > 0) {
              const noun = removedStillValid.length === 1 ? 'signature' : 'signatures';
              console.log(
                chalk.yellow(
                  `  ${removedStillValid.length} other ${noun} still verified over this content and ` +
                    `was removed anyway.\n` +
                    `  Keep a copy of the previous file if you want ${removedStillValid.length === 1 ? 'it' : 'them'} back — nothing invalidated ${removedStillValid.length === 1 ? 'it' : 'them'}.`
                )
              );
            }

            // Stated as the general fact it is, not as a claim about any entry above: this CLI cannot
            // tell which key a feed actually signs with.
            console.log(
              chalk.dim(`  A feed appends its own signature again after it verifies a replacement.`)
            );
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
