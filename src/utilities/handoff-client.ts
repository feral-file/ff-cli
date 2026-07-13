import { webcrypto } from 'node:crypto';
import {
  HANDOFF_ALGORITHM,
  decryptHandoffMessage,
  exportHandoffPublicJwk,
  generateHandoffKeyPair,
  handoffVerificationCode,
  type BrokerHandoffMessage,
} from './handoff-crypto';

const DEFAULT_HANDOFF_URL = 'https://handoff.feralfile.com';

interface CreateChannelResponse {
  channelId: string;
  minterToken: string;
  shortCode: string;
  expiresAt: string;
}

interface PollResponse {
  channelId: string;
  messages: BrokerHandoffMessage[];
}

export interface TopicHandoffPayload {
  v: 1;
  type: 'ff1_topic_handoff';
  channelId: string;
  deviceId: string;
  deviceName?: string;
  topicId: string;
  sentAt: string;
}

function brokerBaseUrl(value?: string): string {
  return (value || process.env.FF1_HANDOFF_URL || DEFAULT_HANDOFF_URL).replace(/\/$/, '');
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

function parseCreated(value: unknown): CreateChannelResponse {
  const record = value as Partial<CreateChannelResponse> | null;
  if (
    !record ||
    typeof record.channelId !== 'string' ||
    !record.channelId.startsWith('ch_') ||
    typeof record.minterToken !== 'string' ||
    typeof record.shortCode !== 'string' ||
    !/^\d{6}$/.test(record.shortCode) ||
    typeof record.expiresAt !== 'string'
  ) {
    throw new Error('handoff channel response is invalid');
  }
  return record as CreateChannelResponse;
}

function parsePoll(value: unknown, channelId: string): PollResponse {
  const record = value as Partial<PollResponse> | null;
  if (record?.channelId !== channelId || !Array.isArray(record.messages)) {
    throw new Error('handoff poll response is invalid');
  }
  return record as PollResponse;
}

function parseTopicPayload(
  value: unknown,
  channelId: string,
  expectedDeviceId: string
): TopicHandoffPayload {
  const payload = value as Partial<TopicHandoffPayload> | null;
  if (
    payload?.v !== 1 ||
    payload.type !== 'ff1_topic_handoff' ||
    payload.channelId !== channelId ||
    typeof payload.deviceId !== 'string' ||
    payload.deviceId.trim().toUpperCase() !== expectedDeviceId.trim().toUpperCase() ||
    typeof payload.topicId !== 'string' ||
    payload.topicId.trim().length === 0 ||
    typeof payload.sentAt !== 'string' ||
    Number.isNaN(Date.parse(payload.sentAt))
  ) {
    throw new Error('received topic handoff does not match the selected FF1 device');
  }
  return payload as TopicHandoffPayload;
}

/** One short-lived CLI-side channel waiting for a mobile topic transfer. */
export class TopicHandoffReceiver {
  private constructor(
    readonly baseUrl: string,
    readonly channelId: string,
    readonly shortCode: string,
    readonly verificationCode: string,
    readonly expiresAt: string,
    private readonly minterToken: string,
    private readonly privateKey: webcrypto.CryptoKey,
    private readonly fetchFn: typeof fetch
  ) {}

  /** Ask the handoff broker for a one-time six-digit pairing channel. */
  static async create(
    options: {
      baseUrl?: string;
      fetchFn?: typeof fetch;
    } = {}
  ): Promise<TopicHandoffReceiver> {
    const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    const baseUrl = brokerBaseUrl(options.baseUrl);
    const keyPair = await generateHandoffKeyPair();
    const publicKey = await exportHandoffPublicJwk(keyPair.publicKey);
    const response = await fetchFn(new URL('/v1/channels', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        algorithm: HANDOFF_ALGORITHM,
        minterPublicKeyJwk: publicKey,
        idleTtlSeconds: 300,
        shortCodeRequested: true,
      }),
    });
    const created = parseCreated(await responseJson(response, 'handoff channel creation'));
    const verificationCode = handoffVerificationCode({
      channelId: created.channelId,
      minterPublicKeyJwk: publicKey,
    });
    return new TopicHandoffReceiver(
      baseUrl,
      created.channelId,
      created.shortCode,
      verificationCode,
      created.expiresAt,
      created.minterToken,
      keyPair.privateKey,
      fetchFn
    );
  }

  /** Poll until mobile sends a valid encrypted topic for the selected device. */
  async receiveTopic(options: {
    expectedDeviceId: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  }): Promise<TopicHandoffPayload> {
    const deadline = Date.now() + (options.maxWaitMs ?? 300_000);
    let afterSeq = 0;
    while (Date.now() <= deadline) {
      const url = new URL(
        `/v1/channels/${encodeURIComponent(this.channelId)}/messages`,
        this.baseUrl
      );
      url.searchParams.set('afterSeq', String(afterSeq));
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.minterToken}` },
      });
      const poll = parsePoll(await responseJson(response, 'handoff poll'), this.channelId);
      for (const message of poll.messages) {
        afterSeq = Math.max(afterSeq, message.seq);
        if (
          message.sender !== 'browser' ||
          message.recipient !== 'minter' ||
          !message.senderPublicKeyJwk
        ) {
          continue;
        }
        const plaintext = await decryptHandoffMessage({
          privateKey: this.privateKey,
          peerPublicKeyJwk: message.senderPublicKeyJwk,
          channelId: this.channelId,
          seq: message.seq,
          message,
        });
        return parseTopicPayload(plaintext, this.channelId, options.expectedDeviceId);
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 1000));
    }
    throw new Error('Timed out waiting for the mobile app topic transfer');
  }

  /** Close the broker channel and invalidate its participant credentials. */
  async close(): Promise<void> {
    const response = await this.fetchFn(
      new URL(`/v1/channels/${encodeURIComponent(this.channelId)}`, this.baseUrl),
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.minterToken}` },
      }
    );
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new Error(`handoff channel close failed with HTTP ${response.status}`);
    }
  }
}
