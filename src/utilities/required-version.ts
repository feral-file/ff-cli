/**
 * The ff-cli required-version floor: commands that contact an FF1 refuse to
 * run when the installed ff-cli is older than `cli_update.required_version`
 * in the remote config document the Feral File app also reads
 * (`<base>/ff-app.json`).
 *
 * Rules this module owns (keep them when changing it):
 * - It is a compatibility lever, not a security control: it tells an install
 *   that can no longer talk to current FF1 firmware to update. Deleting the
 *   kept value and blocking the config host bypasses it, and that is accepted.
 * - At most one read attempt per FLOOR_READ_INTERVAL_MS, failed attempts
 *   included. The result is kept in the config directory and enforced between
 *   attempts, so a network that cannot reach the config host pays the read
 *   deadline once a day, not on every command.
 * - A successful read always replaces the kept value, and a document whose
 *   key is missing or unparsable stores "no floor". Withdrawing a wrong floor
 *   from the document therefore unlocks every install on its next read.
 * - It fails open: nothing was ever read, the read failed and nothing is
 *   kept, the kept file is unreadable or unwritable, or either version does
 *   not parse. Only a parsed floor above a parsed installed version refuses.
 */

import fs from 'fs';
import path from 'path';
import { getConfigPaths, getRemoteConfigUrl } from '../config';

/** FLOOR_READ_INTERVAL_MS is the least time between two read attempts. */
export const FLOOR_READ_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** FLOOR_READ_TIMEOUT_MS bounds the one GET, so the check never stalls a command for long. */
export const FLOOR_READ_TIMEOUT_MS = 2000;

const KEPT_FILE = 'required-version.json';

/**
 * REQUIRED_VERSION_COMMANDS are the commands the floor gates, by command path:
 * the ones whose action contacts an FF1. Commands that only read or write
 * local files, or talk to a feed or an indexer, are never gated, and neither
 * are the `device` subcommands that only edit config.json.
 */
export const REQUIRED_VERSION_COMMANDS: ReadonlySet<string> = new Set([
  'display',
  'download',
  'ssh',
  'report',
  'device pair',
  'device controllers',
  'device revoke',
  'device lan',
  'device unpair',
  'device add',
]);

/** Kept is the stored result: when a read was last attempted, and the floor (null: none). */
type Kept = { attemptedAt: number; requiredVersion: string | null };

/** RequiredVersionDeps are injectable for tests; production uses the defaults. */
export interface RequiredVersionDeps {
  /** Directory of the kept value (default: the ff-cli config directory). */
  dir?: string;
  /** Remote config base URL (default: getRemoteConfigUrl). */
  baseUrl?: string;
  /** Unix milliseconds. */
  now?: () => number;
  fetchFn?: typeof fetch;
}

/** CommandNode is the part of a commander Command that names its path. */
type CommandNode = { name(): string; parent?: CommandNode | null };

/**
 * commandPath is a command's names from below the program root, joined by
 * spaces (`device pair`). An alias resolves to its command's name.
 */
function commandPath(command: CommandNode): string {
  const names: string[] = [];
  for (let node = command; node.parent; node = node.parent) {
    names.unshift(node.name());
  }
  return names.join(' ');
}

/** parseVersion reads a plain `major.minor.patch`; anything else is unparsable. */
function parseVersion(value: unknown): [number, number, number] | null {
  const match = typeof value === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** isBelow reports installed < floor; false when either does not parse (fail open). */
function isBelow(installed: string, floor: unknown): boolean {
  const have = parseVersion(installed);
  const need = parseVersion(floor);
  if (!have || !need) {
    return false;
  }
  for (let index = 0; index < 3; index++) {
    if (have[index] !== need[index]) {
      return have[index] < need[index];
    }
  }
  return false;
}

/** readKept returns the stored result, or null when it is absent or malformed. */
function readKept(file: string): Kept | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<Kept> | null;
    if (value && typeof value.attemptedAt === 'number') {
      return { attemptedAt: value.attemptedAt, requiredVersion: value.requiredVersion ?? null };
    }
  } catch {
    // Absent or corrupt is "nothing was ever read".
  }
  return null;
}

/**
 * readFloor GETs the remote config document once. It returns the floor to
 * store (null for a missing or unparsable key: "no floor"), or undefined when
 * the document itself was not read, which leaves the kept value alone.
 */
async function readFloor(
  baseUrl: string,
  fetchFn: typeof fetch
): Promise<string | null | undefined> {
  try {
    const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/ff-app.json`, {
      signal: AbortSignal.timeout(FLOOR_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    const document = (await response.json()) as {
      cli_update?: { required_version?: unknown } | null;
    } | null;
    const floor = document?.cli_update?.required_version;
    return parseVersion(floor) ? (floor as string) : null;
  } catch {
    return undefined;
  }
}

/**
 * unsupportedVersionMessage returns the line to print when the installed
 * ff-cli is below the required version, or null when the command may run.
 * It makes the day's one read attempt when it is due.
 *
 * @param installed - The running ff-cli version (package.json)
 * @param deps - Test seams
 * @returns The refusal line, or null
 */
export async function unsupportedVersionMessage(
  installed: string,
  deps: RequiredVersionDeps = {}
): Promise<string | null> {
  const dir = deps.dir ?? path.dirname(getConfigPaths().userPath);
  const file = path.join(dir, KEPT_FILE);
  const now = (deps.now ?? Date.now)();
  let kept = readKept(file);
  const age = kept ? now - kept.attemptedAt : Infinity;
  // A negative age is a clock that was set back; reading again is the only
  // way such a stamp does not freeze the kept value for good.
  if (age < 0 || age >= FLOOR_READ_INTERVAL_MS) {
    const floor = await readFloor(deps.baseUrl ?? getRemoteConfigUrl(), deps.fetchFn ?? fetch);
    kept = {
      attemptedAt: now,
      requiredVersion: floor === undefined ? (kept?.requiredVersion ?? null) : floor,
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(kept)}\n`, 'utf-8');
    } catch {
      // Best effort: an unwritable config directory costs a read per command
      // and still enforces what this read returned.
    }
  }
  return isBelow(installed, kept?.requiredVersion)
    ? `ff-cli ${installed} is no longer supported. Update: npm i -g @feralfile/cli`
    : null;
}

/**
 * enforceRequiredVersion is the commander `preAction` hook body: for a gated
 * command below the floor it prints the update line on stderr and exits 1
 * before the action runs, on the LAN and through the relay alike. Scripts see
 * the non-zero exit.
 *
 * @param command - The command about to run
 * @param installed - The running ff-cli version
 */
export async function enforceRequiredVersion(
  command: CommandNode,
  installed: string
): Promise<void> {
  if (!REQUIRED_VERSION_COMMANDS.has(commandPath(command))) {
    return;
  }
  const message = await unsupportedVersionMessage(installed);
  if (message) {
    console.error(message);
    process.exit(1);
  }
}
