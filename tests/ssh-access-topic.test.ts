import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FF1_TOPIC_HEADER, sendSshAccessCommand } from '../src/utilities/ssh-access';
import type { FF1Device } from '../src/types';

// Phase 0 of feral-file#3551: a claimed FF1 on newer FF OS requires the
// relayer topic as LAN topic proof on sshAccess casts. These tests pin the
// header contract and the 401 topic_required -> pairing guidance mapping.

const TOPIC = 'topic-secret-value';

interface Captured {
  headers: Record<string, string>;
  body: unknown;
}

/** mockFetch answers the compatibility probe with a supported version, then `castReply`. */
function mockFetch(castReply: () => Response, captured: Captured[]) {
  return async (_input: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { command?: string };
    if (body.command === 'getDeviceStatus') {
      return new Response(JSON.stringify({ message: { installedVersion: '1.0.21' } }), {
        status: 200,
      });
    }
    captured.push({ headers: { ...(init?.headers as Record<string, string>) }, body });
    return castReply();
  };
}

function run(
  device: FF1Device,
  castReply: () => Response,
  topic: string | null | (() => never),
  topicCalls: string[] = []
) {
  const captured: Captured[] = [];
  const promise = sendSshAccessCommand(
    { enabled: true, publicKey: 'ssh-ed25519 AAAA test', deviceName: device.name },
    {
      fetchFn: mockFetch(castReply, captured),
      getFF1DeviceConfigFn: () => ({ devices: [device] }),
      getTopicIdFn: (deviceId: string) => {
        topicCalls.push(deviceId);
        return typeof topic === 'function' ? topic() : topic;
      },
    }
  );
  return { promise, captured };
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const topicRequired = () =>
  new Response(JSON.stringify({ error: { code: 'topic_required' } }), {
    status: 401,
    statusText: 'Unauthorized',
  });

describe('sshAccess topic proof header (#3551 phase 0)', () => {
  const paired: FF1Device = { name: 'Kitchen', host: 'http://10.0.0.2:1111', id: 'ff1-abc' };

  test('sends X-FF1-Topic when a topic is stored for the device ID', async () => {
    const topicCalls: string[] = [];
    const { promise, captured } = run(paired, ok, TOPIC, topicCalls);
    const result = await promise;
    assert.equal(result.success, true);
    assert.deepEqual(topicCalls, ['ff1-abc']);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].headers[FF1_TOPIC_HEADER], TOPIC);
    assert.equal((captured[0].body as { command: string }).command, 'sshAccess');
  });

  test('omits the header when no topic is stored', async () => {
    const { promise, captured } = run(paired, ok, null);
    assert.equal((await promise).success, true);
    assert.equal(FF1_TOPIC_HEADER in captured[0].headers, false);
  });

  test('omits the header and skips the keyring when the device has no ID', async () => {
    const topicCalls: string[] = [];
    const { promise, captured } = run(
      { name: 'Old', host: 'http://10.0.0.3:1111' },
      ok,
      TOPIC,
      topicCalls
    );
    assert.equal((await promise).success, true);
    assert.deepEqual(topicCalls, []);
    assert.equal(FF1_TOPIC_HEADER in captured[0].headers, false);
  });

  test('still sends the request without the header when the keyring throws', async () => {
    const { promise, captured } = run(paired, ok, () => {
      throw new Error('keyring locked');
    });
    assert.equal((await promise).success, true);
    assert.equal(FF1_TOPIC_HEADER in captured[0].headers, false);
  });

  test('maps 401 topic_required to actionable pairing guidance', async () => {
    const { promise } = run({ ...paired, name: 'Living Room' }, topicRequired, null);
    const result = await promise;
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /requires ff-cli to be paired/);
    assert.match(result.error ?? '', /ff-cli device pair "Living Room"/);
    assert.match(result.error ?? '', /Pair with ff-cli/);
    assert.match(result.error ?? '', /Secure this FF1/);
  });

  test('topic_required on a device without an ID tells the user to re-add it first', async () => {
    const { promise } = run({ name: 'Old', host: 'http://10.0.0.3:1111' }, topicRequired, null);
    const result = await promise;
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /ff-cli device add --id/);
    assert.match(result.error ?? '', /ff-cli device pair Old/);
  });

  test('never leaks the topic value into the result', async () => {
    const { promise } = run(paired, topicRequired, TOPIC);
    const result = await promise;
    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result).includes(TOPIC), false);
  });

  test('other 401 bodies keep the generic device error', async () => {
    const { promise } = run(
      paired,
      () =>
        new Response(JSON.stringify({ error: { code: 'bad_api_key' } }), {
          status: 401,
          statusText: 'Unauthorized',
        }),
      TOPIC
    );
    const result = await promise;
    assert.equal(result.success, false);
    assert.equal(result.error, 'Device returned error 401: Unauthorized');
  });

  test('non-401 errors are unchanged', async () => {
    const { promise } = run(
      paired,
      () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
      TOPIC
    );
    const result = await promise;
    assert.equal(result.success, false);
    assert.equal(result.error, 'Device returned error 500: Internal Server Error');
    assert.equal(result.details, 'boom');
  });
});

// feral-file#3551 LAN control: sshAccess is owner tier, so FF OS with LAN
// control refuses a plaintext one with enrollment_required, also before the
// FF1 has an owner; the status read after that refusal picks the advice.
describe('sshAccess without a grant on FF OS with LAN control (#3551)', () => {
  const office: FF1Device = { name: 'Office', host: 'http://10.0.0.4:1111', id: 'ff1-def' };
  const refused = (code: string) =>
    new Response(JSON.stringify({ error: { code } }), { status: 403, statusText: 'Forbidden' });

  /** lanFetch answers getDeviceStatus with status, and sshAccess with reply. */
  function lanFetch(status: Record<string, unknown>, reply: () => Response, casts: string[]) {
    return async (_input: string, init?: RequestInit): Promise<Response> => {
      const command = (JSON.parse(String(init?.body ?? '{}')) as { command: string }).command;
      casts.push(command);
      return command === 'getDeviceStatus'
        ? new Response(JSON.stringify(status), { status: 200 })
        : reply();
    };
  }

  function send(fetchFn: (input: string, init?: RequestInit) => Promise<Response>) {
    return sendSshAccessCommand(
      { enabled: true, publicKey: 'ssh-ed25519 AAAA test', deviceName: office.name },
      { fetchFn, getFF1DeviceConfigFn: () => ({ devices: [office] }), getTopicIdFn: () => null }
    );
  }

  test('an FF1 with no owner yet gets the owner-setup guidance', async () => {
    const casts: string[] = [];
    const result = await send(
      lanFetch(
        { installedVersion: '3.0.0', control: { v: 1, state: 'legacy' } },
        () => refused('enrollment_required'),
        casts
      )
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Office has no owner yet, and SSH access needs one/);
    assert.match(
      result.details ?? '',
      /Set this FF1 up as owner in the Feral File app, then add this computer with Add controller/
    );
    assert.deepEqual(casts, ['getDeviceStatus', 'sshAccess', 'getDeviceStatus']);
  });

  test('an owned FF1 gets the owner-or-closed copy and the pair command', async () => {
    const result = await send(
      lanFetch(
        { installedVersion: '3.0.0', control: { v: 1, state: 'enrolled', lan: 'open' } },
        () => refused('enrollment_required'),
        []
      )
    );
    assert.equal(result.success, false);
    assert.match(
      result.error ?? '',
      /accepts this command only from its owner, or the owner turned off control from its Wi-Fi/
    );
    assert.match(result.details ?? '', /ff-cli device pair Office/);
  });

  test('lan_only says the FF1 only accepts its own network', async () => {
    const result = await send(
      lanFetch({ installedVersion: '3.0.0' }, () => refused('lan_only'), [])
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /accepts requests only from its own network/);
  });
});
