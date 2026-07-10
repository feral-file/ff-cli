export interface DeviceEntry {
  host: string;
  name?: string;
  /** mDNS device ID (e.g. 'ff1-hh9jsnoc'). Stored so host-change lookups can match by ID. */
  id?: string;
  apiKey?: string;
  /** Resolved IP addresses last observed for this device. Stored so --host <ip> can match
   *  an existing .local entry without requiring a new mDNS scan. */
  addresses?: string[];
}

/**
 * Strip undefined values from an object so spreads do not overwrite existing
 * keys with undefined (e.g. when a caller passes id: undefined because the
 * device was discovered without an ID).
 */
function withoutUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Apply a patch to an entry.
 *
 * Addresses are handled specially:
 *  - Incoming non-empty: replace (fresh discovery data supersedes stale IPs).
 *  - Host changed, no incoming addresses: clear (stale IPs belonged to the old
 *    network location; keeping them lets --host <old-ip> match the wrong device
 *    after DHCP churn or a partial avahi timeout that omits the address field).
 *  - Same host, no incoming addresses: keep existing (--host path provides no
 *    addresses; the stored set must be preserved so reverse IP lookup still works).
 *
 * Dual-stack accumulation (IPv4 + IPv6) is handled upstream by parseAvahiBrowseOutput
 * before upsertDevice is called, so the full address set is always present in a single
 * invocation.
 */
function applyPatch(existing: DeviceEntry, patch: Partial<DeviceEntry>): DeviceEntry {
  const hostChanged = patch.host !== undefined && patch.host !== existing.host;
  let addresses: string[] | undefined;
  if (patch.addresses && patch.addresses.length > 0) {
    addresses = patch.addresses; // fresh data: replace
  } else if (hostChanged) {
    addresses = undefined; // host changed, no new IPs: clear stale addresses
  } else {
    addresses = existing.addresses; // same host, no new IPs: keep stored set
  }
  const updated = { ...existing, ...patch };
  // Rebuild the row from supported fields so an old plaintext topicID cannot
  // survive a normal device update. Topics now belong exclusively in the OS
  // credential vault under the stable device ID.
  return {
    host: updated.host,
    name: updated.name,
    id: updated.id,
    apiKey: updated.apiKey,
    addresses,
  };
}

/**
 * Insert or update a device in the configured device list.
 *
 * Priority:
 * 0. matchedIndex provided — caller already resolved the row via findExistingDeviceEntry;
 *    update that position directly. Handles rename + host-change combos where none of
 *    the id/name/host heuristics below would find the correct row.
 * 1. Same mDNS device ID → update in-place (preserves position, handles host change).
 * 2. Same host → update in-place (preserves position and metadata).
 * 3. Same name, different host → replace in-place (preserves position so that
 *    devices[0] — the implicit default for play/send/ssh — does not silently change).
 * 4. Neither match → append.
 */
export function upsertDevice(
  existingDevices: DeviceEntry[],
  newDevice: {
    name: string;
    host: string;
    id?: string;
    apiKey?: string;
    addresses?: string[];
  },
  /** Pre-resolved row index from findExistingDeviceEntry. When provided, the
   *  heuristics below are skipped and this row is updated directly. */
  matchedIndex?: number
): { devices: DeviceEntry[]; updated: boolean } {
  const devices = [...existingDevices];
  const patch = withoutUndefined(newDevice);

  // Case 0: caller already resolved the match — update directly.
  if (matchedIndex !== undefined && matchedIndex >= 0 && matchedIndex < devices.length) {
    const isSameHost = devices[matchedIndex].host === newDevice.host;
    devices[matchedIndex] = applyPatch(devices[matchedIndex], patch);
    return { devices, updated: isSameHost };
  }

  // Case 1: same mDNS device ID — update in-place even when host changed.
  if (newDevice.id) {
    const sameIdIndex = devices.findIndex((d) => d.id === newDevice.id);
    if (sameIdIndex !== -1) {
      const isSameHost = devices[sameIdIndex].host === newDevice.host;
      devices[sameIdIndex] = applyPatch(devices[sameIdIndex], patch);
      return { devices, updated: isSameHost };
    }
  }

  // Case 2: same host — update in-place
  const sameHostIndex = devices.findIndex((d) => d.host === newDevice.host);
  if (sameHostIndex !== -1) {
    devices[sameHostIndex] = applyPatch(devices[sameHostIndex], patch);
    return { devices, updated: true };
  }

  // Case 3: same name, different host — replace in-place to preserve array order.
  // Spread existing entry first so non-secret device metadata survives a host change.
  const staleNameIndex = devices.findIndex((d) => d.name === newDevice.name);
  if (staleNameIndex !== -1) {
    devices[staleNameIndex] = applyPatch(devices[staleNameIndex], patch);
    return { devices, updated: false };
  }

  // Case 4: new device
  devices.push({ ...patch } as DeviceEntry);
  return { devices, updated: false };
}
