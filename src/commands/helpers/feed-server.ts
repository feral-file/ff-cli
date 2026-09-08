/**
 * Chooses which configured feed server a command writes to.
 *
 * The rule this file exists to fix: with more than one server configured and no `--server`, the old
 * `publish` printed "Select server" and read from stdin. Under a pipe, cron job, or CI step, stdin is
 * closed, readline resolves immediately with an empty answer, `parseInt('')` yields `NaN`, and the
 * command exited **0** having published nothing. A silent success is the worst possible answer for a
 * write, so ambiguity in a non-interactive session is now a non-zero exit that lists the servers.
 *
 * Failing rather than defaulting to index 0 is deliberate: the first configured server is usually
 * production, and a script that meant the other one would otherwise write to the wrong feed and report
 * success. `find --publish` already answered this way for `--yes`; this generalizes it to any session
 * with no terminal, and to the delete path, where a wrong-feed write is not undoable.
 */

import chalk from 'chalk';
import { createPrompt } from './prompt';

/**
 * Outcome of a server choice.
 *
 * Deliberately one shape rather than a discriminated union: this project compiles with `strict: false`,
 * where narrowing a `{ ok: true } | { ok: false }` union does not work, so a union would force casts at
 * every call site. `ok` is the only field a caller must test.
 */
export interface FeedServerSelection {
  ok: boolean;
  /** Chosen base URL. Set when `ok`. */
  url?: string;
  /** Index of the chosen URL in the configured list. Set when `ok`. */
  index?: number;
  /** One-line diagnosis. Set when not `ok`. */
  error?: string;
  /** Supporting detail, usually the list of configured servers. */
  detail?: string;
}

export interface FeedServerSelectionOptions {
  /** Raw `--server` value, if the user passed one. */
  serverArg?: string;
  /**
   * Treat the session as non-interactive regardless of the terminal, e.g. under `--yes`. The absence of
   * a TTY is checked separately, so callers need not test it themselves.
   */
  nonInteractive?: boolean;
  /**
   * Prompt function, for tests. Production callers omit it and get a readline prompt on stdin.
   *
   * The interactive branch has a failure mode worth covering — a bare Enter must not select a server —
   * and driving a real readline over a pseudo-terminal to reach one `if` is more machinery than the
   * branch is worth. This is the smaller seam.
   */
  ask?: (question: string) => Promise<string>;
}

/**
 * Resolve the feed server URL for a command.
 *
 * `--server` is validated whatever the server count: `parseInt('0abc')` truncates to 0 and would route
 * to a different server than the user named.
 *
 * @param baseURLs - Configured feed server base URLs, in config order
 * @param options - `--server` value and whether the session may prompt
 * @returns The chosen URL and its index, or the error to report
 */
export async function selectFeedServer(
  baseURLs: string[],
  options: FeedServerSelectionOptions = {}
): Promise<FeedServerSelection> {
  if (!baseURLs || baseURLs.length === 0) {
    return {
      ok: false,
      error: 'No feed servers configured',
      detail: 'Add feed server URLs to config.json: feed.baseURLs',
    };
  }

  const upperBound = baseURLs.length - 1;

  if (options.serverArg !== undefined) {
    // `Number('')` and `Number('  ')` are both 0, so an empty `--server=` would silently select the
    // first server — a typo answering as if it were a choice.
    const raw = options.serverArg.trim();
    const index = raw.length === 0 ? Number.NaN : Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= baseURLs.length) {
      return {
        ok: false,
        error: `Invalid --server value: ${options.serverArg} (expected integer in 0..${upperBound})`,
        detail: describeServers(baseURLs),
      };
    }
    return { ok: true, url: baseURLs[index], index };
  }

  if (baseURLs.length === 1) {
    return { ok: true, url: baseURLs[0], index: 0 };
  }

  if (options.nonInteractive || !process.stdin.isTTY) {
    return {
      ok: false,
      error: `Multiple feed servers configured (${baseURLs.length}); pass --server <index>`,
      detail: describeServers(baseURLs),
    };
  }

  console.log(chalk.yellow('Multiple feed servers configured:'));
  console.log(describeServers(baseURLs));
  console.log();
  const answer = await askForSelection(options.ask);
  console.log();

  // A bare Enter is not a choice. `Number('')` is 0, so accepting it would send the write to whichever
  // feed happens to be listed first — usually production — for someone who was hesitating, or who
  // reflexively took a default that was never offered. This prompt deliberately has no default: the
  // whole point of asking is that the CLI cannot tell which feed was meant.
  const selected = answer.trim();
  const index = selected.length === 0 ? Number.NaN : Number(selected);
  if (!Number.isInteger(index) || index < 0 || index >= baseURLs.length) {
    return {
      ok: false,
      error:
        selected.length === 0
          ? `No server selected (expected integer in 0..${upperBound})`
          : `Invalid selection: ${selected} (expected integer in 0..${upperBound})`,
      detail: describeServers(baseURLs),
    };
  }
  return { ok: true, url: baseURLs[index], index };
}

/** Ask which server to use, through the injected prompt when a caller supplied one. */
async function askForSelection(ask?: (question: string) => Promise<string>): Promise<string> {
  if (ask) {
    return ask('Select server (0-based index): ');
  }
  const prompt = createPrompt();
  try {
    return await prompt.ask('Select server (0-based index): ');
  } finally {
    prompt.close();
  }
}

/** Numbered listing of the configured servers, used in both the prompt and the failure detail. */
export function describeServers(baseURLs: string[]): string {
  return baseURLs.map((url, index) => chalk.cyan(`  ${index}: ${url}`)).join('\n');
}
