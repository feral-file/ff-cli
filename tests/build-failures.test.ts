/**
 * build reports everything the caller asked for that did not happen.
 *
 * A build that drops a requirement, or whose send to a device fails, still
 * saves the playlist it collected, but it must not look like a clean success:
 * an agent trusting the exit code would otherwise hand over a partial
 * playlist, or say a playlist is on the wall when the send failed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { buildPlaylistDirect, validateRequirements } from '../src/main';

const require = createRequire(import.meta.url);
const utilities = require('../src/utilities');

// Built by the real item builder so it passes the same DP-1 validation a fetched feed item would.
const item = utilities.playlistBuilder.buildUrlItem('https://example.com/good.png', 10);

describe('build failures', () => {
  let dir: string;
  const originalCwd = process.cwd();
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalFetchFeed = utilities.feedFetcher.fetchFeedPlaylistDirect;
  const originalConsole = { log: console.log, error: console.error, warn: console.warn };

  before(() => {
    // The build prints progress straight to stdout, which this process shares
    // with the test runner's reporter; captured output keeps that stream clean.
    console.log = () => undefined;
    console.error = () => undefined;
    console.warn = () => undefined;
    // Isolate config: no signing key and no devices, whatever the machine has.
    dir = mkdtempSync(join(tmpdir(), 'ff-cli-build-failures-'));
    process.chdir(dir);
    process.env.XDG_CONFIG_HOME = join(dir, '.xdg');
    utilities.feedFetcher.fetchFeedPlaylistDirect = async (name: string) =>
      name === 'Good'
        ? { success: true, items: [item] }
        : { success: false, error: `No playlist named "${name}"` };
  });

  after(() => {
    Object.assign(console, originalConsole);
    utilities.feedFetcher.fetchFeedPlaylistDirect = originalFetchFeed;
    process.chdir(originalCwd);
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('a requirement that finds nothing is a failure, and the rest is still saved', async () => {
    const result = await buildPlaylistDirect(
      {
        requirements: [
          { type: 'fetch_feed', playlistName: 'Good', quantity: 1 },
          { type: 'fetch_feed', playlistName: 'Missing', quantity: 1 },
        ],
      },
      { outputPath: join(dir, 'partial.json') }
    );
    assert.equal(result.playlist?.items.length, 1);
    assert.deepEqual(result.failures, ['Requirement 2: no items found']);
  });

  test('a failed send to the named device is a failure', async () => {
    const result = await buildPlaylistDirect(
      {
        requirements: [{ type: 'fetch_feed', playlistName: 'Good', quantity: 1 }],
        playlistSettings: { deviceName: 'no-such-device' },
      },
      { outputPath: join(dir, 'send.json') }
    );
    assert.equal(result.failures?.length, 1, JSON.stringify(result.failures));
    assert.match(result.failures?.[0] ?? '', /^Send to device: /);
  });

  test('a full success reports no failures', async () => {
    const result = await buildPlaylistDirect(
      { requirements: [{ type: 'fetch_feed', playlistName: 'Good', quantity: 1 }] },
      { outputPath: join(dir, 'ok.json') }
    );
    assert.deepEqual(result.failures, []);
  });
});

describe('requirement validation', () => {
  test('an unknown type lists the valid ones', () => {
    assert.throws(
      () => validateRequirements([{ type: 'wallet' } as never]),
      /invalid type "wallet"\. Valid types: build_playlist, query_address, fetch_feed, feral_file_artwork/
    );
  });
});
