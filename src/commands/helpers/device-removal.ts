import type { Config, FF1Device } from '../../types';
import { deleteTopicId, getTopicId } from '../../utilities/topic-store';

interface DeviceRemovalDependencies {
  persistConfig: (config: Config) => Promise<void>;
  getTopicId?: (deviceId: string) => string | null;
  deleteTopicId?: (deviceId: string) => boolean;
  warn?: (message: string) => void;
}

interface DeviceRemovalResult {
  removed: FF1Device;
  updatedDevices: FF1Device[];
}

/**
 * persistDeviceRemoval saves the authoritative config change before attempting
 * best-effort credential cleanup.
 *
 * The operating-system credential vault can be locked or temporarily
 * unavailable. That must not trap a stale device in config.json; the user can
 * remove the orphaned credential later after the vault becomes available.
 *
 * @param {Config} config - Parsed CLI configuration to update
 * @param {number} deviceIndex - Index of the configured device to remove
 * @param {DeviceRemovalDependencies} dependencies - Persistence and credential operations
 * @returns {Promise<DeviceRemovalResult>} Removed device and remaining device list
 */
export async function persistDeviceRemoval(
  config: Config,
  deviceIndex: number,
  dependencies: DeviceRemovalDependencies
): Promise<DeviceRemovalResult> {
  const existingDevices = config.ff1Devices?.devices ?? [];
  const removed = existingDevices[deviceIndex];
  if (!removed) {
    throw new Error('Configured FF1 device no longer exists');
  }

  const updatedDevices = existingDevices.filter((_, index) => index !== deviceIndex);
  config.ff1Devices = { devices: updatedDevices };
  await dependencies.persistConfig(config);

  if (removed.id) {
    try {
      const readTopic = dependencies.getTopicId ?? getTopicId;
      const deleteTopic = dependencies.deleteTopicId ?? deleteTopicId;
      if (readTopic(removed.id)) {
        deleteTopic(removed.id);
      }
    } catch {
      (dependencies.warn ?? console.warn)(
        'Warning: device was removed, but its secure topic credential could not be deleted.'
      );
    }
  }

  return { removed, updatedDevices };
}
