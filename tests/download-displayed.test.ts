/**
 * `ff-cli download --displayed`: asks an FF1 to keep the work it is
 * displaying, including one this CLI did not send (feral-file/feral-file#3633).
 * The fake device answers `checkStatus` with the player's status and
 * `downloadPlaylistItem {displayed}` the way ffos-user#483 does.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type DownloadDependencies, downloadDisplayed } from '../src/utilities/offline-download';
import type { FF1Device } from '../src/types';

const HOST = 'http://10.0.0.2:1111';
const kitchen: FF1Device = { name: 'Kitchen', host: HOST };

const A = 'https://cdn.example/a/index.html?token=secret';
const B = 'https://cdn.example/b.mp4';

interface Cast {
  command: string;
  request: Record<string, unknown>;
}

type Handler = (cast: Cast) => unknown;

function deps(handler: Handler): DownloadDependencies & { casts: Cast[] } {
  const casts: Cast[] = [];
  let now = 0;
  return {
    casts,
    fetchFn: async (input: string, init?: RequestInit): Promise<Response> => {
      assert.equal(input, `${HOST}/api/cast`);
      const cast = JSON.parse(String(init?.body)) as Cast;
      casts.push(cast);
      // The LAN hub nests the handler's body under `message`.
      return new Response(JSON.stringify({ message: handler(cast) }), { status: 200 });
    },
    getFF1DeviceConfigFn: () => ({ devices: [kitchen] }),
    clockMsFn: () => now,
    sleepFn: async (ms: number) => {
      now += ms;
    },
  };
}

function playing(index: number, items: Record<string, unknown>[]) {
  return { ok: true, castCommand: 'displayPlaylist', index, items };
}

const twoWorks = [
  { id: 'id-a', title: 'Work A', source: A },
  { id: 'id-b', title: 'Work B', source: B },
];

describe('download --displayed', () => {
  test('keeps the work on screen by index and id, then waits on the source the FF1 returns', async () => {
    const d = deps((cast) => {
      switch (cast.command) {
        case 'checkStatus':
          return playing(1, twoWorks);
        case 'downloadPlaylistItem':
          return { ok: true, status: 'queued', source: B };
        default:
          return {
            ok: true,
            items: [
              { source: B, state: 'ready', percent: 100, bytes: 2048, coverageComplete: true },
            ],
          };
      }
    });

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, true, result.error);
    assert.deepEqual(
      d.casts.map((cast) => cast.command),
      ['checkStatus', 'downloadPlaylistItem', 'getOfflineCacheStatus']
    );
    assert.deepEqual(d.casts[1].request, { displayed: { index: 1, id: 'id-b' } });
    assert.deepEqual(d.casts[2].request, { sources: [B] });
    assert.equal(result.items?.[0].title, 'Work B');
    assert.equal(result.items?.[0].outcome, 'ready');
  });

  test('--index picks another work in the list', async () => {
    const d = deps((cast) =>
      cast.command === 'checkStatus'
        ? playing(1, twoWorks)
        : { ok: true, status: 'queued', source: A }
    );

    const result = await downloadDisplayed({ wait: false, index: 0 }, d);

    assert.equal(result.success, true, result.error);
    assert.deepEqual(d.casts[1].request, { displayed: { index: 0, id: 'id-a' } });
    assert.equal(result.waited, false);
  });

  test('a work with no id is refused before anything is queued', async () => {
    const d = deps(() => playing(0, [{ title: 'No id', source: A }]));

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /no id/);
    assert.deepEqual(
      d.casts.map((cast) => cast.command),
      ['checkStatus']
    );
  });

  test('nothing on display, or an index past the end, is refused', async () => {
    for (const [status, index] of [
      [{ ok: true }, undefined],
      [playing(0, twoWorks), 5],
    ] as const) {
      const d = deps(() => status);
      const result = await downloadDisplayed({ wait: true, index }, d);
      assert.equal(result.success, false);
      assert.deepEqual(
        d.casts.map((cast) => cast.command),
        ['checkStatus']
      );
    }
  });

  test('the display changing in between is reported as such', async () => {
    const d = deps((cast) =>
      cast.command === 'checkStatus'
        ? playing(0, twoWorks)
        : {
            ok: false,
            error: { code: 'not_found', message: 'the item is not on display', retryable: false },
          }
    );

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /moved on|changed/);
  });

  test('an FF OS without the selector says the FF OS is too old', async () => {
    const d = deps((cast) =>
      cast.command === 'checkStatus'
        ? playing(0, twoWorks)
        : {
            ok: false,
            error: { code: 'invalid_request', message: 'source is required', retryable: false },
          }
    );

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /FF OS/);
  });

  test('an inline work is not reported as held: nothing says what it loads is kept', async () => {
    const inline = 'data:text/html;base64,PGh0bWw+';
    const d = deps((cast) =>
      cast.command === 'checkStatus'
        ? playing(0, [{ id: 'id-i', title: 'Inline', source: inline }])
        : { ok: true, status: 'not_queued_inline', source: inline }
    );

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /inline/);
  });

  test('the source never reaches a message: the untitled label is redacted', async () => {
    const d = deps((cast) => {
      switch (cast.command) {
        case 'checkStatus':
          return playing(0, [{ id: 'id-a', source: A }]);
        case 'downloadPlaylistItem':
          return { ok: true, status: 'queued', source: A };
        default:
          return {
            ok: true,
            items: [{ source: A, state: 'ready', percent: 100, coverageComplete: true }],
          };
      }
    });

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, true, result.error);
    assert.doesNotMatch(result.items?.[0].title ?? '', /secret/);
  });

  test('a URL cast whose live document dropped the work is reported as moved on', async () => {
    const d = deps((cast) =>
      cast.command === 'checkStatus'
        ? playing(0, twoWorks)
        : {
            ok: false,
            error: { code: 'not_found', message: 'source not found in playlist', retryable: false },
          }
    );

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /moved on/);
  });

  test('a work the FF1 reports with no source is refused before anything is sent', async () => {
    const d = deps(() => playing(0, [{ id: 'id-a', title: 'Work A' }]));

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /no source/);
    assert.deepEqual(
      d.casts.map((cast) => cast.command),
      ['checkStatus']
    );
  });

  test('a failed status read says it was the read that failed', async () => {
    const d = deps(() => ({ ok: false, error: 'overheating' }));

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Could not read what Kitchen is displaying/);
  });

  test('a failed status read keeps the reason and the follow-up', async () => {
    const d = deps(() => {
      throw new Error('connect ECONNREFUSED 10.0.0.2:1111');
    });

    const result = await downloadDisplayed({ wait: true }, d);

    assert.equal(result.success, false);
    assert.match(
      result.error ?? '',
      /Could not read what Kitchen is displaying: Could not reach Kitchen/
    );
    assert.match(result.details ?? '', /ECONNREFUSED/);
  });
});
