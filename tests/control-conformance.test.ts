/**
 * FF1 control protocol v1 conformance (ffos-user docs/ff1-control-v1.md §12):
 * every vector in tests/fixtures/ff1-control-v1 (vendored from the Go
 * reference; see SOURCE.md there) against the CLI codec, plus round-trips of
 * the CLI's own requests through an independent node:crypto device opener.
 * The controllerQR and registration vectors (§5.6) run in
 * tests/control-registration.test.ts.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { compactDecrypt, compactVerify, importJWK } from 'jose';
import {
  NotificationOrder,
  approvalCode,
  encodeRequestClaims,
  openNotification,
  openReply,
  parseProfile,
  sealRequest,
  type ControllerKeys,
  type DeviceProfile,
  type RequestClaims,
} from '../src/utilities/control/codec';
import { parsePrivateJwk, thumbprint } from '../src/utilities/control/jwk';
import { b64uDecode, parseStrictJson, uintMember } from '../src/utilities/control/strict-json';
import {
  DevicePublicError,
  concatKdf,
  openRequest,
  sealReply,
  thumb,
  type Jwk,
} from './helpers/control-device';

const FIXTURES = path.join(__dirname, 'fixtures', 'ff1-control-v1');

interface Fixture {
  name: string;
  kind: string;
  [key: string]: unknown;
}

const keys = JSON.parse(readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8'));
const device = keys.device;
const profile: DeviceProfile = parseProfile(device.profile);
const controllers: Record<string, { ctl: string; sig: Jwk; enc: Jwk; nk?: string }> =
  keys.controllers;

function load(dir: string): Fixture[] {
  return readdirSync(path.join(FIXTURES, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(FIXTURES, dir, f), 'utf8')) as Fixture);
}

const positive = load('positive');
const negative = load('negative');

/** FixtureSetup is the device state a request vector runs against (§12). */
interface FixtureSetup {
  grants: string[];
  /** Display grants (§5.7); the device admits their keys like grant keys. */
  displayGrants?: Array<{ name: string; expiresAt?: number }>;
}

function grantKeys(setup: FixtureSetup): Record<string, Jwk> {
  const out: Record<string, Jwk> = {};
  const names = [...setup.grants, ...(setup.displayGrants ?? []).map((g) => g.name)];
  for (const name of names) {
    const c = controllers[name];
    out[c.ctl] = { kty: 'EC', crv: 'P-256', x: c.sig.x, y: c.sig.y };
  }
  return out;
}

function controllerKeys(name: string): ControllerKeys {
  const c = controllers[name];
  return { sig: parsePrivateJwk(c.sig), enc: parsePrivateJwk(c.enc) };
}

function bindFor(f: Fixture) {
  const claims = f.claims as { rid: string };
  return {
    dev: device.dev,
    gen: device.gen,
    ctl: controllers[f.from as string].ctl,
    rid: claims.rid,
  };
}

describe('ff1-control-v1 fixture inventory', () => {
  test('every fixture kind is handled', () => {
    const kinds = new Set([...positive, ...negative].map((f) => f.kind));
    for (const kind of kinds) {
      assert.ok(
        [
          'request',
          'notification',
          'reply',
          'approvalCode',
          'controllerQR',
          'registration',
        ].includes(kind),
        kind
      );
    }
    // 85 files at ffos-user feat/3551-display-grants: keys.json + 20 positive
    // + 64 negative (SOURCE.md).
    assert.equal(positive.length, 20);
    assert.equal(negative.length, 64);
  });

  test('the reordered-ctr vector is accepted (ctr inside the window, unseen)', async () => {
    const f = positive.find((v) => v.name === 'cmd-owner-reordered-ctr')!;
    const reply = f.reply as { compact: string };
    const claims = await openReply(
      reply.compact,
      b64uDecode(f.rk as string),
      profile.sig,
      bindFor(f)
    );
    assert.equal(claims.ok, true);
    assert.equal(claims.code, undefined);
    assert.equal((f.expect as { replyOk?: boolean }).replyOk, true);
  });

  test('the strict-ep notification negatives are present', () => {
    const names = negative.filter((v) => v.kind === 'notification').map((v) => v.name);
    for (const name of ['notification-bad-ep', 'notification-padded-ep']) {
      assert.ok(names.includes(name), name);
    }
  });

  test('pins are the RFC 7638 thumbprints of the profile keys', () => {
    assert.equal(thumbprint(profile.sig), device.pins.sig);
    assert.equal(thumbprint(profile.enc), device.pins.enc);
    for (const c of Object.values(controllers)) {
      assert.equal(thumbprint(parsePrivateJwk(c.sig)), c.ctl);
      assert.equal(thumb(c.sig), c.ctl);
    }
  });

  test('Concat KDF known answer for the all-zero Z (§3.1)', () => {
    assert.equal(
      concatKdf(Buffer.alloc(32)).toString('base64url'),
      'ohtGU230iroWUJBOQYR7JT-iHsoYc-MLxzoRXrqr6Yw'
    );
  });
});

describe('approvalCode (§5.4)', () => {
  const vector = positive.find((f) => f.kind === 'approvalCode');
  test('vector is present', () => assert.ok(vector));
  for (const c of (vector?.cases ?? []) as Array<{ ctl: string; sigPin: string; code: string }>) {
    test(`${c.ctl.slice(0, 8)}… with pin ${c.sigPin.slice(0, 8)}…`, () => {
      assert.equal(approvalCode(c.ctl, c.sigPin), c.code);
    });
  }
});

describe('positive request vectors', () => {
  for (const f of positive.filter((v) => v.kind === 'request')) {
    describe(f.name, () => {
      const grants = grantKeys(f.setup as FixtureSetup);

      test('the independent device opener opens the Go request and its claims match', () => {
        const opened = openRequest(f.compact as string, device.enc, grants);
        assert.equal(opened.payload, f.payload);
        assert.deepEqual(opened.claims, f.claims);
        assert.equal(opened.kid, controllers[f.from as string].ctl);
      });

      test('jose opens the Go request independently', async () => {
        const encKey = await importJWK(device.enc, 'ECDH-ES');
        const { plaintext } = await compactDecrypt(f.compact as string, encKey);
        assert.equal(new TextDecoder().decode(plaintext), f.jws);
        const sigKey = await importJWK(
          { ...controllers[f.from as string].sig, d: undefined },
          'ES256'
        );
        const { payload } = await compactVerify(f.jws as string, sigKey);
        assert.equal(new TextDecoder().decode(payload), f.payload);
      });

      test('the CLI encodes the same claims byte for byte', () => {
        assert.equal(encodeRequestClaims(f.claims as RequestClaims), f.payload);
      });

      test('the CLI opens and verifies the device reply against the pinned devSig', async () => {
        const reply = f.reply as { compact: string; claims: unknown };
        const claims = await openReply(
          reply.compact,
          b64uDecode(f.rk as string),
          profile.sig,
          bindFor(f)
        );
        assert.deepEqual(claims, reply.claims);
        const expect = f.expect as { replyOk?: boolean; replyCode?: string };
        assert.equal(claims.ok, expect.replyOk === true);
        assert.equal(claims.code, expect.replyCode);
      });

      test('the CLI opens every notification the device emitted', async () => {
        const notes = (f.notifications ?? []) as Array<{
          to: string;
          compact: string;
          claims: unknown;
        }>;
        for (const n of notes) {
          const to = controllers[n.to];
          const claims = await openNotification(n.compact, to.ctl, b64uDecode(to.nk!), {
            dev: device.dev,
            gen: device.gen,
          });
          assert.deepEqual(claims, n.claims);
        }
      });

      // ff-cli no longer sends requestAccess (§5.2 is a LAN-only fallback it
      // does not offer), so its builder refuses that op; the vector's bytes
      // are still checked above.
      const sends = (f.claims as RequestClaims).op !== ('requestAccess' as string);
      test(
        'a request the CLI seals with the same claims opens on the device side',
        { skip: !sends },
        async () => {
          const c = f.claims as RequestClaims;
          const sealed = await sealRequest({
            profile,
            keys: controllerKeys(f.from as string),
            ctr: c.ctr,
            op: c.op,
            cmd: c.cmd,
            req: c.req,
            enroll: c.enroll,
            now: c.iat,
            lifetimeSeconds: c.exp - c.iat,
            rid: c.rid,
            rk: b64uDecode(c.rk),
          });
          const opened = openRequest(sealed.compact, device.enc, grants);
          assert.equal(opened.payload, f.payload);
          assert.deepEqual(opened.claims, f.claims);
        }
      );

      test('with the vector epk and IV the CLI reproduces the Go ciphertext', async () => {
        // jose emits epk members as x,crv,kty,y and Go as crv,kty,x,y, so the
        // header (and with it the GCM tag) differs; the KDF output, IV and
        // therefore the ciphertext over the same JWS must not.
        const { encryptRequest } = await import('../src/utilities/control/codec.js');
        const ours = await encryptRequest(profile.enc, f.jws as string, {
          ephemeralKey: parsePrivateJwk(f.ephemeralKey),
          iv: b64uDecode(f.iv as string),
        });
        const theirs = (f.compact as string).split('.');
        const mine = ours.split('.');
        assert.equal(mine[2], theirs[2]);
        assert.equal(mine[3], theirs[3]);
        const header = JSON.parse(Buffer.from(mine[0], 'base64url').toString('utf8'));
        assert.deepEqual(Object.keys(header).sort(), ['alg', 'cty', 'enc', 'epk', 'kid', 'typ']);
        assert.deepEqual(Object.keys(header.epk).sort(), ['crv', 'kty', 'x', 'y']);
        assert.equal(header.epk.x, (f.ephemeralKey as Jwk).x);
      });
    });
  }
});

describe('positive notification vectors', () => {
  for (const f of positive.filter((v) => v.kind === 'notification')) {
    test(f.name, async () => {
      const to = controllers[f.to as string];
      const claims = await openNotification(
        f.compact as string,
        to.ctl,
        b64uDecode(f.nk as string),
        {
          dev: device.dev,
          gen: device.gen,
        }
      );
      const expected = (f.notifications as Array<{ claims: unknown }>)[0].claims;
      assert.deepEqual(claims, expected);
    });
  }
});

describe('negative reply and notification vectors (client MUST reject)', () => {
  for (const f of negative.filter((v) => v.kind === 'reply')) {
    test(f.name, async () => {
      await assert.rejects(
        openReply(
          f.compact as string,
          b64uDecode(f.rk as string),
          profile.sig,
          f.bind as { dev: string; gen: string; ctl: string; rid: string }
        )
      );
    });
  }
  for (const f of negative.filter((v) => v.kind === 'notification')) {
    test(f.name, async () => {
      const to = controllers[f.to as string];
      await assert.rejects(
        openNotification(f.compact as string, to.ctl, b64uDecode(f.nk as string), {
          dev: device.dev,
          gen: device.gen,
        })
      );
    });
  }
});

describe('negative request vectors', () => {
  for (const f of negative.filter((v) => v.kind === 'request')) {
    const expect = f.expect as { public?: string; replyCode?: string };
    const setup = f.setup as FixtureSetup;
    if (expect.public) {
      test(`${f.name}: the device side answers public ${expect.public}`, () => {
        const repeat = f.compactRepeat as { char: string; count: number } | undefined;
        const compact = repeat ? repeat.char.repeat(repeat.count) : (f.compact as string);
        assert.throws(
          () => openRequest(compact, device.enc, grantKeys(setup)),
          (error: unknown) => error instanceof DevicePublicError && error.code === expect.public
        );
      });
    } else {
      test(`${f.name}: the CLI opens the encrypted ${expect.replyCode} reply`, async () => {
        const reply = f.reply as { compact: string; claims: unknown };
        const claims = await openReply(
          reply.compact,
          b64uDecode(f.rk as string),
          profile.sig,
          bindFor(f)
        );
        assert.equal(claims.ok, false);
        assert.equal(claims.code, expect.replyCode);
        assert.deepEqual(claims, reply.claims);
      });
    }
  }
});

describe('strict parsing (§1)', () => {
  test('duplicate members are rejected, also after unescaping', () => {
    assert.throws(() => parseStrictJson('{"typ":1,"typ":2}'));
    assert.throws(() => parseStrictJson('{"typ":1,"\\u0074yp":2}'));
    assert.throws(() => parseStrictJson('{"a":{"b":1,"b":1}}'));
  });

  test('non-canonical integers are rejected', () => {
    for (const bad of ['1.0', '1e3', '-1', '01', '"1"', '9007199254740992']) {
      // `01` is not even JSON; the rest parse but are not canonical integers.
      assert.throws(
        () => uintMember(parseStrictJson(`{"n":${bad}}`) as Record<string, unknown>, 'n'),
        bad
      );
    }
    assert.equal(uintMember(parseStrictJson('{"n":42}') as Record<string, unknown>, 'n'), 42);
  });

  test('padded, whitespace and non-canonical base64url are rejected', () => {
    assert.throws(() => b64uDecode('QQ=='));
    assert.throws(() => b64uDecode('Q Q'));
    assert.throws(() => b64uDecode('QR'));
    assert.deepEqual([...b64uDecode('QQ')], [0x41]);
  });

  test('invalid UTF-8 is rejected', () => {
    assert.throws(() =>
      parseStrictJson(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))
    );
  });

  test('a public JWK with a private member is rejected', () => {
    assert.throws(() => parseProfile({ ...device.profile, sig: device.sig }));
  });
});

describe('notification ordering (§9 ep, seq)', () => {
  test('keeps the highest seq per ep and accepts a new ep', () => {
    const order = new NotificationOrder();
    assert.equal(order.accept({ ep: 'AAAAAAAAAAA', seq: 1 }), true);
    assert.equal(order.accept({ ep: 'AAAAAAAAAAA', seq: 3 }), true);
    assert.equal(order.accept({ ep: 'AAAAAAAAAAA', seq: 2 }), false);
    assert.equal(order.accept({ ep: 'AAAAAAAAAAA', seq: 3 }), false);
    assert.equal(order.accept({ ep: 'BBBBBBBBBBB', seq: 1 }), true);
  });
});

describe('reply payload segment is decoded strictly (§1)', () => {
  const rk = Buffer.alloc(32, 7).toString('base64url');
  const bind = { dev: device.dev, gen: device.gen, ctl: controllers.owner.ctl, rid: 'rid-strict' };
  const claims = { v: 1, ...bind, iat: 1, ok: true, res: { ok: true } };

  /** withTrailingBits flips the unused low bits of the last base64url character. */
  function withTrailingBits(segment: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const unused = segment.length % 4 === 2 ? 4 : segment.length % 4 === 3 ? 2 : 0;
    assert.ok(unused > 0, 'segment must end in a partial group');
    const last = alphabet.indexOf(segment.at(-1)!);
    return segment.slice(0, -1) + alphabet[last | ((1 << unused) - 1)];
  }

  test('a correctly signed reply opens (control)', async () => {
    const compact = sealReply(device.sig, rk, claims);
    assert.equal((await openReply(compact, b64uDecode(rk), profile.sig, bind)).ok, true);
  });

  test('rejects non-canonical trailing bits in the payload segment', async () => {
    // Pad claims until the encoded payload ends in a partial base64 group.
    let padded = { ...claims, res: { ok: true, pad: '' } };
    while (Buffer.byteLength(JSON.stringify(padded)) % 3 === 0) {
      padded = { ...padded, res: { ok: true, pad: `${padded.res.pad}x` } };
    }
    const compact = sealReply(device.sig, rk, padded, withTrailingBits);
    await assert.rejects(
      openReply(compact, b64uDecode(rk), profile.sig, bind),
      /non-canonical base64url/
    );
  });

  test('rejects padding in the payload segment', async () => {
    let padded = { ...claims, res: { ok: true, pad: '' } };
    while (Buffer.byteLength(JSON.stringify(padded)) % 3 === 0) {
      padded = { ...padded, res: { ok: true, pad: `${padded.res.pad}x` } };
    }
    const compact = sealReply(device.sig, rk, padded, (seg) =>
      seg.padEnd(Math.ceil(seg.length / 4) * 4, '=')
    );
    await assert.rejects(openReply(compact, b64uDecode(rk), profile.sig, bind), /base64url/);
  });
});
