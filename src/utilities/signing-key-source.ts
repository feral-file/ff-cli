/**
 * Where an explicit signing key came from: `--key` on the command line, or `--key-file` on disk.
 *
 * `--key` puts a private key in two places nobody chose to put it: the shell history file, and the
 * process list, where any local user can read it for as long as the command runs. Neither is something
 * the operator can take back afterwards, and an Ed25519 signing key that has been disclosed is not
 * repairable — the identity it asserts is the identity, and a playlist's owner set is immutable. So
 * every command that accepts `--key` also accepts `--key-file <path>`, which reads the same material
 * from a file the operator controls.
 *
 * The two flags are mutually exclusive rather than ordered. A precedence rule would have to pick a
 * winner when they disagree, and the loser is silently ignored — which is exactly the class of failure
 * the empty-`--key` fix removed: a key the operator believes was used and was not.
 *
 * Reading the file is deliberately *not* gated on its permissions. A mode check would refuse work on
 * key files that are perfectly appropriate — a file inside a per-user directory, a path on a tmpfs
 * mounted for one user, a Windows ACL the mode bits cannot describe — and it would still not prove the
 * file is private, because the directory above it decides who can reach the name at all. The
 * documentation says to keep the file private; the CLI does not pretend to be able to check it.
 */

import { readFileSync } from 'node:fs';

/** The flag an explicit key arrived on. Also used verbatim in refusals, so it names what to retype. */
export type SigningKeyFlag = '--key' | '--key-file';

/** An explicit key and the flag that carried it. */
export interface ExplicitSigningKey {
  /** Key material, in any encoding the signer's normalization accepts. */
  material: string;
  /** Which flag supplied it. */
  flag: SigningKeyFlag;
}

/** Options object shape the four key-taking commands share. */
export interface SigningKeyOptions {
  key?: string;
  keyFile?: string;
}

/**
 * Which key flag the command was given, without reading anything.
 *
 * Split out from the resolution below so a command that is going to *refuse* an explicit key — a plain
 * `publish` signs nothing at request time — can name the flag the operator actually typed without
 * opening their key file to do it.
 *
 * Presence, never truthiness: `--key ""` and `--key-file ""` are both what an unset shell variable
 * expands to, and both are overrides that failed rather than overrides that are absent.
 *
 * @param options - The command's parsed options
 * @returns The flag used, or `undefined` when neither was given
 * @throws Error when both flags are present
 */
export function explicitSigningKeyFlag(options: SigningKeyOptions): SigningKeyFlag | undefined {
  const hasKey = options.key !== undefined;
  const hasKeyFile = options.keyFile !== undefined;
  if (hasKey && hasKeyFile) {
    throw new Error(
      '--key and --key-file both name a signing key, and nothing here can tell which one you meant. ' +
        'Pass exactly one: --key for material on the command line, --key-file for a path to read it from.'
    );
  }
  if (hasKeyFile) {
    return '--key-file';
  }
  return hasKey ? '--key' : undefined;
}

/**
 * Read key material out of a key file.
 *
 * The contents are trimmed, so a file written by `printf`, by an editor that appends a newline, or by a
 * password manager's export all behave the same. What comes back then goes through the *same*
 * normalization `--key` does — base64 PKCS#8 DER, a 32-byte seed as hex or base64, or PEM — because a
 * key file is a delivery mechanism, not a second key format.
 *
 * An empty or whitespace-only file is rejected here rather than passed on. Every other outcome would be
 * a silent fallback to the configured key: `sign` and the feed mutations would refuse an empty `--key`
 * with a message about shell expansion that is wrong for a file, and `status` would quietly report the
 * configured identity as though it were the file's. That fallback is the bug the empty-`--key` fix
 * removed, and it is worse from a file, because a file that reads as empty (truncated, still being
 * written, the wrong path in a directory of similar names) looks nothing like a typo at the prompt.
 *
 * Every argument is opened. Deciding in advance that something "looks like a key" and refusing to try
 * cost real paths — `/run/BEGIN/secrets/owner.key`, a content-addressed 64-hex filename — and bought
 * nothing, because opening a wrong path is free. What is not free is *printing* one: a private key
 * that reaches a terminal is in scrollback and in whatever ships those logs onward, and it cannot be
 * rotated out of a document that already names it. So the guarantee lives entirely in what may be said
 * about a failure; see `safePathLabel`. Existence is also the only thing separating a key typed into
 * the path from a file genuinely named after a hex digest, and that cannot be known without looking.
 *
 * @param path - Value of `--key-file` exactly as the command received it
 * @returns Trimmed key material
 * @throws Error when the path is empty, cannot be read, or holds no key material
 */
export function readSigningKeyFile(path: string): string {
  if (path.trim().length === 0) {
    throw new Error(
      'The --key-file path is empty. This usually means a shell variable did not expand (for example ' +
        '--key-file "$KEY_PATH" with KEY_PATH unset). Refusing rather than falling back to the ' +
        'configured key, which would sign under an identity you did not choose.'
    );
  }

  // The path is used exactly as given, NOT trimmed. Trimming was only ever a convenience, and it is
  // the wrong one here: it silently opens `owner.key` for `--key-file "owner.key "`, so a file that
  // is not the one named decides what signs. The trim above answers a different question — whether
  // anything was passed at all.
  let contents: string;
  try {
    contents = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new Error(describeKeyFileReadFailure(path, error));
  }

  const material = contents.trim();
  if (material.length === 0) {
    throw new Error(
      `The key file at ${safePathLabel(path)} holds no key material. Refusing rather than falling ` +
        'back to the configured key: a signature made under an identity you did not choose is not ' +
        'something a publish or a delete can be taken back from.'
    );
  }
  return material;
}

/**
 * Whether a value is, on its own, a complete Ed25519 key encoding.
 *
 * Complete is the whole point. An earlier version treated any `BEGIN` substring and any key-shaped
 * last segment as reason enough to refuse before opening, which made `/run/BEGIN/secrets/owner.key`
 * and a content-addressed 64-hex filename unusable — real paths, refused for looking like something
 * they were not, with no way to say otherwise. The shapes below are the forms a whole key takes and
 * nothing else: a PEM block carries both its header AND the line breaks a real block has, a hex seed
 * is 64 characters of nothing but hex, and base64 is judged by what it decodes to.
 */
function isWholeKeyEncoding(value: string): boolean {
  if (value.includes('BEGIN') && /[\r\n]/.test(value)) {
    return true;
  }
  if (/^(0x)?[0-9a-fA-F]{64,}$/.test(value)) {
    return true;
  }
  // Decided by DECODED LENGTH rather than by charset alone: `/` and `+` are legal base64 and most
  // real PKCS#8 keys contain a `/`, so a charset test that read that as a directory separator would
  // let the common case through. 32 bytes is a raw Ed25519 seed; 48 is PKCS#8 for one.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const decodedLength = Buffer.from(value, 'base64').length;
    if (decodedLength === 32 || decodedLength === 48) {
      return true;
    }
  }
  return false;
}

/** Whether the argument is a bare key: a complete encoding with no path structure around it. */
function isBareKeyMaterial(value: string): boolean {
  return !/[/\\]/.test(value) && isWholeKeyEncoding(value);
}

/** Whether any path segment is a complete key encoding — a key with a directory prefix on it. */
function anySegmentIsKeyEncoding(value: string): boolean {
  return value.split(/[/\\]/).some((segment) => isWholeKeyEncoding(segment));
}

/**
 * How to refer to a `--key-file` argument in a message, without ever printing key material.
 *
 * This is the guarantee, and it is deliberately separate from the decision to open. Opening a wrong
 * path costs nothing; printing one can disclose a private key that cannot be rotated out of a document
 * that already names it. So everything is opened, and this decides what may be said afterwards.
 *
 * Length carries most of it: no complete key encoding is under 40 characters — a 32-byte seed is 64
 * hex or 44 base64 characters — so a short argument cannot be a whole key, and a partial one is not a
 * key. The segment test then covers a key wearing a directory prefix, which length alone would pass
 * only for something already too long to print.
 *
 * @param path - Value of `--key-file` exactly as the command received it
 * @returns The path itself when it is provably safe to print, or a description of it
 */
function safePathLabel(path: string): string {
  const value = path.trim();
  if (value.length < 40 && !anySegmentIsKeyEncoding(value)) {
    return path;
  }
  return 'the path given (not repeated here, in case it is key material)';
}

/**
 * Turn a read failure into a sentence that says what to do about it.
 *
 * The raw errno text ("EISDIR: illegal operation on a directory, read") reads like a bug in the CLI
 * rather than a wrong path, and it is the same three mistakes every time: the file is not there, it is
 * not readable, or the path names a directory.
 *
 * The underlying `Error.message` is never interpolated — only its `code`. Node builds that message by
 * appending the path it was given, so passing it through would echo the argument a second time, in a
 * form no caller here controls.
 */
function describeKeyFileReadFailure(path: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const value = path.trim();

  // A bare, complete key with nothing of a path about it, and no file of that name. `--key-file
  // "$SIGNING_KEY"` is one keystroke from `--key "$SIGNING_KEY"`, and it is the natural typo for
  // someone moving off `--key`, so say what the mistake was. Existence is what separates this from a
  // file someone genuinely named after a hex digest — which is why the open is attempted first rather
  // than guessed at.
  if (isBareKeyMaterial(value)) {
    return (
      'The --key-file argument looks like a key rather than a path, and no file of that name exists. ' +
      'It is not repeated here. Point --key-file at the file that holds the key, or pass the key ' +
      'itself with --key.'
    );
  }

  const label = safePathLabel(path);

  // When the argument cannot be printed, the errno is the whole message. Naming which failure it was
  // is still worth saying — "there is nothing there" and "you may not read it" send an operator to
  // different places — but nothing about the value itself may appear.
  if (label !== path) {
    return (
      `The --key-file argument could not be read (${code ?? 'read failed'}) and is not repeated ` +
      'here: it may be key material rather than a path. Check the path you passed.'
    );
  }

  if (code === 'ENOENT') {
    return `No key file at ${label}.`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `Cannot read the key file at ${label}: permission denied (${code}).`;
  }
  if (code === 'EISDIR') {
    return `${label} is a directory, not a key file.`;
  }
  return `Cannot read the key file at ${label} (${code ?? 'read failed'}).`;
}

/**
 * Resolve the explicit signing key a command was given, from either flag.
 *
 * Commands call this before anything else — before a feed is chosen, before a playlist is looked up,
 * before a destructive action is confirmed — so an unreadable file fails while the only thing it can
 * cost is the run itself.
 *
 * `--key` material is returned exactly as typed, including when it is empty: the commands already
 * refuse an empty `--key` with a message about shell expansion, and that message is the right one for
 * a value that came from the command line.
 *
 * @param options - The command's parsed options
 * @returns The explicit key and its flag, or `undefined` when neither flag was given
 * @throws Error when both flags are present, or when a key file cannot be read or is empty
 */
export function resolveExplicitSigningKey(
  options: SigningKeyOptions
): ExplicitSigningKey | undefined {
  const flag = explicitSigningKeyFlag(options);
  if (flag === undefined) {
    return undefined;
  }
  if (flag === '--key-file') {
    return { material: readSigningKeyFile(options.keyFile as string), flag };
  }
  return { material: options.key as string, flag };
}
