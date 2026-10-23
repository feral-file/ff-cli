import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import { findConfiguredDeviceIndex, findExistingDeviceEntry } from '../utilities/device-lookup';
import { normalizeDeviceHost } from '../utilities/device-normalize';
import { upsertDevice } from '../utilities/device-upsert';
import { promoteDeviceToDefault } from '../utilities/device-default';
import { renameDevice } from '../utilities/device-rename';
import { readConfigFile, resolveExistingConfigPath } from './helpers/config-files';
import { discoverAndSelectDevice } from './helpers/device-discovery';
import { createPrompt, promptYesNo } from './helpers/prompt';
import {
  CommandFailure,
  type PairOptions,
  runControllers,
  runPair,
  runRevoke,
  runUnpair,
} from './helpers/device-control';
import { persistDeviceRemoval } from './helpers/device-removal';

const deviceCommand = new Command('device').description('Manage configured FF1 devices');

deviceCommand
  .command('pair')
  .description(
    'Pair ff-cli with a configured FF1: on secure control, show a code an owner scans with "Add controller" in the Feral File app (needs internet and an owner); otherwise receive relayer access through a one-time code'
  )
  .argument('[name]', 'Configured device name (uses the default device when omitted)')
  .option(
    '--label <label>',
    "Name the owner sees when adding ff-cli (default: this computer's hostname)"
  )
  .option('--timeout <seconds>', 'How long to wait for an owner, 10-600 (default: 300)')
  .option('--resume', 'Finish a pairing an owner already approved, without a new code')
  .option('-y, --yes', 'Move a corrupt controller file aside without asking')
  .option(
    '--topic-handoff',
    'Use the one-time code and "Pair with ff-cli" in the app (FF OS without secure control); chosen automatically when the FF1 reports no secure control'
  )
  .action(async (name: string | undefined, options: PairOptions) => {
    await runControlAction('Pairing failed:', () => runPair(name, options));
  });

deviceCommand
  .command('controllers')
  .description('List the controllers paired with an FF1 (owner only)')
  .argument('[name]', 'Configured device name (uses the default device when omitted)')
  .action(async (name?: string) => {
    await runControlAction('Error:', () => runControllers(name));
  });

deviceCommand
  .command('revoke')
  .description("Revoke a controller's access to an FF1, or deny its pending request (owner only)")
  .argument('<controller-id>', 'Controller ID shown by `ff-cli device controllers`')
  .argument('[name]', 'Configured device name (uses the default device when omitted)')
  .action(async (ctl: string, name?: string) => {
    await runControlAction('Error:', () => runRevoke(ctl, name));
  });

deviceCommand
  .command('unpair')
  .description("Revoke ff-cli's access on an FF1 (best effort) and delete its controller keys")
  .argument('[name]', 'Configured device name (uses the default device when omitted)')
  .option('-y, --yes', 'Delete the keys without asking')
  .action(async (name: string | undefined, options: { yes?: boolean }) => {
    await runControlAction('Error:', () => runUnpair(name, options));
  });

/**
 * runControlAction runs a pairing/controller action and prints a failure as
 * an error line plus its follow-up, setting a non-zero exit code.
 *
 * @param prefix - Error prefix
 * @param action - Action to run
 */
async function runControlAction(prefix: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(chalk.red(`\n${prefix}`), (error as Error).message);
    if (error instanceof CommandFailure && error.details) {
      console.error(chalk.dim(error.details));
    }
    console.error();
    process.exitCode = 1;
  }
}

deviceCommand
  .command('list')
  .description('List all configured FF1 devices')
  .action(async () => {
    try {
      const configPath = await resolveExistingConfigPath();
      if (!configPath) {
        console.log(chalk.red('config.json not found'));
        console.log(chalk.dim('Run: ff-cli setup'));
        process.exit(1);
      }

      const config = await readConfigFile(configPath);
      const devices = config.ff1Devices?.devices || [];

      if (devices.length === 0) {
        console.log(chalk.yellow('\nNo devices configured'));
        console.log(chalk.dim('Run: ff-cli device add'));
        console.log();
        return;
      }

      console.log(chalk.blue(`\nFF1 Devices (${devices.length})\n`));
      devices.forEach((device, index) => {
        const isFirst = index === 0;
        const marker = isFirst ? chalk.green('→') : ' ';
        const nameLabel = device.name || 'unnamed';
        console.log(`${marker} ${chalk.bold(nameLabel)}`);
        console.log(`    Host: ${chalk.dim(device.host)}`);
        if (device.apiKey) {
          console.log(`    API key: ${chalk.green('Set')}`);
        }
        if (device.id) {
          console.log(`    Device ID: ${chalk.dim(device.id)}`);
        }
        if (isFirst) {
          console.log(`    ${chalk.dim('(default)')}`);
        }
        console.log();
      });
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });

deviceCommand
  .command('add')
  .description('Add a new FF1 device (with mDNS discovery)')
  .option('--host <host>', 'Device host (skip discovery)')
  .option('--name <name>', 'Device name')
  .option('--id <id>', 'Stable FF1 device ID (required for manual relayer pairing)')
  .action(async (options: { host?: string; name?: string; id?: string }) => {
    // Lazy prompt: non-interactive paths (--host + --name) must never block on stdin.
    let prompt: ReturnType<typeof createPrompt> | null = null;
    const ask = async (question: string): Promise<string> => {
      if (!prompt) {
        prompt = createPrompt();
      }
      return prompt.ask(question);
    };
    const closePrompt = () => {
      if (prompt) {
        prompt.close();
      }
    };

    try {
      const configPath = await resolveExistingConfigPath();
      if (!configPath) {
        console.log(chalk.red('config.json not found'));
        console.log(chalk.dim('Run: ff-cli setup'));
        process.exit(1);
      }

      const config = await readConfigFile(configPath);
      const existingDevices = config.ff1Devices?.devices || [];

      let hostValue = '';
      let discoveredName = '';
      const suppliedId = options.id?.trim().toUpperCase();
      if (suppliedId && !/^FF1-[A-Z0-9]{4,}$/.test(suppliedId)) {
        throw new Error('Device ID must use the FF1-XXXXXXXX format');
      }
      if (suppliedId && !options.host) {
        throw new Error('--id is only needed with --host; discovered devices provide their ID');
      }
      let discoveredId: string | undefined = suppliedId;
      let discoveredAddresses: string[] | undefined;

      if (options.host) {
        hostValue = normalizeDeviceHost(options.host);
      } else {
        console.log(chalk.blue('\nDiscover FF1 devices...\n'));
        const selection = await discoverAndSelectDevice(ask, existingDevices);
        hostValue = selection.hostValue;
        discoveredName = selection.discoveredName;
        discoveredId = selection.discoveredId;
        discoveredAddresses = selection.discoveredAddresses;

        if (!hostValue) {
          console.log(chalk.dim('\nNo device added.'));
          closePrompt();
          return;
        }
      }

      // Find any existing entry that represents this device, including cases
      // where the host URL changed (IP ↔ .local) since the device was last added.
      const existingEntry = findExistingDeviceEntry(
        existingDevices,
        hostValue,
        discoveredName,
        discoveredId,
        discoveredAddresses
      );
      const existingIndex = existingEntry
        ? existingDevices.findIndex((d) => d === existingEntry)
        : -1;

      if (existingIndex !== -1) {
        if (options.host && options.name) {
          // Non-interactive: auto-overwrite when both flags are supplied.
          console.log(
            chalk.yellow(
              `\nUpdating existing device: ${existingDevices[existingIndex].name || existingDevices[existingIndex].host}`
            )
          );
        } else {
          console.log(
            chalk.yellow(
              `\nDevice already configured: ${existingDevices[existingIndex].name || existingDevices[existingIndex].host}`
            )
          );
          const overwrite = await promptYesNo(ask, 'Update this device?', false);
          if (!overwrite) {
            console.log(chalk.dim('No changes made.'));
            closePrompt();
            return;
          }
        }
      }

      // Preserve the stored friendly name as the default so a blank prompt never
      // clobbers a curated label (even after a host-URL change).
      const existingName = existingEntry?.name || '';
      let deviceName: string;
      if (options.name) {
        deviceName = options.name;
      } else {
        const defaultName = existingName || discoveredName || '';
        const namePrompt = defaultName
          ? `Device name (kitchen, office, etc.) [${defaultName}]: `
          : 'Device name (kitchen, office, etc.): ';
        const nameAnswer = await ask(namePrompt);
        deviceName = nameAnswer || defaultName || 'ff1';
      }

      // Reject a name that is already used by a DIFFERENT device (not the one being updated).
      // Only applies when existingIndex !== -1: we know exactly which row to update, so a
      // same-name entry at a different index is provably a different device. When
      // existingIndex === -1 (no confirmed match, e.g. manual IP → .local migration),
      // a same-name entry is the upsertDevice case-3 migration path — blocking it would
      // prevent the user from retaining their existing device name during host migration.
      // Case-insensitive: lookups everywhere else ignore case, so "Kitchen"
      // alongside "kitchen" would make one of them unreachable by name.
      const nameConflict =
        existingIndex !== -1
          ? existingDevices.find(
              (d, i) => d.name?.toLowerCase() === deviceName.toLowerCase() && i !== existingIndex
            )
          : undefined;
      if (nameConflict) {
        if (options.name) {
          console.error(
            chalk.red(
              `\nError: device name "${deviceName}" is already used by another device (${nameConflict.host}).`
            )
          );
          console.error(chalk.dim('Use a different name or run "ff-cli device remove" first.'));
          closePrompt();
          process.exit(1);
        }
        console.log(
          chalk.yellow(
            `"${deviceName}" is already used by another device. Please choose a different name.`
          )
        );
        const retryAnswer = await ask('Device name: ');
        deviceName = retryAnswer || 'ff1';
        const retryConflict =
          existingIndex !== -1
            ? existingDevices.find(
                (d, i) => d.name?.toLowerCase() === deviceName.toLowerCase() && i !== existingIndex
              )
            : undefined;
        if (retryConflict) {
          console.error(chalk.red(`\nName "${deviceName}" is also taken. No changes made.`));
          closePrompt();
          return;
        }
      }

      const result = upsertDevice(
        existingDevices,
        { name: deviceName, host: hostValue, id: discoveredId, addresses: discoveredAddresses },
        existingIndex !== -1 ? existingIndex : undefined
      );
      console.log(chalk.green(`\n${result.updated ? 'Updated' : 'Added'} device: ${deviceName}`));

      config.ff1Devices = { devices: result.devices };
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
      console.log(chalk.dim(`Total devices: ${result.devices.length}\n`));

      closePrompt();
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      closePrompt();
      process.exit(1);
    }
  });

deviceCommand
  .command('remove')
  .description('Remove a configured FF1 device')
  .argument('<name>', 'Device name to remove')
  .action(async (name: string) => {
    try {
      const configPath = await resolveExistingConfigPath();
      if (!configPath) {
        console.log(chalk.red('config.json not found'));
        process.exit(1);
      }

      const config = await readConfigFile(configPath);
      const existingDevices = config.ff1Devices?.devices || [];

      const deviceIndex = findConfiguredDeviceIndex(existingDevices, name);

      if (deviceIndex === -1) {
        console.error(chalk.red(`\nDevice "${name}" not found`));
        if (existingDevices.length > 0) {
          const names = existingDevices.map((d) => d.name || d.host).join(', ');
          console.log(chalk.dim(`Available devices: ${names}`));
        }
        process.exit(1);
      }

      const { removed, updatedDevices } = await persistDeviceRemoval(config, deviceIndex, {
        persistConfig: async (updatedConfig) => {
          await fs.writeFile(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf-8');
        },
        warn: (message) => console.warn(chalk.yellow(message)),
      });
      console.log(chalk.green(`\nRemoved device: ${removed.name || removed.host}`));
      console.log(chalk.dim(`Remaining devices: ${updatedDevices.length}\n`));
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });

deviceCommand
  .command('rename')
  .description('Rename a configured FF1 device (host, API key, and default status are untouched)')
  .argument('<name>', 'Current device name or host')
  .argument('<new-name>', 'New device name')
  .action(async (name: string, newName: string) => {
    try {
      const configPath = await resolveExistingConfigPath();
      if (!configPath) {
        console.log(chalk.red('config.json not found'));
        console.log(chalk.dim('Run: ff-cli setup'));
        process.exit(1);
      }

      const config = await readConfigFile(configPath);
      const existingDevices = config.ff1Devices?.devices || [];

      if (existingDevices.length === 0) {
        console.log(chalk.yellow('\nNo devices configured'));
        console.log(chalk.dim('Run: ff-cli device add\n'));
        process.exit(1);
      }

      let result;
      try {
        result = renameDevice(existingDevices, name, newName);
      } catch (error) {
        console.error(chalk.red(`\n${(error as Error).message}`));
        const names = existingDevices.map((d) => d.name || d.host).join(', ');
        console.log(chalk.dim(`Available devices: ${names}\n`));
        process.exit(1);
      }

      if (result.unchanged) {
        console.log(chalk.dim(`\n"${result.renamed.name}" is already named that.\n`));
        return;
      }

      config.ff1Devices = { devices: result.devices };
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

      const from = result.previousName || result.renamed.host;
      console.log(chalk.green(`\nRenamed device: ${from} → ${result.renamed.name}\n`));
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });

deviceCommand
  .command('default')
  .description('Set the default FF1 device (reorders so this device is used when -d is omitted)')
  .argument('<name>', 'Device name or host to promote to default')
  .action(async (name: string) => {
    try {
      const configPath = await resolveExistingConfigPath();
      if (!configPath) {
        console.log(chalk.red('config.json not found'));
        console.log(chalk.dim('Run: ff-cli setup'));
        process.exit(1);
      }

      const config = await readConfigFile(configPath);
      const existingDevices = config.ff1Devices?.devices || [];

      if (existingDevices.length === 0) {
        console.log(chalk.yellow('\nNo devices configured'));
        console.log(chalk.dim('Run: ff-cli device add\n'));
        process.exit(1);
      }

      let result;
      try {
        result = promoteDeviceToDefault(existingDevices, name);
      } catch (error) {
        console.error(chalk.red(`\n${(error as Error).message}`));
        const names = existingDevices.map((d) => d.name || d.host).join(', ');
        console.log(chalk.dim(`Available devices: ${names}\n`));
        process.exit(1);
      }

      const label = result.promoted.name || result.promoted.host;

      if (result.alreadyDefault) {
        console.log(chalk.dim(`\n"${label}" is already the default.\n`));
        return;
      }

      config.ff1Devices = { devices: result.devices };
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

      console.log(chalk.green(`\nDefault device: ${label}`));
      console.log(chalk.dim('Other commands now target this device when -d is omitted.\n'));
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });

export { deviceCommand };
