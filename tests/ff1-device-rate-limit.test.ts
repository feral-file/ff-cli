import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryAfterMs } from '../src/utilities/ff1-device';

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds into milliseconds', () => {
    assert.equal(parseRetryAfterMs('5'), 5000);
    assert.equal(parseRetryAfterMs(' 0 '), 0);
    assert.equal(parseRetryAfterMs('120'), 120000);
  });

  it('parses an HTTP-date into a non-negative delay', () => {
    const future = new Date(Date.now() + 10000).toUTCString();
    const ms = parseRetryAfterMs(future);
    assert.ok(ms !== undefined);
    // Allow scheduling slack: should be within a couple seconds of 10s.
    assert.ok(ms! > 7000 && ms! <= 11000, `unexpected delay ${ms}`);
  });

  it('clamps a past HTTP-date to 0 (retry immediately)', () => {
    const past = new Date(Date.now() - 60000).toUTCString();
    assert.equal(parseRetryAfterMs(past), 0);
  });

  it('returns undefined for absent or unparseable values', () => {
    assert.equal(parseRetryAfterMs(null), undefined);
    assert.equal(parseRetryAfterMs(undefined), undefined);
    assert.equal(parseRetryAfterMs(''), undefined);
    assert.equal(parseRetryAfterMs('soon'), undefined);
    assert.equal(parseRetryAfterMs('-5'), undefined);
  });
});
