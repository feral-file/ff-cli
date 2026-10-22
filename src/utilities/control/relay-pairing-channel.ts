/**
 * The relay v2 opener for the owner-initiated pairing channel
 * (ffos-user docs/ff1-control-v1.md §5.6 step 1). It adapts TemporaryChannel
 * (`/v2/channels/{channelId}/connections`) to the PairingChannel interface
 * that `ff-cli device pair` consumes, and is installed at startup by
 * installRelayPairingChannel when a v2 endpoint is configured.
 *
 * The channel carries no authority: every message is untrusted bytes that
 * registration.ts opens and checks. This adapter only queues them.
 *
 * A relay drop ends the pairing wait (no reconnect: a new connection would
 * get a new connection ID the owner's app does not know); `device pair` says
 * the channel closed and the user shows a new code.
 *
 * Limit: TemporaryChannel does not reassemble `relayChunk` transfers, so a
 * sealed registration result must fit one relay frame (about 32 KiB of
 * payload). Results are about 1 KiB; a chunked one would arrive as fragments
 * that fail to open and are ignored like any other stray message.
 */

import { getFF1RelayerConfig } from '../../config';
import * as logger from '../../logger';
import { TemporaryChannel } from '../temporary-channel';
import { MAX_PAIR_TIMEOUT_MS } from './pairing';
import {
  type PairingChannel,
  type PairingChannelOpener,
  setPairingChannelOpener,
} from './pairing-channel';
import { isValidChannelId } from './registration';

/**
 * PAIRING_CHANNEL_TIMEOUT_MS is TemporaryChannel's own deadline. It only has
 * to outlast the longest `device pair --timeout`; the caller's AbortSignal
 * is what actually ends the wait.
 */
const PAIRING_CHANNEL_TIMEOUT_MS = MAX_PAIR_TIMEOUT_MS + 60_000;
/**
 * MAX_QUEUED_MESSAGES bounds unread messages. Anyone who saw the QR can write
 * to the channel; the pairing loop drains each message at once, so only a
 * flood fills the queue. Then NEW messages are dropped: evicting the oldest
 * would let a flood push out an owner's result that is already queued.
 */
const MAX_QUEUED_MESSAGES = 64;

type SocketFactory = (url: string) => WebSocket;

/**
 * MessageQueue is a single-consumer async iterable of channel payloads that
 * ends when the channel closes.
 */
class MessageQueue implements AsyncIterable<Uint8Array> {
  private items: Uint8Array[] = [];
  private waiter?: (result: IteratorResult<Uint8Array>) => void;
  private ended = false;

  /** push queues one payload, or hands it to a waiting reader. */
  push(item: Uint8Array): void {
    if (this.ended) {
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: item, done: false });
      return;
    }
    if (this.items.length < MAX_QUEUED_MESSAGES) {
      this.items.push(item);
    }
  }

  /** end finishes the iteration once queued payloads are read. */
  end(): void {
    this.ended = true;
    if (this.waiter && !this.items.length) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

/**
 * relayPairingChannelOpener returns an opener that joins the pairing channel
 * on the relay v2 endpoint.
 *
 * The payload handler is attached before `ready` is awaited, so a result
 * sent right after the relay's hello is not lost. Aborting the signal closes
 * the channel, which ends the message iteration.
 *
 * @param endpoint - Relay v2 origin
 * @param socketFactory - WebSocket constructor seam for tests
 * @returns The opener for setPairingChannelOpener
 */
export function relayPairingChannelOpener(
  endpoint: string,
  socketFactory?: SocketFactory
): PairingChannelOpener {
  return async (channelId, signal) => {
    if (!isValidChannelId(channelId)) {
      throw new Error('invalid pairing channel ID');
    }
    signal.throwIfAborted();
    const channel = new TemporaryChannel(
      endpoint,
      channelId,
      PAIRING_CHANNEL_TIMEOUT_MS,
      socketFactory
    );
    const queue = new MessageQueue();
    // The frame payload is a view into the relay frame; keep a private copy.
    channel.onPayload = (_from, payload) => queue.push(payload.slice());
    channel.onClose = () => queue.end();
    const onAbort = () => channel.close(new Error('Pairing cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await channel.ready;
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      throw error;
    }
    return pairingChannel(channel, queue, () => signal.removeEventListener('abort', onAbort));
  };
}

/** pairingChannel exposes a joined TemporaryChannel as a receive-only PairingChannel. */
function pairingChannel(
  channel: TemporaryChannel,
  queue: MessageQueue,
  detach: () => void
): PairingChannel {
  return {
    channelId: channel.channelId,
    messages: () => queue,
    close: async () => {
      detach();
      channel.close();
    },
  };
}

/**
 * installRelayPairingChannel installs the relay opener when a v2 endpoint is
 * configured (ff1Relayer.v2Endpoint, FF1_RELAY_V2_ENDPOINT, or the default
 * derived from the relayer). Without one, or with an invalid relayer config,
 * `device pair` keeps the default opener, which says pairing is unavailable.
 *
 * @param getConfig - Relayer config source (tests inject one)
 */
export function installRelayPairingChannel(
  getConfig: () => { v2Endpoint?: string } = getFF1RelayerConfig
): void {
  let endpoint: string | undefined;
  try {
    endpoint = getConfig().v2Endpoint;
  } catch (error) {
    logger.debug(`Relay pairing channel not installed: ${(error as Error).message}`);
    return;
  }
  if (endpoint) {
    setPairingChannelOpener(relayPairingChannelOpener(endpoint));
  }
}
