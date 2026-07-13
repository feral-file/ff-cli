import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decryptHandoffMessage,
  encryptHandoffMessage,
  exportHandoffPublicJwk,
  generateHandoffKeyPair,
  handoffVerificationCode,
} from '../src/utilities/handoff-crypto';

describe('handoff crypto', () => {
  test('creates a stable out-of-band key commitment', () => {
    const code = handoffVerificationCode({
      channelId: 'ch_test',
      minterPublicKeyJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
        y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
      },
    });

    assert.equal(code, '941E-AAAA-23EB');
  });

  test('encrypts and decrypts a channel-bound topic payload', async () => {
    const sender = await generateHandoffKeyPair();
    const recipient = await generateHandoffKeyPair();
    const senderPublicKeyJwk = await exportHandoffPublicJwk(sender.publicKey);
    const recipientPublicKeyJwk = await exportHandoffPublicJwk(recipient.publicKey);
    const plaintext = {
      v: 1,
      type: 'ff1_topic_handoff',
      channelId: 'ch_test',
      deviceId: 'FF1-TEST1234',
      topicId: 'topic-secret',
      sentAt: '2026-07-10T00:00:00.000Z',
    };

    const encrypted = await encryptHandoffMessage({
      privateKey: sender.privateKey,
      senderPublicKeyJwk,
      peerPublicKeyJwk: recipientPublicKeyJwk,
      channelId: 'ch_test',
      messageId: 'msg_test',
      sender: 'browser',
      recipient: 'minter',
      plaintext,
    });
    const decrypted = await decryptHandoffMessage({
      privateKey: recipient.privateKey,
      peerPublicKeyJwk: senderPublicKeyJwk,
      channelId: 'ch_test',
      seq: 1,
      message: { ...encrypted, seq: 1 },
    });

    assert.deepEqual(decrypted, plaintext);
  });

  test('rejects an envelope rebound to another channel', async () => {
    const sender = await generateHandoffKeyPair();
    const recipient = await generateHandoffKeyPair();
    const senderPublicKeyJwk = await exportHandoffPublicJwk(sender.publicKey);
    const recipientPublicKeyJwk = await exportHandoffPublicJwk(recipient.publicKey);
    const encrypted = await encryptHandoffMessage({
      privateKey: sender.privateKey,
      peerPublicKeyJwk: recipientPublicKeyJwk,
      channelId: 'ch_one',
      messageId: 'msg_test',
      sender: 'browser',
      recipient: 'minter',
      plaintext: { v: 1 },
    });

    await assert.rejects(
      decryptHandoffMessage({
        privateKey: recipient.privateKey,
        peerPublicKeyJwk: senderPublicKeyJwk,
        channelId: 'ch_two',
        seq: 1,
        message: { ...encrypted, senderPublicKeyJwk, seq: 1 },
      }),
      /channel binding mismatch/
    );
  });
});
