import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { sendPlaylistToDevice } from '../src/utilities/ff1-device';

const originalCwd = process.cwd();
let fixtureDir: string;

const playlist = {
  dpVersion: '1.1.0',
  id: 'fallback-test',
  title: 'Fallback test',
  items: [],
} as unknown as Parameters<typeof sendPlaylistToDevice>[0]['playlist'];

describe('relayer fallback', () => {
  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'ff1-relayer-fallback-'));
    process.chdir(fixtureDir);
    writeFileSync(
      path.join(fixtureDir, 'config.json'),
      JSON.stringify({
        ff1Relayer: { baseUrl: 'https://relayer.example', apiKey: 'optional-key' },
        ff1Devices: {
          devices: [
            {
              name: 'Office',
              id: 'FF1-SKYZ2E3A',
              host: 'http://ff1-skyz2e3a.local:1111',
            },
          ],
        },
      })
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('falls back after LAN reachability failure and prints an explicit notice', async () => {
    const requests: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    const notices: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = input.toString();
      requests.push({ url, headers: init?.headers });
      if (url.startsWith('http://ff1-skyz2e3a.local')) {
        throw new Error('fetch failed', { cause: { code: 'ENOTFOUND' } });
      }
      return new Response(JSON.stringify({ message: { message: { ok: true } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn,
        getTopicIdFn: () => 'topic-secret',
        waitFn: async () => undefined,
        noticeFn: (message) => notices.push(message),
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.transport, 'relayer');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /LAN.*unreachable.*relayer/i);
    const relayerRequest = requests.at(-1)!;
    assert.equal(relayerRequest.url, 'https://relayer.example/api/cast?topicID=topic-secret');
    assert.equal(new Headers(relayerRequest.headers).get('API-KEY'), 'optional-key');
  });

  test('does not fall back when no topic is paired for the selected device', async () => {
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: async () => {
          throw new Error('fetch failed', { cause: { code: 'ENOTFOUND' } });
        },
        getTopicIdFn: () => null,
        waitFn: async () => undefined,
        noticeFn: () => assert.fail('notice should not be printed without a fallback'),
      }
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Could not reach device/);
    assert.match(result.details ?? '', /device pair/);
  });

  test('does not fall back after a LAN HTTP failure', async () => {
    const urls: string[] = [];
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: async (input) => {
          urls.push(input.toString());
          return new Response('device rejected request', { status: 500 });
        },
        getTopicIdFn: () => assert.fail('topic lookup means fallback was attempted'),
        waitFn: async () => undefined,
      }
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Device returned error 500/);
    assert.ok(urls.every((url) => url.startsWith('http://ff1-skyz2e3a.local')));
  });

  test('does not fall back after a LAN application rejection', async () => {
    const result = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { command?: string };
          return body.command === 'getDeviceStatus'
            ? new Response(JSON.stringify({ message: { installedVersion: '1.0.0' } }))
            : new Response(JSON.stringify({ message: { ok: false } }));
        },
        getTopicIdFn: () => assert.fail('topic lookup means fallback was attempted'),
        waitFn: async () => undefined,
      }
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /rejected the display command/);
  });

  test('returns structured failures for invalid config and relayer HTTP errors', async () => {
    const unreachable: typeof fetch = async () => {
      throw new Error('fetch failed', { cause: { code: 'ENOTFOUND' } });
    };
    const invalidConfig = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: unreachable,
        getTopicIdFn: () => 'topic-secret',
        getRelayerConfigFn: () => {
          throw new Error('ff1Relayer.baseUrl must be a valid HTTP(S) URL');
        },
        waitFn: async () => undefined,
      }
    );
    assert.equal(invalidConfig.success, false);
    assert.equal(invalidConfig.transport, 'relayer');
    assert.match(invalidConfig.error ?? '', /Invalid FF1 relayer configuration/);

    const relayerHttpFailure = await sendPlaylistToDevice(
      { playlist },
      {
        fetchFn: async (input) => {
          if (input.toString().startsWith('http://ff1-skyz2e3a.local')) {
            throw new Error('fetch failed', { cause: { code: 'ENOTFOUND' } });
          }
          return new Response('relayer unavailable', { status: 503 });
        },
        getTopicIdFn: () => 'topic-secret',
        waitFn: async () => undefined,
      }
    );
    assert.equal(relayerHttpFailure.success, false);
    assert.equal(relayerHttpFailure.transport, 'relayer');
    assert.match(relayerHttpFailure.error ?? '', /HTTP 503/);
  });
});
