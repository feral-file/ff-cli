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
          // Name every discarded entry, and say only what was actually checked.
          //
          // Your own earlier signature is free: this command replaces it. For the rest the only
          // establishable fact is whether the entry verifies against the document as it stands —
          // "void" would assert it verified against the PREVIOUS content, which was edited in place
          // and exists nowhere by the time this runs. A failed verification is equally consistent
          // with an edit, with a tampered entry, and with one that was never valid, so it is reported
          // as unverified rather than diagnosed.
          //
          // Roles are carried through rather than assumed: a document may hold `agent`,
          // `institution`, or `licensor` entries, and a `feed` role is not special-cased because any
          // key can emit one and this CLI has no feed identity to check a kid against.
          const dropped: Array<{
            kind: string;
            role: string | null;
            kid: string | null;
            verified: boolean;
            checkable: boolean;
            label: string;
          }> = result.dropped ?? [];

          if (dropped.length > 0) {
            const plural = dropped.length === 1 ? '' : 's';
            console.log(chalk.dim(`  Replaced ${dropped.length} existing signature${plural}:`));
            for (const entry of dropped) {
              console.log(chalk.dim(`    - ${entry.label}`));
            }

            const others = dropped.filter((entry) => entry.kind === 'other' && entry.checkable);
            const stillValid = others.filter((entry) => entry.verified);
            const unverified = others.filter((entry) => !entry.verified);

            if (stillValid.length > 0) {
              const noun = stillValid.length === 1 ? 'signature' : 'signatures';
              const it = stillValid.length === 1 ? 'it' : 'them';
              // Name the file that actually holds them. "Keep a copy of the previous file" was advice
              // the command had already made impossible on an in-place run: the only copy was gone by
              // the time it was printed. The backup is written before the overwrite now, so this can
              // point at something that exists.
              const where = result.backupPath
                ? `  The document as it was is saved at ${result.backupPath} — ${it} ${
                    stillValid.length === 1 ? 'is' : 'are'
                  } still valid there.`
                : result.inPlace
                  ? `  Nothing invalidated ${it}; recover ${it} from your own copy of the previous file.`
                  : `  Your input file is untouched, so ${it} ${
                      stillValid.length === 1 ? 'remains' : 'remain'
                    } valid there.`;
              console.log(
                chalk.yellow(
                  `  ${stillValid.length} other ${noun} still verified over this content and ` +
                    `${stillValid.length === 1 ? 'was' : 'were'} removed anyway.\n` +
                    where
                )
              );
            }

            if (unverified.length > 0) {
              const noun = unverified.length === 1 ? 'signature' : 'signatures';
              // Stated as what was observed, with both explanations, and no instruction that would
              // only make sense under one of them.
              console.log(
                chalk.yellow(
                  `  ${unverified.length} other ${noun} could not be verified against this document:`
                )
              );
              for (const entry of unverified) {
                const who = entry.kid ? `...${entry.kid.slice(-8)}` : 'unknown key';
                console.log(chalk.yellow(`    ${who}${entry.role ? ` (${entry.role})` : ''}`));
              }
              console.log(
                chalk.yellow(
                  `  That is consistent with the content having changed since they were made, and\n` +
                    `  equally with their never having been valid — this command only has the document\n` +
                    `  as it stands, so it cannot tell which. If you want those signatures on what you\n` +
                    `  publish, their holders have to sign this document; signing appends, so they can\n` +
                    `  add to this file without disturbing yours.`
                )
              );
            }

            if (dropped.some((entry) => !entry.checkable)) {
              console.log(
                chalk.yellow(
                  `  A legacy flat signature carries no kid or role, so nothing here can judge it.`
                )
              );
            }

            // The general fact, never a claim about a specific entry above.
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
