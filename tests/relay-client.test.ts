import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RelayAmbiguousError,
  RelayClient,
  RelayUndeliveredError,
  PING_INTERVAL_MS,
  relayURL,
  encodeRelayFrame,
  decodeRelayFrame,
} from '../src/utilities/relay-client';

type Header = { v: 2; id: string; to: string };
type Sent = { header: Header; body: Record<string, unknown>; size: number; at: number };

/**
 * Socket is a scripted relay connection. `onFrame` sees each binary frame the
 * client writes; `frames` keeps them decoded (relayChunk bodies stay wrapped).
 */
class Socket extends EventTarget {
  binaryType = '';
  sent: unknown[] = [];
  frames: Sent[] = [];
  closed = false;
  onFrame?: (header: Header, body: Record<string, unknown>) => void;
  send(data: unknown) {
    this.sent.push(data);
    if (!(data instanceof Uint8Array)) {
      return;
    }
    const size = new DataView(data.buffer, data.byteOffset).getUint16(0);
    const header = JSON.parse(new TextDecoder().decode(data.slice(2, 2 + size))) as Header;
    const body = JSON.parse(new TextDecoder().decode(data.slice(2 + size)));
    this.frames.push({ header, body, size: data.byteLength, at: Date.now() });
    queueMicrotask(() => this.onFrame?.(header, body));
  }
  close() {
    this.closed = true;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  control(event: Record<string, unknown>) {
    this.message(JSON.stringify(event));
  }
  hello(peers: string[]) {
    this.control({ type: 'hello', connectionId: 'cli', peers });
  }
  ack(from: string, id: string) {
    this.control({ type: 'ack', from, id });
  }
  refuse(to: string, id: string, code: string) {
    this.control({ type: 'error', code, id, to });
  }
  reply(from: string, messageID: unknown, message: unknown = { ok: true }) {
    const frame = encodeRelayFrame(
      { v: 2, id: crypto.randomUUID(), to: 'cli', from } as Header,
      new TextEncoder().encode(JSON.stringify({ type: 'RPC', messageID, message }))
    );
    this.message(frame.buffer);
  }
}

function client(socket: Socket) {
  return new RelayClient('https://relay.example', 'FF1-TEST', () => socket as unknown as WebSocket);
}

/** request supplies a test endpoint validator; production uses pinned JOSE verification. */
function request(
  relay: RelayClient,
  body: Record<string, unknown> = {},
  timeout?: number,
  verify: (value: Record<string, unknown>) => Promise<boolean> = async () => true
) {
  return relay.requestPrepared(
    async () => ({ command: 'ff1Envelope', request: body, verify }),
    timeout
  );
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const genuine = async (value: Record<string, unknown>) =>
  (value.message as { genuine?: boolean }).genuine === true;

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

test('the first envelope fans out to peers and the RPC waits for the reply, not the ACK', async () => {
  const socket = new Socket();
  const relay = client(socket);
  socket.hello(['player-1']);
  let finished = false;
  const result = request(relay).then((value) => {
    finished = true;
    return value;
  });
  await tick();
  const [{ header, body }] = socket.frames;
  assert.equal(header.to, 'peers');
  assert.equal((body.message as { command: string }).command, 'ff1Envelope');
  socket.ack('player-1', header.id);
  await tick();
  assert.equal(finished, false);
  socket.reply('player-1', body.messageID);
  assert.deepEqual((await result).message, { ok: true });
  assert.equal(JSON.parse(socket.sent.at(-1) as string).type, 'ack');
  relay.close();
});

test('the verified peer is pinned; later requests are unicast to it', async () => {
  const socket = new Socket();
  socket.onFrame = (header, body) => {
    socket.ack('stranger', header.id);
    socket.ack('ff1', header.id);
    socket.reply('stranger', body.messageID, { forged: true });
    socket.reply('ff1', body.messageID, { genuine: true });
  };
  const relay = client(socket);
  socket.hello(['stranger', 'ff1']);
  assert.deepEqual((await request(relay, {}, 2000, genuine)).message, { genuine: true });
  assert.deepEqual((await request(relay, {}, 2000, genuine)).message, { genuine: true });
  assert.deepEqual(
    socket.frames.map((frame) => frame.header.to),
    ['peers', 'ff1']
  );
  relay.close();
});

test('strangers filling the channel cannot keep the FF1 from being probed', async () => {
  const socket = new Socket();
  const strangers = Array.from({ length: 35 }, (_, index) => `stranger-${index}`);
  socket.onFrame = (header, body) => {
    for (const peer of [...strangers, 'ff1']) {
      socket.ack(peer, header.id);
    }
    socket.reply('ff1', body.messageID, { genuine: true });
  };
  const relay = client(socket);
  socket.hello([...strangers, 'ff1']);
  assert.deepEqual((await request(relay, {}, 2000, genuine)).message, { genuine: true });
  assert.equal(socket.frames.length, 1, 'one fan-out frame, no per-peer unicast');
  relay.close();
});

test('an empty channel is proven undelivered at once', async () => {
  const socket = new Socket();
  socket.onFrame = (header) => socket.refuse('peers', header.id, 'peer_unavailable');
  const relay = client(socket);
  socket.hello([]);
  const started = Date.now();
  await assert.rejects(request(relay, {}, 5000), RelayUndeliveredError);
  assert.ok(Date.now() - started < 1000);
  relay.close();
});

test('a refusal by every target with no ACK is proven undelivered', async () => {
  const socket = new Socket();
  socket.onFrame = (header) => {
    socket.refuse('a', header.id, 'peer_unavailable');
    socket.refuse('b', header.id, 'peer_unavailable');
  };
  const relay = client(socket);
  socket.hello(['a', 'b']);
  await assert.rejects(request(relay, {}, 5000), RelayUndeliveredError);
  relay.close();
});

test('an ACKed command with no verified reply is ambiguous, never undelivered', async () => {
  const socket = new Socket();
  socket.onFrame = (header) => socket.ack('ff1', header.id);
  const relay = client(socket);
  socket.hello(['ff1']);
  await assert.rejects(request(relay, {}, 300), RelayAmbiguousError);
  relay.close();
});

test('a socket drop after sending is ambiguous', async () => {
  const socket = new Socket();
  socket.onFrame = () => socket.dispatchEvent(new Event('close'));
  const relay = client(socket);
  socket.hello(['ff1']);
  await assert.rejects(request(relay, {}, 2000), RelayAmbiguousError);
});

test('a deadline before the receipt arrives is ambiguous once the frame was written', async () => {
  const socket = new Socket();
  const relay = client(socket);
  socket.hello(['ff1']);
  await assert.rejects(request(relay, {}, 200), RelayAmbiguousError);
  assert.equal(socket.frames.length, 1);
  relay.close();
});

test('a peer leaving before it answers is ambiguous', async () => {
  const socket = new Socket();
  socket.onFrame = () => socket.control({ type: 'peer_disconnected', connectionId: 'ff1' });
  const relay = client(socket);
  socket.hello(['ff1']);
  await assert.rejects(request(relay, {}, 1000), RelayAmbiguousError);
  relay.close();
});

test('a late ACK marks the peer reached, so it never gets a second copy', async () => {
  const socket = new Socket();
  socket.onFrame = (header) => {
    if (header.to !== 'peers') {
      return;
    }
    socket.ack('stranger', header.id);
    // ff1 joined just before the relay forwarded the fan-out; its ACK comes
    // after the receipt window closed.
    socket.control({ type: 'peer_connected', connectionId: 'ff1' });
    socket.ack('ff1', header.id);
  };
  const relay = client(socket);
  socket.hello(['stranger']);
  await assert.rejects(request(relay, {}, 500), RelayAmbiguousError);
  assert.deepEqual(
    socket.frames.map((frame) => frame.header.to),
    ['peers']
  );
  relay.close();
});

test('the socket pings for liveness and ignores pong', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const socket = new Socket();
  const relay = client(socket);
  socket.hello(['ff1']);
  socket.message('pong');
  t.mock.timers.tick(PING_INTERVAL_MS);
  assert.equal(socket.sent.at(-1), 'ping');
  assert.equal(socket.closed, false);
  relay.close();
});

test('backpressure is transient: the peer is retried after a backoff', async () => {
  const socket = new Socket();
  socket.onFrame = (header, body) => {
    if (header.to === 'peers') {
      socket.refuse('ff1', header.id, 'backpressure');
      return;
    }
    socket.ack('ff1', header.id);
    socket.reply('ff1', body.messageID);
  };
  const relay = client(socket);
  socket.hello(['ff1']);
  await request(relay, {}, 3000);
  assert.deepEqual(
    socket.frames.map((frame) => frame.header.to),
    ['peers', 'ff1']
  );
  relay.close();
});

test('a peer that may already hold the command never gets it twice', async () => {
  // ff1 neither ACKs nor refuses: the relay may have forwarded the frame.
  const socket = new Socket();
  const relay = client(socket);
  socket.hello(['ff1']);
  await assert.rejects(request(relay, {}, 6000), RelayAmbiguousError);
  assert.equal(socket.frames.length, 1);
  relay.close();
});

test('connect failures are retried with backoff before the first hello', async () => {
  const sockets: Socket[] = [];
  const relay = new RelayClient('https://relay.example', 'FF1-TEST', () => {
    const socket = new Socket();
    sockets.push(socket);
    queueMicrotask(() => {
      if (sockets.length < 3) {
        socket.dispatchEvent(new Event('error'));
        return;
      }
      socket.onFrame = (header, body) => {
        socket.ack('ff1', header.id);
        socket.reply('ff1', body.messageID);
      };
      socket.hello(['ff1']);
    });
    return socket as unknown as WebSocket;
  });
  await request(relay, {}, 5000);
  assert.equal(sockets.length, 3);
  relay.close();
});

test('a relay that never admits the client leaves the command undelivered', async () => {
  let attempts = 0;
  const relay = new RelayClient('https://relay.example', 'FF1-TEST', () => {
    attempts++;
    const socket = new Socket();
    queueMicrotask(() => socket.dispatchEvent(new Event('close')));
    return socket as unknown as WebSocket;
  });
  await assert.rejects(request(relay, {}, 5000), RelayUndeliveredError);
  assert.equal(attempts, 3);
});

test('close before sending rejects pending commands as undelivered; malformed frames are bounded', async () => {
  const socket = new Socket();
  const relay = client(socket);
  const pending = request(relay);
  relay.close();
  await assert.rejects(pending, RelayUndeliveredError);
  assert.throws(() => decodeRelayFrame(new ArrayBuffer(65537)));
  assert.throws(() => decodeRelayFrame(new Uint8Array([0, 255, 0]).buffer));
});

test('expired queued commands are never sent after transport credit is released', async () => {
  const socket = new Socket();
  const relay = client(socket);
  socket.hello(['player-1']);
  const first = request(relay, {}, 1000);
  const firstRejected = assert.rejects(first);
  await tick();
  const second = request(relay, {}, 10);
  await assert.rejects(second, /timed out|timeout/i);
  socket.ack('player-1', socket.frames[0].header.id);
  await tick();
  assert.equal(socket.frames.length, 1);
  relay.close();
  await firstRejected;
});

test('large transfers stay below the Worker byte ceiling with immediate ACKs', async () => {
  const socket = new Socket();
  const parts: Buffer[] = [];
  socket.onFrame = (header, body) => {
    const chunk = body.relayChunk as { data: string; count: number };
    parts.push(Buffer.from(chunk.data, 'base64'));
    socket.ack('player-1', header.id);
    if (parts.length === chunk.count) {
      socket.reply('player-1', JSON.parse(Buffer.concat(parts).toString()).messageID);
    }
  };
  const relay = client(socket);
  socket.hello(['player-1']);
  try {
    await request(relay, { data: 'x'.repeat(2 * 1024 * 1024) });
    for (const start of socket.frames) {
      const bytes = socket.frames
        .filter((write) => write.at >= start.at && write.at < start.at + 1000)
        .reduce((sum, write) => sum + write.size, 0);
      assert.ok(bytes < 1048576, `one-second window exceeded limit: ${bytes}`);
    }
  } finally {
    relay.close();
  }
});

test('malformed reconstructed candidate payload is ACKed without closing a valid peer', async () => {
  const socket = new Socket();
  const relay = client(socket);
  socket.hello(['attacker', 'ff1']);
  for (let index = 0; index < 2; index++) {
    const payload = new TextEncoder().encode(
      JSON.stringify({ relayChunk: { id: 'bad-transfer', index, count: 2, data: btoa('x') } })
    );
    const frame = encodeRelayFrame(
      { v: 2, id: `bad-${index}`, to: 'cli', from: 'attacker' } as Header,
      payload
    );
    socket.message(frame.buffer);
  }
  assert.equal(socket.closed, false);
  assert.equal(socket.sent.length, 2);
  relay.close();
});

test('unfinished transfers from all candidates share one byte budget', async () => {
  const socket = new Socket();
  const relay = client(socket);
  socket.hello(['a', 'b']);
  const data = Buffer.alloc(32768, 1).toString('base64');
  const chunk = (from: string, index: number) => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ relayChunk: { id: `t-${from}`, index, count: 128, data } })
    );
    socket.message(
      encodeRelayFrame({ v: 2, id: `${from}-${index}`, to: 'cli', from } as Header, payload).buffer
    );
  };
  for (let index = 0; index < 100; index++) {
    chunk('a', index);
  }
  // a holds 100 chunks; b fits only 28 more before the shared budget is spent.
  for (let index = 0; index < 40; index++) {
    chunk('b', index);
  }
  const held = (relay as unknown as { assemblies: Map<string, { bytes: number }> }).assemblies;
  const total = [...held.values()].reduce((sum, assembly) => sum + assembly.bytes, 0);
  assert.ok(total <= 4 * 1024 * 1024, `held ${total} bytes`);
  assert.equal(held.get('a')?.bytes, 100 * 32768);
  assert.equal(socket.closed, false);
  relay.close();
});

test('discovers FF1 joining after another controller without resealing or resending', async () => {
  const socket = new Socket();
  socket.onFrame = (header, body) => {
    if (header.to === 'peers') {
      socket.ack('other-controller', header.id);
      return;
    }
    socket.ack(header.to, header.id);
    if (header.to === 'ff1') {
      socket.reply('ff1', body.messageID);
    }
  };
  const relay = client(socket);
  socket.hello(['other-controller']);
  let seals = 0;
  const result = relay.requestPrepared(() => {
    seals++;
    return Promise.resolve({
      command: 'ff1Envelope',
      request: { jwe: 'opaque' },
      verify: () => Promise.resolve(true),
    });
  }, 2000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.control({ type: 'peer_connected', connectionId: 'ff1' });
  await result;
  assert.equal(seals, 1);
  assert.deepEqual(
    socket.frames.map((frame) => frame.header.to),
    ['peers', 'ff1']
  );
  relay.close();
});
