import { Command } from 'commander';
import chalk from 'chalk';
import { readConfigFile, resolveExistingConfigPath } from './helpers/config-files';
import { getPlaylistConfig } from '../config';
import { parsePlaylistPrivateKeyToKeyObject } from '../utilities/ed25519-key-derive';
import { isDp1PlaylistSigningRole } from '../utilities/playlist-signing-role';
import { playlistSigningDidKey } from '../utilities/signing-identity';
import { configuredFF1Devices } from '../utilities/config-placeholders';

export const statusCommand = new Command('status')
  .description('Show configuration status')
  // Identity discovery must cover every key `sign` accepts, not just the configured one. `sign --key`
  // signs with a key the config never mentions, so reporting only the configured identity would hand the
  // user the wrong did:key to declare in curators[] — and a wrong declaration fails exactly like a
  // missing one.
  .option(
    '-k, --key <privateKey>',
    'Report the signing identity for this key instead of the configured one'
  )
  .action(async (options: { key?: string }) => {
    try {
      const overrideKey = options.key?.trim();
      if (overrideKey) {
        try {
          console.log(
            chalk.green(`Signing identity (did:key) ${playlistSigningDidKey(overrideKey)}`)
          );
          console.log(chalk.dim("  declare this in the playlist's curators[] before signing"));
          return;
        } catch (error) {
          console.log(chalk.red(`--key unusable: ${(error as Error).message}`));
          process.exit(1);
        }
      }

      const configPath = await resolveExistingConfigPath();
      if (!configPath) {
        console.log(chalk.red('config.json not found'));
        console.log(chalk.dim('Run: ff-cli setup'));
        // PLAYLIST_PRIVATE_KEY is a supported signing source on its own, and the did:key it implies is
        // the one value a user must know before they can write a publishable playlist — it has to be
        // declared in curators[] before signing. Exiting silently here would leave an environment-only
        // user unable to obtain it from anywhere. The exit status still reports "not configured".
        const envKey = process.env.PLAYLIST_PRIVATE_KEY?.trim();
        if (envKey) {
          try {
            console.log(
              chalk.green(`\nSigning identity (did:key) ${playlistSigningDidKey(envKey)}`)
            );
            console.log(
              chalk.dim("  from PLAYLIST_PRIVATE_KEY; declare it in the playlist's curators[]")
            );
          } catch (error) {
            console.log(chalk.red(`\nPLAYLIST_PRIVATE_KEY unusable: ${(error as Error).message}`));
          }
        }
        process.exit(1);
      }

      const config = await readConfigFile(configPath);
      const playlistConfig = getPlaylistConfig();

      const playlistKeyMaterial = playlistConfig.privateKey?.trim() || '';
      const playlistKeyError =
        playlistKeyMaterial.length > 0 ? validatePlaylistPrivateKey(playlistKeyMaterial) : null;
      const hasPlaylistSigningKey = playlistKeyMaterial.length > 0 && playlistKeyError === null;
      const configuredDevices = configuredFF1Devices(config.ff1Devices?.devices || []);
      let hasValidPlaylistRole = false;
      let playlistRoleDetail: string | undefined;
      let playlistRoleError: string | undefined;
      const playlistRoleMaterial = playlistConfig.role?.trim() || '';
      if (playlistRoleMaterial) {
        hasValidPlaylistRole = isDp1PlaylistSigningRole(playlistRoleMaterial);
        playlistRoleDetail = playlistRoleMaterial;
        if (!hasValidPlaylistRole) {
          playlistRoleError = playlistRoleMaterial;
        }
      }

      // The feed matches a signature's kid against the document's own curators[], so this value is not
      // decoration: without it a user cannot write a publishable playlist, and it appears nowhere else.
      let signingDidKey: string | undefined;
      if (hasPlaylistSigningKey) {
        try {
          signingDidKey = playlistSigningDidKey(playlistKeyMaterial);
        } catch {
          signingDidKey = undefined;
        }
      }

      const statuses = [
        {
          label: 'Config file',
          ok: true,
          detail: configPath,
        },
        {
          label: 'Playlist signing key',
          ok: hasPlaylistSigningKey,
          optional: false,
          detail: playlistKeyError
            ? `${playlistKeyError} (from config/env)`
            : playlistKeyMaterial
              ? 'from config/env'
              : undefined,
          hint: ' (needed for signing and legacy verification)',
        },
        {
          label: 'Signing identity (did:key)',
          ok: Boolean(signingDidKey),
          optional: false,
          detail: signingDidKey,
          hint: " (declare this in the playlist's curators[] so the feed accepts a publish)",
        },
        {
          label: 'Playlist signing role',
          ok: hasValidPlaylistRole,
          optional: true,
          detail: playlistRoleDetail,
          invalid: Boolean(playlistRoleError),
          hint: ' (used when signing playlists)',
        },
        {
          label: `FF1 devices (${configuredDevices.length})`,
          ok: configuredDevices.length > 0,
          detail:
            configuredDevices.map((d) => `${d.name || 'unnamed'} → ${d.host}`).join(', ') ||
            undefined,
        },
      ];

      console.log(chalk.blue('\n🔎 FF1 Status\n'));
      statuses.forEach((status) => {
        let label: string;
        if (status.ok) {
          label = chalk.green('OK');
        } else if ((status as { invalid?: boolean }).invalid) {
          label = chalk.red('Invalid');
        } else if (status.optional) {
          label = chalk.yellow('Not set');
        } else {
          label = chalk.red('Missing');
        }
        const detail = status.detail ? chalk.dim(` (${status.detail})`) : '';
        const hint =
          status.ok || !(status as { hint?: string }).hint
            ? ''
            : chalk.dim((status as { hint?: string }).hint as string);
        console.log(`${label} ${status.label}${detail}${hint}`);
      });

      const hasRequired = statuses.some(
        (status) =>
          !status.ok && (!status.optional || Boolean((status as { invalid?: boolean }).invalid))
      );
      if (hasRequired) {
        console.log(chalk.dim('\nRun: ff-cli setup'));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('\nStatus check failed:'), (error as Error).message);
      process.exit(1);
    }
  });

function validatePlaylistPrivateKey(material: string): string | null {
  try {
    parsePlaylistPrivateKeyToKeyObject(material);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
