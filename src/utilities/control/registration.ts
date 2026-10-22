/**
 * Owner-initiated registration (ffos-user docs/ff1-control-v1.md §5.6), the
 * controller side: the `ff1-ctl:1|…` controller QR ff-cli shows, and the
 * sealed registration result an owner's app sends back over the pairing
 * channel.
 *
 * The result is the pin source for the device profile (§14.1), so it is
 * checked exactly like the Go reference (control/registration.go
 * OpenRegistration) and nothing in it is trusted before every check passed:
 * closed member sets, the channel and pairing secret from our own QR, `ctl`
 * equal to our own key, and the configured device. A message that fails any
 * check is not an answer; the caller keeps waiting for a genuine one.
 *
 * Cryptography is node:crypto (P-256 ECDH, HKDF-SHA256, AES-256-GCM). The
 * fixtures in tests/fixtures/ff1-control-v1 pin every byte of it.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  CONTROL_PLATFORMS,
  type ControlPlatform,
  type ControlRole,
  type ControllerKeys,
  type DeviceProfile,
  parseProfile,
} from './codec';
import {
  type PrivateJwk,
  type PublicJwk,
  generatePrivateJwk,
  parsePublicJwk,
  publicOf,
  thumbprint,
} from './jwk';
import {
  ControlFormatError,
  b64uDecode,
  b64uEncode,
  isPlainObject,
  parseStrictJson,
  stringMember,
  strictObject,
  uintMember,
} from './strict-json';

/** CONTROLLER_QR_PREFIX starts every controller QR payload (§5.6.1). */
export const CONTROLLER_QR_PREFIX = 'ff1-ctl:1|';
/** REGISTRATION_TYPE is the plaintext result's type. */
export const REGISTRATION_TYPE = 'ff1_controller_registration';
/** REGISTRATION_SEALED_TYPE is the wire message's type. */
export const REGISTRATION_SEALED_TYPE = 'ff1_controller_registration_sealed';

const REGISTRATION_LABEL = 'ff1-controller-registration/v1';
const PS_LEN = 16;
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;
const SEC1_POINT_LEN = 65;
const COORD_LEN = 32;
// The label is the last of the nine fields after the prefix and may itself
// contain "|", so the payload is split at most nine times.
const CONTROLLER_QR_FIELDS = 9;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_LABEL_CHARS = 64;
/**
 * PROTOCOL_UNSAFE_LABEL is exactly the device's label rule (Go
 * control/store.go unsafeLabelCharacters). It judges labels and device names
 * this module READS, so a genuine result is never refused over a character
 * the device accepts; labels ff-cli sends use the stricter codec.labelProblem.
 */
const PROTOCOL_UNSAFE_LABEL =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u2028\u2029\ufeff]/u;

/** ControllerQr is a parsed `ff1-ctl:1|…` payload (§5.6.1). */
export interface ControllerQr {
  channelId: string;
  /** b64u of the 65-byte uncompressed SEC 1 minter public key. */
  minterKey: string;
  sig: PublicJwk;
  enc: PublicJwk;
  /** b64u of the 16-byte pairing secret. */
  ps: string;
  platform: ControlPlatform;
  label: string;
}

/** PairingMaterial is a QR to show plus the minter private key that opens its result. */
export interface PairingMaterial {
  qr: ControllerQr;
  minter: PrivateJwk;
}

/** RegistrationResult is the verified §5.6.2 plaintext. */
export interface RegistrationResult {
  v: 1;
  type: typeof REGISTRATION_TYPE;
  channelId: string;
  ps: string;
  ctl: string;
  outcome: 'approved' | 'rejected';
  /** Present exactly when outcome is "approved", as are deviceName and role. */
  profile?: DeviceProfile;
  deviceName?: string;
  role?: ControlRole;
  expiresAt?: number;
  topicId?: string;
}

/**
 * isProtocolLabel is the §5 label rule as the device applies it: 1-64
 * characters, none of the control or invisible formatting characters.
 *
 * @param value - Candidate label or device name
 * @returns True when the device would accept it
 */
function isProtocolLabel(value: string): boolean {
  const length = [...value].length;
  return length >= 1 && length <= MAX_LABEL_CHARS && !PROTOCOL_UNSAFE_LABEL.test(value);
}

/** sec1Of renders a public JWK as b64u(0x04 || X || Y). */
function sec1Of(key: PublicJwk): string {
  return b64uEncode(
    Buffer.concat([
      Buffer.from([4]),
      Buffer.from(b64uDecode(key.x)),
      Buffer.from(b64uDecode(key.y)),
    ])
  );
}

/**
 * parseSec1Point validates b64u of an uncompressed P-256 point; compressed
 * and off-curve points are refused (parsePublicJwk runs the on-curve check).
 */
function parseSec1Point(value: string, what: string): PublicJwk {
  let bytes: Uint8Array;
  try {
    bytes = b64uDecode(value);
  } catch {
    bytes = new Uint8Array();
  }
  if (bytes.length !== SEC1_POINT_LEN || bytes[0] !== 4) {
    throw new ControlFormatError(`${what} must be b64u of a 65-byte uncompressed P-256 point`);
  }
  return parsePublicJwk(
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64uEncode(bytes.subarray(1, 1 + COORD_LEN)),
      y: b64uEncode(bytes.subarray(1 + COORD_LEN)),
    },
    what
  );
}

/**
 * generatePairingMaterial draws what one pairing attempt shows: a fresh
 * minter key, a 16-byte pairing secret and a random channel ID, bound to the
 * controller keys and label the owner will register.
 *
 * @param keys - Controller keys to register
 * @param label - Label the owner sees (already validated)
 * @returns The QR fields and the minter private key
 */
export function generatePairingMaterial(keys: ControllerKeys, label: string): PairingMaterial {
  const minter = generatePrivateJwk();
  return {
    minter,
    qr: {
      channelId: randomUUID(),
      minterKey: sec1Of(minter),
      sig: publicOf(keys.sig),
      enc: publicOf(keys.enc),
      ps: b64uEncode(randomBytes(PS_LEN)),
      platform: 'cli',
      label,
    },
  };
}

/**
 * controllerQrString renders the QR payload.
 *
 * @param qr - QR fields
 * @returns `ff1-ctl:1|channelId|minterKey|sig.x|sig.y|enc.x|enc.y|ps|platform|label`
 */
export function controllerQrString(qr: ControllerQr): string {
  return (
    CONTROLLER_QR_PREFIX +
    [
      qr.channelId,
      qr.minterKey,
      qr.sig.x,
      qr.sig.y,
      qr.enc.x,
      qr.enc.y,
      qr.ps,
      qr.platform,
      qr.label,
    ].join('|')
  );
}

/**
 * controllerQrCtl is the controller ID the QR's sig key has once registered.
 *
 * @param qr - QR fields
 * @returns thumb(sig)
 */
export function controllerQrCtl(qr: ControllerQr): string {
  return thumbprint(qr.sig);
}

/**
 * parseControllerQr parses and validates a controller QR payload (§5.6.1).
 *
 * @param value - QR text
 * @returns The QR fields
 * @throws {ControlFormatError} On anything but a valid payload
 */
export function parseControllerQr(value: string): ControllerQr {
  if (!value.startsWith(CONTROLLER_QR_PREFIX)) {
    throw new ControlFormatError('not an ff1-ctl:1 payload');
  }
  const fields: string[] = [];
  let rest = value.slice(CONTROLLER_QR_PREFIX.length);
  while (fields.length < CONTROLLER_QR_FIELDS - 1) {
    const cut = rest.indexOf('|');
    if (cut < 0) {
      throw new ControlFormatError('controller QR has too few fields');
    }
    fields.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1);
  }
  fields.push(rest);
  const [channelId, minterKey, sigX, sigY, encX, encY, ps, platform, label] = fields;
  if (!CHANNEL_ID_PATTERN.test(channelId)) {
    throw new ControlFormatError('controller QR channelId is invalid');
  }
  parseSec1Point(minterKey, 'controller QR minterKey');
  const sig = parsePublicJwk({ kty: 'EC', crv: 'P-256', x: sigX, y: sigY }, 'controller QR sig');
  const enc = parsePublicJwk({ kty: 'EC', crv: 'P-256', x: encX, y: encY }, 'controller QR enc');
  let psBytes: Uint8Array;
  try {
    psBytes = b64uDecode(ps);
  } catch {
    psBytes = new Uint8Array();
  }
  if (psBytes.length !== PS_LEN) {
    throw new ControlFormatError('controller QR ps must be b64u of 16 bytes');
  }
  if (!(CONTROL_PLATFORMS as readonly string[]).includes(platform)) {
    throw new ControlFormatError('controller QR platform is invalid');
  }
  if (!isProtocolLabel(label)) {
    throw new ControlFormatError('controller QR label is invalid');
  }
  return {
    channelId,
    minterKey,
    sig,
    enc,
    ps,
    platform: platform as ControlPlatform,
    label,
  };
}

/** registrationKey derives the AES-256-GCM key and AAD of §5.6.2. */
function registrationKey(
  own: PrivateJwk,
  peer: PublicJwk,
  channelId: string,
  minterKey: string,
  epk: string
): { key: Buffer; aad: Buffer } {
  const z = diffieHellman({
    privateKey: createPrivateKey({ key: { ...own }, format: 'jwk' }),
    publicKey: createPublicKey({ key: { ...publicOf(peer) }, format: 'jwk' }),
  });
  const salt = createHash('sha256')
    .update(CONTROLLER_QR_PREFIX + channelId, 'utf8')
    .digest();
  const key = Buffer.from(hkdfSync('sha256', z, salt, REGISTRATION_LABEL, 32));
  const aad = Buffer.from(`${REGISTRATION_LABEL}|${channelId}|${minterKey}|${epk}`, 'utf8');
  return { key, aad };
}

/**
 * sealRegistration is the owner side of §5.6.2, used by tests and as the
 * reference for the app: encrypt an exact plaintext to the QR's minter key
 * under the ephemeral key with iv (12 bytes, never reused for one epk).
 *
 * @param qr - The controller QR
 * @param plaintext - Exact result JSON
 * @param ephemeral - Owner's fresh P-256 key
 * @param iv - 12-byte nonce
 * @returns The wire message JSON
 */
export function sealRegistration(
  qr: ControllerQr,
  plaintext: string | Uint8Array,
  ephemeral: PrivateJwk = generatePrivateJwk(),
  iv: Uint8Array = randomBytes(GCM_IV_LEN)
): string {
  if (iv.length !== GCM_IV_LEN) {
    throw new Error('registration iv must be 12 bytes');
  }
  const minter = parseSec1Point(qr.minterKey, 'minterKey');
  const epk = sec1Of(ephemeral);
  const { key, aad } = registrationKey(ephemeral, minter, qr.channelId, qr.minterKey, epk);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `{"v":1,"type":${JSON.stringify(REGISTRATION_SEALED_TYPE)},"epk":${JSON.stringify(epk)},"iv":${JSON.stringify(b64uEncode(iv))},"ct":${JSON.stringify(b64uEncode(ct))}}`;
}

/**
 * openRegistration is the controller side of §5.6.3: decrypt a sealed result
 * with the minter key behind qr and check every binding, in the spec's order.
 *
 * @param material - The QR this controller showed and its minter key
 * @param wire - The wire message (relay frame payload)
 * @param wantDev - The configured device ID; profile.dev must equal it
 * @param now - Unix seconds, bounding expiresAt
 * @returns The verified result
 * @throws {ControlFormatError} When the message is not a genuine result for this QR
 */
export function openRegistration(
  material: PairingMaterial,
  wire: string | Uint8Array,
  wantDev: string,
  now: number
): RegistrationResult {
  const { qr, minter } = material;
  if (sec1Of(minter) !== qr.minterKey) {
    throw new ControlFormatError('minter key does not match the QR');
  }
  const sealed = strictObject(
    parseStrictJson(wire),
    ['v', 'type', 'epk', 'iv', 'ct'],
    [],
    'sealed registration'
  );
  if (uintMember(sealed, 'v') !== 1 || sealed.type !== REGISTRATION_SEALED_TYPE) {
    throw new ControlFormatError('sealed registration has the wrong v or type');
  }
  const epkB64 = stringMember(sealed, 'epk');
  const epk = parseSec1Point(epkB64, 'sealed registration epk');
  const iv = b64uDecode(stringMember(sealed, 'iv'));
  if (iv.length !== GCM_IV_LEN) {
    throw new ControlFormatError('sealed registration iv must be 12 bytes');
  }
  const ct = b64uDecode(stringMember(sealed, 'ct'));
  if (ct.length < GCM_TAG_LEN) {
    throw new ControlFormatError('sealed registration does not decrypt');
  }
  const { key, aad } = registrationKey(minter, epk, qr.channelId, qr.minterKey, epkB64);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(ct.subarray(ct.length - GCM_TAG_LEN));
    plaintext = Buffer.concat([
      decipher.update(ct.subarray(0, ct.length - GCM_TAG_LEN)),
      decipher.final(),
    ]);
  } catch {
    throw new ControlFormatError('sealed registration does not decrypt');
  }
  return parseRegistrationResult(qr, plaintext, wantDev, now);
}

/** parseRegistrationResult checks the decrypted plaintext (§5.6.2, §5.6.3 steps 2-4). */
function parseRegistrationResult(
  qr: ControllerQr,
  plaintext: Uint8Array,
  wantDev: string,
  now: number
): RegistrationResult {
  const base = ['v', 'type', 'channelId', 'ps', 'ctl', 'outcome'];
  const obj = strictObject(
    parseStrictJson(plaintext),
    base,
    ['profile', 'deviceName', 'role', 'expiresAt', 'topicId'],
    'registration result'
  );
  if (uintMember(obj, 'v') !== 1 || obj.type !== REGISTRATION_TYPE) {
    throw new ControlFormatError('registration result has the wrong v or type');
  }
  if (obj.channelId !== qr.channelId) {
    throw new ControlFormatError('registration result is for another channel');
  }
  const ps = stringMember(obj, 'ps');
  const psBytes = Buffer.from(ps, 'utf8');
  const wantPs = Buffer.from(qr.ps, 'utf8');
  if (psBytes.length !== wantPs.length || !timingSafeEqual(psBytes, wantPs)) {
    throw new ControlFormatError('registration result ps does not match');
  }
  const ctl = controllerQrCtl(qr);
  if (obj.ctl !== ctl) {
    throw new ControlFormatError('registration result is for another controller');
  }
  const outcome = stringMember(obj, 'outcome');
  const result: RegistrationResult = {
    v: 1,
    type: REGISTRATION_TYPE,
    channelId: qr.channelId,
    ps,
    ctl,
    outcome: 'rejected',
  };
  if (outcome === 'rejected') {
    if (Object.keys(obj).length !== base.length) {
      throw new ControlFormatError('a rejected registration carries no grant members');
    }
    return result;
  }
  if (outcome !== 'approved') {
    throw new ControlFormatError('registration result outcome is invalid');
  }
  for (const member of ['profile', 'deviceName', 'role']) {
    if (!Object.prototype.hasOwnProperty.call(obj, member)) {
      throw new ControlFormatError(`an approved registration needs ${member}`);
    }
  }
  if (!isPlainObject(obj.profile) || uintMember(obj.profile, 'v') !== 1) {
    throw new ControlFormatError('registration result profile is invalid');
  }
  const profile = parseProfile(obj.profile);
  if (profile.dev !== wantDev) {
    throw new ControlFormatError('registration result is for another device');
  }
  const deviceName = stringMember(obj, 'deviceName');
  if (!isProtocolLabel(deviceName)) {
    throw new ControlFormatError('registration result deviceName is invalid');
  }
  const role = stringMember(obj, 'role');
  if (role !== 'owner' && role !== 'controller') {
    throw new ControlFormatError('registration result role is invalid');
  }
  Object.assign(result, { outcome, profile, deviceName, role });
  if (Object.prototype.hasOwnProperty.call(obj, 'expiresAt')) {
    const expiresAt = uintMember(obj, 'expiresAt');
    // An owner grant never expires (§5.5), and an expiry in the past is no grant.
    if (expiresAt <= now || role === 'owner') {
      throw new ControlFormatError('registration result expiresAt is invalid');
    }
    result.expiresAt = expiresAt;
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'topicId')) {
    const topicId = obj.topicId;
    if (typeof topicId !== 'string' || topicId === '') {
      throw new ControlFormatError('registration result topicId must be a non-empty string');
    }
    result.topicId = topicId;
  }
  return result;
}
