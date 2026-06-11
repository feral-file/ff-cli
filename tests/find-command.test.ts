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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
// Spawn node directly with tsx's JS entry to avoid Windows .cmd shim
// limitations in spawn (Node refuses to execute .bat/.cmd without shell).
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');

type GraphQLHandler = (query: string, variables: Record<string, unknown>) => unknown;

let server: Server;
let serverUrl: string;
let handler: GraphQLHandler;

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

    const finish = (result: RunResult | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      if (result instanceof Error) {
        rejectRun(result);
      } else {
        resolveRun(result);
      }
    };

    // Hermeticity backstop: a hung prompt or an unexpected network call
    // should fail the test, not stall the suite.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`find timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.killOn && options.killOn.test(stdout)) {
        child.kill('SIGKILL');
        finish({ stdout, stderr, code: null });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', finish);
    child.on('close', (code) => finish({ stdout, stderr, code }));

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
  contractAddress: '0xabc',
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
    const result = await runFind(['ethereum:0xabc:1'], { stdin: 'n\n' });
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
    const result = await runFind(['ethereum:0xabc:1', '--limit', '2'], { stdin: 'n\n' });
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
    const result = await runFind(['ethereum:0xabc:1', '--output', 'out.json'], {
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
    const result = await runFind(['ethereum:0xabc:1'], { stdin: 'n\n' });
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
    const result = await runFind(['ethereum:0xabc:1'], { stdin: 'n\n' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Single token — ethereum 0xabc:1/);
    assert.match(result.stdout, /Raster doesn't index this series/);
    assert.match(result.stdout, /Build playlist with 1 token\?/);
    assert.match(result.stdout, /Cancelled\./);
  });
});
