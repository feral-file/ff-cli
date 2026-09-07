/**
 * Guards the module-resolution contract in tsconfig.json.
 *
 * The project compiles with `module: node20` + `moduleResolution: nodenext`
 * so TypeScript honours package `exports` maps. Two consequences of that mode
 * are easy to break silently and expensive to notice:
 *
 *  1. Dynamic `import()` is emitted verbatim instead of being downlevelled to
 *     `Promise.resolve().then(() => require(...))`. Node's ESM resolver has no
 *     extension search, so a relative `import('./x')` compiles cleanly but
 *     throws ERR_MODULE_NOT_FOUND at runtime. tsc only flags this in `.ts`
 *     files; the `.js` sources under `src/` are `checkJs: false`, so a missing
 *     extension there ships broken with a green build.
 *
 *  2. The old `baseUrl`/`paths` shim that pointed `ox` at `node_modules/ox/_types`
 *     existed only because the legacy node10 resolver ignored `exports`. Under
 *     an exports-aware resolver it is dead weight, and reintroducing `paths`
 *     would quietly re-hide the class of packaging bug it papered over.
 *
 * These assertions are cheap; the failure they prevent is a runtime crash in a
 * command that no unit test loads from `dist/`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

/**
 * readTsconfig parses tsconfig.json, which carries `//` comments (JSONC).
 * Stripping whole-line comments is enough for this file's shape and avoids
 * pulling a JSONC parser into the dependency tree for one test.
 */
function readTsconfig(): { compilerOptions: Record<string, unknown> } {
  const raw = readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8');
  const stripped = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(stripped);
}

/**
 * collectSourceFiles walks `src/` plus the root entrypoint and returns every
 * `.ts`/`.js` file tsc compiles, so the extension check covers the `.js`
 * sources that `checkJs: false` exempts from compiler diagnostics.
 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (name.endsWith('.ts') || name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

describe('tsconfig module resolution', () => {
  test('uses an exports-aware resolver', () => {
    const { compilerOptions } = readTsconfig();
    assert.equal(compilerOptions.module, 'node20');
    assert.equal(compilerOptions.moduleResolution, 'nodenext');
  });

  test('carries no ox path shim', () => {
    const { compilerOptions } = readTsconfig();
    assert.equal(compilerOptions.paths, undefined);
    assert.equal(compilerOptions.baseUrl, undefined);
  });
});

describe('dynamic imports', () => {
  test('every relative import() in compiled sources has an explicit extension', () => {
    const files = [...collectSourceFiles(join(repoRoot, 'src')), join(repoRoot, 'index.ts')];
    // Matches `import('./x')` / `import("../x")` and captures the specifier.
    // Bare specifiers (`import('dp1-js')`) are resolved through package
    // `exports` and correctly carry no extension.
    const dynamicImport = /\bimport\(\s*['"](\.[^'"]*)['"]\s*\)/g;
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(dynamicImport)) {
        const specifier = match[1];
        if (!/\.(js|json|cjs|mjs)$/.test(specifier)) {
          offenders.push(`${file.slice(repoRoot.length + 1)}: import('${specifier}')`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Relative dynamic imports need an explicit .js extension under nodenext resolution:\n${offenders.join('\n')}`
    );
  });
});
