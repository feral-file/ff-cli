import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { encodeRelayFrame } from '../src/utilities/relay-client';
import {
  PairingTransportUnavailableError,
  pairingChannelOpener,
  setPairingChannelOpener,
} from '../src/utilities/control/pairing-channel';
import {
  installRelayPairingChannel,
  relayPairingChannelOpener,
} from '../src/utilities/control/relay-pairing-channel';

const CHANNEL_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

class Socket extends EventTarget {
  binaryType = '';
  url: string;
  sent: unknown[] = [];
  closed = false;
  constructor(url: string) {
    super();
    this.url = url;
  }
  send(value: unknown) {
    this.sent.push(value);
  }
  close() {
    this.closed = true;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  hello() {
    this.message(JSON.stringify({ type: 'hello', connectionId: 'cli', peers: [] }));
  }
  payload(from: string, bytes: number[]) {
    const frame = encodeRelayFrame(
      { v: 2, id: crypto.randomUUID(), to: 'cli', from },
      new Uint8Array(bytes)
    );
    this.message(frame.buffer);
  }
}

/** open joins a channel on a scripted socket; `script` runs once the socket exists. */
async function open(script: (socket: Socket) => void, signal = new AbortController().signal) {
  let socket: Socket | undefined;
  const opener = relayPairingChannelOpener('https://relay.test', (url) => {
    socket = new Socket(url);
    const created = socket;
    queueMicrotask(() => script(created));
    return created as unknown as WebSocket;
  });
  const channel = await opener(CHANNEL_ID, signal);
  return { channel, socket: socket! };
}

async function next(iterator: AsyncIterator<Uint8Array>) {
  return iterator.next();
}

afterEach(() => setPairingChannelOpener(undefined));

test('joins the pairing channel and keeps a message sent right after hello', async () => {
  const { channel, socket } = await open((s) => {
    s.hello();
    s.payload('owner', [1, 2, 3]);
  });
  assert.equal(socket.url, `wss://relay.test/v2/channels/${CHANNEL_ID}/connections`);
  assert.equal(channel.channelId, CHANNEL_ID);
  assert.equal(channel.send, undefined, 'the CLI only receives on the pairing channel');
  const messages = channel.messages()[Symbol.asyncIterator]();
  assert.deepEqual([...(await next(messages)).value], [1, 2, 3]);
  // Receipt credit goes back to the relay before the message is read.
  assert.equal(JSON.parse(socket.sent.at(-1) as string).type, 'ack');
  await channel.close();
  assert.equal(socket.closed, true);
});

test('messages arrive in order and the iteration ends when the channel closes', async () => {
  const { channel, socket } = await open((s) => s.hello());
  const messages = channel.messages()[Symbol.asyncIterator]();
  const first = next(messages);
  socket.payload('stranger', [9]);
  socket.payload('owner', [7]);
  assert.deepEqual([...(await first).value], [9]);
  assert.deepEqual([...(await next(messages)).value], [7]);
  const pending = next(messages);
  socket.dispatchEvent(new Event('close'));
  assert.equal((await pending).done, true);
});

test('a flood cannot evict a message that is already queued', async () => {
  const { channel, socket } = await open((s) => s.hello());
  socket.payload('owner', [1]);
  for (let index = 0; index < 100; index++) {
    socket.payload('stranger', [2]);
  }
  socket.message('pong');
  const messages = channel.messages()[Symbol.asyncIterator]();
  assert.deepEqual([...(await next(messages)).value], [1]);
  await channel.close();
});

test('aborting the signal closes the channel and ends the iteration', async () => {
  const abort = new AbortController();
  const { channel, socket } = await open((s) => s.hello(), abort.signal);
  const pending = next(channel.messages()[Symbol.asyncIterator]());
  abort.abort();
  assert.equal((await pending).done, true);
  assert.equal(socket.closed, true);
});

test('a relay failure before hello rejects the open', async () => {
  await assert.rejects(
    open((s) => s.dispatchEvent(new Event('error'))),
    /Pairing channel failed/
  );
});

test('an invalid channel ID or an aborted signal opens no socket', async () => {
  let sockets = 0;
  const opener = relayPairingChannelOpener('https://relay.test', (url) => {
    sockets++;
    return new Socket(url) as unknown as WebSocket;
  });
  for (const channelId of ['short', 'x'.repeat(65), 'bad/char-0123456789']) {
    await assert.rejects(opener(channelId, new AbortController().signal), /channel ID/);
  }
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(opener(CHANNEL_ID, aborted.signal));
  assert.equal(sockets, 0);
});

test('the relay opener is installed only when a v2 endpoint is configured', async () => {
  const signal = new AbortController().signal;
  installRelayPairingChannel(() => ({}));
  await assert.rejects(
    pairingChannelOpener()(CHANNEL_ID, signal),
    PairingTransportUnavailableError
  );
  installRelayPairingChannel(() => {
    throw new Error('bad config');
  });
  await assert.rejects(
    pairingChannelOpener()(CHANNEL_ID, signal),
    PairingTransportUnavailableError
  );
  installRelayPairingChannel(() => ({ v2Endpoint: 'https://relay.test' }));
  // An invalid ID is refused by the relay opener before any socket exists.
  await assert.rejects(pairingChannelOpener()('short', signal), /invalid pairing channel ID/);
});
