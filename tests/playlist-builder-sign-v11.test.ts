import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createRequire } from 'module';

import { verifyPlaylist } from '../src/utilities/playlist-verifier';

const require = createRequire(import.meta.url);
/** buildDP1Playlist signs via config-backed `playlist.privateKey`; keep import path aligned with CLI. */
const { buildDP1Playlist } = require('../src/utilities/playlist-builder.js') as {
  buildDP1Playlist: (params: {
    items: Array<Record<string, unknown>>;
    title: string;
    slug: string;
    deterministicMode: boolean;
    fixedTimestamp: string;
    fixedId: string;
  }) => Promise<Record<string, unknown>>;
};

const deterministicParams = {
  title: 'Builder hex key test',
  slug: 'builder-hex-key',
  deterministicMode: true,
  fixedTimestamp: '2026-06-01T12:00:00.000Z',
  fixedId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
} as const;

const minimalItem = {
  id: 'ad5de50a-6a0d-4b61-8ef9-7b0f0d1d5e9b',
  source: 'https://example.com/art.mp4',
  duration: 10,
  license: 'token',
};

describe('buildDP1Playlist signing (v1.1.0)', () => {
  test('embeds signatures[] when config private key is PKCS#8 hex (no 0x prefix)', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    await withPlaylistConfig('ff1-builder-hex-', der.toString('hex'), async () => {
      const playlist = await buildDP1Playlist({
        items: [minimalItem],
        ...deterministicParams,
      });
      assert.ok(Array.isArray(playlist.signatures));
      assert.equal(playlist.signatures?.length, 1);
      const signed = playlist as Record<string, unknown>;
      assert.equal(typeof (signed.signatures as unknown[])[0], 'object');
      const vr = await verifyPlaylist(signed);
      assert.equal(vr.valid, true, vr.error);
    });
  });

  test('embeds signatures[] when config private key is PKCS#8 hex with 0x prefix', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const prefixed = `0x${der.toString('hex')}`;
    await withPlaylistConfig('ff1-builder-0x-', prefixed, async () => {
      const playlist = await buildDP1Playlist({
        items: [minimalItem],
        ...deterministicParams,
      });
      assert.ok(Array.isArray(playlist.signatures));
      assert.equal(playlist.signatures?.length, 1);
      const vr = await verifyPlaylist(playlist as Record<string, unknown>);
      assert.equal(vr.valid, true, vr.error);
    });
  });

  test('an item carrying an inline manifest signs and verifies', async () => {
    // An inline manifest has no refHash — its integrity comes entirely from the
    // playlist signature, so it must sit inside the canonical signing payload.
    // Schema validation cannot see the failure mode here: a manifest silently
    // excluded from (or breaking) the payload hash would still validate.
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    await withPlaylistConfig('ff1-builder-manifest-', der.toString('hex'), async () => {
      const playlist = await buildDP1Playlist({
        items: [
          {
            ...minimalItem,
            inlineManifest: {
              refVersion: '1.1.0',
              id: 'c0ffee00-dead-4bee-8fad-1234567890ab',
              created: '2026-06-01T12:00:00.000Z',
              locale: 'en',
              metadata: {
                title: 'Chapter #1',
                description: 'An essay in motion.',
                artists: [{ name: 'Larva Labs' }],
                thumbnails: { default: { uri: 'https://example.com/still.png' } },
              },
            },
          },
        ],
        ...deterministicParams,
      });

      const items = playlist.items as Array<Record<string, unknown>>;
      const manifest = items[0].inlineManifest as Record<string, unknown>;
      assert.equal(manifest.refVersion, '1.1.0');
      const vr = await verifyPlaylist(playlist as Record<string, unknown>);
      assert.equal(vr.valid, true, vr.error);
    });
  });
});

/**
 * Isolates cwd and drops a cwd-local `config.json` so `getPlaylistConfig` picks up playlist.privateKey
 * the same way the CLI does for build flows.
 */
async function withPlaylistConfig(
  namePrefix: string,
  playlistPrivateKey: string,
  fn: () => Promise<void>
): Promise<void> {
  const dir = join(tmpdir(), `${namePrefix}${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const prevCwd = process.cwd();
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ playlist: { privateKey: playlistPrivateKey, role: 'agent' } }, null, 2),
    'utf-8'
  );
  try {
    process.chdir(dir);
    await fn();
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}
