import { Command } from 'commander';
import chalk from 'chalk';
import { selectFeedServer } from './helpers/feed-server';
import { createPrompt, promptYesNo } from './helpers/prompt';
import type { KeySource } from '../utilities/feed-mutation';

/**
 * `ff-cli unpublish <id-or-url>` — delete a playlist this key owns from a feed.
 *
 * The delete is irreversible in a way most deletes are not: the feed tombstones the id, so the playlist
 * cannot be restored and the id can never be reused. Hence the confirmation, which shows the title and
 * server first, and defaults to no. `-y` skips it for scripts; without a terminal and without `-y` the
 * command refuses rather than assuming consent.
 */
/** Parsed options for `unpublish`. */
interface UnpublishCommandOptions {
  server?: string;
  yes?: boolean;
  key?: string;
  keyFile?: string;
}

export const unpublishCommand = new Command('unpublish')
  .description('Delete a playlist from a feed server (signed delete; owner key required)')
  .argument('<id-or-url>', 'Playlist id, slug, or feed URL')
  .option('-s, --server <index>', 'Feed server index (use this if multiple servers configured)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option(
    '-k, --key <privateKey>',
    'Ed25519 private key that signs the delete authorization (overrides config)'
  )
  .option(
    '--key-file <path>',
    'Read the key that signs the delete authorization from this file, not the command line'
  )
  .action(async (idOrUrl: string, options: UnpublishCommandOptions) => {
    try {
      console.log(chalk.blue('\nUnpublish playlist\n'));

      const { getFeedConfig } = await import('../config.js');
      const { unpublishPlaylist, fetchPlaylistForUnpublish } = await import(
        '../utilities/playlist-unpublisher.js'
      );

      // Resolve the signing credential ONCE, before anything else touches the network or the operator,
      // and carry the material itself forward.
      //
      // This runs before the server is chosen, not after. With several feeds configured, selecting one
      // is a question put to the operator, and asking it only to reject the key afterwards spends their
      // attention on a run that could never have completed. A credential the command already holds is
      // checkable without asking anybody anything, so it is checked first.
      //
      // Deriving it here means a malformed or empty --key fails before the lookup and before the
      // confirmation prompt — otherwise someone was shown a playlist, asked to approve destroying it,
      // and only then told their key was unusable.
      //
      // Passing the resolved material on, rather than letting unpublishPlaylist resolve again, closes a
      // narrower gap: the prompt can stay open indefinitely, and a second resolution would re-read
      // config.json at send time. A config edited in that window would sign the delete under an
      // identity other than the one the operator saw and approved — and a delete tombstones the id.
      // The DID displayed below and the key that signs are now the same value.
      //
      // Only the did:key is ever printed; the material never reaches the output from this path.
      //
      // `--key-file` is read here too, in the same step and before the same milestones: a key file that
      // is missing, unreadable, or empty is a credential failure like any other, and it must not be
      // discovered after the operator has approved a delete.
      const { mutationSignerIdentity } = await import('../utilities/feed-mutation.js');
      const { resolveExplicitSigningKey } = await import('../utilities/signing-key-source.js');
      let signerDidKey: string;
      let signingKey: string;
      let keySource: KeySource = 'configured';
      try {
        const explicitKey = resolveExplicitSigningKey(options);
        keySource = explicitKey?.flag ?? 'configured';
        ({ privateKey: signingKey, didKey: signerDidKey } = mutationSignerIdentity(
          explicitKey?.material,
          'delete'
        ));
      } catch (error) {
        console.error(chalk.red('\nCannot sign the delete'));
        console.error(chalk.red(`  ${(error as Error).message}`));
        console.log();
        process.exit(1);
      }

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
        console.log(chalk.dim(`  Signing as: ${signerDidKey}`));
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

      // `Signing as` is printed on both paths, not only before the prompt: under -y it is the only
      // record of which identity performed an irreversible delete, and it is what the assertion in the
      // tests ties to the signature on the wire.
      if (options.yes) {
        console.log(chalk.dim(`  Signing as: ${signerDidKey}`));
      }

      const result = await unpublishPlaylist(idOrUrl, selection.url, {
        privateKey: signingKey,
        keySource,
      });

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
