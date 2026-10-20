/**
 * Test-only FF1 device side of the control protocol v1, written from the spec
 * (ffos-user docs/ff1-control-v1.md) with node:crypto only.
 *
 * It deliberately shares NO code with src/utilities/control (which uses jose
 * and its own strict parser), so a request sealed by the CLI and opened here,
 * and a Go fixture opened here, are two independent checks of the same bytes.
 * It implements only what the tests need: §3.4 steps 1-3 (public errors), the
 * claim checks of step 4 that a vector can trip, and sealing replies (§4.1)
 * and notifications (§9) so transport tests can answer like a device.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

export interface Jwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
}

const b64 = (b: Buffer | Uint8Array | string): string =>
  Buffer.from(b as Buffer).toString('base64url');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url');

/** thumb is RFC 7638 for P-256, computed independently of src/. */
export function thumb(jwk: Jwk): string {
  return b64(
    createHash('sha256').update(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`).digest()
  );
}

/** concatKdf is RFC 7518 §4.6.2 for ECDH-ES direct with A256GCM. */
export function concatKdf(z: Buffer): Buffer {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return createHash('sha256')
    .update(Buffer.concat([u32(1), z, u32(7), Buffer.from('A256GCM'), u32(0), u32(0), u32(256)]))
    .digest();
}

/** DevicePublicError is a §4.4 public error. */
export class DevicePublicError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function exactKeys(obj: Record<string, unknown>, keys: string[]): boolean {
  const got = Object.keys(obj).sort();
  return got.length === keys.length && [...keys].sort().every((k, i) => got[i] === k);
}

/** hasDuplicateTopLevelKeys detects a repeated member name anywhere in a flat header. */
function hasDuplicateTopLevelKeys(text: string): boolean {
  const keys = [...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => JSON.parse(`"${m[1]}"`));
  return new Set(keys).size !== keys.length;
}

function parseHeaderSeg(seg: string): Record<string, unknown> {
  const text = unb64(seg).toString('utf8');
  if (hasDuplicateTopLevelKeys(text)) {
    throw new DevicePublicError('bad_envelope');
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function gcmOpen(key: Buffer, ivB64: string, ctB64: string, tagB64: string, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, unb64(ivB64));
  d.setAAD(Buffer.from(aad, 'ascii'));
  d.setAuthTag(unb64(tagB64));
  return Buffer.concat([d.update(unb64(ctB64)), d.final()]);
}

function gcmSeal(key: Buffer, header: string, pt: Buffer): string {
  const hseg = b64(header);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(hseg, 'ascii'));
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return `${hseg}..${b64(iv)}.${b64(ct)}.${b64(c.getAuthTag())}`;
}

function esVerify(pub: Jwk, input: string, sig: Buffer): boolean {
  if (sig.length !== 64) {
    return false;
  }
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y },
    format: 'jwk',
  });
  return verify('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }, sig);
}

function esSign(priv: Jwk, input: string): string {
  const key = createPrivateKey({
    key: priv as unknown as import('node:crypto').JsonWebKey,
    format: 'jwk',
  });
  return b64(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }));
}

/** OpenedRequest is what §3.4 steps 1-3 yield. */
export interface OpenedRequest {
  kid: string;
  claims: Record<string, unknown>;
  payload: string;
}

/**
 * openRequest runs §3.4 steps 1-3 against devEnc, looking up the JWS kid in
 * `grants` (ctl -> public sig JWK) or, for enrollment ops, in enroll.sig.
 */
export function openRequest(
  compact: string,
  devEnc: Jwk,
  grants: Record<string, Jwk>
): OpenedRequest {
  if (compact.length > 4 * 1024 * 1024) {
    throw new DevicePublicError('bad_envelope');
  }
  const parts = compact.split('.');
  if (parts.length !== 5 || parts[1] !== '' || parts[0].length > 4096) {
    throw new DevicePublicError('bad_envelope');
  }
  let jwsText: string;
  try {
    const h = parseHeaderSeg(parts[0]);
    const epk = h.epk as Jwk;
    if (
      !exactKeys(h, ['alg', 'enc', 'kid', 'typ', 'cty', 'epk']) ||
      h.alg !== 'ECDH-ES' ||
      h.enc !== 'A256GCM' ||
      h.typ !== 'ff1-req+jwe' ||
      h.cty !== 'ff1-req+jws' ||
      h.kid !== thumb(devEnc) ||
      !exactKeys(epk as unknown as Record<string, unknown>, ['kty', 'crv', 'x', 'y'])
    ) {
      throw new Error('header');
    }
    const z = diffieHellman({
      privateKey: createPrivateKey({
        key: devEnc as unknown as import('node:crypto').JsonWebKey,
        format: 'jwk',
      }),
      publicKey: createPublicKey({ key: { ...epk }, format: 'jwk' }),
    });
    jwsText = gcmOpen(concatKdf(z), parts[2], parts[3], parts[4], parts[0]).toString('utf8');
  } catch (error) {
    if (error instanceof DevicePublicError) {
      throw error;
    }
    throw new DevicePublicError('bad_envelope');
  }
  return openInnerJws(jwsText, grants);
}

function openInnerJws(jwsText: string, grants: Record<string, Jwk>): OpenedRequest {
  const parts = jwsText.split('.');
  if (parts.length !== 3) {
    throw new DevicePublicError('bad_envelope');
  }
  let h: Record<string, unknown>;
  let payload: string;
  let claims: Record<string, unknown>;
  try {
    h = parseHeaderSeg(parts[0]);
    payload = unb64(parts[1]).toString('utf8');
    claims = JSON.parse(payload) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DevicePublicError) {
      throw error;
    }
    throw new DevicePublicError('bad_envelope');
  }
  if (
    !exactKeys(h, ['alg', 'kid', 'typ']) ||
    h.alg !== 'ES256' ||
    h.typ !== 'ff1-req+jws' ||
    typeof h.kid !== 'string'
  ) {
    throw new DevicePublicError('bad_envelope');
  }
  const kid = h.kid;
  let key = grants[kid];
  const enroll = claims.enroll as { sig?: Jwk } | undefined;
  if (!key && (claims.op === 'enroll' || claims.op === 'requestAccess') && enroll?.sig) {
    key = thumb(enroll.sig) === kid ? enroll.sig : undefined;
  }
  if (!key) {
    throw new DevicePublicError('unknown_controller');
  }
  if (!esVerify(key, `${parts[0]}.${parts[1]}`, unb64(parts[2]))) {
    throw new DevicePublicError('bad_signature');
  }
  return { kid, claims, payload };
}

/** sealReply builds a §4.1 reply the way the device does. */
export function sealReply(devSig: Jwk, rk: string, claims: Record<string, unknown>): string {
  const header = `{"alg":"ES256","kid":"${thumb(devSig)}","typ":"ff1-res+jws"}`;
  const input = `${b64(header)}.${b64(JSON.stringify(claims))}`;
  const jws = `${input}.${esSign(devSig, input)}`;
  return gcmSeal(
    unb64(rk),
    '{"alg":"dir","enc":"A256GCM","typ":"ff1-res+jwe","cty":"ff1-res+jws"}',
    Buffer.from(jws)
  );
}

/** sealNotification builds a §9 sealed notification. */
export function sealNotification(nk: string, claims: Record<string, unknown>): string {
  return gcmSeal(
    unb64(nk),
    `{"alg":"dir","enc":"A256GCM","typ":"ff1-ntf+jwe","kid":"${String(claims.ctl)}"}`,
    Buffer.from(JSON.stringify(claims))
  );
}

/** FakeAnswer is what a FakeFF1 handler decides for one opened request. */
export type FakeAnswer =
  | { ok: true; res?: unknown }
  | { ok: false; code: string; res?: unknown }
  | { publicCode: string; status?: number };

/**
 * FakeFF1 answers `ff1Envelope` casts like the device: it opens the request
 * with the fixture device keys, enforces one use per ctr, records what it saw
 * and replies with a reply sealed under the request's rk.
 */
export class FakeFF1 {
  readonly seen: Array<Record<string, unknown>> = [];
  private readonly used = new Set<string>();

  constructor(
    private readonly keys: { dev: string; gen: string; sig: Jwk; enc: Jwk },
    private readonly grants: Record<string, Jwk>,
    private readonly decide: (claims: Record<string, unknown>) => FakeAnswer = () => ({
      ok: true,
      res: { ok: true },
    })
  ) {}

  /** handle returns the HTTP status and JSON body for a LAN cast body. */
  handle(body: { command?: string; request?: { v?: number; jwe?: string } }): {
    status: number;
    json: unknown;
  } {
    if (body.command !== 'ff1Envelope' || body.request?.v !== 1 || !body.request.jwe) {
      return { status: 403, json: { error: { code: 'enrollment_required' } } };
    }
    let opened: OpenedRequest;
    try {
      opened = openRequest(body.request.jwe, this.keys.enc, this.grants);
    } catch (error) {
      const code = error instanceof DevicePublicError ? error.code : 'bad_envelope';
      return { status: 401, json: { error: { code } } };
    }
    const claims = opened.claims;
    this.seen.push(claims);
    const replayKey = `${opened.kid}:${String(claims.ctr)}`;
    const answer: FakeAnswer = this.used.has(replayKey)
      ? { ok: false, code: 'replay' }
      : this.decide(claims);
    this.used.add(replayKey);
    if ('publicCode' in answer) {
      return { status: answer.status ?? 401, json: { error: { code: answer.publicCode } } };
    }
    const reply: Record<string, unknown> = {
      v: 1,
      dev: this.keys.dev,
      gen: this.keys.gen,
      ctl: opened.kid,
      rid: claims.rid,
      iat: claims.iat,
      ok: answer.ok,
    };
    if (!answer.ok) {
      reply.code = answer.code;
    }
    if (answer.res !== undefined) {
      reply.res = answer.res;
    }
    return { status: 200, json: { v: 1, jwe: sealReply(this.keys.sig, String(claims.rk), reply) } };
  }
}
