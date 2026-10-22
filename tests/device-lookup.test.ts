/**
 * Regression tests for findExistingDeviceEntry.
 *
 * When a device comes back on a new host URL (e.g., IP→mDNS hostname or
 * a DHCP IP change), setup and device-add must still find the stored entry
 * so they can default the name prompt to the stored friendly label rather
 * than the raw mDNS service name, and so upsertDevice updates in-place
 * instead of appending a duplicate.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findExistingDeviceEntry } from '../src/utilities/device-lookup';
import { upsertDevice } from '../src/utilities/device-upsert';

describe('findExistingDeviceEntry', () => {
  test('exact host match returns the entry', () => {
    const devices = [{ name: 'kitchen', host: 'http://ff1-hh9jsnoc.local:1111' }];
    const result = findExistingDeviceEntry(devices, 'http://ff1-hh9jsnoc.local:1111', '');
    assert.equal(result?.name, 'kitchen');
  });

  // Regression: IP ↔ .local — the primary unresolved case.
  // Device was stored with an IP; it is now rediscovered via its .local hostname.
  // Without a stored id, only TXT-name or hostname matching can bridge the gap.
  // WITH a stored id (e.g. 'ff1-hh9jsnoc'), identity matching resolves it.
  test('IP ↔ .local: stored entry found via discoveredId when host format changed', () => {
    const devices = [{ name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-hh9jsnoc' }];
    const result = findExistingDeviceEntry(
      devices,
      'http://ff1-hh9jsnoc.local:1111', // rediscovered via .local hostname
      'ff1-hh9jsnoc', // discoveredName
      'ff1-hh9jsnoc' // discoveredId — matches stored id
    );
    assert.equal(result?.name, 'kitchen');
  });

  test('IP ↔ .local: stored entry found via TXT name when id not yet stored', () => {
    // Older config entry without id field; TXT-name match is the fallback
    const devices = [{ name: 'kitchen', host: 'http://192.168.1.10:1111' }];
    const result = findExistingDeviceEntry(
      devices,
      'http://ff1-hh9jsnoc.local:1111',
      'kitchen', // TXT record advertises name=kitchen
      'ff1-hh9jsnoc'
    );
    assert.equal(result?.name, 'kitchen');
  });

  test('.local same hostname: stored entry found even when port/protocol differs', () => {
    const devices = [{ name: 'kitchen', host: 'http://ff1-hh9jsnoc.local:1111' }];
    // Same mDNS hostname, different port (edge case)
    const result = findExistingDeviceEntry(devices, 'http://ff1-hh9jsnoc.local:2222', '');
    assert.equal(result?.name, 'kitchen');
  });

  test('IP host: the same address on another port is a different device', () => {
    // Several FF1s can sit behind one address on different ports (port forwarding, a tunnel).
    const devices = [{ host: 'http://127.0.0.1:18131', name: 'Art Computer' }];
    const result = findExistingDeviceEntry(devices, 'http://127.0.0.1:18132', '');
    assert.equal(result, undefined);
  });

  test('IP host: a remembered address on another port is a different device', () => {
    const devices = [
      { host: 'http://192.168.1.20:1111', name: 'office', addresses: ['192.168.1.20'] },
    ];
    assert.equal(findExistingDeviceEntry(devices, 'http://192.168.1.20:2222', ''), undefined);
  });

  test("IP host: a .local entry's remembered address on another port is a different device", () => {
    const devices = [
      { host: 'http://ff1.local:1111', name: 'office', addresses: ['192.168.1.10'] },
    ];
    assert.equal(findExistingDeviceEntry(devices, 'http://192.168.1.10:18132', ''), undefined);
  });

  test('IP host: a remembered address on the same port still matches a .local entry', () => {
    const devices = [
      { host: 'http://ff1-abcd1234.local:1111', name: 'office', addresses: ['192.168.1.20'] },
    ];
    assert.equal(findExistingDeviceEntry(devices, 'http://192.168.1.20:1111', '')?.name, 'office');
  });

  test('IP host: the same address and port still matches across protocols', () => {
    const devices = [{ host: 'http://192.168.1.20:1111', name: 'office' }];
    const result = findExistingDeviceEntry(devices, 'https://192.168.1.20:1111', '');
    assert.equal(result?.name, 'office');
  });

  test('TXT-name match: stored entry found by discoveredName when host completely changed', () => {
    // No stored id — TXT-name fallback applies
    const devices = [{ name: 'kitchen', host: 'http://192.168.1.10:1111' }];
    const result = findExistingDeviceEntry(devices, 'http://10.0.0.99:1111', 'kitchen');
    assert.equal(result?.name, 'kitchen');
  });

  // Regression: a different physical device (different id) that merely advertises the same
  // friendly name must NOT match via TXT-name fallback. If it did, upsertDevice case-3
  // would overwrite the existing entry instead of adding a new row.
  test('TXT-name fallback is skipped when stored entry has an id (different physical device)', () => {
    const devices = [{ name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-aaa' }];
    // Completely different device: different id, different host, but same TXT name
    const result = findExistingDeviceEntry(
      devices,
      'http://192.168.1.99:1111',
      'kitchen', // TXT name matches — but this is a different device
      'ff1-ccc' // different id → id check (step 1) won't match; step 5 must also refuse
    );
    assert.equal(
      result,
      undefined,
      'different device must not match via TXT-name when stored entry has id'
    );
  });

  // Regression: pre-id config (no stored id, curated name) + mDNS label doesn't match
  // the friendly name. Without address-based matching, findExistingDeviceEntry() falls
  // through all checks and returns undefined → upsertDevice() appends a duplicate.
  test('IP ↔ .local: stored entry found via resolved IP address when id and TXT name both absent', () => {
    // Legacy config: no id, curated name that doesn't match the raw mDNS label
    const devices = [{ name: 'kitchen', host: 'http://192.168.1.10:1111' }];
    const result = findExistingDeviceEntry(
      devices,
      'http://ff1-hh9jsnoc.local:1111', // new .local host
      'ff1-hh9jsnoc', // raw mDNS label — does NOT match stored name 'kitchen'
      'ff1-hh9jsnoc', // discoveredId — not stored, so id check won't find it
      ['192.168.1.10'] // avahi-reported IP matches the stored entry's host
    );
    assert.equal(result?.name, 'kitchen');
  });

  // Regression: stored IP must be found even when it is not the first address in the list.
  test('IP ↔ .local: stored entry found when stored IP is not the first discovered address', () => {
    const devices = [{ name: 'kitchen', host: 'http://192.168.1.10:1111' }];
    const result = findExistingDeviceEntry(
      devices,
      'http://ff1-hh9jsnoc.local:1111',
      'ff1-hh9jsnoc',
      'ff1-hh9jsnoc',
      ['fe80::1', '192.168.1.10'] // stored IP is second in list
    );
    assert.equal(result?.name, 'kitchen');
  });

  // Regression: --host <ip> path provides no discoveredAddresses; the match must work
  // via the stored addresses on the .local entry (written during the prior mDNS setup).
  test('IP host with no discoveredAddresses matches stored .local entry via stored addresses', () => {
    // Stored from a prior mDNS-based device add: .local host + addresses persisted
    const devices = [
      {
        name: 'kitchen',
        host: 'http://ff1-hh9jsnoc.local:1111',
        id: 'ff1-hh9jsnoc',
        addresses: ['192.168.1.10'],
      },
    ];
    const result = findExistingDeviceEntry(
      devices,
      'http://192.168.1.10:1111', // user ran: ff1 device add --host 192.168.1.10
      '', // no discoveredName
      undefined, // no discoveredId (--host path skips discovery)
      undefined // no discoveredAddresses (--host path skips discovery)
    );
    assert.equal(result?.name, 'kitchen');
  });

  // Regression: IPv6 hosts use colons, not dots; the /^[0-9.]+$/ guard must not
  // skip them for the stored-address fallback.
  test('IPv6 host with no discoveredAddresses matches stored .local entry via stored addresses', () => {
    const devices = [
      {
        name: 'kitchen',
        host: 'http://ff1-hh9jsnoc.local:1111',
        id: 'ff1-hh9jsnoc',
        addresses: ['fe80::1'],
      },
    ];
    // URL.hostname strips brackets: 'http://[fe80::1]:1111' → hostname 'fe80::1'
    const result = findExistingDeviceEntry(
      devices,
      'http://[fe80::1]:1111',
      '',
      undefined,
      undefined
    );
    assert.equal(result?.name, 'kitchen');
  });

  // Regression: step 4a must still match when discoveredId is absent (partial avahi result or
  // --host path). Previously the guard read `if (d.id) return false`, which blocked the match
  // even when no discoveredId was available to compare against — preventing migration for
  // pre-id configs that gained an id in a later discovery.
  test('address match succeeds for id-bearing entry when discoveredId is absent', () => {
    const devices = [{ name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-hh9jsnoc' }];
    // Partial avahi result: same IP as stored, but no id in this discovery pass
    const result = findExistingDeviceEntry(
      devices,
      'http://ff1-hh9jsnoc.local:1111',
      'ff1-hh9jsnoc', // raw mDNS label
      undefined, // no discoveredId
      ['192.168.1.10'] // avahi-reported IP matches stored entry's host IP
    );
    assert.equal(result?.name, 'kitchen');
  });

  // Confirm address-based matching does not shadow an entry that already has an id.
  test('address match is skipped for entries that have a stored id', () => {
    const devices = [
      { name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-hh9jsnoc' },
      { name: 'office', host: 'http://192.168.1.11:1111' }, // no id
    ];
    // discoveredId matches kitchen; addresses match office. id check should win.
    const result = findExistingDeviceEntry(
      devices,
      'http://ff1-hh9jsnoc.local:1111',
      'ff1-hh9jsnoc',
      'ff1-hh9jsnoc',
      ['192.168.1.11'] // would match office by IP, but kitchen wins by id
    );
    assert.equal(result?.name, 'kitchen');
  });

  test('returns undefined when no match by host, id, hostname, or name', () => {
    const devices = [
      { name: 'kitchen', host: 'http://ff1-hh9jsnoc.local:1111', id: 'ff1-hh9jsnoc' },
      { name: 'office', host: 'http://192.168.1.11:1111', id: 'ff1-aaabbbcc' },
    ];
    const result = findExistingDeviceEntry(
      devices,
      'http://10.0.0.99:1111',
      'bedroom',
      'ff1-zzzzzz'
    );
    assert.equal(result, undefined);
  });

  test('id match takes priority over exact-host match', () => {
    const devices = [
      { name: 'kitchen', host: 'http://ff1-hh9jsnoc.local:1111', id: 'ff1-hh9jsnoc' },
      { name: 'office', host: 'http://10.0.0.2:1111', id: 'ff1-aaabbbcc' },
    ];
    // The office device (id ff1-aaabbbcc) moved to kitchen's host URL.
    // id is the more reliable identity signal, so office wins over the exact-host kitchen entry.
    const result = findExistingDeviceEntry(
      devices,
      'http://ff1-hh9jsnoc.local:1111',
      'office',
      'ff1-aaabbbcc'
    );
    assert.equal(result?.name, 'office');
  });

  // Regression: upsertDevice must not append a duplicate when the same device
  // is rediscovered under a new host URL.
  test('discovery-list state: upsertDevice does not create duplicate when id match found', () => {
    const existing = [
      { name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-hh9jsnoc' },
      { name: 'office', host: 'http://192.168.1.11:1111', id: 'ff1-aaabbbcc' },
    ];
    // Caller used findExistingDeviceEntry to determine the stored name, then calls upsertDevice
    // with the stored name (not the raw mDNS label) and the new host.
    const { devices, updated } = upsertDevice(existing, {
      name: 'kitchen', // preserved from findExistingDeviceEntry result
      host: 'http://ff1-hh9jsnoc.local:1111', // new .local host
      id: 'ff1-hh9jsnoc',
    });
    assert.equal(updated, false); // new host, so not "updated" in the same-host sense
    assert.equal(devices.length, 2, 'must not create a duplicate entry');
    const kitchen = devices.find((d: { name?: string }) => d.name === 'kitchen');
    assert.equal(kitchen?.host, 'http://ff1-hh9jsnoc.local:1111', 'host must be updated');
  });
});
