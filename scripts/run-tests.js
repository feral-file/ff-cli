'use strict';

/**
 * Runs every `*.test.ts` under `tests/` (including nested dirs) via tsx's test runner.
 * Shell globs are not portable; a quoted pattern such as tests slash-glob `.test.ts`
 * is passed literally to tsx and fails.
 */

const { spawnSync } = require('child_process');
const { readdirSync, statSync } = require('fs');
const { join } = require('path');

/**
 * collectTestFiles walks `dir` recursively and returns paths to `*.test.ts` files.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function collectTestFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const root = join(__dirname, '..');
const testDir = join(root, 'tests');
const files = collectTestFiles(testDir).sort();

if (files.length === 0) {
  console.error('No *.test.ts files found under tests/.');
  process.exit(1);
}

const tsxCli = join(root, 'node_modules/tsx/dist/cli.mjs');
const result = spawnSync(process.execPath, [tsxCli, '--test', ...files], {
  stdio: 'inherit',
  cwd: root,
  // Tests spawn the CLI with gated commands; the required-version read must
  // never leave the machine. A refused loopback port fails at once and the
  // check fails open (src/utilities/required-version.ts).
  env: { REMOTE_CONFIG_URL: 'http://127.0.0.1:1', ...process.env },
});

process.exit(result.status === null ? 1 : result.status);
