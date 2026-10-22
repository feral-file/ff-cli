import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, test } from 'node:test';
import { HandoffReceiver, parseHandoffPayload } from '../src/utilities/handoff-client';
import {
  encryptHandoffMessage,
  exportHandoffPublicJwk,
  generateHandoffKeyPair,
} from '../src/utilities/handoff-crypto';

describe('HandoffReceiver', () => {
  test('receives only the selected device topic and closes the channel', async () => {
    let minterPublicKeyJwk: webcrypto.JsonWebKey | undefined;
    let closed = false;
    const browser = await generateHandoffKeyPair();
    const browserPublicKeyJwk = await exportHandoffPublicJwk(browser.publicKey);

    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === '/v1/channels' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          minterPublicKeyJwk: webcrypto.JsonWebKey;
        };
        minterPublicKeyJwk = body.minterPublicKeyJwk;
        return Response.json(
          {
            channelId: 'ch_test',
            minterToken: 'mt_test',
            pairingToken: 'pt_test',
            shortCode: '123456',
            expiresAt: '2026-07-10T01:00:00Z',
            qrPayload: {},
          },
          { status: 201 }
        );
      }
      if (url.pathname.endsWith('/messages')) {
        assert.ok(minterPublicKeyJwk);
        const encrypted = await encryptHandoffMessage({
          privateKey: browser.privateKey,
          senderPublicKeyJwk: browserPublicKeyJwk,
          peerPublicKeyJwk: minterPublicKeyJwk,
          channelId: 'ch_test',
          messageId: 'msg_test',
          sender: 'browser',
          recipient: 'minter',
          plaintext: {
            v: 1,
            type: 'ff1_topic_handoff',
            channelId: 'ch_test',
            deviceId: 'FF1-SKYZ2E3A',
            deviceName: 'Office',
            topicId: 'topic-secret',
            sentAt: '2026-07-10T00:00:00Z',
          },
        });
        return Response.json({
          channelId: 'ch_test',
          expiresAt: '2026-07-10T01:00:00Z',
          messages: [{ ...encrypted, seq: 1 }],
        });
      }
      if (url.pathname === '/v1/channels/ch_test' && init?.method === 'DELETE') {
        closed = true;
        return Response.json({ status: 'closed' });
      }
      return new Response('not found', { status: 404 });
    };

    const receiver = await HandoffReceiver.create({
      baseUrl: 'https://handoff.example',
      fetchFn,
    });
    const payload = await receiver.receiveHandoff({
      expectedDeviceId: 'ff1-skyz2e3a',
      pollIntervalMs: 1,
      maxWaitMs: 100,
    });
    await receiver.close();

    assert.equal(receiver.shortCode, '123456');
    assert.equal(payload.topicId, 'topic-secret');
    assert.equal(closed, true);
  });
});

describe('parseHandoffPayload (v1 topic handoff only)', () => {
  const base = {
    v: 1,
    type: 'ff1_topic_handoff',
    channelId: 'ch_test',
    deviceId: 'FF1-FIXTURE1',
    topicId: 'topic-secret',
    sentAt: '2026-01-01T00:00:00Z',
  };

  test('accepts a topic handoff for the selected device, in any letter case', () => {
    assert.equal(parseHandoffPayload(base, 'ch_test', 'ff1-fixture1').topicId, 'topic-secret');
  });

  test('rejects another device, another channel, or an empty topic', () => {
    for (const bad of [
      { ...base, deviceId: 'FF1-OTHER001' },
      { ...base, channelId: 'ch_other' },
      { ...base, topicId: ' ' },
    ]) {
      assert.throws(() => parseHandoffPayload(bad, 'ch_test', 'FF1-FIXTURE1'));
    }
  });

  test('rejects the retired v2 controller handoff', () => {
    assert.throws(() =>
      parseHandoffPayload(
        { ...base, v: 2, type: 'ff1_controller_handoff', profile: {} },
        'ch_test',
        'FF1-FIXTURE1'
      )
    );
  });
});
