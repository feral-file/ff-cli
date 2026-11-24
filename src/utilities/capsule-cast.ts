import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { findSecureController, runSecureCommand } from './control/secure-transport';
import { resolveConfiguredDevice } from './ff1-compatibility';
import { isPlaylistSourceUrl } from './playlist-source';

const CAPSULE_LIMIT = 1536 * 1024;
const SIDECAR_LIMIT = 8 * 1024;

const defaults = {
  resolve: resolveConfiguredDevice,
  controller: findSecureController,
  send: runSecureCommand,
};

/** isCapsuleFile identifies local capsule arguments without intercepting web URLs. */
export function isCapsuleFile(source: string): boolean {
  return !isPlaylistSourceUrl(source) && extname(source).toLowerCase() === '.dp1c';
}

/** readBoundedFile reads a regular file without buffering beyond the wire limit. */
async function readBoundedFile(path: string, limit: number, label: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new Error(`Cannot open ${label}: ${path}`);
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > limit) {
      throw new Error(
        `${label} must be a nonempty regular file within the ${limit}-byte size limit.`
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of file.createReadStream({ end: limit, autoClose: false })) {
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length === 0 || bytes.length > limit) {
      throw new Error(`${label} is empty or exceeds its size limit.`);
    }
    return bytes;
  } finally {
    await file.close();
  }
}

/** capsuleRequest prepares the original archive and sidecar for controld to verify. */
export async function capsuleRequest(file: string, signer: string | undefined) {
  if (!signer || !/^did:key:z[1-9A-HJ-NP-Za-km-z]{46,60}$/.test(signer)) {
    throw new Error('Capsule display requires --signer <expected Ed25519 did:key>.');
  }
  const capsule = await readBoundedFile(file, CAPSULE_LIMIT, 'capsule');
  const sidecar = await readBoundedFile(file + '.sig.json', SIDECAR_LIMIT, 'capsule signature');
  let signature: unknown;
  try {
    signature = JSON.parse(sidecar.toString('utf8'));
  } catch {
    throw new Error('Capsule signature sidecar is invalid JSON.');
  }
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    throw new Error('Capsule signature sidecar must be a JSON object.');
  }
  return { capsule: capsule.toString('base64'), signature, signer };
}

/** displayCapsule sends a capsule once over the enrolled owner LAN channel. */
export async function displayCapsule(
  file: string,
  signer: string | undefined,
  deviceName?: string,
  deps = defaults
) {
  const req = await capsuleRequest(file, signer);
  const selected = deps.resolve(deviceName);
  const device = selected.device;
  if (!selected.success || !device) {
    throw new Error(selected.error || 'FF1 device is not configured correctly.');
  }
  const { record, failure } = deps.controller(device);
  if (failure) {
    throw new Error([failure.error, failure.details].filter(Boolean).join(' '));
  }
  if (!device.id || record?.role !== 'owner') {
    throw new Error('Capsule display requires ff-cli to be paired as an owner of this FF1.');
  }
  const result = await deps.send({
    device: { ...device, id: device.id },
    record,
    cmd: 'displayCapsule',
    req,
    relayerFallback: false,
    retry: false,
  });
  if (!result.success) {
    throw new Error([result.error, result.details].filter(Boolean).join(' '));
  }
  const message = result.response?.message as { ok?: unknown; error?: unknown } | undefined;
  if (message?.ok !== true) {
    throw new Error(
      typeof message?.error === 'string' ? message.error : 'FF1 did not accept the capsule.'
    );
  }
  return device;
}
