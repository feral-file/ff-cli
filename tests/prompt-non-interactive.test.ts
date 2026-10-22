/**
 * A prompt with no terminal to ask on must fail loudly.
 *
 * Agents and CI run ff-cli with stdin that is not a TTY. Before this guard, a
 * prompt in that state either read end-of-input and let the process exit 0
 * having done nothing (`find <url>` printed "Build playlist? [Y/n]" and quit),
 * or blocked forever on an open pipe. Piped answers must keep working.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';

import { createPrompt, isNonInteractiveError, promptYesNo } from '../src/commands/helpers/prompt';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

describe('createPrompt without a terminal', () => {
  test('rejects with the question and the hint when input ends unanswered', async () => {
    const input = new PassThrough();
    const prompt = createPrompt('Re-run with -y.', { input });
    const asked = promptYesNo(prompt.ask, 'Build playlist with 32 tokens?', true);
    input.end();
    await assert.rejects(asked, (error: unknown) => {
      assert.ok(isNonInteractiveError(error), 'must be a NonInteractiveError');
      assert.match((error as Error).message, /Build playlist with 32 tokens\?/);
      assert.match((error as Error).message, /stdin is not a terminal/);
      assert.match((error as Error).message, /Re-run with -y\./);
      return true;
    });
  });

  test('rejects when an open pipe never answers', async () => {
    const input = new PassThrough();
    const prompt = createPrompt('Re-run with -y.', { input, answerTimeoutMs: 50 });
    await assert.rejects(() => prompt.ask('Pick one: '), /needs an answer, and none came/);
    input.destroy();
  });

  test('a piped answer still works', async () => {
    const input = new PassThrough();
    const prompt = createPrompt(undefined, { input, answerTimeoutMs: 5_000 });
    const asked = promptYesNo(prompt.ask, 'Delete?', false);
    input.write('y\n');
    assert.equal(await asked, true);
    prompt.close();
  });

  test('close() is safe when nothing was asked', () => {
    const prompt = createPrompt();
    assert.doesNotThrow(() => prompt.close());
  });
});

describe('find on a plain web page', () => {
  test('names `ff-cli play` as the way to show it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ff-cli-find-page-'));
    try {
      const run = spawnSync(process.execPath, [tsxCli, cliEntry, 'find', 'https://example.com'], {
        cwd,
        env: { ...process.env, XDG_CONFIG_HOME: join(cwd, '.xdg') },
        encoding: 'utf-8',
      });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, /ff-cli play "https:\/\/example\.com"/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
