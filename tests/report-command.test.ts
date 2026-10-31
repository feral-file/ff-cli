/**
 * `ff-cli report` end to end, against one loopback server that plays both
 * support-logs (`POST /v2/cli/reports`) and a plaintext FF1 (`GET /api/status`,
 * `POST /api/cast`).
 *
 * The CLI is spawned rather than called: the exit status, the stdout/stderr
 * split and the order of requests are the contract an agent relies on, and they
 * only exist at the process boundary. `spawn`, not `spawnSync`, because the
 * server runs on this process's event loop.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');
const { version } = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));

const BUNDLE_ID = '0Ab3dEf6gH9iJ';
const TOKEN = 'bundle-token.abc';
const RECEIPT = {
  support_bundle_id: BUNDLE_ID,
  ff1_upload_token: TOKEN,
  ff1_upload_token_expires_in_seconds: 1800,
};
const STATUS = {
  device_id: 'FF1-STATUS01',
  version: '2.0.14',
  branch: 'release',
  contract: '1',
  claimed: true,
  topic_id: '',
};

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Answer {
  status: number;
  body: unknown;
}

interface Routes {
  report?: Answer;
  status?: Answer;
  cast?: Answer;
}

/** startServer answers each route with `routes` (defaults: a receipt, STATUS, `{ok:true}`). */
async function startServer(routes: Routes = {}): Promise<{
  url: string;
  seen: Seen[];
  close: () => void;
}> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      seen.push({ method: req.method ?? '', path, headers: req.headers, body });
      const answer =
        path === '/v2/cli/reports'
          ? (routes.report ?? { status: 201, body: RECEIPT })
          : path === '/api/status'
            ? (routes.status ?? { status: 200, body: STATUS })
            : path === '/api/cast'
              ? (routes.cast ?? { status: 200, body: { ok: true } })
              : { status: 404, body: { code: 'not_found', message: 'no route' } };
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }
  return { url: `http://127.0.0.1:${address.port}`, seen, close: () => server.close() };
}

/** closedPort returns a loopback URL nothing listens on. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${address.port}`;
}

interface RunOptions {
  supportUrl: string;
  deviceHost?: string;
  stdin?: string;
  config?: Record<string, unknown>;
  files?: Record<string, string>;
}

/** runReport runs `ff-cli report <args>` in a temp cwd whose config points at the test server. */
async function runReport(
  args: string[],
  options: RunOptions
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(os.tmpdir(), 'ff1-report-'));
  const config = {
    supportLogs: { baseUrl: options.supportUrl },
    ff1Devices: {
      devices: [
        { name: 'Office', id: 'FF1-CONFIG01', host: options.deviceHost ?? options.supportUrl },
      ],
    },
    ...options.config,
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf-8');
  for (const [name, content] of Object.entries(options.files ?? {})) {
    writeFileSync(join(dir, name), content, 'utf-8');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(dir, '.xdg') };
  delete env.FF_SUPPORT_LOGS_URL;
  delete env.PLAYLIST_PRIVATE_KEY;
  const child = spawn(process.execPath, [tsxCli, cliEntry, 'report', ...args], {
    cwd: dir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(options.stdin ?? '');
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  rmSync(dir, { recursive: true, force: true });
  return { status, stdout, stderr };
}

/** posted returns the parsed report bodies the server received. */
function posted(seen: Seen[]): Array<Record<string, unknown>> {
  return seen.filter((s) => s.path === '/v2/cli/reports').map((s) => JSON.parse(s.body));
}

describe('ff-cli report: text sources', () => {
  test('--message: posts the contract payload and prints the reference', async () => {
    const server = await startServer();
    try {
      const run = await runReport(
        ['--message', '  The work plays black.  ', '--email', 'a@example.com'],
        {
          supportUrl: server.url,
        }
      );
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(server.seen.length, 1);
      const [request] = server.seen;
      assert.equal(request.method, 'POST');
      assert.match(String(request.headers['content-type']), /application\/json/);
      assert.equal(request.headers['user-agent'], `ff-cli/${version}`);
      assert.deepEqual(JSON.parse(request.body), {
        report: 'The work plays black.',
        ff_cli_version: version,
        reporter_email: 'a@example.com',
        os: `${process.platform} ${os.release()}`,
        node_version: process.version,
      });
      assert.match(run.stdout, /Report sent to Feral File support/);
      assert.match(run.stdout, new RegExp(`Support \\[${BUNDLE_ID}\\]`));
      assert.match(run.stdout, /Support may reply to a@example\.com/);
      assert.match(run.stdout, /No Art Computer named/);
    } finally {
      server.close();
    }
  });

  test('--file: posts the file content', async () => {
    const server = await startServer();
    try {
      const run = await runReport(['--file', 'report.txt'], {
        supportUrl: server.url,
        files: { 'report.txt': 'Line one.\nLine two.\n' },
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(posted(server.seen)[0].report, 'Line one.\nLine two.');
      assert.equal('reporter_email' in posted(server.seen)[0], false);
      assert.match(run.stdout, /No --email given/);
    } finally {
      server.close();
    }
  });

  test('stdin: read when neither flag is given', async () => {
    const server = await startServer();
    try {
      const run = await runReport([], { supportUrl: server.url, stdin: 'From a pipe.\n' });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(posted(server.seen)[0].report, 'From a pipe.');
    } finally {
      server.close();
    }
  });

  const refusals: Array<{ name: string; args: string[]; stdin?: string; match: RegExp }> = [
    {
      name: '--message with --file',
      args: ['--message', 'a', '--file', 'report.txt'],
      match: /--message or --file, not both/,
    },
    { name: 'an empty --message', args: ['--message', '   '], match: /The report is empty/ },
    { name: 'empty stdin', args: [], stdin: '', match: /The report is empty/ },
    {
      name: 'an unreadable --file',
      args: ['--file', 'missing.txt'],
      match: /Could not read --file/,
    },
    {
      name: 'a report over 32768 bytes',
      args: [],
      stdin: 'é'.repeat(16_385),
      match: /32770 bytes; Feral File support takes at most 32768/,
    },
    {
      name: 'an --email that is not an address',
      args: ['--message', 'a', '--email', 'not-an-address'],
      match: /is not an address Feral File support can reply to[\s\S]*bare ASCII address/,
    },
    // support-logs answers these with a 400 or support-intake drops them as a
    // reply address, so they are refused before anything is sent.
    {
      name: 'an --email in angle brackets',
      args: ['--message', 'a', '--email', '<a@b.co>'],
      match: /"<a@b\.co>" is not an address Feral File support can reply to/,
    },
    {
      name: 'an --email with a quoted local part',
      args: ['--message', 'a', '--email', '"x"@b.co'],
      match: /is not an address Feral File support can reply to/,
    },
    {
      name: 'an --email with a non-ASCII domain',
      args: ['--message', 'a', '--email', 'user@bücher.de'],
      match: /"user@bücher\.de" is not an address Feral File support can reply to/,
    },
    {
      name: "support's own address as --email",
      args: ['--message', 'a', '--email', 'Support@FeralFile.com'],
      match: /is an address Feral File support does not reply to/,
    },
    {
      name: 'an unknown -d',
      args: ['--message', 'a', '-d', 'Attic'],
      match: /Device "Attic" not found/,
    },
  ];
  for (const refusal of refusals) {
    test(`refuses ${refusal.name}, exit 1, nothing sent`, async () => {
      const server = await startServer();
      try {
        const run = await runReport(refusal.args, {
          supportUrl: server.url,
          stdin: refusal.stdin,
          files: { 'report.txt': 'text' },
        });
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.match(run.stderr, refusal.match);
        assert.deepEqual(server.seen, []);
      } finally {
        server.close();
      }
    });
  }

  test('refuses a report carrying the configured signing key, in another encoding', async () => {
    const server = await startServer();
    const key = generateKeyPairSync('ed25519').privateKey;
    const configured = key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const seedHex = Buffer.from(String(key.export({ format: 'jwk' }).d), 'base64url').toString(
      'hex'
    );
    try {
      const run = await runReport(['--message', `my key is ${seedHex.toUpperCase()}`], {
        supportUrl: server.url,
        config: { playlist: { privateKey: configured } },
      });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, /contains this computer's playlist signing key/);
      assert.match(run.stderr, /Nothing was sent/);
      assert.deepEqual(server.seen, []);
    } finally {
      server.close();
    }
  });

  test('refuses --file config.json when the config escapes the key as JSON allows', async () => {
    const server = await startServer();
    let configured = '';
    while (!configured.includes('/')) {
      configured = generateKeyPairSync('ed25519')
        .privateKey.export({ format: 'der', type: 'pkcs8' })
        .toString('base64');
    }
    // The loader decodes `\/`, so this config is the one ff-cli runs with and the file reported.
    const escapedConfig = JSON.stringify({
      supportLogs: { baseUrl: server.url },
      playlist: { privateKey: configured },
    })
      .split('/')
      .join('\\/');
    try {
      const run = await runReport(['--file', 'config.json'], {
        supportUrl: server.url,
        files: { 'config.json': escapedConfig },
      });
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, /contains this computer's playlist signing key/);
      assert.deepEqual(server.seen, []);
    } finally {
      server.close();
    }
  });
});

describe('ff-cli report: dry run', () => {
  test('prints the exact body with the device block and sends nothing', async () => {
    const server = await startServer();
    try {
      const run = await runReport(['--message', 'Dry.', '-d', 'Office', '--dry-run'], {
        supportUrl: server.url,
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      // Only the read-only status GET; no report and no cast.
      assert.deepEqual(
        server.seen.map((s) => `${s.method} ${s.path}`),
        ['GET /api/status']
      );
      const body = JSON.parse(run.stdout);
      assert.equal(body.report, 'Dry.');
      assert.equal(body.ff_cli_version, version);
      assert.deepEqual(body.device, {
        device_id: 'FF1-STATUS01',
        version: '2.0.14',
        branch: 'release',
      });
      assert.match(run.stderr, /Dry run: nothing was sent/);
      assert.match(run.stderr, new RegExp(`${server.url}/v2/cli/reports`));
      assert.match(run.stderr, /asks Office to upload its logs/);
    } finally {
      server.close();
    }
  });
});

describe('ff-cli report: Art Computer', () => {
  test('reads its status, posts the report, then sends uploadLogs with the token', async () => {
    const server = await startServer();
    try {
      const run = await runReport(['--message', 'Plays black.', '-d', 'Office'], {
        supportUrl: server.url,
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.deepEqual(
        server.seen.map((s) => `${s.method} ${s.path}`),
        ['GET /api/status', 'POST /v2/cli/reports', 'POST /api/cast']
      );
      assert.deepEqual(posted(server.seen)[0].device, {
        device_id: 'FF1-STATUS01',
        version: '2.0.14',
        branch: 'release',
      });
      assert.deepEqual(JSON.parse(server.seen[2].body), {
        command: 'uploadLogs',
        request: {
          userId: 'ff-cli',
          apiKey: TOKEN,
          title: 'ff-cli report',
          supportBundleID: BUNDLE_ID,
        },
      });
      assert.match(run.stdout, /Asked Office to upload its logs under the same reference/);
      assert.match(run.stdout, /needs internet/);
    } finally {
      server.close();
    }
  });

  test('an unreachable Art Computer is noted, and the exit status stays 0', async () => {
    const server = await startServer();
    try {
      const run = await runReport(['--message', 'Gone.', '-d', 'Office'], {
        supportUrl: server.url,
        deviceHost: await closedPort(),
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stderr, /Could not read the status of Office/);
      // The configured device ID still goes when the status cannot be read.
      assert.deepEqual(posted(server.seen)[0].device, { device_id: 'FF1-CONFIG01' });
      assert.match(run.stdout, new RegExp(`Support \\[${BUNDLE_ID}\\]`));
      assert.match(
        run.stdout,
        /Office did not take the request to upload its logs: Could not reach Office/
      );
      assert.match(run.stdout, /The report itself reached support/);
    } finally {
      server.close();
    }
  });

  test('a secured Art Computer refusing plaintext gets the pairing line, exit 0', async () => {
    const server = await startServer({
      cast: { status: 403, body: { error: { code: 'enrollment_required' } } },
    });
    try {
      const run = await runReport(['--message', 'Secured.', '-d', 'Office'], {
        supportUrl: server.url,
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /This FF1 is secured/);
      assert.match(run.stdout, /ff-cli device pair Office/);
    } finally {
      server.close();
    }
  });
});

describe('ff-cli report: the report does not post', () => {
  const failures: Array<{ name: string; report?: Answer; match: RegExp }> = [
    {
      name: '400',
      report: { status: 400, body: { code: 'invalid_report', message: 'report is required' } },
      match: /refused the report \(HTTP 400\): report is required/,
    },
    {
      name: '429',
      report: { status: 429, body: { code: 'rate_limited', message: 'too many requests' } },
      match: /limiting reports right now \(HTTP 429\)[\s\S]*Wait a few minutes/,
    },
    {
      name: '503',
      report: { status: 503, body: { code: 'unavailable', message: 'not configured' } },
      match: /could not take the report \(HTTP 503\)[\s\S]*support@feralfile\.com/,
    },
    {
      name: 'a 201 without a reference',
      report: { status: 201, body: { ok: true } },
      match: /without a report reference/,
    },
  ];
  for (const failure of failures) {
    test(`${failure.name}: exit 1, and the Art Computer is not asked`, async () => {
      const server = await startServer({ report: failure.report });
      try {
        const run = await runReport(['--message', 'Fails.', '-d', 'Office'], {
          supportUrl: server.url,
        });
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.match(run.stderr, failure.match);
        assert.equal(
          server.seen.some((s) => s.path === '/api/cast'),
          false
        );
        assert.doesNotMatch(run.stdout, /Report sent/);
      } finally {
        server.close();
      }
    });
  }

  test('network failure: exit 1 and says to check the connection', async () => {
    const run = await runReport(['--message', 'Offline.'], { supportUrl: await closedPort() });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /Could not reach Feral File support/);
    assert.match(run.stderr, /internet connection/);
  });
});
