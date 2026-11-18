/**
 * `ff-cli download`: asks an FF1 to keep a playlist for display with no
 * network (the device's offline cache), then follows each item until it is
 * held or has failed. The device is a fake that answers the two commands the
 * way FF OS 3.0.1 does (ffos-user docs/controld-inbound-controller-messages.md,
 * "Offline Artwork Caching Inbound Messages").
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { formatItemLine, parseTimeoutSeconds } from '../src/commands/download';
import { parseProfile } from '../src/utilities/control/codec';
import { parsePrivateJwk } from '../src/utilities/control/jwk';
import { type ControllerRecord, saveController } from '../src/utilities/control/controller-store';
import {
  type DownloadDependencies,
  downloadPlaylist,
  loadDownloadSource,
  redactReason,
  redactUrls,
} from '../src/utilities/offline-download';
import type { FF1Device, Playlist } from '../src/types';
import { type FakeAnswer, FakeFF1, type Jwk } from './helpers/control-device';

const HOST = 'http://10.0.0.2:1111';
const kitchen: FF1Device = { name: 'Kitchen', host: HOST };

const A = 'https://cdn.example/a/index.html';
const B = 'https://cdn.example/b.mp4';

function playlistOf(...sources: string[]): Playlist {
  return {
    dpVersion: '1.1.0',
    id: 'p1',
    title: 'Two works',
    items: sources.map((source, index) => ({ title: `Work ${index + 1}`, source })),
  } as unknown as Playlist;
}

interface Cast {
  command: string;
  request: Record<string, unknown>;
}

type Handler = (cast: Cast, casts: Cast[]) => unknown;

/** plaintextFetch answers plaintext LAN casts from `handler`, recording them. */
function plaintextFetch(handler: Handler, casts: Cast[] = []) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    assert.equal(input, `${HOST}/api/cast`);
    const cast = JSON.parse(String(init?.body)) as Cast;
    casts.push(cast);
    const answer = handler(cast, casts);
    return answer instanceof Response
      ? answer
      : new Response(JSON.stringify(answer), { status: 200 });
  };
}

const QUEUED = { ok: true, status: 'queued', total: 2, queuedCount: 2 };

function item(source: string, state: string, extra: Record<string, unknown> = {}) {
  return { source, state, percent: state === 'ready' ? 100 : 0, ...extra };
}

/** Clock is a fake millisecond clock that only sleep() moves. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    clockMsFn: () => now,
    sleepFn: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

/** delay resolves after `ms`, or rejects as fetch does when `signal` aborts first. */
function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    });
  });
}

function deps(
  handler: Handler,
  playlist: Playlist,
  extra: Partial<DownloadDependencies> = {}
): DownloadDependencies & { casts: Cast[]; sleeps: number[] } {
  const casts: Cast[] = [];
  const clock = fakeClock();
  return {
    casts,
    sleeps: clock.sleeps,
    fetchFn: plaintextFetch(handler, casts),
    getFF1DeviceConfigFn: () => ({ devices: [kitchen] }),
    loadPlaylistFn: async (source: string) => ({
      playlist,
      source,
      sourceType: 'file' as const,
    }),
    clockMsFn: clock.clockMsFn,
    sleepFn: clock.sleepFn,
    ...extra,
  };
}

describe('download: file source', () => {
  test('sends dp1_call, polls by item source, and succeeds when every item is held', async () => {
    const playlist = playlistOf(A, B);
    let polls = 0;
    const d = deps((cast) => {
      if (cast.command === 'downloadPlaylist') {
        return QUEUED;
      }
      polls += 1;
      return polls === 1
        ? { ok: true, items: [item(A, 'downloading'), item(B, 'queued')] }
        : {
            ok: true,
            items: [
              item(B, 'ready', { bytes: 2048, coverageComplete: true }),
              item(A, 'ready', { bytes: 11988, coverageComplete: true }),
            ],
          };
    }, playlist);
    const seen: string[] = [];
    const result = await downloadPlaylist(
      {
        source: 'playlist.json',
        wait: true,
        onItemState: (i) => seen.push(`${i.title}:${i.state}`),
      },
      d
    );

    assert.equal(result.success, true, result.error);
    assert.deepEqual(d.casts[0], { command: 'downloadPlaylist', request: { dp1_call: playlist } });
    assert.deepEqual(d.casts[1], {
      command: 'getOfflineCacheStatus',
      request: { sources: [A, B] },
    });
    assert.equal(result.queuedCount, 2);
    assert.equal(result.deviceName, 'Kitchen');
    assert.deepEqual(
      result.items?.map((i) => [i.title, i.state, i.bytes, i.coverageComplete, i.outcome]),
      [
        ['Work 1', 'ready', 11988, true, 'ready'],
        ['Work 2', 'ready', 2048, true, 'ready'],
      ]
    );
    assert.deepEqual(seen, ['Work 1:downloading', 'Work 2:queued', 'Work 1:ready', 'Work 2:ready']);
    assert.equal(d.sleeps.length, 1);
  });

  test('reads the reply inside the plaintext `message` wrapper', async () => {
    const d = deps(
      (cast) =>
        cast.command === 'downloadPlaylist'
          ? { message: { ...QUEUED, total: 1, queuedCount: 1 } }
          : { message: { ok: true, items: [item(A, 'ready', { coverageComplete: true })] } },
      playlistOf(A)
    );
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, true, result.error);
    assert.equal(result.queuedCount, 1);
  });

  test('an item that fails, or is held with incomplete coverage, fails the command', async () => {
    const d = deps(
      (cast) =>
        cast.command === 'downloadPlaylist'
          ? QUEUED
          : {
              ok: true,
              // coverageComplete and bytes are omitted on the wire when false/0.
              items: [
                item(A, 'partial', { bytes: 900, reason: 'fetch_failed:https://cdn.example/x' }),
                item(B, 'failed'),
              ],
            },
      playlistOf(A, B)
    );
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, false);
    assert.deepEqual(
      result.items?.map((i) => [i.title, i.state, i.coverageComplete, i.outcome]),
      [
        ['Work 1', 'partial', false, 'incomplete'],
        ['Work 2', 'failed', false, 'failed'],
      ]
    );
    assert.equal(result.items?.[0].reason, 'fetch_failed:https://cdn.example/x');
    assert.match(result.error ?? '', /1 failed/);
    assert.match(result.error ?? '', /1 incomplete/);
  });

  test('`ready` without coverageComplete is incomplete, not held', async () => {
    const d = deps(
      (cast) =>
        cast.command === 'downloadPlaylist'
          ? QUEUED
          : { ok: true, items: [item(A, 'ready', { bytes: 10 })] },
      playlistOf(A)
    );
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, false);
    assert.equal(result.items?.[0].outcome, 'incomplete');
  });

  test('an item the FF1 did not queue (not_cached after the queue answer) is failed', async () => {
    const d = deps(
      (cast) =>
        cast.command === 'downloadPlaylist'
          ? { ...QUEUED, queuedCount: 1 }
          : { ok: true, items: [item(A, 'ready', { coverageComplete: true })] },
      playlistOf(A, 'https://stream.example/live.m3u8')
    );
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, false);
    assert.deepEqual(
      result.items?.map((i) => [i.state, i.outcome]),
      [
        ['ready', 'ready'],
        ['not_cached', 'failed'],
      ]
    );
    assert.equal(d.sleeps.length, 0);
  });

  test('times out with the items still pending named', async () => {
    const d = deps(
      (cast) =>
        cast.command === 'downloadPlaylist'
          ? QUEUED
          : {
              ok: true,
              items: [item(A, 'ready', { coverageComplete: true }), item(B, 'downloading')],
            },
      playlistOf(A, B)
    );
    const result = await downloadPlaylist(
      { source: 'playlist.json', wait: true, timeoutSeconds: 5 },
      d
    );
    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.deepEqual(
      result.items?.map((i) => i.outcome),
      ['ready', 'timed_out']
    );
    assert.match(result.error ?? '', /1 timed out/);
    assert.equal(
      d.sleeps.reduce((sum, ms) => sum + ms, 0),
      5000
    );
  });

  test('the timeout bounds the requests too, paging included', async () => {
    const sources = Array.from({ length: 1030 }, (_, i) => `https://cdn.example/${i}.png`);
    const ready = (list: string[]) => list.map((s) => item(s, 'ready', { coverageComplete: true }));
    const clock = { now: 0 };
    const casts: Cast[] = [];
    // Each status request takes 30 s on the device's side; nothing sleeps.
    const fetchFn = plaintextFetch((cast) => {
      if (cast.command === 'downloadPlaylist') {
        return QUEUED;
      }
      clock.now += 30_000;
      const asked = cast.request.sources as string[];
      return asked.length === 1024 && !cast.request.cursor
        ? { ok: true, items: ready(asked.slice(0, 1000)), nextCursor: 'k1' }
        : { ok: true, items: ready(asked.length === 1024 ? asked.slice(1000) : asked) };
    }, casts);
    const d = deps(() => QUEUED, playlistOf(...sources), {
      fetchFn,
      clockMsFn: () => clock.now,
      sleepFn: async (ms) => {
        clock.now += ms;
      },
    });
    const result = await downloadPlaylist(
      { source: 'playlist.json', wait: true, timeoutSeconds: 45 },
      d
    );
    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    // The first page answers at 30 s, the second at 60 s, past the deadline:
    // it is dropped and the third request is never sent.
    assert.equal(casts.length, 3);
    assert.ok(result.items?.every((i) => i.state === 'unknown' && i.outcome === 'timed_out'));
    assert.match(result.error ?? '', /1030 timed out/);
  });

  test('a status request that never answers is cut off at the timeout', async () => {
    const d = deps(() => QUEUED, playlistOf(A), { clockMsFn: undefined, sleepFn: undefined });
    const inner = d.fetchFn!;
    d.fetchFn = async (input, init) => {
      if (d.casts.length > 0) {
        await delay(60_000, init?.signal);
      }
      return inner(input, init);
    };
    const started = Date.now();
    const result = await downloadPlaylist(
      { source: 'playlist.json', wait: true, timeoutSeconds: 1 },
      d
    );
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed >= 900 && elapsed < 1400, `took ${elapsed} ms`);
  });

  test('--no-wait reports the queued count and never polls', async () => {
    const d = deps(() => QUEUED, playlistOf(A, B));
    const result = await downloadPlaylist({ source: 'playlist.json', wait: false }, d);
    assert.equal(result.success, true);
    assert.equal(result.waited, false);
    assert.equal(result.queuedCount, 2);
    assert.equal(result.total, 2);
    assert.equal(d.casts.length, 1);
  });

  test('asks for status in pages of 1024 sources and follows nextCursor', async () => {
    const sources = Array.from({ length: 1030 }, (_, i) => `https://cdn.example/${i}.png`);
    const ready = (list: string[]) => list.map((s) => item(s, 'ready', { coverageComplete: true }));
    const d = deps(
      (cast) => {
        if (cast.command === 'downloadPlaylist') {
          return { ...QUEUED, total: 1030, queuedCount: 1030 };
        }
        const asked = cast.request.sources as string[];
        if (asked.length === 1024 && !cast.request.cursor) {
          return {
            ok: true,
            items: ready(asked.slice(0, 1000)),
            truncated: true,
            nextCursor: 'k1',
          };
        }
        if (asked.length === 1024) {
          return { ok: true, items: ready(asked.slice(1000)) };
        }
        return { ok: true, items: ready(asked) };
      },
      playlistOf(...sources)
    );
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, true, result.error);
    assert.equal(result.items?.length, 1030);
    const status = d.casts.slice(1).map((c) => c.request);
    assert.equal(status.length, 3);
    assert.equal((status[0].sources as string[]).length, 1024);
    assert.equal(status[1].cursor, 'k1');
    assert.equal((status[2].sources as string[]).length, 6);
  });
});

describe('download: what it takes', () => {
  const load = (playlist: unknown) => async (source: string) => ({
    playlist: playlist as Playlist,
    source,
    sourceType: 'file' as const,
  });

  test('a URL is refused with the save-first step, before anything is sent', async () => {
    const d = deps(() => QUEUED, playlistOf(A));
    const result = await downloadPlaylist(
      { source: 'https://feed.example/api/v1/playlists/two?key=SECRET', wait: true },
      d
    );
    assert.equal(result.success, false);
    assert.equal(result.error, 'download takes a playlist file, not a URL.');
    assert.match(result.details ?? '', /ff-cli fetch <id-or-url> -o playlist\.json/);
    assert.match(result.details ?? '', /ff-cli download playlist\.json/);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal(d.casts.length, 0);
  });

  test('JSON that is not a DP-1 playlist is refused', async () => {
    await assert.rejects(
      loadDownloadSource('data.json', load({ hello: 'world' })),
      /is not a DP-1 playlist/
    );
  });

  test('a dynamic playlist is refused, in either form the FF1 resolves', async () => {
    const base = playlistOf(A) as unknown as Record<string, unknown>;
    for (const dynamic of [
      { dynamicQuery: { endpoint: 'https://indexer.example' } },
      { dynamicQueries: [{ endpoint: 'https://indexer.example' }] },
    ]) {
      await assert.rejects(
        loadDownloadSource('dynamic.json', load({ ...base, ...dynamic })),
        /is a dynamic playlist/
      );
    }
    await loadDownloadSource('static.json', load({ ...base, dynamicQueries: [] }));
  });

  test('a playlist with no items is refused', async () => {
    await assert.rejects(loadDownloadSource('empty.json', load(playlistOf())), /has no items/);
  });

  test('items with no source are refused by name, never dropped', async () => {
    const d = deps(() => QUEUED, {
      dpVersion: '1.1.0',
      items: [{ title: 'A', source: A }, { title: 'B' }, { source: '' }],
    } as unknown as Playlist);
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, false);
    assert.equal(result.error, 'playlist.json has 2 of 3 items with no source: B, item 3.');
    assert.equal(d.casts.length, 0);
  });

  test('an inline data: source is refused by name: nothing says what it loads is held', async () => {
    const d = deps(() => QUEUED, {
      dpVersion: '1.1.0',
      items: [
        { title: 'Hosted', source: A },
        { title: 'Page', source: 'data:text/html,<img src="https://cdn.example/never.png">' },
        { source: 'DATA:text/plain,hi' },
      ],
    } as unknown as Playlist);
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      'playlist.json has 2 of 3 items with an inline (data:) source: Page, item 3.'
    );
    assert.match(result.details ?? '', /cannot check that what it loads is held/);
    assert.match(result.details ?? '', /Nothing was sent to the device\./);
    assert.equal(d.casts.length, 0);
  });
});

describe('download: nothing secret reaches the terminal', () => {
  const SIGNED = 'https://user:pw@cdn.example/work/index.html?token=SECRET#frag';

  test('redactUrls drops userinfo, query and fragment, and keeps the path', () => {
    assert.equal(redactUrls(SIGNED), 'https://cdn.example/work/index.html?…#…');
    assert.equal(
      redactUrls('fetch_failed:https://cdn.example/x?token=SECRET; csp:ipfs://cid/a?k=SECRET'),
      'fetch_failed:https://cdn.example/x?…; csp:ipfs://cid/a?…'
    );
    assert.equal(redactUrls('no address here'), 'no address here');
  });

  test('a reason loses the query and fragment of a relative reference too', async () => {
    assert.equal(
      redactReason('gltf_external_dependency:texture.png?token=SECRET'),
      'gltf_external_dependency:texture.png?…'
    );
    assert.equal(
      redactReason(
        'gltf_external_dependency:a/b.bin?sig=SECRET.x#SECRET; fetch_failed:c.png#SECRET.'
      ),
      'gltf_external_dependency:a/b.bin?…#…; fetch_failed:c.png#….'
    );
    assert.equal(
      redactReason(`loading_failed:${SIGNED}`),
      'loading_failed:https://cdn.example/work/index.html?…#…'
    );
    assert.equal(redactReason('is it held?'), 'is it held?');

    const d = deps(
      (cast) =>
        cast.command === 'downloadPlaylist'
          ? QUEUED
          : {
              ok: true,
              items: [
                item(A, 'partial', { reason: 'gltf_external_dependency:texture.png?token=SECRET' }),
              ],
            },
      playlistOf(A)
    );
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(
      formatItemLine(result.items![0]),
      '  ✗ Work 1: partial, 0 bytes, coverage incomplete (gltf_external_dependency:texture.png?…)'
    );
  });

  test('an untitled item, a device reason, and a device error are redacted; requests are exact', async () => {
    const playlist = { dpVersion: '1.1.0', items: [{ source: SIGNED }] } as unknown as Playlist;
    const seen: string[] = [];
    const d = deps(
      (cast) =>
        cast.command === 'downloadPlaylist'
          ? QUEUED
          : {
              ok: true,
              items: [item(SIGNED, 'partial', { reason: `loading_failed(net::ERR):${SIGNED}` })],
            },
      playlist
    );
    const result = await downloadPlaylist(
      { source: 'playlist.json', wait: true, onItemState: (i) => seen.push(formatItemLine(i)) },
      d
    );
    assert.equal(result.success, false);
    assert.deepEqual(d.casts[1].request, { sources: [SIGNED] });
    assert.equal(result.items?.[0].title, 'https://cdn.example/work/index.html?…#…');
    const printed = [
      ...seen,
      ...(result.items ?? []).map(formatItemLine),
      result.error,
      result.details,
    ].join('\n');
    assert.doesNotMatch(printed, /SECRET|user:pw/);

    const refused = deps(
      () => ({
        ok: false,
        error: { code: 'resolve_failed', message: `fetch ${SIGNED}: 403`, retryable: true },
      }),
      playlist
    );
    const failure = await downloadPlaylist({ source: 'playlist.json', wait: true }, refused);
    assert.equal(failure.details, 'fetch https://cdn.example/work/index.html?…#…: 403');
  });
});

describe('download: device answers', () => {
  const offlineError = (code: string, message: string, retryable = false) => ({
    ok: false,
    error: { code, message, retryable },
  });

  test('`disabled` is a plain sentence', async () => {
    const d = deps(() => offlineError('disabled', 'offline caching is not enabled'), playlistOf(A));
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      'Kitchen has offline display turned off, so it cannot keep works to display with no network.'
    );
    assert.equal(d.casts.length, 1);
  });

  test('`resolve_failed` carries the device reason', async () => {
    const d = deps(
      () => offlineError('resolve_failed', 'signature verification failed', true),
      playlistOf(A)
    );
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /could not load the playlist/);
    assert.equal(result.details, 'signature verification failed');
  });

  test('a reply without the offline answer shape is not reported as queued', async () => {
    const d = deps(() => ({ message: { something: 'else' } }), playlistOf(A));
    const result = await downloadPlaylist({ source: 'playlist.json', wait: false }, d);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /did not accept the download command/);
  });

  test('a retryable status failure keeps waiting; a final one stops', async () => {
    let polls = 0;
    const d = deps((cast) => {
      if (cast.command === 'downloadPlaylist') {
        return QUEUED;
      }
      polls += 1;
      return polls === 1
        ? offlineError('offline_cache_error', 'disk read failed', true)
        : { ok: true, items: [item(A, 'ready', { coverageComplete: true })] };
    }, playlistOf(A));
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, true, result.error);

    const stopped = deps(
      (cast) =>
        cast.command === 'downloadPlaylist'
          ? QUEUED
          : offlineError('invalid_request', 'sources must be an array'),
      playlistOf(A)
    );
    const failure = await downloadPlaylist({ source: 'playlist.json', wait: true }, stopped);
    assert.equal(failure.success, false);
    assert.equal(stopped.casts.length, 2);
  });
});

describe('download: no pairing', () => {
  test('a secured FF1 refusing plaintext gets the pairing guidance', async () => {
    const d = deps(
      () =>
        new Response(JSON.stringify({ error: { code: 'enrollment_required' } }), {
          status: 403,
          statusText: 'Forbidden',
        }),
      playlistOf(A)
    );
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, false);
    assert.match(result.details ?? '', /ff-cli device pair Kitchen/);
    assert.equal(d.casts.length, 1);
  });

  test('no configured device stops before anything is sent', async () => {
    const d = deps(() => QUEUED, playlistOf(A), {
      getFF1DeviceConfigFn: () => ({ devices: [] }),
    });
    const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /No FF1 devices configured/);
    assert.equal(d.casts.length, 0);
  });

  test('an unfinished pairing stops with the resume guidance', async () => {
    const { storeDir, deviceId, cleanup } = controllerStore({ enrolled: false });
    try {
      const d = deps(() => QUEUED, playlistOf(A), {
        getFF1DeviceConfigFn: () => ({ devices: [{ ...kitchen, id: deviceId }] }),
        controllerStore: { dir: storeDir },
      });
      const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /Pairing ff-cli with this FF1 is not finished/);
      assert.equal(d.casts.length, 0);
    } finally {
      cleanup();
    }
  });
});

// Secure control: with a controller file the same two commands travel as
// ff1-control-v1 envelopes, LAN only, and the handler body is the reply `res`.
const FIXTURES = path.join(__dirname, 'fixtures', 'ff1-control-v1');
const keys = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keys.json'), 'utf8'));

function controllerStore(options: { enrolled: boolean }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff1-download-'));
  const storeDir = path.join(tmp, 'controllers');
  const c = keys.controllers.controller;
  const record: ControllerRecord = {
    v: 1,
    deviceId: keys.device.dev,
    profile: parseProfile(keys.device.profile),
    keys: { sig: parsePrivateJwk(c.sig), enc: parsePrivateJwk(c.enc) },
    label: 'test cli',
    ctr: 0,
    createdAt: keys.now,
    ...(options.enrolled ? { role: c.role, nk: c.nk, enrolledAt: keys.now } : {}),
  } as ControllerRecord;
  saveController(record, { dir: storeDir });
  return {
    storeDir,
    deviceId: keys.device.dev as string,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

/**
 * secureDeps pairs a FakeFF1 that answers from `decide` with the deps that
 * reach it. `beforeReply` runs after the device has opened a request and
 * before its answer is returned (a slow device).
 */
function secureDeps(
  decide: (claims: Record<string, unknown>) => FakeAnswer,
  playlist: Playlist,
  beforeReply: (
    claims: Record<string, unknown>,
    signal?: AbortSignal | null
  ) => Promise<void> = async () => {}
) {
  const { storeDir, deviceId, cleanup } = controllerStore({ enrolled: true });
  const c = keys.controllers.controller;
  const device = new FakeFF1(
    { dev: deviceId, gen: keys.device.gen, sig: keys.device.sig, enc: keys.device.enc },
    { [c.ctl]: { kty: 'EC', crv: 'P-256', x: c.sig.x, y: c.sig.y } as Jwk },
    decide
  );
  const d = deps(() => QUEUED, playlist, {
    fetchFn: async (_input, init) => {
      const answer = device.handle(JSON.parse(String(init?.body)));
      await beforeReply(device.seen[device.seen.length - 1], init?.signal);
      return new Response(JSON.stringify(answer.json), { status: answer.status });
    },
    getFF1DeviceConfigFn: () => ({ devices: [{ ...kitchen, id: deviceId }] }),
    controllerStore: { dir: storeDir },
    nowFn: () => keys.now,
  });
  return { d, device, cleanup };
}

const QUEUED_ONE = { ok: true as const, res: { ...QUEUED, total: 1, queuedCount: 1 } };
const READY_A = {
  ok: true as const,
  res: { ok: true, items: [item(A, 'ready', { bytes: 7, coverageComplete: true })] },
};

describe('download: secure control', () => {
  test('a controller grant downloads and polls through secure envelopes', async () => {
    const playlist = playlistOf(A);
    const { d, device, cleanup } = secureDeps(
      (claims) => (claims.cmd === 'downloadPlaylist' ? QUEUED_ONE : READY_A),
      playlist
    );
    try {
      const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, d);
      assert.equal(result.success, true, result.error);
      assert.deepEqual(
        device.seen.map((claims) => [claims.cmd, claims.req]),
        [
          ['downloadPlaylist', { dp1_call: playlist }],
          ['getOfflineCacheStatus', { sources: [A] }],
        ]
      );
    } finally {
      cleanup();
    }
  });

  test('a transient answer to a status read is retried by the wait; a final one stops it', async () => {
    const transient: FakeAnswer[] = [
      { publicCode: 'busy', status: 503 },
      { ok: false, code: 'rate_limited' },
      { ok: false, code: 'internal_error' },
      { ok: false, code: 'command_failed', res: { error: 'rate_limited' } },
    ];
    let reads = 0;
    const retried = secureDeps((claims) => {
      if (claims.cmd === 'downloadPlaylist') {
        return QUEUED_ONE;
      }
      reads += 1;
      return transient[reads - 1] ?? READY_A;
    }, playlistOf(A));
    try {
      const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, retried.d);
      assert.equal(result.success, true, result.error);
      assert.equal(reads, 5);
      assert.deepEqual(retried.d.sleeps, [2000, 2000, 2000, 2000]);
    } finally {
      retried.cleanup();
    }

    const stopped = secureDeps(
      (claims) =>
        claims.cmd === 'downloadPlaylist' ? QUEUED_ONE : { ok: false, code: 'forbidden' },
      playlistOf(A)
    );
    try {
      const result = await downloadPlaylist({ source: 'playlist.json', wait: true }, stopped.d);
      assert.equal(result.success, false);
      assert.equal(result.timedOut, undefined);
      assert.equal(stopped.device.seen.length, 2);
    } finally {
      stopped.cleanup();
    }
  });

  test('a transient answer that never clears ends at the timeout, naming it', async () => {
    const { d, cleanup } = secureDeps(
      (claims) =>
        claims.cmd === 'downloadPlaylist' ? QUEUED_ONE : { publicCode: 'busy', status: 503 },
      playlistOf(A)
    );
    try {
      const result = await downloadPlaylist(
        { source: 'playlist.json', wait: true, timeoutSeconds: 5 },
        d
      );
      assert.equal(result.success, false);
      assert.equal(result.timedOut, true);
      assert.match(result.details ?? '', /The last status read failed: .*busy/);
    } finally {
      cleanup();
    }
  });

  test('the request sent again after a `replay` answer gets only the time that is left', async () => {
    let reads = 0;
    // The wait runs on the real clock: every status answer takes 750 ms, the
    // first is `replay`, and the second request must be cut off at 1 s, not
    // given another full second.
    const { d, device, cleanup } = secureDeps(
      (claims) => {
        if (claims.cmd === 'downloadPlaylist') {
          return QUEUED_ONE;
        }
        reads += 1;
        return reads === 1 ? { ok: false, code: 'replay' } : READY_A;
      },
      playlistOf(A),
      (claims, signal) =>
        claims.cmd === 'getOfflineCacheStatus' ? delay(750, signal) : Promise.resolve()
    );
    d.clockMsFn = undefined;
    d.sleepFn = undefined;
    try {
      const started = Date.now();
      const result = await downloadPlaylist(
        { source: 'playlist.json', wait: true, timeoutSeconds: 1 },
        d
      );
      const elapsed = Date.now() - started;
      assert.equal(device.seen.length, 3);
      assert.equal(result.success, false);
      assert.equal(result.timedOut, true);
      assert.ok(elapsed >= 900 && elapsed < 1400, `took ${elapsed} ms`);
    } finally {
      cleanup();
    }
  });
});

describe('download: command output', () => {
  test('--timeout takes a positive whole number of seconds', () => {
    assert.equal(parseTimeoutSeconds(undefined), 180);
    assert.equal(parseTimeoutSeconds('600'), 600);
    for (const bad of ['0', '-5', '1.5', 'soon']) {
      assert.throws(() => parseTimeoutSeconds(bad), /positive whole number of seconds/);
    }
  });

  test('an item line carries title, state, bytes, and coverage', () => {
    assert.equal(
      formatItemLine({
        title: 'Work 1',
        source: A,
        state: 'ready',
        bytes: 11988,
        coverageComplete: true,
        outcome: 'ready',
      }),
      '  ✓ Work 1: ready, 11988 bytes, coverage complete'
    );
    assert.equal(
      formatItemLine({
        title: 'Work 2',
        source: B,
        state: 'partial',
        bytes: 900,
        coverageComplete: false,
        reason: 'fetch_failed:https://cdn.example/x',
        outcome: 'incomplete',
      }),
      '  ✗ Work 2: partial, 900 bytes, coverage incomplete (fetch_failed:https://cdn.example/x)'
    );
  });
});
