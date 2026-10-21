/**
 * Controller pairing (feral-file#3551 M6): v2 handoff validation, the
 * requestAccess + enroll poll against a fake FF1, key reuse, and the owner
 * command table.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  approvalCode,
  controllerIdOf,
  labelProblem,
  parseProfile,
  stripUnsafeLabelCharacters,
} from '../src/utilities/control/codec';
import { thumbprint } from '../src/utilities/control/jwk';
import {
  createController,
  dropStagedController,
  loadController,
  nextCounter,
  promoteStagedController,
  saveController,
  stagingStore,
} from '../src/utilities/control/controller-store';
import {
  localApprovalCode,
  pollEnrollment,
  prepareController,
  requestAccess,
} from '../src/utilities/control/pairing';
import { parseHandoffPayload } from '../src/utilities/handoff-client';
import {
  CommandFailure,
  REQUEST_ACCESS_RETRY_MS,
  confirmReplacement,
  enrollController,
  formatCode,
  formatControllerTable,
  parseLabel,
  parseTimeoutMs,
  runUnpair,
  storeHandoffTopic,
} from '../src/commands/helpers/device-control';
import { describeControlCode } from '../src/utilities/control/control-errors';
import { markEnrolled } from '../src/utilities/control/controller-store';
import { FakeFF1, thumb, type Jwk } from './helpers/control-device';

const FIXTURES = path.join(__dirname, 'fixtures', 'ff1-control-v1');
const keys = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8'));
const DEVICE_ID = keys.device.dev as string;
const HOST = 'http://ff1-fixture1.local:1111';
const device = { name: 'Office', id: DEVICE_ID, host: HOST };
const profile = parseProfile(keys.device.profile);
const NK = keys.controllers.controller.nk as string;

let storeDir: string;

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff1-pair-'));
});

afterEach(() => {
  fs.rmSync(storeDir, { recursive: true, force: true });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * pairingDevice simulates §5.2/§5.3: requestAccess -> pending with the
 * device-side code; enroll -> pending until `approveAfter` polls, then the grant.
 */
function pairingDevice(approveAfter: number, final: 'grant' | 'not_approved' = 'grant') {
  let enrolls = 0;
  const fake = new FakeFF1(
    { dev: DEVICE_ID, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
    {},
    (claims) => {
      const ctl = String(claims.ctl);
      const enroll = claims.enroll as { sig: Jwk };
      assert.equal(thumb(enroll.sig), ctl);
      if (claims.op === 'requestAccess') {
        return {
          ok: true,
          res: {
            status: 'pending',
            code: approvalCode(ctl, keys.device.pins.sig),
            expiresAt: 1,
          },
        };
      }
      enrolls += 1;
      if (enrolls <= approveAfter) {
        return { ok: false, code: 'pending', res: {} };
      }
      if (final === 'not_approved') {
        return { ok: false, code: 'not_approved' };
      }
      return { ok: true, res: { role: 'controller', nk: NK, profile: keys.device.profile } };
    }
  );
  const fetchFn: typeof fetch = async (_input, init) => {
    const answer = fake.handle(JSON.parse(String(init?.body)));
    return json(answer.status, answer.json);
  };
  return { fake, fetchFn };
}

describe('v2 controller handoff', () => {
  const base = {
    v: 2,
    type: 'ff1_controller_handoff',
    channelId: 'ch_test',
    deviceId: DEVICE_ID,
    profile: keys.device.profile,
    topicId: 'topic-secret',
    sentAt: '2026-10-20T00:00:00Z',
  };

  test('accepts a profile for the selected device', () => {
    const payload = parseHandoffPayload(base, 'ch_test', DEVICE_ID.toLowerCase());
    assert.equal(payload.v, 2);
    assert.deepEqual(payload.v === 2 && payload.profile, profile);
  });

  test('topicId is optional', () => {
    const { topicId: _omit, ...withoutTopic } = base;
    assert.equal(parseHandoffPayload(withoutTopic, 'ch_test', DEVICE_ID).v, 2);
  });

  test('rejects a profile for another device', () => {
    assert.throws(
      () =>
        parseHandoffPayload(
          { ...base, profile: { ...keys.device.profile, dev: 'FF1-OTHER001' } },
          'ch_test',
          DEVICE_ID
        ),
      /does not match/
    );
    assert.throws(
      () => parseHandoffPayload({ ...base, deviceId: 'FF1-OTHER001' }, 'ch_test', DEVICE_ID),
      /does not match/
    );
  });

  test('rejects a profile that carries a private key', () => {
    assert.throws(
      () =>
        parseHandoffPayload(
          { ...base, profile: { ...keys.device.profile, sig: keys.device.sig } },
          'ch_test',
          DEVICE_ID
        ),
      /invalid FF1 profile/
    );
  });

  test('still accepts a v1 topic handoff', () => {
    const payload = parseHandoffPayload(
      { ...base, v: 1, type: 'ff1_topic_handoff', profile: undefined },
      'ch_test',
      DEVICE_ID
    );
    assert.equal(payload.v, 1);
  });
});

describe('pairing', () => {
  test('requestAccess then enroll stores role and nk', async () => {
    const { record } = prepareController(profile, 'test laptop', { dir: storeDir });
    const { fake, fetchFn } = pairingDevice(2);
    const deps = { fetchFn, controllerStore: { dir: storeDir }, waitFn: async () => undefined };

    const access = await requestAccess(device, record, deps);
    assert.equal(access.status, 'pending');
    assert.equal(access.status === 'pending' && access.code, localApprovalCode(record));
    assert.equal(
      localApprovalCode(record),
      approvalCode(controllerIdOf(record.keys), thumbprint(profile.sig))
    );

    const sleeps: number[] = [];
    const result = await pollEnrollment(device, record, deps, {
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      storeOptions: { dir: storeDir },
    });
    assert.equal(result.status, 'enrolled');
    const stored = loadController(DEVICE_ID, { dir: storeDir })!;
    assert.equal(stored.role, 'controller');
    assert.equal(stored.nk, NK);
    assert.deepEqual(sleeps, [2000, 2000]);
    // requestAccess + three enroll polls, each with its own counter.
    assert.deepEqual(
      fake.seen.map((c) => [c.op, c.ctr]),
      [
        ['requestAccess', 1],
        ['enroll', 2],
        ['enroll', 3],
        ['enroll', 4],
      ]
    );
    const enroll = fake.seen[1].enroll as Record<string, unknown>;
    assert.equal(enroll.platform, 'cli');
    assert.equal(enroll.label, 'test laptop');
    assert.equal('inv' in enroll, false);
  });

  test('a denied or expired request stops polling with re-pair guidance', async () => {
    const { record } = prepareController(profile, 'x', { dir: storeDir });
    const { fetchFn } = pairingDevice(1, 'not_approved');
    const result = await pollEnrollment(
      device,
      record,
      { fetchFn, controllerStore: { dir: storeDir } },
      { sleepFn: async () => undefined, storeOptions: { dir: storeDir } }
    );
    assert.equal(result.status, 'failed');
    assert.match(result.status === 'failed' ? result.failure.error : '', /denied or expired/);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir })!.role, undefined);
  });

  test('a long wait re-sends requestAccess before the pending request lapses', async () => {
    const created = prepareController(profile, 'x', { dir: storeDir });
    const { fetchFn } = pairingDevice(1000);
    let now = 0;
    let refreshes = 0;
    const result = await pollEnrollment(
      device,
      created.record,
      { fetchFn, controllerStore: { dir: storeDir } },
      {
        timeoutMs: 600_000,
        intervalMs: 60_000,
        refreshMs: 240_000,
        nowMsFn: () => now,
        sleepFn: async (ms) => {
          now += ms;
        },
        refresh: async () => {
          refreshes += 1;
        },
        storeOptions: { dir: storeDir },
      }
    );
    assert.equal(result.status, 'timeout');
    assert.equal(refreshes, 2); // at 240 s and 480 s
    assert.throws(() => parseTimeoutMs('601'), /between 10 and 600/);
    assert.equal(parseTimeoutMs('600'), 600_000);
  });

  test('times out and stops when cancelled', async () => {
    const { record } = prepareController(profile, 'x', { dir: storeDir });
    const { fetchFn } = pairingDevice(1000);
    let clock = 0;
    const timeout = await pollEnrollment(
      device,
      record,
      { fetchFn, controllerStore: { dir: storeDir } },
      {
        timeoutMs: 5000,
        nowMsFn: () => clock,
        sleepFn: async (ms) => {
          clock += ms;
        },
        storeOptions: { dir: storeDir },
      }
    );
    assert.equal(timeout.status, 'timeout');
    const cancelled = await pollEnrollment(
      device,
      record,
      { fetchFn, controllerStore: { dir: storeDir } },
      { cancelled: () => true, storeOptions: { dir: storeDir } }
    );
    assert.equal(cancelled.status, 'cancelled');
  });

  test('keeps polling while the FF1 is unreachable', async () => {
    const { record } = prepareController(profile, 'x', { dir: storeDir });
    const { fetchFn } = pairingDevice(0);
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('fetch failed', { cause: { code: 'EHOSTUNREACH' } });
      }
      return fetchFn(input, init);
    };
    const result = await pollEnrollment(
      device,
      record,
      { fetchFn: flaky, controllerStore: { dir: storeDir }, getTopicIdFn: () => null },
      { sleepFn: async () => undefined, storeOptions: { dir: storeDir } }
    );
    assert.equal(result.status, 'enrolled');
  });

  test('an FF1 with no secure owner yet is explained', async () => {
    const { record } = prepareController(profile, 'x', { dir: storeDir });
    const fake = new FakeFF1(
      { dev: DEVICE_ID, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
      {},
      () => ({ ok: false, code: 'not_approved' })
    );
    const access = await requestAccess(device, record, {
      fetchFn: async (_i, init) => {
        const a = fake.handle(JSON.parse(String(init?.body)));
        return json(a.status, a.json);
      },
      controllerStore: { dir: storeDir },
    });
    assert.equal(access.status, 'failed');
    assert.match(access.status === 'failed' ? access.failure.details! : '', /Secure this FF1/);
  });

  test('a refused request deletes the controller file this run created, keeping plaintext working', async () => {
    const fake = new FakeFF1(
      { dev: DEVICE_ID, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
      {},
      () => ({ ok: false, code: 'not_approved' })
    );
    const deps = {
      fetchFn: (async (_i, init) => {
        const a = fake.handle(JSON.parse(String(init?.body)));
        return json(a.status, a.json);
      }) as typeof fetch,
      controllerStore: { dir: storeDir },
    };
    const created = prepareController(profile, 'x', { dir: storeDir });
    await assert.rejects(
      enrollController(device, created.record, 10_000, true, deps),
      /no owner under secure control/
    );
    assert.equal(loadController(DEVICE_ID, { dir: storeDir }), null);

    const reused = prepareController(profile, 'x', { dir: storeDir });
    await assert.rejects(enrollController(device, reused.record, 10_000, false, deps));
    assert.ok(loadController(DEVICE_ID, { dir: storeDir }), 'an earlier pairing is kept');
  });

  test('a lower-case configured device ID finds the upper-case controller file', () => {
    prepareController(profile, 'x', { dir: storeDir });
    const lower = DEVICE_ID.toLowerCase();
    assert.ok(loadController(lower, { dir: storeDir }));
    assert.equal(nextCounter(lower, { dir: storeDir }).ctr, 1);
  });

  test('re-pairing the same identity reuses keys and counter; a new gen is staged beside it', () => {
    const first = prepareController(profile, 'a', { dir: storeDir });
    nextCounter(DEVICE_ID, { dir: storeDir });
    const again = prepareController(profile, 'b', { dir: storeDir });
    assert.equal(again.reused, true);
    assert.equal(controllerIdOf(again.record.keys), controllerIdOf(first.record.keys));
    assert.equal(again.record.ctr, 1);
    assert.equal(again.record.label, 'b');

    const reset = parseProfile({ ...keys.device.profile, gen: 'AAAAAAAAAAAAAAAAAAAAAA' });
    const fresh = prepareController(reset, 'b', { dir: storeDir });
    assert.equal(fresh.reused, false);
    assert.equal(fresh.staged, true);
    assert.notEqual(controllerIdOf(fresh.record.keys), controllerIdOf(first.record.keys));
    assert.equal(fresh.record.ctr, 0);
    // The existing record is untouched until the new pairing is enrolled.
    const kept = loadController(DEVICE_ID, { dir: storeDir })!;
    assert.equal(controllerIdOf(kept.keys), controllerIdOf(first.record.keys));
    const staged = loadController(DEVICE_ID, stagingStore({ dir: storeDir }))!;
    assert.equal(controllerIdOf(staged.keys), controllerIdOf(fresh.record.keys));
  });

  test('a failed replacement pairing keeps the enrolled record; success replaces it', async () => {
    const store = { dir: storeDir };
    const old = parseProfile({ ...keys.device.profile, gen: 'AAAAAAAAAAAAAAAAAAAAAA' });
    const first = createController({ profile: old, label: 'old' }, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);

    const refused = prepareController(profile, 'x', store);
    assert.equal(refused.staged, true);
    const refusing = fakeFetch(() => ({ ok: false, code: 'not_approved' }));
    await assert.rejects(
      enrollController(
        device,
        refused.record,
        10_000,
        true,
        { fetchFn: refusing, controllerStore: store },
        true
      ),
      /no owner under secure control/
    );
    const kept = loadController(DEVICE_ID, store)!;
    assert.equal(controllerIdOf(kept.keys), controllerIdOf(first.keys));
    assert.equal(kept.role, 'owner');
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);

    const replacing = prepareController(profile, 'x', store);
    const { fetchFn } = pairingDevice(0);
    await enrollController(
      device,
      replacing.record,
      10_000,
      true,
      { fetchFn, controllerStore: store, waitFn: async () => undefined },
      true
    );
    const now = loadController(DEVICE_ID, store)!;
    assert.equal(controllerIdOf(now.keys), controllerIdOf(replacing.record.keys));
    assert.equal(now.role, 'controller');
    assert.equal(now.profile.gen, profile.gen);
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
  });

  test('a promotion that stopped before removing the staged file is finished without rolling back ctr', () => {
    const store = { dir: storeDir };
    const old = parseProfile({ ...keys.device.profile, gen: 'AAAAAAAAAAAAAAAAAAAAAA' });
    createController({ profile: old, label: 'old' }, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    const next = prepareController(profile, 'x', store);
    assert.equal(next.staged, true);
    const enrolled = markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, stagingStore(store));
    // Crash window: main rewritten, staged not yet removed; main then sends.
    saveController(enrolled, store);
    nextCounter(DEVICE_ID, store);
    nextCounter(DEVICE_ID, store);

    const promoted = promoteStagedController(DEVICE_ID, store);
    assert.equal(promoted.ctr, 2);
    assert.equal(loadController(DEVICE_ID, store)!.ctr, 2);
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);

    // The --resume path drops such a file instead of resuming with it.
    saveController(enrolled, stagingStore(store));
    assert.equal(dropStagedController(DEVICE_ID, true, store), true);
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
    assert.equal(loadController(DEVICE_ID, store)!.ctr, 2);
  });

  test('a staged pairing for another identity is kept for --resume until a same-identity pairing supersedes it', () => {
    const store = { dir: storeDir };
    const first = prepareController(profile, 'a', store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    const reset = parseProfile({ ...keys.device.profile, gen: 'AAAAAAAAAAAAAAAAAAAAAA' });
    prepareController(reset, 'b', store);
    // An abandoned replacement is still the pairing --resume continues.
    assert.equal(dropStagedController(DEVICE_ID, true, store), false);
    assert.ok(loadController(DEVICE_ID, stagingStore(store)));

    const again = prepareController(profile, 'a', store);
    assert.equal(again.reused, true);
    assert.equal(controllerIdOf(again.record.keys), controllerIdOf(first.record.keys));
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
  });

  test('replacing an enrolled record for another identity asks first', async () => {
    const store = { dir: storeDir };
    const old = parseProfile({ ...keys.device.profile, gen: 'AAAAAAAAAAAAAAAAAAAAAA' });
    createController({ profile: old, label: 'old' }, store);
    const never = async () => {
      throw new Error('must not ask');
    };
    // Pending (not enrolled): nothing to lose, no question.
    await confirmReplacement(device, profile, {}, never, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    // Same identity: no question.
    await confirmReplacement(device, old, {}, never, store);
    await confirmReplacement(device, profile, { yes: true }, never, store);
    const asked: string[] = [];
    await assert.rejects(
      confirmReplacement(
        device,
        profile,
        {},
        async (q) => {
          asked.push(q);
          return false;
        },
        store
      ),
      /current pairing was kept/
    );
    assert.equal(asked.length, 1);
    await confirmReplacement(device, profile, {}, async () => true, store);
  });

  test('a corrupt controller file is replaced by a fresh pairing', () => {
    createController({ profile, label: 'x' }, { dir: storeDir });
    fs.writeFileSync(path.join(storeDir, `${DEVICE_ID}.json`), '{"v":1,"v":1}');
    const result = prepareController(profile, 'x', { dir: storeDir });
    assert.equal(result.reused, false);
    assert.ok(loadController(DEVICE_ID, { dir: storeDir }));
  });
});

describe('controllers table', () => {
  test('renders listControllers rows, self marker, status and pending codes', () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, 'positive', 'cmd-owner-listControllers.json'), 'utf8')
    );
    const res = {
      ...fixture.reply.claims.res,
      pending: [
        {
          ctl: keys.controllers.stranger.ctl,
          label: 'Stranger',
          platform: 'other',
          code: '359263',
          expiresAt: 1767225900,
        },
      ],
    };
    const lines = formatControllerTable(res, keys.now);
    const text = lines.join('\n');
    assert.match(lines[0], /ROLE\s+LABEL\s+PLATFORM/);
    assert.match(text, /\*\s+owner\s+Owner phone/);
    assert.match(text, /revoked 2025-12-31 23:50/);
    assert.match(text, /359 263/);
    assert.ok(text.includes(keys.controllers.owner.ctl));
  });
});

/** fakeFetch routes casts to a FakeFF1 with a custom decision. */
function fakeFetch(decide: ConstructorParameters<typeof FakeFF1>[2], before?: () => void) {
  const fake = new FakeFF1(
    { dev: DEVICE_ID, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
    {},
    decide
  );
  const fetchFn: typeof fetch = async (_i, init) => {
    before?.();
    const a = fake.handle(JSON.parse(String(init?.body)));
    return json(a.status, a.json);
  };
  return fetchFn;
}

describe('pairing robustness', () => {
  test('an unavailable keyring warns and lets pairing continue', () => {
    const warnings: string[] = [];
    const stored = storeHandoffTopic(
      DEVICE_ID,
      'topic-secret',
      () => {
        throw new Error('no secret service');
      },
      (m) => warnings.push(m)
    );
    assert.equal(stored, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /relayer fallback/);
    assert.ok(!warnings[0].includes('topic-secret'));
  });

  test('an approval-code mismatch deletes the pending file this run created', async () => {
    const created = prepareController(profile, 'x', { dir: storeDir });
    const fetchFn = fakeFetch(() => ({
      ok: true,
      res: { status: 'pending', code: '000000', expiresAt: 1 },
    }));
    await assert.rejects(
      enrollController(device, created.record, 10_000, true, {
        fetchFn,
        controllerStore: { dir: storeDir },
      }),
      /different approval code/
    );
    assert.equal(loadController(DEVICE_ID, { dir: storeDir }), null);
  });

  test('Ctrl-C while requestAccess is in flight deletes the pending file', async () => {
    const created = prepareController(profile, 'x', { dir: storeDir });
    const fetchFn = fakeFetch(
      (claims) => ({
        ok: true,
        res: {
          status: 'pending',
          code: approvalCode(String(claims.ctl), keys.device.pins.sig),
          expiresAt: 1,
        },
      }),
      () => {
        process.emit('SIGINT');
      }
    );
    const previous = process.exitCode;
    try {
      await enrollController(device, created.record, 10_000, true, {
        fetchFn,
        controllerStore: { dir: storeDir },
      });
      assert.equal(process.exitCode, 130);
    } finally {
      process.exitCode = previous;
    }
    assert.equal(loadController(DEVICE_ID, { dir: storeDir }), null);
  });

  test('rate_limited or busy on requestAccess asks again and keeps the file', async () => {
    const created = prepareController(profile, 'x', { dir: storeDir });
    let requests = 0;
    const fetchFn = fakeFetch((claims) => {
      if (claims.op === 'requestAccess') {
        requests += 1;
        if (requests === 1) {
          return { ok: false, code: 'rate_limited' };
        }
        if (requests === 2) {
          return { publicCode: 'busy', status: 503 };
        }
        return {
          ok: true,
          res: {
            status: 'pending',
            code: approvalCode(String(claims.ctl), keys.device.pins.sig),
            expiresAt: 1,
          },
        };
      }
      return { ok: true, res: { role: 'controller', nk: NK, profile: keys.device.profile } };
    });
    const waits: number[] = [];
    await enrollController(device, created.record, 60_000, true, {
      fetchFn,
      controllerStore: { dir: storeDir },
      waitFn: async (ms) => {
        waits.push(ms);
      },
    });
    assert.deepEqual(waits, [REQUEST_ACCESS_RETRY_MS, REQUEST_ACCESS_RETRY_MS]);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir })!.role, 'controller');
  });

  test('rate_limited until the wait is used up fails and deletes the file this run created', async () => {
    const created = prepareController(profile, 'x', { dir: storeDir });
    const fetchFn = fakeFetch(() => ({ ok: false, code: 'rate_limited' }));
    const waits: number[] = [];
    await assert.rejects(
      enrollController(device, created.record, 20_000, true, {
        fetchFn,
        controllerStore: { dir: storeDir },
        waitFn: async (ms) => {
          waits.push(ms);
        },
      }),
      /rate-limiting/
    );
    assert.equal(waits.length, 2);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir }), null);
  });

  test('Ctrl-C during the retry wait exits 130 without asking again', async () => {
    const created = prepareController(profile, 'x', { dir: storeDir });
    let requests = 0;
    const fetchFn = fakeFetch(() => {
      requests += 1;
      return { ok: false, code: 'rate_limited' };
    });
    const previous = process.exitCode;
    try {
      await enrollController(device, created.record, 60_000, true, {
        fetchFn,
        controllerStore: { dir: storeDir },
        waitFn: async () => {
          process.emit('SIGINT');
        },
      });
      assert.equal(process.exitCode, 130);
    } finally {
      process.exitCode = previous;
    }
    assert.equal(requests, 1);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir }), null);
  });

  test('approved for a key without a local grant still shows the approval code', async () => {
    const created = prepareController(profile, 'x', { dir: storeDir });
    const fetchFn = fakeFetch((claims) =>
      claims.op === 'requestAccess'
        ? { ok: true, res: { status: 'approved', role: 'controller' } }
        : { ok: true, res: { role: 'controller', nk: NK, profile: keys.device.profile } }
    );
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };
    try {
      await enrollController(device, created.record, 10_000, true, {
        fetchFn,
        controllerStore: { dir: storeDir },
      });
    } finally {
      console.log = log;
    }
    const code = formatCode(localApprovalCode(created.record));
    assert.ok(
      lines.some((l) => l.includes(code)),
      'approval code printed'
    );
  });

  test('public bad_envelope / bad_signature advice is conditional', () => {
    for (const code of ['bad_envelope', 'bad_signature']) {
      const failure = describeControlCode(code, 'Office');
      assert.match(failure.details!, /^If this FF1 was factory reset/);
    }
  });
});

describe('unpair', () => {
  const originalCwd = process.cwd();
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ff1-unpair-'));
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ ff1Devices: { devices: [device] } })
    );
    process.chdir(home);
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
    prepareController(profile, 'x');
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('owner keys are kept when the confirmation is declined', async () => {
    const asked: string[] = [];
    await assert.rejects(
      runUnpair('Office', {}, async (q) => {
        asked.push(q);
        return false;
      }),
      /nothing was deleted/
    );
    assert.equal(asked.length, 1);
    assert.ok(loadController(DEVICE_ID));
  });

  test('--yes deletes owner keys without asking', async () => {
    await runUnpair('Office', { yes: true }, async () => {
      throw new Error('must not ask');
    });
    assert.equal(loadController(DEVICE_ID), null);
  });
});

describe('controller labels', () => {
  test('rejects control, bidi and invisible format characters', () => {
    for (const bad of [
      'a\u0007b',
      'a\u0085b',
      'evil\u202Etxt',
      'zero\u200Bwidth',
      'a\u2066b',
      'a\uFEFFb',
      'a\u00ADb',
      'line\u2028sep',
    ]) {
      assert.ok(labelProblem(bad), JSON.stringify(bad));
      assert.throws(
        () => parseLabel(bad),
        (e: unknown) =>
          e instanceof CommandFailure && /invisible formatting/.test((e as Error).message)
      );
    }
  });

  test('accepts ordinary text, including non-ASCII and emoji', () => {
    for (const ok of ['Studio Mac', 'Brandon’s 筆電', 'gallery 🎨']) {
      assert.equal(labelProblem(ok), undefined);
      assert.equal(parseLabel(ok), ok);
    }
    assert.throws(() => parseLabel('x'.repeat(65)), /1-64/);
  });

  test('the hostname-derived default drops unsafe characters', () => {
    assert.equal(stripUnsafeLabelCharacters('my\u200Bhost\u202E'), 'myhost');
  });

  test('requestAccess invalid_request explains the label', async () => {
    const { record } = prepareController(profile, 'x', { dir: storeDir });
    const access = await requestAccess(device, record, {
      fetchFn: fakeFetch(() => ({ ok: false, code: 'invalid_request' })),
      controllerStore: { dir: storeDir },
    });
    assert.equal(access.status, 'failed');
    assert.match(access.status === 'failed' ? access.failure.details! : '', /--label/);
  });

  test('a busy answer keeps the enroll poll going', async () => {
    const { record } = prepareController(profile, 'x', { dir: storeDir });
    let polls = 0;
    const fetchFn = fakeFetch(() => {
      polls += 1;
      return polls === 1
        ? { publicCode: 'busy', status: 503 }
        : { ok: true, res: { role: 'controller', nk: NK, profile: keys.device.profile } };
    });
    const result = await pollEnrollment(
      device,
      record,
      { fetchFn, controllerStore: { dir: storeDir } },
      { sleepFn: async () => undefined, storeOptions: { dir: storeDir } }
    );
    assert.equal(result.status, 'enrolled');
  });
});
