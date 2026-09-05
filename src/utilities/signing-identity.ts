/**
 * The `did:key` a signature from the configured playlist key will carry as its `kid`.
 *
 * The feed authorizes a create by matching a signature's `kid` against a key the document declares in
 * `curators[]`. Until now that value existed nowhere a user could see: it appeared for the first time
 * *inside* a signature, so learning it meant signing something first. That made the only correct
 * publishing sequence — declare the curator, then sign — impossible to follow, and the obvious
 * workaround is broken: signing appends to `signatures[]`, so signing to discover the kid, adding
 * `curators[]`, then signing again leaves the first signature covering a document that no longer exists,
 * and verification fails before upload.
 */

import { createPublicKey } from 'node:crypto';
import { parsePlaylistPrivateKeyToKeyObject } from './ed25519-key-derive';

/**
 * Derive the `did:key` for playlist signing key material.
 *
 * Accepts everything the signer accepts (PKCS#8 base64, raw seed hex/base64, PEM), because a user who
 * can sign with a key must be able to see the identity that signing will assert.
 */
export function playlistSigningDidKey(privateKeyMaterial: string): string {
  const privateKey = parsePlaylistPrivateKeyToKeyObject(privateKeyMaterial);
  const raw = createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string };
  if (!raw.x) {
    throw new Error('Could not derive a public key from the configured playlist signing key');
  }
  // JWK `x` for Ed25519 is the 32-byte public key, base64url.
  const publicKey = Buffer.from(raw.x, 'base64url');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Ed25519DIDKey } = require('dp1-js');
  return Ed25519DIDKey(publicKey);
}
