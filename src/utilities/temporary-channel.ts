import { decodeRelayFrame, encodeRelayFrame, relayURL } from './relay-client';

/** TemporaryChannel supplies only the generic carrier seam for the reviewed
 * pairing workflow. QR generation, crypto, result validation and staging stay
 * with that workflow. Its caller chooses the recipient from the endpoint exchange.
 */
export class TemporaryChannel {
  readonly channelId: string;
  connectionId?: string;
  readonly peers = new Set<string>();
  readonly ready: Promise<void>;
  private socket: WebSocket;
  private timer: ReturnType<typeof setTimeout>;
  private closed = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private receipts = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  onPayload?: (from: string, ciphertext: Uint8Array) => void;
  onClose?: (reason: Error) => void;

  /** Create an endpoint-timed attempt. Await ready before displaying its QR. */
  constructor(
    endpoint: string,
    channelId = crypto.randomUUID(),
    timeoutMs = 120000,
    socketFactory = (url: string) => new WebSocket(url, 'ff-relay.v2')
  ) {
    this.channelId = channelId;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);
    this.socket = socketFactory(relayURL(endpoint, channelId));
    this.socket.binaryType = 'arraybuffer';
    this.timer = setTimeout(
      () => this.close(new Error('Pairing not completed: local timeout')),
      timeoutMs
    );
    this.socket.addEventListener('message', (event) => {
      try {
        this.receive(event.data);
      } catch {
        this.close(new Error('Malformed temporary-channel frame'));
      }
    });
    this.socket.addEventListener('close', () =>
      this.close(new Error('Pairing channel disconnected'))
    );
    this.socket.addEventListener('error', () => this.close(new Error('Pairing channel failed')));
  }

  /** send targets encrypted endpoint bytes; resolving means receipt, not approval. */
  async send(to: string, ciphertext: Uint8Array): Promise<void> {
    await this.ready;
    if (this.closed || !this.peers.has(to)) {
      throw new Error('Pairing peer unavailable');
    }
    if (this.receipts.size >= 2) {
      throw new Error('Pairing carrier backpressure');
    }
    const id = crypto.randomUUID();
    const frame = encodeRelayFrame({ v: 2, id, to }, ciphertext);
    return new Promise((resolve, reject) => {
      const key = `${to}:${id}`;
      const timer = setTimeout(() => {
        this.receipts.delete(key);
        reject(new Error('Pairing receipt timeout; result delivery unknown'));
      }, 5000);
      this.receipts.set(key, { resolve, reject, timer });
      try {
        this.socket.send(frame);
      } catch (error) {
        this.close(error as Error);
      }
    });
  }

  /** close cancels this local attempt and never revokes an endpoint grant. */
  close(reason = new Error('Pairing cancelled')): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.timer);
    this.rejectReady(reason);
    for (const pending of this.receipts.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.receipts.clear();
    this.peers.clear();
    this.socket.close();
    this.onClose?.(reason);
  }

  /** receive releases transport credit before handing ciphertext to validators. */
  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      if (!(data instanceof ArrayBuffer)) {
        throw new Error('Invalid binary frame');
      }
      const { header, payload } = decodeRelayFrame(data);
      this.socket.send(JSON.stringify({ type: 'ack', from: header.from, id: header.id }));
      this.onPayload?.(header.from!, payload);
      return;
    }
    const event = JSON.parse(data);
    if (event.type === 'hello') {
      if (typeof event.connectionId !== 'string' || !Array.isArray(event.peers)) {
        throw new Error('Invalid hello');
      }
      this.connectionId = event.connectionId;
      for (const peer of event.peers.slice(0, 35)) {
        this.peers.add(peer);
      }
      this.resolveReady();
    } else if (event.type === 'peer_connected' && this.peers.size < 35) {
      this.peers.add(event.connectionId);
    } else if (event.type === 'peer_disconnected') {
      this.peers.delete(event.connectionId);
    } else if (event.type === 'ack' || event.type === 'error') {
      const key = `${event.from ?? event.to}:${event.id}`;
      const receipt = this.receipts.get(key);
      if (!receipt) {
        return;
      }
      clearTimeout(receipt.timer);
      this.receipts.delete(key);
      if (event.type === 'ack') {
        receipt.resolve();
      } else {
        receipt.reject(new Error(`Relay: ${event.code}`));
      }
    }
  }
}
