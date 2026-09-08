/**
 * Contract tests for `publish --replace`.
 *
 * A replace is two independently verified halves: the re-signed document, and an authorization intent
 * bound to that document's payload hash. Sending only the document authorizes nothing, and sending an
 * intent whose `payloadHash` was computed over anything but the submitted bytes fails at the feed with a
 * bare `400`. These tests pin both halves, plus the three immutable fields whose accidental change is the
 * ordinary way a replace goes wrong: a rebuilt playlist mints a new id, slug, and `created`.
 *
 * Hermetic: every "feed" is a loopback HTTP server started by the test.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { replacePlaylist } from '../src/utilities/playlist-publisher';
import { signPlaylist } from '../src/utilities/playlist-signer';
import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ff1-replace-'));
}

function makePrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

interface Recorded {
  method?: string;
  url?: string;
  body?: string;
}

interface ReplaceFeedStub {
  stored?: Record<string, unknown> | null;
  putStatus?: number;
  putBody?: Record<string, unknown>;
}

async function startFeed(
  stub: ReplaceFeedStub
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
        if (!stub.stored) {
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
      const status = stub.putStatus ?? 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stub.putBody ?? stub.stored ?? {}));
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

/**
 * Build a signed, publishable playlist owned by `privateKey`, with `overrides` applied before signing.
 *
 * `curators[]` is declared before signing and the role is `curator`, because that is the only shape the
 * shared preflight accepts — a replace is held to exactly the same bar as a create.
 */
async function signedPlaylist(
  privateKey: string,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
  const document = {
    ...base,
    ...overrides,
    curators: [{ name: 'Owner', key: playlistSigningDidKey(privateKey) }],
  };
  const signature = await signPlaylist(document, privateKey, 'curator');
  return { ...document, signature: undefined, signatures: [signature] };
}

/** Write a document to a temp file and return its path. */
function writePlaylist(dir: string, name: string, document: Record<string, unknown>): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(document, null, 2), 'utf-8');
  return path;
}

describe('publish --replace', () => {
  test('sends a PUT carrying the re-signed document and an intent bound to its payload hash', async () => {
    const dir = makeTempDir();
    const privateKey = makePrivateKeyBase64();
    const did = playlistSigningDidKey(privateKey);
    const stored = await signedPlaylist(privateKey);
    const edited = await signedPlaylist(privateKey, { title: 'Edited title' });
    const feed = await startFeed({ stored });

    try {
      const path = writePlaylist(dir, 'edited.json', edited);
      const result = await replacePlaylist(path, feed.baseUrl, { privateKey });

      assert.equal(result.success, true, `${result.error}\n${result.message}`);
      assert.equal(feed.recorded.method, 'PUT');
      assert.equal(feed.recorded.url, `/api/v1/playlists/${String(stored.id)}`);

      const body = JSON.parse(String(feed.recorded.body)) as {
        document: Record<string, unknown>;
        authorization: Record<string, unknown>;
      };

      // The document half is the edited, re-signed document verbatim.
      assert.equal(body.document.title, 'Edited title');
      assert.deepEqual(body.document.signatures, edited.signatures);

      // The authorization half.
      assert.equal(body.authorization.action, 'replace');
      assert.deepEqual(body.authorization.target, {
        type: 'playlist',
        id: stored.id,
        slug: stored.slug,
      });
      assert.match(String(body.authorization.created), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

      const dp1 = await import('dp1-js');
      // payloadHash must be the DP-1 signing digest of the document actually submitted, or a captured
      // intent could install different bytes.
      assert.equal(
        body.authorization.payloadHash,
        dp1.PayloadHashString(Buffer.from(JSON.stringify(body.document)))
      );

      const signatures = body.authorization.signatures as Array<Record<string, unknown>>;
      assert.equal(signatures.length, 1);
      assert.equal(signatures[0].kid, did);
      assert.equal(signatures[0].role, 'curator');

      // And the intent's own signature verifies over the intent bytes with `signatures` stripped.
      const [ok] = dp1.VerifyMultiSignaturesJSON(Buffer.from(JSON.stringify(body.authorization)));
      assert.equal(ok, true);
    } finally {
      feed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a rebuilt document that changes id, slug, or created', async () => {
    // The everyday mistake: re-running `find`/`build` instead of editing the published document. Each of
    // those mints a fresh identity, and the feed answers with a `400` that names no field.
    const dir = makeTempDir();
    const privateKey = makePrivateKeyBase64();
    const stored = await signedPlaylist(privateKey);
    const rebuilt = await signedPlaylist(privateKey, {
      slug: 'a-completely-new-slug',
      created: '2020-01-01T00:00:00Z',
    });
    const feed = await startFeed({ stored });

    try {
      const path = writePlaylist(dir, 'rebuilt.json', rebuilt);
      const result = await replacePlaylist(path, feed.baseUrl, { privateKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /may not change/i);
      assert.match(String(result.message), /slug/);
      assert.match(String(result.message), /created/);
      // The remedy has to name commands that actually produce the next step's input. `verify` was
      // named here once and does not: it validates and prints a summary, leaving no document to edit.
      assert.match(
        String(result.message),
        new RegExp(`ff-cli fetch ${stored.id} -o playlist.json`)
      );
      assert.match(
        String(result.message),
        /ff-cli sign playlist\.json -r curator --replace-signatures/
      );
      assert.match(String(result.message), /ff-cli publish playlist\.json --replace/);
      assert.doesNotMatch(String(result.message), /ff-cli verify/);
      // Nothing is written: the refusal is local.
      assert.equal(feed.recorded.method, undefined);
    } finally {
      feed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a document that changes the owner set', async () => {
    const dir = makeTempDir();
    const ownerKey = makePrivateKeyBase64();
    const intruderKey = makePrivateKeyBase64();
    const stored = await signedPlaylist(ownerKey);

    // A document declaring a second curator: signed correctly, but the owner set is immutable.
    const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const grabbed = {
      ...base,
      id: stored.id,
      slug: stored.slug,
      created: stored.created,
      curators: [
        { name: 'Owner', key: playlistSigningDidKey(ownerKey) },
        { name: 'Intruder', key: playlistSigningDidKey(intruderKey) },
      ],
    };
    const signature = await signPlaylist(grabbed, ownerKey, 'curator');
    const document = { ...grabbed, signatures: [signature] };
    const feed = await startFeed({ stored });

    try {
      const path = writePlaylist(dir, 'owner-change.json', document);
      const result = await replacePlaylist(path, feed.baseUrl, { privateKey: ownerKey });

      assert.equal(result.success, false);
      assert.match(String(result.message), /curators/);
      assert.equal(feed.recorded.method, undefined);
    } finally {
      feed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses when the configured key is not a stored owner', async () => {
    // The document may be perfectly signed by its own declared curator and still be unauthorized: the
    // intent is signed by whoever runs the command, and only a STORED owner may authorize the write.
    const dir = makeTempDir();
    const ownerKey = makePrivateKeyBase64();
    const otherKey = makePrivateKeyBase64();
    const stored = await signedPlaylist(ownerKey);
    const edited = await signedPlaylist(ownerKey, { title: 'Edited' });
    const feed = await startFeed({ stored });

    try {
      const path = writePlaylist(dir, 'not-owner.json', edited);
      const result = await replacePlaylist(path, feed.baseUrl, { privateKey: otherKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /not an owner/i);
      assert.match(String(result.message), new RegExp(playlistSigningDidKey(otherKey)));
      assert.match(String(result.message), new RegExp(playlistSigningDidKey(ownerKey)));
      assert.equal(feed.recorded.method, undefined);
    } finally {
      feed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses when the stored playlist declares a curator that never signed as curator', async () => {
    // The legacy shape a replace meets most often: a playlist published while the default signing role
    // was `agent`. The submitted document can be signed impeccably and still authorize nothing, because
    // the intent is checked against the STORED document's proof — which does not exist.
    const dir = makeTempDir();
    const privateKey = makePrivateKeyBase64();

    const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const declared = {
      ...base,
      curators: [{ name: 'Owner', key: playlistSigningDidKey(privateKey) }],
    };
    const agentSignature = await signPlaylist(declared, privateKey, 'agent');
    const legacyStored = { ...declared, signatures: [agentSignature] };
    const edited = await signedPlaylist(privateKey, { title: 'Edited' });
    const feed = await startFeed({ stored: legacyStored });

    try {
      const path = writePlaylist(dir, 'edited.json', edited);
      const result = await replacePlaylist(path, feed.baseUrl, { privateKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /No key has proved ownership/i);
      assert.match(String(result.message), /new id/);
      assert.equal(feed.recorded.method, undefined, 'nothing may be sent');
    } finally {
      feed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('says to publish instead when the feed has never held this id', async () => {
    const dir = makeTempDir();
    const privateKey = makePrivateKeyBase64();
    const document = await signedPlaylist(privateKey);
    const feed = await startFeed({ stored: null });

    try {
      const path = writePlaylist(dir, 'missing.json', document);
      const result = await replacePlaylist(path, feed.baseUrl, { privateKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /nothing to replace/i);
      assert.match(String(result.message), /without --replace/);
    } finally {
      feed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('applies the same signing preflights as a create', async () => {
    // A replace that accepted a document `publish` refuses would let an unauthorizable playlist back in
    // through the side door: it would be stored with no owner-role signature, and then be neither
    // replaceable nor deletable.
    const dir = makeTempDir();
    const privateKey = makePrivateKeyBase64();
    const base = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const declared = {
      ...base,
      curators: [{ name: 'Owner', key: playlistSigningDidKey(privateKey) }],
    };
    const agentSignature = await signPlaylist(declared, privateKey, 'agent');
    const wrongRole = { ...declared, signatures: [agentSignature] };
    const feed = await startFeed({ stored: wrongRole });

    try {
      const path = writePlaylist(dir, 'wrong-role.json', wrongRole);
      const result = await replacePlaylist(path, feed.baseUrl, { privateKey });

      assert.equal(result.success, false);
      assert.match(String(result.error), /non-owner role/i);
      assert.equal(feed.recorded.method, undefined);
    } finally {
      feed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const errorCases: Array<{
    name: string;
    status: number;
    body: Record<string, unknown>;
    expect: RegExp;
  }> = [
    {
      name: '401',
      status: 401,
      body: { error: 'unauthorized', message: 'request body must carry signatures' },
      expect: /no signatures/i,
    },
    {
      name: '403',
      status: 403,
      body: { error: 'forbidden', message: 'owner set changed' },
      expect: /refused by the feed/i,
    },
    {
      name: '400 invalid_timestamp',
      status: 400,
      body: { error: 'invalid_timestamp', message: 'intent created outside window' },
      expect: /freshness window/i,
    },
    {
      name: '400 bad_request',
      status: 400,
      body: { error: 'bad_request', message: 'identity mismatch' },
      expect: /did not match the stored playlist/i,
    },
    {
      name: '409',
      status: 409,
      body: { error: 'conflict', message: 'resource changed' },
      expect: /changed between authorization and the write/i,
    },
  ];

  for (const errorCase of errorCases) {
    test(`maps a ${errorCase.name} from the replace`, async () => {
      const dir = makeTempDir();
      const privateKey = makePrivateKeyBase64();
      const stored = await signedPlaylist(privateKey);
      const edited = await signedPlaylist(privateKey, { title: 'Edited' });
      const feed = await startFeed({
        stored,
        putStatus: errorCase.status,
        putBody: errorCase.body,
      });

      try {
        const path = writePlaylist(dir, 'edited.json', edited);
        const result = await replacePlaylist(path, feed.baseUrl, { privateKey });

        assert.equal(result.success, false);
        assert.match(String(result.error), errorCase.expect);
        assert.match(
          `${result.error} ${result.message}`,
          new RegExp(String(errorCase.body.message))
        );
      } finally {
        feed.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
