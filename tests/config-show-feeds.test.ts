/**
 * `config show` numbers the EFFECTIVE feed list — the same list `-s <index>` indexes into on
 * publish, fetch, replace and unpublish — whichever source supplied it. Before this it printed only
 * `config.feedServers`, unnumbered, so an operator on the legacy `feed.baseURLs` shape or on
 * `FEED_BASE_URLS` had no way to learn the index a write requires.
 *
 * Spawns the real entrypoint in a temp cwd so config resolution is the production one.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
// Spawn node directly with tsx's JS entry to avoid Windows .cmd shim limitations in spawnSync.
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

function runShow(configJson: Record<string, unknown> | null, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ff1-config-show-'));
  // An empty XDG_CONFIG_HOME keeps the developer's own ~/.config/ff-cli out of the run.
  const xdg = mkdtempSync(join(tmpdir(), 'ff1-config-show-xdg-'));
  try {
    if (configJson) {
      writeFileSync(join(dir, 'config.json'), `${JSON.stringify(configJson, null, 2)}\n`, 'utf-8');
    }
    const result = spawnSync(process.execPath, [tsxCli, cliEntry, 'config', 'show'], {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, XDG_CONFIG_HOME: xdg, FEED_BASE_URLS: '', ...env },
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
}

describe('config show numbers the effective feed servers', () => {
  test('feedServers are listed with the index -s expects', () => {
    const out = runShow({
      defaultDuration: 10,
      feedServers: [
        { baseUrl: 'https://feed.example.com/api/v1' },
        { baseUrl: 'http://127.0.0.1:8787/api/v1' },
      ],
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /0: https:\/\/feed\.example\.com\/api\/v1/);
    assert.match(out.stdout, /1: http:\/\/127\.0\.0\.1:8787\/api\/v1/);
    assert.match(out.stdout, /index for -s/);
  });

  test('the legacy feed.baseURLs shape is numbered the same way', () => {
    const out = runShow({
      defaultDuration: 10,
      feed: { baseURLs: ['https://a.example/api/v1', 'https://b.example/api/v1'] },
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /0: https:\/\/a\.example\/api\/v1/);
    assert.match(out.stdout, /1: https:\/\/b\.example\/api\/v1/);
  });

  test('FEED_BASE_URLS is numbered when no config file supplies feeds', () => {
    const out = runShow(
      { defaultDuration: 10 },
      { FEED_BASE_URLS: 'https://x.example/api/v1,https://y.example/api/v1' }
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /0: https:\/\/x\.example\/api\/v1/);
    assert.match(out.stdout, /1: https:\/\/y\.example\/api\/v1/);
  });
});
