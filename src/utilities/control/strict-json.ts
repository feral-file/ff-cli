/**
 * Strict JSON and base64url decoding for the FF1 control protocol v1
 * (ffos-user docs/ff1-control-v1.md §1).
 *
 * Why this exists instead of `JSON.parse`: two implementations that disagree
 * about what a byte string means (which of two duplicate `kid` members wins,
 * whether `1.0` is the integer 1) are a signature-confusion bug. `JSON.parse`
 * silently keeps the LAST duplicate and erases the difference between `1`,
 * `1.0` and `1e0`, so every header, claims object and JWK that crosses the
 * trust boundary is parsed here instead. The Go reference (control/json.go)
 * applies the same rules; keep the two in step.
 */

/** ControlFormatError is thrown for every malformed protocol object. */
export class ControlFormatError extends Error {
  constructor(message: string) {
    super(`ff1-control: ${message}`);
    this.name = 'ControlFormatError';
  }
}

/** MAX_SAFE_CLAIM_INT is 2^53-1, the integer ceiling of §1. */
const MAX_SAFE_CLAIM_INT = Number.MAX_SAFE_INTEGER;

/** MAX_JSON_DEPTH bounds nesting, matching the Go reference's maxJSONDepth. */
const MAX_JSON_DEPTH = 128;

/**
 * rawNumbers remembers the exact source text of every number member of every
 * parsed object, so integer claims can be checked for canonical form after
 * parsing (JSON.parse-style values cannot tell `1` from `1.0`).
 */
const rawNumbers = new WeakMap<object, Map<string, string>>();

const B64U_ALPHABET = /^[A-Za-z0-9_-]*$/;

/**
 * b64uDecode decodes unpadded base64url strictly: `=` padding, whitespace,
 * any non-alphabet byte and non-zero trailing bits are all rejected (§1). The
 * round-trip comparison is what catches non-canonical trailing bits, which
 * Node's lenient decoder would otherwise accept.
 *
 * @param value - Candidate base64url text
 * @returns The decoded bytes
 * @throws {ControlFormatError} When the text is not canonical base64url
 */
export function b64uDecode(value: string): Uint8Array {
  if (typeof value !== 'string' || !B64U_ALPHABET.test(value) || value.length % 4 === 1) {
    throw new ControlFormatError('invalid base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    throw new ControlFormatError('non-canonical base64url');
  }
  return new Uint8Array(bytes);
}

/**
 * b64uEncode encodes bytes as unpadded base64url.
 *
 * @param bytes - Bytes or UTF-8 text to encode
 * @returns Unpadded base64url text
 */
export function b64uEncode(bytes: Uint8Array | string): string {
  return Buffer.from(bytes as Uint8Array).toString('base64url');
}

/**
 * isB64uOfLength reports whether value is canonical base64url of exactly n bytes.
 *
 * @param value - Candidate value
 * @param n - Required decoded length
 * @returns True when the value decodes to exactly n bytes
 */
export function isB64uOfLength(value: unknown, n: number): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return b64uDecode(value).length === n;
  } catch {
    return false;
  }
}

/**
 * utf8Decode decodes bytes as UTF-8, rejecting invalid sequences (§1). A
 * lenient decoder would map them to U+FFFD and let two different byte strings
 * read as the same JSON.
 *
 * @param bytes - Raw bytes
 * @returns The decoded string
 * @throws {ControlFormatError} On invalid UTF-8
 */
export function utf8Decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ControlFormatError('invalid UTF-8');
  }
}

/** StrictParser is a small recursive-descent JSON parser with duplicate-key detection. */
class StrictParser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseDocument(): unknown {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      throw new ControlFormatError('trailing data after JSON value');
    }
    return value;
  }

  private fail(message: string): never {
    throw new ControlFormatError(`invalid JSON at ${this.pos}: ${message}`);
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length && ' \t\r\n'.includes(this.text[this.pos])) {
      this.pos += 1;
    }
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) {
      this.fail('nested too deeply');
    }
    this.skipWhitespace();
    const ch = this.text[this.pos];
    if (ch === '{') {
      return this.parseObject(depth);
    }
    if (ch === '[') {
      return this.parseArray(depth);
    }
    if (ch === '"') {
      return this.parseString();
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      return Number(this.parseNumberText());
    }
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.text.startsWith(literal, this.pos)) {
        this.pos += literal.length;
        return value;
      }
    }
    return this.fail('unexpected token');
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.pos += 1;
    // A null-prototype object keeps a member named "__proto__" an ordinary
    // member instead of a prototype assignment.
    const out = Object.create(null) as Record<string, unknown>;
    const numbers = new Map<string, string>();
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      rawNumbers.set(out, numbers);
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') {
        this.fail('object key is not a string');
      }
      // Keys are compared after unescaping, so "typ" and "typ" collide.
      const key = this.parseString();
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        this.fail(`duplicate member ${JSON.stringify(key)}`);
      }
      this.skipWhitespace();
      if (this.text[this.pos] !== ':') {
        this.fail('expected ":"');
      }
      this.pos += 1;
      this.skipWhitespace();
      const start = this.pos;
      out[key] = this.parseValue(depth + 1);
      if (typeof out[key] === 'number') {
        numbers.set(key, this.text.slice(start, this.pos));
      }
      this.skipWhitespace();
      const sep = this.text[this.pos];
      this.pos += 1;
      if (sep === '}') {
        rawNumbers.set(out, numbers);
        return out;
      }
      if (sep !== ',') {
        this.fail('expected "," or "}"');
      }
    }
  }

  private parseArray(depth: number): unknown[] {
    this.pos += 1;
    const out: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      out.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const sep = this.text[this.pos];
      this.pos += 1;
      if (sep === ']') {
        return out;
      }
      if (sep !== ',') {
        this.fail('expected "," or "]"');
      }
    }
  }

  private parseString(): string {
    const start = this.pos;
    this.pos += 1;
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) {
        this.fail('unterminated string');
      }
      if (ch === '"') {
        this.pos += 1;
        break;
      }
      if (ch === '\\') {
        this.pos += 2;
        continue;
      }
      if (ch < ' ') {
        this.fail('control character in string');
      }
      this.pos += 1;
    }
    // The span is grammar-checked by JSON.parse, which also unescapes it.
    try {
      return JSON.parse(this.text.slice(start, this.pos)) as string;
    } catch {
      return this.fail('invalid string escape');
    }
  }

  private parseNumberText(): string {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (!match) {
      this.fail('invalid number');
    }
    this.pos += match[0].length;
    return match[0];
  }
}

/**
 * parseStrictJson parses UTF-8 JSON text with the §1 rules: one value, no
 * trailing data, no duplicate member names at any depth.
 *
 * @param input - JSON text or raw UTF-8 bytes
 * @returns The parsed value; objects have a null prototype
 * @throws {ControlFormatError} On any violation
 */
export function parseStrictJson(input: string | Uint8Array): unknown {
  const text = typeof input === 'string' ? input : utf8Decode(input);
  return new StrictParser(text).parseDocument();
}

/**
 * isPlainObject reports whether value is a parsed JSON object (not an array or null).
 *
 * @param value - Candidate value
 * @returns True for JSON objects
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * strictObject requires value to be an object whose member names are all in
 * required ∪ optional, with every required member present (§1 closed sets).
 *
 * @param value - Parsed JSON value
 * @param required - Members that must be present
 * @param optional - Members that may be present
 * @param what - Name used in error messages
 * @returns The object, typed as a record
 * @throws {ControlFormatError} On any extra or missing member
 */
export function strictObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  what: string
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ControlFormatError(`${what} is not a JSON object`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new ControlFormatError(`${what} has unexpected member ${JSON.stringify(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new ControlFormatError(`${what} is missing member ${JSON.stringify(key)}`);
    }
  }
  return value;
}

/**
 * stringMember returns a required string member.
 *
 * @param obj - Parsed object
 * @param key - Member name
 * @returns The string value
 * @throws {ControlFormatError} When the member is absent or not a string
 */
export function stringMember(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new ControlFormatError(`member ${JSON.stringify(key)} is not a string`);
  }
  return value;
}

/**
 * uintMember returns a canonical non-negative integer member in [0, 2^53-1].
 * `1.0`, `1e3`, `-0`, `01` and quoted numbers are rejected (§1): the Dart,
 * JS and Go encoders never produce them, so seeing one means a hand-built or
 * hostile object. Only objects produced by parseStrictJson can be checked.
 *
 * @param obj - Object returned by parseStrictJson
 * @param key - Member name
 * @returns The integer value
 * @throws {ControlFormatError} When absent, non-canonical or out of range
 */
export function uintMember(obj: Record<string, unknown>, key: string): number {
  const raw = rawNumbers.get(obj)?.get(key);
  if (raw === undefined || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new ControlFormatError(`member ${JSON.stringify(key)} is not a canonical integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_SAFE_CLAIM_INT) {
    throw new ControlFormatError(`member ${JSON.stringify(key)} is out of range`);
  }
  return value;
}

/**
 * boolMember returns a required boolean member.
 *
 * @param obj - Parsed object
 * @param key - Member name
 * @returns The boolean value
 * @throws {ControlFormatError} When absent or not a boolean
 */
export function boolMember(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    throw new ControlFormatError(`member ${JSON.stringify(key)} is not a boolean`);
  }
  return value;
}

/**
 * toPlainJson deep-copies a parsed value onto ordinary prototypes so callers
 * outside the codec (printing, deepEqual in tests) see normal objects.
 *
 * @param value - Value from parseStrictJson
 * @returns Equivalent value with ordinary object prototypes
 */
export function toPlainJson<T = unknown>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
