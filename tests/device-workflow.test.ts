/**
 * End-to-end workflow tests: avahi-browse parsing → device selection → lookup → upsert.
 *
 * These tests exercise the full Linux discovery path (parseAvahiBrowseOutput) wired
 * into the selection-to-upsert pipeline so that regressions in any single step
 * surface as a broken workflow rather than a missing unit test.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseAvahiBrowseOutput } from '../src/utilities/ff1-discovery';
import { findExistingDeviceEntry } from '../src/utilities/device-lookup';
import { upsertDevice } from '../src/utilities/device-upsert';
import { resolveManualDeviceInput } from '../src/commands/helpers/device-discovery';

/** Simulate the selection step: map a discovered device to the host URL used by the CLI. */
function toHostValue(device: { host: string; port: number }): string {
  return `http://${device.host}:${device.port}`;
}

describe('device add / setup workflow (avahi → lookup → upsert)', () => {
  test('no-mDNS manual ID is retained for relayer pairing', () => {
    const selection = resolveManualDeviceInput('ff1-skyz2e3a');
    const { devices } = upsertDevice([], {
      name: 'office',
      host: selection.hostValue,
      id: selection.discoveredId,
    });

    assert.equal(selection.hostValue, 'http://ff1-skyz2e3a.local:1111');
    assert.equal(devices[0].id, 'FF1-SKYZ2E3A');
    assert.ok(devices[0].id, 'device pair can proceed with the retained stable ID');
  });

  test('uppercase manual ID matches lowercase mDNS rediscovery', () => {
    const stored = [
      {
        name: 'office',
        host: 'http://192.168.1.20:1111',
        id: 'FF1-SKYZ2E3A',
      },
    ];
    const discoveredId = 'ff1-skyz2e3a';
    const matched = findExistingDeviceEntry(
      stored,
      'http://ff1-skyz2e3a.local:1111',
      'office',
      discoveredId,
      ['192.168.1.20']
    );
    assert.equal(matched, stored[0]);

    const { devices } = upsertDevice(stored, {
      name: 'office',
      host: 'http://ff1-skyz2e3a.local:1111',
      id: discoveredId,
      addresses: ['192.168.1.20'],
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, 'FF1-SKYZ2E3A');
  });

  // Regression: re-running setup after a device is already configured must update
  // in-place and must not append a duplicate entry.
  test('avahi re-discovery does not duplicate a fully configured entry', () => {
    const avahiOutput = [
      '=  wlan0 IPv4 FF1-HH9JSNOC _ff1._tcp local',
      '   hostname = [ff1-hh9jsnoc.local.]',
      '   address = [192.168.1.10]',
      '   port = [1111]',
      '   txt = ["name=kitchen" "id=ff1-hh9jsnoc"]',
    ].join('\n');

    const discovered = parseAvahiBrowseOutput(avahiOutput);
    assert.equal(discovered.length, 1);
    const device = discovered[0];
    const newHost = toHostValue(device);

    const stored = [
      { name: 'kitchen', host: newHost, id: 'ff1-hh9jsnoc', addresses: ['192.168.1.10'] },
      { name: 'office', host: 'http://192.168.1.11:1111', id: 'ff1-aaabbbcc' },
    ];

    const existingEntry = findExistingDeviceEntry(
      stored,
      newHost,
      device.name,
      device.id,
      device.addresses
    );
    assert.equal(existingEntry?.name, 'kitchen', 'lookup must find the existing entry');

    const { devices } = upsertDevice(stored, {
      name: existingEntry?.name ?? device.name,
      host: newHost,
      id: device.id,
      addresses: device.addresses,
    });

    assert.equal(devices.length, 2, 'no duplicate must be created');
    assert.equal(devices[0].name, 'kitchen');
    assert.equal(devices[0].host, newHost);
  });

  // Regression: IP ↔ .local migration — device was stored with an IP host (pre-id
  // config); avahi now reports it via its .local hostname and includes the resolved IP
  // in the address field. The workflow must recognise the match and update in-place.
  test('IP→.local migration: avahi address bridges the gap for a pre-id stored entry', () => {
    const avahiOutput = [
      '=  wlan0 IPv4 FF1-HH9JSNOC _ff1._tcp local',
      '   hostname = [ff1-hh9jsnoc.local.]',
      '   address = [192.168.1.10]', // same IP as stored entry
      '   port = [1111]',
      '   txt = ["name=kitchen" "id=ff1-hh9jsnoc"]',
    ].join('\n');

    const discovered = parseAvahiBrowseOutput(avahiOutput);
    const device = discovered[0];
    const newHost = toHostValue(device);

    // Pre-id stored entry: IP host, no id, curated name that matches TXT name
    const stored = [{ name: 'kitchen', host: 'http://192.168.1.10:1111' }];

    const existingEntry = findExistingDeviceEntry(
      stored,
      newHost,
      device.name,
      device.id,
      device.addresses
    );
    assert.equal(existingEntry?.name, 'kitchen', 'lookup must find entry via avahi address');

    const { devices } = upsertDevice(stored, {
      name: existingEntry?.name ?? device.name,
      host: newHost,
      id: device.id,
      addresses: device.addresses,
    });

    assert.equal(devices.length, 1, 'no duplicate must be created');
    assert.equal(devices[0].host, newHost, 'host must be migrated to .local');
    assert.equal(devices[0].id, 'FF1-HH9JSNOC', 'id must be persisted for future lookups');
  });

  // Regression: dual-stack device emits IPv4 + IPv6 resolved records; the merged
  // entry must carry both addresses and still produce a single config row.
  test('dual-stack avahi output produces one entry with both IP addresses', () => {
    const avahiOutput = [
      '=  wlan0 IPv6 FF1-HH9JSNOC _ff1._tcp local',
      '   hostname = [ff1-hh9jsnoc.local.]',
      '   address = [fe80::1]',
      '   port = [1111]',
      '   txt = ["name=kitchen" "id=ff1-hh9jsnoc"]',
      '=  wlan0 IPv4 FF1-HH9JSNOC _ff1._tcp local',
      '   hostname = [ff1-hh9jsnoc.local.]',
      '   address = [192.168.1.10]',
      '   port = [1111]',
      '   txt = ["name=kitchen" "id=ff1-hh9jsnoc"]',
    ].join('\n');

    const discovered = parseAvahiBrowseOutput(avahiOutput);
    assert.equal(discovered.length, 1, 'dual-stack records must merge into one entry');
    const device = discovered[0];

    assert.ok(device.addresses?.includes('192.168.1.10'), 'IPv4 address must be present');
    assert.ok(device.addresses?.includes('fe80::1'), 'IPv6 address must be present');

    const stored = [{ name: 'kitchen', host: 'http://192.168.1.10:1111' }];
    const newHost = toHostValue(device);
    const existingEntry = findExistingDeviceEntry(
      stored,
      newHost,
      device.name,
      device.id,
      device.addresses
    );
    assert.equal(existingEntry?.name, 'kitchen');

    const { devices } = upsertDevice(stored, {
      name: existingEntry?.name ?? device.name,
      host: newHost,
      id: device.id,
      addresses: device.addresses,
    });

    assert.equal(devices.length, 1, 'no duplicate must be created');
    assert.ok(devices[0].addresses?.includes('192.168.1.10'));
    assert.ok(devices[0].addresses?.includes('fe80::1'));
  });
});

// ---------------------------------------------------------------------------
// Two distinct devices sharing the same friendly/TXT name
// ---------------------------------------------------------------------------
describe('same-friendly-name collision: lookup + add flow', () => {
  // Regression: TXT-name fallback must not collapse two physically distinct devices
  // (different ids, different hosts) into the same config row.
  test('lookup returns undefined when a stored id-bearing entry has the same name as a different device', () => {
    const stored = [
      { name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-aaa' },
      { name: 'office', host: 'http://192.168.1.11:1111', id: 'ff1-bbb' },
    ];
    // Genuinely new device with a different id that happens to advertise name='kitchen'
    const existingEntry = findExistingDeviceEntry(
      stored,
      'http://192.168.1.99:1111', // different host
      'kitchen', // same TXT friendly name as stored device
      'ff1-ccc' // different id
    );
    assert.equal(existingEntry, undefined, 'must not resolve to the existing kitchen entry');
  });

  // Regression: the full device-add flow — lookup yields undefined → name-collision
  // guard fires → upsertDevice is NOT called with the colliding name → no overwrite.
  test('add flow: when lookup returns undefined and name collides, guard prevents overwrite', () => {
    const stored = [{ name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-aaa' }];
    const newHost = 'http://192.168.1.99:1111';
    const newId = 'ff1-ccc';
    const advertisedName = 'kitchen';

    // Step 1: lookup — must return undefined
    const existingEntry = findExistingDeviceEntry(stored, newHost, advertisedName, newId);
    const existingIndex = existingEntry ? stored.findIndex((d) => d === existingEntry) : -1;
    assert.equal(existingIndex, -1, 'no existing entry should be found');

    // Step 2: name-collision guard — must fire because existingIndex === -1
    // and another device already owns the name
    const nameConflict = stored.find(
      (d, i) => d.name === advertisedName && (existingIndex === -1 || i !== existingIndex)
    );
    assert.ok(nameConflict, 'name-collision guard must detect the conflict');
    // The guard would error/re-prompt here — upsertDevice is never called
    // Verify that calling upsertDevice with the colliding name would clobber (showing why the guard matters)
    const { devices } = upsertDevice(stored, { name: advertisedName, host: newHost, id: newId });
    assert.equal(
      devices.length,
      1,
      'upsertDevice alone would collapse to 1 row — guard must prevent this call'
    );
    assert.equal(
      devices[0].id,
      newId.toUpperCase(),
      'the original kitchen entry would be overwritten without the guard'
    );
  });
});

// ---------------------------------------------------------------------------
// Duplicate name collision guard
// ---------------------------------------------------------------------------
describe('device add name-collision guard', () => {
  /**
   * Simulate the CLI's pre-upsert name-collision check.
   * Returns true if the chosen name is safe to use (no collision with a
   * device that is NOT the one being updated).
   */
  function isNameAvailable(
    existingDevices: Array<{ name?: string; host?: string }>,
    chosenName: string,
    existingIndex: number
  ): boolean {
    return !existingDevices.find(
      (d, i) => d.name === chosenName && (existingIndex === -1 || i !== existingIndex)
    );
  }

  test('name is available when no other device uses it', () => {
    const devices = [
      { name: 'kitchen', host: 'http://A' },
      { name: 'office', host: 'http://B' },
    ];
    assert.ok(isNameAvailable(devices, 'bedroom', -1));
  });

  test('collision detected when a different device already uses the name', () => {
    const devices = [
      { name: 'kitchen', host: 'http://A' },
      { name: 'office', host: 'http://B' },
    ];
    // Adding a brand-new device (existingIndex = -1) with name 'kitchen'
    assert.ok(!isNameAvailable(devices, 'kitchen', -1));
  });

  test('no false collision when updating the device that already owns the name', () => {
    const devices = [
      { name: 'kitchen', host: 'http://A' },
      { name: 'office', host: 'http://B' },
    ];
    // Updating index 0 ('kitchen') — the name still belongs to the same row, not a collision
    assert.ok(isNameAvailable(devices, 'kitchen', 0));
  });

  // Regression: without the guard, upsertDevice case-3 would silently clobber the
  // existing 'kitchen' entry when a new device (different host, no id) is added
  // with the same name.
  test('without guard, upsertDevice case-3 would clobber the existing entry', () => {
    const existingDevices = [
      { name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-aaa' },
      { name: 'office', host: 'http://192.168.1.11:1111', id: 'ff1-bbb' },
    ];
    // Simulate adding a genuinely new device but accidentally re-using 'kitchen'
    const { devices } = upsertDevice(existingDevices, {
      name: 'kitchen', // accidentally same as existing
      host: 'http://192.168.1.99:1111', // different host — new device
      id: 'ff1-ccc', // different id — new device
    });
    // upsertDevice itself cannot distinguish accidental collision from intentional
    // rename; without the CLI guard this appends a duplicate (id mismatch prevents
    // case-1 match, host mismatch prevents case-2, but name match triggers case-3).
    // The CLI guard must reject this BEFORE calling upsertDevice.
    // Verify that without the guard the old 'kitchen' entry is replaced:
    assert.equal(devices.length, 2);
    assert.equal(
      devices.find((d) => d.name === 'kitchen')?.host,
      'http://192.168.1.99:1111',
      'without guard, wrong entry is clobbered — this is the bug the guard prevents'
    );
  });
});

// ---------------------------------------------------------------------------
// device remove: unnamed-entry targeting
// ---------------------------------------------------------------------------
describe('device remove: match by host for unnamed entries', () => {
  /**
   * Simulate the updated remove lookup: match by name OR by normalised host URL.
   */
  function findDeviceToRemove(
    existingDevices: Array<{ name?: string; host?: string }>,
    arg: string
  ): number {
    const lower = arg.toLowerCase();
    return existingDevices.findIndex(
      (d) =>
        (d.name && d.name.toLowerCase() === lower) || (d.host && d.host.toLowerCase() === lower)
    );
  }

  test('finds a named device by name', () => {
    const devices = [
      { name: 'kitchen', host: 'http://192.168.1.10:1111' },
      { host: 'http://192.168.1.11:1111' }, // unnamed
    ];
    assert.equal(findDeviceToRemove(devices, 'kitchen'), 0);
  });

  test('finds an unnamed device by exact host URL', () => {
    const devices = [
      { name: 'kitchen', host: 'http://192.168.1.10:1111' },
      { host: 'http://192.168.1.11:1111' }, // unnamed — can only be targeted by host
    ];
    assert.equal(findDeviceToRemove(devices, 'http://192.168.1.11:1111'), 1);
  });

  test('returns -1 when neither name nor host matches', () => {
    const devices = [{ name: 'kitchen', host: 'http://192.168.1.10:1111' }];
    assert.equal(findDeviceToRemove(devices, 'bedroom'), -1);
  });
});
