import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientDeviceNetworkError } from '../src/utilities/ff1-device';
import { isConnectPhaseNetworkError } from '../src/utilities/device-network';

describe('isConnectPhaseNetworkError', () => {
  it('accepts failures that prove the request was never sent', () => {
    for (const cause of [
      { code: 'ECONNREFUSED' },
      { code: 'EHOSTUNREACH' },
      { code: 'ENOTFOUND' },
      { code: 'EAI_AGAIN' },
      { code: 'UND_ERR_CONNECT_TIMEOUT' },
      { code: 'ETIMEDOUT', syscall: 'connect' },
      { code: 'EHOSTDOWN', syscall: 'connect' },
      { code: 'ENETDOWN', syscall: 'connect' },
      { errors: [{ code: 'ECONNREFUSED' }, { code: 'ENETUNREACH' }] },
    ]) {
      assert.equal(isConnectPhaseNetworkError(new Error('fetch failed', { cause })), true);
    }
  });

  it('rejects failures that may follow a delivered request', () => {
    for (const cause of [
      undefined,
      { code: 'ECONNRESET' },
      { code: 'UND_ERR_SOCKET' },
      { code: 'ETIMEDOUT', syscall: 'read' },
      { code: 'EHOSTDOWN', syscall: 'write' },
    ]) {
      assert.equal(isConnectPhaseNetworkError(new Error('fetch failed', { cause })), false);
    }
  });
});

describe('isTransientDeviceNetworkError', () => {
  it('returns true for undici fetch failed resolver errors', () => {
    const error = new Error('fetch failed', {
      cause: { code: 'ENOTFOUND' },
    });

    assert.equal(isTransientDeviceNetworkError(error), true);
  });

  it('returns true for no-route message', () => {
    const error = new Error('connect EHOSTUNREACH: No route to host');

    assert.equal(isTransientDeviceNetworkError(error), true);
  });

  it('returns false for non-network errors', () => {
    const error = new Error('Unexpected token < in JSON at position 0');

    assert.equal(isTransientDeviceNetworkError(error), false);
  });
});
