import { Command } from 'commander';
import chalk from 'chalk';
import { selectFeedServer } from './helpers/feed-server';
import { explicitSigningKeyFlag } from '../utilities/signing-key-source';
import type { KeySource } from '../utilities/feed-mutation';

/** Parsed options for `publish`. */
interface PublishCommandOptions {
  server?: string;
  replace?: boolean;
  key?: string;
  keyFile?: string;
}

export const publishCommand = new Command('publish')
  .description('Publish a playlist to a feed server')
  .argument('<file>', 'Path to the playlist file')
  .option('-s, --server <index>', 'Feed server index (use this if multiple servers configured)')
  .option(
    '--replace',
    'Replace the playlist already stored under this document id, instead of creating a new one'
  )
  .option(
    '-k, --key <privateKey>',
    'Ed25519 private key that signs the replace authorization (overrides config; --replace only)'
  )
  .option(
    '--key-file <path>',
    'Read the key that signs the replace authorization from this file, not the command line'
  )
  .action(async (file: string, options: PublishCommandOptions) => {
    try {
      // A plain publish signs nothing at request time — it uploads the signatures[] envelope the
      // document already carries — so a key flag would do nothing here. Refusing beats accepting it
      // silently: someone passing a key believes it is being used, and a no-op flag on a command
      // that writes to a feed is the kind of quiet lie this CLI has been removing.
      //
      // Tested for PRESENCE, not truthiness. `--key ""` is what an unset shell variable expands to,
      // and it is still a key the user meant to supply; skipping the refusal for it published the
      // document while leaving them believing a key had been checked.
      //
      // The flag is resolved to a NAME here, not to key material: this branch is about to refuse, and
      // opening someone's key file only to tell them the flag does not apply reads their private key
      // for no reason at all.
      const keyFlag = explicitSigningKeyFlag(options);
      if (keyFlag !== undefined && !options.replace) {
        console.error(chalk.red(`\n${keyFlag} has no effect on a plain publish`));
        console.log(
          chalk.yellow(
            '  A publish is authorized by the signatures already inside the document; the command\n' +
              '  signs nothing. Sign the file first, with the key you meant:\n' +
              `    ff-cli sign <file> -r curator ${keyFlag} <${
                keyFlag === '--key-file' ? 'file holding the private key' : 'private key'
              }>\n` +
              `  ${keyFlag} applies to "publish --replace", which signs an authorization intent.\n`
          )
        );
        process.exit(1);
      }

      console.log(chalk.blue(options.replace ? '\nReplace playlist\n' : '\nPublish playlist\n'));

      const { getFeedConfig } = await import('../config.js');
      const { publishPlaylist, replacePlaylist } = await import(
        '../utilities/playlist-publisher.js'
      );

      // Validate the signing credential before the server is chosen, for a replace.
      //
      // Selecting between several configured feeds is a question put to the operator; asking it and
      // only then rejecting their key spends their attention on a run that could never have completed.
      // The credential is already in hand, so it is checked without asking anybody anything.
      //
      // Only for --replace: a plain publish signs nothing at request time and must keep working with
      // no key configured at all, so requiring one here would break it.
      //
      // A `--key-file` is read as part of the same step: a missing, unreadable, or empty key file is a
      // credential failure like any other, and it belongs before the server question for the same
      // reason a malformed key does.
      let replaceKey: string | undefined;
      let keySource: KeySource = 'configured';
      if (options.replace) {
        const { mutationSignerIdentity } = await import('../utilities/feed-mutation.js');
        const { resolveExplicitSigningKey } = await import('../utilities/signing-key-source.js');
        try {
          const explicitKey = resolveExplicitSigningKey(options);
          keySource = explicitKey?.flag ?? 'configured';
          replaceKey = mutationSignerIdentity(explicitKey?.material, 'replace').privateKey;
        } catch (error) {
          console.error(chalk.red('\nCannot sign the replacement'));
          console.error(chalk.red(`  ${(error as Error).message}`));
          console.log();
          process.exit(1);
        }
      }

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
        ? await replacePlaylist(file, selection.url, {
            // The material resolved above, so the identity validated here is the one that signs.
            privateKey: replaceKey,
            keySource,
          })
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
