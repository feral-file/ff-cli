import { Command } from 'commander';
import chalk from 'chalk';
import {
  createSampleConfig,
  getConfig,
  getConfigPaths,
  listAvailableModels,
  validateConfig,
} from '../config';

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
        console.log(chalk.bold('Default model:'), chalk.white(config.defaultModel));
        console.log(chalk.bold('Default duration:'), chalk.white(config.defaultDuration + 's'));
        console.log(chalk.bold('\nAvailable models:\n'));

        const models = listAvailableModels();
        models.forEach((modelName) => {
          const modelConfig = config.models[modelName];
          const isCurrent = modelName === config.defaultModel;
          console.log(`  ${isCurrent ? chalk.green('→') : ' '} ${chalk.bold(modelName)}`);
          console.log(
            `    API key: ${modelConfig.apiKey && modelConfig.apiKey !== 'your_api_key_here' ? chalk.green('Set') : chalk.red('Missing')}`
          );
          console.log(`    Base URL: ${chalk.dim(modelConfig.baseURL)}`);
          console.log(`    Model: ${chalk.dim(modelConfig.model)}`);
          console.log(
            `    Function calling: ${modelConfig.supportsFunctionCalling ? chalk.green('Supported') : chalk.red('Not supported')}`
          );
          console.log();
        });
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
