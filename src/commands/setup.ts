import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { findExistingDeviceEntry } from '../utilities/device-lookup';
import { upsertDevice } from '../utilities/device-upsert';
import { ensureConfigFile, isMissingConfigValue, readConfigFile } from './helpers/config-files';
import { discoverAndSelectDevice } from './helpers/device-discovery';
import { createPrompt, promptYesNo } from './helpers/prompt';
import { configuredFF1Devices } from '../utilities/config-placeholders';
import {
  DP1_PLAYLIST_SIGNING_ROLES,
  resolveDp1PlaylistSigningRole,
} from '../utilities/playlist-signing-role';

export const setupCommand = new Command('setup')
  .description('Guided setup for config, signing key, and device')
  .action(async () => {
    let prompt: ReturnType<typeof createPrompt> | null = null;
    try {
      const { path: configPath, created } = await ensureConfigFile();
      if (created) {
        console.log(chalk.green(`Created ${configPath}`));
      }

      const config = await readConfigFile(configPath);

      console.log(chalk.blue('\nff-cli setup\n'));

      prompt = createPrompt();
      const ask = prompt.ask;

      const currentKey = config.playlist?.privateKey || '';
      const currentRole = config.playlist?.role || '';
      let signingKey = currentKey;
      let signingRole = currentRole;

      if (isMissingConfigValue(currentKey)) {
        const keyPair = crypto.generateKeyPairSync('ed25519');
        signingKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
      } else {
        const keepKey = await promptYesNo(ask, 'Keep existing signing key?', true);
        if (!keepKey) {
          const keyAnswer = await ask(
            'Paste signing key (base64 or hex), or leave blank to regenerate: '
          );
          if (keyAnswer) {
            signingKey = keyAnswer;
          } else {
            const keyPair = crypto.generateKeyPairSync('ed25519');
            signingKey = keyPair.privateKey
              .export({ format: 'der', type: 'pkcs8' })
              .toString('base64');
          }
        }
      }

      if (signingKey) {
        const roleHint = DP1_PLAYLIST_SIGNING_ROLES.join(', ');
        while (true) {
          const roleAnswer = await ask(`Signing role (${roleHint}) [${currentRole || 'agent'}]: `);
          try {
            signingRole = resolveDp1PlaylistSigningRole(roleAnswer, signingRole || 'agent');
            break;
          } catch (error) {
            console.log(chalk.red((error as Error).message));
            if (!roleAnswer.trim()) {
              console.log(
                chalk.dim('Enter one of the supported roles above, or fix the stored value.')
              );
            }
          }
        }

        config.playlist = {
          ...(config.playlist || {}),
          privateKey: signingKey,
          role: signingRole,
        };
      }

      const configuredDevices = configuredFF1Devices(config.ff1Devices?.devices || []);
      const existingDevices = configuredDevices;
      // Drop bundled example rows before discovery. Otherwise setup sees the
      // sample placeholder as an existing device and lets users skip the device
      // prompt without ever configuring a usable FF1 host.
      config.ff1Devices = { devices: configuredDevices };

      if (existingDevices.length > 0) {
        console.log(
          chalk.dim(
            `\nConfigured devices: ${existingDevices.map((d) => d.name || d.host).join(', ')}`
          )
        );
      }

      const selection = await discoverAndSelectDevice(ask, existingDevices, { allowSkip: true });

      if (selection.hostValue) {
        // Prefer the already-stored label so re-running setup (or re-adding a device
        // that returned on a new IP) doesn't clobber the friendly name.
        const existingEntry = findExistingDeviceEntry(
          existingDevices,
          selection.hostValue,
          selection.discoveredName,
          selection.discoveredId,
          selection.discoveredAddresses
        );
        const existingIndex = existingEntry
          ? existingDevices.findIndex((d) => d === existingEntry)
          : -1;
        const existingName = existingEntry?.name || '';
        const defaultName = existingName || selection.discoveredName || 'art-computer';
        const namePrompt =
          defaultName !== 'art-computer'
            ? `Device name (kitchen, office, etc.) [${defaultName}]: `
            : 'Device name (kitchen, office, etc.): ';
        const nameAnswer = await ask(namePrompt);
        let deviceName = nameAnswer || defaultName || 'art-computer';

        // Same name-collision guard as `device add`: reject names that would
        // clobber a different device entry. Only fires when existingIndex !== -1
        // (we know the row); when existingIndex === -1, a same-name entry is the
        // case-3 migration path.
        const setupNameConflict =
          existingIndex !== -1
            ? existingDevices.find((d, i) => d.name === deviceName && i !== existingIndex)
            : undefined;
        if (setupNameConflict) {
          console.log(
            chalk.yellow(
              `"${deviceName}" is already used by another device. Please choose a different name.`
            )
          );
          const retryAnswer = await ask('Device name: ');
          deviceName = retryAnswer || 'art-computer';
          const retryConflict =
            existingIndex !== -1
              ? existingDevices.find((d, i) => d.name === deviceName && i !== existingIndex)
              : undefined;
          if (retryConflict) {
            console.log(chalk.yellow(`"${deviceName}" is also taken. Skipping device.`));
            config.ff1Devices = { devices: existingDevices };
            await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
            return;
          }
        }

        const result = upsertDevice(
          existingDevices,
          {
            name: deviceName,
            host: selection.hostValue,
            id: selection.discoveredId,
            addresses: selection.discoveredAddresses,
          },
          existingIndex !== -1 ? existingIndex : undefined
        );
        console.log(chalk.dim(`${result.updated ? 'Updated' : 'Added'} device: ${deviceName}`));
        config.ff1Devices = { devices: result.devices };
      } else if (existingDevices.length > 0) {
        config.ff1Devices = { devices: existingDevices };
      }

      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
      prompt.close();
      prompt = null;

      console.log(chalk.green('\nSetup complete'));
      console.log(chalk.dim(`   Config: ${configPath}`));

      const hasSigningKey = !isMissingConfigValue(config.playlist?.privateKey || '');
      const hasDevice = configuredFF1Devices(config.ff1Devices?.devices || []).length > 0;

      if (!hasSigningKey || !hasDevice) {
        console.log(chalk.yellow('\nNext steps:'));
        if (!hasSigningKey) {
          console.log(chalk.yellow('  • Add a playlist signing key'));
        }
        if (!hasDevice) {
          console.log(chalk.yellow('  • Add an FF1 device host'));
        }
      }

      console.log(chalk.dim('\nRun: ff-cli play <url-or-playlist>'));
    } catch (error) {
      console.error(chalk.red('\nSetup failed:'), (error as Error).message);
      process.exit(1);
    } finally {
      if (prompt) {
        prompt.close();
      }
    }
  });
