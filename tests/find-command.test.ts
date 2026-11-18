/**
 * Command-level tests for `ff-cli find` against a mock
 * ff-source-resolver-service (wired in via the SOURCE_RESOLVER_URL override).
 *
 * The transport's error split is unit-tested in
 * source-resolver-client.test.ts; these cover the user-visible behavior of
 * the command itself: the confirm prompt text for complete vs capped series,
 * the --output prompt bypass, the single-token fallback messaging, the
 * degrade when the service is unavailable, collection pages read through
 * `/tokens`, and the zero-supported-tokens failure exit.
 *
 * All prompts are answered "n", or bypassed with --output. Both the service
 * and the FF indexer client are pointed at local mocks (SOURCE_RESOLVER_URL,
 * INDEXER_API_URL), so the suite is hermetic: no test reaches a network
 * service, and none depends on how fast one answers.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
// Spawn node directly with tsx's JS entry to avoid Windows .cmd shim
// limitations in spawn (Node refuses to execute .bat/.cmd without shell).
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

type GraphQLHandler = (query: string, variables: Record<string, unknown>) => unknown;

/** ServiceCall is one request the mock source resolver received. */
interface ServiceCall {
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  apiKey: string;
}

/** ServiceAnswer is what a handler returns: a JSON body and an optional status. */
interface ServiceAnswer {
  status?: number;
  body: unknown;
}

type ServiceHandler = (call: ServiceCall) => ServiceAnswer;

let server: Server;
let serverUrl: string;
let handler: ServiceHandler;
let serviceCalls: ServiceCall[] = [];

// The FF indexer client gets its own server, speaking the indexer's GraphQL.
let indexerServer: Server;
let indexerUrl: string;
/**
 * Operations the indexer mock was asked for, per test, tagged with the token
 * they concern. getNFTTokenInfoBatch runs both token workflows concurrently
 * under Promise.all, so there is no meaningful global ordering between them —
 * only each token's own lifecycle is ordered.
 */
let indexerOps: { op: string; token: string }[] = [];
/** Job id handed out per token at enqueue, so a poll can be attributed back. */
const jobIds = new Map<number, string>();

const VALID_ETH_CONTRACT = '0xababababab20053426ad1c782de9ea8444358070';

before(async () => {
  // Speaks ff-source-resolver-service's lookup routes. Each request is
  // recorded (path, query, body, API-KEY) and answered by the test's handler;
  // the toggles below model the service being unavailable in each of the
  // ways find must degrade on.
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      const call: ServiceCall = {
        path: url.pathname,
        query: url.searchParams,
        body: raw ? JSON.parse(raw) : null,
        apiKey: String(req.headers['api-key'] ?? ''),
      };
      serviceCalls.push(call);
      res.setHeader('Content-Type', 'application/json');
      if (refusal !== null && (refuseOnly === null || refuseOnly.test(call.path))) {
        res.statusCode = refusal.status;
        res.end(JSON.stringify(refusal.body));
        return;
      }
      if (destroyResponseBody) {
        // Headers out, body terminated mid-stream: fetch() resolves, the
        // body read rejects — the #98-review failure mode.
        res.write('{"found": ');
        res.destroy();
        return;
      }
      const answer = handler(call);
      res.statusCode = answer.status ?? 200;
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock source resolver did not bind to a port');
  }
  serverUrl = `http://127.0.0.1:${address.port}`;

  // Speaks the indexer's actual GraphQL contract, per operation, and REJECTS
  // anything else. A permissive fallback is what let the previous version pass
  // without proving anything: it answered every unrecognized operation with an
  // empty token envelope, so a client regression (consuming `jobId` instead of
  // the real `job_id`, say) still produced "2/2 tokens indexed" and the same
  // "no tokens could be indexed" exit. Rejecting the unexpected is what makes
  // the recorded sequence below evidence rather than decoration.
  //
  // The empty token list is deliberate: the run completes the whole
  // enqueue -> poll -> query path and then exits on "no tokens could be
  // indexed", which is a determinate outcome the test can assert.
  indexerServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { query, variables } = JSON.parse(body || '{}') as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      res.setHeader('Content-Type', 'application/json');

      // A token CID ends in :<tokenId>, which is what tells the two concurrent
      // workflows apart. jobStatus carries only a job_id, so enqueue hands out
      // one id per token and this maps it back.
      const tokenOf = (cid: string): string => {
        const parts = cid.split(':');
        return parts[parts.length - 1] || 'unknown';
      };
      // The mutation passes token_cids as a GraphQL variable; the tokens query
      // interpolates them into the query text instead (buildTokensListQuery is
      // documented as "inline arguments, no variables"). Both carriages have to
      // be read, or half the lifecycle goes untagged.
      const cidFromVariables = (value: unknown): string =>
        tokenOf(Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));
      const cidFromQuery = (text: string): string => {
        const match = /token_cids:\s*\[\s*"([^"]+)"/.exec(text);
        return match ? tokenOf(match[1]) : 'unknown';
      };

      if (query?.includes('triggerTokenIndexing')) {
        const token = cidFromVariables(variables?.token_cids);
        const jobId = jobIds.size + 1;
        jobIds.set(jobId, token);
        indexerOps.push({ op: 'enqueue', token });
        res.end(JSON.stringify({ data: { triggerTokenIndexing: { job_id: jobId } } }));
        return;
      }
      if (query?.includes('jobStatus')) {
        const jobId = Number(variables?.job_id);
        indexerOps.push({ op: 'jobStatus', token: jobIds.get(jobId) ?? 'unknown' });
        res.end(JSON.stringify({ data: { jobStatus: { status: 'completed', last_error: null } } }));
        return;
      }
      if (indexerOwnerHandler && query?.includes('owners:')) {
        res.end(JSON.stringify(indexerOwnerHandler(query, {})));
        return;
      }
      if (query?.includes('tokens')) {
        indexerOps.push({ op: 'tokens', token: cidFromQuery(query) });
        res.end(JSON.stringify({ data: { tokens: { items: [], total: 0 } } }));
        return;
      }
      indexerOps.push({ op: 'UNEXPECTED', token: 'unknown' });
      res.statusCode = 400;
      res.end(JSON.stringify({ errors: [{ message: 'mock: unexpected indexer operation' }] }));
    });
  });

  await new Promise<void>((resolveListen) => {
    indexerServer.listen(0, '127.0.0.1', resolveListen);
  });
  const indexerAddress = indexerServer.address();
  if (indexerAddress === null || typeof indexerAddress === 'string') {
    throw new Error('mock indexer server did not bind to a port');
  }
  indexerUrl = `http://127.0.0.1:${indexerAddress.port}/graphql`;
});

after(() => {
  server.close();
  indexerServer.close();
});

let destroyResponseBody = false;
/** When set, the service answers this instead of calling the handler. */
let refusal: (ServiceAnswer & { status: number }) | null = null;
/** When set, only routes whose path matches are refused. */
let refuseOnly: RegExp | null = null;
let indexerOwnerHandler: GraphQLHandler | undefined;

/** UNAUTHORIZED is how the service refuses a missing or wrong client key. */
const UNAUTHORIZED = {
  status: 400,
  body: { kind: 'error', code: 'INVALID_INPUT', message: 'Unauthorized.' },
};

beforeEach(() => {
  handler = (call) => ({
    status: 400,
    body: { kind: 'error', code: 'INVALID_INPUT', message: `no handler for ${call.path}` },
  });
  serviceCalls = [];
  destroyResponseBody = false;
  refusal = null;
  refuseOnly = null;
  indexerOps = [];
  indexerOwnerHandler = undefined;
  jobIds.clear();
});

interface RunResult {
  stdout: string;
  stderr: string;
  /** Process exit code. */
  code: number | null;
}

/**
 * Run `ff-cli find <args>` against the mock source resolver.
 *
 * `stdin` is written to the child's stdin and closed (prompt answers).
 *
 * Every run completes on its own: both GraphQL clients are pointed at local
 * mocks, so there is no network call to cut short. The harness used to take a
 * `killOn` regex and SIGKILL the child mid-run to stop it reaching the real
 * indexer; that raced the network and is gone.
 */
function runFind(
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {}
): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-find-cmd-'));
    const child = spawn(process.execPath, [tsxCli, cliEntry, 'find', ...args], {
      cwd: dir,
      env: {
        ...process.env,
        SOURCE_RESOLVER_URL: serverUrl,
        FF_SOURCE_RESOLVER_API_KEY: 'test-client-key',
        // Without these the run reaches the real indexer once it passes the
        // prompt, and polls it for POLLING_TIMEOUT_MS (60s). The override is
        // gated on NODE_ENV so it cannot become ambient configuration.
        NODE_ENV: 'test',
        INDEXER_API_URL: indexerUrl,
        FORCE_COLOR: '0',
        ...options.env,
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (result: RunResult | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // On Windows the just-killed child can briefly hold its cwd open
      // (EBUSY); retry, and prefer leaking a temp dir over a flaky test.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // best-effort cleanup only
      }
      if (result instanceof Error) {
        rejectRun(result);
      } else {
        resolveRun(result);
      }
    };

    // Hermeticity backstop: a hung prompt or an unexpected network call
    // should fail the test, not stall the suite. Resolution happens in the
    // 'close' handler so the child is fully gone before cleanup.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 30_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (timedOut) {
        finish(new Error(`find timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      } else {
        finish({ stdout, stderr, code });
      }
    });

    child.stdin.write(options.stdin ?? '');
    child.stdin.end();
  });
}

const VALID_TEZOS_CONTRACT = 'KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton';
const TOKEN_INPUT = `ethereum:${VALID_ETH_CONTRACT}:1`;

/**
 * workCard builds a `/work` answer for the test token. `series` adds the
 * fields the service sets only for a series of distinct outputs.
 */
function workCard(
  options: { series?: boolean; diag?: string[]; work?: Record<string, unknown> } = {}
): ServiceAnswer {
  return {
    body: {
      found: true,
      work: {
        title: 'Test Series #1',
        artist: 'Test Artist',
        chain: 'ethereum',
        contract: VALID_ETH_CONTRACT,
        tokenId: '1',
        series: 'Test Series',
        ...(options.series ? { seriesSlug: 'test-series', seriesSize: 3 } : {}),
        ...options.work,
      },
      diag: options.diag ?? [],
    },
  };
}

/** seriesPage builds a `/series` page of Ethereum outputs. */
function seriesPage(tokenIds: string[], next = '', skipped = 0): ServiceAnswer {
  return {
    body: {
      title: 'Test Series',
      total: tokenIds.length,
      outputs: tokenIds.map((tokenId) => ({
        tokenId,
        title: `Test Series #${tokenId}`,
        chain: 'ethereum',
        contract: VALID_ETH_CONTRACT,
      })),
      next,
      skipped,
    },
  };
}

/** A Raster token record carrying the media a Raster-sourced item needs. */
const PLAYABLE_ETH_TOKEN = (tokenId: string, contract = VALID_ETH_CONTRACT) => ({
  chainId: 'eip155:1',
  contractAddress: contract,
  tokenId,
  tokenStandard: 'ERC721',
  name: `Test Series #${tokenId}`,
  description: 'A test work.',
  media: {
    previewHash: null,
    previewType: null,
    contentUrl: `https://example.com/${tokenId}.mp4`,
    normalizedContentUrl: null,
    contentType: 'video',
  },
  artworks: [
    {
      id: '42',
      slug: 'test-series',
      title: 'Test Series',
      description: '',
      platform: { id: 'feralfile', name: 'Feral File' },
      artists: [{ id: '7', name: 'Test Artist', slug: 'test-artist' }],
    },
  ],
  artists: [],
});

/** rasterTokensFor answers `/raster/tokens` with a playable record per ref. */
function rasterTokensFor(call: ServiceCall): ServiceAnswer {
  const refs = (call.body?.refs ?? []) as Array<{ contract: string; tokenId: string }>;
  return { body: { tokens: refs.map((ref) => PLAYABLE_ETH_TOKEN(ref.tokenId, ref.contract)) } };
}

/** paths lists the routes the service was asked, in order. */
function paths(): string[] {
  return serviceCalls.map((call) => call.path);
}

/**
 * withoutNodeDeprecations drops the deprecation warnings Node itself prints
 * (Node 26 flags tsx's `module.register()` as DEP0205), so a test can still
 * catch a deprecation ff-cli prints. Node writes the warning as
 * `(node:PID) [DEP0205] DeprecationWarning: <text>` plus a
 * `--trace-deprecation` hint, and the loader repeats `DeprecationWarning:
 * <text>`; only lines carrying a Node DEP code, that hint, or that exact
 * repeated text are removed.
 *
 * @param stderr - The child's stderr
 * @returns stderr without Node's own deprecation lines
 */
function withoutNodeDeprecations(stderr: string): string {
  const lines = stderr.split('\n');
  const repeated = new Set(
    lines
      .map((line) => /\[DEP\d{4}\] (DeprecationWarning: .*)$/.exec(line)?.[1])
      .filter((text): text is string => !!text)
  );
  return lines
    .filter(
      (line) =>
        !/\[DEP\d{4}\] DeprecationWarning:/.test(line) &&
        !/^\(Use `node --trace-deprecation/.test(line) &&
        !repeated.has(line.trim())
    )
    .join('\n');
}

describe('find command — wallet addresses', () => {
  test('an unclaimed address falls back to an owner lookup', async () => {
    handler = () => ({ body: { artists: [] } });
    const result = await runFind([VALID_ETH_CONTRACT, '--limit', '1', '--output', 'wallet.json']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No playable tokens found in wallet/);
    assert.deepEqual(paths(), ['/raster/artists']);
    assert.equal(serviceCalls[0].query.get('address'), VALID_ETH_CONTRACT);
    assert.equal(indexerOps.length, 1);
    assert.equal(indexerOps[0].op, 'tokens');
  });

  test('a failed second wallet page aborts the playlist', async () => {
    handler = () => ({ body: { artists: [] } });
    const offsets: number[] = [];
    indexerOwnerHandler = (query) => {
      const offset = Number(/offset:\s*(\d+)/.exec(query)?.[1]);
      offsets.push(offset);
      if (offset === 50) {
        return { errors: [{ message: 'second page unavailable' }] };
      }
      return {
        data: {
          tokens: {
            items: Array.from({ length: 50 }, (_, i) => ({
              contract_address: VALID_ETH_CONTRACT,
              token_number: String(i),
              chain: 'eip155:1',
              standard: 'erc721',
              display: { name: `Token ${i}`, image_url: 'https://example.com/token.png' },
            })),
            total: 51,
          },
        },
      };
    };
    const result = await runFind([VALID_ETH_CONTRACT, '--limit', '51', '--output', 'wallet.json']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /second page unavailable/);
    assert.doesNotMatch(result.stdout, /Playlist saved/);
    assert.deepEqual(offsets, [0, 50]);
  });

  test('owner lookup saves a playlist from the configured Raster source', async () => {
    handler = (call) => {
      if (call.path === '/raster/artists') {
        return { body: { artists: [] } };
      }
      assert.equal(call.path, '/raster/tokens-owned');
      return {
        body: {
          tokens: ['1', '2'].map((id) => ({
            quantity: 1,
            lastAcquiredAt: null,
            token: PLAYABLE_ETH_TOKEN(id),
          })),
          next: '',
        },
      };
    };
    const result = await runFind([VALID_ETH_CONTRACT, '--limit', '1', '--output', 'wallet.json'], {
      env: { FF_TOKEN_SOURCE: 'raster' },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Playlist saved to wallet\.json/);
    assert.match(result.stdout, /1 item\b/);
    assert.deepEqual(indexerOps, []);
  });

  test("an artist's address builds the picked work's series", async () => {
    handler = (call) => {
      if (call.path === '/raster/artists') {
        return { body: { artists: [{ id: '7', name: 'Test Artist', slug: 'test-artist' }] } };
      }
      if (call.path === '/raster/artist-works') {
        return {
          body: { works: [{ id: '42', slug: 'test-series', title: 'Test Series' }], next: '' },
        };
      }
      return seriesPage(['1', '2']);
    };
    const result = await runFind([VALID_ETH_CONTRACT], { stdin: 'n\n' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Test Artist — Test Series/);
    assert.match(result.stdout, /Build playlist with 2 tokens\?/);
    assert.deepEqual(paths(), ['/raster/artists', '/raster/artist-works', '/series']);
    assert.equal(serviceCalls[1].query.get('id'), '7');
    assert.equal(serviceCalls[2].query.get('slug'), 'test-series');
  });

  test('the service refusing an address lookup lists the wallet through the indexer (feral-file#3612)', async () => {
    refusal = UNAUTHORIZED;
    const result = await runFind([VALID_ETH_CONTRACT, '--limit', '1', '--output', 'wallet.json']);
    // The empty indexer listing ends the run; what matters is that the run got
    // there instead of dying on the refusal.
    assert.match(result.stdout, /Feral File source resolver 400 INVALID_INPUT: Unauthorized\./);
    assert.match(
      result.stdout,
      /Continuing without the source resolver — listing the wallet's holdings/
    );
    assert.match(result.stderr, /No playable tokens found in wallet/);
    assert.equal(indexerOps.length, 1);
    assert.equal(indexerOps[0].op, 'tokens');
  });

  test('the service failing the artist catalog after naming the artist lists the wallet', async () => {
    handler = () => ({
      body: { artists: [{ id: '7', name: 'Test Artist', slug: 'test-artist' }] },
    });
    refusal = {
      status: 502,
      body: { kind: 'error', code: 'UPSTREAM_UNAVAILABLE', message: 'api.raster.art 429' },
    };
    refuseOnly = /artist-works/;
    const result = await runFind([VALID_ETH_CONTRACT, '--limit', '1', '--output', 'wallet.json']);
    assert.match(result.stdout, /502 UPSTREAM_UNAVAILABLE: api\.raster\.art 429/);
    assert.match(
      result.stdout,
      /Continuing without the source resolver — listing the wallet's holdings/
    );
    assert.match(result.stderr, /No playable tokens found in wallet/);
    assert.equal(indexerOps.length, 1);
  });
});

describe('find command — series flow', () => {
  test('complete series → "Build playlist with N tokens?" prompt; "n" cancels before resolving', async () => {
    handler = (call) =>
      call.path === '/work' ? workCard({ series: true }) : seriesPage(['1', '2']);
    const result = await runFind([TOKEN_INPUT], { stdin: 'n\n' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Test Artist — Test Series/);
    assert.match(result.stdout, /Build playlist with 2 tokens\?/);
    assert.doesNotMatch(result.stdout, /the first/);
    assert.match(result.stdout, /Cancelled\./);
    assert.doesNotMatch(result.stdout, /Resolving/);
    // The input goes to /work as typed, then the series by its slug, with the client key.
    assert.deepEqual(paths(), ['/work', '/series']);
    assert.equal(serviceCalls[0].query.get('url'), TOKEN_INPUT);
    assert.equal(serviceCalls[1].query.get('slug'), 'test-series');
    assert.ok(serviceCalls.every((call) => call.apiKey === 'test-client-key'));
  });

  test('--limit below series size → "the first N tokens" prompt wording', async () => {
    handler = (call) =>
      call.path === '/work' ? workCard({ series: true }) : seriesPage(['1', '2', '3'], 'c2');
    const result = await runFind([TOKEN_INPUT, '--limit', '2'], { stdin: 'n\n' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Build playlist with the first 2 tokens\?/);
    assert.match(result.stdout, /Cancelled\./);
    assert.deepEqual(paths(), ['/work', '/series']);
  });

  test('a series walks every page until the end', async () => {
    handler = (call) => {
      if (call.path === '/work') {
        return workCard({ series: true });
      }
      return call.query.get('after') === 'c2' ? seriesPage(['3']) : seriesPage(['1', '2'], 'c2');
    };
    const result = await runFind([TOKEN_INPUT], { stdin: 'n\n' });
    assert.match(result.stdout, /Build playlist with 3 tokens\?/);
    assert.deepEqual(paths(), ['/work', '/series', '/series']);
  });

  test('--output bypasses the prompt and builds from Raster with no indexer call', async () => {
    handler = (call) => {
      if (call.path === '/work') {
        return workCard({ series: true });
      }
      return call.path === '/series' ? seriesPage(['1', '2']) : rasterTokensFor(call);
    };
    const result = await runFind([TOKEN_INPUT, '--output', 'out.json'], {
      env: { FF_TOKEN_SOURCE: 'raster' },
    });
    assert.doesNotMatch(result.stdout, /Build playlist with/);
    assert.match(result.stdout, /Resolving 2 tokens via Raster/);
    assert.match(result.stdout, /Playlist saved to out\.json/);
    assert.equal(result.code, 0, result.stderr);
    // The feral-file#3576 done check: building yields items and the request
    // trace shows no indexer call at all.
    assert.deepEqual(indexerOps, []);
    // Raster's records come through the service in one batch.
    assert.deepEqual(paths(), ['/work', '/series', '/raster/tokens']);
  });

  test('the default token source is the indexer, with no deprecation warning', async () => {
    handler = (call) =>
      call.path === '/work' ? workCard({ series: true }) : seriesPage(['1', '2']);
    const result = await runFind([TOKEN_INPUT, '--output', 'out.json']);
    assert.doesNotMatch(withoutNodeDeprecations(result.stderr), /deprecated/i);
    assert.match(result.stdout, /Resolving 2 tokens via FF indexer/);
    assert.match(result.stdout, /2\/2 tokens resolved/);
    assert.match(result.stderr, /No tokens could be resolved via FF indexer/);
    assert.equal(result.code, 1);
    // What shows the protocol path completed is each token's own lifecycle,
    // asserted per token because the two workflows run concurrently.
    assert.ok(
      !indexerOps.some((entry) => entry.op === 'UNEXPECTED'),
      'mock saw an operation it does not model'
    );
    for (const token of ['1', '2']) {
      const lifecycle = indexerOps.filter((entry) => entry.token === token).map((e) => e.op);
      assert.deepEqual(
        lifecycle,
        ['tokens', 'enqueue', 'jobStatus', 'tokens'],
        `token ${token}: looked up, missed, enqueued, polled to terminal, looked up again`
      );
    }
  });

  test('series with only unsupported-chain outputs → clear error, exit 1', async () => {
    handler = (call) => {
      if (call.path === '/work') {
        return workCard({ series: true });
      }
      return {
        body: {
          title: 'Test Series',
          total: 2,
          outputs: [{ tokenId: '', title: 'Off chain', chain: 'other', contract: '' }],
          next: '',
          skipped: 1,
        },
      };
    };
    const result = await runFind([TOKEN_INPUT], { stdin: 'n\n' });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Skipped 2 tokens on unsupported chains/);
    assert.match(result.stderr, /Series has no tokens on supported chains/);
  });

  test('a token outside any series → single-token messaging and 1-token prompt', async () => {
    handler = () => workCard();
    const result = await runFind([TOKEN_INPUT], { stdin: 'n\n' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp(`Single token — ethereum ${VALID_ETH_CONTRACT}:1`));
    assert.match(result.stdout, /No series of distinct works holds this token/);
    assert.match(result.stdout, /Build playlist with 1 token\?/);
    assert.match(result.stdout, /Cancelled\./);
    assert.deepEqual(paths(), ['/work']);
  });

  test("a source the service could not read is shown, not taken as proof there's no series", async () => {
    handler = () => workCard({ diag: ['api.raster.art 401'] });
    const result = await runFind([TOKEN_INPUT], { stdin: 'n\n' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Source resolver note: api\.raster\.art 401/);
    assert.doesNotMatch(result.stdout, /No series of distinct works/);
    assert.match(result.stdout, /Build playlist with 1 token\?/);
  });

  const unavailable: Array<[string, ServiceAnswer & { status: number }]> = [
    ['refusing the key', UNAUTHORIZED],
    ['answering 401', { status: 401, body: {} }],
    ['answering 403', { status: 403, body: {} }],
    ['answering 429', { status: 429, body: {} }],
    [
      'failing upstream (502)',
      { status: 502, body: { kind: 'error', code: 'UPSTREAM_UNAVAILABLE', message: 'x' } },
    ],
  ];
  for (const [label, answer] of unavailable) {
    test(`the service ${label} → warns and degrades to a one-item playlist (feral-file#3612)`, async () => {
      refusal = answer;
      const result = await runFind([TOKEN_INPUT], { stdin: 'n\n' });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Feral File source resolver ${answer.status}`));
      assert.match(
        result.stdout,
        /Continuing without the source resolver — building a one-item playlist/
      );
      assert.doesNotMatch(result.stdout, /No series of distinct works/);
      assert.match(result.stdout, /Build playlist with 1 token\?/);
      assert.match(result.stdout, /Cancelled\./);
    });
  }

  test('the series listing failing after the series was named → one-item playlist', async () => {
    handler = () => workCard({ series: true });
    refusal = {
      status: 502,
      body: { kind: 'error', code: 'UPSTREAM_UNAVAILABLE', message: 'api.raster.art 429' },
    };
    refuseOnly = /^\/series$/;
    const result = await runFind([TOKEN_INPUT], { stdin: 'n\n' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /api\.raster\.art 429/);
    assert.match(
      result.stdout,
      /Continuing without the source resolver — building from the input alone/
    );
    assert.match(result.stdout, new RegExp(`Single token — ethereum ${VALID_ETH_CONTRACT}:1`));
    assert.doesNotMatch(result.stdout, /No series of distinct works/);
    assert.match(result.stdout, /Build playlist with 1 token\?/);
  });

  test('a body terminating mid-stream → warns and degrades to a one-item playlist (#98 review)', async () => {
    // fetch() succeeds (headers arrive), the body read rejects. The typed
    // unavailability must survive to the target resolution so the find flow
    // degrades instead of dying.
    destroyResponseBody = true;
    const result = await runFind([TOKEN_INPUT], { stdin: 'n\n' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Feral File source resolver unreachable/);
    assert.match(
      result.stdout,
      /Continuing without the source resolver — building a one-item playlist/
    );
    assert.match(result.stdout, /Build playlist with 1 token\?/);
  });
});

describe('find command — links only the service can read', () => {
  test('a series link builds the whole series, with no token to fall back on', async () => {
    const link = 'https://feralfile.com/series/mock-series';
    handler = (call) =>
      call.path === '/work'
        ? workCard({
            series: true,
            work: { title: 'Mock Series', seriesSlug: 'ff:mock-series', tokenId: '', show: 'all' },
          })
        : seriesPage(['21', '22']);
    const result = await runFind([link], { stdin: 'n\n' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Test Artist — Test Series/);
    assert.match(result.stdout, /Build playlist with 2 tokens\?/);
    assert.equal(serviceCalls[0].query.get('url'), link);
    assert.equal(serviceCalls[1].query.get('slug'), 'ff:mock-series');
  });

  test('the service not answering for a raster.art link says only it can resolve it', async () => {
    refusal = UNAUTHORIZED;
    const result = await runFind(['https://raster.art/artwork/some-slug']);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /can only be resolved by the Feral File source resolver, which is not answering/
    );
    assert.match(result.stderr, /Unauthorized\./);
  });

  test('a collection page builds the tokens /tokens reads off it, capped by --limit', async () => {
    const link = `https://objkt.com/collections/${VALID_TEZOS_CONTRACT}`;
    handler = (call) => {
      if (call.path === '/work') {
        return workCard({ work: { chain: 'other', contract: '', tokenId: '', series: '' } });
      }
      if (call.path === '/tokens') {
        return {
          body: {
            title: 'Mock Objkt Collection',
            items: ['1', '2'].map((tokenId) => ({
              provenance: { contract: { chain: 'tezos', address: VALID_TEZOS_CONTRACT, tokenId } },
            })),
          },
        };
      }
      return rasterTokensFor(call);
    };
    const result = await runFind([link, '--limit', '1', '--output', 'collection.json'], {
      env: { FF_TOKEN_SOURCE: 'raster' },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Mock Objkt Collection/);
    assert.match(result.stdout, /Resolving 1 token via Raster/);
    assert.deepEqual(paths(), ['/work', '/tokens', '/raster/tokens']);
    assert.equal(serviceCalls[1].query.get('url'), link);
    assert.deepEqual(serviceCalls[2].body?.refs, [
      { chain: 'tezos', contract: VALID_TEZOS_CONTRACT, tokenId: '1' },
    ]);
  });

  test('a collection holding one token builds that token alone, never its parent series', async () => {
    const link = `https://objkt.com/collections/${VALID_TEZOS_CONTRACT}`;
    handler = (call) => {
      if (call.path === '/work') {
        return workCard({ work: { chain: 'other', contract: '', tokenId: '', series: '' } });
      }
      return {
        body: {
          title: 'One-Token Collection',
          items: [
            {
              provenance: {
                contract: { chain: 'tezos', address: VALID_TEZOS_CONTRACT, tokenId: '1' },
              },
            },
          ],
        },
      };
    };
    const result = await runFind([link], { stdin: 'n\n' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /One-Token Collection/);
    assert.match(result.stdout, /Build playlist with 1 token\?/);
    assert.deepEqual(paths(), ['/work', '/tokens']);
  });

  test("a project page builds its representative token's series through /work", async () => {
    const link = 'https://www.fxhash.xyz/generative/mock-project';
    handler = (call) => {
      if (call.path === '/tokens') {
        return {
          body: {
            title: 'One',
            items: [
              {
                provenance: {
                  contract: { chain: 'evm', address: VALID_ETH_CONTRACT, tokenId: '1' },
                },
              },
            ],
          },
        };
      }
      if (call.path === '/work' && call.query.get('url') === link) {
        return workCard({ work: { chain: 'other', contract: '', tokenId: '', series: '' } });
      }
      return call.path === '/work' ? workCard({ series: true }) : seriesPage(['1', '2']);
    };
    const result = await runFind([link], { stdin: 'n\n' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Build playlist with 2 tokens\?/);
    assert.deepEqual(paths(), ['/work', '/tokens', '/work', '/series']);
    assert.equal(serviceCalls[2].query.get('url'), TOKEN_INPUT);
  });

  test('a page with no token explains and points at display --web', async () => {
    const link = 'https://superrare.com/collection/0x1234567890123456789012345678901234567890';
    handler = (call) =>
      call.path === '/work'
        ? workCard({ work: { chain: 'other', contract: '', tokenId: '', series: '' } })
        : {
            status: 400,
            body: { code: 'NOT_FOUND', message: 'Could not extract token information' },
          };
    const result = await runFind([link]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /SuperRare collection URLs/);
    assert.match(result.stderr, /ff-cli display --web/);
  });
});
