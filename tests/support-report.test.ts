/**
 * support-report.ts pieces the CLI test cannot reach through a plaintext
 * loopback FF1: uploadLogs as a secure envelope, the signing-key guard's
 * encodings, and where the support-logs origin comes from.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { parseProfile } from '../src/utilities/control/codec';
import { parsePrivateJwk } from '../src/utilities/control/jwk';
import { type ControllerRecord, saveController } from '../src/utilities/control/controller-store';
import { getSupportLogsConfig, validateConfig } from '../src/config';
import {
  MAX_REPORT_BYTES,
  MAX_REQUEST_BYTES,
  buildReportPayload,
  containsSigningKey,
  isBareAddress,
  isReservedAddress,
  postReport,
  readDeviceStatus,
  requestLogUpload,
} from '../src/utilities/support-report';
import { FakeFF1, type Jwk } from './helpers/control-device';

const FIXTURES = path.join(__dirname, 'fixtures', 'ff1-control-v1');
const keys = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8'));
const NOW = keys.now as number;
const DEVICE_ID = keys.device.dev as string;
const HOST = 'http://ff1-fixture1.local:1111';
const RECEIPT = { supportBundleId: '0Ab3dEf6gH9iJ', uploadToken: 'bundle-token.abc' };

let tmp: string;
let storeDir: string;
const originalCwd = process.cwd();
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff1-report-unit-'));
  storeDir = path.join(tmp, 'controllers');
  process.env.XDG_CONFIG_HOME = path.join(tmp, '.xdg');
  delete process.env.FF_SUPPORT_LOGS_URL;
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
});

function enrolledRecord(name: 'owner' | 'controller'): void {
  const c = keys.controllers[name];
  const record: ControllerRecord = {
    v: 1,
    deviceId: DEVICE_ID,
    profile: parseProfile(keys.device.profile),
    keys: { sig: parsePrivateJwk(c.sig), enc: parsePrivateJwk(c.enc) },
    label: 'test cli',
    role: c.role,
    nk: c.nk,
    ctr: 0,
    createdAt: NOW,
    enrolledAt: NOW,
  };
  saveController(record, { dir: storeDir });
}

function fakeDevice(decide?: ConstructorParameters<typeof FakeFF1>[2]): FakeFF1 {
  const grants: Record<string, Jwk> = {};
  for (const name of ['owner', 'controller']) {
    const c = keys.controllers[name];
    grants[c.ctl] = { kty: 'EC', crv: 'P-256', x: c.sig.x, y: c.sig.y };
  }
  return new FakeFF1(
    { dev: DEVICE_ID, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
    grants,
    decide
  );
}

/** lanFetch routes LAN casts to the fake device. */
function lanFetch(device: FakeFF1): typeof fetch {
  return async (input, init) => {
    assert.equal(new URL(input.toString()).origin, HOST);
    const answer = device.handle(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(answer.json), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('requestLogUpload over secure control', () => {
  const office = { name: 'Office', id: DEVICE_ID, host: HOST };

  test('sends uploadLogs with the token inside a LAN envelope', async () => {
    enrolledRecord('owner');
    const device = fakeDevice();
    const result = await requestLogUpload(office, RECEIPT, {
      fetchFn: lanFetch(device),
      controllerStore: { dir: storeDir },
      nowFn: () => NOW,
    });
    assert.equal(result.success, true, result.error);
    const upload = device.seen.find((c) => c.cmd === 'uploadLogs');
    assert.ok(upload, 'uploadLogs reached the FF1');
    assert.deepEqual(upload.req, {
      userId: 'ff-cli',
      apiKey: 'bundle-token.abc',
      title: 'ff-cli report',
      supportBundleID: '0Ab3dEf6gH9iJ',
    });
  });

  test('a controller-role grant gets the owner-access guidance', async () => {
    enrolledRecord('controller');
    const device = fakeDevice((claims) =>
      claims.cmd === 'uploadLogs' ? { ok: false, code: 'permission_denied' } : { ok: true, res: {} }
    );
    const result = await requestLogUpload(office, RECEIPT, {
      fetchFn: lanFetch(device),
      controllerStore: { dir: storeDir },
      nowFn: () => NOW,
    });
    assert.equal(result.success, false);
    assert.match(result.error!, /owner access/);
    assert.match(result.details!, /owner role/);
  });

  test('a relayer answer whose body read fails is a failure, never a throw', async () => {
    // The report is already in when this runs; a throw would reach the command
    // and turn a delivered report into exit 1.
    enrolledRecord('owner');
    const urls: string[] = [];
    const result = await requestLogUpload(office, RECEIPT, {
      fetchFn: async (input) => {
        urls.push(input.toString());
        if (input.toString().startsWith(HOST)) {
          throw new Error('fetch failed', { cause: { code: 'EHOSTUNREACH' } });
        }
        return {
          ok: true,
          status: 200,
          text: () => Promise.reject(new Error('terminated')),
        } as unknown as Response;
      },
      getRelayerConfigFn: () => ({ baseUrl: 'https://relayer.example' }),
      getTopicIdFn: () => 'topic-secret',
      controllerStore: { dir: storeDir },
      nowFn: () => NOW,
    });
    assert.equal(result.success, false);
    assert.match(result.error!, /terminated/);
    assert.ok(
      urls.some((u) => u.startsWith('https://relayer.example/')),
      'the relayer was tried'
    );
  });
});

/**
 * EMAIL_FIXTURES are the reply-address cases shared with support-logs and
 * support-intake, copied unchanged from the cross-repo contract. All three must
 * accept exactly the `accept` list and refuse exactly the `reject` list.
 */
const EMAIL_FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'reporter-email-fixtures.json'), 'utf8')
) as { rule: string; accept: string[]; reject: string[] };

/** acceptedReplyAddress is what `--email` takes: the grammar's form and not reserved. */
function acceptedReplyAddress(value: string): boolean {
  return isBareAddress(value) && !isReservedAddress(value);
}

describe('reply address (shared fixtures)', () => {
  for (const address of EMAIL_FIXTURES.accept) {
    test(`accepts ${JSON.stringify(address.length > 40 ? `${address.slice(0, 40)}… (${address.length})` : address)}`, () => {
      assert.equal(acceptedReplyAddress(address), true);
    });
  }
  for (const address of EMAIL_FIXTURES.reject) {
    test(`refuses ${JSON.stringify(address.length > 40 ? `${address.slice(0, 40)}… (${address.length})` : address)}`, () => {
      assert.equal(acceptedReplyAddress(address), false);
    });
  }

  test('also refuses control and non-ASCII characters in the local part', () => {
    for (const address of ['a\u0001b@example.com', 'üser@example.com', 'a\tb@example.com']) {
      assert.equal(acceptedReplyAddress(address), false, JSON.stringify(address));
    }
  });

  test('a reserved address has the accepted form but is refused as reserved', () => {
    for (const address of [
      'support@feralfile.com',
      'Postmaster@example.com',
      'mailer-daemon@example.com',
    ]) {
      assert.equal(isBareAddress(address), true, address);
      assert.equal(isReservedAddress(address), true, address);
    }
  });
});

describe('report body size', () => {
  test('the worst-case body for a 32768-byte report stays under the 256 KiB request cap', () => {
    // Every report byte a control character JSON escapes as \u00XX (6 bytes),
    // the longest reply address, and every device field at the 256-byte cap,
    // also all control characters.
    const control = '\u0001';
    const body = JSON.stringify(
      buildReportPayload({
        report: control.repeat(MAX_REPORT_BYTES),
        ffCliVersion: '3.0.0',
        // The longest address the shared fixtures accept: 254 bytes.
        email: EMAIL_FIXTURES.accept.reduce((a, b) => (b.length > a.length ? b : a)),
        device: {
          device_id: control.repeat(256),
          version: control.repeat(256),
          branch: control.repeat(256),
        },
      }),
      null,
      2
    );
    const bytes = Buffer.byteLength(body, 'utf8');
    assert.ok(bytes < 202_000, `worst case is ${bytes} bytes`);
    assert.ok(bytes < MAX_REQUEST_BYTES);
  });

  test('postReport refuses a body over the cap without sending it', async () => {
    let calls = 0;
    const result = await postReport(
      'http://127.0.0.1:9',
      'x'.repeat(MAX_REQUEST_BYTES + 1),
      async () => {
        calls += 1;
        return new Response('{}', { status: 201 });
      }
    );
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.match((result as { error: string }).error, /at most 262144/);
  });

  test('a device field over the 256-byte field cap is left out', async () => {
    const result = await readDeviceStatus(
      { name: 'Office', id: 'FF1-CONFIG01', host: HOST },
      async () =>
        new Response(
          JSON.stringify({ device_id: 'FF1-X', version: 'v'.repeat(257), branch: 'release' })
        )
    );
    assert.deepEqual(result.device, { device_id: 'FF1-X', branch: 'release' });
  });
});

/** keyWithSlash returns a base64 PKCS#8 Ed25519 key that contains a `/`, the character JSON may escape. */
function keyWithSlash(): string {
  for (;;) {
    const der = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    if (der.includes('/')) {
      return der;
    }
  }
}

/** pemWrapped wraps a base64 DER body as PEM, 16 characters a line. */
function pemWrapped(der: string): string {
  return `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,16}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

describe('containsSigningKey', () => {
  const key = generateKeyPairSync('ed25519').privateKey;
  const der = key.export({ format: 'der', type: 'pkcs8' });
  const seed = Buffer.from(String(key.export({ format: 'jwk' }).d), 'base64url');
  const configured = der.toString('base64');
  const pem = String(key.export({ format: 'pem', type: 'pkcs8' }));

  test('finds the key as configured and in the other encodings of the same key', () => {
    for (const form of [
      configured,
      der.toString('hex'),
      seed.toString('hex').toUpperCase(),
      `0x${seed.toString('hex')}`,
      seed.toString('base64'),
      seed.toString('base64url'),
    ]) {
      assert.equal(containsSigningKey(`config: ${form} end`, configured), true, form);
    }
  });

  test('finds a configured PEM key, and its body wrapped across lines', () => {
    const body = configured.match(/.{1,16}/g)!.join('\n  ');
    assert.equal(containsSigningKey(`pasted:\n  ${body}\n`, pem), true);
  });

  test('finds the key through JSON string escapes and percent-encoding', () => {
    const slashed = keyWithSlash();
    const escaped = slashed.replace(/\//g, '\\/');
    const unicode = slashed.replace(/\//g, '\\u002F');
    const pemInJson = JSON.stringify({ privateKey: pemWrapped(slashed) }).replace(/\//g, '\\/');
    for (const report of [
      JSON.stringify({ playlist: { privateKey: slashed } }).replace(/\//g, '\\/'),
      `"privateKey": "${unicode}"`,
      pemInJson,
      JSON.stringify({ log: JSON.stringify({ privateKey: escaped }) }),
      `https://example.com/?k=${encodeURIComponent(slashed)}`,
    ]) {
      assert.equal(containsSigningKey(report, slashed), true, report);
    }
  });

  test('ignores another key, and does nothing without a configured key', () => {
    const other = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    assert.equal(containsSigningKey(`config: ${other}`, configured), false);
    assert.equal(containsSigningKey(`config: ${configured}`, null), false);
    assert.equal(containsSigningKey(`config: ${configured}`, '  '), false);
  });
});

describe('support-logs origin', () => {
  test('defaults to production, FF_SUPPORT_LOGS_URL overrides it, config.json wins', () => {
    assert.equal(getSupportLogsConfig().baseUrl, 'https://support-logs.feralfile.com');
    process.env.FF_SUPPORT_LOGS_URL = 'https://support-logs.staging.example/';
    assert.equal(getSupportLogsConfig().baseUrl, 'https://support-logs.staging.example');
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ supportLogs: { baseUrl: 'http://127.0.0.1:9999' } })
    );
    assert.equal(getSupportLogsConfig().baseUrl, 'http://127.0.0.1:9999');
  });

  test('config validate reports a bad supportLogs.baseUrl', () => {
    fs.writeFileSync(
      path.join(tmp, 'config.json'),
      JSON.stringify({ supportLogs: { baseUrl: 'ftp://support.example' } })
    );
    assert.throws(
      () => getSupportLogsConfig(),
      /supportLogs.baseUrl must be a valid HTTP\(S\) URL/
    );
    assert.ok(validateConfig().errors.includes('supportLogs.baseUrl must be a valid HTTP(S) URL'));
  });
});
