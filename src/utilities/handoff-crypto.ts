import { createHash, randomBytes, webcrypto } from 'node:crypto';

/** Wire algorithm required by the handoff broker protocol. */
export const HANDOFF_ALGORITHM = 'P256-HKDF-SHA256-AES-256-GCM' as const;

export type HandoffRole = 'browser' | 'minter';

export interface EncryptedHandoffMessage {
  messageId: string;
  sender: HandoffRole;
  recipient: HandoffRole;
  algorithm: typeof HANDOFF_ALGORITHM;
  aad: string;
  nonce: string;
  ciphertext: string;
  senderPublicKeyJwk?: webcrypto.JsonWebKey;
}

export interface BrokerHandoffMessage extends EncryptedHandoffMessage {
  seq: number;
}

interface HandoffAAD {
  v: 1;
  channelId: string;
  messageId: string;
  seq: number;
  sender: HandoffRole;
  recipient: HandoffRole;
  algorithm: typeof HANDOFF_ALGORITHM;
}

/** canonicalJson serializes JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

/** Create the out-of-band key commitment shown by both CLI and mobile. */
export function handoffVerificationCode(input: {
  channelId: string;
  minterPublicKeyJwk: webcrypto.JsonWebKey;
}): string {
  const commitment = createHash('sha256')
    .update(
      canonicalJson({
        v: 1,
        algorithm: HANDOFF_ALGORITHM,
        channelId: input.channelId,
        minterPublicKeyJwk: input.minterPublicKeyJwk,
      })
    )
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `${commitment.slice(0, 4)}-${commitment.slice(4, 8)}-${commitment.slice(8, 12)}`;
}

/** Generate an ephemeral P-256 ECDH key pair for one broker channel. */
export async function generateHandoffKeyPair(): Promise<webcrypto.CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])) as webcrypto.CryptoKeyPair;
}

/** Export the public half of an ephemeral handoff key as JWK. */
export async function exportHandoffPublicJwk(
  publicKey: webcrypto.CryptoKey
): Promise<webcrypto.JsonWebKey> {
  return webcrypto.subtle.exportKey('jwk', publicKey);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function handoffAAD(input: {
  channelId: string;
  messageId: string;
  seq: number;
  sender: HandoffRole;
  recipient: HandoffRole;
}): HandoffAAD {
  return {
    v: 1,
    channelId: input.channelId,
    messageId: input.messageId,
    seq: input.seq,
    sender: input.sender,
    recipient: input.recipient,
    algorithm: HANDOFF_ALGORITHM,
  };
}

async function deriveAesKey(input: {
  privateKey: webcrypto.CryptoKey;
  peerPublicKeyJwk: webcrypto.JsonWebKey;
  channelId: string;
}): Promise<webcrypto.CryptoKey> {
  const peer = await webcrypto.subtle.importKey(
    'jwk',
    input.peerPublicKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedBits = await webcrypto.subtle.deriveBits(
    { name: 'ECDH', public: peer },
    input.privateKey,
    256
  );
  const hkdfKey = await webcrypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const saltInput = canonicalJson({
    algorithm: HANDOFF_ALGORITHM,
    channelId: input.channelId,
    v: 1,
  });
  const salt = await webcrypto.subtle.digest('SHA-256', Buffer.from(saltInput));
  return webcrypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: Buffer.from('ff-mint-pairing/v1/aes-gcm'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt a JSON payload into the broker's authenticated envelope format. */
export async function encryptHandoffMessage(input: {
  privateKey: webcrypto.CryptoKey;
  senderPublicKeyJwk?: webcrypto.JsonWebKey;
  peerPublicKeyJwk: webcrypto.JsonWebKey;
  channelId: string;
  messageId: string;
  sender: HandoffRole;
  recipient: HandoffRole;
  plaintext: unknown;
}): Promise<EncryptedHandoffMessage> {
  const aad = handoffAAD({ ...input, seq: 0 });
  const aadBytes = Buffer.from(canonicalJson(aad));
  const nonce = randomBytes(12);
  const key = await deriveAesKey(input);
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aadBytes, tagLength: 128 },
    key,
    Buffer.from(canonicalJson(input.plaintext))
  );
  return {
    messageId: input.messageId,
    sender: input.sender,
    recipient: input.recipient,
    algorithm: HANDOFF_ALGORITHM,
    aad: base64UrlEncode(aadBytes),
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    ...(input.senderPublicKeyJwk ? { senderPublicKeyJwk: input.senderPublicKeyJwk } : {}),
  };
}

/** Decrypt and validate one channel-bound broker message. */
export async function decryptHandoffMessage(input: {
  privateKey: webcrypto.CryptoKey;
  peerPublicKeyJwk: webcrypto.JsonWebKey;
  channelId: string;
  seq: number;
  message: BrokerHandoffMessage;
}): Promise<unknown> {
  const { message } = input;
  if (message.algorithm !== HANDOFF_ALGORITHM) {
    throw new Error('encrypted message algorithm mismatch');
  }
  const aadBytes = base64UrlDecode(message.aad);
  const aad = JSON.parse(Buffer.from(aadBytes).toString('utf8')) as Partial<HandoffAAD>;
  const valid =
    aad.v === 1 &&
    aad.channelId === input.channelId &&
    aad.messageId === message.messageId &&
    aad.sender === message.sender &&
    aad.recipient === message.recipient &&
    aad.algorithm === HANDOFF_ALGORITHM &&
    (aad.seq === 0 || aad.seq === input.seq);
  if (!valid) {
    throw new Error('encrypted message channel binding mismatch');
  }
  const nonce = base64UrlDecode(message.nonce);
  if (nonce.length !== 12) {
    throw new Error('AES-GCM nonce must be 12 bytes');
  }
  const key = await deriveAesKey(input);
  const plaintext = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aadBytes, tagLength: 128 },
    key,
    base64UrlDecode(message.ciphertext)
  );
  return JSON.parse(Buffer.from(plaintext).toString('utf8')) as unknown;
}

/** Create a collision-resistant broker message identifier. */
export function randomHandoffMessageId(): string {
  return `msg_${randomBytes(16).toString('base64url')}`;
}
