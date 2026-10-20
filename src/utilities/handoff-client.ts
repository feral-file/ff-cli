import { defaultDeadlineFetch } from './http';
import { webcrypto } from 'node:crypto';
import {
  HANDOFF_ALGORITHM,
  decryptHandoffMessage,
  exportHandoffPublicJwk,
  generateHandoffKeyPair,
  handoffVerificationCode,
  type BrokerHandoffMessage,
} from './handoff-crypto';
import { type DeviceProfile, parseProfile } from './control/codec';

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

/** TopicHandoffPayload is the v1 handoff: relayer topic only (old firmware). */
export interface TopicHandoffPayload {
  v: 1;
  type: 'ff1_topic_handoff';
  channelId: string;
  deviceId: string;
  deviceName?: string;
  topicId: string;
  sentAt: string;
}

/**
 * ControllerHandoffPayload is the v2 handoff (feral-file#3551 M6): the owner
 * app sends the FF1's control profile, which ff-cli pins as the trust root
 * for every reply, plus the relayer topic when the device still uses it for
 * routing. The handoff channel is end-to-end encrypted and the user compares
 * a verification code, so this is the one place the profile may come from;
 * `/api/v2/status` on the LAN is unauthenticated and is never pinned.
 */
export interface ControllerHandoffPayload {
  v: 2;
  type: 'ff1_controller_handoff';
  channelId: string;
  deviceId: string;
  deviceName?: string;
  profile: DeviceProfile;
  topicId?: string;
  sentAt: string;
}

export type HandoffPayload = TopicHandoffPayload | ControllerHandoffPayload;

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

/**
 * parseHandoffPayload accepts a v2 controller handoff or a v1 topic handoff
 * for the selected device and rejects everything else.
 *
 * @param value - Decrypted handoff plaintext
 * @param channelId - This receiver's channel
 * @param expectedDeviceId - The configured device's stable ID
 * @returns The validated payload
 * @throws {Error} When the payload is for another channel or device, or malformed
 */
export function parseHandoffPayload(
  value: unknown,
  channelId: string,
  expectedDeviceId: string
): HandoffPayload {
  const version = (value as { v?: unknown } | null)?.v;
  return version === 2
    ? parseControllerPayload(value, channelId, expectedDeviceId)
    : parseTopicPayload(value, channelId, expectedDeviceId);
}

/**
 * parseControllerPayload validates a v2 payload. profile.dev must equal the
 * payload deviceId and the configured device ID exactly (ff1-control-v1 §2:
 * deviceId is compared exactly); the profile itself is checked with the
 * protocol's closed-set JWK rules.
 */
function parseControllerPayload(
  value: unknown,
  channelId: string,
  expectedDeviceId: string
): ControllerHandoffPayload {
  const payload = value as Partial<ControllerHandoffPayload> & { profile?: unknown };
  const mismatch = new Error('received controller handoff does not match the selected FF1 device');
  if (
    payload.type !== 'ff1_controller_handoff' ||
    payload.channelId !== channelId ||
    typeof payload.deviceId !== 'string' ||
    payload.deviceId !== expectedDeviceId.trim().toUpperCase() ||
    typeof payload.sentAt !== 'string' ||
    Number.isNaN(Date.parse(payload.sentAt)) ||
    (payload.topicId !== undefined &&
      (typeof payload.topicId !== 'string' || payload.topicId.trim().length === 0))
  ) {
    throw mismatch;
  }
  let profile: DeviceProfile;
  try {
    profile = parseProfile(payload.profile);
  } catch (error) {
    throw new Error(
      `received controller handoff has an invalid FF1 profile: ${(error as Error).message}`
    );
  }
  if (profile.dev !== payload.deviceId) {
    throw mismatch;
  }
  return { ...(payload as ControllerHandoffPayload), profile };
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

/** One short-lived CLI-side channel waiting for a mobile handoff (v2 controller profile or v1 topic). */
export class HandoffReceiver {
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
  ): Promise<HandoffReceiver> {
    // Production default rides the shared deadline (#101 review).
    const fetchFn = options.fetchFn ?? defaultDeadlineFetch;
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
    return new HandoffReceiver(
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

  /**
   * Poll until mobile sends a valid encrypted handoff (v2 controller profile
   * or v1 topic) for the selected device.
   */
  async receiveHandoff(options: {
    expectedDeviceId: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  }): Promise<HandoffPayload> {
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
        return parseHandoffPayload(plaintext, this.channelId, options.expectedDeviceId);
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 1000));
    }
    throw new Error('Timed out waiting for the mobile app handoff');
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
