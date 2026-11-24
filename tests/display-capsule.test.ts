import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capsuleRequest, displayCapsule, isCapsuleFile } from '../src/utilities/capsule-cast';

const signer = 'did:key:z6MkkVAm5Y3spTzraoQCQXnvT7CPk4xPihbocrMu3DH6wkgW';

test('capsule dispatch recognizes file paths and leaves URLs to normal display', () => {
  assert.equal(isCapsuleFile('./work.DP1C'), true);
  assert.equal(isCapsuleFile('https://example.com/work.dp1c'), false);
  assert.equal(isCapsuleFile('./work.json'), false);
});

test('capsule request carries the original archive and detached signature', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-cli-capsule-'));
  try {
    const file = join(dir, 'work.dp1c');
    const body = Buffer.from([0, 42, 255]);
    const signature = { capsuleId: 'test', signatures: [{ kid: signer }] };
    writeFileSync(file, body);
    await assert.rejects(capsuleRequest(file, signer), /signature/i);
    writeFileSync(file + '.sig.json', JSON.stringify(signature));
    assert.deepEqual(await capsuleRequest(file, signer), {
      capsule: body.toString('base64'),
      signature,
      signer,
    });
    await assert.rejects(capsuleRequest(file, undefined), /--signer/);
    writeFileSync(file, Buffer.alloc(1536 * 1024 + 1));
    await assert.rejects(capsuleRequest(file, signer), /size limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an inner player rejection fails the capsule command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-cli-capsule-'));
  try {
    const file = join(dir, 'work.dp1c');
    writeFileSync(file, 'fixture');
    writeFileSync(file + '.sig.json', JSON.stringify({ signatures: [{ kid: signer }] }));
    const device = { host: 'http://192.0.2.1:1111', id: 'FF1-TEST', name: 'trial' };
    const record = { role: 'owner' } as NonNullable<
      ReturnType<
        typeof import('../src/utilities/control/secure-transport').findSecureController
      >['record']
    >;
    let response = { ok: false, error: 'native player lacks offlineCapsule.v1' };
    const deps = {
      resolve: () => ({ success: true, device }),
      controller: () => ({ record }),
      send: async (
        input: Parameters<
          typeof import('../src/utilities/control/secure-transport').runSecureCommand
        >[0]
      ) => {
        assert.equal(input.cmd, 'displayCapsule');
        assert.equal(input.relayerFallback, false);
        assert.equal(input.retry, false);
        return { success: true, response: { message: response } };
      },
    };
    await assert.rejects(displayCapsule(file, signer, undefined, deps), /native player lacks/);
    response = { ok: true, error: '' };
    assert.equal(await displayCapsule(file, signer, undefined, deps), device);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
