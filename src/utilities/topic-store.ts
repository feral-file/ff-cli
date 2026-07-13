import { Entry } from '@napi-rs/keyring';

const TOPIC_STORE_SERVICE = 'com.feralfile.ff-cli.topic';

/** Minimal keyring entry surface used for testable OS-backed topic storage. */
export interface KeyringEntry {
  setPassword(value: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

const defaultEntryFactory: KeyringEntryFactory = (service, account) => new Entry(service, account);

/** Normalize a physical FF1 identifier into its one keyring account name. */
export function topicStoreAccount(deviceId: string): string {
  const normalized = deviceId.trim().toUpperCase();
  if (!normalized) {
    throw new Error('FF1 device ID is required for secure topic storage');
  }
  return normalized;
}

/** Store a device topic in the operating system credential vault. */
export function storeTopicId(
  deviceId: string,
  topicId: string,
  entryFactory: KeyringEntryFactory = defaultEntryFactory
): void {
  const normalizedTopic = topicId.trim();
  if (!normalizedTopic) {
    throw new Error('FF1 topic ID is required for secure topic storage');
  }
  entryFactory(TOPIC_STORE_SERVICE, topicStoreAccount(deviceId)).setPassword(normalizedTopic);
}

/** Read a device topic from the operating system credential vault. */
export function getTopicId(
  deviceId: string,
  entryFactory: KeyringEntryFactory = defaultEntryFactory
): string | null {
  return entryFactory(TOPIC_STORE_SERVICE, topicStoreAccount(deviceId)).getPassword();
}

/** Delete a device topic from the operating system credential vault. */
export function deleteTopicId(
  deviceId: string,
  entryFactory: KeyringEntryFactory = defaultEntryFactory
): boolean {
  return entryFactory(TOPIC_STORE_SERVICE, topicStoreAccount(deviceId)).deletePassword();
}
