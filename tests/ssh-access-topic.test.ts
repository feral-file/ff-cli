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
