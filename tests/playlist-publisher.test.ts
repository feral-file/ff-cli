import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { publishPlaylist } from '../src/utilities/playlist-publisher';
import { signPlaylist } from '../src/utilities/playlist-signer';
import { playlistSigningDidKey } from '../src/utilities/signing-identity';

const fixturePath = join(__dirname, 'fixtures/playlists/valid-unsigned-open-v11.json');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ff1-publish-'));
}

function makePrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

describe('publishPlaylist validation contract', () => {
  test('rejects a structurally invalid playlist before upload', async () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, 'invalid.json');
      writeFileSync(path, JSON.stringify({ dpVersion: '1.1.0', title: 'bad' }, null, 2), 'utf-8');

      const result = await publishPlaylist(path, 'http://127.0.0.1:0');

      assert.equal(result.success, false);
      assert.match(result.error ?? '', /verification failed|dp1:/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a playlist with a broken signature envelope before upload', async () => {
    const dir = makeTempDir();
    const server = createServer((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'playlist-123' }));
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const port = address.port;
      const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const playlist = { ...basePlaylist, signatures: [{ sig: 'AAAA' }] };
      const path = join(dir, 'tampered.json');
      writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

      const result = await publishPlaylist(path, `http://127.0.0.1:${port}`);

      assert.equal(result.success, false);
      assert.match(result.error ?? '', /signature verification failed/i);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uploads a verified playlist after signature verification succeeds', async () => {
    const dir = makeTempDir();
    let deliveredBody = '';
    const server = createServer((req, res) => {
      req.setEncoding('utf-8');
      req.on('data', (chunk) => {
        deliveredBody += chunk;
      });
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'playlist-123' }));
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const privateKey = makePrivateKeyBase64();
      // Declare the signer as a curator BEFORE signing. The feed accepts a create only when a
      // signature's kid appears in the document's own curators[], and signing covers curators[], so
      // adding it afterwards would invalidate the signature this test then expects to upload.
      //
      // Sign as `curator`, not the configured default: a declared key only counts as an owner when it
      // also signed in the owner role, so this is what a publishable document looks like.
      const withCurator = {
        ...basePlaylist,
        curators: [{ name: 'Test Curator', key: playlistSigningDidKey(privateKey) }],
      };
      const signature = await signPlaylist(withCurator, privateKey, 'curator');
      const playlist = { ...withCurator, signature: undefined, signatures: [signature] };
      const path = join(dir, 'signed.json');
      writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

      const result = await publishPlaylist(path, `http://127.0.0.1:${address.port}`);

      assert.equal(result.success, true);
      assert.equal(result.playlistId, 'playlist-123');
      assert.match(result.message ?? '', /Published to feed server/i);
      assert.ok(deliveredBody, 'expected publish request body to be captured');

      const delivered = JSON.parse(deliveredBody) as {
        signatures?: unknown[];
        signature?: unknown;
      };
      assert.equal(Array.isArray(delivered.signatures), true);
      assert.ok((delivered.signatures?.length ?? 0) > 0);
      assert.equal(delivered.signature, undefined);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('publishPlaylist refuses a signed playlist whose signer is not a declared curator', async () => {
  // The feed's rule, checked locally: a signature's kid must appear in the document's own curators[].
  // Its server-side answer ("no valid curator signature found") reads as a signing problem and sends
  // people to check their key rather than their document, so the CLI answers first with the remedy.
  const dir = makeTempDir();
  try {
    const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const privateKey = makePrivateKeyBase64();
    const signature = await signPlaylist(basePlaylist, privateKey);
    const playlist = { ...basePlaylist, signature: undefined, signatures: [signature] };
    const path = join(dir, 'signed-no-curator.json');
    writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

    // A URL that would fail loudly if contacted: the point is that no request is made at all.
    const result = await publishPlaylist(path, 'http://127.0.0.1:1/api/v1');

    assert.equal(result.success, false);
    assert.match(String(result.error), /not declared as a curator/i);
    assert.match(String(result.message), /curators/);
    // The remedy has to carry the actual kid, or the user cannot act on it.
    assert.match(String(result.message), new RegExp(playlistSigningDidKey(privateKey)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishPlaylist refuses a legacy flat-signature playlist without uploading', async () => {
  // A flat `signature` string still verifies locally when the matching key is configured, but it carries
  // no kid — so the curator check has nothing to match and the document would reach the feed only to be
  // refused as unauthenticated. Verified against a running feed before this guard existed.
  const dir = makeTempDir();
  try {
    const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const playlist = { ...basePlaylist, signature: 'ed25519:deadbeef', signatures: undefined };
    const path = join(dir, 'legacy.json');
    writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

    // Port 1 would fail loudly if contacted; the point is that nothing is sent.
    const result = await publishPlaylist(path, 'http://127.0.0.1:1/api/v1');

    assert.equal(result.success, false);
    const text = `${result.error} ${result.message}`;
    assert.match(text, /legacy flat signature|signatures\[\]/i);
    // The remedy must name the concrete steps, not just the diagnosis.
    assert.match(text, /ff-cli sign/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishPlaylist refuses a declared curator who signed under a non-owner role', async () => {
  // The feed derives a resource's owners from `curators[]` and then requires one of those keys to have
  // signed *as curator*: being named is a claim, signing in the owner role is the proof. A key that is
  // declared but signed as `agent` therefore authorizes nothing, and the server's answer speaks about
  // ownership rather than about the role, which sends people to edit `curators[]` — already correct.
  // This is a separate failure from "not declared": the document is right and the signature is wrong.
  const dir = makeTempDir();
  try {
    const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const privateKey = makePrivateKeyBase64();
    const key = playlistSigningDidKey(privateKey);
    const declared = { ...basePlaylist, curators: [{ name: 'Declared', key }] };
    const signature = await signPlaylist(declared, privateKey, 'agent');
    const playlist = { ...declared, signature: undefined, signatures: [signature] };
    const path = join(dir, 'declared-wrong-role.json');
    writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

    const result = await publishPlaylist(path, 'http://127.0.0.1:1/api/v1');

    assert.equal(result.success, false);
    assert.match(String(result.error), /signed as "agent"|non-owner role/i);
    // The remedy must name the role fix, not the declaration fix.
    assert.match(String(result.message), /curator/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publishPlaylist accepts a declared curator who signed in the curator role', async () => {
  // Non-vacuity guard for the check above: the same document signed as `curator` must pass the preflight
  // and reach the network, or the new gate would be rejecting everything rather than the wrong role.
  const dir = makeTempDir();
  try {
    const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const privateKey = makePrivateKeyBase64();
    const key = playlistSigningDidKey(privateKey);
    const declared = { ...basePlaylist, curators: [{ name: 'Declared', key }] };
    const signature = await signPlaylist(declared, privateKey, 'curator');
    const playlist = { ...declared, signature: undefined, signatures: [signature] };
    const path = join(dir, 'declared-curator-role.json');
    writeFileSync(path, JSON.stringify(playlist, null, 2), 'utf-8');

    // Port 1 refuses the connection: reaching a transport error proves the preflight let it through.
    const result = await publishPlaylist(path, 'http://127.0.0.1:1/api/v1');

    assert.equal(result.success, false);
    assert.doesNotMatch(String(result.error), /curator/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every publish remedy names the curator role, so following one cannot fail the next gate', async () => {
  // A remedy that hands back a document this same preflight rejects is worse than no remedy: the user
  // follows the instruction exactly and hits a second failure. Both recovery paths tell people to sign,
  // and plain `ff-cli sign` uses playlist.role, whose shipped default is `agent` — which the owner-role
  // gate then refuses. Pin the role on every remedy so the sequence terminates.
  const dir = makeTempDir();
  try {
    const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const privateKey = makePrivateKeyBase64();

    // Legacy flat signature.
    const legacyPath = join(dir, 'legacy.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({ ...basePlaylist, signature: 'ed25519:0xdeadbeef' }, null, 2),
      'utf-8'
    );
    const legacy = await publishPlaylist(legacyPath, 'http://127.0.0.1:1/api/v1');
    assert.equal(legacy.success, false);
    assert.match(String(legacy.message), /-r curator/);

    // Signed, but the signer is not declared.
    const undeclaredPath = join(dir, 'undeclared.json');
    const undeclaredSig = await signPlaylist(basePlaylist, privateKey, 'curator');
    writeFileSync(
      undeclaredPath,
      JSON.stringify({ ...basePlaylist, signatures: [undeclaredSig] }, null, 2),
      'utf-8'
    );
    const undeclared = await publishPlaylist(undeclaredPath, 'http://127.0.0.1:1/api/v1');
    assert.equal(undeclared.success, false);
    assert.match(String(undeclared.message), /-r curator/);

    // Declared, but signed under a non-owner role.
    const wrongRolePath = join(dir, 'wrong-role.json');
    const declared = {
      ...basePlaylist,
      curators: [{ name: 'Declared', key: playlistSigningDidKey(privateKey) }],
    };
    const agentSig = await signPlaylist(declared, privateKey, 'agent');
    writeFileSync(
      wrongRolePath,
      JSON.stringify({ ...declared, signatures: [agentSig] }, null, 2),
      'utf-8'
    );
    const wrongRole = await publishPlaylist(wrongRolePath, 'http://127.0.0.1:1/api/v1');
    assert.equal(wrongRole.success, false);
    assert.match(String(wrongRole.message), /-r curator/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appending a curator signature repairs a role-only failure without an unsigned copy', async () => {
  // The role-only failure is repairable in place, and the remedy must say so: a user who kept only the
  // signed file would otherwise be told to reconstruct a document they no longer have.
  //
  // It works because the DP-1 payload hash covers the document with `signature`/`signatures` stripped, so
  // adding a signature moves no signed byte and the earlier entry stays valid over the same payload. That
  // is exactly what distinguishes this case from the two other publish failures, where the fix changes
  // signed content (curators[]) and the earlier signature would then cover a document that no longer
  // exists — hence their "start from the unsigned file" wording, which must NOT be copied here.
  const dir = makeTempDir();
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'playlist-appended' }));
    });
  });

  try {
    await new Promise<void>((resolvePromise) => server.listen(0, resolvePromise));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const privateKey = makePrivateKeyBase64();
    const declared = {
      ...basePlaylist,
      curators: [{ name: 'Declared', key: playlistSigningDidKey(privateKey) }],
    };

    // The stuck state: declared correctly, signed under the wrong role.
    const agentSignature = await signPlaylist(declared, privateKey, 'agent');
    const stuck = { ...declared, signatures: [agentSignature] };
    const path = join(dir, 'stuck.json');
    writeFileSync(path, JSON.stringify(stuck, null, 2), 'utf-8');

    const before = await publishPlaylist(path, `http://127.0.0.1:${address.port}`);
    assert.equal(before.success, false);
    assert.match(String(before.error), /non-owner role/i);

    // The documented remedy: append, do not rebuild.
    const curatorSignature = await signPlaylist(stuck, privateKey, 'curator');
    const repaired = { ...stuck, signatures: [...stuck.signatures, curatorSignature] };
    writeFileSync(path, JSON.stringify(repaired, null, 2), 'utf-8');

    const after = await publishPlaylist(path, `http://127.0.0.1:${address.port}`);
    assert.equal(after.success, true, after.error);
    assert.equal(after.playlistId, 'playlist-appended');
    // Both entries survive, and the original remains verifiable — publishPlaylist verifies before upload,
    // so reaching success at all proves the appended envelope still validates as a whole.
    assert.equal(repaired.signatures.length, 2);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a curator signature from an undeclared key does not satisfy the owner-role gate', async () => {
  // `sign` uses the CONFIGURED key unless --key says otherwise, and that key is not necessarily the one
  // the playlist declares. Following "sign -r curator" on a machine configured with a different key
  // appends an owner-role signature the feed ignores — the declared key still shows only its non-owner
  // role, so the same failure repeats and the remedy looks broken.
  //
  // Existing recovery coverage used one key for both roles, which cannot see this. Hence two keys here:
  // A is declared and signed as agent; B is the configured key.
  const dir = makeTempDir();
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'playlist-two-keys' }));
    });
  });

  try {
    await new Promise<void>((resolvePromise) => server.listen(0, resolvePromise));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }
    const feed = `http://127.0.0.1:${address.port}`;

    const basePlaylist = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
    const keyA = makePrivateKeyBase64();
    const keyB = makePrivateKeyBase64();
    const declared = {
      ...basePlaylist,
      curators: [{ name: 'Declared A', key: playlistSigningDidKey(keyA) }],
    };

    // Stuck: the declared key signed under a non-owner role.
    const agentA = await signPlaylist(declared, keyA, 'agent');
    const stuck = { ...declared, signatures: [agentA] };
    const path = join(dir, 'two-keys.json');
    writeFileSync(path, JSON.stringify(stuck, null, 2), 'utf-8');

    // The remedy carried out with the WRONG key: a curator signature, but from an undeclared one.
    const curatorB = await signPlaylist(stuck, keyB, 'curator');
    writeFileSync(
      path,
      JSON.stringify({ ...stuck, signatures: [agentA, curatorB] }, null, 2),
      'utf-8'
    );
    const wrongKey = await publishPlaylist(path, feed);
    assert.equal(
      wrongKey.success,
      false,
      'an undeclared curator signature must not satisfy the gate'
    );
    assert.match(String(wrongKey.error), /non-owner role/i);
    // The remedy must name the key that has to sign, or the user repeats the same step.
    assert.match(String(wrongKey.message), /--key/);
    assert.match(String(wrongKey.message), new RegExp(playlistSigningDidKey(keyA)));

    // The remedy carried out correctly: the declared key signs in the owner role.
    const curatorA = await signPlaylist(stuck, keyA, 'curator');
    writeFileSync(
      path,
      JSON.stringify({ ...stuck, signatures: [agentA, curatorB, curatorA] }, null, 2),
      'utf-8'
    );
    const rightKey = await publishPlaylist(path, feed);
    assert.equal(rightKey.success, true, rightKey.error);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
