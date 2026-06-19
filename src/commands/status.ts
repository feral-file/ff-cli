import { Command } from 'commander';
import chalk from 'chalk';
import { readConfigFile, resolveExistingConfigPath } from './helpers/config-files';
import { getPlaylistConfig } from '../config';
import { parsePlaylistPrivateKeyToKeyObject } from '../utilities/ed25519-key-derive';
import { isDp1PlaylistSigningRole } from '../utilities/playlist-signing-role';
import { configuredFF1Devices } from '../utilities/config-placeholders';

export const statusCommand = new Command('status')
  .description('Show configuration status')
  .action(async () => {
    try {
      const configPath = await resolveExistingConfigPath();
      if (!configPath) {
        console.log(chalk.red('config.json not found'));
        console.log(chalk.dim('Run: ff-cli setup'));
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
