/** Maximum reconstructed command size, matching the FF1 command ingress. */
const MAX_MESSAGE = 4 * 1024 * 1024;
/**
 * MAX_ASSEMBLY_BYTES bounds every unfinished inbound transfer together. Until
 * a peer is pinned any co-channel peer may start one, so a per-peer bound
 * alone would let 35 strangers make the CLI hold 35 × 4 MiB.
 */
const MAX_ASSEMBLY_BYTES = MAX_MESSAGE;
const ASSEMBLY_TIMEOUT_MS = 180000;
const CHUNK_SIZE = 32768;
/** RECEIPT_TIMEOUT_MS is how long one frame waits for its relay receipts. */
const RECEIPT_TIMEOUT_MS = 5000;
/**
 * FANOUT_GRACE_MS is how long a fan-out frame keeps waiting for the other
 * peers once one peer has acknowledged it. A silent stranger on the public
 * channel then costs about a second per chunk, not the whole receipt timeout.
 */
const FANOUT_GRACE_MS = 1000;
/**
 * CONNECT_ATTEMPTS bounds reconnects before the first `hello`. §10 calls a
 * connect-time refusal (HTTP 429, close 1008) transient; a browser-style
 * WebSocket cannot tell it from a 404, so the attempts are bounded and the
 * command is reported undelivered (the next command tries again).
 */
const CONNECT_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 4000;
/**
 * PING_INTERVAL_MS keeps the socket alive (§10 Liveness): the relay closes a
 * connection that shows no frame and no `ping` for 90 s, and every endpoint
 * pings at least every 30 s.
 */
export const PING_INTERVAL_MS = 25_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type Header = { v: 2; id: string; to: string; from?: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Assembly = {
  id: string;
  count: number;
  next: number;
  bytes: number;
  parts: Uint8Array[];
  expires: number;
};
type Prepared = {
  command: string;
  request: Record<string, unknown>;
  verify: (value: Record<string, unknown>) => Promise<boolean>;
};
/**
 * Delivery tracks what one request's frames proved (§10 "Ambiguity is the
 * default"): `written` frames left this client, `refused` of them were
 * explicitly refused by the relay for every destination known at send time
 * with no ACK, and `reached` holds peers that ACKed any frame, including an
 * ACK that arrives after its receipt window closed. `frames` are the frame
 * IDs, kept so a late ACK still finds its request.
 */
type Delivery = { written: number; refused: number; reached: Set<string>; frames: Set<string> };
/**
 * PeerState is what one request's sends proved about one peer: it holds the
 * whole body (`full`), it may hold part of it (`touched`), or the relay
 * refused it transiently (`retry`) or because the peer is gone (`gone`).
 */
type PeerState = 'full' | 'touched' | 'retry' | 'gone';
type ReceiptResult = {
  empty: boolean;
  acked: Set<string>;
  refused: Map<string, string>;
  unanswered: Set<string>;
};
type Receipt = {
  delivery: Delivery;
  to: string;
  fanout: boolean;
  awaiting: Set<string>;
  result: ReceiptResult;
  finish: () => void;
  timer: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
};

/**
 * RelayUndeliveredError means the request provably never reached a peer: it
 * was never sent, or the relay refused it for every target and no chunk of
 * it was acknowledged (ff1-control-v1 §10). Only this error allows a resend
 * or a fallback to another route.
 */
export class RelayUndeliveredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayUndeliveredError';
  }
}

/**
 * RelayAmbiguousError means some part of the request may have reached a peer
 * (an acknowledgement, a missing acknowledgement, a socket drop after a
 * send). The FF1 may have run it, so it is never resent (§14.4).
 */
export class RelayAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayAmbiguousError';
  }
}

/** relayURL selects the public device channel without credentials. */
export function relayURL(baseUrl: string, deviceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) {
    throw new Error('Invalid device ID');
  }
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  ) {
    throw new Error('Invalid relayer endpoint');
  }
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  url.pathname = `/v2/channels/${deviceId}/connections`;
  return url.toString();
}

/** encodeRelayFrame leaves the application payload byte-for-byte intact. */
export function encodeRelayFrame(header: Header, payload: Uint8Array): Uint8Array {
  const encoded = encoder.encode(JSON.stringify(header));
  if (encoded.length > 1024 || encoded.length + payload.length + 2 > 65536) {
    throw new Error('Relay frame too large');
  }
  const frame = new Uint8Array(encoded.length + payload.length + 2);
  new DataView(frame.buffer).setUint16(0, encoded.length);
  frame.set(encoded, 2);
  frame.set(payload, encoded.length + 2);
  return frame;
}

/** decodeRelayFrame validates routing metadata before delivering application data. */
export function decodeRelayFrame(frame: ArrayBuffer): { header: Header; payload: Uint8Array } {
  if (frame.byteLength < 3 || frame.byteLength > 65536) {
    throw new Error('Invalid relay frame');
  }
  const size = new DataView(frame).getUint16(0);
  if (!size || size > 1024 || size + 2 > frame.byteLength) {
    throw new Error('Invalid relay header');
  }
  const header = JSON.parse(decoder.decode(new Uint8Array(frame, 2, size))) as Header;
  if (
    header.v !== 2 ||
    ![header.id, header.to, header.from].every(
      (value) => typeof value === 'string' && ID_PATTERN.test(value)
    )
  ) {
    throw new Error('Invalid relay routing');
  }
  return { header, payload: new Uint8Array(frame, size + 2) };
}

/**
 * RelayClient carries protected JSON commands over relay v2 (§10).
 *
 * The first send of a request fans out to `to:"peers"`, and the client pins
 * the peer whose reply the caller's validator accepts (the reply verifies
 * under the enrolled profile). Peers that join later, or that the relay
 * refused transiently, get the same sealed bytes by unicast; a peer that may
 * already hold them never gets them twice. Failures are typed: see
 * RelayUndeliveredError and RelayAmbiguousError. Receipt ACKs never imply
 * application acceptance.
 */
export class RelayClient {
  private nextFrameAt = 0;
  private frameWrites = Promise.resolve();
  private socket!: WebSocket;
  private readonly url: string;
  private connected = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private player?: string;
  private peers = new Set<string>();
  private pending = new Map<string, Pending>();
  private receipts = new Map<string, Receipt>();
  /** Frame ID to its request, for ACKs that arrive after the receipt finished. */
  private frameOwners = new Map<string, Delivery>();
  private pinger?: ReturnType<typeof setInterval>;
  private validators = new Map<string, (value: Record<string, unknown>) => Promise<boolean>>();
  private assemblies = new Map<string, Assembly>();
  private closed = false;
  private sequence = Promise.resolve();
  private readiness!: Pending;
  private ready: Promise<void>;

  /** Create a controller connection; requests wait for the relay's hello. */
  constructor(
    baseUrl: string,
    deviceId: string,
    private readonly socketFactory = (url: string) => new WebSocket(url, 'ff-relay.v2')
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readiness = { resolve: () => resolve(), reject };
    });
    // Connection errors may precede the first request; retain rejection without
    // producing an unhandled promise while the caller prepares its command.
    void this.ready.catch(() => undefined);
    this.url = relayURL(baseUrl, deviceId);
    this.connect(0);
  }

  /**
   * requestPrepared seals only after the connection is ready, sends the
   * sealed command and resolves with the first reply its validator accepts.
   *
   * @param prepare - Seals the command; called at most once
   * @param timeoutMs - Deadline for the whole request, connecting included
   * @returns The verified RPC reply
   * @throws {RelayUndeliveredError} When no part of the command reached a peer
   * @throws {RelayAmbiguousError} When the command may have reached a peer
   */
  async requestPrepared(
    prepare: () => Promise<Prepared>,
    timeoutMs = 30000
  ): Promise<Record<string, unknown>> {
    const id = crypto.randomUUID();
    const delivery: Delivery = { written: 0, refused: 0, reached: new Set(), frames: new Set() };
    // Bound queue/open waits before allocating a replay counter or sealing.
    const result = this.wait(`rpc:${id}`, timeoutMs);
    void result.catch(() => undefined);
    const work = this.sequence.then(() => this.run(id, prepare, result, delivery));
    this.sequence = work.catch(() => undefined);
    void work.catch((error) => this.settle(`rpc:${id}`, undefined, error as Error));
    try {
      return (await result) as Record<string, unknown>;
    } catch (error) {
      throw classify(error as Error, delivery);
    } finally {
      this.validators.delete(id);
      delivery.frames.forEach((frame) => this.frameOwners.delete(frame));
    }
  }

  /** close releases the socket and all pending calls, including readiness. */
  close(error = new Error('Relay client closed')): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pinger);
    this.readiness.reject(error);
    for (const receipt of [...this.receipts.values()]) {
      receipt.finish();
    }
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.assemblies.clear();
    this.validators.clear();
    this.socket.close();
  }

  /**
   * connect opens one socket. Before the first hello a failure reconnects
   * with backoff (CONNECT_ATTEMPTS); afterwards it closes the client.
   */
  private connect(attempt: number): void {
    const socket = this.socketFactory(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    let lostOnce = false;
    const lost = (error: Error) => {
      if (lostOnce || socket !== this.socket || this.closed) {
        return;
      }
      lostOnce = true;
      if (!this.connected && attempt + 1 < CONNECT_ATTEMPTS) {
        socket.close();
        this.retryTimer = setTimeout(() => this.connect(attempt + 1), backoffMs(attempt));
        return;
      }
      this.close(error);
    };
    socket.addEventListener('message', (event) => {
      if (socket !== this.socket) {
        return;
      }
      try {
        this.receive(event.data);
      } catch (error) {
        this.close(error as Error);
      }
    });
    socket.addEventListener('error', () => lost(new Error('Relayer connection failed')));
    socket.addEventListener('close', (event) => {
      const code = (event as CloseEvent).code;
      lost(new Error(code ? `Relayer disconnected (${code})` : 'Relayer disconnected'));
    });
  }

  /** run is one request's work, serialized behind earlier requests. */
  private async run(
    id: string,
    prepare: () => Promise<Prepared>,
    result: Promise<unknown>,
    delivery: Delivery
  ): Promise<void> {
    const active = () => this.pending.has(`rpc:${id}`) && !this.closed;
    await Promise.race([this.ready, result]);
    if (!active()) {
      throw new Error('Relay request expired');
    }
    const prepared = await prepare();
    if (!active()) {
      throw new Error('Relay request expired');
    }
    if (prepared.command !== 'ff1Envelope') {
      throw new Error('V2 requires a protected envelope');
    }
    this.validators.set(id, prepared.verify);
    const body = encoder.encode(
      JSON.stringify({
        messageID: id,
        message: { command: prepared.command, request: prepared.request },
      })
    );
    await this.deliver(body, delivery, active, result);
  }

  /**
   * deliver sends one sealed body until a reply settles the request: first
   * to the pinned player, or fanned out to `peers` (§10), then by unicast to
   * peers that never received it. It throws RelayUndeliveredError as soon as
   * no peer is left to try and nothing was delivered.
   */
  private async deliver(
    body: Uint8Array,
    delivery: Delivery,
    active: () => boolean,
    result: Promise<unknown>
  ): Promise<void> {
    const states = new Map<string, PeerState>();
    const retries = new Map<string, { attempt: number; at: number }>();
    const first = await this.send(body, this.player ?? 'peers', active, delivery, states);
    if (first.empty) {
      throw new RelayUndeliveredError('Relay: no peer is connected to this FF1 channel');
    }
    while (active()) {
      const now = Date.now();
      const candidates = (this.player ? [this.player] : [...this.peers]).filter((peer) => {
        const state = states.get(peer);
        if (delivery.reached.has(peer)) {
          // It ACKed a frame of this request, possibly late: never a second copy.
          return false;
        }
        return state === undefined || (state === 'retry' && (retries.get(peer)?.at ?? 0) <= now);
      });
      if (!candidates.length && !this.retryable(states) && !touched(delivery)) {
        throw new RelayUndeliveredError('Relay refused the command for every peer');
      }
      for (const peer of candidates) {
        const attempt = states.get(peer) === 'retry' ? (retries.get(peer)?.attempt ?? 0) + 1 : 0;
        await this.send(body, peer, active, delivery, states);
        retries.set(peer, { attempt, at: Date.now() + backoffMs(attempt) });
      }
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 100)),
        result.then(
          () => undefined,
          () => undefined
        ),
      ]);
    }
  }

  /** retryable reports a live peer the relay refused only transiently. */
  private retryable(states: Map<string, PeerState>): boolean {
    return [...states].some(([peer, state]) => state === 'retry' && this.peers.has(peer));
  }

  /** wait owns the bounded deadline of one request. */
  private wait(key: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error('Relay response timeout'));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** settle consumes exactly one matching response or failure. */
  private settle(key: string, value?: unknown, error?: Error): void {
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    this.pending.delete(key);
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve(value);
    }
  }

  /**
   * send writes one body to `to` (a peer or `peers`) chunk by chunk and
   * records what the receipts proved per peer in `states`. It stops early
   * once no peer holds every chunk so far, since none could reassemble it.
   */
  private async send(
    body: Uint8Array,
    to: string,
    active: () => boolean,
    delivery: Delivery,
    states: Map<string, PeerState>
  ): Promise<{ empty: boolean }> {
    if (body.length > MAX_MESSAGE) {
      throw new Error('Relay message too large');
    }
    const transfer = crypto.randomUUID();
    const count = Math.ceil(body.length / CHUNK_SIZE);
    const sendStates = new Map<string, PeerState>();
    for (let index = 0; index < count && active(); index++) {
      const payload = chunkPayload(body, transfer, index, count);
      const receipt = await this.writeFrame(payload, to, delivery, active);
      if (receipt.empty) {
        return { empty: true };
      }
      mergeChunkResult(sendStates, receipt, index === 0);
      if (![...sendStates.values()].includes('full')) {
        break;
      }
    }
    for (const [peer, state] of sendStates) {
      states.set(peer, state);
    }
    return { empty: false };
  }

  /** writeFrame paces one frame below the relay's byte ceiling and awaits its receipts. */
  private writeFrame(
    payload: Uint8Array,
    to: string,
    delivery: Delivery,
    active: () => boolean
  ): Promise<ReceiptResult> {
    const id = crypto.randomUUID();
    const frame = encodeRelayFrame({ v: 2, id, to }, payload);
    const write = this.frameWrites.then(async () => {
      const delay = this.nextFrameAt - Date.now();
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      this.nextFrameAt = Date.now() + Math.max(20, Math.ceil((frame.byteLength * 1000) / 750000));
      // Re-checked after the pacing wait: a request whose deadline already
      // fired was reported on what had been written, so nothing more may go.
      if (this.closed || !active()) {
        return refusedLocally(to);
      }
      const receipt = this.expectReceipt(id, to, delivery);
      // Counted before the write: from here on only explicit refusals can
      // prove the frame undelivered, whatever happens to the socket.
      delivery.written++;
      delivery.frames.add(id);
      this.frameOwners.set(id, delivery);
      try {
        this.socket.send(frame);
      } catch (error) {
        this.close(error as Error);
      }
      return { receipt };
    });
    this.frameWrites = write.then(
      () => undefined,
      () => undefined
    );
    return write.then((written) => ('receipt' in written ? written.receipt : written));
  }

  /**
   * expectReceipt registers the receipts one frame waits for: the target's,
   * or every currently known peer's for a fan-out. The frame counts as
   * refused only when the relay refused it explicitly for every destination
   * and no peer ACKed it; silence, a departure or a close leaves it ambiguous.
   */
  private expectReceipt(id: string, to: string, delivery: Delivery): Promise<ReceiptResult> {
    return new Promise((resolve) => {
      const fanout = to === 'peers';
      const result: ReceiptResult = {
        empty: false,
        acked: new Set(),
        refused: new Map(),
        unanswered: new Set(),
      };
      const receipt: Receipt = {
        delivery,
        to,
        fanout,
        awaiting: new Set(fanout ? this.peers : [to]),
        result,
        timer: setTimeout(() => receipt.finish(), RECEIPT_TIMEOUT_MS),
        finish: () => {
          clearTimeout(receipt.timer);
          clearTimeout(receipt.grace);
          this.receipts.delete(id);
          receipt.awaiting.forEach((peer) => result.unanswered.add(peer));
          receipt.awaiting.clear();
          const refusedAll =
            !result.acked.size && !result.unanswered.size && result.refused.size > 0;
          if (result.empty || refusedAll) {
            delivery.refused++;
          }
          resolve(result);
        },
      };
      this.receipts.set(id, receipt);
    });
  }

  /** onReceipt applies one relay ack or routing error to its frame. */
  private onReceipt(event: Record<string, unknown>): void {
    const receipt = typeof event.id === 'string' ? this.receipts.get(event.id) : undefined;
    if (!receipt) {
      // A late ACK still proves the peer holds (part of) the request.
      const owner = typeof event.id === 'string' ? this.frameOwners.get(event.id) : undefined;
      if (owner && event.type === 'ack' && validId(event.from)) {
        owner.reached.add(event.from);
      }
      return;
    }
    const peer = event.type === 'ack' ? event.from : event.to;
    if (!receipt.fanout && peer !== receipt.to) {
      // Only the targeted recipient can answer a unicast frame.
      return;
    }
    if (event.type === 'ack' && typeof event.from === 'string') {
      receipt.result.acked.add(event.from);
      receipt.awaiting.delete(event.from);
      receipt.delivery.reached.add(event.from);
      if (receipt.fanout && receipt.awaiting.size && !receipt.grace) {
        receipt.grace = setTimeout(() => receipt.finish(), FANOUT_GRACE_MS);
      }
    } else if (event.type === 'error' && event.to === 'peers') {
      receipt.result.empty = true;
      receipt.awaiting.clear();
    } else if (event.type === 'error' && typeof event.to === 'string') {
      receipt.result.refused.set(event.to, String(event.code));
      receipt.awaiting.delete(event.to);
    } else {
      return;
    }
    if (!receipt.fanout || !receipt.awaiting.size) {
      receipt.finish();
    }
  }

  /** receive distinguishes relay controls from the existing application envelope. */
  private receive(data: unknown): void {
    if (data === 'pong') {
      return;
    }
    if (typeof data === 'string') {
      this.control(JSON.parse(data));
      return;
    }
    if (!(data instanceof ArrayBuffer)) {
      throw new Error('Invalid relay data');
    }
    const { header, payload } = decodeRelayFrame(data);
    this.socket.send(JSON.stringify({ type: 'ack', from: header.from, id: header.id }));
    const from = header.from!;
    if (!this.peers.has(from) || (this.player && from !== this.player)) {
      return;
    }
    let message: Record<string, unknown> | undefined;
    try {
      message = parseMessage(this.assemble(from, payload));
    } catch {
      return;
    }
    if (message?.type === 'RPC' && typeof message.messageID === 'string') {
      this.verifyReply(from, message);
    }
  }

  /**
   * verifyReply settles a request with a reply its validator accepts, and
   * pins that peer. An unverified reply settles nothing: on the public
   * channel a forgery costs availability only.
   */
  private verifyReply(from: string, message: Record<string, unknown>): void {
    const messageID = message.messageID as string;
    const verify = this.validators.get(messageID);
    if (!verify) {
      return;
    }
    void verify(message)
      .then((accepted) => {
        if (accepted && this.peers.has(from) && this.pending.has(`rpc:${messageID}`)) {
          this.player = from;
          this.settle(`rpc:${messageID}`, message);
        }
      })
      .catch(() => undefined);
  }

  /** control keeps connection presence separate from command completion. */
  private control(event: Record<string, unknown>): void {
    if (event.type === 'hello') {
      this.onHello(event);
    } else if (event.type === 'peer_connected' && validId(event.connectionId)) {
      this.peers.add(event.connectionId);
    } else if (event.type === 'peer_disconnected' && typeof event.connectionId === 'string') {
      this.onPeerGone(event.connectionId);
    } else if (event.type === 'ack' || event.type === 'error') {
      this.onReceipt(event);
    }
  }

  /** onHello records the peers present at connect and releases waiting requests. */
  private onHello(event: Record<string, unknown>): void {
    if (!validId(event.connectionId) || !Array.isArray(event.peers)) {
      throw new Error('Invalid relay hello');
    }
    // Every live peer is kept: the relay caps a channel at 36 connections,
    // and a client-side cap would let strangers crowd the FF1 out.
    for (const peer of event.peers) {
      if (validId(peer)) {
        this.peers.add(peer);
      }
    }
    this.connected = true;
    this.pinger ??= startPinging(() => this.socket);
    this.readiness.resolve(undefined);
  }

  /** onPeerGone forgets a peer; losing the pinned player ends the connection. */
  private onPeerGone(peer: string): void {
    this.peers.delete(peer);
    this.assemblies.delete(peer);
    if (peer === this.player) {
      this.close(new Error('Player disconnected'));
      return;
    }
    // A peer that left before answering may still have received the frame.
    for (const receipt of [...this.receipts.values()]) {
      if (receipt.awaiting.delete(peer)) {
        receipt.result.unanswered.add(peer);
        if (!receipt.awaiting.size) {
          receipt.finish();
        }
      }
    }
  }

  /** assemble enforces one ordered 4 MiB transfer per peer and a shared byte budget. */
  private assemble(from: string, payload: Uint8Array): Uint8Array | undefined {
    const chunk = JSON.parse(decoder.decode(payload)).relayChunk;
    if (!chunk) {
      return payload;
    }
    const bytes = chunkBytes(chunk);
    this.sweepAssemblies();
    if (chunk.index === 0) {
      this.assemblies.set(from, {
        id: chunk.id,
        count: chunk.count,
        next: 0,
        bytes: 0,
        parts: [],
        expires: Date.now() + ASSEMBLY_TIMEOUT_MS,
      });
    }
    const assembly = this.assemblies.get(from);
    if (
      !assembly ||
      assembly.id !== chunk.id ||
      assembly.count !== chunk.count ||
      assembly.next !== chunk.index ||
      assembly.bytes + bytes.length > MAX_MESSAGE ||
      this.assemblyBytes() + bytes.length > MAX_ASSEMBLY_BYTES
    ) {
      this.assemblies.delete(from);
      throw new Error('Invalid chunk sequence');
    }
    assembly.parts.push(bytes);
    assembly.bytes += bytes.length;
    assembly.next++;
    if (assembly.next !== assembly.count) {
      return undefined;
    }
    this.assemblies.delete(from);
    return concat(assembly.parts, assembly.bytes);
  }

  /** sweepAssemblies drops transfers past their 180 s reassembly window. */
  private sweepAssemblies(): void {
    const now = Date.now();
    for (const [peer, assembly] of this.assemblies) {
      if (now >= assembly.expires) {
        this.assemblies.delete(peer);
      }
    }
  }

  /** assemblyBytes is the total held by unfinished transfers. */
  private assemblyBytes(): number {
    let total = 0;
    for (const assembly of this.assemblies.values()) {
      total += assembly.bytes;
    }
    return total;
  }
}

/** backoffMs is a jittered exponential delay for transient relay refusals. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.ceil(ceiling * (0.5 + Math.random() / 2));
}

/** refusalState maps a relay refusal code to what it proves about the peer. */
function refusalState(code: string): PeerState {
  // backpressure and duplicate_packet mean "not forwarded this time", which
  // §10 makes transient; peer_unavailable means the target is gone.
  return code === 'backpressure' || code === 'duplicate_packet' ? 'retry' : 'gone';
}

/**
 * mergeChunkResult folds one chunk's receipts into the per-peer states of a
 * body. A peer is `full` only when it acknowledged every chunk; a peer that
 * acknowledged some chunks, or never answered, is `touched`.
 */
function mergeChunkResult(
  states: Map<string, PeerState>,
  receipt: ReceiptResult,
  first: boolean
): void {
  for (const peer of receipt.unanswered) {
    states.set(peer, 'touched');
  }
  for (const peer of receipt.acked) {
    if (first) {
      states.set(peer, 'full');
    } else if (states.get(peer) !== 'full') {
      states.set(peer, 'touched');
    }
  }
  for (const [peer, code] of receipt.refused) {
    const previous = states.get(peer);
    if (first || previous === 'retry' || previous === 'gone') {
      states.set(peer, refusalState(code));
    } else {
      states.set(peer, 'touched');
    }
  }
}

/** refusedLocally is the receipt of a frame this client never wrote. */
function refusedLocally(to: string): ReceiptResult {
  return {
    empty: false,
    acked: new Set(),
    refused: new Map(to === 'peers' ? [] : [[to, 'peer_unavailable']]),
    unanswered: new Set(),
  };
}

/**
 * startPinging sends the §10 liveness `ping` every PING_INTERVAL_MS on
 * whichever socket is current. The timer never keeps the process alive.
 */
export function startPinging(socket: () => WebSocket): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      socket().send('ping');
    } catch {
      /* The close handler reports a dead socket. */
    }
  }, PING_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** touched reports whether any frame of a request may have reached a peer. */
function touched(delivery: Delivery): boolean {
  return delivery.reached.size > 0 || delivery.written > delivery.refused;
}

/** classify types a request failure by whether any part of it may have arrived. */
function classify(error: Error, delivery: Delivery): Error {
  if (error instanceof RelayUndeliveredError || error instanceof RelayAmbiguousError) {
    return error;
  }
  return touched(delivery)
    ? new RelayAmbiguousError(error.message)
    : new RelayUndeliveredError(error.message);
}

/** validId reports a relay connection ID. */
function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** chunkPayload is chunk `index` of `body`, wrapped in relayChunk when split. */
function chunkPayload(body: Uint8Array, transfer: string, index: number, count: number) {
  const part = body.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
  if (count === 1) {
    return part;
  }
  return encoder.encode(
    JSON.stringify({
      relayChunk: { id: transfer, index, count, data: Buffer.from(part).toString('base64') },
    })
  );
}

/** chunkBytes validates one inbound relayChunk and decodes its data. */
function chunkBytes(chunk: Record<string, unknown>): Uint8Array {
  const { id, index, count, data } = chunk;
  if (
    typeof id !== 'string' ||
    !ID_PATTERN.test(id) ||
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 2 ||
    count > 128 ||
    typeof index !== 'number' ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count ||
    typeof data !== 'string' ||
    data.length > 43692
  ) {
    throw new Error('Invalid relay chunk');
  }
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  if (!bytes.length || bytes.length > CHUNK_SIZE) {
    throw new Error('Invalid chunk size');
  }
  return bytes;
}

/** concat joins reassembled parts. */
function concat(parts: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** parseMessage decodes a complete application message, or undefined when incomplete. */
function parseMessage(body: Uint8Array | undefined): Record<string, unknown> | undefined {
  if (!body) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(decoder.decode(body));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}
