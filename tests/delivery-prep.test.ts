import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { preparePlaylistForDelivery, verifyPlaylist } from '../src/utilities/playlist-verifier';
import { signPlaylist } from '../src/utilities/playlist-signer';

const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

function makePrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

describe('preparePlaylistForDelivery', () => {
  test('signs an unsigned playlist before delivery when a signing key is available', async () => {
    const playlist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;

    const result = await preparePlaylistForDelivery(playlist, true, makePrivateKeyBase64());

    assert.equal(result.valid, true);
    assert.equal(result.signed, true);
    assert.ok(result.playlist);

    const verification = await verifyPlaylist(result.playlist);
    assert.equal(verification.valid, true);
  });

  test('verifies a signed playlist before delivery without changing it', async () => {
    const playlist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const signed = await signPlaylist(playlist, makePrivateKeyBase64());

    const result = await preparePlaylistForDelivery({ ...playlist, signatures: [signed] });

    assert.equal(result.valid, true);
    assert.equal(result.signed, false);
    assert.deepEqual(result.playlist, { ...playlist, signatures: [signed] });

    const verification = await verifyPlaylist(result.playlist);
    assert.equal(verification.valid, true);
  });

  test('leaves an already signed playlist unchanged', async () => {
    const playlist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;

    const signed = await signPlaylist(playlist, makePrivateKeyBase64());
    const result = await preparePlaylistForDelivery({ ...playlist, signatures: [signed] });

    assert.equal(result.valid, true);
    assert.equal(result.signed, false);
    assert.deepEqual(result.playlist, { ...playlist, signatures: [signed] });
  });

  test('rejects structurally invalid playlists', async () => {
    const result = await preparePlaylistForDelivery(
      {
        dpVersion: '1.1.0',
        title: 'missing items',
      },
      true,
      makePrivateKeyBase64()
    );

    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /dp1:/i);
  });

  test('fails when an unsigned playlist has no signing key', async () => {
    const playlist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;

    const result = await preparePlaylistForDelivery(playlist, true);

    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /no playlist signing key/i);
  });

  test('fails when a playlist already has a broken signature envelope', async () => {
    const playlist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const signature = await signPlaylist(playlist, makePrivateKeyBase64());
    const tampered = { ...playlist, signatures: [{ ...signature, sig: 'AAAA' }] };

    const result = await preparePlaylistForDelivery(tampered, true, makePrivateKeyBase64());

    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /signature verification failed/i);
  });
});
