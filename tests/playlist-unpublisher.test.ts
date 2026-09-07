/**
 * Contract tests for `unpublish`.
 *
 * The feed's DELETE is authorized only by a signed intent whose shape it checks field by field, and every
 * one of those fields is a way to fail silently: a wrong slug, a stale `created`, or a key that is not a
 * stored owner all produce a rejection whose cause is invisible from the CLI's side. These tests pin the
 * bytes that go on the wire and the message an operator reads back for each documented failure.
 *
 * Hermetic: every "feed" here is a loopback HTTP server started by the test. Nothing leaves the machine.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { describe, test } from 'node:test';

import {
  fetchPlaylistForUnpublish,
  unpublishPlaylist,
} from '../src/utilities/playlist-unpublisher';
import { resolvePlaylistIdentifier } from '../src/utilities/feed-mutation';
import { playlistSigningDidKey } from '../src/utilities/signing-identity';

function makePrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

const STORED_ID = '019852a0-3fc9-7f0a-9b6e-5f3f0f2e1a11';
const STORED_SLUG = 'test-playlist-019852a0';

interface Recorded {
  method?: string;
  url?: string;
  body?: string;
}

interface FeedStub {
  /** Reply for `GET /playlists/{id}`; `null` answers 404. */
  stored?: Record<string, unknown> | null;
  /** Status for the DELETE. Defaults to 204. */
  deleteStatus?: number;
  /** Body for a failing DELETE. */
  deleteBody?: Record<string, unknown>;
}

/**
 * Start a loopback feed that answers a GET and a DELETE, recording the delete request.
 *
 * @returns The base URL, the recorded delete request, and a close function
 */
async function startFeed(
  stub: FeedStub
): Promise<{ baseUrl: string; recorded: Recorded; close: () => void }> {
  const recorded: Recorded = {};
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.method === 'GET') {
        if (stub.stored === null || stub.stored === undefined) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found', message: 'playlist not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stub.stored));
        return;
      }

      recorded.method = req.method;
      recorded.url = req.url;
      recorded.body = body;
      const status = stub.deleteStatus ?? 204;
      if (status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stub.deleteBody ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to start test feed');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    recorded,
    close: () => server.close(),
  };
}

/** A stored playlist owned by `ownerKey`. */
function storedPlaylist(ownerKey: string): Record<string, unknown> {
  return {
    dpVersion: '1.1.0',
    id: STORED_ID,
    slug: STORED_SLUG,
    title: 'Unpublish fixture',
    created: '2026-09-07T10:00:00Z',
    curators: [{ name: 'Owner', key: ownerKey }],
    items: [],
  };
}

describe('unpublish intent', () => {
  test('sends a delete intent naming the stored id and slug, signed as curator', async () => {
    const privateKey = makePrivateKeyBase64();
    const did = playlistSigningDidKey(privateKey);
    const feed = await startFeed({ stored: storedPlaylist(did) });

    try {
      const result = await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey });

      assert.equal(result.success, true, result.error);
      assert.equal(result.playlistId, STORED_ID);
      assert.equal(result.slug, STORED_SLUG);
      assert.equal(recordedMethod(feed.recorded), 'DELETE');
      assert.equal(feed.recorded.url, `/api/v1/playlists/${STORED_ID}`);

      const body = JSON.parse(String(feed.recorded.body)) as Record<string, unknown>;
      assert.equal(body.action, 'delete');
      assert.deepEqual(body.target, { type: 'playlist', id: STORED_ID, slug: STORED_SLUG });
      // Whole-second RFC 3339: the feed compares this against its own clock, and the proven envelope
      // carries no milliseconds.
      assert.match(String(body.created), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

      const signatures = body.signatures as Array<Record<string, unknown>>;
      assert.equal(signatures.length, 1);
      assert.equal(signatures[0].alg, 'ed25519');
      assert.equal(signatures[0].kid, did);
      // Only an owner signature authorizes a delete, so the role is never taken from playlist.role.
      assert.equal(signatures[0].role, 'curator');
      assert.equal(signatures[0].ts, body.created);
    } finally {
      feed.close();
    }
  });

  test('the signature verifies over the intent bytes with signatures stripped', async () => {
    // This is the assertion that would catch a signer fed the wrong payload: the feed canonicalizes the
    // body minus `signatures` (JCS) and checks the digest, so a signature taken over anything else —
    // the whole body, or a re-serialized copy — verifies here and fails there.
    const privateKey = makePrivateKeyBase64();
    const did = playlistSigningDidKey(privateKey);
    const feed = await startFeed({ stored: storedPlaylist(did) });

    try {
      await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey });

      const body = JSON.parse(String(feed.recorded.body)) as Record<string, unknown>;
      const signature = (body.signatures as Array<Record<string, unknown>>)[0];
      const { signatures: _dropped, ...intent } = body;

      const dp1 = await import('dp1-js');
      const expected = dp1.PayloadHashString(Buffer.from(JSON.stringify(intent)));
      assert.equal(signature.payload_hash, expected);

      // Verify the way the feed does: over the whole body, which the verifier canonicalizes with
      // `signatures` stripped. Passing the body rather than a reconstructed intent is the point — it
      // proves the signature covers the bytes actually sent, not a copy assembled by the test.
      const [ok] = dp1.VerifyMultiSignaturesJSON(Buffer.from(String(feed.recorded.body)));
      assert.equal(ok, true);
    } finally {
      feed.close();
    }
  });

  test('takes the slug from the stored copy, not from the identifier the user typed', async () => {
    // `target.slug` must equal the stored row, and nothing the user types carries it — hence the GET.
    // A CLI that derived the slug from the title or the id would fail every delete with a bare 400.
    const privateKey = makePrivateKeyBase64();
    const did = playlistSigningDidKey(privateKey);
    const stored = { ...storedPlaylist(did), slug: 'a-slug-nobody-could-guess' };
    const feed = await startFeed({ stored });

    try {
      const result = await unpublishPlaylist(
        `${feed.baseUrl}/playlists/${STORED_ID}`,
        feed.baseUrl,
        { privateKey }
      );

      assert.equal(result.success, true, result.error);
      const body = JSON.parse(String(feed.recorded.body)) as {
        target: { slug: string; id: string };
      };
      assert.equal(body.target.slug, 'a-slug-nobody-could-guess');
      assert.equal(body.target.id, STORED_ID);
    } finally {
      feed.close();
    }
  });
});

describe('unpublish ownership preflight', () => {
  test('refuses before sending when the configured key is not a stored owner', async () => {
    const ownerKey = makePrivateKeyBase64();
    const otherKey = makePrivateKeyBase64();
    const ownerDid = playlistSigningDidKey(ownerKey);
    const otherDid = playlistSigningDidKey(otherKey);
    const feed = await startFeed({ stored: storedPlaylist(ownerDid) });

    try {
      const result = await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey: otherKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /not an owner/i);
      // Both sides must be named, or an operator with several keys learns only that one was wrong.
      assert.match(String(result.message), new RegExp(otherDid));
      assert.match(String(result.message), new RegExp(ownerDid));
      // Nothing may reach the feed: the refusal is local.
      assert.equal(feed.recorded.method, undefined);
    } finally {
      feed.close();
    }
  });

  test('says a playlist with no declared owners can never be deleted', async () => {
    // Every playlist published before ff-cli required an owner-role signature is in this state. It is a
    // different answer from "wrong key": there is no right key, and telling the operator to switch keys
    // sends them looking for one that does not exist.
    const privateKey = makePrivateKeyBase64();
    const stored = { ...storedPlaylist(playlistSigningDidKey(privateKey)), curators: [] };
    const feed = await startFeed({ stored });

    try {
      const result = await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /declares no owners/i);
      assert.match(String(result.message), /new id/);
      assert.equal(feed.recorded.method, undefined);
    } finally {
      feed.close();
    }
  });
});

describe('unpublish feed error mapping', () => {
  const cases: Array<{
    name: string;
    status: number;
    body: Record<string, unknown>;
    expect: RegExp;
  }> = [
    {
      name: '401 — the feed saw no signatures',
      status: 401,
      body: { error: 'unauthorized', message: 'request body must carry signatures' },
      expect: /no signatures/i,
    },
    {
      name: '403 — the signer is not an owner',
      status: 403,
      body: { error: 'forbidden', message: 'signer is not an owner' },
      expect: /not an owner/i,
    },
    {
      name: '400 invalid_timestamp — outside the freshness window',
      status: 400,
      body: { error: 'invalid_timestamp', message: 'created is outside the allowed window' },
      expect: /freshness window/i,
    },
    {
      name: '400 bad_request — target mismatch',
      status: 400,
      body: { error: 'bad_request', message: 'delete intent target mismatch' },
      expect: /did not match the stored playlist/i,
    },
    {
      name: '404 — unknown or tombstoned',
      status: 404,
      body: { error: 'not_found', message: 'playlist not found' },
      expect: /no such playlist/i,
    },
    {
      name: '409 — changed between authorization and write',
      status: 409,
      body: { error: 'conflict', message: 'resource changed' },
      expect: /changed between authorization and the write/i,
    },
  ];

  for (const testCase of cases) {
    test(`maps ${testCase.name}`, async () => {
      const privateKey = makePrivateKeyBase64();
      const did = playlistSigningDidKey(privateKey);
      const feed = await startFeed({
        stored: storedPlaylist(did),
        deleteStatus: testCase.status,
        deleteBody: testCase.body,
      });

      try {
        const result = await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey });

        assert.equal(result.success, false);
        assert.match(String(result.error), testCase.expect);
        // The feed's own words are always carried through, so nothing it said is lost in translation.
        assert.match(
          `${result.error} ${result.message}`,
          new RegExp(String(testCase.body.message))
        );
      } finally {
        feed.close();
      }
    });
  }

  test('reports a lookup 404 without signing anything', async () => {
    const privateKey = makePrivateKeyBase64();
    const feed = await startFeed({ stored: null });

    try {
      const result = await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /no such playlist/i);
      assert.equal(feed.recorded.method, undefined);
    } finally {
      feed.close();
    }
  });
});

describe('playlist identifier resolution', () => {
  test('accepts a bare id, a slug, and a feed URL', () => {
    assert.equal(resolvePlaylistIdentifier(STORED_ID), STORED_ID);
    assert.equal(resolvePlaylistIdentifier('  my-slug '), 'my-slug');
    assert.equal(
      resolvePlaylistIdentifier(`https://feed.example.com/api/v1/playlists/${STORED_ID}`),
      STORED_ID
    );
    // A trailing slash must not resolve to an empty segment.
    assert.equal(
      resolvePlaylistIdentifier(`https://feed.example.com/api/v1/playlists/${STORED_ID}/`),
      STORED_ID
    );
  });
});

describe('playlist lookup helper', () => {
  test('fetchPlaylistForUnpublish returns the stored document', async () => {
    const privateKey = makePrivateKeyBase64();
    const feed = await startFeed({ stored: storedPlaylist(playlistSigningDidKey(privateKey)) });

    try {
      const stored = await fetchPlaylistForUnpublish(STORED_ID, feed.baseUrl);
      assert.equal(stored.id, STORED_ID);
      assert.equal(stored.slug, STORED_SLUG);
    } finally {
      feed.close();
    }
  });
});

/** Reads the recorded method, so an unrecorded request fails as `undefined` rather than throwing. */
function recordedMethod(recorded: Recorded): string | undefined {
  return recorded.method;
}
