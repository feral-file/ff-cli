/**
 * The pairing channel of owner-initiated registration
 * (ffos-user docs/ff1-control-v1.md §5.6 step 1): a relay channel named by
 * the random channelId in the controller QR, on which the owner's app sends
 * the sealed registration result.
 *
 * ff-cli only consumes this interface. The relay v2 carrier
 * (`/v2/channels/{channelId}/connections`) is implemented by
 * relay-pairing-channel.ts, which plugs in with setPairingChannelOpener at
 * startup when a v2 endpoint is configured. Without one the default opener
 * fails with PairingTransportUnavailableError, so the CLI says so instead of
 * waiting on nothing.
 *
 * The channel is untrusted: anyone who saw the QR can join it and send bytes.
 * Every message is opened and checked by registration.ts before it means
 * anything; the channel carries no authority of its own.
 */

/** PairingChannel is one joined relay pairing channel. */
export interface PairingChannel {
  readonly channelId: string;
  /** Payloads other connections sent on the channel, in arrival order. */
  messages(): AsyncIterable<Uint8Array>;
  /**
   * Sends on the channel. Optional: the CLI controller only receives the
   * owner's result, so an adapter for it may leave this out.
   */
  send?(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * PairingChannelOpener joins the channel. The signal aborts the join and,
 * once joined, ends the message iteration.
 */
export type PairingChannelOpener = (
  channelId: string,
  signal: AbortSignal
) => Promise<PairingChannel>;

/** PairingTransportUnavailableError is thrown when no relay pairing channel is built in. */
export class PairingTransportUnavailableError extends Error {
  constructor() {
    super(
      'owner-initiated pairing needs the relay v2 pairing channel, which this build does not include yet'
    );
    this.name = 'PairingTransportUnavailableError';
  }
}

const unavailableOpener: PairingChannelOpener = async () => {
  throw new PairingTransportUnavailableError();
};

let currentOpener: PairingChannelOpener = unavailableOpener;

/**
 * setPairingChannelOpener installs the relay adapter's opener; undefined
 * restores the default (unavailable) one.
 *
 * @param opener - Opener to use for `ff-cli device pair`
 */
export function setPairingChannelOpener(opener: PairingChannelOpener | undefined): void {
  currentOpener = opener ?? unavailableOpener;
}

/**
 * pairingChannelOpener returns the installed opener.
 *
 * @returns The opener `device pair` uses unless a caller injects one
 */
export function pairingChannelOpener(): PairingChannelOpener {
  return currentOpener;
}
