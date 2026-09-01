/**
 * Command-level tests for the `ff-cli find` series flow against a mock
 * Raster GraphQL server (wired in via the RASTER_API_URL override).
 *
 * The Raster client unit tests (find-resolvers.test.ts) lock in response
 * parsing; these cover the user-visible behavior of the command itself:
 * the confirm prompt text for complete vs capped series, the --output
 * prompt bypass, the single-token fallback messaging, and the
 * zero-supported-tokens failure exit.
 *
 * All prompts are answered "n", or bypassed with --output. Both the Raster
 * client and the FF indexer client are pointed at the mock server
 * (RASTER_API_URL, INDEXER_API_URL), so the suite is hermetic: no test
 * reaches a network service, and none depends on how fast one answers.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
const testRequire = createRequire(__filename);
// Spawn node directly with tsx's JS entry to avoid Windows .cmd shim
// limitations in spawn (Node refuses to execute .bat/.cmd without shell).
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

type GraphQLHandler = (query: string, variables: Record<string, unknown>) => unknown;

let server: Server;
let serverUrl: string;
let handler: GraphQLHandler;

// The FF indexer client gets its own server: sharing one with Raster would
// force the handler to tell the two GraphQL vocabularies apart by substring,
// and both speak of "tokens".
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
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { query, variables } = JSON.parse(body) as {
        query: string;
        variables: Record<string, unknown>;
      };
      res.setHeader('Content-Type', 'application/json');
      if (destroyResponseBody) {
        // Headers out, body terminated mid-stream: fetch() resolves, the
        // body read rejects — the #98-review failure mode.
        res.write('{"data": {');
        res.destroy();
        return;
      }
      res.end(JSON.stringify(handler(query, variables ?? {})));
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock Raster server did not bind to a port');
  }
  serverUrl = `http://127.0.0.1:${address.port}/graphql`;

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

beforeEach(() => {
  handler = () => ({ errors: [{ message: 'no handler installed for this test' }] });
  destroyResponseBody = false;
  indexerOps = [];
  jobIds.clear();
});

interface RunResult {
  stdout: string;
  stderr: string;
  /** Process exit code. */
  code: number | null;
}

/**
 * Run `ff-cli find <args>` against the mock Raster server.
 *
 * `stdin` is written to the child's stdin and closed (prompt answers).
 *
 * Every run completes on its own: both GraphQL clients are pointed at local
 * mocks, so there is no network call to cut short. The harness used to take a
 * `killOn` regex and SIGKILL the child mid-run to stop it reaching the real
 * indexer; that raced the network and is gone.
 */
function runFind(args: string[], options: { stdin?: string } = {}): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-find-cmd-'));
    const child = spawn(process.execPath, [tsxCli, cliEntry, 'find', ...args], {
      cwd: dir,
      env: {
        ...process.env,
        RASTER_API_URL: serverUrl,
        // Without these the run reaches the real indexer once it passes the
        // prompt, and polls it for POLLING_TIMEOUT_MS (60s). The override is
        // gated on NODE_ENV so it cannot become ambient configuration.
        NODE_ENV: 'test',
        INDEXER_API_URL: indexerUrl,
        FORCE_COLOR: '0',
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

/** tokenByRef response: token belongs to a Raster-indexed series. */
const SERIES_HIT = {
  data: {
    tokenByRef: {
      artworks: [
        {
          id: '42',
          title: 'Test Series',
          artists: [{ id: '7', name: 'Test Artist', slug: 'test-artist' }],
        },
      ],
    },
  },
};

function tokensPage(
  nodes: Array<{ chainId: string; contractAddress: string; tokenId: string }>,
  hasNextPage: boolean
): unknown {
  return {
    data: {
      artwork: {
        tokens: {
          nodes,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next-cursor' : null },
        },
      },
    },
  };
}

const ETH_TOKEN = (
  tokenId: string
): { chainId: string; contractAddress: string; tokenId: string } => ({
  chainId: 'eip155:1',
  contractAddress: VALID_ETH_CONTRACT,
  tokenId,
});

describe('find command — Raster series flow (mock GraphQL server)', () => {
  test('complete series → "Build playlist with N tokens?" prompt; "n" cancels before indexing', async () => {
    handler = (query) => {
      if (query.includes('tokenByRef')) {
        return SERIES_HIT;
      }
      return tokensPage([ETH_TOKEN('1'), ETH_TOKEN('2')], false);
    };
    const result = await runFind([`ethereum:${VALID_ETH_CONTRACT}:1`], { stdin: 'n\n' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Test Artist — Test Series/);
    assert.match(result.stdout, /Build playlist with 2 tokens\?/);
    assert.doesNotMatch(result.stdout, /the first/);
    assert.match(result.stdout, /Cancelled\./);
    assert.doesNotMatch(result.stdout, /Indexing/);
  });

  test('--limit below series size → "the first N tokens" prompt wording', async () => {
    handler = (query) => {
      if (query.includes('tokenByRef')) {
        return SERIES_HIT;
      }
      // One page holding more tokens than the limit: the truncation is
      // detected from leftover rows, with more pages still advertised.
      return tokensPage([ETH_TOKEN('1'), ETH_TOKEN('2'), ETH_TOKEN('3')], true);
    };
    const result = await runFind([`ethereum:${VALID_ETH_CONTRACT}:1`, '--limit', '2'], {
      stdin: 'n\n',
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Build playlist with the first 2 tokens\?/);
    assert.match(result.stdout, /Cancelled\./);
  });

  test('--output bypasses the confirm prompt and proceeds to indexing', async () => {
    handler = (query) => {
      if (query.includes('tokenByRef')) {
        return SERIES_HIT;
      }
      return tokensPage([ETH_TOKEN('1'), ETH_TOKEN('2')], false);
    };
    const result = await runFind([`ethereum:${VALID_ETH_CONTRACT}:1`, '--output', 'out.json']);
    // What this test is for: --output skips the confirm prompt and goes
    // straight to indexing. The earlier version killed the child on the
    // "Indexing" line and asserted the kill landed first (code === null),
    // which raced a live network call; a fast indexer lost it and the release
    // gate went red.
    assert.doesNotMatch(result.stdout, /Build playlist with/);
    assert.match(result.stdout, /Indexing 2 tokens via FF indexer/);
    // The mock carries the run through enqueue, poll, and token query, so the
    // flow reaches a determinate end rather than being cut short.
    assert.match(result.stdout, /2\/2 tokens indexed/);
    assert.match(result.stderr, /No tokens could be indexed/);
    assert.equal(result.code, 1);
    // The exit message alone proves nothing: a client that regressed to
    // reading `jobId` would fail at the enqueue and still land here. What
    // shows the protocol path completed is each token's own lifecycle.
    //
    // Asserted per token, never across them: the two workflows run
    // concurrently under Promise.all, so one token's enqueue can legitimately
    // reach the mock before the other's first lookup. A single global sequence
    // would reject valid interleavings and fail intermittently in CI — the
    // same class of flake this suite was repaired to remove.
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

  test('series with only unsupported-chain tokens → clear error, exit 1', async () => {
    handler = (query) => {
      if (query.includes('tokenByRef')) {
        return SERIES_HIT;
      }
      return tokensPage(
        [
          { chainId: 'eip155:137', contractAddress: '0xmatic', tokenId: '1' },
          { chainId: 'eip155:8453', contractAddress: '0xbase', tokenId: '2' },
        ],
        false
      );
    };
    const result = await runFind([`ethereum:${VALID_ETH_CONTRACT}:1`], { stdin: 'n\n' });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Skipped 2 tokens on unsupported chains/);
    assert.match(result.stderr, /Series has no tokens on supported chains/);
  });

  test('unindexed token → single-token fallback messaging and 1-token prompt', async () => {
    handler = (query) => {
      if (query.includes('tokenByRef')) {
        return { data: { tokenByRef: null } };
      }
      return { errors: [{ message: 'unexpected query for single-token path' }] };
    };
    const result = await runFind([`ethereum:${VALID_ETH_CONTRACT}:1`], { stdin: 'n\n' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp(`Single token — ethereum ${VALID_ETH_CONTRACT}:1`));
    assert.match(result.stdout, /Raster doesn't index this series/);
    assert.match(result.stdout, /Build playlist with 1 token\?/);
    assert.match(result.stdout, /Cancelled\./);
  });

  test('Raster body terminating mid-stream → warns and degrades to one-item playlist (#98 review)', async () => {
    // fetch() succeeds (headers arrive), the body read rejects. The typed
    // RasterUnreachableError must survive to resolveCoords so the find flow
    // degrades instead of dying — the whole point of the boundary fix.
    destroyResponseBody = true;
    const result = await runFind([`ethereum:${VALID_ETH_CONTRACT}:1`], { stdin: 'n\n' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Raster API unreachable/);
    assert.match(result.stdout, /Continuing without Raster — building a one-item playlist/);
    assert.match(result.stdout, /Build playlist with 1 token\?/);
    assert.match(result.stdout, /Cancelled\./);
  });
});

describe('find command — resolver-backed token-list flow', () => {
  test('passes --limit through parsed and unsupported resolver-backed token-list paths', async () => {
    const objktCollectionUrl = 'https://objkt.com/collections/KT1TokenListContract';
    const superRareCollectionUrl =
      'https://superrare.com/collection/0x1234567890123456789012345678901234567890';
    const feralFileShowUrl = 'https://feralfile.com/exhibitions/shows/mock-show';
    const feralFileSeriesUrl = 'https://feralfile.com/exhibitions/series/mock-series';
    const dir = mkdtempSync(join(tmpdir(), 'ff-find-token-list-'));
    const originalCwd = process.cwd();
    const resolverCalls: Array<{ input: string; options: { limit: number } }> = [];
    const promptQuestions: string[] = [];
    const promptAnswers = ['yes', 's', 'yes', 's', 'yes', 's', 'yes', 's'];
    const indexedBatches: unknown[][] = [];
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const resolverMissInputs = new Set<string>();
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const originalExit = process.exit;

    const sourceResolver = testRequire('@feralfile/source-resolver');
    const originalResolveTokenInfos = Object.getOwnPropertyDescriptor(
      sourceResolver,
      'resolveTokenInfos'
    );
    const promptPath = testRequire.resolve('../src/commands/helpers/prompt');
    const nftIndexerPath = testRequire.resolve('../src/utilities/nft-indexer');
    const playlistBuilderPath = testRequire.resolve('../src/utilities/playlist-builder');
    const originalPromptCache = testRequire.cache[promptPath];
    const originalNftIndexerCache = testRequire.cache[nftIndexerPath];
    const originalPlaylistBuilderCache = testRequire.cache[playlistBuilderPath];

    Object.defineProperty(sourceResolver, 'resolveTokenInfos', {
      configurable: true,
      value: async (input: string, options: { limit: number }) => {
        resolverCalls.push({ input, options });
        if (resolverMissInputs.has(input)) {
          return {
            kind: 'not-found',
            reason: 'mock resolver miss',
          };
        }
        // Series pages resolve to exactly the tokens the page describes —
        // one here, mirroring a single-edition series (the case the old
        // ff-marketplace→Raster path expanded to a sibling collection).
        if (input === feralFileSeriesUrl) {
          return {
            kind: 'tokens',
            title: 'Mock Feral File Series',
            coords: [
              {
                chain: 'ethereum',
                contract: '0x1234567890123456789012345678901234567890',
                tokenId: '21',
              },
            ],
            hasMore: false,
          };
        }
        const isSuperRareCollection = input === superRareCollectionUrl;
        const isFeralFileShow = input === feralFileShowUrl;
        return {
          kind: 'tokens',
          title: isSuperRareCollection
            ? 'Mock SuperRare Collection'
            : isFeralFileShow
              ? 'Mock Feral File Show'
              : 'Mock Objkt Collection',
          coords: [
            {
              chain: isSuperRareCollection || isFeralFileShow ? 'ethereum' : 'tezos',
              contract:
                isSuperRareCollection || isFeralFileShow
                  ? '0x1234567890123456789012345678901234567890'
                  : 'KT1TokenListContract',
              tokenId: isSuperRareCollection ? '7' : isFeralFileShow ? '11' : '1',
            },
            {
              chain: isSuperRareCollection || isFeralFileShow ? 'ethereum' : 'tezos',
              contract:
                isSuperRareCollection || isFeralFileShow
                  ? '0x1234567890123456789012345678901234567890'
                  : 'KT1TokenListContract',
              tokenId: isSuperRareCollection ? '8' : isFeralFileShow ? '12' : '2',
            },
          ],
          hasMore: true,
        };
      },
    });

    testRequire.cache[promptPath] = {
      id: promptPath,
      filename: promptPath,
      loaded: true,
      exports: {
        createPrompt: () => ({
          ask: async (question: string) => {
            promptQuestions.push(question);
            return promptAnswers.shift() ?? 's';
          },
          close: () => undefined,
        }),
        promptYesNo: async (ask: (question: string) => Promise<string>, question: string) => {
          const answer = await ask(`${question} [Y/n] `);
          return answer === 'yes';
        },
      },
    };
    testRequire.cache[nftIndexerPath] = {
      id: nftIndexerPath,
      filename: nftIndexerPath,
      loaded: true,
      exports: {
        getNFTTokenInfoBatch: async (tokens: unknown[]) => {
          indexedBatches.push(tokens);
          return [{ title: 'Indexed token', media: { uri: 'ipfs://token-1' } }];
        },
      },
    };
    testRequire.cache[playlistBuilderPath] = {
      id: playlistBuilderPath,
      filename: playlistBuilderPath,
      loaded: true,
      exports: {
        buildDP1Playlist: async ({ items, title }: { items: unknown[]; title: string }) => ({
          slug: 'mock-objkt-collection',
          title,
          items,
        }),
        buildUrlItem: () => {
          throw new Error('token-list flow should not build direct URL items');
        },
      },
    };

    try {
      process.chdir(dir);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutWrites.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      process.exit = ((code?: string | number | null) => {
        throw new Error(`process.exit(${code ?? 0})`);
      }) as typeof process.exit;
      const imported = await import('../src/commands/find');
      const findCommand = imported.findCommand ?? imported.default.findCommand;

      await findCommand.parseAsync(['node', 'find', objktCollectionUrl, '--limit', '1'], {
        from: 'node',
      });

      assert.deepEqual(resolverCalls, [
        {
          input: objktCollectionUrl,
          options: { limit: 1 },
        },
      ]);
      assert.deepEqual(indexedBatches, [
        [{ chain: 'tezos', contractAddress: 'KT1TokenListContract', tokenId: '1' }],
      ]);
      assert.equal(promptQuestions[0], 'Build playlist with the first 1 token? [Y/n] ');
      assert.match(promptQuestions[1], /^Next\? \[P\]lay on FF1/);
      assert.match(stdoutWrites.join(''), /Mock Objkt Collection/);
      assert.match(stdoutWrites.join(''), /Indexing 1 token via FF indexer/);
      assert.ok(existsSync(join(dir, 'mock-objkt-collection.json')));
      assert.equal(
        JSON.parse(readFileSync(join(dir, 'mock-objkt-collection.json'), 'utf8')).title,
        'Mock Objkt Collection'
      );

      resolverCalls.length = 0;
      promptQuestions.length = 0;
      indexedBatches.length = 0;
      stdoutWrites.length = 0;

      await findCommand.parseAsync(['node', 'find', superRareCollectionUrl, '--limit', '1'], {
        from: 'node',
      });

      assert.deepEqual(resolverCalls, [
        {
          input: superRareCollectionUrl,
          options: { limit: 1 },
        },
      ]);
      assert.deepEqual(indexedBatches, [
        [
          {
            chain: 'ethereum',
            contractAddress: '0x1234567890123456789012345678901234567890',
            tokenId: '7',
          },
        ],
      ]);
      assert.equal(promptQuestions[0], 'Build playlist with the first 1 token? [Y/n] ');
      assert.match(stdoutWrites.join(''), /Mock SuperRare Collection/);
      assert.match(stdoutWrites.join(''), /Indexing 1 token via FF indexer/);

      resolverCalls.length = 0;
      stderrWrites.length = 0;
      resolverMissInputs.add(superRareCollectionUrl);

      await assert.rejects(
        () =>
          findCommand.parseAsync(['node', 'find', superRareCollectionUrl, '--limit', '1'], {
            from: 'node',
          }),
        /process\.exit\(1\)/
      );

      assert.deepEqual(resolverCalls, [
        {
          input: superRareCollectionUrl,
          options: { limit: 1 },
        },
      ]);
      assert.match(stderrWrites.join(''), /SuperRare collection URLs/);
      assert.match(stderrWrites.join(''), /Paste a specific token URL/);

      resolverCalls.length = 0;
      promptQuestions.length = 0;
      indexedBatches.length = 0;
      stdoutWrites.length = 0;
      resolverMissInputs.delete(superRareCollectionUrl);

      await findCommand.parseAsync(['node', 'find', feralFileShowUrl, '--limit', '1'], {
        from: 'node',
      });

      assert.deepEqual(resolverCalls, [
        {
          input: feralFileShowUrl,
          options: { limit: 1 },
        },
      ]);
      assert.deepEqual(indexedBatches, [
        [
          {
            chain: 'ethereum',
            contractAddress: '0x1234567890123456789012345678901234567890',
            tokenId: '11',
          },
        ],
      ]);
      assert.equal(promptQuestions[0], 'Build playlist with the first 1 token? [Y/n] ');
      assert.match(stdoutWrites.join(''), /Mock Feral File Show/);
      assert.match(stdoutWrites.join(''), /Indexing 1 token via FF indexer/);

      resolverCalls.length = 0;
      stderrWrites.length = 0;
      resolverMissInputs.add(feralFileShowUrl);

      await assert.rejects(
        () =>
          findCommand.parseAsync(['node', 'find', feralFileShowUrl, '--limit', '1'], {
            from: 'node',
          }),
        /process\.exit\(1\)/
      );

      assert.deepEqual(resolverCalls, [
        {
          input: feralFileShowUrl,
          options: { limit: 1 },
        },
      ]);
      assert.match(
        stderrWrites.join(''),
        /Feral File: no supported tokens found for show "mock-show"/
      );

      // Series URLs route through the same resolver token-list path as shows
      // (never ff-marketplace→Raster, which expanded a single-edition series
      // to its parent artwork's full token list). The mock Raster server
      // seeing zero traffic is asserted implicitly: a Raster call would hit
      // this test's GraphQL handler and fail the deepEqual on indexedBatches.
      resolverCalls.length = 0;
      promptQuestions.length = 0;
      indexedBatches.length = 0;
      stdoutWrites.length = 0;
      stderrWrites.length = 0;
      resolverMissInputs.delete(feralFileShowUrl);

      await findCommand.parseAsync(['node', 'find', feralFileSeriesUrl, '--limit', '1'], {
        from: 'node',
      });

      assert.deepEqual(resolverCalls, [
        {
          input: feralFileSeriesUrl,
          options: { limit: 1 },
        },
      ]);
      assert.deepEqual(indexedBatches, [
        [
          {
            chain: 'ethereum',
            contractAddress: '0x1234567890123456789012345678901234567890',
            tokenId: '21',
          },
        ],
      ]);
      assert.match(stdoutWrites.join(''), /Mock Feral File Series/);

      resolverCalls.length = 0;
      stderrWrites.length = 0;
      resolverMissInputs.add(feralFileSeriesUrl);

      await assert.rejects(
        () =>
          findCommand.parseAsync(['node', 'find', feralFileSeriesUrl, '--limit', '1'], {
            from: 'node',
          }),
        /process\.exit\(1\)/
      );

      assert.match(
        stderrWrites.join(''),
        /Feral File: no supported tokens found for series "mock-series"/
      );
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.exit = originalExit;
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
      if (originalResolveTokenInfos) {
        Object.defineProperty(sourceResolver, 'resolveTokenInfos', originalResolveTokenInfos);
      }
      if (originalPromptCache) {
        testRequire.cache[promptPath] = originalPromptCache;
      } else {
        delete testRequire.cache[promptPath];
      }
      if (originalNftIndexerCache) {
        testRequire.cache[nftIndexerPath] = originalNftIndexerCache;
      } else {
        delete testRequire.cache[nftIndexerPath];
      }
      if (originalPlaylistBuilderCache) {
        testRequire.cache[playlistBuilderPath] = originalPlaylistBuilderCache;
      } else {
        delete testRequire.cache[playlistBuilderPath];
      }
    }
  });
});
