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
 * The material never appears in any error raised here. A key that reaches a terminal is in scrollback
 * and in whatever ships those logs onward, so the path is named and the contents never are.
 *
 * @param path - Value of `--key-file` exactly as the command received it
 * @returns Trimmed key material
 * @throws Error when the path is empty, the file cannot be read, or it holds no key material
 */
export function readSigningKeyFile(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length === 0) {
    throw new Error(
      'The --key-file path is empty. This usually means a shell variable did not expand (for example ' +
        '--key-file "$KEY_PATH" with KEY_PATH unset). Refusing rather than falling back to the ' +
        'configured key, which would sign under an identity you did not choose.'
    );
  }

  let contents: string;
  try {
    contents = readFileSync(trimmedPath, 'utf-8');
  } catch (error) {
    throw new Error(describeKeyFileReadFailure(trimmedPath, error));
  }

  const material = contents.trim();
  if (material.length === 0) {
    throw new Error(
      `The key file at ${trimmedPath} holds no key material. Refusing rather than falling back to the ` +
        'configured key: a signature made under an identity you did not choose is not something a ' +
        'publish or a delete can be taken back from.'
    );
  }
  return material;
}

/**
 * Turn a read failure into a sentence that says what to do about it.
 *
 * The raw errno text ("EISDIR: illegal operation on a directory, read") reads like a bug in the CLI
 * rather than a wrong path, and it is the same three mistakes every time: the file is not there, it is
 * not readable, or the path names a directory.
 */
function describeKeyFileReadFailure(path: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return `No key file at ${path}.`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `Cannot read the key file at ${path}: permission denied.`;
  }
  if (code === 'EISDIR') {
    return `${path} is a directory, not a key file.`;
  }
  return `Cannot read the key file at ${path}: ${(error as Error).message}`;
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
