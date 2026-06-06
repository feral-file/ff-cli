/**
 * configPlaceholders identifies values copied from config.json.example.
 *
 * The sample file is useful for manual editing, but runtime flows must treat
 * those literal placeholders as unset so setup cannot mistake example rows for
 * configured devices.
 */
const CONFIG_PLACEHOLDER_PATTERN = /YOUR_|your_/;

/**
 * isMissingConfigValue reports whether a config string is empty or still a
 * sample placeholder.
 *
 * @param {string | null | undefined} value - Config value to inspect.
 * @returns {boolean} True when the value should be treated as unset.
 */
export function isMissingConfigValue(value?: string | null): boolean {
  if (!value) {
    return true;
  }
  return CONFIG_PLACEHOLDER_PATTERN.test(value);
}

/**
 * configuredFF1Devices returns only device rows with a real host.
 *
 * @param {T[]} devices - Device rows from config.json.
 * @returns {T[]} Rows that can be used for FF1 network operations.
 */
export function configuredFF1Devices<T extends { host?: string | null }>(devices: T[] = []): T[] {
  return devices.filter((device) => !isMissingConfigValue(device.host));
}
