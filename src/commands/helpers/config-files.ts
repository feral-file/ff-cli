import { promises as fs } from 'fs';
import { createSampleConfig, getConfigPaths } from '../../config';
import type { Config } from '../../types';
export { isMissingConfigValue } from '../../utilities/config-placeholders';

/**
 * Read and parse a config.json file at the given path.
 */
export async function readConfigFile(configPath: string): Promise<Config> {
  const file = await fs.readFile(configPath, 'utf-8');
  return JSON.parse(file) as Config;
}

/**
 * Locate an existing config.json. Local (`./config.json`) wins over user
 * (`~/.config/ff-cli/config.json`). Returns null when neither exists.
 */
export async function resolveExistingConfigPath(): Promise<string | null> {
  const { localPath, userPath } = getConfigPaths();
  try {
    await fs.access(localPath);
    return localPath;
  } catch (_error) {
    try {
      await fs.access(userPath);
      return userPath;
    } catch (_innerError) {
      return null;
    }
  }
}

/**
 * Resolve the existing config file or write a sample one to the user
 * config path. The `created` flag tells callers whether to print the
 * new-file confirmation.
 */
export async function ensureConfigFile(): Promise<{ path: string; created: boolean }> {
  const { userPath } = getConfigPaths();
  const existingPath = await resolveExistingConfigPath();
  if (existingPath) {
    return { path: existingPath, created: false };
  }
  const createdPath = await createSampleConfig(userPath);
  return { path: createdPath, created: true };
}
