import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { createRequire } from 'node:module';

const projectRoot = resolve(__dirname, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = resolve(projectRoot, 'index.ts');
const fixturesDir = join(projectRoot, 'tests/fixtures/playlists');
const examplesDir = join(projectRoot, 'examples');
const require = createRequire(import.meta.url);
const { SignLegacyEd25519 } = require('dp1-js') as {
  SignLegacyEd25519: (raw: Buffer | string, privateKey: string) => string;
};
const { signPlaylist } = require('../src/utilities/playlist-signer.js') as {
  signPlaylist: (
    playlist: Record<string, unknown>,
    privateKey?: string,
    roleOverride?: string
  ) => Promise<Record<string, unknown>>;
};

type RunResult = { status: number | null; stdout: string; stderr: string };

const playlistFixtures = {
  validSignedV10: 'valid-signed-v10.json',
  validSignedV11: 'valid-signed-v11.json',
  validUnsignedV10: 'unsigned-draft-v10.json',
  validUnsignedOpenV11: 'unsigned-draft-open-v11.json',
  invalidMissingTitleV10: 'invalid-missing-title-v10.json',
  invalidDisplayAndSourceV10: 'invalid-display-and-source-v10.json',
  invalidMissingItems: 'invalid-playlist-missing-items.json',
  invalidJson: 'invalid-json.json',
} as const;

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {}
): RunResult {
  const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(cwd, '.xdg'),
      ...extraEnv,
    },
    encoding: 'utf-8',
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'ff-cli-integration-'));
}

function writeSigningConfig(dir: string): void {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ playlist: { privateKey: privateKeyBase64, role: 'agent' } }, null, 2),
    'utf-8'
  );
}

function makeLegacySignedPlaylist(
  privateKeyBase64: string,
  publicKeyPem: string,
  playlist: Record<string, unknown>
): {
  playlist: Record<string, unknown>;
  publicKeyPem: string;
} {
  const legacySignature = SignLegacyEd25519(
    Buffer.from(JSON.stringify(playlist)),
    privateKeyBase64
  );

  return {
    playlist: {
      ...playlist,
      signature: legacySignature,
    },
    publicKeyPem,
  };
}

function copyFixture(
  dir: string,
  fixtureName: keyof typeof playlistFixtures,
  targetName = 'playlist.json'
): string {
  const target = join(dir, targetName);
  copyFileSync(join(fixturesDir, playlistFixtures[fixtureName]), target);
  return target;
}

function copyExample(dir: string, exampleName: string, targetName = 'playlist.json'): string {
  const target = join(dir, targetName);
  copyFileSync(join(examplesDir, exampleName), target);
  return target;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Parsed shape acceptable to `signPlaylist` / DP-1 v1.1.0 envelope before attaching `signatures[]`. */
function v11UnsignedPlaylistEnvelope(): Record<string, unknown> {
  return {
    dpVersion: '1.1.0',
    id: 'd2d4f9b0-7f01-4c26-9c10-1c4d7477f5de',
    slug: 'cli-verify-v11',
    created: '2026-02-06T00:00:00.000Z',
    title: 'CLI verify v1.1 multisig',
    items: [
      {
        id: 'ad5de50a-6a0d-4b61-8ef9-7b0f0d1d5e9b',
        source: 'https://example.com/nft.png',
        duration: 10,
        license: 'open',
        created: '2026-02-06T00:00:00.000Z',
      },
    ],
    defaults: {
      display: {
        scaling: 'fit',
        background: '#111111',
        margin: 0,
      },
      license: 'token',
      duration: 10,
    },
  };
}

/** Raw Ed25519 public key bytes (32) from a Node KeyObject, via JWK export. */
function rawEd25519PublicKeyBytes(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { crv?: string; x?: string };
  assert.equal(jwk.crv, 'Ed25519');
  assert.ok(jwk.x);
  return Buffer.from(jwk.x, 'base64url');
}

function expectOk(result: RunResult, context: string): void {
  assert.equal(result.status, 0, `${context}: ${result.stdout}${result.stderr}`);
}

function expectFail(result: RunResult, pattern: RegExp, context: string): void {
  assert.notEqual(result.status, 0, `${context}: expected non-zero exit`);
  assert.match(result.stdout + result.stderr, pattern, context);
}

describe('ff1 verify/validate/sign CLI integration', () => {
  test('verify and validate accept the v1.1.0 sample playlist example', () => {
    const dir = makeWorkspace();
    try {
      writeSigningConfig(dir);
      const sampleV11 = copyExample(dir, 'sample-playlist-v11.json', 'sample-v11.json');
      const signedV11 = join(dir, 'sample-v11-signed.json');
      const sign = runCli(dir, ['sign', sampleV11, '-o', signedV11]);
      expectOk(sign, 'sign sample v1.1.0 example');

      const verify = runCli(dir, ['verify', signedV11]);
      expectOk(verify, 'verify sample v1.1.0 example');
      assert.match(verify.stdout, /Playlist is valid/i);
      assert.match(verify.stdout, /DP Version: 1\.1\.0/i);

      const validate = runCli(dir, ['validate', signedV11]);
      expectOk(validate, 'validate sample v1.1.0 example');
      assert.match(validate.stdout, /Playlist is valid/i);
      assert.match(validate.stdout, /DP Version: 1\.1\.0/i);
    } finally {
      cleanup(dir);
    }
  });

  test('verify and validate accept the documented valid playlist fixtures', () => {
    const dir = makeWorkspace();
    try {
      writeSigningConfig(dir);
      const unsignedV11 = copyExample(dir, 'sample-playlist-v11.json', 'unsigned-v11.json');
      const signedV11 = join(dir, 'signed-v11.json');
      const signV11 = runCli(dir, ['sign', unsignedV11, '-o', signedV11]);
      expectOk(signV11, 'sign sample v1.1.0 example');

      const verifySignedV11 = runCli(dir, ['verify', signedV11]);
      expectOk(verifySignedV11, 'verify signed v1.1.0');
      assert.match(verifySignedV11.stdout, /Playlist is valid/i);

      const validateSignedV11 = runCli(dir, ['validate', signedV11]);
      expectOk(validateSignedV11, 'validate signed v1.1.0');
      assert.match(validateSignedV11.stdout, /Playlist is valid/i);

      const tampered = JSON.parse(readFileSync(signedV11, 'utf-8')) as {
        signatures?: Array<{ sig?: string }>;
      };
      assert.ok(Array.isArray(tampered.signatures) && tampered.signatures.length > 0);
      tampered.signatures![0].sig = 'AAAA';
      writeFileSync(signedV11, JSON.stringify(tampered, null, 2), 'utf-8');

      const verifyTampered = runCli(dir, ['verify', signedV11]);
      expectFail(
        verifyTampered,
        /signature verification failed|invalid/i,
        'verify tampered v1.1.0'
      );
    } finally {
      cleanup(dir);
    }
  });

  test('validate accepts unsigned open playlists and sign can promote them into envelopes', () => {
    const dir = makeWorkspace();
    try {
      const unsigned = copyFixture(dir, 'validUnsignedOpenV11', 'unsigned.json');

      const validate = runCli(dir, ['validate', unsigned]);
      expectOk(validate, 'validate unsigned open');
      assert.match(validate.stdout, /Playlist is valid/i);

      const verify = runCli(dir, ['verify', unsigned]);
      expectFail(verify, /playlist signature verification failed/i, 'verify unsigned open');
      assert.match(verify.stdout, /Playlist signature verification failed/i);

      writeSigningConfig(dir);
      const output = join(dir, 'signed.json');
      const sign = runCli(dir, ['sign', unsigned, '-o', output]);
      expectOk(sign, 'sign unsigned open playlist');

      const signed = JSON.parse(readFileSync(output, 'utf-8')) as { signatures?: unknown[] };
      assert.ok(Array.isArray(signed.signatures), 'sign must write signatures[]');
      assert.ok((signed.signatures ?? []).length > 0, 'signatures[] must not be empty');
    } finally {
      cleanup(dir);
    }
  });

  const verifyFailureCases = [
    {
      name: 'missing file',
      fixture: undefined,
      path: 'missing.json',
      pattern: /not found/i,
    },
    {
      name: 'invalid json',
      fixture: 'invalidJson' as const,
      path: 'invalid-json.json',
      pattern: /Expected property name|invalid json|Input must be a valid JSON object/i,
    },
    {
      name: 'missing title',
      fixture: 'invalidMissingTitleV10' as const,
      path: 'invalid-missing-title-v10.json',
      pattern: /title: Required|invalid|validation failed/i,
    },
    {
      name: 'missing items',
      fixture: 'invalidMissingItems' as const,
      path: 'invalid-playlist-missing-items.json',
      pattern: /items|Required|validation failed/i,
    },
  ] as const;

  for (const testCase of verifyFailureCases) {
    test(`verify and validate reject ${testCase.name}`, () => {
      const dir = makeWorkspace();
      try {
        const playlistPath = testCase.fixture
          ? copyFixture(dir, testCase.fixture, testCase.path)
          : join(dir, testCase.path);
        if (!testCase.fixture) {
          // no-op, path intentionally missing
        }

        const verify = runCli(dir, ['verify', playlistPath]);
        expectFail(verify, testCase.pattern, `verify ${testCase.name}`);

        const validate = runCli(dir, ['validate', playlistPath]);
        expectFail(validate, testCase.pattern, `validate ${testCase.name}`);
      } finally {
        cleanup(dir);
      }
    });
  }

  test('verify rejects legacy signed playlist without a public key', () => {
    const dir = makeWorkspace();
    try {
      // Fixture ships with the repo; do not rely on optional example files under examples/.
      const playlist = copyFixture(dir, 'validSignedV10', 'legacy-signed-v10.json');
      const result = runCli(dir, ['verify', playlist]);

      expectFail(
        result,
        /Playlist signature verification failed|signature verification failed|invalid|verification failed/i,
        'verify legacy signed playlist without pubkey'
      );
      assert.match(result.stdout, /Playlist signature verification failed/i);
      assert.match(result.stdout, /legacy-signed-v10\.json/i);
    } finally {
      cleanup(dir);
    }
  });

  test('verify accepts a legacy signed playlist when --public-key is provided', () => {
    const dir = makeWorkspace();
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const privateKeyBase64 = privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64');
      const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
      const payload = {
        dpVersion: '1.0.0',
        id: 'd2d4f9b0-7f01-4c26-9c10-1c4d7477f5de',
        title: 'Legacy Signed',
        created: '2026-02-06T00:00:00.000Z',
        items: [
          {
            id: 'ad5de50a-6a0d-4b61-8ef9-7b0f0d1d5e9b',
            source: 'https://example.com/nft1.png',
            duration: 10,
            license: 'open',
            created: '2026-02-06T00:00:00.000Z',
          },
        ],
        defaults: {
          display: {
            scaling: 'fit',
            background: '#111111',
            margin: 0,
          },
          license: 'token',
          duration: 10,
        },
        slug: 'legacy-signed',
      };
      const signed = makeLegacySignedPlaylist(privateKeyBase64, publicKeyPem, payload);
      const playlist = copyFixture(dir, 'validSignedV10', 'legacy-signed-v10.json');
      writeFileSync(playlist, JSON.stringify(signed.playlist, null, 2), 'utf-8');

      const result = runCli(dir, ['verify', playlist, '--public-key', publicKeyPem]);

      expectOk(result, 'verify legacy signed playlist with public key');
      assert.match(result.stdout, /Playlist is valid/i);
      assert.match(result.stdout, /legacy-signed-v10\.json/i);
    } finally {
      cleanup(dir);
    }
  });

  test('verify accepts legacy signed playlist when --public-key is raw hex, 0x hex, or base64', () => {
    const dir = makeWorkspace();
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const privateKeyBase64 = privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64');
      const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
      const rawPub = rawEd25519PublicKeyBytes(publicKey);
      const keyVariants: Array<{ label: string; value: string }> = [
        { label: 'hex', value: rawPub.toString('hex') },
        { label: '0x hex', value: `0x${rawPub.toString('hex')}` },
        { label: 'base64', value: rawPub.toString('base64') },
      ];
      const payload = {
        dpVersion: '1.0.0',
        id: 'd2d4f9b0-7f01-4c26-9c10-1c4d7477f5de',
        title: 'Legacy Signed Key Formats',
        created: '2026-02-06T00:00:00.000Z',
        items: [
          {
            id: 'ad5de50a-6a0d-4b61-8ef9-7b0f0d1d5e9b',
            source: 'https://example.com/nft1.png',
            duration: 10,
            license: 'open',
            created: '2026-02-06T00:00:00.000Z',
          },
        ],
        defaults: {
          display: {
            scaling: 'fit',
            background: '#111111',
            margin: 0,
          },
          license: 'token',
          duration: 10,
        },
        slug: 'legacy-key-formats',
      };

      for (let i = 0; i < keyVariants.length; i++) {
        const signed = makeLegacySignedPlaylist(privateKeyBase64, publicKeyPem, payload);
        const playlistPath = join(dir, `legacy-keyfmt-${i}.json`);
        writeFileSync(playlistPath, JSON.stringify(signed.playlist, null, 2), 'utf-8');

        const result = runCli(dir, ['verify', playlistPath, '--public-key', keyVariants[i].value]);

        expectOk(result, `verify legacy with ${keyVariants[i].label} public key`);
        assert.match(result.stdout, /Playlist is valid/i);
      }
    } finally {
      cleanup(dir);
    }
  });

  test('verify derives the legacy public key from playlist.privateKey when --public-key is omitted', () => {
    const dir = makeWorkspace();
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const privateKeyBase64 = privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64');
      const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
      const playlist = {
        dpVersion: '1.0.0',
        id: 'd2d4f9b0-7f01-4c26-9c10-1c4d7477f5de',
        title: 'Legacy Config Signed',
        created: '2026-02-06T00:00:00.000Z',
        items: [
          {
            id: 'ad5de50a-6a0d-4b61-8ef9-7b0f0d1d5e9b',
            source: 'https://example.com/nft1.png',
            duration: 10,
            license: 'open',
            created: '2026-02-06T00:00:00.000Z',
          },
        ],
      };
      const signed = makeLegacySignedPlaylist(privateKeyBase64, publicKeyPem, playlist);
      const playlistPath = join(dir, 'legacy-config-signed.json');
      writeFileSync(playlistPath, JSON.stringify(signed.playlist, null, 2), 'utf-8');
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ playlist: { privateKey: privateKeyBase64 } }, null, 2),
        'utf-8'
      );

      const result = runCli(dir, ['verify', playlistPath]);

      expectOk(result, 'verify legacy playlist with derived config key');
      assert.match(result.stdout, /Playlist is valid/i);
      assert.match(result.stdout, /legacy-config-signed\.json/i);
    } finally {
      cleanup(dir);
    }
  });

  test('verify derives the legacy public key from PLAYLIST_PRIVATE_KEY when config is absent', () => {
    const dir = makeWorkspace();
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const privateKeyBase64 = privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64');
      const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
      const playlist = {
        dpVersion: '1.0.0',
        id: 'd2d4f9b0-7f01-4c26-9c10-1c4d7477f5de',
        title: 'Legacy Env Signed',
        created: '2026-02-06T00:00:00.000Z',
        items: [
          {
            id: 'ad5de50a-6a0d-4b61-8ef9-7b0f0d1d5e9b',
            source: 'https://example.com/nft1.png',
            duration: 10,
            license: 'open',
            created: '2026-02-06T00:00:00.000Z',
          },
        ],
      };
      const signed = makeLegacySignedPlaylist(privateKeyBase64, publicKeyPem, playlist);
      const playlistPath = join(dir, 'legacy-env-signed.json');
      writeFileSync(playlistPath, JSON.stringify(signed.playlist, null, 2), 'utf-8');

      const result = runCli(dir, ['verify', playlistPath], {
        PLAYLIST_PRIVATE_KEY: privateKeyBase64,
      });

      expectOk(result, 'verify legacy playlist with derived env key');
      assert.match(result.stdout, /Playlist is valid/i);
      assert.match(result.stdout, /legacy-env-signed\.json/i);
    } finally {
      cleanup(dir);
    }
  });

  test('sign writes a signatures envelope and the result still verifies', () => {
    const dir = makeWorkspace();
    try {
      writeSigningConfig(dir);
      const input = copyExample(dir, 'sample-playlist-v11.json', 'input.json');
      const output = join(dir, 'signed.json');

      const sign = runCli(dir, ['sign', input, '-o', output]);
      expectOk(sign, 'sign valid playlist');
      assert.match(sign.stdout, /Playlist signed/i);

      const signed = JSON.parse(readFileSync(output, 'utf-8')) as {
        signatures?: unknown[];
        signature?: unknown;
      };
      assert.ok(Array.isArray(signed.signatures), 'sign must write signatures[]');
      assert.equal(signed.signature, undefined, 'sign must not emit legacy signature field');
      assert.ok((signed.signatures ?? []).length > 0, 'signatures[] must not be empty');

      const verifySigned = runCli(dir, ['verify', output]);
      expectOk(verifySigned, 'verify signed output');
      assert.match(verifySigned.stdout, /Playlist is valid/i);
    } finally {
      cleanup(dir);
    }
  });

  test('sign CLI honors a --role override when writing signatures[]', () => {
    const dir = makeWorkspace();
    try {
      writeSigningConfig(dir);
      const input = copyFixture(dir, 'validUnsignedOpenV11', 'input-role.json');
      const output = join(dir, 'signed-role.json');

      const sign = runCli(dir, ['sign', input, '-o', output, '-r', 'feed']);
      expectOk(sign, 'sign with explicit role override');

      const signed = JSON.parse(readFileSync(output, 'utf-8')) as {
        signatures?: Array<{ role?: string }>;
      };
      assert.ok(Array.isArray(signed.signatures), 'sign must write signatures[]');
      assert.equal(signed.signatures?.at(-1)?.role, 'feed');
    } finally {
      cleanup(dir);
    }
  });

  test('sign CLI rejects an unsupported --role override', () => {
    const dir = makeWorkspace();
    try {
      writeSigningConfig(dir);
      const input = copyFixture(dir, 'validUnsignedOpenV11', 'input-invalid-role.json');

      const sign = runCli(dir, [
        'sign',
        input,
        '-o',
        join(dir, 'signed-invalid-role.json'),
        '-r',
        'owner',
      ]);
      expectFail(
        sign,
        /Unsupported DP-1 playlist signing role "owner"/,
        'sign invalid role override'
      );
    } finally {
      cleanup(dir);
    }
  });

  test('sign produces verifiable v1.1.0 signatures[] from an unsigned dpVersion 1.0.0 fixture', () => {
    const dir = makeWorkspace();
    try {
      writeSigningConfig(dir);
      const input = copyFixture(dir, 'validUnsignedV10', 'unsigned-v10.json');
      const output = join(dir, 'signed-from-v10.json');

      const sign = runCli(dir, ['sign', input, '-o', output]);
      expectOk(sign, 'sign dpVersion 1.0.0 playlist');

      const signed = JSON.parse(readFileSync(output, 'utf-8')) as {
        dpVersion?: string;
        signatures?: unknown[];
        signature?: unknown;
      };
      assert.ok(Array.isArray(signed.signatures), 'sign must write signatures[]');
      assert.equal(signed.signature, undefined, 'sign must not emit legacy signature field');
      assert.ok((signed.signatures ?? []).length > 0, 'signatures[] must not be empty');

      const verifySigned = runCli(dir, ['verify', output]);
      expectOk(verifySigned, 'verify playlist signed from v1.0.0 unsigned fixture');
      assert.match(verifySigned.stdout, /Playlist is valid/i);
    } finally {
      cleanup(dir);
    }
  });

  test('verify CLI accepts valid v1.1 signatures[] without --public-key', async () => {
    const dir = makeWorkspace();
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const pkB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

      const base = v11UnsignedPlaylistEnvelope();
      const sig = await signPlaylist(base, pkB64);
      const signed = { ...base, signatures: [sig] };

      const pathFile = join(dir, 'cli-v11-multisig.json');
      writeFileSync(pathFile, JSON.stringify(signed, null, 2), 'utf-8');

      const result = runCli(dir, ['verify', pathFile]);
      expectOk(result, 'verify v1.1 multisig omit public key');
      assert.match(result.stdout, /Playlist is valid/i);
      assert.match(result.stdout, /Signatures: 1/i);
    } finally {
      cleanup(dir);
    }
  });

  test('verify CLI accepts valid v1.1 signatures[] with malformed --public-key (stderr warns)', async () => {
    const dir = makeWorkspace();
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const pkB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

      const base = v11UnsignedPlaylistEnvelope();
      const sig = await signPlaylist(base, pkB64);
      const signed = { ...base, signatures: [sig] };

      const pathFile = join(dir, 'cli-v11-multisig-bad-arg.json');
      writeFileSync(pathFile, JSON.stringify(signed, null, 2), 'utf-8');

      const result = runCli(dir, ['verify', pathFile, '--public-key', 'not-a-valid-pem']);
      expectOk(result, 'verify v1.1 multisig with bad --public-key');
      assert.match(result.stdout, /Playlist is valid/i);
      assert.match(result.stderr, /Could not normalize public key for dp1-js/i);
    } finally {
      cleanup(dir);
    }
  });

  const signFailureCases = [
    {
      name: 'missing file',
      setup: (_dir: string) => undefined,
      input: 'missing.json',
      expect: /not found/i,
    },
    {
      name: 'invalid json',
      setup: (dir: string) => copyFixture(dir, 'invalidJson', 'invalid-json.json'),
      input: 'invalid-json.json',
      expect: /Expected property name|invalid json|Input must be a valid JSON object/i,
    },
    {
      name: 'invalid playlist',
      setup: (dir: string) => copyFixture(dir, 'invalidMissingTitleV10', 'invalid.json'),
      input: 'invalid.json',
      expect: /Playlist validation failed|validation failed|invalid|title|required/i,
    },
    {
      name: 'missing signing key',
      setup: (dir: string) => copyExample(dir, 'sample-playlist-v11.json', 'unsigned.json'),
      input: 'unsigned.json',
      env: { PLAYLIST_PRIVATE_KEY: '' },
      expect: /private key/i,
    },
  ] as const;

  for (const testCase of signFailureCases) {
    test(`sign rejects ${testCase.name}`, () => {
      const dir = makeWorkspace();
      try {
        writeSigningConfig(dir);
        const inputPath = join(dir, testCase.input);
        testCase.setup(dir);

        if (testCase.name === 'missing signing key') {
          rmSync(join(dir, 'config.json'), { force: true });
        }

        const sign = runCli(dir, ['sign', inputPath, '-o', join(dir, 'signed.json')], {
          ...('env' in testCase ? testCase.env : {}),
        });
        expectFail(sign, testCase.expect, `sign ${testCase.name}`);
      } finally {
        cleanup(dir);
      }
    });
  }
});
