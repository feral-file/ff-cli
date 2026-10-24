/**
 * P-256 JWK handling for the FF1 control protocol v1 (§2).
 *
 * Every key the protocol carries (device, controller, ephemeral) is a P-256
 * JWK with EXACTLY the members kty, crv, x, y. A private `d` in a public slot
 * is an error, never ignored: a client that ships its private key has a bug
 * this module must not paper over. The Go reference is control/jwk.go.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  ControlFormatError,
  b64uEncode,
  isB64uOfLength,
  stringMember,
  strictObject,
} from './strict-json';

/** PublicJwk is a validated P-256 public key in wire shape. */
export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** PrivateJwk is a P-256 private key; it never leaves the controller file. */
export interface PrivateJwk extends PublicJwk {
  d: string;
}

const COORD_LEN = 32;

/**
 * parsePublicJwk validates a parsed JWK object: exact member set, `EC`/`P-256`,
 * 32-byte canonical base64url coordinates, and a point on the curve (Node's
 * key import runs the SEC 1 on-curve check and rejects the identity).
 *
 * @param value - Parsed JSON value (from parseStrictJson or a trusted literal)
 * @param what - Name used in error messages
 * @returns The key in canonical member order
 * @throws {ControlFormatError} When the key is malformed or off-curve
 */
export function parsePublicJwk(value: unknown, what = 'JWK'): PublicJwk {
  const obj = strictObject(value, ['kty', 'crv', 'x', 'y'], [], what);
  if (stringMember(obj, 'kty') !== 'EC' || stringMember(obj, 'crv') !== 'P-256') {
    throw new ControlFormatError(`${what} is not an EC P-256 key`);
  }
  const x = stringMember(obj, 'x');
  const y = stringMember(obj, 'y');
  if (!isB64uOfLength(x, COORD_LEN) || !isB64uOfLength(y, COORD_LEN)) {
    throw new ControlFormatError(`${what} coordinates must be 32-byte base64url`);
  }
  const jwk: PublicJwk = { crv: 'P-256', kty: 'EC', x, y };
  try {
    createPublicKey({ key: { ...jwk }, format: 'jwk' });
  } catch {
    throw new ControlFormatError(`${what} is not a point on P-256`);
  }
  return jwk;
}

/**
 * parsePrivateJwk validates a stored private JWK: exact members kty, crv, x,
 * y, d, and `d` must reproduce `x`,`y`. A mismatch means the file was edited
 * or corrupted, and trusting either half would sign with a key the device does
 * not have on record.
 *
 * @param value - Parsed JSON value
 * @param what - Name used in error messages
 * @returns The private key
 * @throws {ControlFormatError} When malformed or inconsistent
 */
export function parsePrivateJwk(value: unknown, what = 'private JWK'): PrivateJwk {
  const obj = strictObject(value, ['kty', 'crv', 'x', 'y', 'd'], [], what);
  const pub = parsePublicJwk({ kty: obj.kty, crv: obj.crv, x: obj.x, y: obj.y }, what);
  const d = stringMember(obj, 'd');
  if (!isB64uOfLength(d, COORD_LEN)) {
    throw new ControlFormatError(`${what} d must be 32-byte base64url`);
  }
  let derived: { x?: string; y?: string };
  try {
    derived = createPublicKey(createPrivateKey({ key: { ...pub, d }, format: 'jwk' })).export({
      format: 'jwk',
    });
  } catch {
    throw new ControlFormatError(`${what} is not a valid P-256 private key`);
  }
  if (derived.x !== pub.x || derived.y !== pub.y) {
    throw new ControlFormatError(`${what} d does not match x,y`);
  }
  return { ...pub, d };
}

/**
 * publicOf strips a private JWK down to its canonical public members.
 *
 * @param key - Private or public JWK
 * @returns The public JWK in thumbprint member order
 */
export function publicOf(key: PublicJwk): PublicJwk {
  return { crv: 'P-256', kty: 'EC', x: key.x, y: key.y };
}

/**
 * canonicalJwkJson is the RFC 7638 required-member serialization, which is
 * also the wire form this CLI emits, so a JWK it writes is byte-identical to
 * the input of its own thumbprint (§2 "SHOULD emit in thumbprint order").
 *
 * @param key - JWK
 * @returns `{"crv":"P-256","kty":"EC","x":"…","y":"…"}`
 */
export function canonicalJwkJson(key: PublicJwk): string {
  return `{"crv":"P-256","kty":"EC","x":${JSON.stringify(key.x)},"y":${JSON.stringify(key.y)}}`;
}

/**
 * thumbprint is the RFC 7638 JWK thumbprint of §2: b64u(SHA-256) of the
 * canonical member serialization. It is always 43 characters.
 *
 * @param key - JWK (private members are ignored)
 * @returns The thumbprint
 */
export function thumbprint(key: PublicJwk): string {
  return b64uEncode(createHash('sha256').update(canonicalJwkJson(key), 'utf8').digest());
}

/**
 * isThumbprint reports whether value is thumbprint-shaped (b64u of 32 bytes).
 *
 * @param value - Candidate value
 * @returns True for a 43-character base64url SHA-256
 */
export function isThumbprint(value: unknown): value is string {
  return typeof value === 'string' && value.length === 43 && isB64uOfLength(value, 32);
}

/**
 * generatePrivateJwk creates a fresh P-256 key pair as a private JWK.
 *
 * @returns A private JWK in canonical member order plus `d`
 */
export function generatePrivateJwk(): PrivateJwk {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  return { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y, d: jwk.d };
}

/**
 * sameKey reports whether two JWKs are the same point.
 *
 * @param a - First key
 * @param b - Second key
 * @returns True when x and y match
 */
export function sameKey(a: PublicJwk, b: PublicJwk): boolean {
  return a.x === b.x && a.y === b.y;
}
