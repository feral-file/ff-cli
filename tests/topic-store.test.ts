import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  deleteTopicId,
  getTopicId,
  storeTopicId,
  topicStoreAccount,
  type KeyringEntry,
  type KeyringEntryFactory,
} from '../src/utilities/topic-store';

class MemoryEntry implements KeyringEntry {
  constructor(
    private readonly values: Map<string, string>,
    private readonly key: string
  ) {}

  setPassword(value: string): void {
    this.values.set(this.key, value);
  }

  getPassword(): string | null {
    return this.values.get(this.key) ?? null;
  }

  deletePassword(): boolean {
    return this.values.delete(this.key);
  }
}

describe('topic store', () => {
  test('maps a normalized device id to one OS keyring item', () => {
    const values = new Map<string, string>();
    const factory: KeyringEntryFactory = (service, account) =>
      new MemoryEntry(values, `${service}:${account}`);

    storeTopicId(' ff1-skyz2e3a ', 'topic-secret', factory);

    assert.equal(getTopicId('FF1-SKYZ2E3A', factory), 'topic-secret');
    assert.equal(values.size, 1);
    assert.equal(topicStoreAccount('ff1-skyz2e3a'), 'FF1-SKYZ2E3A');
    assert.equal(deleteTopicId('FF1-SKYZ2E3A', factory), true);
    assert.equal(getTopicId('FF1-SKYZ2E3A', factory), null);
  });

  test('rejects empty device and topic identifiers', () => {
    const factory: KeyringEntryFactory = () => new MemoryEntry(new Map(), 'unused');
    assert.throws(() => storeTopicId('', 'topic', factory), /device ID is required/);
    assert.throws(() => storeTopicId('FF1-TEST', '', factory), /topic ID is required/);
  });
});
