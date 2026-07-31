import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renameDevice } from '../src/utilities/device-rename';
import type { DeviceEntry } from '../src/utilities/device-upsert';

const sample = (): DeviceEntry[] => [
  { name: 'kitchen', host: 'http://192.168.1.10:1111', id: 'ff1-kkk', apiKey: 'KEY-K' },
  { name: 'office', host: 'http://192.168.1.11:1111', id: 'ff1-ooo', topicID: 'topic-o' },
  { name: 'studio', host: 'http://192.168.1.12:1111' },
];

describe('renameDevice', () => {
  test('renames in place, preserving position and all other fields', () => {
    const { devices, renamed, previousName, unchanged } = renameDevice(
      sample(),
      'office',
      'gallery'
    );
    assert.equal(unchanged, false);
    assert.equal(previousName, 'office');
    assert.equal(renamed.name, 'gallery');
    assert.deepEqual(
      devices.map((d) => d.name),
      ['kitchen', 'gallery', 'studio'],
      'only the target name changes; order is preserved'
    );
    assert.equal(devices[1].host, 'http://192.168.1.11:1111');
    assert.equal(devices[1].id, 'ff1-ooo');
    assert.equal(devices[1].topicID, 'topic-o');
  });

  test('is case-insensitive on the identifier', () => {
    const { renamed } = renameDevice(sample(), 'OFFICE', 'gallery');
    assert.equal(renamed.name, 'gallery');
  });

  test('matches by host URL and names an unnamed legacy entry', () => {
    const devices: DeviceEntry[] = [
      { name: 'kitchen', host: 'http://192.168.1.10:1111' },
      { host: 'http://192.168.1.99:1111' },
    ];
    const result = renameDevice(devices, 'http://192.168.1.99:1111', 'hallway');
    assert.equal(result.devices[1].name, 'hallway');
    assert.equal(result.previousName, undefined);
  });

  test('allows a case-only rename of the same device', () => {
    const { devices, unchanged } = renameDevice(sample(), 'office', 'Office');
    assert.equal(unchanged, false);
    assert.equal(devices[1].name, 'Office');
  });

  test('reports unchanged when the name is already exactly the requested one', () => {
    const { devices, unchanged } = renameDevice(sample(), 'office', 'office');
    assert.equal(unchanged, true);
    assert.deepEqual(
      devices.map((d) => d.name),
      ['kitchen', 'office', 'studio']
    );
  });

  test('trims surrounding whitespace from the new name', () => {
    const { renamed } = renameDevice(sample(), 'office', '  gallery  ');
    assert.equal(renamed.name, 'gallery');
  });

  test('throws when the new name is empty or whitespace', () => {
    assert.throws(() => renameDevice(sample(), 'office', '   '), /must not be empty/);
  });

  test('throws when the new name is used by a different device (case-insensitive)', () => {
    assert.throws(() => renameDevice(sample(), 'office', 'kitchen'), /already used/);
    assert.throws(() => renameDevice(sample(), 'office', 'KITCHEN'), /already used/);
  });

  test('throws when identifier does not match any device', () => {
    assert.throws(() => renameDevice(sample(), 'bathroom', 'gallery'), /not found/);
  });

  test('does not mutate the input array', () => {
    const input = sample();
    const before = input.map((d) => d.name);
    renameDevice(input, 'office', 'gallery');
    assert.deepEqual(
      input.map((d) => d.name),
      before
    );
  });
});
