import { Command } from 'commander';
import chalk from 'chalk';
import { promises as fs } from 'fs';
import { getPlaylistConfig, getSupportLogsConfig } from '../config';
import { resolveConfiguredDevice } from '../utilities/ff1-compatibility';
import {
  type ReportDevice,
  type ReportFailure,
  type ReportReceipt,
  MAX_REPORT_BYTES,
  buildReportPayload,
  containsSigningKey,
  isEmailAddress,
  postReport,
  readDeviceStatus,
  requestLogUpload,
} from '../utilities/support-report';
import type { FF1Device } from '../types';

interface ReportOptions {
  message?: string;
  file?: string;
  email?: string;
  device?: string;
  dryRun?: boolean;
}

/** REPORT_HELP says what a report carries, so a caller knows what leaves the machine before sending. */
const REPORT_HELP = `
The report text comes from --message or --file (not both), or from stdin when
neither is given and stdin is not a terminal. It goes privately to Feral File
support with this ff-cli version, the OS, and the Node version, and with
--email when given. Nothing else leaves this computer: no config, keys, or
playlists.

With -d, the report also carries the Art Computer's device ID, FF OS version and
branch, and once it is in, the Art Computer is asked to upload its logs under
the same reference. It uploads in the background and needs internet. On FF OS
with secure control, that request needs ff-cli paired with the owner role.

Exit status: 0 when the report reached Feral File support, even if the Art
Computer did not take the log request; 1 when it did not.

Examples:
  ff-cli report --message "The work plays black on the Art Computer; in a desktop browser it renders." -d Office
  ff-cli report --file report.txt --email you@example.com
  printf '%s\\n' "$REPORT" | ff-cli report -d Office --dry-run
`;

/**
 * `ff-cli report` sends a problem report to Feral File support, the same
 * pipeline the app's Support & Feedback feeds, so an agent driving ff-cli can
 * report what went wrong without a person pressing send. The wire contract and
 * what may be sent live in utilities/support-report.ts.
 */
export const reportCommand = new Command('report')
  .description(
    "Send a problem report to Feral File support, with an Art Computer's logs when one is involved"
  )
  .option('--message <text>', 'The report text')
  .option('--file <path>', 'Read the report text from this file')
  .option('--email <address>', 'Where Feral File support may reply')
  .option(
    '-d, --device <name>',
    'The Art Computer involved: adds its device ID, version and branch, and asks it to upload its logs'
  )
  .option('--dry-run', 'Print the JSON that would be sent, and send nothing')
  .addHelpText('after', REPORT_HELP)
  .action(async (options: ReportOptions) => {
    try {
      await runReport(options);
    } catch (error) {
      console.error(chalk.red('\nError:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * runReport checks the report, reads the Art Computer's status, posts the
 * report, then asks the Art Computer for its logs. Every refusal before the
 * post exits 1 with nothing sent; after the post the exit status is 0.
 *
 * @param options - Command options
 * @returns Promise that resolves when the report is done
 */
async function runReport(options: ReportOptions): Promise<void> {
  const report = await readReport(options);
  const email = options.email?.trim();
  checkReport(report, email);
  const { baseUrl } = getSupportLogsConfig();
  const device = options.device !== undefined ? selectDevice(options.device) : undefined;
  const deviceBlock = device ? await describeDevice(device) : undefined;
  // One serialization, so --dry-run prints the very bytes a real run posts.
  const body = JSON.stringify(buildReportPayload({ report, email, device: deviceBlock }), null, 2);
  if (options.dryRun) {
    printDryRun(body, baseUrl, device);
    return;
  }
  const posted = await postReport(baseUrl, body);
  if (posted.ok === false) {
    exitWith(posted);
  }
  printReceipt(posted.receipt, email);
  await askForLogs(device, posted.receipt);
}

/**
 * readReport returns the trimmed report text from exactly one source. Flags
 * win and stdin is read only when neither is given: an agent's stdin is often
 * a pipe that carries nothing, and reading it beside a flag would wait on it.
 *
 * @param options - Command options
 * @returns The report text, possibly empty
 */
async function readReport(options: ReportOptions): Promise<string> {
  if (options.message !== undefined && options.file !== undefined) {
    exitWith({ error: 'Give the report once: --message or --file, not both.' });
  }
  if (options.message !== undefined) {
    return options.message.trim();
  }
  if (options.file !== undefined) {
    try {
      return (await fs.readFile(options.file, 'utf-8')).trim();
    } catch (error) {
      exitWith({ error: `Could not read --file ${options.file}: ${(error as Error).message}` });
    }
  }
  if (process.stdin.isTTY) {
    exitWith({
      error: 'No report given.',
      details: 'Pass --message "<text>" or --file <path>, or pipe the text on stdin.',
    });
  }
  return (await readStdin()).trim();
}

/** readStdin reads all of stdin as UTF-8. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * checkReport refuses a report support-logs would refuse, a reply address
 * that is not one, and a report carrying this computer's signing key.
 *
 * @param report - Trimmed report text
 * @param email - Trimmed --email value; an empty one is refused, not dropped
 */
function checkReport(report: string, email: string | undefined): void {
  if (!report) {
    exitWith({
      error: 'The report is empty.',
      details: 'If the text came from a shell variable, check that it is set.',
    });
  }
  const bytes = Buffer.byteLength(report, 'utf8');
  if (bytes > MAX_REPORT_BYTES) {
    exitWith({
      error: `The report is ${bytes} bytes; Feral File support takes at most ${MAX_REPORT_BYTES}.`,
      details:
        "Shorten it. With -d the Art Computer's logs travel separately, so leave log excerpts out.",
    });
  }
  if (email !== undefined && !isEmailAddress(email)) {
    exitWith({ error: `--email "${email}" is not an email address.` });
  }
  if (containsSigningKey(report, getPlaylistConfig().privateKey)) {
    exitWith({
      error: "The report contains this computer's playlist signing key.",
      details: 'Remove the key and run the command again. Nothing was sent.',
    });
  }
}

/** selectDevice resolves -d the way `play -d` does, or exits 1 naming the configured devices. */
function selectDevice(name: string): FF1Device {
  const selected = resolveConfiguredDevice(name);
  if (!selected.success || !selected.device) {
    exitWith({ error: selected.error || 'The Art Computer is not configured correctly.' });
  }
  return selected.device;
}

/** describeDevice reads the Art Computer block, noting a failed status read without stopping. */
async function describeDevice(device: FF1Device): Promise<ReportDevice> {
  const status = await readDeviceStatus(device);
  if (status.error) {
    console.error(
      chalk.yellow(
        `Could not read the status of ${deviceLabel(device)} (${status.error}); the report goes without its version and branch.`
      )
    );
  }
  return status.device;
}

/** printDryRun prints the body on stdout and what a real run would do on stderr. */
function printDryRun(body: string, baseUrl: string, device: FF1Device | undefined): void {
  process.stdout.write(`${body}\n`);
  console.error(
    chalk.dim(`Dry run: nothing was sent. A real run posts this to ${baseUrl}/v2/cli/reports`)
  );
  if (device) {
    console.error(
      chalk.dim(
        `Then it asks ${deviceLabel(device)} to upload its logs under the reference that comes back.`
      )
    );
  }
}

/** printReceipt reports the reference in the app's `Support [<id>]` form and who support can reply to. */
function printReceipt(receipt: ReportReceipt, email: string | undefined): void {
  console.log(chalk.green('✓ Report sent to Feral File support'));
  console.log(`  Reference: Support [${receipt.supportBundleId}]`);
  console.log(
    chalk.dim(
      email
        ? `  Support may reply to ${email}`
        : '  No --email given, so support has no address to reply to'
    )
  );
}

/**
 * askForLogs asks the Art Computer to upload its logs under the report's
 * reference and prints the outcome. Best effort: a failure prints a line and
 * leaves the exit status at 0, since the report already reached support.
 *
 * @param device - Art Computer named with -d, if any
 * @param receipt - The posted report's receipt
 */
async function askForLogs(device: FF1Device | undefined, receipt: ReportReceipt): Promise<void> {
  if (!device) {
    console.log(chalk.dim('  No Art Computer named (-d), so no device logs were requested'));
    return;
  }
  const label = deviceLabel(device);
  if (!receipt.uploadToken) {
    console.log(
      chalk.yellow(`${label} was not asked to upload its logs: support returned no upload token.`)
    );
    return;
  }
  const result = await requestLogUpload(device, {
    supportBundleId: receipt.supportBundleId,
    uploadToken: receipt.uploadToken,
  });
  if (result.success) {
    console.log(chalk.green(`✓ Asked ${label} to upload its logs under the same reference`));
    console.log(chalk.dim('  It uploads in the background and needs internet to do it'));
    return;
  }
  console.log(
    chalk.yellow(`${label} did not take the request to upload its logs: ${result.error}`)
  );
  if (result.details) {
    console.log(chalk.dim(`  ${result.details}`));
  }
  console.log(chalk.dim('  The report itself reached support.'));
}

/** deviceLabel names a device in output. */
function deviceLabel(device: FF1Device): string {
  return device.name || device.host;
}

/** exitWith prints a failure and exits 1. */
function exitWith(failure: ReportFailure): never {
  console.error(chalk.red(`\n${failure.error}`));
  if (failure.details) {
    console.error(chalk.dim(`  ${failure.details}`));
  }
  process.exit(1);
}
