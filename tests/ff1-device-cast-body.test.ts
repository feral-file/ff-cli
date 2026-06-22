import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendPlaylistToDevice } from '../src/utilities/ff1-device';

// Exercises the cast response handling: an empty or non-JSON body from the
// device must not crash with "Unexpected end of JSON input". A transient empty
// body should be retried (the device commonly returns one on the first cast
// after boot), and a persistently empty body should yield a clear error.

interface MockResponse {
  status: number;
  ok: boolean;
  statusText: string;
  headers: { get: () => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

const originalCwd = process.cwd();
const originalFetch = global.fetch;
let fixtureDir: string;

const makeResponse = (body: string, init?: Partial<MockResponse>): MockResponse => ({
  status: init?.status ?? 200,
  ok: init?.ok ?? true,
  statusText: init?.statusText ?? 'OK',
  headers: { get: () => null },
  text: async () => body,
  json: async () => JSON.parse(body),
});

// The compatibility probe (command: getDeviceStatus) runs before the cast.
// Returning a 500 makes assertFF1CommandCompatibility treat the device as
// compatible without needing a version, isolating the cast-body behavior.
const compatibilityProbeResponse = (): MockResponse =>
  makeResponse('{}', { status: 500, ok: false, statusText: 'Internal Server Error' });

const installFetchMock = (castHandler: () => MockResponse): void => {
  global.fetch = (async (_url: RequestInfo | URL, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(options.body as string) : undefined;
    if (body?.command === 'getDeviceStatus') {
      return compatibilityProbeResponse() as unknown as Response;
    }
    return castHandler() as unknown as Response;
  }) as unknown as typeof global.fetch;
};

const writeDeviceConfig = (): void => {
  writeFileSync(
    path.join(process.cwd(), 'config.json'),
    JSON.stringify({ ff1Devices: { devices: [{ name: 'Frame', host: 'http://ff1.local' }] } }),
    'utf8'
  );
};

const samplePlaylist = {
  dpVersion: '1.1.0',
  id: 'test',
  items: [],
} as unknown as Parameters<typeof sendPlaylistToDevice>[0]['playlist'];

describe('sendPlaylistToDevice cast-body handling', () => {
  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'ff1-cast-body-test-'));
    process.chdir(fixtureDir);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.chdir(originalCwd);
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('retries an empty body and succeeds when a later attempt returns JSON', async () => {
    writeDeviceConfig();
    let castAttempt = 0;
    installFetchMock(() => {
      castAttempt += 1;
      return castAttempt === 1 ? makeResponse('') : makeResponse('{"ok":true}');
    });

    const result = await sendPlaylistToDevice({ playlist: samplePlaylist });

    assert.equal(result.success, true);
    assert.deepEqual(result.response, { ok: true });
    assert.equal(castAttempt, 2, 'should have retried after the empty body');
  });

  test('reports a clear error (not a JSON parse crash) when the body stays empty', async () => {
    writeDeviceConfig();
    installFetchMock(() => makeResponse(''));

    const result = await sendPlaylistToDevice({ playlist: samplePlaylist });

    assert.equal(result.success, false);
    assert.match(result.error || '', /returned no usable response/);
    assert.match(result.details || '', /empty response body/);
    // Crucially, the failure is not the raw JSON parse error.
    assert.doesNotMatch(result.error || '', /Unexpected end of JSON input/);
  });
});
