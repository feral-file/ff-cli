/**
 * Ensures nft-indexer media and mapping logic matches ff-indexer-v2 GraphQL:
 * `display` + unified `media_assets`, and job-based status.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nftIndexer = require('../src/utilities/nft-indexer');

/**
 * Minimal `Response` stub for tests. `nft-indexer` only reads `ok`, `status`, and `json()`.
 */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

/** Parses POST body from fetch(init) in nft-indexer tests. */
function graphqlRequestFromInit(init?: RequestInit): { query: string; variables?: unknown } {
  const raw = init?.body;
  const text =
    typeof raw === 'string' ? raw : raw !== undefined && raw !== null ? String(raw) : '{}';
  const parsed = JSON.parse(text) as { query?: string; variables?: unknown };
  assert.ok(typeof parsed.query === 'string', 'expected GraphQL query string in fetch body');
  return { query: parsed.query, variables: parsed.variables };
}

/** Minimal token row matching indexer `tokens.items` shape used by mocks. */
function mockTokenRow(overrides: Record<string, unknown> = {}) {
  return {
    contract_address: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
    token_number: '7804',
    current_owner: '0x1111111111111111111111111111111111111111',
    burned: false,
    display: {
      name: 'Punk 7804',
      description: 'Mock',
      mime_type: 'image/png',
      image_url: 'https://example.com/punk.png',
      animation_url: '',
      artists: [{ name: 'Larva Labs' }],
    },
    media_assets: [{ source_url: 'https://cdn.example.com/punk.png', variants: {} }],
    ...overrides,
  };
}

test('getBestMediaUrl: display.animation_url takes precedence', () => {
  const { getBestMediaUrl } = nftIndexer;
  const media = getBestMediaUrl(
    {
      animation_url: 'https://example.com/animation.mp4',
      image_url: 'https://example.com/image.png',
    },
    [{ source_url: 'https://cdn.example/fallback.mp4', variants: {} }]
  );
  assert.equal(media.url, 'https://example.com/animation.mp4');
  assert.equal(media.thumbnail, 'https://example.com/image.png');
});

test('getBestMediaUrl: falls back to media asset source_url when no animation_url', () => {
  const { getBestMediaUrl } = nftIndexer;
  const media = getBestMediaUrl({ animation_url: '', image_url: 'https://example.com/image.png' }, [
    { source_url: 'https://cdn.example/file.mp4', variants: {} },
  ]);
  assert.equal(media.url, 'https://cdn.example/file.mp4');
});

test('getBestMediaUrl: uses variant URLs from media_assets', () => {
  const { getBestMediaUrl } = nftIndexer;
  const media = getBestMediaUrl({ animation_url: '', image_url: '' }, [
    {
      source_url: '',
      variants: { l: 'https://cdn.example/transcoded.mp4' },
    },
  ]);
  assert.equal(media.url, 'https://cdn.example/transcoded.mp4');
});

test('getBestMediaUrl: falls back to display.image_url when no media assets', () => {
  const { getBestMediaUrl } = nftIndexer;
  const media = getBestMediaUrl(
    { animation_url: '', image_url: 'https://example.com/image.png' },
    []
  );
  assert.equal(media.url, 'https://example.com/image.png');
  assert.equal(media.thumbnail, 'https://example.com/image.png');
});

test('getBestMediaUrl: handles null/empty display and media_assets', () => {
  const { getBestMediaUrl } = nftIndexer;
  const media = getBestMediaUrl({}, []);
  assert.equal(media.url, '');
  assert.equal(media.thumbnail, '');
});

test('getBestMediaUrl: skips data URIs', () => {
  const { getBestMediaUrl } = nftIndexer;
  const media = getBestMediaUrl(
    {
      animation_url: 'data:image/png;base64,abc123',
      image_url: 'https://example.com/fallback.png',
    },
    []
  );
  assert.equal(media.url, 'https://example.com/fallback.png');
});

test('getBestMediaUrl: skips URLs longer than 1024 chars', () => {
  const { getBestMediaUrl } = nftIndexer;
  const longUrl = 'https://example.com/' + 'x'.repeat(1100);
  const media = getBestMediaUrl(
    { animation_url: longUrl, image_url: 'https://example.com/fallback.png' },
    []
  );
  assert.equal(media.url, 'https://example.com/fallback.png');
});

test('mapIndexerDataToStandardFormat: reads display fields', () => {
  const { mapIndexerDataToStandardFormat } = nftIndexer;
  const out = mapIndexerDataToStandardFormat(
    {
      token_number: '1',
      contract_address: '0xabc',
      current_owner: '0xowner',
      burned: false,
      display: {
        name: 'Test Token',
        description: 'Test description',
        mime_type: 'video/mp4',
        image_url: 'https://example.com/image.png',
        animation_url: 'https://example.com/video.mp4',
        artists: [{ name: 'Artist Name' }],
      },
      media_assets: [],
    },
    'ethereum'
  );
  assert.equal(out.success, true);
  if (!('token' in out) || !out.token) {
    assert.fail('expected token on success');
  }
  assert.equal(out.token.name, 'Test Token');
  assert.equal(out.token.description, 'Test description');
  assert.equal(out.token.animation_url, 'https://example.com/video.mp4');
  assert.equal(out.token.metadata.artistName, 'Artist Name');
});

test('mapIndexerDataToStandardFormat: uses media_assets for image URL', () => {
  const { mapIndexerDataToStandardFormat } = nftIndexer;
  const out = mapIndexerDataToStandardFormat(
    {
      token_number: '1',
      contract_address: '0xabc',
      current_owner: '0xowner',
      burned: false,
      display: { name: 'Test', mime_type: 'video/mp4' },
      media_assets: [{ source_url: 'https://cdn.example/file.mp4', variants: {} }],
    },
    'ethereum'
  );
  assert.equal(out.success, true);
  if (!('token' in out) || !out.token) {
    assert.fail('expected token on success');
  }
  assert.equal(out.token.image.url, 'https://cdn.example/file.mp4');
});

test('mapIndexerDataToStandardFormat: handles missing display gracefully', () => {
  const { mapIndexerDataToStandardFormat } = nftIndexer;
  const out = mapIndexerDataToStandardFormat(
    {
      token_number: '123',
      contract_address: '0xabc',
      current_owner: '0xowner',
      burned: false,
      media_assets: [],
    },
    'ethereum'
  );
  assert.equal(out.success, true);
  if (!('token' in out) || !out.token) {
    assert.fail('expected token on success');
  }
  assert.equal(out.token.name, 'Token #123');
  assert.equal(out.token.metadata.artistName, '');
});

test('mapIndexerDataToStandardFormat: infers erc721 for ethereum tokens and preserves it in DP1 output', () => {
  const { mapIndexerDataToStandardFormat, convertToDP1Item } = nftIndexer;
  const tokenRow = mockTokenRow({
    contract_address: '0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb',
    token_number: '7804',
  });

  const out = mapIndexerDataToStandardFormat(tokenRow, 'ethereum');
  assert.equal(out.success, true);
  if (!('token' in out) || !out.token) {
    assert.fail('expected token on success');
  }
  assert.equal(out.token.standard, 'erc721');

  const dp1 = convertToDP1Item(out, 10);
  assert.equal(dp1.success, true);
  if (!('item' in dp1) || !dp1.item) {
    assert.fail('expected item on success');
  }
  assert.equal(dp1.item.provenance.contract.standard, 'erc721');
});

test('mapIndexerDataToStandardFormat: infers fa2 for Tezos KT contracts and preserves it in DP1 output', () => {
  const { mapIndexerDataToStandardFormat, convertToDP1Item } = nftIndexer;
  const tokenRow = mockTokenRow({
    contract_address: 'KT1abcdef1234567890abcdef1234567890abcdef',
    token_number: '42',
  });

  const out = mapIndexerDataToStandardFormat(tokenRow, 'tezos');
  assert.equal(out.success, true);
  if (!('token' in out) || !out.token) {
    assert.fail('expected token on success');
  }
  assert.equal(out.token.standard, 'fa2');

  const dp1 = convertToDP1Item(out, 10);
  assert.equal(dp1.success, true);
  if (!('item' in dp1) || !dp1.item) {
    assert.fail('expected item on success');
  }
  assert.equal(dp1.item.provenance.contract.standard, 'fa2');
});

test('mapIndexerDataToStandardFormat: returns error for null indexerData', () => {
  const { mapIndexerDataToStandardFormat } = nftIndexer;
  const out = mapIndexerDataToStandardFormat(null, 'ethereum');
  assert.equal(out.success, false);
  assert.equal(out.error, 'Token not found in indexer');
});

// Job polling tests using global.fetch stubbing

test('queryJobStatus: returns status and lastError on success', async () => {
  const { queryJobStatus } = nftIndexer;
  const originalFetch = global.fetch;

  global.fetch = async () =>
    jsonResponse({
      data: {
        jobStatus: {
          status: 'running',
          last_error: null,
        },
      },
    });

  try {
    const result = await queryJobStatus(123);
    assert.equal(result.success, true);
    assert.equal(result.status, 'running');
    assert.equal(result.lastError, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('queryJobStatus: handles HTTP errors', async () => {
  const { queryJobStatus } = nftIndexer;
  const originalFetch = global.fetch;

  global.fetch = async () => jsonResponse(null, false, 500);

  try {
    const result = await queryJobStatus(123);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('HTTP error'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('queryJobStatus: handles GraphQL errors', async () => {
  const { queryJobStatus } = nftIndexer;
  const originalFetch = global.fetch;

  global.fetch = async () =>
    jsonResponse({
      errors: [{ message: 'Job not found' }],
    });

  try {
    const result = await queryJobStatus(123);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('GraphQL errors'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('queryJobStatus: rejects invalid job_id', async () => {
  const { queryJobStatus } = nftIndexer;
  const result = await queryJobStatus('invalid');
  assert.equal(result.success, false);
  assert.equal(result.error, 'Invalid job_id');
});

test('pollForJobCompletion: completes on "completed" status', async () => {
  const { pollForJobCompletion } = nftIndexer;
  const originalFetch = global.fetch;

  global.fetch = async () =>
    jsonResponse({
      data: {
        jobStatus: {
          status: 'completed',
          last_error: null,
        },
      },
    });

  try {
    const result = await pollForJobCompletion(123);
    assert.equal(result.success, true);
    assert.equal(result.completed, true);
    assert.equal(result.timedOut, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('pollForJobCompletion: fails on "failed" status with lastError', async () => {
  const { pollForJobCompletion } = nftIndexer;
  const originalFetch = global.fetch;

  global.fetch = async () =>
    jsonResponse({
      data: {
        jobStatus: {
          status: 'failed',
          last_error: 'Token not found',
        },
      },
    });

  try {
    const result = await pollForJobCompletion(123);
    assert.equal(result.success, false);
    assert.equal(result.completed, false);
    assert.ok(result.error?.includes('Token not found'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('triggerIndexingAsync: parses job_id from response', async () => {
  const { triggerIndexingAsync } = nftIndexer;
  const originalFetch = global.fetch;

  global.fetch = async () =>
    jsonResponse({
      data: {
        triggerTokenIndexing: {
          job_id: 456,
        },
      },
    });

  try {
    const result = await triggerIndexingAsync('ethereum', '0xabc', '123');
    assert.equal(result.success, true);
    assert.equal(result.job_id, 456);
    assert.equal(result.workflow_id, undefined);
    assert.equal(result.run_id, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('triggerIndexingAsync: returns error when no job_id in response', async () => {
  const { triggerIndexingAsync } = nftIndexer;
  const originalFetch = global.fetch;

  global.fetch = async () =>
    jsonResponse({
      data: {
        triggerTokenIndexing: {},
      },
    });

  try {
    const result = await triggerIndexingAsync('ethereum', '0xabc', '123');
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('No job_id'));
  } finally {
    global.fetch = originalFetch;
  }
});

// ——— GraphQL document shape (regression guard for ff-indexer-v2 contract) ———

test('GraphQL documents: tokens list selects display + media_assets variants only', () => {
  const { buildTokensListQuery } = nftIndexer;
  const q = buildTokensListQuery({
    token_cids: ['eip155:1:erc721:0xabc:1'],
    limit: 10,
    offset: 2,
  });
  assert.match(q, /tokens\s*\(\s*token_cids:/);
  assert.match(q, /display\s*\{/);
  assert.match(q, /\bname\b/);
  assert.match(q, /\bdescription\b/);
  assert.match(q, /\bmime_type\b/);
  assert.match(q, /\bimage_url\b/);
  assert.match(q, /\banimation_url\b/);
  assert.match(q, /artists\s*\{\s*name\s*\}/);
  assert.match(q, /media_assets\s*\{/);
  assert.match(q, /variants\s*\(\s*keys:\s*\[\s*l,\s*m,\s*xl,\s*xxl,\s*preview\s*]\s*\)/);
  assert.match(q, /\blimit:\s*10\b/);
  assert.match(q, /\boffset:\s*2\b/);
  assert.doesNotMatch(q, /\benrichment_source\b/);
  assert.doesNotMatch(q, /\bmetadata\s*\{/);
});

test('GraphQL documents: triggerTokenIndexing mutation shape', () => {
  const { TRIGGER_TOKEN_INDEXING_MUTATION } = nftIndexer;
  assert.match(TRIGGER_TOKEN_INDEXING_MUTATION, /mutation\s+TriggerTokenIndexing/);
  assert.match(TRIGGER_TOKEN_INDEXING_MUTATION, /\$token_cids:\s*\[String!\]!/);
  assert.match(
    TRIGGER_TOKEN_INDEXING_MUTATION,
    /triggerTokenIndexing\s*\(\s*token_cids:\s*\$token_cids\s*\)/
  );
  assert.match(TRIGGER_TOKEN_INDEXING_MUTATION, /job_id/);
});

test('GraphQL documents: jobStatus query shape', () => {
  const { JOB_STATUS_QUERY } = nftIndexer;
  assert.match(JOB_STATUS_QUERY, /query\s+JobStatus/);
  assert.match(JOB_STATUS_QUERY, /\$job_id:\s*Int!/);
  assert.match(JOB_STATUS_QUERY, /jobStatus\s*\(\s*job_id:\s*\$job_id\s*\)/);
  assert.match(JOB_STATUS_QUERY, /\bstatus\b/);
  assert.match(JOB_STATUS_QUERY, /\blast_error\b/);
});

// ——— getNFTTokenInfoSingle ———

test('getNFTTokenInfoSingle: mock single tokens response (already indexed)', async () => {
  const { getNFTTokenInfoSingle } = nftIndexer;
  const originalFetch = global.fetch;
  const row = mockTokenRow();

  global.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = graphqlRequestFromInit(init);
    assert.ok(query.includes('tokens('), 'expected tokens query');
    return jsonResponse({
      data: {
        tokens: { items: [row], total: 1 },
      },
    });
  };

  try {
    const result = await getNFTTokenInfoSingle(
      {
        chain: 'ethereum',
        contractAddress: row.contract_address as string,
        tokenId: row.token_number as string,
      },
      10,
      { jobPoll: { intervalMs: 0 }, mediaPoll: { intervalMs: 0 } }
    );
    assert.equal(result.success, true);
    if (!result.success || !('item' in result) || !result.item) {
      assert.fail('expected DP1 item');
    }
    assert.equal(result.item.source, 'https://cdn.example.com/punk.png');
    assert.equal(result.item.title, 'Punk 7804');
  } finally {
    global.fetch = originalFetch;
  }
});

test('getNFTTokenInfoSingle: mock miss then trigger, job completed, then token with media', async () => {
  const { getNFTTokenInfoSingle } = nftIndexer;
  const originalFetch = global.fetch;
  let tokenRound = 0;

  global.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = graphqlRequestFromInit(init);
    if (query.includes('triggerTokenIndexing')) {
      return jsonResponse({
        data: { triggerTokenIndexing: { job_id: 42 } },
      });
    }
    if (query.includes('jobStatus')) {
      return jsonResponse({
        data: { jobStatus: { status: 'completed', last_error: null } },
      });
    }
    if (query.includes('tokens(')) {
      tokenRound += 1;
      if (tokenRound === 1) {
        return jsonResponse({ data: { tokens: { items: [], total: 0 } } });
      }
      return jsonResponse({
        data: {
          tokens: { items: [mockTokenRow()], total: 1 },
        },
      });
    }
    assert.fail(`unexpected fetch query: ${query.slice(0, 80)}`);
  };

  try {
    const row = mockTokenRow();
    const result = await getNFTTokenInfoSingle(
      {
        chain: 'ethereum',
        contractAddress: row.contract_address as string,
        tokenId: row.token_number as string,
      },
      10,
      { jobPoll: { intervalMs: 0 }, mediaPoll: { intervalMs: 0 } }
    );
    assert.equal(result.success, true);
    if (!result.success || !('item' in result) || !result.item) {
      assert.fail('expected DP1 item');
    }
    assert.ok(result.item.source);
    assert.equal(tokenRound, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getNFTTokenInfoSingle: mock polls media_assets when first hit has empty list', async () => {
  const { getNFTTokenInfoSingle } = nftIndexer;
  const originalFetch = global.fetch;
  let tokenCalls = 0;

  global.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = graphqlRequestFromInit(init);
    if (query.includes('tokens(')) {
      tokenCalls += 1;
      if (tokenCalls === 1) {
        return jsonResponse({
          data: {
            tokens: {
              items: [
                mockTokenRow({
                  media_assets: [],
                  display: {
                    name: 'Pending',
                    description: '',
                    mime_type: 'video/mp4',
                    image_url: '',
                    animation_url: '',
                    artists: [],
                  },
                }),
              ],
              total: 1,
            },
          },
        });
      }
      return jsonResponse({
        data: {
          tokens: {
            items: [mockTokenRow()],
            total: 1,
          },
        },
      });
    }
    assert.fail('expected only tokens queries in this scenario');
  };

  try {
    const row = mockTokenRow();
    const result = await getNFTTokenInfoSingle(
      {
        chain: 'ethereum',
        contractAddress: row.contract_address as string,
        tokenId: row.token_number as string,
      },
      10,
      { jobPoll: { intervalMs: 0 }, mediaPoll: { intervalMs: 0 } }
    );
    assert.equal(result.success, true);
    assert.equal(tokenCalls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
