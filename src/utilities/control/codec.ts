/**
 * FF1 control protocol v1 codec (ffos-user docs/ff1-control-v1.md), the
 * controller side: seal requests (§3), open replies (§4) and sealed
 * notifications (§9), and the approval code (§5.4).
 *
 * This is the TypeScript implementation that spec §12 requires to round-trip
 * the Go reference's fixtures (tests/fixtures/ff1-control-v1). Cryptography is
 * done by `jose` (panva); everything jose is lenient about is checked here
 * first, because the spec is stricter than RFC 7515/7516:
 *
 * - Every protected header has a CLOSED member set. jose would accept a `zip`,
 *   `jku` or extra member; this module rejects them before jose sees the token.
 * - Duplicate members and non-canonical integers are rejected (strict-json.ts).
 * - Only ES256 (raw 64-byte r||s), ECDH-ES (direct) and dir with A256GCM.
 *
 * Do not "simplify" a check here into a jose option: the closed-set rules are
 * the protocol, and two implementations disagreeing on them is the bug class
 * the spec exists to prevent.
 */

import { createHash, randomBytes } from 'node:crypto';
import { CompactEncrypt, CompactSign, compactDecrypt, compactVerify, importJWK } from 'jose';
import {
  ControlFormatError,
  b64uDecode,
  b64uEncode,
  boolMember,
  isB64uOfLength,
  isPlainObject,
  parseStrictJson,
  stringMember,
  strictObject,
  toPlainJson,
  uintMember,
} from './strict-json';
import {
  type PrivateJwk,
  type PublicJwk,
  canonicalJwkJson,
  isThumbprint,
  parsePublicJwk,
  publicOf,
  thumbprint,
} from './jwk';

/** MAX_COMPACT_BYTES bounds a whole compact object before any decoding (§3.1). */
export const MAX_COMPACT_BYTES = 4 * 1024 * 1024;
/** MAX_HEADER_BYTES bounds the base64url protected-header segment (§3.1). */
export const MAX_HEADER_BYTES = 4 * 1024;
/**
 * MAX_ENVELOPE_COMPACT_BYTES is what ff-cli lets a request grow to: the LAN
 * hub caps the whole cast BODY at 4 MiB (§10), so the compact leaves room for
 * the `{"command":"ff1Envelope","request":{"v":1,"jwe":…}}` wrapper.
 */
export const MAX_ENVELOPE_COMPACT_BYTES = MAX_COMPACT_BYTES - 1024;
/** DEFAULT_REQUEST_LIFETIME_SECONDS is exp - iat; the spec allows [1, 120]. */
export const DEFAULT_REQUEST_LIFETIME_SECONDS = 60;

const TYP_REQ_JWE = 'ff1-req+jwe';
const TYP_REQ_JWS = 'ff1-req+jws';
const TYP_RES_JWE = 'ff1-res+jwe';
const TYP_RES_JWS = 'ff1-res+jws';
const TYP_NTF_JWE = 'ff1-ntf+jwe';
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;
const KEY_LEN = 32;
const ES256_SIG_LEN = 64;
const RID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABEL_CHARS = 64;

/** CONTROL_PLATFORMS are the enroll.platform values of §5. */
export const CONTROL_PLATFORMS = ['ios', 'android', 'cli', 'other'] as const;
export type ControlPlatform = (typeof CONTROL_PLATFORMS)[number];

/** ControlRole is the grant role a device hands out (§5.5). */
export type ControlRole = 'owner' | 'controller';

/** DeviceProfile is the public device profile of §2. */
export interface DeviceProfile {
  v: 1;
  dev: string;
  gen: string;
  sig: PublicJwk;
  enc: PublicJwk;
}

/** ControllerKeys are this controller's private keys (§2 ctlSig, ctlEnc). */
export interface ControllerKeys {
  sig: PrivateJwk;
  enc: PrivateJwk;
}

/** EnrollObject is the §5 enroll claim. */
export interface EnrollObject {
  sig: PublicJwk;
  enc: PublicJwk;
  label: string;
  platform: ControlPlatform;
  inv?: string;
}

export type RequestOp = 'cmd' | 'enroll' | 'requestAccess';

/** RequestClaims are the §3.3 claims. */
export interface RequestClaims {
  v: 1;
  dev: string;
  gen: string;
  ctl: string;
  rid: string;
  ctr: number;
  iat: number;
  exp: number;
  op: RequestOp;
  rk: string;
  cmd?: string;
  req?: Record<string, unknown>;
  enroll?: EnrollObject;
}

/** ReplyClaims are the §4.1 reply claims. */
export interface ReplyClaims {
  v: 1;
  dev: string;
  gen: string;
  ctl: string;
  rid: string;
  iat: number;
  ok: boolean;
  code?: string;
  res?: unknown;
}

/** NotificationClaims are the §9 sealed-notification claims. */
export interface NotificationClaims {
  v: 1;
  dev: string;
  gen: string;
  ctl: string;
  ep: string;
  seq: number;
  iat: number;
  type: string;
  body: unknown;
}

/** RequestInput is everything sealRequest needs; omitted fields are generated. */
export interface RequestInput {
  profile: DeviceProfile;
  keys: ControllerKeys;
  ctr: number;
  op: RequestOp;
  cmd?: string;
  req?: Record<string, unknown>;
  enroll?: EnrollObject;
  /** Unix seconds; defaults to the wall clock. */
  now?: number;
  lifetimeSeconds?: number;
  /** Test seams: fixtures fix these. Production must leave them unset. */
  rid?: string;
  rk?: Uint8Array;
  ephemeralKey?: PrivateJwk;
  iv?: Uint8Array;
}

/** SealedRequest is a request ready to send plus what is needed to open its reply. */
export interface SealedRequest {
  compact: string;
  jws: string;
  claims: RequestClaims;
  rk: Uint8Array;
}

/**
 * parseProfile validates a device profile `{v:1,dev,gen,sig,enc}` (§2) with
 * a closed member set. The profile is the pin source, so it is never trusted
 * partially.
 *
 * @param value - Parsed JSON value
 * @returns The profile with canonical JWKs
 * @throws {ControlFormatError} When malformed
 */
export function parseProfile(value: unknown): DeviceProfile {
  const obj = strictObject(value, ['v', 'dev', 'gen', 'sig', 'enc'], [], 'profile');
  if (obj.v !== 1) {
    throw new ControlFormatError('profile v must be 1');
  }
  const dev = stringMember(obj, 'dev');
  const gen = stringMember(obj, 'gen');
  if (!dev) {
    throw new ControlFormatError('profile dev is empty');
  }
  if (!isB64uOfLength(gen, 16)) {
    throw new ControlFormatError('profile gen must be b64u(16 bytes)');
  }
  return {
    v: 1,
    dev,
    gen,
    sig: parsePublicJwk(obj.sig, 'profile sig'),
    enc: parsePublicJwk(obj.enc, 'profile enc'),
  };
}

/**
 * approvalCode is §5.4: the first 4 bytes of
 * SHA-256("ff1-approval-code/v1|" + ctl + "|" + sigPin) as a big-endian
 * uint32, mod 1,000,000, zero-padded to 6 digits. sigPin is thumb(devSig) as
 * THIS controller pinned it, so a LAN man-in-the-middle serving a fake
 * profile produces a code that differs from the one the real device shows
 * the owner.
 *
 * @param ctl - controllerId (thumb(ctlSig))
 * @param sigPin - thumb(devSig) of the pinned profile
 * @returns Six decimal digits
 */
export function approvalCode(ctl: string, sigPin: string): string {
  const digest = createHash('sha256')
    .update(`ff1-approval-code/v1|${ctl}|${sigPin}`, 'utf8')
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/**
 * controllerIdOf returns thumb(ctlSig), the controllerId (§2).
 *
 * @param keys - Controller keys
 * @returns The controllerId
 */
export function controllerIdOf(keys: ControllerKeys): string {
  return thumbprint(keys.sig);
}

/**
 * encodeRequestClaims serializes claims in the reference member order. Order
 * is not significant to the device, but a stable order makes the payload
 * byte-comparable with the Go fixtures.
 *
 * @param c - Claims to encode
 * @returns JSON text
 */
export function encodeRequestClaims(c: RequestClaims): string {
  const parts = [
    `"v":1`,
    `"dev":${JSON.stringify(c.dev)}`,
    `"gen":${JSON.stringify(c.gen)}`,
    `"ctl":${JSON.stringify(c.ctl)}`,
    `"rid":${JSON.stringify(c.rid)}`,
    `"ctr":${c.ctr}`,
    `"iat":${c.iat}`,
    `"exp":${c.exp}`,
    `"op":${JSON.stringify(c.op)}`,
    `"rk":${JSON.stringify(c.rk)}`,
  ];
  if (c.cmd !== undefined) {
    parts.push(`"cmd":${JSON.stringify(c.cmd)}`, `"req":${JSON.stringify(c.req ?? {})}`);
  }
  if (c.enroll) {
    const e = c.enroll;
    const enroll = [
      `"sig":${canonicalJwkJson(e.sig)}`,
      `"enc":${canonicalJwkJson(e.enc)}`,
      `"label":${JSON.stringify(e.label)}`,
      `"platform":${JSON.stringify(e.platform)}`,
    ];
    if (e.inv !== undefined) {
      enroll.push(`"inv":${JSON.stringify(e.inv)}`);
    }
    parts.push(`"enroll":{${enroll.join(',')}}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * buildRequestClaims assembles and validates §3.3 claims. It refuses to build
 * a request the device would answer `invalid_request`, so such a bug surfaces
 * locally instead of burning a counter on the device.
 *
 * @param input - Request input
 * @param rk - Reply key bytes
 * @returns The claims
 * @throws {Error} When the input breaks a §3.3 rule
 */
export function buildRequestClaims(input: RequestInput, rk: Uint8Array): RequestClaims {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const lifetime = input.lifetimeSeconds ?? DEFAULT_REQUEST_LIFETIME_SECONDS;
  const rid = input.rid ?? b64uEncode(randomBytes(16));
  if (!Number.isSafeInteger(input.ctr) || input.ctr < 1) {
    throw new Error('ctr must be a positive integer');
  }
  if (!RID_PATTERN.test(rid) || rk.length !== KEY_LEN) {
    throw new Error('rid or rk is malformed');
  }
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 120) {
    throw new Error('request lifetime must be 1-120 seconds');
  }
  const claims: RequestClaims = {
    v: 1,
    dev: input.profile.dev,
    gen: input.profile.gen,
    ctl: controllerIdOf(input.keys),
    rid,
    ctr: input.ctr,
    iat: now,
    exp: now + lifetime,
    op: input.op,
    rk: b64uEncode(rk),
  };
  if (input.op === 'cmd') {
    assertCommand(input.cmd, input.req, input.enroll);
    claims.cmd = input.cmd;
    claims.req = input.req ?? {};
  } else {
    assertEnroll(input.op, input.enroll, input.cmd, claims.ctl);
    claims.enroll = input.enroll;
  }
  return claims;
}

function assertCommand(cmd: unknown, req: unknown, enroll: unknown): void {
  if (typeof cmd !== 'string' || cmd.length === 0 || Buffer.byteLength(cmd) > 64) {
    throw new Error('cmd must be a 1-64 byte command name');
  }
  if (req !== undefined && !isPlainObject(req)) {
    throw new Error('req must be a JSON object');
  }
  if (enroll !== undefined) {
    throw new Error('op=cmd forbids enroll');
  }
}

function assertEnroll(op: RequestOp, enroll: EnrollObject | undefined, cmd: unknown, ctl: string) {
  if (op !== 'enroll' && op !== 'requestAccess') {
    throw new Error(`unknown op ${String(op)}`);
  }
  if (!enroll || cmd !== undefined) {
    throw new Error(`op=${op} requires enroll and forbids cmd/req`);
  }
  if (thumbprint(enroll.sig) !== ctl) {
    throw new Error('enroll.sig must be the signing key');
  }
  const labelChars = [...enroll.label].length;
  if (labelChars < 1 || labelChars > MAX_LABEL_CHARS) {
    throw new Error('enroll label must be 1-64 characters');
  }
  if (!CONTROL_PLATFORMS.includes(enroll.platform)) {
    throw new Error('enroll platform is invalid');
  }
  if (enroll.inv !== undefined && op !== 'enroll') {
    throw new Error('inv is only allowed with op=enroll');
  }
}

/**
 * signRequest produces the §3.2 inner JWS: header exactly
 * `{"alg":"ES256","kid":ctl,"typ":"ff1-req+jws"}`, raw r||s signature.
 *
 * @param ctlSig - Controller signing key
 * @param payload - Encoded claims
 * @returns Compact JWS
 */
export async function signRequest(ctlSig: PrivateJwk, payload: string): Promise<string> {
  const key = await importJWK({ ...ctlSig }, 'ES256');
  return new CompactSign(new TextEncoder().encode(payload))
    .setProtectedHeader({ alg: 'ES256', kid: thumbprint(ctlSig), typ: TYP_REQ_JWS })
    .sign(key);
}

/**
 * encryptRequest wraps a JWS in the §3.1 request JWE (ECDH-ES direct, A256GCM)
 * for the pinned devEnc.
 *
 * jose appends `epk` to the protected header itself. jose writes its members
 * in the order x, crv, kty, y rather than the thumbprint order the spec
 * RECOMMENDS (SHOULD); the device accepts any order (MUST), so the header is
 * re-parsed and checked for the exact member set and a valid epk instead of
 * hand-rolling the key agreement. That check is what guards against a jose
 * upgrade adding a member (apu/apv/zip) the device would reject.
 *
 * @param devEnc - Pinned device encryption key
 * @param jws - Inner compact JWS
 * @param fixed - Test seam for a fixed ephemeral key and IV
 * @returns Compact JWE
 */
export async function encryptRequest(
  devEnc: PublicJwk,
  jws: string,
  fixed: { ephemeralKey?: PrivateJwk; iv?: Uint8Array } = {}
): Promise<string> {
  const recipient = await importJWK({ ...publicOf(devEnc) }, 'ECDH-ES');
  const builder = new CompactEncrypt(new TextEncoder().encode(jws)).setProtectedHeader({
    alg: 'ECDH-ES',
    enc: 'A256GCM',
    kid: thumbprint(devEnc),
    typ: TYP_REQ_JWE,
    cty: TYP_REQ_JWS,
  });
  if (fixed.ephemeralKey) {
    const epk = await importJWK({ ...fixed.ephemeralKey, ext: true }, 'ECDH-ES', {
      extractable: true,
    });
    builder.setKeyManagementParameters({ epk: epk as Exclude<typeof epk, Uint8Array> });
  }
  if (fixed.iv) {
    builder.setInitializationVector(fixed.iv);
  }
  const compact = await builder.encrypt(recipient);
  checkRequestHeader(compact.split('.')[0], thumbprint(devEnc));
  return compact;
}

/**
 * checkRequestHeader asserts a request JWE header is exactly the §3.1 shape.
 *
 * @param segment - Base64url protected header
 * @param devEncKid - Expected kid
 * @returns The ephemeral public key
 * @throws {ControlFormatError} When the header deviates
 */
export function checkRequestHeader(segment: string, devEncKid: string): PublicJwk {
  const header = parseHeader(segment, {
    alg: 'ECDH-ES',
    enc: 'A256GCM',
    kid: devEncKid,
    typ: TYP_REQ_JWE,
    cty: TYP_REQ_JWS,
    epk: null,
  });
  return parsePublicJwk(header.epk, 'epk');
}

/**
 * sealRequest builds a complete request: claims, inner JWS, outer JWE.
 * A fresh rk, rid, epk and IV are drawn for every call, which is what makes
 * "never resend the same request" structural: callers retry by sealing again.
 *
 * @param input - Request input
 * @returns The sealed request and its reply key
 * @throws {Error} When claims are invalid or the result exceeds 4 MiB
 */
export async function sealRequest(input: RequestInput): Promise<SealedRequest> {
  const rk = input.rk ?? new Uint8Array(randomBytes(KEY_LEN));
  const claims = buildRequestClaims(input, rk);
  const jws = await signRequest(input.keys.sig, encodeRequestClaims(claims));
  const compact = await encryptRequest(input.profile.enc, jws, {
    ephemeralKey: input.ephemeralKey,
    iv: input.iv,
  });
  if (compact.length > MAX_ENVELOPE_COMPACT_BYTES) {
    throw new Error(
      `the encrypted request is ${compact.length} bytes, over the FF1 limit of ${MAX_ENVELOPE_COMPACT_BYTES}; host large playlists by URL instead`
    );
  }
  return { compact, jws, claims, rk };
}

/**
 * parseHeader decodes a protected header and checks its exact member set and
 * the exact string value of each member whose expected value is a string. A
 * null expectation means "present; the caller checks it".
 */
function parseHeader(
  segment: string,
  expected: Record<string, string | null>
): Record<string, unknown> {
  if (!segment || segment.length > MAX_HEADER_BYTES) {
    throw new ControlFormatError('protected header size');
  }
  const header = strictObject(
    parseStrictJson(b64uDecode(segment)),
    Object.keys(expected),
    [],
    'protected header'
  );
  for (const [key, want] of Object.entries(expected)) {
    if (want !== null && header[key] !== want) {
      throw new ControlFormatError(`protected header ${key} is not ${JSON.stringify(want)}`);
    }
  }
  return header;
}

/**
 * splitJwe checks the five-part compact form shared by both dir profiles:
 * size, empty encrypted key, 12-byte IV, 16-byte tag, exact header.
 */
function splitJwe(compact: string, expected: Record<string, string | null>): void {
  if (typeof compact !== 'string' || compact.length > MAX_COMPACT_BYTES) {
    throw new ControlFormatError('compact JWE size');
  }
  const parts = compact.split('.');
  if (parts.length !== 5 || parts[1] !== '') {
    throw new ControlFormatError('compact JWE shape');
  }
  parseHeader(parts[0], expected);
  if (b64uDecode(parts[2]).length !== GCM_IV_LEN || b64uDecode(parts[4]).length !== GCM_TAG_LEN) {
    throw new ControlFormatError('JWE IV or tag length');
  }
  b64uDecode(parts[3]);
}

/** decryptDir opens a dir/A256GCM JWE whose shape splitJwe already checked. */
async function decryptDir(compact: string, key: Uint8Array): Promise<Uint8Array> {
  if (key.length !== KEY_LEN) {
    throw new ControlFormatError('content key length');
  }
  try {
    const { plaintext } = await compactDecrypt(compact, key, {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    return plaintext;
  } catch {
    throw new ControlFormatError('JWE authentication failed');
  }
}

/**
 * verifyReplyJws checks the §4.1 inner JWS against the PINNED devSig and
 * returns its payload bytes.
 */
async function verifyReplyJws(jws: string, devSig: PublicJwk): Promise<Uint8Array> {
  const parts = jws.split('.');
  if (parts.length !== 3) {
    throw new ControlFormatError('compact JWS shape');
  }
  const header = parseHeader(parts[0], { alg: 'ES256', kid: null, typ: TYP_RES_JWS });
  if (!isThumbprint(header.kid) || header.kid !== thumbprint(devSig)) {
    throw new ControlFormatError('reply kid is not the pinned devSig');
  }
  // A DER, truncated or padded signature is never r||s (§3.2).
  if (b64uDecode(parts[2]).length !== ES256_SIG_LEN) {
    throw new ControlFormatError('reply signature length');
  }
  try {
    const key = await importJWK({ ...publicOf(devSig) }, 'ES256');
    const { payload } = await compactVerify(jws, key, { algorithms: ['ES256'] });
    return payload;
  } catch {
    throw new ControlFormatError('reply signature');
  }
}

/**
 * parseReplyClaims applies the §4.1 closed member set; `code` is present
 * exactly when `ok` is false.
 */
function parseReplyClaims(payload: Uint8Array): ReplyClaims {
  const obj = strictObject(
    parseStrictJson(payload),
    ['v', 'dev', 'gen', 'ctl', 'rid', 'iat', 'ok'],
    ['code', 'res'],
    'reply claims'
  );
  if (uintMember(obj, 'v') !== 1) {
    throw new ControlFormatError('reply v');
  }
  const ok = boolMember(obj, 'ok');
  const hasCode = Object.prototype.hasOwnProperty.call(obj, 'code');
  if (hasCode === ok) {
    throw new ControlFormatError('reply code must be present exactly when ok is false');
  }
  const claims: ReplyClaims = {
    v: 1,
    dev: stringMember(obj, 'dev'),
    gen: stringMember(obj, 'gen'),
    ctl: stringMember(obj, 'ctl'),
    rid: stringMember(obj, 'rid'),
    iat: uintMember(obj, 'iat'),
    ok,
  };
  if (hasCode) {
    claims.code = stringMember(obj, 'code');
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'res')) {
    claims.res = toPlainJson(obj.res);
  }
  return claims;
}

/** ReplyBinding is what the controller sent and the reply must echo (§4.2). */
export interface ReplyBinding {
  dev: string;
  gen: string;
  ctl: string;
  rid: string;
}

/**
 * openReply is §4.1-4.2 in full: exact headers, decryption with the request's
 * rk, ES256 against the pinned devSig, strict claims, and the dev/gen/ctl/rid
 * binding. Any failure means "no valid reply"; a reply is never trusted
 * partially, so the caller gets either verified claims or an exception.
 *
 * @param compact - Reply compact JWE
 * @param rk - Reply key from the request
 * @param devSig - Pinned device signing key
 * @param bind - The request's dev/gen/ctl/rid
 * @returns Verified claims
 * @throws {ControlFormatError} On any failure
 */
export async function openReply(
  compact: string,
  rk: Uint8Array,
  devSig: PublicJwk,
  bind: ReplyBinding
): Promise<ReplyClaims> {
  splitJwe(compact, { alg: 'dir', enc: 'A256GCM', typ: TYP_RES_JWE, cty: TYP_RES_JWS });
  const jws = new TextDecoder().decode(await decryptDir(compact, rk));
  const claims = parseReplyClaims(await verifyReplyJws(jws, devSig));
  if (
    claims.dev !== bind.dev ||
    claims.gen !== bind.gen ||
    claims.ctl !== bind.ctl ||
    claims.rid !== bind.rid
  ) {
    throw new ControlFormatError('reply is not bound to this request');
  }
  return claims;
}

/**
 * openNotification is the controller side of §9: exact header with
 * kid = our controllerId, decryption under nk, the closed claim set, ctl equal
 * to kid, and dev/gen equal to the pins. Notifications are NOT signed; the
 * caller must only use them to inform UI and never act on one automatically.
 *
 * @param compact - Notification compact JWE
 * @param ctl - This controller's controllerId
 * @param nk - This controller's notification key
 * @param pins - The pinned dev/gen; omit only in conformance tests
 * @returns Claims
 * @throws {ControlFormatError} On any failure
 */
export async function openNotification(
  compact: string,
  ctl: string,
  nk: Uint8Array,
  pins?: { dev: string; gen: string }
): Promise<NotificationClaims> {
  splitJwe(compact, { alg: 'dir', enc: 'A256GCM', typ: TYP_NTF_JWE, kid: ctl });
  const obj = strictObject(
    parseStrictJson(await decryptDir(compact, nk)),
    ['v', 'dev', 'gen', 'ctl', 'ep', 'seq', 'iat', 'type', 'body'],
    [],
    'notification claims'
  );
  if (uintMember(obj, 'v') !== 1) {
    throw new ControlFormatError('notification v');
  }
  const claims: NotificationClaims = {
    v: 1,
    dev: stringMember(obj, 'dev'),
    gen: stringMember(obj, 'gen'),
    ctl: stringMember(obj, 'ctl'),
    ep: stringMember(obj, 'ep'),
    seq: uintMember(obj, 'seq'),
    iat: uintMember(obj, 'iat'),
    type: stringMember(obj, 'type'),
    body: toPlainJson(obj.body),
  };
  if (claims.ctl !== ctl) {
    throw new ControlFormatError('notification ctl does not match kid');
  }
  // §9: ep is b64u(8 random bytes), strict (no padding), as in the Go reference.
  if (!isB64uOfLength(claims.ep, 8)) {
    throw new ControlFormatError('notification ep must be b64u(8 bytes)');
  }
  if (pins && (claims.dev !== pins.dev || claims.gen !== pins.gen)) {
    throw new ControlFormatError('notification is for another device or generation');
  }
  return claims;
}

/**
 * NotificationOrder implements the §9 ordering rule: within one `ep` keep
 * only increasing `seq`; an `ep` never seen before starts a new daemon run and
 * is accepted. `iat` is not used for ordering because device clocks can step.
 */
export class NotificationOrder {
  private readonly highest = new Map<string, number>();

  /**
   * accept reports whether a notification is newer than everything seen in its
   * run, and records it when it is.
   *
   * @param n - Opened notification claims
   * @returns True when the notification should be shown
   */
  accept(n: Pick<NotificationClaims, 'ep' | 'seq'>): boolean {
    const seen = this.highest.get(n.ep);
    if (seen !== undefined && n.seq <= seen) {
      return false;
    }
    this.highest.set(n.ep, n.seq);
    return true;
  }
}

/** envelopeCastBody is the §10 LAN and legacy-relayer request body. */
export function envelopeCastBody(compact: string): {
  command: 'ff1Envelope';
  request: { v: 1; jwe: string };
} {
  return { command: 'ff1Envelope', request: { v: 1, jwe: compact } };
}
