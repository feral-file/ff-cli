import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RelayClient,
  relayURL,
  encodeRelayFrame,
  decodeRelayFrame,
} from '../src/utilities/relay-client';

class Socket extends EventTarget {
  binaryType = '';
  sent: unknown[] = [];
  closed = false;
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

test('routes by device ID and rejects credential-bearing endpoints', () => {
  assert.equal(
    relayURL('https://relay.example', 'FF1-TEST'),
    'wss://relay.example/v2/channels/FF1-TEST/connections'
  );
  for (const endpoint of [
    'https://secret@relay.example',
    'https://relay.example?topicID=x',
    'https://relay.example/api/connection',
  ]) {
    assert.throws(() => relayURL(endpoint, 'FF1-TEST'));
  }
});

test('RPC waits for device response, not the transport ACK', async () => {
  const socket = new Socket();
  const client = new RelayClient(
    'https://relay.example',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  socket.message(JSON.stringify({ type: 'hello', peers: ['player-1'] }));
  let finished = false;
  const result = request(client, 'getDeviceStatus', {}).then((value) => {
    finished = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const frame = socket.sent[0] as Uint8Array;
  const headerSize = new DataView(frame.buffer).getUint16(0);
  const header = JSON.parse(new TextDecoder().decode(frame.slice(2, 2 + headerSize)));
  const command = JSON.parse(new TextDecoder().decode(frame.slice(2 + headerSize)));
  assert.equal(command.message.command, 'ff1Envelope');
  socket.message(JSON.stringify({ type: 'ack', from: 'player-1', id: header.id }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  const response = { type: 'RPC', messageID: command.messageID, message: { ok: true } };
  const reply = encodeRelayFrame(
    { v: 2, id: 'reply-1', to: 'controller-1', from: 'player-1' },
    new TextEncoder().encode(JSON.stringify(response))
  );
  socket.message(reply.buffer);
  assert.deepEqual(await result, response);
  assert.equal(JSON.parse(socket.sent.at(-1) as string).type, 'ack');
  client.close();
});

test('disconnect rejects pending commands and malformed frames are bounded', async () => {
  const socket = new Socket();
  const client = new RelayClient(
    'https://relay.example',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  const pending = request(client, 'getDeviceStatus', {});
  client.close();
  await assert.rejects(pending, /closed/);
  assert.throws(() => decodeRelayFrame(new ArrayBuffer(65537)));
  assert.throws(() => decodeRelayFrame(new Uint8Array([0, 255, 0]).buffer));
});

test('expired queued commands are never sent after transport credit is released', async () => {
  const socket = new Socket();
  const client = new RelayClient(
    'https://relay.example',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  socket.message(JSON.stringify({ type: 'hello', peers: ['player-1'] }));
  const first = request(client, 'first', {}, 1000);
  const firstRejected = assert.rejects(first);
  await new Promise((resolve) => setImmediate(resolve));
  const second = request(client, 'expired', {}, 10);
  await assert.rejects(second, /timed out|timeout/i);
  const frame = socket.sent[0] as Uint8Array;
  const size = new DataView(frame.buffer, frame.byteOffset).getUint16(0);
  const header = JSON.parse(new TextDecoder().decode(frame.slice(2, 2 + size)));
  socket.message(JSON.stringify({ type: 'ack', from: 'player-1', id: header.id }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.filter((item) => item instanceof Uint8Array).length, 1);
  client.close();
  await firstRejected;
});

test('large transfers stay below the Worker byte ceiling with immediate ACKs', async () => {
  const socket = new Socket();
  const writes: { at: number; bytes: number }[] = [];
  const parts: Buffer[] = [];
  const originalSend = socket.send.bind(socket);
  socket.send = (data: unknown) => {
    originalSend(data);
    if (!(data instanceof Uint8Array)) {
      return;
    }
    writes.push({ at: Date.now(), bytes: data.byteLength });
    const size = new DataView(data.buffer, data.byteOffset).getUint16(0);
    const header = JSON.parse(new TextDecoder().decode(data.slice(2, 2 + size)));
    const chunk = JSON.parse(new TextDecoder().decode(data.slice(2 + size))).relayChunk;
    parts.push(Buffer.from(chunk.data, 'base64'));
    queueMicrotask(() => {
      socket.message(JSON.stringify({ type: 'ack', from: 'player-1', id: header.id }));
      if (parts.length === chunk.count) {
        const command = JSON.parse(Buffer.concat(parts).toString());
        const response = encodeRelayFrame(
          { v: 2, id: 'response', to: 'controller', from: 'player-1' },
          new TextEncoder().encode(
            JSON.stringify({ type: 'RPC', messageID: command.messageID, message: { ok: true } })
          )
        );
        socket.message(response.buffer);
      }
    });
  };
  const client = new RelayClient(
    'https://relay.example',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  socket.message(JSON.stringify({ type: 'hello', peers: ['player-1'] }));
  try {
    await request(client, 'displayPlaylist', { data: 'x'.repeat(2 * 1024 * 1024) });
    for (const start of writes) {
      const bytes = writes
        .filter((write) => write.at >= start.at && write.at < start.at + 1000)
        .reduce((sum, write) => sum + write.bytes, 0);
      assert.ok(bytes < 1048576, `one-second window exceeded limit: ${bytes}`);
    }
  } finally {
    client.close();
  }
});

/** request supplies a test endpoint validator; production uses pinned JOSE verification. */
function request(
  client: RelayClient,
  _command: string,
  body: Record<string, unknown>,
  timeout?: number
) {
  return client.requestPrepared(
    async () => ({ command: 'ff1Envelope', request: body, verify: async () => true }),
    timeout
  );
}

test('malformed reconstructed candidate payload is ACKed without closing a valid peer', async () => {
  const socket = new Socket();
  const client = new RelayClient(
    'https://relay.test',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  socket.message(JSON.stringify({ type: 'hello', peers: ['attacker', 'ff1'] }));
  for (let index = 0; index < 2; index++) {
    const payload = new TextEncoder().encode(
      JSON.stringify({ relayChunk: { id: 'bad-transfer', index, count: 2, data: btoa('x') } })
    );
    const frame = encodeRelayFrame(
      { v: 2, id: `bad-${index}`, to: 'cli', from: 'attacker' },
      payload
    );
    socket.message(frame.buffer);
  }
  assert.equal(socket.closed, false);
  assert.equal(socket.sent.length, 2);
  client.close();
});

test('discovers FF1 joining after another controller without resealing or resending', async () => {
  const socket = new Socket();
  socket.send = (data: unknown) => {
    socket.sent.push(data);
    if (!(data instanceof Uint8Array)) {
      return;
    }
    const length = new DataView(data.buffer, data.byteOffset).getUint16(0);
    const header = JSON.parse(new TextDecoder().decode(data.slice(2, 2 + length))) as {
      to: string;
      id: string;
    };
    const body = JSON.parse(new TextDecoder().decode(data.slice(2 + length))) as {
      messageID: string;
    };
    queueMicrotask(() => {
      socket.message(JSON.stringify({ type: 'ack', from: header.to, id: header.id }));
      if (header.to === 'ff1') {
        const frame = encodeRelayFrame(
          { v: 2, id: 'verified', to: 'cli', from: 'ff1' },
          new TextEncoder().encode(JSON.stringify({ type: 'RPC', messageID: body.messageID }))
        );
        socket.message(frame.buffer);
      }
    });
  };
  const client = new RelayClient(
    'https://relay.test',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  socket.message(JSON.stringify({ type: 'hello', peers: ['other-controller'] }));
  let seals = 0;
  const result = client.requestPrepared(() => {
    seals++;
    return Promise.resolve({
      command: 'ff1Envelope',
      request: { jwe: 'opaque' },
      verify: () => Promise.resolve(true),
    });
  }, 2000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.message(JSON.stringify({ type: 'peer_connected', connectionId: 'ff1' }));
  await result;
  assert.equal(seals, 1);
  assert.equal(socket.sent.filter((data) => data instanceof Uint8Array).length, 2);
  client.close();
});
