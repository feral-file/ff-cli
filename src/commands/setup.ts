import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { findExistingDeviceEntry } from '../utilities/device-lookup';
import { upsertDevice } from '../utilities/device-upsert';
import { normalizeDeviceHost } from '../utilities/device-normalize';
import { ensureConfigFile, isMissingConfigValue, readConfigFile } from './helpers/config-files';
import { discoverAndSelectDevice } from './helpers/device-discovery';
import { createPrompt, promptYesNo } from './helpers/prompt';
import { configuredFF1Devices } from '../utilities/config-placeholders';
import { parsePlaylistPrivateKeyToKeyObject } from '../utilities/ed25519-key-derive';
import {
  DP1_PLAYLIST_SIGNING_ROLES,
  resolveDp1PlaylistSigningRole,
} from '../utilities/playlist-signing-role';

interface SetupOptions {
  nonInteractive?: boolean;
  key?: string;
  generateKey?: boolean;
  role?: string;
  deviceHost?: string;
  deviceName?: string;
}

/** Generate a fresh Ed25519 signing key as base64 PKCS#8 DER (the recommended form). */
function generateSigningKeyBase64(): string {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  return keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

export const setupCommand = new Command('setup')
  .description('Guided setup for config, signing key, and device')
  .option(
    '-y, --non-interactive',
    'Run without prompts (for agents/CI); uses flags and safe defaults. Auto-enabled when stdin is not a TTY.'
  )
  .option(
    '--key <privateKey>',
    'Signing key material (base64 PKCS#8 DER, 32-byte seed as hex/base64, or PEM)'
  )
  .option('--generate-key', 'Generate a new Ed25519 signing key')
  .option('--role <role>', `Signing role (${DP1_PLAYLIST_SIGNING_ROLES.join(', ')})`)
  .option(
    '--device-host <host>',
    'FF1 device host, e.g. http://192.168.1.50:1111 (skips mDNS discovery)'
  )
  .option('--device-name <name>', 'Friendly name for the device')
  .action(async (options: SetupOptions) => {
    // Treat a non-TTY stdin as non-interactive: agents driving the CLI cannot
    // answer prompts, and the report shows feeding stdin to the prompts does not
    // work. The explicit flag forces it even on a TTY.
    const nonInteractive = Boolean(options.nonInteractive) || !process.stdin.isTTY;

    let prompt: ReturnType<typeof createPrompt> | null = null;
    // Lazily open the prompt so non-interactive runs never touch stdin.
    const getAsk = () => (prompt ??= createPrompt()).ask;
    try {
      const { path: configPath, created } = await ensureConfigFile();
      if (created) {
        console.log(chalk.green(`Created ${configPath}`));
      }

      const config = await readConfigFile(configPath);

      console.log(chalk.blue(`\nff-cli setup${nonInteractive ? ' (non-interactive)' : ''}\n`));

      const currentKey = config.playlist?.privateKey || '';
      const currentRole = config.playlist?.role || '';
      let signingKey = currentKey;
      let signingRole = currentRole;

      if (nonInteractive) {
        // Key precedence: explicit --key, then --generate-key, then keep an
        // existing usable key, otherwise generate one so signing works.
        if (options.key) {
          // Validate eagerly so a bad key fails here with a clear message rather
          // than later inside dp1-js during signing.
          try {
            parsePlaylistPrivateKeyToKeyObject(options.key);
          } catch (error) {
            throw new Error(
              `Invalid --key: ${(error as Error).message}. ` +
                'Expected base64 PKCS#8 DER, a 32-byte raw seed as hex/base64, or PEM.'
            );
          }
          signingKey = options.key;
        } else if (options.generateKey || isMissingConfigValue(currentKey)) {
          signingKey = generateSigningKeyBase64();
          console.log(chalk.dim('Generated a new Ed25519 signing key.'));
        }
      } else {
        if (isMissingConfigValue(currentKey)) {
          signingKey = generateSigningKeyBase64();
        } else {
          const ask = getAsk();
          const keepKey = await promptYesNo(ask, 'Keep existing signing key?', true);
          if (!keepKey) {
            const keyAnswer = await ask(
              'Paste signing key (base64 or hex), or leave blank to regenerate: '
            );
            signingKey = keyAnswer || generateSigningKeyBase64();
          }
        }
      }

      if (signingKey) {
        if (nonInteractive) {
          // Role precedence: --role, then existing role, then 'agent'.
          try {
            signingRole = resolveDp1PlaylistSigningRole(options.role, signingRole || 'agent');
          } catch (error) {
            throw new Error(
              `Invalid --role: ${(error as Error).message} ` +
                `Supported roles: ${DP1_PLAYLIST_SIGNING_ROLES.join(', ')}.`
            );
          }
        } else {
          const ask = getAsk();
          const roleHint = DP1_PLAYLIST_SIGNING_ROLES.join(', ');
          while (true) {
            const roleAnswer = await ask(
              `Signing role (${roleHint}) [${currentRole || 'agent'}]: `
            );
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

      if (nonInteractive) {
        // Non-interactive device step: only act when a host is supplied. mDNS
        // discovery is interactive and unreliable across subnets, so we never
        // run it here — agents should pass --device-host.
        if (options.deviceHost) {
          const hostValue = normalizeDeviceHost(options.deviceHost);
          const existingEntry = findExistingDeviceEntry(
            existingDevices,
            hostValue,
            '',
            undefined,
            undefined
          );
          const existingIndex = existingEntry
            ? existingDevices.findIndex((d) => d === existingEntry)
            : -1;
          const deviceName = options.deviceName || existingEntry?.name || 'art-computer';
          const result = upsertDevice(
            existingDevices,
            { name: deviceName, host: hostValue },
            existingIndex !== -1 ? existingIndex : undefined
          );
          console.log(chalk.dim(`${result.updated ? 'Updated' : 'Added'} device: ${deviceName}`));
          config.ff1Devices = { devices: result.devices };
        } else {
          config.ff1Devices = { devices: existingDevices };
          if (existingDevices.length === 0) {
            console.log(
              chalk.dim(
                'No device configured. Add one with: ff-cli device add --host http://<device-ip>:1111 --name <name>'
              )
            );
          }
        }
      } else {
        const ask = getAsk();
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
      }

      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
      if (prompt) {
        prompt.close();
        prompt = null;
      }

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
