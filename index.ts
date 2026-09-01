#!/usr/bin/env node

// Suppress punycode deprecation warnings from dependencies.
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
    return;
  }
  console.warn(warning.name + ': ' + warning.message);
});

import 'dotenv/config';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'net';
import { Command } from 'commander';

// Node's happy-eyeballs gives each address-family connect attempt 250 ms by
// default. That is shorter than a single round trip to a far-away API host
// (e.g. api.raster.art from Asia is ~250 ms RTT), so on networks with broken
// IPv6 the IPv4 attempt gets cut off mid-handshake, the IPv6 fallback has no
// route, and fetch fails or stalls intermittently (#97). 2.5 s per attempt is
// still fast-failing but no longer races the speed of light.
setDefaultAutoSelectFamilyAttemptTimeout(2500);
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { setupCommand } from './src/commands/setup';
import { statusCommand } from './src/commands/status';
import { verifyCommand, validateCommand } from './src/commands/validate';
import { signCommand } from './src/commands/sign';
import { playCommand } from './src/commands/play';
import { publishCommand } from './src/commands/publish';
import { findCommand } from './src/commands/find';
import { buildCommand } from './src/commands/build';
import { enrichCommand } from './src/commands/enrich';
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
    `\nQuick start:\n  1) ff-cli setup\n  2) ff-cli play <url-or-playlist>\n\nDocs: https://github.com/feral-file/ff-cli\n`
  );

program.addCommand(setupCommand);
program.addCommand(statusCommand);
program.addCommand(verifyCommand);
program.addCommand(validateCommand);
program.addCommand(signCommand);
program.addCommand(playCommand);
program.addCommand(publishCommand);
program.addCommand(findCommand);
program.addCommand(enrichCommand);
program.addCommand(buildCommand);
program.addCommand(configCommand);
program.addCommand(sshCommand);
program.addCommand(deviceCommand);

program.parse();
