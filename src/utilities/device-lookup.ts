import { normalizeDeviceHost } from './device-normalize';

/**
 * Find an existing configured device that corresponds to a newly discovered host.
 *
 * Priority (most reliable to least):
 *  1. mDNS device ID match — the device's stable hardware identity. Checked first
 *     so a stale row that happens to share the same IP cannot shadow the correct
 *     entry. Requires the stored entry to have been written with an id field.
 *  2. Exact URL match — normal case after ID (same host format, no migration).
 *  3. mDNS hostname component match — both URLs are parsed and only the hostname
 *     part is compared (same .local name, different underlying IP or port).
 *  4a. Discovered IP → stored IP: the mDNS discovery reports a resolved IP that
 *     matches the IP in a stored entry. Bridges .local ↔ stored-IP migration for
 *     pre-id configs with no stored id.
 *  4b. New-host IP → stored addresses: the caller provides an IP host (e.g. from
 *     --host <ip>) and a stored entry has that IP in its addresses list. Bridges
 *     the reverse direction (.local stored, IP provided by the user).
 *  5. TXT-name match — if the device advertises a name that matches a stored
 *     friendly name, treat them as the same device (last-resort fallback for
 *     configs written before the id field existed).
 *
 * Returns the matched entry so callers can preserve the stored friendly name as
 * the default when prompting, rather than falling back to the raw mDNS label.
 */
export function findExistingDeviceEntry(
  existingDevices: Array<{ host?: string; name?: string; id?: string; addresses?: string[] }>,
  newHost: string,
  discoveredName: string,
  discoveredId?: string,
  discoveredAddresses?: string[]
): { host?: string; name?: string; id?: string; addresses?: string[] } | undefined {
  const sameDeviceId = (left?: string, right?: string) =>
    Boolean(left && right && left.trim().toUpperCase() === right.trim().toUpperCase());
  // 1. mDNS device ID — stable hardware identity, checked before URL so stale
  //    host entries for other devices at the same IP do not shadow the result.
  if (discoveredId) {
    const byId = existingDevices.find((d) => sameDeviceId(d.id, discoveredId));
    if (byId) {
      return byId;
    }
  }

  // 2. Exact URL match
  const byHost = existingDevices.find((d) => d.host === newHost);
  if (byHost) {
    return byHost;
  }

  // 3. mDNS hostname component match (ignores port and protocol differences)
  let newHostname = '';
  try {
    newHostname = new URL(newHost).hostname;
  } catch {
    // not a valid URL — skip hostname matching
  }

  if (newHostname) {
    const byHostname = existingDevices.find((d) => {
      try {
        return new URL(d.host || '').hostname === newHostname;
      } catch {
        return false;
      }
    });
    if (byHostname) {
      return byHostname;
    }
  }

  // Node.js URL.hostname wraps IPv6 addresses in brackets: [fe80::1].
  // Strip them so comparisons work against the bracket-free strings stored in addresses[].
  const stripBrackets = (h: string) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);

  // 4a. Discovered IP → stored IP: mDNS reported addresses include the stored entry's IP.
  //     Skip only when both the stored entry AND the discovered device carry an id that
  //     differs — in that case the devices are provably distinct. If discoveredId is absent
  //     (partial avahi result, --host path) allow the address match regardless of whether
  //     the stored entry has an id; the address is the best identity signal available.
  if (discoveredAddresses && discoveredAddresses.length > 0) {
    const byDiscoveredAddress = existingDevices.find((d) => {
      if (d.id && discoveredId && !sameDeviceId(d.id, discoveredId)) {
        return false; // different physical devices — do not conflate
      }
      try {
        const storedIp = stripBrackets(new URL(d.host || '').hostname);
        return discoveredAddresses.includes(storedIp);
      } catch {
        return false;
      }
    });
    if (byDiscoveredAddress) {
      return byDiscoveredAddress;
    }
  }

  // 4b. New-host IP → stored addresses: the new host is an IP URL (IPv4 or IPv6)
  //     and a stored entry has that IP in its stored addresses list (populated from
  //     prior mDNS discoveries). This bridges --host <ip/ipv6> → existing .local entry.
  //     Strip IPv6 brackets before comparing (Node URL.hostname returns '[fe80::1]').
  const rawHostname = stripBrackets(newHostname);
  if (rawHostname && (/^[0-9.]+$/.test(rawHostname) || rawHostname.includes(':'))) {
    const byStoredAddress = existingDevices.find((d) => d.addresses?.includes(rawHostname));
    if (byStoredAddress) {
      return byStoredAddress;
    }
  }

  // 5. TXT-name match — only for entries WITHOUT a stored id.
  //    If a stored entry already has an id and it did not match in step 1, then
  //    the discovered device is a physically distinct device that merely advertises
  //    the same friendly name; matching by name alone would resolve to the wrong row
  //    and cause upsertDevice to overwrite a different device.
  if (discoveredName) {
    return existingDevices.find((d) => !d.id && d.name === discoveredName);
  }

  return undefined;
}

/**
 * Find the index of a configured device by a user-supplied identifier.
 *
 * Matches by friendly name (case-insensitive) or by host URL — raw or
 * normalized — so unnamed legacy/manual entries (stored without a name field)
 * can still be targeted. Shared by `device remove`, `device default`,
 * `device rename`, and runtime `-d` resolution so every surface answers to
 * the same identifier the same way.
 *
 * Returns -1 when nothing matches.
 */
export function findConfiguredDeviceIndex(
  devices: Array<{ host?: string; name?: string }>,
  identifier: string
): number {
  const normalizedArg = identifier.toLowerCase();
  let normalizedArgHost = '';
  try {
    normalizedArgHost = normalizeDeviceHost(identifier).toLowerCase();
  } catch {
    // not a valid URL — host matching will not apply
  }

  return devices.findIndex(
    (d) =>
      (d.name && d.name.toLowerCase() === normalizedArg) ||
      (d.host && d.host.toLowerCase() === normalizedArg) ||
      (normalizedArgHost &&
        d.host &&
        normalizeDeviceHost(d.host).toLowerCase() === normalizedArgHost)
  );
}
