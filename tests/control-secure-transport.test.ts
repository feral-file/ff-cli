/**
 * Secure control path (feral-file#3551 M6): controller key store invariants
 * and the three device commands over LAN and relayer, against a fake FF1
 * built from the fixture device keys.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { encodeRelayFrame } from '../src/utilities/relay-client';
import { sendSecureRequest } from '../src/utilities/control/secure-transport';
import { parseProfile } from '../src/utilities/control/codec';
import { parsePrivateJwk } from '../src/utilities/control/jwk';
import {
  type ControllerRecord,
  controllerFilePath,
  createController,
  deleteController,
  loadController,
  markEnrolled,
  nextCounter,
  recordRegistration,
  saveController,
} from '../src/utilities/control/controller-store';
import {
  REPLAY_COUNTER_JUMP,
  type SecureTransportDeps,
  findEnvelopeAnswer,
  sendSecureRequest,
} from '../src/utilities/control/secure-transport';
import { sendPlaylistToDevice } from '../src/utilities/ff1-device';
import { sendSshAccessCommand } from '../src/utilities/ssh-access';
import { FakeFF1, sealReply, type Jwk } from './helpers/control-device';

const FIXTURES = path.join(__dirname, 'fixtures', 'ff1-control-v1');
const keys = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8'));
const NOW = keys.now as number;
const DEVICE_ID = keys.device.dev as string;
const HOST = 'http://ff1-fixture1.local:1111';

const playlist = {
  dpVersion: '1.1.0',
  id: 'secure-test',
  title: 'Secure test',
  items: [],
} as unknown as Parameters<typeof sendPlaylistToDevice>[0]['playlist'];

let tmp: string;
let storeDir: string;
const originalCwd = process.cwd();

function enrolledRecord(name: 'owner' | 'controller'): ControllerRecord {
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
  return record;
}

function fakeDevice(decide?: ConstructorParameters<typeof FakeFF1>[2]): FakeFF1 {
  const grants: Record<string, Jwk> = {};
  for (const name of ['owner', 'controller']) {
    const c = keys.controllers[name];
    grants[c.ctl] = { kty: 'EC', crv: 'P-256', x: c.sig.x, y: c.sig.y };
  }
  return new FakeFF1(
    {
      dev: DEVICE_ID,
      gen: keys.device.gen,
      sig: keys.device.sig,
      enc: keys.device.enc,
    },
    grants,
    decide
  );
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** lanFetch routes LAN casts to the fake device and records request bodies. */
function lanFetch(device: FakeFF1, bodies: unknown[] = []): typeof fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    assert.equal(new URL(input.toString()).origin, HOST);
    const answer = device.handle(body);
    return json(answer.status, answer.json);
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff1-secure-'));
  storeDir = path.join(tmp, 'controllers');
  fs.writeFileSync(
    path.join(tmp, 'config.json'),
    JSON.stringify({
      // v2 off: these tests pin the legacy topic route; the carrier tests below set it.
      ff1Relayer: { baseUrl: 'https://relayer.example', v2Endpoint: '' },
      ff1Devices: { devices: [{ name: 'Office', id: DEVICE_ID, host: HOST }] },
    })
  );
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('controller key store', () => {
  test('creates the file 0600 in a 0700 directory with pins and no grant', () => {
    const record = createController(
      { profile: parseProfile(keys.device.profile), label: 'laptop' },
      { dir: storeDir }
    );
    const file = controllerFilePath(DEVICE_ID, { dir: storeDir });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(storeDir).mode & 0o777, 0o700);
    }
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.gen, keys.device.gen);
    assert.deepEqual(stored.pins, keys.device.pins);
    assert.equal(stored.role, undefined);
    assert.equal(stored.ctr, 0);
    assert.deepEqual(loadController(DEVICE_ID, { dir: storeDir }), record);
  });

  test('allocates strictly increasing counters and persists each one first', () => {
    enrolledRecord('owner');
    const seen = [1, 2, 3].map(() => nextCounter(DEVICE_ID, { dir: storeDir }).ctr);
    assert.deepEqual(seen, [1, 2, 3]);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir })!.ctr, 3);
    assert.equal(fs.existsSync(`${controllerFilePath(DEVICE_ID, { dir: storeDir })}.lock`), false);
    assert.deepEqual(
      fs.readdirSync(storeDir).filter((f) => f.endsWith('.tmp')),
      []
    );
  });

  test('breaks a stale lock left by a crashed process', () => {
    enrolledRecord('owner');
    const lock = `${controllerFilePath(DEVICE_ID, { dir: storeDir })}.lock`;
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    assert.equal(nextCounter(DEVICE_ID, { dir: storeDir }).ctr, 1);
  });

  test('breaks a lock whose holder process has exited once it is old enough', () => {
    enrolledRecord('owner');
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const lock = `${controllerFilePath(DEVICE_ID, { dir: storeDir })}.lock`;
    fs.writeFileSync(lock, `${dead}:token`);
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lock, old, old);
    assert.equal(nextCounter(DEVICE_ID, { dir: storeDir }).ctr, 1);
    assert.equal(fs.existsSync(lock), false);
    assert.deepEqual(
      fs.readdirSync(storeDir).filter((f) => f.endsWith('.stale')),
      []
    );
  });

  test('does not break a dead-holder lock younger than the minimum age', () => {
    enrolledRecord('owner');
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const lock = `${controllerFilePath(DEVICE_ID, { dir: storeDir })}.lock`;
    fs.writeFileSync(lock, `${dead}:token`);
    // nextCounter waits up to 5 s; the lock turns 1 s old meanwhile and is
    // broken then, so the allocation succeeds only after that delay.
    const started = Date.now();
    assert.equal(nextCounter(DEVICE_ID, { dir: storeDir }).ctr, 1);
    assert.ok(Date.now() - started >= 900);
  });

  test('unpair (deleteController) takes the counter lock', () => {
    enrolledRecord('owner');
    const lock = `${controllerFilePath(DEVICE_ID, { dir: storeDir })}.lock`;
    fs.writeFileSync(lock, `${process.ppid}:other`);
    assert.throws(() => deleteController(DEVICE_ID, { dir: storeDir }), /Timed out/);
    assert.ok(loadController(DEVICE_ID, { dir: storeDir }));
    fs.rmSync(lock);
    assert.equal(deleteController(DEVICE_ID, { dir: storeDir }), true);
  });

  test('storing a registration result re-reads under the lock and keeps a newer counter', () => {
    const stale = createController(
      { profile: parseProfile(keys.device.profile), label: 'a' },
      { dir: storeDir }
    );
    nextCounter(DEVICE_ID, { dir: storeDir });
    nextCounter(DEVICE_ID, { dir: storeDir });
    assert.equal(stale.ctr, 0); // the caller's copy is out of date
    const registration = {
      channelId: '7b0d6e4a-2f51-4c8e-9a43-a48fcc56c5d9',
      deviceName: 'Office',
      role: 'controller' as const,
      receivedAt: NOW,
    };
    const updated = recordRegistration(DEVICE_ID, { label: 'b', registration }, { dir: storeDir });
    assert.equal(updated.ctr, 2);
    const reloaded = loadController(DEVICE_ID, { dir: storeDir })!;
    assert.equal(reloaded.ctr, 2);
    assert.equal(reloaded.label, 'b');
    assert.deepEqual(reloaded.registration, registration);
  });

  test('a failed atomic write leaves no temp file with key material', () => {
    // The target name is a non-empty directory, so the rename fails.
    const target = controllerFilePath(DEVICE_ID, { dir: storeDir });
    fs.mkdirSync(path.join(target, 'blocker'), { recursive: true });
    assert.throws(() =>
      createController(
        { profile: parseProfile(keys.device.profile), label: 'x' },
        { dir: storeDir }
      )
    );
    assert.deepEqual(
      fs.readdirSync(storeDir).filter((f) => f.endsWith('.tmp')),
      []
    );
  });

  test('releasing never removes a lock another process now holds', () => {
    enrolledRecord('owner');
    const lock = `${controllerFilePath(DEVICE_ID, { dir: storeDir })}.lock`;
    // A live holder (this test process's parent PID stands in for one).
    fs.writeFileSync(lock, `${process.ppid}:other`);
    assert.throws(() => nextCounter(DEVICE_ID, { dir: storeDir }), /Timed out/);
    assert.equal(fs.readFileSync(lock, 'utf8'), `${process.ppid}:other`);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir })!.ctr, 0);
  });

  test('markEnrolled keeps a counter allocated in between', () => {
    createController({ profile: parseProfile(keys.device.profile), label: 'x' }, { dir: storeDir });
    nextCounter(DEVICE_ID, { dir: storeDir });
    nextCounter(DEVICE_ID, { dir: storeDir });
    const record = markEnrolled(
      DEVICE_ID,
      { role: 'controller', nk: keys.controllers.controller.nk },
      { dir: storeDir }
    );
    assert.equal(record.ctr, 2);
    assert.equal(record.role, 'controller');
  });

  test('a corrupt file is an error that never echoes key material', () => {
    const record = enrolledRecord('owner');
    const file = controllerFilePath(DEVICE_ID, { dir: storeDir });
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.pins.sig = 'x'.repeat(43);
    fs.writeFileSync(file, JSON.stringify(stored));
    assert.throws(
      () => loadController(DEVICE_ID, { dir: storeDir }),
      (error: Error) =>
        /corrupt/.test(error.message) &&
        !error.message.includes(record.keys.sig.d) &&
        /device pair/.test(error.message) &&
        !/unpair/.test(error.message)
    );
  });

  test('rejects a device ID that is not file-name safe', () => {
    assert.throws(() => controllerFilePath('../evil', { dir: storeDir }));
  });
});

describe('secure displayPlaylist', () => {
  test('sends preflight and cast as envelopes with fresh counters over the LAN', async () => {
    enrolledRecord('owner');
    const device = fakeDevice((claims) =>
      claims.cmd === 'getDeviceStatus'
        ? { ok: true, res: { message: { installedVersion: '2.1.0' } } }
        : { ok: true, res: { ok: true } }
    );
    const bodies: Array<Record<string, unknown>> = [];
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: lanFetch(device, bodies),
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
        waitFn: async () => undefined,
      }
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.transport, 'lan');
    assert.ok(bodies.every((b) => b.command === 'ff1Envelope'));
    assert.deepEqual(
      device.seen.map((c) => [c.cmd, c.ctr]),
      [
        ['getDeviceStatus', 1],
        ['displayPlaylist', 2],
      ]
    );
    assert.deepEqual(device.seen[1].req, {
      dp1_call: playlist,
      intent: { action: 'now_display' },
    });
    assert.equal(loadController(DEVICE_ID, { dir: storeDir })!.ctr, 2);
    // The plaintext playlist never crosses the wire.
    assert.ok(!JSON.stringify(bodies).includes('secure-test'));
  });

  test('a transient preflight answer (internal_error) does not stop the command', async () => {
    enrolledRecord('owner');
    const device = fakeDevice((claims) =>
      claims.cmd === 'getDeviceStatus'
        ? { ok: false, code: 'internal_error' }
        : { ok: true, res: { ok: true } }
    );
    const result = await sendPlaylistToDevice(
      { playlist },
      { fetchFn: lanFetch(device), controllerStore: { dir: storeDir }, nowFn: () => NOW }
    );
    assert.equal(result.success, true, result.error);
    assert.deepEqual(
      device.seen.map((c) => c.cmd),
      ['getDeviceStatus', 'displayPlaylist']
    );
  });

  for (const [name, first] of [
    ['internal_error', { ok: false, code: 'internal_error' }],
    ['rate_limited', { ok: false, code: 'rate_limited' }],
    [
      'storm-protection command_failed',
      {
        ok: false,
        code: 'command_failed',
        res: { ok: false, error: 'rate_limited', command: 'displayPlaylist', message: 'busy' },
      },
    ],
  ] as const) {
    test(`play retries ${name} with a new request (new ctr and rid)`, async () => {
      enrolledRecord('controller');
      let casts = 0;
      const device = fakeDevice((claims) => {
        if (claims.cmd !== 'displayPlaylist') {
          return { ok: true, res: {} };
        }
        casts += 1;
        return casts === 1 ? first : { ok: true, res: { ok: true } };
      });
      const waits: number[] = [];
      const result = await sendPlaylistToDevice(
        { playlist },
        {
          fetchFn: lanFetch(device),
          controllerStore: { dir: storeDir },
          nowFn: () => NOW,
          waitFn: async (ms) => {
            waits.push(ms);
          },
        }
      );
      assert.equal(result.success, true, result.error);
      const casted = device.seen.filter((c) => c.cmd === 'displayPlaylist');
      assert.equal(casted.length, 2);
      assert.notEqual(casted[0].ctr, casted[1].ctr);
      assert.notEqual(casted[0].rid, casted[1].rid);
      assert.equal(waits.length, 1);
    });
  }

  test('play retries a public busy (LAN 503) with a new request', async () => {
    enrolledRecord('controller');
    const device = fakeDevice();
    let casts = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      const answer = device.handle(JSON.parse(String(init?.body)));
      if (device.seen.at(-1)!.cmd === 'displayPlaylist' && casts++ === 0) {
        return json(503, { error: { code: 'busy' } });
      }
      return json(answer.status, answer.json);
    };
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn,
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
        waitFn: async () => undefined,
      }
    );
    assert.equal(result.success, true, result.error);
    const casted = device.seen.filter((c) => c.cmd === 'displayPlaylist');
    assert.equal(casted.length, 2);
    assert.notEqual(casted[0].ctr, casted[1].ctr);
    assert.notEqual(casted[0].rid, casted[1].rid);
  });

  test('a busy preflight does not stop the command', async () => {
    enrolledRecord('owner');
    const device = fakeDevice((claims) =>
      claims.cmd === 'getDeviceStatus'
        ? { publicCode: 'busy', status: 503 }
        : { ok: true, res: { ok: true } }
    );
    const result = await sendPlaylistToDevice(
      { playlist },
      { fetchFn: lanFetch(device), controllerStore: { dir: storeDir }, nowFn: () => NOW }
    );
    assert.equal(result.success, true, result.error);
  });

  test('busy from the relayer RPC is reported as busy', async () => {
    enrolledRecord('controller');
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: async (input) => {
          if (new URL(input.toString()).origin === HOST) {
            throw new Error('fetch failed', { cause: { code: 'EHOSTUNREACH' } });
          }
          return json(200, { message: { error: { code: 'busy' } } });
        },
        getTopicIdFn: () => 'topic-secret',
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
        waitFn: async () => undefined,
        noticeFn: () => undefined,
      }
    );
    assert.equal(result.success, false);
    assert.equal(result.error, 'The FF1 is busy; try again.');
  });

  test('a command_failed that is not storm protection is not retried', async () => {
    enrolledRecord('controller');
    const device = fakeDevice((claims) =>
      claims.cmd === 'displayPlaylist'
        ? { ok: false, code: 'command_failed', res: { ok: false, error: 'playlistInvalid' } }
        : { ok: true, res: {} }
    );
    const result = await sendPlaylistToDevice(
      { playlist },
      { fetchFn: lanFetch(device), controllerStore: { dir: storeDir }, nowFn: () => NOW }
    );
    assert.equal(result.success, false);
    assert.equal(device.seen.filter((c) => c.cmd === 'displayPlaylist').length, 1);
  });

  test('a retry after HTTP 429 is a new request with a new ctr and rid', async () => {
    enrolledRecord('controller');
    const device = fakeDevice();
    let casts = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const answer = device.handle(body);
      const claims = device.seen.at(-1)!;
      if (claims.cmd === 'displayPlaylist' && casts++ === 0) {
        return json(429, {}, { 'retry-after': '1' });
      }
      return json(answer.status, answer.json);
    };
    const waits: number[] = [];
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn,
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
        waitFn: async (ms) => {
          waits.push(ms);
        },
      }
    );
    assert.equal(result.success, true, result.error);
    const casted = device.seen.filter((c) => c.cmd === 'displayPlaylist');
    assert.equal(casted.length, 2);
    assert.notEqual(casted[0].ctr, casted[1].ctr);
    assert.notEqual(casted[0].rid, casted[1].rid);
    assert.deepEqual(waits, [1000]);
  });

  test('falls back to the relayer with a freshly sealed envelope when the LAN is unreachable', async () => {
    enrolledRecord('controller');
    const device = fakeDevice();
    const relayed: string[] = [];
    const notices: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      if (url.origin === HOST) {
        throw new Error('fetch failed', { cause: { code: 'EHOSTUNREACH' } });
      }
      relayed.push(url.toString());
      const answer = device.handle(JSON.parse(String(init?.body)));
      return json(200, { message: answer.json });
    };
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn,
        getTopicIdFn: () => 'topic-secret',
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
        waitFn: async () => undefined,
        noticeFn: (m) => notices.push(m),
      }
    );
    assert.equal(result.success, true, result.error);
    assert.equal(result.transport, 'relayer');
    assert.equal(relayed.length, 1);
    assert.match(relayed[0], /topicID=topic-secret/);
    assert.match(notices[0], /relayer/);
    // Three LAN casts and the preflight burned counters 1-4; the relayer used 5.
    assert.equal(device.seen.at(-1)!.ctr, 5);
  });

  test('a connection reset after the request was sent is never resent on any route', async () => {
    enrolledRecord('controller');
    const device = fakeDevice();
    const relayed: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      if (url.origin !== HOST) {
        relayed.push(url.toString());
        throw new Error('the relayer must not be used');
      }
      const answer = device.handle(JSON.parse(String(init?.body)));
      if (device.seen.at(-1)?.cmd === 'displayPlaylist') {
        // Delivered and run, then the socket dropped before the reply.
        throw new Error('fetch failed', { cause: { code: 'ECONNRESET' } });
      }
      return json(answer.status, answer.json);
    };
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn,
        getTopicIdFn: () => 'topic-secret',
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
        waitFn: async () => undefined,
        noticeFn: () => undefined,
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Outcome unknown/);
    assert.equal(relayed.length, 0);
    assert.equal(device.seen.filter((c) => c.cmd === 'displayPlaylist').length, 1);
  });

  test('maps an encrypted access_revoked to pairing guidance', async () => {
    enrolledRecord('controller');
    const device = fakeDevice(() => ({ ok: false, code: 'access_revoked' }));
    const result = await sendPlaylistToDevice(
      { playlist },
      { fetchFn: lanFetch(device), controllerStore: { dir: storeDir }, nowFn: () => NOW }
    );
    assert.equal(result.success, false);
    assert.match(result.error!, /revoked/);
    assert.match(result.details!, /ff-cli device pair Office/);
    assert.match(result.details!, /Add controller/);
    // The preflight refusal stops the command before the playlist is sent.
    assert.deepEqual(
      device.seen.map((c) => c.cmd),
      ['getDeviceStatus']
    );
  });

  test('maps a public unknown_controller (HTTP 401) to pairing guidance', async () => {
    const record = enrolledRecord('owner');
    // A device that never heard of this controller.
    const device = new FakeFF1(
      { dev: DEVICE_ID, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
      {}
    );
    const result = await sendPlaylistToDevice(
      { playlist },
      { fetchFn: lanFetch(device), controllerStore: { dir: storeDir }, nowFn: () => NOW }
    );
    assert.equal(result.success, false);
    assert.match(result.error!, /does not know this ff-cli controller/);
    assert.match(result.details!, /ff-cli device pair Office/);
    assert.ok(record);
  });

  test('discards a reply signed by anything but the pinned devSig', async () => {
    enrolledRecord('owner');
    const device = fakeDevice();
    const impostor = keys.controllers.stranger.sig as Jwk;
    const fetchFn: typeof fetch = async (_input, init) => {
      device.handle(JSON.parse(String(init?.body)));
      const claims = device.seen.at(-1)!;
      const forged = sealReply(impostor, String(claims.rk), {
        v: 1,
        dev: DEVICE_ID,
        gen: keys.device.gen,
        ctl: claims.ctl,
        rid: claims.rid,
        iat: NOW,
        ok: true,
        res: { ok: true },
      });
      return json(200, { v: 1, jwe: forged });
    };
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn,
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
        waitFn: async () => undefined,
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error!, /did not verify/);
  });

  test('surfaces command_failed with the handler body', async () => {
    enrolledRecord('controller');
    const device = fakeDevice((claims) =>
      claims.cmd === 'displayPlaylist'
        ? {
            ok: false,
            code: 'command_failed',
            res: {
              ok: false,
              error: 'sourceUnreachable',
              command: 'displayPlaylist',
              message: 'sourceUnreachable: no playlist item source is loadable',
            },
          }
        : { ok: true, res: {} }
    );
    const result = await sendPlaylistToDevice(
      { playlist },
      { fetchFn: lanFetch(device), controllerStore: { dir: storeDir }, nowFn: () => NOW }
    );
    assert.equal(result.success, false);
    assert.match(result.error!, /rejected the command/);
    assert.match(result.details!, /sourceUnreachable/);
  });

  test('a pending controller file stops with resume guidance and sends nothing', async () => {
    createController({ profile: parseProfile(keys.device.profile), label: 'x' }, { dir: storeDir });
    let calls = 0;
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: async () => {
          calls += 1;
          return json(200, {});
        },
        controllerStore: { dir: storeDir },
      }
    );
    assert.equal(result.success, false);
    assert.match(result.details!, /--resume/);
    assert.equal(calls, 0);
  });
});

describe('replay recovery (§14.4)', () => {
  const device = { name: 'Office', id: DEVICE_ID, host: HOST };
  const request = {
    device,
    op: 'cmd' as const,
    cmd: 'getDeviceStatus',
    req: {},
    relayerFallback: false,
    retry: false,
  };

  test('a verified replay moves the counter ahead and sends the command once more', async () => {
    const record = enrolledRecord('owner');
    const fake = fakeDevice((claims) =>
      Number(claims.ctr) < REPLAY_COUNTER_JUMP
        ? { ok: false, code: 'replay' }
        : { ok: true, res: {} }
    );
    const outcome = await sendSecureRequest(request, record, {
      fetchFn: lanFetch(fake),
      controllerStore: { dir: storeDir },
      nowFn: () => NOW,
    });
    assert.equal(outcome.kind === 'reply' && outcome.reply.ok, true);
    assert.deepEqual(
      fake.seen.map((c) => c.ctr),
      [1, REPLAY_COUNTER_JUMP + 2]
    );
    assert.notEqual(fake.seen[0].rid, fake.seen[1].rid);
    assert.notEqual(fake.seen[0].rk, fake.seen[1].rk);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir })!.ctr, REPLAY_COUNTER_JUMP + 2);
  });

  test('a second verified replay is not retried again', async () => {
    const record = enrolledRecord('owner');
    const fake = fakeDevice(() => ({ ok: false, code: 'replay' }));
    const result = await sendSecureRequest(request, record, {
      fetchFn: lanFetch(fake),
      controllerStore: { dir: storeDir },
      nowFn: () => NOW,
    });
    assert.equal(result.kind === 'reply' && result.reply.code, 'replay');
    assert.equal(fake.seen.length, 2);
  });

  test('a public replay is never evidence: no counter jump, no retry', async () => {
    const record = enrolledRecord('owner');
    const fake = fakeDevice(() => ({ publicCode: 'replay' }));
    const outcome = await sendSecureRequest(request, record, {
      fetchFn: lanFetch(fake),
      controllerStore: { dir: storeDir },
      nowFn: () => NOW,
    });
    assert.equal(outcome.kind, 'public');
    assert.equal(fake.seen.length, 1);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir })!.ctr, 1);
  });

  test('a replay that persists is reported without advising unpair', async () => {
    enrolledRecord('owner');
    const fake = fakeDevice(() => ({ ok: false, code: 'replay' }));
    const result = await sendPlaylistToDevice(
      { playlist },
      { fetchFn: lanFetch(fake), controllerStore: { dir: storeDir }, nowFn: () => NOW }
    );
    assert.equal(result.success, false);
    assert.match(result.details!, /moved its request counter ahead and tried once more/);
    assert.match(result.details!, /Run the command again/);
    assert.match(result.details!, /Do not unpair/);
  });
});

describe('public refusal bodies', () => {
  test('a public error with a message member is still read by its code', () => {
    for (const code of ['enrollment_required', 'envelope_required']) {
      assert.deepEqual(
        findEnvelopeAnswer({ error: { code, message: 'this FF1 needs signed requests' } }),
        { code }
      );
    }
  });
});

describe('legacy path against a secured FF1', () => {
  test('a plaintext preflight refused with enrollment_required stops with pairing guidance', async () => {
    const casts: string[] = [];
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: async (_input, init) => {
          casts.push(JSON.parse(String(init?.body)).command);
          // §4.4: the plaintext refusal carries a fixed `message` beside `code`.
          return json(403, {
            error: {
              code: 'enrollment_required',
              message: 'this FF1 needs signed requests: update the Feral File app or ff-cli',
            },
          });
        },
        controllerStore: { dir: storeDir },
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error!, /secured/);
    assert.match(result.details!, /ff-cli device pair Office/);
    assert.deepEqual(casts, ['getDeviceStatus']);
  });

  test('a relayer plaintext denial maps to pairing guidance', async () => {
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: async (input) => {
          if (new URL(input.toString()).origin === HOST) {
            throw new Error('fetch failed', { cause: { code: 'EHOSTUNREACH' } });
          }
          // ff1-control-v1 §4.4: the flat shape released clients read as a failure.
          return json(200, {
            message: {
              ok: false,
              error: 'envelope_required',
              command: 'displayPlaylist',
              message: 'this FF1 requires a signed control envelope',
            },
          });
        },
        getTopicIdFn: () => 'topic-secret',
        controllerStore: { dir: storeDir },
        waitFn: async () => undefined,
        noticeFn: () => undefined,
      }
    );
    assert.equal(result.success, false);
    assert.equal(result.transport, 'relayer');
    assert.match(result.details!, /ff-cli device pair Office/);
  });

  test('old firmware keeps the plaintext cast unchanged', async () => {
    const casts: Array<Record<string, unknown>> = [];
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: async (_input, init) => {
          const body = JSON.parse(String(init?.body));
          casts.push(body);
          return json(200, { message: { installedVersion: '1.0.9', ok: true } });
        },
        controllerStore: { dir: storeDir },
      }
    );
    assert.equal(result.success, true, result.error);
    assert.equal(casts[1].command, 'displayPlaylist');
  });
});

describe('secure sshAccess', () => {
  test('is sent as a LAN envelope without the topic header', async () => {
    enrolledRecord('owner');
    const device = fakeDevice();
    const headers: Array<Record<string, string>> = [];
    const result = await sendSshAccessCommand(
      { enabled: true, publicKey: 'ssh-ed25519 AAAA test', ttlSeconds: 60 },
      {
        fetchFn: async (input, init) => {
          headers.push(init?.headers as Record<string, string>);
          const answer = device.handle(JSON.parse(String(init?.body)));
          return json(answer.status, answer.json);
        },
        getTopicIdFn: () => 'topic-secret',
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
      }
    );
    assert.equal(result.success, true, result.error);
    const ssh = device.seen.find((c) => c.cmd === 'sshAccess')!;
    assert.deepEqual(ssh.req, {
      enabled: true,
      publicKey: 'ssh-ed25519 AAAA test',
      ttlSeconds: 60,
    });
    assert.ok(headers.every((h) => !('X-FF1-Topic' in h)));
  });

  test('a controller-role grant gets the owner-grant guidance', async () => {
    enrolledRecord('controller');
    const device = fakeDevice((claims) =>
      claims.cmd === 'sshAccess' ? { ok: false, code: 'permission_denied' } : { ok: true, res: {} }
    );
    const result = await sendSshAccessCommand(
      { enabled: false },
      {
        fetchFn: async (_input, init) => {
          const answer = device.handle(JSON.parse(String(init?.body)));
          return json(answer.status, answer.json);
        },
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
      }
    );
    assert.equal(result.success, false);
    assert.match(result.error!, /owner access/);
    assert.match(result.details!, /owner role/);
  });

  test('ssh shows busy without retrying', async () => {
    enrolledRecord('owner');
    const device = fakeDevice((claims) =>
      claims.cmd === 'sshAccess' ? { publicCode: 'busy', status: 503 } : { ok: true, res: {} }
    );
    const result = await sendSshAccessCommand(
      { enabled: false },
      {
        fetchFn: async (_input, init) => {
          const answer = device.handle(JSON.parse(String(init?.body)));
          return json(answer.status, answer.json);
        },
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
      }
    );
    assert.equal(result.success, false);
    assert.equal(result.error, 'The FF1 is busy; try again.');
    assert.equal(device.seen.filter((c) => c.cmd === 'sshAccess').length, 1);
  });

  test('does not fall back to the relayer', async () => {
    enrolledRecord('owner');
    const urls: string[] = [];
    const result = await sendSshAccessCommand(
      { enabled: false },
      {
        fetchFn: async (input) => {
          urls.push(input.toString());
          throw new Error('fetch failed', { cause: { code: 'EHOSTUNREACH' } });
        },
        getTopicIdFn: () => 'topic-secret',
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
      }
    );
    assert.equal(result.success, false);
    assert.ok(urls.every((u) => u.startsWith(HOST)));
  });
});

// These exercise the existing endpoint fixture through the new carrier; no
// registration contract or crypto is implemented by the transport tests.
describe('secure generic carrier integration', () => {
  type Mode = 'verified' | 'empty-channel' | 'never-admitted' | 'lost-command-reply' | 'no-receipt';

  /**
   * carrierSocket is a relay with a stranger and the FF1 on the device
   * channel. The stranger ACKs everything and answers with a forgery.
   */
  function carrierSocket(device: FakeFF1, mode: Mode, sent: string[]) {
    return class Socket extends EventTarget {
      binaryType = '';
      constructor(url: string, protocol: string) {
        super();
        assert.equal(protocol, 'ff-relay.v2');
        assert.match(url, /\/v2\/channels\//);
        queueMicrotask(() => {
          if (mode === 'never-admitted') {
            this.dispatchEvent(new Event('error'));
            return;
          }
          const peers = mode === 'empty-channel' ? [] : ['stranger', 'ff1'];
          this.message(JSON.stringify({ type: 'hello', connectionId: 'cli', peers }));
        });
      }
      message(data: unknown) {
        this.dispatchEvent(new MessageEvent('message', { data }));
      }
      close() {
        /* No actual network socket. */
      }
      send(data: unknown) {
        if (!(data instanceof Uint8Array)) {
          return;
        }
        const length = new DataView(data.buffer, data.byteOffset).getUint16(0);
        const header = JSON.parse(new TextDecoder().decode(data.slice(2, 2 + length)));
        const body = JSON.parse(new TextDecoder().decode(data.slice(2 + length)));
        sent.push(header.to);
        queueMicrotask(() => this.deliver(header, body));
      }
      deliver(header: { id: string; to: string }, body: { messageID: string; message: unknown }) {
        if (mode === 'empty-channel') {
          this.control({ type: 'error', code: 'peer_unavailable', id: header.id, to: 'peers' });
          return;
        }
        if (mode === 'no-receipt') {
          // Written, but no ACK or refusal before the deadline.
          return;
        }
        this.control({ type: 'ack', from: 'stranger', id: header.id });
        this.control({ type: 'ack', from: 'ff1', id: header.id });
        this.reply('stranger', body.messageID, { v: 1, jwe: 'forged-candidate' });
        const answer = device.handle(body.message as Record<string, unknown>).json;
        if (mode === 'lost-command-reply') {
          this.dispatchEvent(new Event('close'));
          return;
        }
        this.reply('ff1', body.messageID, answer);
      }
      control(event: Record<string, unknown>) {
        this.message(JSON.stringify(event));
      }
      reply(from: string, messageID: string, message: unknown) {
        const frame = encodeRelayFrame(
          { v: 2, id: crypto.randomUUID(), from, to: 'cli' },
          new TextEncoder().encode(JSON.stringify({ type: 'RPC', messageID, message }))
        );
        this.message(frame.buffer);
      }
    };
  }

  async function sendOverCarrier(
    mode: Mode,
    overrides: { v2TimeoutMs?: number } = {},
    route: { v2Explicit?: boolean; relayV2?: boolean } = { v2Explicit: true }
  ) {
    const record = enrolledRecord('owner');
    if (route.relayV2 !== undefined) {
      record.relayV2 = route.relayV2;
      saveController(record, { dir: storeDir });
    }
    const device = fakeDevice();
    const previous = globalThis.WebSocket;
    const sent: string[] = [];
    let legacyCalls = 0;
    globalThis.WebSocket = carrierSocket(device, mode, sent) as unknown as typeof WebSocket;
    try {
      const outcome = await sendSecureRequest(
        {
          device: { id: DEVICE_ID, host: HOST },
          op: 'cmd',
          cmd: 'next',
          req: {},
          retry: false,
          relayerFallback: true,
        },
        record,
        {
          ...overrides,
          controllerStore: { dir: storeDir },
          nowFn: () => NOW,
          getRelayerConfigFn: () => ({
            baseUrl: 'https://legacy.test',
            v2Endpoint: 'wss://v2.test',
            ...(route.v2Explicit ? { v2Explicit: true } : {}),
          }),
          getTopicIdFn: () => 'optional-topic',
          noticeFn: () => undefined,
          fetchFn: async (input, init) => {
            if (new URL(input.toString()).origin === HOST) {
              throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
            }
            legacyCalls++;
            return json(200, { message: device.handle(JSON.parse(String(init?.body))).json });
          },
        }
      );
      return { outcome, device, sent, legacyCalls };
    } finally {
      globalThis.WebSocket = previous;
    }
  }

  test('a verified reply over a fan-out settles the command; no status probe precedes it', async () => {
    const { outcome, device, sent, legacyCalls } = await sendOverCarrier('verified');
    assert.equal(outcome.kind, 'reply');
    assert.equal(legacyCalls, 0);
    assert.deepEqual(sent, ['peers']);
    assert.deepEqual(
      device.seen.map((c) => c.cmd),
      ['next']
    );
  });

  for (const mode of ['empty-channel', 'never-admitted'] as const) {
    test(`proven undelivered (${mode}) falls back to the legacy topic with a fresh request`, async () => {
      const { outcome, device, legacyCalls } = await sendOverCarrier(mode);
      assert.equal(outcome.kind, 'reply');
      assert.equal(outcome.transport, 'relayer');
      assert.equal(legacyCalls, 1);
      assert.deepEqual(
        device.seen.map((c) => c.cmd),
        ['next']
      );
    });
  }

  test('a lost reply after delivery is outcome unknown and never falls back', async () => {
    const { outcome, device, legacyCalls } = await sendOverCarrier('lost-command-reply');
    assert.equal(outcome.kind, 'failed');
    assert.match((outcome as { error: string }).error, /Outcome unknown/);
    assert.equal((outcome as { unreachable?: boolean }).unreachable, undefined);
    assert.equal(legacyCalls, 0, 'ambiguous execution must never fall back');
    assert.equal(device.seen.length, 1);
  });

  test('a deadline while a written frame awaits its receipt is ambiguous, never a fallback', async () => {
    const { outcome, legacyCalls } = await sendOverCarrier('no-receipt', { v2TimeoutMs: 300 });
    assert.equal(outcome.kind, 'failed');
    assert.match((outcome as { error: string }).error, /Outcome unknown/);
    assert.equal(legacyCalls, 0, 'a written frame may have reached the FF1');
  });

  /**
   * sendWithTwoCopies runs one v2 command through a fake relay client that
   * delivers the sealed request to the FF1 twice (a fan-out plus a
   * late-joiner copy): the first copy runs, the second is answered with a
   * verified `replay`. Both replies are verified, strictly one after the
   * other and in the given order, and the request settles with
   * `settleWith`. No timers: the order is fixed on every platform.
   */
  async function sendWithTwoCopies(order: 'ok-first' | 'replay-first', settleWith: 0 | 1) {
    const record = enrolledRecord('owner');
    const device = fakeDevice();
    let legacyCalls = 0;
    const relayClientFn = () => ({
      close: () => undefined,
      requestPrepared: async (
        prepare: () => Promise<{
          command: string;
          request: Record<string, unknown>;
          verify: (value: Record<string, unknown>) => Promise<boolean>;
        }>
      ) => {
        const prepared = await prepare();
        const message = { command: prepared.command, request: prepared.request };
        const ok = device.handle(message).json;
        const replay = device.handle(message).json;
        const replies = (order === 'ok-first' ? [ok, replay] : [replay, ok]).map((answer) => ({
          type: 'RPC',
          messageID: 'm',
          message: answer,
        }));
        for (const reply of replies) {
          assert.equal(await prepared.verify(reply), true);
        }
        return replies[settleWith];
      },
    });
    const outcome = await sendSecureRequest(
      {
        device: { id: DEVICE_ID, host: HOST },
        op: 'cmd',
        cmd: 'next',
        req: {},
        retry: false,
        relayerFallback: true,
      },
      record,
      {
        relayClientFn: relayClientFn as unknown as SecureTransportDeps['relayClientFn'],
        controllerStore: { dir: storeDir },
        nowFn: () => NOW,
        getRelayerConfigFn: () => ({
          baseUrl: 'https://legacy.test',
          v2Endpoint: 'wss://v2.test',
          v2Explicit: true,
        }),
        getTopicIdFn: () => 'optional-topic',
        noticeFn: () => undefined,
        fetchFn: async (input, init) => {
          if (new URL(input.toString()).origin === HOST) {
            throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
          }
          legacyCalls++;
          return json(200, { message: device.handle(JSON.parse(String(init?.body))).json });
        },
      }
    );
    return { outcome, device, legacyCalls };
  }

  test('a verified replay on v2 is an unknown outcome: no counter jump, no resend', async () => {
    const before = loadController(DEVICE_ID, { dir: storeDir })?.ctr ?? 0;
    const { outcome, device, legacyCalls } = await sendWithTwoCopies('replay-first', 0);
    assert.equal(outcome.kind, 'failed');
    assert.match((outcome as { error: string }).error, /Outcome unknown/);
    assert.equal(legacyCalls, 0);
    assert.equal(device.seen.length, 2, 'only the two relay copies, nothing resent');
    const after = loadController(DEVICE_ID, { dir: storeDir })!.ctr;
    assert.ok(after - before < REPLAY_COUNTER_JUMP, 'the counter did not jump');
  });

  test('the reply that settled the request is the answer, not a later one that also verified', async () => {
    // The ok reply settles the request; the replay to the second copy
    // verifies afterwards and must not replace it.
    const { outcome, legacyCalls } = await sendWithTwoCopies('ok-first', 0);
    assert.equal(outcome.kind, 'reply');
    assert.equal((outcome as { reply: { ok: boolean } }).reply.ok, true);
    assert.equal(legacyCalls, 0);
  });

  test('an ambiguous failure on the cached route keeps relayV2 and is not resent', async () => {
    // One blip (a socket drop, the deadline) must not strand a v2-only FF1
    // until the next LAN preflight: the flag stays, only a verified status
    // changes it.
    const { outcome, legacyCalls } = await sendOverCarrier(
      'no-receipt',
      { v2TimeoutMs: 300 },
      { relayV2: true }
    );
    assert.equal(outcome.kind, 'failed');
    assert.match((outcome as { error: string }).error, /Outcome unknown/);
    assert.equal(legacyCalls, 0, 'an ambiguous outcome is never resent on the legacy topic');
    assert.equal(loadController(DEVICE_ID, { dir: storeDir })?.relayV2, true);
  });

  test('a derived endpoint is not used for an FF1 that has not advertised relay v2', async () => {
    for (const relayV2 of [undefined, false]) {
      const { outcome, sent, legacyCalls } = await sendOverCarrier('verified', {}, { relayV2 });
      assert.equal(outcome.kind, 'reply');
      assert.deepEqual(sent, [], 'no v2 attempt');
      assert.equal(legacyCalls, 1);
    }
  });

  test('a derived endpoint is used for an FF1 whose verified status advertised relay v2', async () => {
    const { outcome, sent, legacyCalls } = await sendOverCarrier('verified', {}, { relayV2: true });
    assert.equal(outcome.kind, 'reply');
    assert.deepEqual(sent, ['peers']);
    assert.equal(legacyCalls, 0);
  });

  test('a verified getDeviceStatus records whether the FF1 advertises relay v2', async () => {
    for (const [control, expected] of [
      [{ state: 'secured', transports: ['lan', 'relayer', 'relayV2'] }, true],
      [{ state: 'secured' }, false],
    ] as const) {
      const record = enrolledRecord('owner');
      const device = fakeDevice(() => ({ ok: true, res: { installedVersion: '2.0.0', control } }));
      const outcome = await sendSecureRequest(
        {
          device: { id: DEVICE_ID, host: HOST },
          op: 'cmd',
          cmd: 'getDeviceStatus',
          req: {},
          retry: false,
          relayerFallback: false,
        },
        record,
        { controllerStore: { dir: storeDir }, nowFn: () => NOW, fetchFn: lanFetch(device) }
      );
      assert.equal(outcome.kind, 'reply');
      assert.equal(record.relayV2, expected);
      assert.equal(loadController(DEVICE_ID, { dir: storeDir })?.relayV2, expected);
    }
  });

  test('the v2 deadline bounds a command the FF1 never answers', async () => {
    const started = Date.now();
    const record = enrolledRecord('owner');
    const previous = globalThis.WebSocket;
    globalThis.WebSocket = class extends EventTarget {
      binaryType = '';
      constructor() {
        super();
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ type: 'hello', connectionId: 'cli', peers: ['ff1'] }),
            })
          )
        );
      }
      send(data: unknown) {
        if (!(data instanceof Uint8Array)) {
          return;
        }
        const length = new DataView(data.buffer, data.byteOffset).getUint16(0);
        const header = JSON.parse(new TextDecoder().decode(data.slice(2, 2 + length)));
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ type: 'ack', from: 'ff1', id: header.id }),
            })
          )
        );
      }
      close() {
        /* No actual network socket. */
      }
    } as unknown as typeof WebSocket;
    try {
      const outcome = await sendSecureRequest(
        {
          device: { id: DEVICE_ID, host: HOST },
          op: 'cmd',
          cmd: 'revokeController',
          req: {},
          retry: false,
          relayerFallback: true,
        },
        record,
        {
          v2TimeoutMs: 300,
          controllerStore: { dir: storeDir },
          nowFn: () => NOW,
          getRelayerConfigFn: () => ({
            baseUrl: 'https://legacy.test',
            v2Endpoint: 'wss://v2.test',
          }),
          getTopicIdFn: () => 'optional-topic',
          noticeFn: () => undefined,
          fetchFn: async () => {
            throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } });
          },
        }
      );
      assert.equal(outcome.kind, 'failed');
      assert.ok(Date.now() - started < 2000, 'the default 30 s deadline was used');
    } finally {
      globalThis.WebSocket = previous;
    }
  });
});

describe('replay copy', () => {
  test('a replay that was not retried does not claim a counter jump', async () => {
    const { describeControlCode } = await import('../src/utilities/control/control-errors.js');
    const failure = describeControlCode('replay', 'Office');
    assert.doesNotMatch(failure.details!, /moved its request counter/);
    assert.match(failure.details!, /Run the command again/);
  });
});
