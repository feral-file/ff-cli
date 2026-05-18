import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { sendPreparedPlaylistToDevice } from '../src/main';
import { preparePlaylistForDelivery, verifyPlaylist } from '../src/utilities/playlist-verifier';
import { signPlaylist } from '../src/utilities/playlist-signer';

const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

function makePrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

describe('sendPreparedPlaylistToDevice', () => {
  test('sends the signed delivery payload for an unsigned playlist', async () => {
    const playlist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const privateKey = makePrivateKeyBase64();
    let deliveredPlaylist: Record<string, unknown> | undefined;
    let deliveredDevice: string | undefined;

    const result = await sendPreparedPlaylistToDevice(playlist as never, {
      preparePlaylistForDelivery,
      privateKey,
      resolveDeviceName: () => 'kitchen',
      sendToDevice: async (payload, deviceName) => {
        deliveredPlaylist = payload as Record<string, unknown>;
        deliveredDevice = deviceName;
        return { success: true, deviceName, device: 'http://127.0.0.1:1111' };
      },
    });

    assert.equal(result.success, true);
    assert.equal(deliveredDevice, 'kitchen');
    assert.ok(deliveredPlaylist);
    const verification = await verifyPlaylist(deliveredPlaylist);
    assert.equal(verification.valid, true);
    assert.equal(result.playlist, deliveredPlaylist);
  });

  test('fails closed when the input already has a broken signature envelope', async () => {
    const playlist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const privateKey = makePrivateKeyBase64();
    const signature = await signPlaylist(playlist, privateKey);
    const broken = { ...playlist, signatures: [{ ...signature, sig: 'AAAA' }] };
    let sendCalled = false;

    const result = await sendPreparedPlaylistToDevice(broken as never, {
      preparePlaylistForDelivery,
      privateKey,
      resolveDeviceName: () => 'kitchen',
      sendToDevice: async () => {
        sendCalled = true;
        return { success: true };
      },
    });

    assert.equal(result.success, false);
    assert.equal(sendCalled, false);
    assert.match(result.error ?? '', /signature verification failed/i);
  });
});
