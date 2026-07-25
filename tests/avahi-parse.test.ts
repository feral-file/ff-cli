/**
 * Regression tests for parseAvahiBrowseOutput.
 *
 * The Linux mDNS path must preserve original case and handle multi-word service
 * names. Lookups are case-insensitive, but stored names are display labels and
 * round-trip into config.json — truncation or case mangling corrupts them.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  parseAvahiBrowseOutput,
  resolveAvahiResult,
  discoverFF1Devices,
} from '../src/utilities/ff1-discovery';
import type { FF1DiscoveryResult, DiscoveryOptions } from '../src/utilities/ff1-discovery';

const makeAvahiRecord = ({
  serviceName,
  hostname,
  port = 1111,
  txtName,
}: {
  serviceName: string;
  hostname: string;
  port?: number;
  txtName?: string;
}): string => {
  const txtLine = txtName ? `   txt = ["name=${txtName}"]` : '   txt = []';
  return [
    `=  wlan0 IPv4 ${serviceName} _ff1._tcp local`,
    `   hostname = [${hostname}]`,
    `   address = [192.168.1.10]`,
    `   port = [${port}]`,
    txtLine,
  ].join('\n');
};

describe('parseAvahiBrowseOutput', () => {
  // Regression: service names were lowercased, breaking exact-match routing
  test('preserves mixed-case service name when no TXT name is present', () => {
    const output = makeAvahiRecord({
      serviceName: 'FF1-Office',
      hostname: 'ff1-office.local.',
    });
    const devices = parseAvahiBrowseOutput(output);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'FF1-Office');
  });

  // Regression: multi-word names were truncated to the first word
  test('preserves multi-word service name', () => {
    const output = makeAvahiRecord({
      serviceName: 'Living Room Display',
      hostname: 'ff1-abc123.local.',
    });
    const devices = parseAvahiBrowseOutput(output);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'Living Room Display');
  });

  test('TXT name overrides the header service name', () => {
    const output = makeAvahiRecord({
      serviceName: 'FF1-HH9JSNOC',
      hostname: 'ff1-hh9jsnoc.local.',
      txtName: 'kitchen',
    });
    const devices = parseAvahiBrowseOutput(output);
    assert.equal(devices[0].name, 'kitchen');
  });

  test('parses two records from one avahi-browse session', () => {
    const block1 = makeAvahiRecord({ serviceName: 'FF1-AAA', hostname: 'ff1-aaa.local.' });
    const block2 = makeAvahiRecord({ serviceName: 'FF1-BBB', hostname: 'ff1-bbb.local.' });
    const devices = parseAvahiBrowseOutput(`${block1}\n${block2}`);
    assert.equal(devices.length, 2);
    const names = devices.map((d) => d.name).sort();
    assert.deepEqual(names, ['FF1-AAA', 'FF1-BBB']);
  });

  test('returns empty array for empty output', () => {
    assert.deepEqual(parseAvahiBrowseOutput(''), []);
  });

  test('returns empty array for output with no resolved records', () => {
    const output = '+  wlan0 IPv4 FF1-AAA _ff1._tcp local\n';
    assert.deepEqual(parseAvahiBrowseOutput(output), []);
  });

  test('recovers the complete record before a truncated second record', () => {
    const complete = makeAvahiRecord({ serviceName: 'FF1-AAA', hostname: 'ff1-aaa.local.' });
    // Truncated second record — only the header line, no hostname/port/txt
    const truncated = '=  wlan0 IPv4 FF1-BBB _ff1._tcp local';
    const devices = parseAvahiBrowseOutput(`${complete}\n${truncated}`);
    // The complete record is still returned; the truncated one is silently dropped
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'FF1-AAA');
  });

  test('captures resolved IP address in addresses field', () => {
    const output = makeAvahiRecord({ serviceName: 'FF1-AAA', hostname: 'ff1-aaa.local.' });
    const devices = parseAvahiBrowseOutput(output);
    assert.equal(devices.length, 1);
    assert.deepEqual(devices[0].addresses, ['192.168.1.10']);
  });

  // Regression: avahi can emit multiple address lines for a dual-stack device;
  // the parser must accumulate all of them so findExistingDeviceEntry can match
  // against the stored IP regardless of which address appears first.
  test('accumulates all address lines for dual-stack devices', () => {
    const output = [
      '=  wlan0 IPv6 FF1-AAA _ff1._tcp local',
      '   hostname = [ff1-aaa.local.]',
      '   address = [fe80::1]',
      '   port = [1111]',
      '   txt = []',
      '=  wlan0 IPv4 FF1-AAA _ff1._tcp local',
      '   hostname = [ff1-aaa.local.]',
      '   address = [192.168.1.10]',
      '   port = [1111]',
      '   txt = []',
    ].join('\n');
    const devices = parseAvahiBrowseOutput(output);
    // Both records share the same key (hostname:port) so they merge into one entry
    assert.equal(devices.length, 1);
    assert.ok(devices[0].addresses?.includes('192.168.1.10'), 'IPv4 address must be present');
    assert.ok(devices[0].addresses?.includes('fe80::1'), 'IPv6 address must be present');
  });

  // Regression: a partial record that has txt=[] emits {} which is truthy, blocking a later
  // complete TXT payload from being used. The fix treats {} as absent.
  test('merge uses complete TXT from later record when earlier record had empty txt', () => {
    // Partial first: txt = [] → {}
    const partial = [
      '=  wlan0 IPv4 FF1-HH9JSNOC _ff1._tcp local',
      '   hostname = [ff1-hh9jsnoc.local.]',
      '   address = [192.168.1.10]',
      '   port = [1111]',
      '   txt = []',
    ].join('\n');
    // Complete second: txt with name and id
    const complete = [
      '=  wlan0 IPv6 FF1-HH9JSNOC _ff1._tcp local',
      '   hostname = [ff1-hh9jsnoc.local.]',
      '   address = [fe80::1]',
      '   port = [1111]',
      '   txt = ["name=kitchen" "id=ff1-hh9jsnoc"]',
    ].join('\n');
    const devices = parseAvahiBrowseOutput(`${partial}\n${complete}`);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'kitchen', 'TXT name from later complete record must be used');
    assert.ok(devices[0].addresses?.includes('192.168.1.10'), 'IPv4 address must be present');
    assert.ok(devices[0].addresses?.includes('fe80::1'), 'IPv6 address must be present');
  });

  // Regression: a later partial record (e.g. a second IPv6 interface record with no TXT)
  // must not clobber the name/id/txt from the earlier complete record.
  test('merge preserves name and txt from earlier complete record when later record is partial', () => {
    const complete = makeAvahiRecord({
      serviceName: 'FF1-HH9JSNOC',
      hostname: 'ff1-hh9jsnoc.local.',
      txtName: 'kitchen',
    });
    // Partial record for the same hostname (e.g. IPv6 interface): header + hostname + address only
    const partial = [
      '=  wlan0 IPv6 FF1-HH9JSNOC _ff1._tcp local',
      '   hostname = [ff1-hh9jsnoc.local.]',
      '   address = [fe80::1]',
      '   port = [1111]',
      '   txt = []',
    ].join('\n');
    const devices = parseAvahiBrowseOutput(`${complete}\n${partial}`);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'kitchen', 'TXT name from first record must survive');
    assert.ok(devices[0].addresses?.includes('192.168.1.10'), 'IPv4 address must be present');
    assert.ok(devices[0].addresses?.includes('fe80::1'), 'IPv6 address must be present');
  });

  // Regression: avahi-browse -r can emit "_ff1._tcp.local" instead of "_ff1._tcp"
  // in the header line; indexOf('_ff1._tcp') returns -1 on the variant, truncating
  // multi-word names to a single token. The fix uses a prefix regex.
  test('parses multi-word name when type token is _ff1._tcp.local variant', () => {
    // Build the record with the .local variant manually (makeAvahiRecord uses plain _ff1._tcp)
    const output = [
      '=  wlan0 IPv4 Living Room Display _ff1._tcp.local local',
      '   hostname = [ff1-abc123.local.]',
      '   address = [192.168.1.10]',
      '   port = [1111]',
      '   txt = []',
    ].join('\n');
    const devices = parseAvahiBrowseOutput(output);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'Living Room Display');
  });
});

// ---------------------------------------------------------------------------
// resolveAvahiResult — tests for the execFile error branch
// ---------------------------------------------------------------------------
describe('resolveAvahiResult', () => {
  const usableStdout = makeAvahiRecord({
    serviceName: 'FF1-Office',
    hostname: 'ff1-office.local.',
  });
  const unusableStdout = '+  wlan0 IPv4 FF1-Office _ff1._tcp local\n';

  test('clean exit returns parsed devices', () => {
    const result = resolveAvahiResult(null, usableStdout);
    assert(result !== null);
    assert.equal(result.devices.length, 1);
  });

  test('clean exit with empty stdout returns empty device list (not null)', () => {
    const result = resolveAvahiResult(null, '');
    assert(result !== null);
    assert.deepEqual(result.devices, []);
  });

  // Regression: non-zero + usable devices must NOT fall through to Bonjour
  test('non-zero exit with usable stdout returns the parsed devices', () => {
    const result = resolveAvahiResult(new Error('avahi exit 1'), usableStdout);
    assert(result !== null, 'must return devices, not null');
    assert.equal(result.devices.length, 1);
    assert.equal(result.devices[0].name, 'FF1-Office');
  });

  // Non-zero + no usable output → Bonjour fallback
  test('non-zero exit with no stdout returns null (ENOENT → Bonjour fallback)', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    assert.equal(resolveAvahiResult(err, ''), null);
  });

  test('non-zero exit with announcement-only stdout returns null', () => {
    assert.equal(resolveAvahiResult(new Error('exit 1'), unusableStdout), null);
  });

  test('non-zero exit with unparseable stdout returns null', () => {
    assert.equal(resolveAvahiResult(new Error('exit 2'), 'garbage\x00data'), null);
  });

  // Regression: avahi timeout (process killed by execFile deadline) with no devices in stdout
  // must return an empty result — NOT null — so discoverFF1Devices does not fall back to
  // Bonjour. Bonjour is unreliable on Linux; an empty scan result is more correct than a
  // Bonjour result that may pick up the wrong service.
  test('timeout with no stdout returns empty result, not null (no Bonjour fallback)', () => {
    const timeoutErr = Object.assign(new Error('Process timeout'), { killed: true });
    const result = resolveAvahiResult(timeoutErr, '');
    assert(result !== null, 'timeout must not trigger Bonjour fallback (null)');
    assert.deepEqual(result.devices, [], 'devices must be empty on timeout');
    assert.ok(result.error, 'error message must be set');
  });

  test('timeout with partial usable stdout returns those devices (not empty)', () => {
    const timeoutErr = Object.assign(new Error('Process timeout'), { killed: true });
    const result = resolveAvahiResult(timeoutErr, usableStdout);
    assert(result !== null);
    assert.equal(result.devices.length, 1, 'partial devices from timeout must be returned');
  });

  test('timeout with announcement-only stdout returns empty result, not null', () => {
    const timeoutErr = Object.assign(new Error('Process timeout'), { killed: true });
    const result = resolveAvahiResult(timeoutErr, unusableStdout);
    assert(result !== null, 'must not fall back to Bonjour on timeout');
    assert.deepEqual(result.devices, []);
  });
});

// ---------------------------------------------------------------------------
// discoverFF1Devices — end-to-end platform gate and fallback wiring
//
// These tests use injectable discovery functions to verify the branching logic:
//  - Linux + avahi returns non-null → use avahi result, skip Bonjour
//  - Linux + avahi returns null (ENOENT) → fall back to Bonjour
//  - Non-Linux → always use Bonjour, never call avahi
// ---------------------------------------------------------------------------
describe('discoverFF1Devices platform gate and fallback wiring', () => {
  const avahiDevices: FF1DiscoveryResult = {
    devices: [{ name: 'kitchen', host: 'http://ff1-hh9jsnoc.local:1111' }],
  };
  const bonjourDevices: FF1DiscoveryResult = {
    devices: [{ name: 'office', host: 'http://192.168.1.11:1111' }],
  };

  // Regression: on Linux when avahi succeeds, Bonjour must not be called and
  // the avahi result must be returned directly.
  test('Linux + avahi non-null: returns avahi result without calling Bonjour', async () => {
    let bonjourCalled = false;
    const avahi = async (_o: DiscoveryOptions) => avahiDevices;
    const bonjour = async (_o: DiscoveryOptions) => {
      bonjourCalled = true;
      return bonjourDevices;
    };
    const result = await discoverFF1Devices({ timeoutMs: 100 }, avahi, bonjour);
    // Only run the platform-specific assertion on Linux; on other platforms the
    // injected avahi function is never called, so we just verify no crash.
    if (process.platform === 'linux') {
      assert.deepEqual(result, avahiDevices, 'avahi result must be returned');
      assert.equal(bonjourCalled, false, 'Bonjour must not be called when avahi succeeds');
    }
  });

  // Regression: on Linux when avahi returns null (not installed / ENOENT), the
  // function must fall back to Bonjour rather than returning an empty result.
  test('Linux + avahi null (ENOENT): falls back to Bonjour', async () => {
    const avahi = async (_o: DiscoveryOptions): Promise<FF1DiscoveryResult | null> => null;
    const bonjour = async (_o: DiscoveryOptions) => bonjourDevices;
    const result = await discoverFF1Devices({ timeoutMs: 100 }, avahi, bonjour);
    if (process.platform === 'linux') {
      assert.deepEqual(result, bonjourDevices, 'Bonjour result must be returned on avahi null');
    }
  });

  // On non-Linux platforms the avahi path must never be entered; Bonjour runs directly.
  test('non-Linux: Bonjour is used; injected avahi is never called', async () => {
    let avahiCalled = false;
    const avahi = async (_o: DiscoveryOptions) => {
      avahiCalled = true;
      return avahiDevices;
    };
    const bonjour = async (_o: DiscoveryOptions) => bonjourDevices;
    const result = await discoverFF1Devices({ timeoutMs: 100 }, avahi, bonjour);
    if (process.platform !== 'linux') {
      assert.equal(avahiCalled, false, 'avahi must not be called on non-Linux');
      assert.deepEqual(result, bonjourDevices);
    } else {
      // On Linux the avahi branch runs; just confirm no crash
      assert(result);
    }
  });
});
