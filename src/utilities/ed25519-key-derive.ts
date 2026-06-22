import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

/**
 * RFC 5480-style SubjectPublicKeyInfo prefix for Ed25519 public keys (raw 32 octets in BIT STRING).
 */
const ED25519_SPKI_RAW_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawEd25519PublicBytesToPem(raw32: Buffer): string {
  if (raw32.length !== 32) {
    throw new Error('Ed25519 raw public key must be 32 bytes');
  }
  const der = Buffer.concat([ED25519_SPKI_RAW_PREFIX, raw32]);
  const pub = createPublicKey({ key: der, format: 'der', type: 'spki' });
  assertEd25519Public(pub);
  return pub.export({ format: 'pem', type: 'spki' }).toString();
}

/**
 * normalizeVerifyPublicKeyToPem interprets `--public-key` values documented for `verify`:
 * PEM SPKI, 64-character hex (optional `0x`), standard base64 of exactly 32 raw bytes,
 * or DER SPKI as base64 (typical single-line export).
 *
 * dp1-js expects PEM-friendly material in practice; this keeps CLI input aligned with docs.
 *
 * @param material - Non-empty key string from the CLI or config-derived PEM
 * @returns PEM-encoded SPKI Ed25519 public key
 * @throws Error if the material cannot be decoded as Ed25519 public key material
 */
export function normalizeVerifyPublicKeyToPem(material: string): string {
  const trimmed = material.trim();
  if (!trimmed) {
    throw new Error('Public key material is empty');
  }

  if (trimmed.includes('BEGIN')) {
    const pub = createPublicKey({ key: trimmed, format: 'pem' });
    assertEd25519Public(pub);
    return pub.export({ format: 'pem', type: 'spki' }).toString();
  }

  const hexCompact = trimmed.replace(/^0x/i, '').replace(/\s/g, '');
  const hexRegex = /^[0-9a-fA-F]{64}$/;
  if (hexRegex.test(hexCompact)) {
    return rawEd25519PublicBytesToPem(Buffer.from(hexCompact, 'hex'));
  }

  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  if (base64Regex.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === 32) {
      return rawEd25519PublicBytesToPem(buf);
    }
    try {
      const pub = createPublicKey({ key: buf, format: 'der', type: 'spki' });
      assertEd25519Public(pub);
      return pub.export({ format: 'pem', type: 'spki' }).toString();
    } catch {
      // fall through
    }
  }

  throw new Error(
    'Unrecognized Ed25519 public key format for verify (expected PEM, 32-byte hex, 32-byte base64, or SPKI DER base64)'
  );
}

/**
 * RFC 8410 PKCS#8 prefix for Ed25519: nested OCTET STRING holds the 32-byte seed.
 * Used so 32-byte hex seeds work on Node versions that reject `type: 'raw'` imports.
 */
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function ed25519SeedBytesToPkcs8(seed32: Buffer): Buffer {
  if (seed32.length !== 32) {
    throw new Error('Ed25519 seed must be 32 bytes');
  }
  return Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed32]);
}

/**
 * parsePlaylistPrivateKeyToKeyObject interprets playlist signing material the same way
 * operators configure it: PKCS#8 DER as base64 (setup default), optional 32-byte raw
 * seed as hex, PKCS#8 as hex, or PEM.
 *
 * @param material - Trimmed private key string from config or env
 * @returns Node.js KeyObject for the Ed25519 private key
 * @throws Error if the material cannot be parsed or is not Ed25519
 */
export function parsePlaylistPrivateKeyToKeyObject(material: string): KeyObject {
  const trimmed = material.trim();
  if (!trimmed) {
    throw new Error('Private key material is empty');
  }

  if (trimmed.includes('BEGIN')) {
    const key = createPrivateKey({ key: trimmed, format: 'pem' });
    assertEd25519(key);
    return key;
  }

  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  const hexRegex = /^(0x)?[0-9a-fA-F]+$/;

  if (base64Regex.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === 0) {
      throw new Error('Invalid base64 private key');
    }
    try {
      const key = createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' });
      assertEd25519(key);
      return key;
    } catch {
      // Continue to other strategies (e.g. hex path may apply for unusual configs)
    }
    // A 32-byte base64 value is a raw Ed25519 seed (not PKCS#8). The example
    // config's `_BASE64_OR_HEX` placeholder invites this, so accept it by
    // wrapping the seed in a PKCS#8 envelope, mirroring the hex-seed path.
    if (buf.length === 32) {
      try {
        const der = ed25519SeedBytesToPkcs8(buf);
        const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
        assertEd25519(key);
        return key;
      } catch {
        // fall through to remaining strategies
      }
    }
  }

  if (hexRegex.test(trimmed)) {
    const raw = Buffer.from(trimmed.replace(/^0x/i, ''), 'hex');
    if (raw.length === 32) {
      try {
        const der = ed25519SeedBytesToPkcs8(raw);
        const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
        assertEd25519(key);
        return key;
      } catch {
        // fall through to full PKCS#8-in-hex
      }
    }
    try {
      const key = createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' });
      assertEd25519(key);
      return key;
    } catch {
      // fall through
    }
  }

  throw new Error(
    'Unrecognized Ed25519 private key format (expected PKCS#8 base64, 32-byte hex seed, PKCS#8 hex, or PEM)'
  );
}

/**
 * deriveEd25519PublicKeyForVerify exports the public half as PEM so legacy
 * verification can hand Node a decoder-friendly public key string directly.
 *
 * @param privateKeyMaterial - Same encoding rules as `playlist.privateKey` / `PLAYLIST_PRIVATE_KEY`
 * @returns PEM-encoded SPKI public key
 */
export function deriveEd25519PublicKeyForVerify(privateKeyMaterial: string): string {
  const privateKey = parsePlaylistPrivateKeyToKeyObject(privateKeyMaterial);
  const publicKey = createPublicKey(privateKey);
  assertEd25519Public(publicKey);
  return publicKey.export({ format: 'pem', type: 'spki' }).toString();
}

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Configured private key must be an Ed25519 key');
  }
}

function assertEd25519Public(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Public key must be Ed25519');
  }
}
