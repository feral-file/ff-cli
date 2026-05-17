import { Command } from 'commander';
import chalk from 'chalk';
import * as readline from 'readline';
import { getConfig, listAvailableModels, validateConfig } from '../config';
import { buildPlaylist } from '../main';
import { displayPlaylistSummary } from './helpers/playlist-display';

// chat keeps an inline readline instance — historySize and the closed-flag
// lifecycle (Ctrl+C → close → graceful exit) are specific to this command
// and don't belong in the shared createPrompt() helper.

export const chatCommand = new Command('chat')
  .description('Start an interactive chat to build playlists using natural language')
  .argument('[content]', 'Optional: Direct chat content (non-interactive mode)')
  .option('-o, --output <filename>', 'Output filename for the playlist', 'playlist.json')
  .option(
    '-m, --model <name>',
    'AI model to use (claude, grok, gpt, gemini) - defaults to config setting'
  )
  .option('-d, --device <name>', 'Target FF1 device name (defaults to first configured device)')
  .option('-v, --verbose', 'Show detailed technical output of function calls', false)
  .action(
    async (
      content: string | undefined,
      options: { output: string; model?: string; device?: string; verbose: boolean }
    ) => {
      try {
        const config = getConfig();
        const availableModels = listAvailableModels();

        if (options.model && !availableModels.includes(options.model)) {
          console.error(chalk.red(`Invalid model: "${options.model}"`));
          console.log(chalk.yellow(`Available models: ${availableModels.join(', ')}`));
          process.exit(1);
        }

        const modelName = options.model || config.defaultModel;

        const validation = validateConfig(modelName);
        if (!validation.valid) {
          console.error(chalk.red('Configuration error:'));
          validation.errors.forEach((error) => {
            console.error(chalk.red(`  • ${error}`));
          });
          console.log(chalk.yellow('\nRun: ff-cli setup\n'));
          process.exit(1);
        }

        // Non-interactive mode: content was passed as a positional argument.
        if (content) {
          console.log(chalk.blue('\nff-cli chat (non-interactive)\n'));
          console.log(chalk.dim(`Model: ${modelName}\n`));
          console.log(chalk.yellow('Request:'), content);
          console.log();

          try {
            const result = await buildPlaylist(content, {
              verbose: options.verbose,
              outputPath: options.output,
              modelName: modelName,
              interactive: false,
              deviceName: options.device,
            });

            if (result && result.playlist) {
              console.log(chalk.green('\nPlaylist saved'));
              console.log(chalk.dim(`  Title: ${result.playlist.title}`));
              console.log(chalk.dim(`  Items: ${result.playlist.items?.length || 0}`));
              console.log(chalk.dim(`  Output: ${options.output}\n`));
            }

            process.exit(0);
          } catch (error) {
            console.error(chalk.red('\nError:'), (error as Error).message);
            if (options.verbose) {
              console.error(chalk.dim((error as Error).stack));
            }
            process.exit(1);
          }
        }

        // Interactive mode.
        console.log(chalk.blue('\nff-cli chat\n'));
        console.log(chalk.dim('Describe the playlist you want. Ctrl+C to exit.'));
        console.log(chalk.dim(`Model: ${modelName}\n`));
        console.log(chalk.dim('Examples:'));
        console.log(chalk.dim('  • Get 3 works from reas.eth'));
        console.log(chalk.dim('  • Get 3 works from einstein-rosen.tez'));
        console.log(
          chalk.dim(
            '  • Get tokens 52932,52457 from Ethereum contract 0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0'
          )
        );
        console.log(chalk.dim('  • Get 3 from Unsupervised'));
        console.log(chalk.dim('  Tip: add -v to see tool calls'));
        console.log();

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          historySize: 100,
        });
        let closed = false;

        rl.on('close', () => {
          closed = true;
        });

        rl.on('SIGINT', () => {
          rl.close();
        });

        const ask = async (): Promise<string> =>
          new Promise((resolve) => {
            if (closed) {
              resolve('');
              return;
            }
            rl.question(chalk.yellow('You: '), (answer: string) => {
              resolve(answer.trim());
            });
          });

        while (!closed) {
          const userInput = await ask();

          if (closed) {
            break;
          }

          if (!userInput) {
            continue;
          }

          console.log();

          try {
            const result = await buildPlaylist(userInput, {
              verbose: options.verbose,
              outputPath: options.output,
              modelName: modelName,
              deviceName: options.device,
            });

            // Skip the playlist summary for send actions: the device send path
            // already emits its own confirmation, and re-printing here would
            // imply the playlist was only built (not sent).
            if (options.verbose) {
              console.log(chalk.dim(`\n[DEBUG] result.sentToDevice: ${result?.sentToDevice}`));
              console.log(chalk.dim(`[DEBUG] result.action: ${result?.action}`));
            }
            if (
              result &&
              result.playlist &&
              result.action !== 'send_playlist' &&
              !result.sentToDevice
            ) {
              displayPlaylistSummary(result.playlist, options.output);
            }
          } catch (error) {
            console.error(chalk.red('Error:'), (error as Error).message);
            if (options.verbose) {
              console.error(chalk.dim((error as Error).stack));
            }
            console.log();
          }
        }

        if (closed) {
          throw new Error('readline was closed');
        }
      } catch (error) {
        if ((error as Error).message !== 'readline was closed') {
          console.error(chalk.red('\nError:'), (error as Error).message);
          if (process.env.DEBUG) {
            console.error(chalk.dim((error as Error).stack));
          }
        }
        console.log(chalk.blue('\nGoodbye\n'));
        process.exit(0);
      }
    }
  );
