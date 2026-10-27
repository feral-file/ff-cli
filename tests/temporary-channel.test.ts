import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TemporaryChannel } from '../src/utilities/temporary-channel';
import { encodeRelayFrame } from '../src/utilities/relay-client';

class Socket extends EventTarget {
  binaryType = '';
  sent: unknown[] = [];
  closed = false;
  send(value: unknown) {
    this.sent.push(value);
  }
  close() {
    this.closed = true;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

test('temporary hello precedes QR readiness; targeted receipt is not result approval', async () => {
  const socket = new Socket();
  const channel = new TemporaryChannel(
    'https://relay.test',
    undefined,
    1000,
    () => socket as unknown as WebSocket
  );
  assert.match(channel.channelId, /^[0-9a-f-]{36}$/);
  socket.message(JSON.stringify({ type: 'hello', connectionId: 'secondary', peers: ['owner'] }));
  await channel.ready;
  assert.equal(channel.connectionId, 'secondary');
  let delivered = 0;
  channel.onPayload = () => {
    // Credit has already been returned before the endpoint validator is called.
    const last = JSON.parse(socket.sent.at(-1) as string) as { type: string };
    assert.equal(last.type, 'ack');
    delivered++;
  };
  const sent = channel.send('owner', new Uint8Array([1, 2, 3]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const frame = socket.sent[0] as Uint8Array;
  const length = new DataView(frame.buffer).getUint16(0);
  const header = JSON.parse(new TextDecoder().decode(frame.slice(2, 2 + length))) as {
    id: string;
    to: string;
  };
  assert.equal(header.to, 'owner');
  socket.message(JSON.stringify({ type: 'ack', from: 'owner', id: header.id }));
  await sent;
  assert.equal(delivered, 0);
  const result = encodeRelayFrame(
    { v: 2, id: 'result', from: 'owner', to: 'secondary' },
    new Uint8Array([9])
  );
  socket.message(result.buffer);
  assert.equal(delivered, 1);
  channel.close();
  assert.equal(socket.closed, true);
});

test('temporary timeout and cancellation are local failures, with no implicit reconnect', async () => {
  const socket = new Socket();
  const channel = new TemporaryChannel(
    'https://relay.test',
    undefined,
    10,
    () => socket as unknown as WebSocket
  );
  await assert.rejects(channel.ready, /local timeout/);
  assert.equal(socket.closed, true);
  const other = new Socket();
  const next = new TemporaryChannel(
    'https://relay.test',
    undefined,
    1000,
    () => other as unknown as WebSocket
  );
  assert.notEqual(next.channelId, channel.channelId);
  const pending = assert.rejects(next.ready, /cancelled/);
  next.close();
  await pending;
});
