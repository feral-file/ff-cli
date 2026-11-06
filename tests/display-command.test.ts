/**
 * `display` puts art on an FF1; `play` is its retired name, kept as a hidden alias.
 *
 * The verb for art is display, not play (B&F weekly 2026-11-03; Canon reference/naming-brand.md §3.4):
 * people play games and video, they display art. Existing scripts and agents still call `ff-cli play`
 * and `find -p` / `--play` / `--no-play`, so those keep working, but help never lists them. Help is
 * where people and agents learn the CLI's words, and listing the old spelling would teach it again.
 * These tests pin both halves: the old spellings run the same code, and no help screen says "play".
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

// The retired verb as a whole word. "playlist" is the DP-1 noun and stays.
const PLAY_WORD = /\bplay\b/i;

// A wallet address is a discovery input: `display` redirects it to `find` and exits 1 before any
// config, network or device access, so it exercises the command's own action offline.
const WALLET = '0xf3860788d1597cecf938424baabe976fac87dc26';

let cwd: string;

/** runCli runs the CLI from source in an isolated working and config directory. */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, '.xdg') },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

before(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ff-cli-display-command-'));
});

after(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('display command', () => {
  test('top-level help lists display and never play', () => {
    const run = runCli(['--help']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^ {2}display \[options\] <source>/m);
    assert.match(run.stdout, /ff-cli display <url-or-playlist>/);
    assert.doesNotMatch(run.stdout, PLAY_WORD);
  });

  test('display --help names display in its usage and never play', () => {
    const run = runCli(['display', '--help']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Usage: ff-cli display \[options\] <source>$/m);
    assert.doesNotMatch(run.stdout, PLAY_WORD);
  });

  test('play --help and help play print the display help', () => {
    const display = runCli(['display', '--help']);
    assert.equal(runCli(['play', '--help']).stdout, display.stdout);
    assert.equal(runCli(['help', 'play']).stdout, display.stdout);
  });

  test('play runs the display action', () => {
    const display = runCli(['display', WALLET]);
    const play = runCli(['play', WALLET]);
    assert.equal(display.status, 1, display.stdout + display.stderr);
    assert.match(display.stderr, /`display` sends an exact playlist or media URL/);
    assert.match(display.stdout, /ff-cli find "0x[0-9a-f]+" --display -y/);
    assert.deepEqual(play, display);
  });
});

describe('find --display', () => {
  test('find --help lists --display and --no-display and never play', () => {
    const run = runCli(['find', '--help']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^ {2}--display\b/m);
    assert.match(run.stdout, /^ {2}--no-display\b/m);
    assert.doesNotMatch(run.stdout, /-p,/);
    assert.doesNotMatch(run.stdout, PLAY_WORD);
  });

  // A plain web page is not an artwork lookup, so `find` exits 1 at its first check; an option
  // commander does not know would instead fail parsing with "unknown option".
  for (const flag of ['--display', '--no-display', '-p', '--play', '--no-play']) {
    test(`find accepts ${flag}`, () => {
      const run = runCli(['find', 'https://example.com', flag]);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.doesNotMatch(run.stderr, /unknown option/);
      assert.match(run.stderr, /ff-cli display "https:\/\/example\.com"/);
    });
  }
});
