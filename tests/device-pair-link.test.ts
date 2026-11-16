/**
 * The pairing link `device pair` prints is the app link the Feral File app
 * opens at Add controller (ff-app `ff1ControllerCodeLink`). An owner taps it
 * or scans it with a phone's own camera; the bare `ff1-ctl:1|…` payload only
 * works inside the app's scanner, which the owner has to find first.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { controllerApprovalLink, qrFits, waitLabel } from '../src/commands/helpers/device-control';
import { DEFAULT_PAIR_TIMEOUT_MS, MAX_PAIR_TIMEOUT_MS } from '../src/utilities/control/pairing';

const PAYLOAD = 'ff1-ctl:1|27408f00-140d-46bc-8cc2-666e6a0e5c3e|BDpY_-|cli|sean & co #1';

describe('controllerApprovalLink', () => {
  test('puts the device and the encoded payload in the fragment', () => {
    const link = controllerApprovalLink(PAYLOAD, 'FF1-NFZMNQSP');
    const [base, fragment] = link.split('#');
    assert.equal(base, 'https://link.feralfile.com/controller');
    const values = Object.fromEntries(
      fragment.split('&').map((pair) => {
        const eq = pair.indexOf('=');
        return [pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1))];
      })
    );
    assert.deepEqual(values, { d: 'FF1-NFZMNQSP', c: PAYLOAD });
  });

  test('leaves no raw separator in a value, whatever the label holds', () => {
    const fragment = controllerApprovalLink(PAYLOAD, 'FF1-NFZMNQSP').split('#')[1];
    // Exactly the two key separators and the one pair separator.
    assert.equal(fragment.split('=').length - 1, 2);
    assert.equal(fragment.split('&').length - 1, 1);
    assert.ok(!fragment.includes('|') && !fragment.includes(' '));
  });

  test('names the device as the app knows it when discovery stored lower case', () => {
    const link = controllerApprovalLink(PAYLOAD, ' ff1-nfzmnqsp ');
    assert.ok(link.startsWith('https://link.feralfile.com/controller#d=FF1-NFZMNQSP&c='));
  });

  test('omits a device id the app would refuse, so the owner picks instead', () => {
    const link = controllerApprovalLink(PAYLOAD, 'not a device id!');
    assert.ok(link.startsWith('https://link.feralfile.com/controller#c='));
  });
});

describe('pairing wait', () => {
  test('defaults to the longest wait the relay allows', () => {
    assert.equal(DEFAULT_PAIR_TIMEOUT_MS, MAX_PAIR_TIMEOUT_MS);
  });
});

describe('what device pair prints around the link', () => {
  test('states the wait exactly, never rounded to another length', () => {
    assert.equal(waitLabel(600_000), '10 minutes');
    assert.equal(waitLabel(60_000), '1 minute');
    assert.equal(waitLabel(10_000), '10 seconds');
    assert.equal(waitLabel(90_000), '90 seconds');
  });

  test('draws the code only where it fits the terminal', () => {
    const qr = ['█'.repeat(83), '█'.repeat(83)].join('\n');
    assert.equal(qrFits(qr, 80), false);
    assert.equal(qrFits(qr, 83), true);
    // A terminal that does not report its width is given the code.
    assert.equal(qrFits(qr, undefined), true);
  });
});
