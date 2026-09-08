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
import { signPlaylist } from '../src/utilities/playlist-signer';
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

/** The unsigned body of a stored playlist declaring `ownerDid` as its curator. */
function storedBody(ownerDid: string): Record<string, unknown> {
  return {
    dpVersion: '1.1.0',
    id: STORED_ID,
    slug: STORED_SLUG,
    title: 'Unpublish fixture',
    created: '2026-09-07T10:00:00Z',
    curators: [{ name: 'Owner', key: ownerDid }],
    items: [],
  };
}

/**
 * A stored playlist actually owned by `ownerKey` — declared AND signed as curator.
 *
 * Declaring alone is not ownership: the feed treats a key as an owner only once it has signed the
 * stored document in the owner role, so a fixture that only declares would exercise the legacy
 * unowned path rather than the ordinary one. `storedBody` is the same document without that proof, and
 * the tests below use it deliberately for the legacy cases.
 */
async function storedPlaylist(
  ownerKey: string,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  // Overrides are applied BEFORE signing. Editing a signed document moves bytes the signature covers,
  // so a fixture patched afterwards would be an unverifiable document rather than a stored one.
  const body = { ...storedBody(playlistSigningDidKey(ownerKey)), ...overrides };
  const signature = await signPlaylist(body, ownerKey, 'curator');
  return { ...body, signatures: [signature] };
}

describe('unpublish intent', () => {
  test('sends a delete intent naming the stored id and slug, signed as curator', async () => {
    const privateKey = makePrivateKeyBase64();
    const did = playlistSigningDidKey(privateKey);
    const feed = await startFeed({ stored: await storedPlaylist(privateKey) });

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
    const feed = await startFeed({ stored: await storedPlaylist(privateKey) });

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
    const stored = await storedPlaylist(privateKey, { slug: 'a-slug-nobody-could-guess' });
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
    const feed = await startFeed({ stored: await storedPlaylist(ownerKey) });

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
    const stored = { ...(await storedPlaylist(privateKey)), curators: [] };
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

  test('refuses a declared curator that only ever signed as agent', async () => {
    // The legacy shape, and the one this check exists for: every playlist published from 2.5.0 with the
    // default `agent` role declares a curator and carries only that key's agent signature. Declaration
    // alone used to pass, so ff-cli signed an intent, sent it, and reported the feed's 403 as "your key
    // is not declared" — the one thing that is not wrong with the document.
    const privateKey = makePrivateKeyBase64();
    const did = playlistSigningDidKey(privateKey);
    const body = storedBody(did);
    const agentSignature = await signPlaylist(body, privateKey, 'agent');
    const feed = await startFeed({ stored: { ...body, signatures: [agentSignature] } });

    try {
      const result = await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /No key has proved ownership/i);
      // It must not read as a declaration problem: curators[] is correct.
      assert.doesNotMatch(String(result.error), /not declared|not an owner/i);
      // The declaration is still worth showing, so the operator can see it was not the problem.
      assert.match(String(result.message), new RegExp(did));
      assert.match(String(result.message), /new id/);
      assert.equal(feed.recorded.method, undefined);
    } finally {
      feed.close();
    }
  });

  test('refuses a key that is declared but was never proved, when another owner exists', async () => {
    // Two curators declared; only A signed as curator. B holds a real declaration and no proof, so B
    // cannot act — and the answer has to point at A rather than at B's curators[] entry.
    const keyA = makePrivateKeyBase64();
    const keyB = makePrivateKeyBase64();
    const didA = playlistSigningDidKey(keyA);
    const didB = playlistSigningDidKey(keyB);
    const body = {
      ...storedBody(didA),
      curators: [
        { name: 'A', key: didA },
        { name: 'B', key: didB },
      ],
    };
    const curatorA = await signPlaylist(body, keyA, 'curator');
    const agentB = await signPlaylist(body, keyB, 'agent');
    const feed = await startFeed({ stored: { ...body, signatures: [curatorA, agentB] } });

    try {
      const result = await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey: keyB });

      assert.equal(result.success, false);
      assert.match(
        String(result.error),
        /declared on this playlist but never signed it as curator/i
      );
      assert.match(String(result.message), new RegExp(didA));
      assert.equal(feed.recorded.method, undefined);
    } finally {
      feed.close();
    }
  });

  test('a tampered owner signature is not proof', async () => {
    // The declaration and the role are both right; only the bytes are wrong. Reading the role without
    // verifying would accept this, which is the difference between checking a claim and checking proof.
    const privateKey = makePrivateKeyBase64();
    const did = playlistSigningDidKey(privateKey);
    const body = storedBody(did);
    const signature = await signPlaylist(body, privateKey, 'curator');
    const feed = await startFeed({
      stored: { ...body, signatures: [{ ...signature, sig: 'AAAA' }] },
    });

    try {
      const result = await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /No key has proved ownership/i);
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
      name: '403 — the feed refused an owner the local check accepted',
      status: 403,
      body: { error: 'forbidden', message: 'signer is not an owner' },
      expect: /refused by the feed/i,
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
        stored: await storedPlaylist(privateKey),
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

  test('a feed 403 is reported as the feed refusing, not as a missing declaration', async () => {
    // The two failures are now genuinely different: the local one means the key is absent from the
    // stored curators[] or unproved, and it never sends a request. This one has passed that check, so
    // repeating "your key is not declared" would send the operator to fix something already correct.
    const privateKey = makePrivateKeyBase64();
    const feed = await startFeed({
      stored: await storedPlaylist(privateKey),
      deleteStatus: 403,
      deleteBody: { error: 'forbidden', message: 'signer is not an owner' },
    });

    try {
      const result = await unpublishPlaylist(STORED_ID, feed.baseUrl, { privateKey });

      assert.equal(result.success, false);
      // It reached the feed — this is a remote refusal, not a preflight one.
      assert.equal(feed.recorded.method, 'DELETE');
      assert.match(String(result.error), /refused by the feed/i);
      assert.doesNotMatch(String(result.error), /not declared|declares no owners/i);
      assert.match(String(result.message), /local check disagreed/i);
    } finally {
      feed.close();
    }
  });

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
    const feed = await startFeed({ stored: await storedPlaylist(privateKey) });

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
