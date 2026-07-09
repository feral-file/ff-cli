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
 * All prompts are answered "n" (or bypassed and the child killed once the
 * flow provably passed the prompt), so no test reaches the FF indexer —
 * the suite stays hermetic.
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
});

after(() => {
  server.close();
});

beforeEach(() => {
  handler = () => ({ errors: [{ message: 'no handler installed for this test' }] });
});

interface RunResult {
  stdout: string;
  stderr: string;
  /** Process exit code; null when the run was killed via `killOn`. */
  code: number | null;
}

/**
 * Run `ff-cli find <args>` against the mock Raster server.
 *
 * `stdin` is written to the child's stdin and closed (prompt answers).
 * `killOn` kills the child once stdout matches — used to stop a run that
 * has provably passed the assertion point but would otherwise continue
 * into the (hardcoded, network) FF indexer.
 */
function runFind(
  args: string[],
  options: { stdin?: string; killOn?: RegExp } = {}
): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-find-cmd-'));
    const child = spawn(process.execPath, [tsxCli, cliEntry, 'find', ...args], {
      cwd: dir,
      env: {
        ...process.env,
        RASTER_API_URL: serverUrl,
        FORCE_COLOR: '0',
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedByMatcher = false;
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
      if (options.killOn && !killedByMatcher && options.killOn.test(stdout)) {
        killedByMatcher = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (timedOut) {
        finish(new Error(`find timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      } else {
        finish({ stdout, stderr, code: killedByMatcher ? null : code });
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
    // killOn stops the run once it has provably passed the prompt — the
    // next step would call the real FF indexer.
    const result = await runFind([`ethereum:${VALID_ETH_CONTRACT}:1`, '--output', 'out.json'], {
      killOn: /Indexing 2 tokens via FF indexer/,
    });
    assert.equal(result.code, null);
    assert.doesNotMatch(result.stdout, /Build playlist with/);
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
});

describe('find command — resolver-backed token-list flow', () => {
  test('passes --limit to source-resolver and prompts for the first N token-list results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-find-token-list-'));
    const originalCwd = process.cwd();
    const resolverCalls: Array<{ input: string; options: { limit: number } }> = [];
    const promptQuestions: string[] = [];
    const promptAnswers = ['yes', 's'];
    const indexedBatches: unknown[][] = [];
    const stdoutWrites: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);

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
        return {
          kind: 'tokens',
          title: 'Mock Objkt Collection',
          coords: [
            {
              chain: 'tezos',
              contract: 'KT1TokenListContract',
              tokenId: '1',
            },
            {
              chain: 'tezos',
              contract: 'KT1TokenListContract',
              tokenId: '2',
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
      const imported = await import('../src/commands/find');
      const findCommand = imported.findCommand ?? imported.default.findCommand;

      await findCommand.parseAsync(
        ['node', 'find', 'https://objkt.com/collections/KT1TokenListContract', '--limit', '1'],
        { from: 'node' }
      );

      assert.deepEqual(resolverCalls, [
        {
          input: 'https://objkt.com/collections/KT1TokenListContract',
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
    } finally {
      process.stdout.write = originalStdoutWrite;
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
