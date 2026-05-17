#!/usr/bin/env node

// Suppress punycode deprecation warnings from dependencies.
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
    return;
  }
  console.warn(warning.name + ': ' + warning.message);
});

import 'dotenv/config';
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { setupCommand } from './src/commands/setup';
import { statusCommand } from './src/commands/status';
import { chatCommand } from './src/commands/chat';
import { verifyCommand, validateCommand } from './src/commands/validate';
import { signCommand } from './src/commands/sign';
import { playCommand } from './src/commands/play';
import { publishCommand } from './src/commands/publish';
import { findCommand } from './src/commands/find';
import { buildCommand } from './src/commands/build';
import { configCommand } from './src/commands/config';
import { sshCommand } from './src/commands/ssh';
import { deviceCommand } from './src/commands/device';

// Load version from package.json. Try the built location first
// (dist/index.js -> ../package.json) and fall back to dev (./package.json).
let packageJsonPath = resolve(dirname(__filename), '..', 'package.json');
try {
  readFileSync(packageJsonPath, 'utf8');
} catch {
  packageJsonPath = resolve(dirname(__filename), 'package.json');
}
const { version: packageVersion, description: packageDescription } = JSON.parse(
  readFileSync(packageJsonPath, 'utf8')
);

const program = new Command();

program
  .name('ff-cli')
  .description(packageDescription)
  .version(packageVersion)
  .addHelpText(
    'after',
    `\nQuick start:\n  1) ff-cli setup\n  2) ff-cli chat\n\nDocs: https://github.com/feral-file/ff-cli\n`
  );

program.addCommand(setupCommand);
program.addCommand(statusCommand);
program.addCommand(chatCommand);
program.addCommand(verifyCommand);
program.addCommand(validateCommand);
program.addCommand(signCommand);
program.addCommand(playCommand);
program.addCommand(publishCommand);
program.addCommand(findCommand);
program.addCommand(buildCommand);
program.addCommand(configCommand);
program.addCommand(sshCommand);
program.addCommand(deviceCommand);

program.parse();
