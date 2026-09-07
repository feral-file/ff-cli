import { Command } from 'commander';
import chalk from 'chalk';
import { parseTtlSeconds, readPublicKeyFile } from './helpers/ssh-helpers';

// `ssh` is a single command with an action argument rather than a
// commander subcommand group. Kept this way to preserve the existing
// CLI surface (`ff1 ssh enable|disable`) used in scripts.

export const sshCommand = new Command('ssh')
  .description('Enable or disable SSH access on an FF1 device')
  .argument('<action>', 'Action: enable or disable')
  .option('-d, --device <name>', 'Device name (uses first device if not specified)')
  .option('--pubkey <path>', 'SSH public key file (required for enable)')
  .option('--ttl <duration>', 'Auto-disable after duration (e.g. 30m, 2h, 900s)')
  .action(async (action: string, options: { device?: string; pubkey?: string; ttl?: string }) => {
    try {
      const normalizedAction = action.trim().toLowerCase();
      if (normalizedAction !== 'enable' && normalizedAction !== 'disable') {
        console.error(chalk.red('\nUnknown action:'), action);
        console.log(chalk.yellow('Available actions: enable, disable\n'));
        process.exit(1);
      }

      const isEnable = normalizedAction === 'enable';
      let publicKey: string | undefined;
      if (isEnable) {
        if (!options.pubkey) {
          console.error(chalk.red('\nPublic key is required to enable SSH'));
          console.log(chalk.yellow('Use: ff1 ssh enable --pubkey ~/.ssh/id_ed25519.pub\n'));
          process.exit(1);
        }
        publicKey = await readPublicKeyFile(options.pubkey);
      }

      let ttlSeconds: number | undefined;
      if (options.ttl) {
        ttlSeconds = parseTtlSeconds(options.ttl);
      }

      const { sendSshAccessCommand } = await import('../utilities/ssh-access.js');

      const result = await sendSshAccessCommand({
        enabled: isEnable,
        deviceName: options.device,
        publicKey,
        ttlSeconds,
      });

      if (result.success) {
        console.log(chalk.green(`SSH ${isEnable ? 'enabled' : 'disabled'}`));
        if (result.deviceName) {
          console.log(chalk.dim(`  Device: ${result.deviceName}`));
        }
        if (result.device) {
          console.log(chalk.dim(`  Host: ${result.device}`));
        }
        if (result.response && typeof result.response === 'object') {
          const expiresAt = result.response.expiresAt as string | undefined;
          if (expiresAt) {
            console.log(chalk.dim(`  Expires: ${expiresAt}`));
          }
        }
        console.log();
        return;
      }

      console.error(chalk.red('\nSSH request failed:'), result.error);
      if (result.details) {
        console.error(chalk.dim(`  Details: ${result.details}`));
      }
      process.exit(1);
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });
