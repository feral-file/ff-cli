/**
 * Controller pairing (feral-file#3551): owner-initiated registration (§5.6)
 * end to end against an in-memory pairing channel and a fake FF1, key reuse
 * and staging, --resume, unpair's self-revoke, and the owner command table.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  controllerIdOf,
  labelProblem,
  parseProfile,
  stripUnsafeLabelCharacters,
} from '../src/utilities/control/codec';
import {
  createController,
  dropStagedController,
  loadController,
  markEnrolled,
  nextCounter,
  parseControllerRecord,
  promoteStagedController,
  saveController,
  stagingStore,
} from '../src/utilities/control/controller-store';
import {
  chooseControllerKeys,
  prepareRegisteredController,
} from '../src/utilities/control/pairing';
import {
  type PairingChannel,
  type PairingChannelOpener,
  setPairingChannelOpener,
} from '../src/utilities/control/pairing-channel';
import {
  type ControllerQr,
  controllerQrCtl,
  generatePairingMaterial,
  parseControllerQr,
  sealRegistration,
} from '../src/utilities/control/registration';
import {
  CommandFailure,
  type PairDeps,
  confirmCorruptReplacement,
  confirmReplacement,
  formatControllerTable,
  pairDevice,
  parseLabel,
  parseTimeoutMs,
  runPair,
  runUnpair,
  storeRelayerTopic,
} from '../src/commands/helpers/device-control';
import {
  describeControlCode,
  unverifiedReplyFailure,
} from '../src/utilities/control/control-errors';
import { FakeFF1, thumb, type Jwk } from './helpers/control-device';

const FIXTURES = path.join(__dirname, 'fixtures', 'ff1-control-v1');
const keys = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8'));
const NOW = keys.now as number;
const DEVICE_ID = keys.device.dev as string;
const HOST = 'http://ff1-fixture1.local:1111';
const device = { name: 'Office', id: DEVICE_ID, host: HOST };
const profile = parseProfile(keys.device.profile);
const resetProfile = parseProfile({ ...keys.device.profile, gen: 'AAAAAAAAAAAAAAAAAAAAAA' });
const NK = keys.controllers.controller.nk as string;
const REGISTRATION = {
  channelId: '7b0d6e4a-2f51-4c8e-9a43-a48fcc56c5d9',
  deviceName: 'Office FF1',
  role: 'controller' as const,
  receivedAt: NOW,
};

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

/** FakeChannel is an in-memory pairing channel the test writes into. */
class FakeChannel implements PairingChannel {
  closed = false;
  private readonly queue: Uint8Array[] = [];
  private ended = false;
  private wake: (() => void) | null = null;

  constructor(readonly channelId: string) {}

  push(message: string | Uint8Array): void {
    this.queue.push(typeof message === 'string' ? Buffer.from(message, 'utf8') : message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *messages(): AsyncIterable<Uint8Array> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  async send(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    this.end();
  }
}

/** resultJson is the owner app's §5.6.2 plaintext for a scanned QR. */
function resultJson(qr: ControllerQr, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    type: 'ff1_controller_registration',
    channelId: qr.channelId,
    ps: qr.ps,
    ctl: controllerQrCtl(qr),
    outcome: 'approved',
    profile: keys.device.profile,
    deviceName: 'Office FF1',
    role: 'controller',
    ...extra,
  });
}

/**
 * ownerWorld wires an owner scanning the QR (onScan sends on the channel), a
 * fake FF1 that grants enroll to every ctl the owner registered, and a topic
 * store; everything a pairing run touches stays in memory or in storeDir.
 */
function ownerWorld(
  onScan: (qr: ControllerQr, channel: FakeChannel, registered: Set<string>) => void,
  enrollRes: Record<string, unknown> = {}
) {
  const registered = new Set<string>();
  const topics: Array<[string, string]> = [];
  const channels: FakeChannel[] = [];
  const fake = new FakeFF1(
    { dev: DEVICE_ID, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
    {},
    (claims) => {
      assert.equal(claims.op, 'enroll');
      const enroll = claims.enroll as { sig: Jwk; inv?: string };
      assert.equal(enroll.inv, undefined, 'owner-initiated pairing never sends inv');
      assert.equal(thumb(enroll.sig), claims.ctl);
      if (!registered.has(String(claims.ctl))) {
        return { ok: false, code: 'not_approved' };
      }
      return {
        ok: true,
        res: { role: 'controller', nk: NK, profile: keys.device.profile, ...enrollRes },
      };
    }
  );
  const openChannel: PairingChannelOpener = async (channelId) => {
    const channel = new FakeChannel(channelId);
    channels.push(channel);
    return channel;
  };
  const deps: PairDeps = {
    openChannel,
    showQr: (payload) => onScan(parseControllerQr(payload), channels.at(-1)!, registered),
    storeTopicFn: (id, topic) => topics.push([id, topic]),
    confirmFn: async () => {
      throw new Error('must not ask');
    },
    fetchFn: async (_input, init) => {
      const answer = fake.handle(JSON.parse(String(init?.body)));
      return json(answer.status, answer.json);
    },
    getTopicIdFn: () => null,
    controllerStore: { dir: storeDir },
    nowFn: () => NOW,
    waitFn: async () => undefined,
    enrollRetryMs: 0,
  };
  return { deps, fake, registered, topics, channels };
}

/** approve is the owner's app: register the QR's keys, then send the sealed result. */
function approve(extra: Record<string, unknown> = {}) {
  return (qr: ControllerQr, channel: FakeChannel, registered: Set<string>) => {
    registered.add(controllerQrCtl(qr));
    channel.push(sealRegistration(qr, resultJson(qr, extra)));
  };
}

const options = { label: 'studio-mac', timeoutMs: 5_000 };

describe('device pair (owner-initiated registration)', () => {
  test('a verified result is pinned, enrolled with its keys, and its topic stored', async () => {
    const world = ownerWorld(approve({ expiresAt: NOW + 3600, topicId: 'topic-secret' }), {
      expiresAt: NOW + 3600,
    });
    await pairDevice(device, options, world.deps);

    const record = loadController(DEVICE_ID, { dir: storeDir })!;
    assert.equal(record.role, 'controller');
    assert.equal(record.nk, NK);
    assert.equal(record.expiresAt, NOW + 3600);
    assert.equal(record.label, 'studio-mac');
    assert.deepEqual(record.profile, profile);
    assert.deepEqual(world.topics, [[DEVICE_ID, 'topic-secret']]);
    assert.equal(world.channels.length, 1);
    assert.equal(world.channels[0].closed, true);
    assert.deepEqual(record.registration, {
      channelId: world.channels[0].channelId,
      deviceName: 'Office FF1',
      role: 'controller',
      expiresAt: NOW + 3600,
      receivedAt: NOW,
    });
    // One enroll, signed by the keys the owner registered.
    assert.deepEqual(
      world.fake.seen.map((c) => [c.op, c.ctl]),
      [['enroll', controllerIdOf(record.keys)]]
    );
    assert.equal(loadController(DEVICE_ID, stagingStore({ dir: storeDir })), null);
  });

  test('a declined request fails and saves nothing', async () => {
    const world = ownerWorld((qr, channel) =>
      channel.push(
        sealRegistration(
          qr,
          JSON.stringify({
            v: 1,
            type: 'ff1_controller_registration',
            channelId: qr.channelId,
            ps: qr.ps,
            ctl: controllerQrCtl(qr),
            outcome: 'rejected',
          })
        )
      )
    );
    await assert.rejects(pairDevice(device, options, world.deps), /declined/);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir }), null);
    assert.equal(world.fake.seen.length, 0);
    assert.equal(world.channels[0].closed, true);
  });

  test('no answer before the timeout is "not completed", never "rejected"', async () => {
    const world = ownerWorld(() => undefined);
    await assert.rejects(
      pairDevice(device, { ...options, timeoutMs: 50 }, world.deps),
      (error: unknown) =>
        error instanceof CommandFailure &&
        /not completed/.test(error.message) &&
        !/reject|declin/i.test(error.message) &&
        /ff-cli device pair Office/.test(error.details!)
    );
    assert.equal(loadController(DEVICE_ID, { dir: storeDir }), null);
    assert.equal(world.channels[0].closed, true);
  });

  test('garbage and forged messages are ignored; the genuine result is accepted', async () => {
    const world = ownerWorld((qr, channel, registered) => {
      channel.push('not json');
      channel.push('{"v":1,"type":"ff1_controller_registration_sealed"}');
      // Sealed to another QR's minter key: does not decrypt here.
      const other = generatePairingMaterial(
        {
          sig: keys.controllers.stranger.sig,
          enc: keys.controllers.stranger.enc,
        },
        'x'
      );
      channel.push(sealRegistration({ ...other.qr, channelId: qr.channelId }, resultJson(qr)));
      // Right keys, wrong pairing secret.
      channel.push(sealRegistration(qr, resultJson(qr, { ps: 'AAAAAAAAAAAAAAAAAAAAAA' })));
      approve()(qr, channel, registered);
    });
    await pairDevice(device, options, world.deps);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir })!.role, 'controller');
  });

  test('a result for another FF1 is not accepted, and the wait times out', async () => {
    const other = { ...keys.device.profile, dev: 'FF1-OTHER0001' };
    const world = ownerWorld(approve({ profile: other }));
    await assert.rejects(
      pairDevice(device, { ...options, timeoutMs: 100 }, world.deps),
      /not completed/
    );
    assert.equal(loadController(DEVICE_ID, { dir: storeDir }), null);
    assert.equal(loadController('FF1-OTHER0001', { dir: storeDir }), null);
    assert.equal(world.fake.seen.length, 0);
  });

  test('a channel that closes before an answer fails without saving', async () => {
    const world = ownerWorld((_qr, channel) => channel.end());
    await assert.rejects(pairDevice(device, options, world.deps), /closed before an owner/);
    assert.equal(loadController(DEVICE_ID, { dir: storeDir }), null);
  });

  test('without the relay adapter, pairing says it is not available in this build', async () => {
    setPairingChannelOpener(undefined);
    const world = ownerWorld(approve());
    await assert.rejects(
      pairDevice(device, options, { ...world.deps, openChannel: undefined }),
      /not available in this build.*relay v2 pairing channel/
    );
  });

  test('an installed opener is used when none is injected', async () => {
    const world = ownerWorld(approve());
    const opened: string[] = [];
    setPairingChannelOpener(async (channelId, signal) => {
      opened.push(channelId);
      return world.deps.openChannel!(channelId, signal);
    });
    try {
      await pairDevice(device, options, { ...world.deps, openChannel: undefined });
    } finally {
      setPairingChannelOpener(undefined);
    }
    assert.equal(opened.length, 1);
    assert.ok(loadController(DEVICE_ID, { dir: storeDir })!.role);
  });

  test('--resume finishes enrollment from the stored result without a channel', async () => {
    const world = ownerWorld(approve());
    const offline: PairDeps = {
      ...world.deps,
      fetchFn: async () => {
        throw new Error('fetch failed');
      },
    };
    await assert.rejects(
      pairDevice(device, options, offline),
      (error: unknown) => error instanceof CommandFailure && /--resume/.test(error.details ?? '')
    );
    const pending = loadController(DEVICE_ID, { dir: storeDir })!;
    assert.equal(pending.role, undefined);
    assert.ok(pending.registration);

    let opened = 0;
    await pairDevice(
      device,
      { ...options, resume: true },
      {
        ...world.deps,
        openChannel: async () => {
          opened += 1;
          throw new Error('no channel on resume');
        },
      }
    );
    assert.equal(opened, 0);
    const record = loadController(DEVICE_ID, { dir: storeDir })!;
    assert.equal(record.role, 'controller');
    assert.equal(controllerIdOf(record.keys), controllerIdOf(pending.keys));
  });

  test('re-pairing the same FF1 shows and keeps this computer’s existing keys and counter', async () => {
    const store = { dir: storeDir };
    const first = createController({ profile, label: 'old' }, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    nextCounter(DEVICE_ID, store);
    let shown = '';
    const world = ownerWorld((qr, channel, registered) => {
      shown = controllerQrCtl(qr);
      approve()(qr, channel, registered);
    });
    await pairDevice(device, options, world.deps);
    assert.equal(shown, controllerIdOf(first.keys));
    const record = loadController(DEVICE_ID, store)!;
    assert.equal(controllerIdOf(record.keys), controllerIdOf(first.keys));
    assert.equal(record.role, 'controller'); // the enroll reply is authoritative
    assert.equal(record.ctr, 2);
    assert.equal(record.label, 'studio-mac');
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
  });

  test('after a factory reset the same keys are staged and replace the old pairing once enrolled', async () => {
    const store = { dir: storeDir };
    const first = createController({ profile: resetProfile, label: 'old' }, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    const asked: string[] = [];
    const world = ownerWorld(approve());
    await pairDevice(device, options, {
      ...world.deps,
      confirmFn: async (q) => {
        asked.push(q);
        return true;
      },
    });
    assert.deepEqual(asked, ['Replace the current pairing?']);
    const record = loadController(DEVICE_ID, store)!;
    assert.equal(controllerIdOf(record.keys), controllerIdOf(first.keys));
    assert.equal(record.profile.gen, profile.gen);
    assert.equal(record.role, 'controller');
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
  });

  test('declining the replacement keeps the current pairing and stages nothing', async () => {
    const store = { dir: storeDir };
    createController({ profile: resetProfile, label: 'old' }, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    const world = ownerWorld(approve());
    await assert.rejects(
      pairDevice(device, options, { ...world.deps, confirmFn: async () => false }),
      /current pairing was kept/
    );
    const kept = loadController(DEVICE_ID, store)!;
    assert.equal(kept.profile.gen, resetProfile.gen);
    assert.equal(kept.role, 'owner');
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
    assert.equal(world.fake.seen.length, 0);
  });

  test('pair refuses to start over an approved but unfinished replacement', async () => {
    const store = { dir: storeDir };
    createController({ profile: resetProfile, label: 'old' }, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    const staged = createController({ profile, label: 'new' }, stagingStore(store));
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, stagingStore(store));
    const world = ownerWorld(approve());
    world.registered.add(controllerIdOf(staged.keys));
    await assert.rejects(pairDevice(device, options, world.deps), /approved but not finished/);
    assert.equal(world.channels.length, 0);
    // --resume promotes it.
    await pairDevice(device, { ...options, resume: true }, world.deps);
    assert.equal(loadController(DEVICE_ID, store)!.profile.gen, profile.gen);
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
  });

  test('a refused enroll after a result names the cause and keeps the file', async () => {
    const world = ownerWorld((qr, channel) => {
      // The app sends approved without the FF1 holding a grant.
      channel.push(sealRegistration(qr, resultJson(qr)));
    });
    await assert.rejects(
      pairDevice(device, options, world.deps),
      (error: unknown) =>
        error instanceof CommandFailure &&
        /no grant for ff-cli/.test(error.message) &&
        /ff-cli device pair Office/.test(error.details!)
    );
    assert.ok(loadController(DEVICE_ID, { dir: storeDir })!.registration);
  });

  test('flag validation', () => {
    assert.equal(parseTimeoutMs(undefined), 300_000);
    assert.equal(parseTimeoutMs('10'), 10_000);
    assert.equal(parseTimeoutMs('600'), 600_000);
    for (const bad of ['9', '601', '1.5', 'x']) {
      assert.throws(() => parseTimeoutMs(bad), CommandFailure);
    }
  });
});

describe('controller store for owner-initiated pairing', () => {
  test('a controller file without the new members still loads; bad ones are refused', () => {
    const store = { dir: storeDir };
    createController({ profile, label: 'x' }, store);
    const file = path.join(storeDir, `${DEVICE_ID}.json`);
    const old = fs.readFileSync(file, 'utf8');
    assert.equal(parseControllerRecord(old).registration, undefined);

    createController({ profile, label: 'x', registration: REGISTRATION }, store);
    markEnrolled(DEVICE_ID, { role: 'controller', nk: NK, expiresAt: NOW + 60 }, store);
    const text = fs.readFileSync(file, 'utf8');
    const record = parseControllerRecord(text);
    assert.deepEqual(record.registration, REGISTRATION);
    assert.equal(record.expiresAt, NOW + 60);

    const obj = JSON.parse(text);
    for (const bad of [
      { ...obj, registration: { ...obj.registration, role: 'admin' } },
      { ...obj, registration: { ...obj.registration, extra: 1 } },
      { ...obj, expiresAt: 'soon' },
    ]) {
      assert.throws(() => parseControllerRecord(JSON.stringify(bad)));
    }
    // A later enroll without expiresAt clears the expiry.
    markEnrolled(DEVICE_ID, { role: 'controller', nk: NK }, store);
    assert.equal(loadController(DEVICE_ID, store)!.expiresAt, undefined);
  });

  test('a lower-case configured device ID finds the upper-case controller file', () => {
    createController({ profile, label: 'x' }, { dir: storeDir });
    const lower = DEVICE_ID.toLowerCase();
    assert.ok(loadController(lower, { dir: storeDir }));
    assert.equal(nextCounter(lower, { dir: storeDir }).ctr, 1);
  });

  test('a new identity is staged beside an existing record and replaces it only when promoted', () => {
    const store = { dir: storeDir };
    createController({ profile: resetProfile, label: 'a' }, store);
    const keysB = chooseControllerKeys(DEVICE_ID, store);
    assert.equal(keysB.reused, true);
    const staged = prepareRegisteredController(
      { profile, keys: keysB.keys, label: 'b', registration: REGISTRATION },
      store
    );
    assert.equal(staged.staged, true);
    assert.equal(loadController(DEVICE_ID, store)!.profile.gen, resetProfile.gen);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, stagingStore(store));
    // Same keys, other identity: the promotion must still replace the record.
    const promoted = promoteStagedController(DEVICE_ID, store);
    assert.equal(promoted.profile.gen, profile.gen);
    assert.equal(loadController(DEVICE_ID, store)!.profile.gen, profile.gen);
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
  });

  test('a promotion that stopped before removing the staged file is finished without rolling back ctr', () => {
    const store = { dir: storeDir };
    createController({ profile: resetProfile, label: 'old' }, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    createController({ profile, label: 'x' }, stagingStore(store));
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

  test('a same-identity result supersedes an abandoned staged pairing', () => {
    const store = { dir: storeDir };
    const first = createController({ profile, label: 'a' }, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    createController({ profile: resetProfile, label: 'b' }, stagingStore(store));
    assert.equal(dropStagedController(DEVICE_ID, true, store), false);
    const again = prepareRegisteredController(
      { profile, keys: first.keys, label: 'c', registration: REGISTRATION },
      store
    );
    assert.equal(again.staged, false);
    assert.equal(again.record.role, 'owner');
    assert.equal(again.record.label, 'c');
    assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
  });

  test('promotion moves a corrupt main record aside instead of failing', () => {
    const store = { dir: storeDir };
    createController({ profile: resetProfile, label: 'old' }, store);
    const next = createController({ profile, label: 'x' }, stagingStore(store));
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, stagingStore(store));
    fs.writeFileSync(path.join(storeDir, `${DEVICE_ID}.json`), '{"v":1,"v":1}');

    const promoted = promoteStagedController(DEVICE_ID, store);
    assert.equal(controllerIdOf(promoted.keys), controllerIdOf(next.keys));
    assert.equal(loadController(DEVICE_ID, store)!.role, 'owner');
    assert.ok(fs.readdirSync(storeDir).some((f) => f.startsWith(`${DEVICE_ID}.json.corrupt-`)));
  });

  test('a corrupt controller file yields fresh keys and is moved aside when the result arrives', () => {
    const store = { dir: storeDir };
    createController({ profile, label: 'x' }, store);
    fs.writeFileSync(path.join(storeDir, `${DEVICE_ID}.json`), '{"v":1,"v":1}');
    const chosen = chooseControllerKeys(DEVICE_ID, store);
    assert.equal(chosen.reused, false);
    const result = prepareRegisteredController(
      { profile, keys: chosen.keys, label: 'x', registration: REGISTRATION },
      store
    );
    assert.equal(result.staged, false);
    assert.ok(loadController(DEVICE_ID, store));
    const aside = fs
      .readdirSync(storeDir)
      .filter((f) => f.startsWith(`${DEVICE_ID}.json.corrupt-`));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(storeDir, aside[0]), 'utf8'), '{"v":1,"v":1}');
  });

  test(
    'an unreadable controller file is never replaced',
    { skip: process.platform === 'win32' || process.getuid?.() === 0 },
    async () => {
      const store = { dir: storeDir };
      const first = createController({ profile, label: 'x' }, store);
      markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
      const file = path.join(storeDir, `${DEVICE_ID}.json`);
      const before = fs.readFileSync(file, 'utf8');
      fs.chmodSync(file, 0o000);
      try {
        assert.throws(
          () => chooseControllerKeys(DEVICE_ID, store),
          /Cannot read controller file.*keys were not changed/
        );
        assert.throws(
          () =>
            prepareRegisteredController(
              { profile, keys: first.keys, label: 'x', registration: REGISTRATION },
              store
            ),
          /Cannot read controller file/
        );
        const world = ownerWorld(approve());
        await assert.rejects(
          pairDevice(device, options, world.deps),
          /Cannot read controller file/
        );
        assert.equal(world.channels.length, 0, 'no QR is shown');
      } finally {
        fs.chmodSync(file, 0o600);
      }
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.equal(loadController(DEVICE_ID, stagingStore(store)), null);
    }
  );

  test('replacing an enrolled record for another identity asks first', async () => {
    const store = { dir: storeDir };
    createController({ profile: resetProfile, label: 'old' }, store);
    const never = async () => {
      throw new Error('must not ask');
    };
    // Pending (not enrolled): nothing to lose, no question.
    await confirmReplacement(device, profile, {}, never, store);
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, store);
    // Same identity: no question.
    await confirmReplacement(device, resetProfile, {}, never, store);
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

  test('replacing a corrupt controller file asks before the QR is shown', async () => {
    await assert.rejects(
      confirmCorruptReplacement(device, {}, async () => false),
      /left as it is/
    );
    await confirmCorruptReplacement(device, {}, async () => true);
    await confirmCorruptReplacement(device, { yes: true }, async () => {
      throw new Error('must not ask');
    });

    const store = { dir: storeDir };
    createController({ profile, label: 'x' }, store);
    fs.writeFileSync(path.join(storeDir, `${DEVICE_ID}.json`), '{"v":1,"v":1}');
    const world = ownerWorld(approve());
    await assert.rejects(
      pairDevice(device, options, { ...world.deps, confirmFn: async () => false }),
      /left as it is/
    );
    assert.equal(world.channels.length, 0);
    assert.equal(
      fs.readFileSync(path.join(storeDir, `${DEVICE_ID}.json`), 'utf8'),
      '{"v":1,"v":1}'
    );
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

describe('pairing copy', () => {
  test('an unavailable keyring warns and lets pairing continue, never printing the topic', () => {
    const warnings: string[] = [];
    const stored = storeRelayerTopic(
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

  test('advice on unauthenticated or replay errors never says unpair', () => {
    for (const code of ['bad_envelope', 'bad_signature', 'replay']) {
      const failure = describeControlCode(code, 'Living Room');
      assert.match(failure.details!, /ff-cli device pair "Living Room"/);
      assert.doesNotMatch(failure.details!, /run `ff-cli device unpair/);
    }
    assert.doesNotMatch(
      unverifiedReplyFailure('bad signature').details!,
      /run `ff-cli device unpair/
    );
    assert.match(describeControlCode('invalid_request', 'Office').details!, /clock/);
  });

  test('pairing codes point at Add controller, not an approval code', () => {
    const failure = describeControlCode('access_revoked', 'Office');
    assert.match(failure.details!, /ff-cli device pair Office/);
    assert.match(failure.details!, /Add controller/);
  });
});

describe('unpair', () => {
  const originalCwd = process.cwd();
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let home: string;

  /** unpairDevice answers revokeController like the FF1, or fails as given. */
  function unpairDevice(answer: 'ok' | 'last_owner' | 'offline' = 'ok') {
    const record = loadController(DEVICE_ID)!;
    const ctl = controllerIdOf(record.keys);
    const fake = new FakeFF1(
      { dev: DEVICE_ID, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
      { [ctl]: { kty: 'EC', crv: 'P-256', x: record.keys.sig.x, y: record.keys.sig.y } },
      () =>
        answer === 'ok'
          ? { ok: true, res: {} }
          : { ok: false, code: 'command_failed', res: { error: 'last_owner' } }
    );
    const fetchFn: typeof fetch = async (_input, init) => {
      if (answer === 'offline') {
        throw new Error('fetch failed');
      }
      const a = fake.handle(JSON.parse(String(init?.body)));
      return json(a.status, a.json);
    };
    return { fake, ctl, deps: { fetchFn, getTopicIdFn: () => null, waitFn: async () => {} } };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ff1-unpair-'));
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ ff1Devices: { devices: [device] } })
    );
    process.chdir(home);
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
    createController({ profile, label: 'x' });
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

  test('sends a sealed self-revoke, then deletes the keys', async () => {
    const { fake, ctl, deps } = unpairDevice('ok');
    await runUnpair(
      'Office',
      { yes: true },
      async () => {
        throw new Error('must not ask');
      },
      deps
    );
    assert.deepEqual(
      fake.seen.map((c) => [c.cmd, c.req]),
      [['revokeController', { ctl }]]
    );
    assert.equal(loadController(DEVICE_ID), null);
  });

  for (const answer of ['last_owner', 'offline'] as const) {
    test(`deletes the keys when the self-revoke fails (${answer})`, async () => {
      const { deps } = unpairDevice(answer);
      await runUnpair('Office', { yes: true }, async () => true, deps);
      assert.equal(loadController(DEVICE_ID), null);
    });
  }

  test('a pending (not enrolled) record sends no self-revoke', async () => {
    saveController({ ...loadController(DEVICE_ID)!, role: undefined, nk: undefined });
    const { fake, deps } = unpairDevice('ok');
    await runUnpair('Office', { yes: true }, async () => true, deps);
    assert.equal(fake.seen.length, 0);
    assert.equal(loadController(DEVICE_ID), null);
  });

  test('owner keys are kept, and nothing is sent, when the confirmation is declined', async () => {
    const { fake, deps } = unpairDevice('ok');
    const asked: string[] = [];
    await assert.rejects(
      runUnpair(
        'Office',
        {},
        async (q) => {
          asked.push(q);
          return false;
        },
        deps
      ),
      /nothing was deleted/
    );
    assert.equal(asked.length, 1);
    assert.equal(fake.seen.length, 0);
    assert.ok(loadController(DEVICE_ID));
  });

  test('controller keys also ask first', async () => {
    saveController({ ...loadController(DEVICE_ID)!, role: 'controller' });
    const { deps } = unpairDevice('ok');
    const asked: string[] = [];
    await assert.rejects(
      runUnpair(
        'Office',
        {},
        async (q) => {
          asked.push(q);
          return false;
        },
        deps
      ),
      /nothing was deleted/
    );
    assert.deepEqual(asked, ['Delete the controller keys?']);
    assert.ok(loadController(DEVICE_ID));
  });

  test('a staged owner record gets the owner warning', async () => {
    saveController({ ...loadController(DEVICE_ID)!, role: 'controller' });
    createController({ profile: resetProfile, label: 'y' }, stagingStore());
    markEnrolled(DEVICE_ID, { role: 'owner', nk: NK }, stagingStore());
    const { deps } = unpairDevice('ok');
    const asked: string[] = [];
    await assert.rejects(
      runUnpair(
        'Office',
        {},
        async (q) => {
          asked.push(q);
          return false;
        },
        deps
      ),
      /nothing was deleted/
    );
    assert.deepEqual(asked, ['Delete the owner keys anyway?']);
  });

  test('runPair parses the flags before anything else', async () => {
    await assert.rejects(runPair('Office', { timeout: '5' }), /--timeout/);
    await assert.rejects(runPair('Office', { label: '' }), /--label/);
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
});
