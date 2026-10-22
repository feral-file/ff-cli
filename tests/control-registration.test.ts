/**
 * Owner-initiated registration conformance (ffos-user docs/ff1-control-v1.md
 * §5.6, §12): every controllerQR and registration vector in
 * tests/fixtures/ff1-control-v1 against src/utilities/control/registration.ts.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { parsePrivateJwk, parsePublicJwk } from '../src/utilities/control/jwk';
import {
  type PairingMaterial,
  controllerQrCtl,
  controllerQrString,
  generatePairingMaterial,
  openRegistration,
  parseControllerQr,
  sealRegistration,
} from '../src/utilities/control/registration';
import { b64uDecode, toPlainJson } from '../src/utilities/control/strict-json';

const FIXTURES = path.join(__dirname, 'fixtures', 'ff1-control-v1');

interface QrCase {
  description: string;
  qr: string;
  channelId?: string;
  minterKey?: string;
  ctl?: string;
  sig?: string;
  enc?: string;
  ps?: string;
  platform?: string;
  label?: string;
}

interface RegistrationVector {
  name: string;
  kind: string;
  description: string;
  now: number;
  qr: string;
  minterKey: Record<string, string>;
  wantDev?: string;
  ownerEphemeralKey: Record<string, string>;
  iv: string;
  plaintext: string;
  result?: unknown;
  wire: string;
}

function load<T extends { kind: string }>(dir: string, kind: string): T[] {
  return readdirSync(path.join(FIXTURES, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(FIXTURES, dir, f), 'utf8')) as T)
    .filter((f) => f.kind === kind);
}

function materialOf(v: RegistrationVector): PairingMaterial {
  return { qr: parseControllerQr(v.qr), minter: parsePrivateJwk(v.minterKey) };
}

describe('controller QR (§5.6.1)', () => {
  const [positive] = load<{ kind: string; cases: QrCase[] }>('positive', 'controllerQR');
  const [negative] = load<{ kind: string; cases: QrCase[] }>('negative', 'controllerQR');

  test('both vectors are present', () => {
    assert.ok(positive && positive.cases.length > 0);
    assert.ok(negative && negative.cases.length > 0);
  });

  for (const c of positive?.cases ?? []) {
    test(`parses and re-renders: ${c.description}`, () => {
      const qr = parseControllerQr(c.qr);
      assert.equal(qr.channelId, c.channelId);
      assert.equal(qr.minterKey, c.minterKey);
      assert.deepEqual(qr.sig, parsePublicJwk(JSON.parse(c.sig!)));
      assert.deepEqual(qr.enc, parsePublicJwk(JSON.parse(c.enc!)));
      assert.equal(qr.ps, c.ps);
      assert.equal(qr.platform, c.platform);
      assert.equal(qr.label, c.label);
      assert.equal(controllerQrCtl(qr), c.ctl);
      assert.equal(controllerQrString(qr), c.qr);
    });
  }

  for (const c of negative?.cases ?? []) {
    test(`rejects: ${c.description}`, () => {
      assert.throws(() => parseControllerQr(c.qr));
    });
  }

  test('generated material renders a QR that parses back, with a fresh secret each time', () => {
    const stranger = JSON.parse(readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8')).controllers
      .stranger;
    const keys = { sig: parsePrivateJwk(stranger.sig), enc: parsePrivateJwk(stranger.enc) };
    const a = generatePairingMaterial(keys, 'Studio | desk');
    const b = generatePairingMaterial(keys, 'Studio | desk');
    assert.deepEqual(parseControllerQr(controllerQrString(a.qr)), a.qr);
    assert.equal(a.qr.platform, 'cli');
    assert.equal(b64uDecode(a.qr.ps).length, 16);
    assert.notEqual(a.qr.ps, b.qr.ps);
    assert.notEqual(a.qr.channelId, b.qr.channelId);
    assert.notEqual(a.qr.minterKey, b.qr.minterKey);
  });
});

describe('sealed registration result (§5.6.2, §5.6.3)', () => {
  const positive = load<RegistrationVector>('positive', 'registration');
  const negative = load<RegistrationVector>('negative', 'registration');

  test('vectors are present', () => {
    assert.ok(positive.length >= 2);
    assert.ok(negative.length >= 11);
  });

  for (const v of positive) {
    describe(v.name, () => {
      test('the CLI reproduces the wire message byte for byte', () => {
        const wire = sealRegistration(
          parseControllerQr(v.qr),
          v.plaintext,
          parsePrivateJwk(v.ownerEphemeralKey),
          b64uDecode(v.iv)
        );
        assert.equal(wire, v.wire);
      });

      test('the CLI opens it to the expected result', () => {
        const result = openRegistration(materialOf(v), v.wire, v.wantDev ?? 'FF1-FIXTURE1', v.now);
        assert.deepEqual(toPlainJson(result), v.result);
      });

      test('a wrong minter key cannot open it', () => {
        const material = materialOf(v);
        const other = generatePairingMaterial(
          { sig: material.minter, enc: material.minter },
          'x'
        ).minter;
        assert.throws(() =>
          openRegistration({ ...material, minter: other }, v.wire, 'FF1-FIXTURE1', v.now)
        );
      });
    });
  }

  // Each negative must fail at the check it targets, not at an earlier one.
  const reasons: Record<string, RegExp> = {
    'registration-approved-no-profile': /needs profile/,
    'registration-expired': /expiresAt/,
    'registration-extra-member': /registration result has unexpected member/,
    'registration-owner-expiry': /expiresAt/,
    'registration-rejected-with-role': /rejected registration carries no grant/,
    'registration-tampered': /does not decrypt/,
    'registration-wire-extra-member': /sealed registration has unexpected member/,
    'registration-wrong-channel': /another channel/,
    'registration-wrong-ctl': /another controller/,
    'registration-wrong-device': /another device/,
    'registration-wrong-ps': /ps does not match/,
  };

  for (const v of negative) {
    test(`rejects ${v.name}: ${v.description}`, () => {
      assert.ok(reasons[v.name], `no expected reason for ${v.name}`);
      assert.throws(
        () => openRegistration(materialOf(v), v.wire, v.wantDev ?? 'FF1-FIXTURE1', v.now),
        reasons[v.name]
      );
    });
  }

  test('an approved result is refused for another configured device', () => {
    const v = positive.find((p) => p.name === 'controller-registration')!;
    assert.throws(
      () => openRegistration(materialOf(v), v.wire, 'FF1-OTHER0001', v.now),
      /another device/
    );
  });

  test('an expiry at or before now is refused', () => {
    const v = positive.find((p) => p.name === 'controller-registration')!;
    const expiresAt = (v.result as { expiresAt: number }).expiresAt;
    assert.throws(
      () => openRegistration(materialOf(v), v.wire, 'FF1-FIXTURE1', expiresAt),
      /expiresAt/
    );
  });

  test('garbage, truncated and non-JSON messages are refused', () => {
    const v = positive[0];
    for (const bad of ['', 'hello', '{}', v.wire.slice(0, -10), `${v.wire} `.repeat(2)]) {
      assert.throws(() => openRegistration(materialOf(v), bad, 'FF1-FIXTURE1', v.now));
    }
  });
});
