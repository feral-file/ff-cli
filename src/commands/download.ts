import { Command } from 'commander';
import chalk from 'chalk';
import {
  DEFAULT_DOWNLOAD_TIMEOUT_SECONDS,
  type DownloadItemReport,
  type DownloadResult,
  downloadDisplayed,
  downloadPlaylist,
} from '../utilities/offline-download';

/**
 * parseTimeoutSeconds reads `--timeout` as a whole number of seconds.
 *
 * @param {string} [value] - The option as typed
 * @returns {number} Seconds to wait
 * @throws {Error} When the value is not a positive whole number
 */
export function parseTimeoutSeconds(value?: string): number {
  if (value === undefined) {
    return DEFAULT_DOWNLOAD_TIMEOUT_SECONDS;
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`--timeout takes a positive whole number of seconds; got "${value}".`);
  }
  return seconds;
}

/**
 * parseIndex reads `--index` as a zero-based position in the FF1's list.
 *
 * @param {string} [value] - The option as typed
 * @returns {number | undefined} The index, or undefined for the work on screen
 * @throws {Error} When the value is not a whole number of zero or more
 */
export function parseIndex(value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`--index takes a whole number of zero or more; got "${value}".`);
  }
  return index;
}

/**
 * formatItemLine renders one item's final line: title, state, bytes, and
 * whether the device holds everything the work loads.
 *
 * @param {DownloadItemReport} item - Item report
 * @returns {string} The line, without color
 */
export function formatItemLine(item: DownloadItemReport): string {
  const mark = item.outcome === 'ready' ? '✓' : '✗';
  const coverage = item.coverageComplete ? 'coverage complete' : 'coverage incomplete';
  const reason = item.reason ? ` (${item.reason})` : '';
  return `  ${mark} ${item.title}: ${item.state}, ${item.bytes} bytes, ${coverage}${reason}`;
}

/**
 * printItems prints the per-item lines, held items in green and the rest in
 * the color of what went wrong.
 *
 * @param {DownloadItemReport[]} items - Item reports
 */
function printItems(items: DownloadItemReport[]): void {
  for (const item of items) {
    const color =
      item.outcome === 'ready' ? chalk.green : item.outcome === 'failed' ? chalk.red : chalk.yellow;
    console.log(color(formatItemLine(item)));
  }
}

/**
 * printQueued prints the `--no-wait` outcome: what the FF1 queued, and that
 * nothing is known yet about whether the works are held.
 *
 * @param {DownloadResult} result - A successful result that did not wait
 */
function printQueued(result: DownloadResult): void {
  const queued = result.queuedCount ?? 0;
  const total = result.total ?? queued;
  console.log(chalk.green(`✓ Queued ${queued} of ${total} items on ${result.deviceName}`));
  console.log(
    chalk.dim('  Not waiting. Run the command again without --no-wait to check what is held.')
  );
  console.log();
}

/**
 * printFailure prints a failed run: the item lines when the wait got that
 * far, then the error and its follow-up.
 *
 * @param {DownloadResult} result - A failed result
 */
function printFailure(result: DownloadResult): void {
  if (result.items) {
    printItems(result.items);
  }
  console.error(chalk.red('\nDownload failed:'), result.error);
  if (result.details) {
    console.error(chalk.dim(`  Details: ${result.details}`));
  }
}

/**
 * downloadCommand asks an FF1 to keep a playlist so it displays with no
 * network, and by default waits until every item is held.
 *
 * The word is "download" because that is the Feral File app's word for the
 * same action; the device's own name for the store is the offline cache.
 * The exit code is the contract for scripts and agents: 0 only when every
 * item is held with complete coverage (or, with `--no-wait`, when the FF1
 * queued the playlist), 1 for anything else, including a timeout.
 *
 * It takes a playlist file, or `--displayed` for a work the FF1 is showing,
 * including one this CLI did not send. offline-download.ts says why a URL or a
 * dynamic playlist is refused, and why `--displayed` refuses a work with no id.
 */
export const downloadCommand = new Command('download')
  .description('Keep a playlist, or the work on display, on an FF1 so it displays with no network')
  .argument('[file]', 'Playlist file (omit with --displayed)')
  .option('-d, --device <name>', 'Device name (uses first device if not specified)')
  .option('--displayed', 'Keep the work the FF1 is displaying instead of a playlist file')
  .option(
    '--index <n>',
    "With --displayed: the position in the FF1's list (default: the work on screen)"
  )
  .option('--no-wait', 'Queue the download and exit without waiting for the items')
  .option(
    '--timeout <seconds>',
    `Seconds to wait for every item (default ${DEFAULT_DOWNLOAD_TIMEOUT_SECONDS})`
  )
  .action(
    async (
      file: string | undefined,
      options: {
        device?: string;
        displayed?: boolean;
        index?: string;
        wait: boolean;
        timeout?: string;
      }
    ) => {
      try {
        const timeoutSeconds = parseTimeoutSeconds(options.timeout);
        if (options.displayed ? file !== undefined : file === undefined) {
          throw new Error(
            'Give a playlist file, or --displayed for the work on display, not both.'
          );
        }
        if (options.index !== undefined && !options.displayed) {
          throw new Error('--index works only with --displayed.');
        }
        const index = parseIndex(options.index);
        console.log(chalk.blue('\nDownload to FF1\n'));
        const onItemState = (item: DownloadItemReport) =>
          console.log(chalk.dim(`  ${item.state}: ${item.title}`));
        const result = options.displayed
          ? await downloadDisplayed({
              deviceName: options.device,
              index,
              wait: options.wait,
              timeoutSeconds,
              onItemState,
            })
          : await downloadPlaylist({
              source: file as string,
              deviceName: options.device,
              wait: options.wait,
              timeoutSeconds,
              onItemState,
            });
        if (!result.success) {
          printFailure(result);
          process.exit(1);
        }
        if (!result.waited) {
          printQueued(result);
          return;
        }
        const items = result.items ?? [];
        console.log();
        printItems(items);
        console.log(
          chalk.green(
            `\n✓ ${items.length} of ${items.length} items held on ${result.deviceName}; they display with no network`
          )
        );
        console.log();
      } catch (error) {
        console.error(chalk.red('\nError:'), (error as Error).message);
        process.exit(1);
      }
    }
  );
