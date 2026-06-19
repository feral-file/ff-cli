import { Command } from 'commander';
import chalk from 'chalk';
import { createSampleConfig, getConfig, getConfigPaths, validateConfig } from '../config';

// `config` is a single command with an action argument rather than a
// commander subcommand group. Kept this way to preserve the existing
// CLI surface (`ff-cli config init|show|validate`) used in scripts.

export const configCommand = new Command('config')
  .description('Manage configuration')
  .argument('<action>', 'Action: init, show, or validate')
  .action(async (action: string) => {
    try {
      if (action === 'init') {
        console.log(chalk.blue('\nCreate config.json\n'));
        const { userPath } = getConfigPaths();
        const configPath = await createSampleConfig(userPath);
        console.log(chalk.green(`Created ${configPath}`));
        console.log(chalk.yellow('\nNext: ff-cli setup\n'));
      } else if (action === 'show') {
        const config = getConfig();
        console.log(chalk.blue('\nCurrent configuration\n'));
        console.log(chalk.bold('Default duration:'), chalk.white(config.defaultDuration + 's'));
        const feedServers = config.feedServers || [];
        if (feedServers.length > 0) {
          console.log(chalk.bold('\nFeed servers:\n'));
          feedServers.forEach((server) => {
            console.log(`  ${chalk.dim(server.baseUrl)}`);
          });
        }
        const devices = config.ff1Devices?.devices || [];
        if (devices.length > 0) {
          console.log(chalk.bold('\nFF1 devices:\n'));
          devices.forEach((device) => {
            console.log(
              `  ${chalk.bold(device.name || 'unnamed')} ${chalk.dim(`→ ${device.host}`)}`
            );
          });
        }
        console.log();
      } else if (action === 'validate') {
        const validation = validateConfig();

        console.log(chalk.blue('\nValidate configuration\n'));

        if (validation.valid) {
          console.log(chalk.green('Configuration is valid\n'));
        } else {
          console.log(chalk.red('Configuration has errors:\n'));
          validation.errors.forEach((error) => {
            console.log(chalk.red(`  • ${error}`));
          });
          console.log();
          process.exit(1);
        }
      } else {
        console.error(chalk.red(`\nUnknown action: ${action}`));
        console.log(chalk.yellow('Available actions: init, show, validate\n'));
        process.exit(1);
      }
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });
