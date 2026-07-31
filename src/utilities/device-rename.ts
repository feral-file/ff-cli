import { findConfiguredDeviceIndex } from './device-lookup';
import type { DeviceEntry } from './device-upsert';

export interface RenameDeviceResult {
  devices: DeviceEntry[];
  renamed: DeviceEntry;
  /** Previous name of the renamed entry (undefined for unnamed legacy entries). */
  previousName?: string;
  /** True when the entry already had exactly the requested name; callers can skip persisting. */
  unchanged: boolean;
}

/**
 * Rename a configured device without touching host, apiKey, topicID, or list
 * position — a pure config edit that needs no discovery or network access
 * (unlike `device add`, whose update path requires the host or mDNS).
 *
 * Matches by name (case-insensitive) or by host URL, mirroring `device remove`
 * so unnamed legacy entries can still be targeted (renaming gives them a name
 * for the first time).
 *
 * @throws {Error} When no device matches the identifier, the new name is
 *   empty, or the new name is already used by a different device
 *   (case-insensitive, so lookups elsewhere stay unambiguous).
 */
export function renameDevice(
  devices: DeviceEntry[],
  identifier: string,
  newName: string
): RenameDeviceResult {
  const trimmedName = newName.trim();
  if (!trimmedName) {
    throw new Error('New device name must not be empty');
  }

  const index = findConfiguredDeviceIndex(devices, identifier);

  if (index === -1) {
    throw new Error(`Device "${identifier}" not found`);
  }

  const conflict = devices.find(
    (d, i) => i !== index && d.name && d.name.toLowerCase() === trimmedName.toLowerCase()
  );
  if (conflict) {
    throw new Error(
      `Device name "${trimmedName}" is already used by another device (${conflict.host})`
    );
  }

  const target = devices[index];
  if (target.name === trimmedName) {
    return { devices: [...devices], renamed: target, previousName: target.name, unchanged: true };
  }

  const updated = [...devices];
  updated[index] = { ...target, name: trimmedName };
  return { devices: updated, renamed: updated[index], previousName: target.name, unchanged: false };
}
