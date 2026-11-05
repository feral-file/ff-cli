/**
 * `ff-cli device lan --open|--close` (feral-file#3551 owner switch): the
 * owner-tier `setLanControl` is sent sealed with the stored grant, the state
 * printed is the one the verified reply carries, and without a grant nothing
 * is sent.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { controllerIdOf, parseProfile } from '../src/utilities/control/codec';
import {
  createController,
  loadController,
  markEnrolled,
} from '../src/utilities/control/controller-store';
import { CommandFailure, parseLanSwitch, runLan } from '../src/commands/helpers/device-control';
import { FakeFF1, type FakeAnswer } from './helpers/control-device';

const FIXTURES = path.join(__dirname, 'fixtures', 'ff1-control-v1');
const keys = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8'));
const DEVICE_ID = keys.device.dev as string;
const NK = keys.controllers.controller.nk as string;
const device = { name: 'Office', id: DEVICE_ID, host: 'http://ff1-fixture1.local:1111' };
const profile = parseProfile(keys.device.profile);

const originalCwd = process.cwd();
let home: string;
let store: { dir: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** captureLog runs fn and returns everything it printed with console.log. */
async function captureLog(fn: () => Promise<unknown>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

/**
 * enrolledFF1 enrolls ff-cli with role and answers its requests through
 * decide; `GET /api/status` is answered by status, or fails when none is given.
 */
function enrolledFF1(
  role: 'owner' | 'controller',
  decide: (c: Record<string, unknown>) => FakeAnswer,
  status?: () => Response
) {
  createController({ profile, label: 'x' }, store);
  markEnrolled(DEVICE_ID, { role, nk: NK }, store);
  const record = loadController(DEVICE_ID, store)!;
  const fake = new FakeFF1(
    { dev: DEVICE_ID, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
    {
      [controllerIdOf(record.keys)]: {
        kty: 'EC',
        crv: 'P-256',
        x: record.keys.sig.x,
        y: record.keys.sig.y,
      },
    },
    decide
  );
  const statusReads: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/api/status')) {
      statusReads.push(String(input));
      if (!status) {
        throw new Error('fetch failed');
      }
      return status();
    }
    const answer = fake.handle(JSON.parse(String(init?.body)));
    return json(answer.status, answer.json);
  };
  return {
    fake,
    statusReads,
    deps: { fetchFn, getTopicIdFn: () => null, waitFn: async () => {}, controllerStore: store },
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ff1-lan-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ ff1Devices: { devices: [device] } })
  );
  process.chdir(home);
  store = { dir: path.join(home, 'controllers') };
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('device lan', () => {
  test('exactly one of --open and --close is required', () => {
    assert.equal(parseLanSwitch({ open: true }), true);
    assert.equal(parseLanSwitch({ close: true }), false);
    for (const options of [{}, { open: true, close: true }]) {
      assert.throws(() => parseLanSwitch(options), CommandFailure);
    }
  });

  for (const open of [true, false]) {
    test(`--${open ? 'open' : 'close'} sends a sealed setLanControl and prints the FF1's state`, async () => {
      const { fake, deps } = enrolledFF1('owner', (claims) => ({
        ok: true,
        res: { open: (claims.req as { open: boolean }).open },
      }));
      const output = await captureLog(() =>
        runLan('Office', open ? { open: true } : { close: true }, deps)
      );
      assert.equal(fake.seen.length, 1);
      assert.equal(fake.seen[0].op, 'cmd');
      assert.equal(fake.seen[0].cmd, 'setLanControl');
      assert.deepEqual(fake.seen[0].req, { open });
      assert.match(output, new RegExp(`LAN control on Office is ${open ? 'open' : 'closed'}`));
    });
  }

  test('prints the state the verified reply carries, not the flag', async () => {
    const { deps } = enrolledFF1('owner', () => ({ ok: true, res: { open: false } }));
    const output = await captureLog(() => runLan('Office', { open: true }, deps));
    assert.match(output, /LAN control on Office is closed/);
  });

  test('a reply without the state fails instead of guessing', async () => {
    const { deps } = enrolledFF1('owner', () => ({ ok: true, res: {} }));
    await assert.rejects(runLan('Office', { close: true }, deps), /did not report its LAN control/);
  });

  // The FF1 may commit lan.json and still answer internal_error (directory
  // fsync failed), so the status is re-read and reported; the command fails.
  test('internal_error re-reads the status and reports the state it shows', async () => {
    const { statusReads, deps } = enrolledFF1(
      'owner',
      () => ({ ok: false, code: 'internal_error' }),
      () => json(200, { device_id: DEVICE_ID, control: { v: 1, state: 'enrolled', lan: 'open' } })
    );
    await assert.rejects(runLan('Office', { open: true }, deps), (error: unknown) => {
      assert.ok(error instanceof CommandFailure);
      assert.equal(
        error.message,
        'The FF1 reported an error, but the switch may have changed. It now reports: open.'
      );
      assert.match(error.details!, /Run the command again/);
      return true;
    });
    assert.deepEqual(statusReads, [`${device.host}/api/status`]);
  });

  test('internal_error with an unreadable status says the switch may have changed', async () => {
    for (const status of [undefined, () => json(200, { device_id: DEVICE_ID })]) {
      fs.rmSync(store.dir, { recursive: true, force: true });
      const { deps } = enrolledFF1('owner', () => ({ ok: false, code: 'internal_error' }), status);
      await assert.rejects(runLan('Office', { close: true }, deps), (error: unknown) => {
        assert.ok(error instanceof CommandFailure);
        assert.match(error.message, /switch may have changed, and its status could not be read/);
        assert.match(error.details!, /Run the command again/);
        return true;
      });
    }
  });

  test('other error codes do not read the status', async () => {
    const { statusReads, deps } = enrolledFF1(
      'owner',
      () => ({ ok: false, code: 'rate_limited' }),
      () => json(200, { control: { lan: 'open' } })
    );
    await assert.rejects(runLan('Office', { close: true }, deps), /rate-limiting/);
    assert.deepEqual(statusReads, []);
  });

  test('a controller grant gets the owner-access message from the FF1', async () => {
    const { fake, deps } = enrolledFF1('controller', () => ({
      ok: false,
      code: 'permission_denied',
    }));
    await assert.rejects(runLan('Office', { close: true }, deps), /needs owner access/);
    assert.equal(fake.seen.length, 1);
  });

  test('without a stored grant nothing is sent, plaintext included', async () => {
    let sent = 0;
    await assert.rejects(
      runLan(
        'Office',
        { close: true },
        {
          fetchFn: async () => {
            sent += 1;
            throw new Error('must not send');
          },
          controllerStore: store,
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof CommandFailure);
        assert.match(error.message, /not paired/);
        assert.match(error.details!, /ff-cli device pair Office/);
        return true;
      }
    );
    assert.equal(sent, 0);
  });
});
