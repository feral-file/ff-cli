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

/**
 * A built playlist that is signed but declares no curator cannot be published: the feed authorizes a
 * create by matching a signature's kid against the document's own curators[], and re-declaring one after
 * the fact would invalidate the signature. So the builder has to write the declaration before it signs,
 * and these cases pin that ordering — verifying the signature is what proves curators[] was covered by it.
 */
describe('buildDP1Playlist curator declaration', () => {
  test('declares the signing key as a curator, inside the signed payload', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const material = der.toString('base64');
    await withPlaylistConfig('ff1-builder-curator-', material, async () => {
      const playlist = await buildDP1Playlist({ items: [minimalItem], ...deterministicParams });

      const curators = playlist.curators as Array<{ name?: string; key?: string }> | undefined;
      assert.ok(Array.isArray(curators), 'builder should declare curators[]');
      const kid = (playlist.signatures as Array<{ kid: string }>)[0].kid;
      assert.ok(
        curators.some((c) => c.key === kid),
        `curators[] should declare the signing kid ${kid}, got ${JSON.stringify(curators)}`
      );
      // DP-1 requires a name alongside the key.
      assert.equal(typeof curators[0].name, 'string');
      assert.ok((curators[0].name as string).length > 0);

      // The decisive assertion: the signature still verifies, so curators[] was present when signing.
      const vr = await verifyPlaylist(playlist);
      assert.equal(vr.valid, true, vr.error);
    });
  });

  test('uses the configured curator name when one is set', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const dir = join(tmpdir(), `ff1-builder-curator-name-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const prevCwd = process.cwd();
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        playlist: { privateKey: der.toString('base64'), role: 'agent', curatorName: 'Studio Nine' },
      }),
      'utf-8'
    );
    try {
      process.chdir(dir);
      const playlist = await buildDP1Playlist({ items: [minimalItem], ...deterministicParams });
      const curators = playlist.curators as Array<{ name?: string; key?: string }>;
      assert.equal(curators[0].name, 'Studio Nine');
      const vr = await verifyPlaylist(playlist);
      assert.equal(vr.valid, true, vr.error);
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `ff-cli setup` writes config.json.example through verbatim apart from the key and role, so any sample
 * value left in the playlist block reaches real published documents — and this one is a public name
 * inside the signed curators[]. The placeholder must therefore lose to the environment, not win over it.
 */
describe('buildDP1Playlist curator name resolution', () => {
  test('ignores the sample placeholder and honours PLAYLIST_CURATOR_NAME', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const dir = join(tmpdir(), `ff1-builder-placeholder-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const prevCwd = process.cwd();
    const prevName = process.env.PLAYLIST_CURATOR_NAME;
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        playlist: {
          privateKey: der.toString('base64'),
          role: 'agent',
          curatorName: 'YOUR_CURATOR_NAME',
        },
      }),
      'utf-8'
    );
    try {
      process.chdir(dir);
      process.env.PLAYLIST_CURATOR_NAME = 'Env Curator';
      const playlist = await buildDP1Playlist({ items: [minimalItem], ...deterministicParams });
      const curators = playlist.curators as Array<{ name?: string; key?: string }>;
      assert.equal(curators[0].name, 'Env Curator');
      assert.notEqual(curators[0].name, 'YOUR_CURATOR_NAME');
    } finally {
      process.chdir(prevCwd);
      if (prevName === undefined) {
        delete process.env.PLAYLIST_CURATOR_NAME;
      } else {
        process.env.PLAYLIST_CURATOR_NAME = prevName;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
