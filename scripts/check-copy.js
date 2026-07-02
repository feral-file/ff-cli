#!/usr/bin/env node
/*
 * check-copy.js — user-facing copy lint for ff-cli.
 *
 * Fails the build when banned spellings appear inside string / template
 * literals in src/. Approved terms and rationale live in Canon:
 *   reference/voice/product-copy.md
 *
 * It parses each file with the TypeScript compiler and inspects only real
 * string and template literals — so comments and JSDoc, where "DP1" is
 * legitimate internal shorthand (and apostrophes abound), are never
 * flagged. Internal debug logs (logger.*) are skipped: not user-facing.
 *
 * Cross-platform (runs on the Windows CI leg): pure Node, no shell.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// Boundaries exclude identifiers (buildDP1Playlist, DP1_FEED, connectedWifi)
// and the correct hyphenated forms (DP-1, Wi-Fi).
const BANNED = [
  { re: /(?<![A-Za-z0-9_-])WiFi(?![A-Za-z0-9_-])/, fix: 'Wi-Fi' },
  { re: /(?<![A-Za-z0-9_-])Wifi(?![A-Za-z0-9_-])/, fix: 'Wi-Fi' },
  { re: /(?<![A-Za-z0-9_-])wifi(?![A-Za-z0-9_-])/, fix: 'Wi-Fi' },
  { re: /(?<![A-Za-z0-9_-])DP1(?![A-Za-z0-9_-])/, fix: 'DP-1' },
  { re: /Device (?:Id|iD|id)(?![A-Za-z])/, fix: 'Device ID' },
  { re: /(?<![A-Za-z0-9_-])Feralfile(?![A-Za-z0-9_-])/, fix: 'Feral File' },
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      walk(full, out);
    } else if (/\.(ts|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
}

const files = [];
if (fs.existsSync(SRC)) {
  walk(SRC, files);
}
const indexTs = path.join(ROOT, 'index.ts');
if (fs.existsSync(indexTs)) {
  files.push(indexTs);
}

let violations = 0;

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const value = node.text; // literal contents, quotes/escapes resolved
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const lineText = text.split('\n')[line] || '';
      if (!/logger\.\w+\s*\(/.test(lineText)) {
        for (const { re, fix } of BANNED) {
          if (re.test(value)) {
            const rel = path.relative(ROOT, file);
            console.log(`  ${rel}:${line + 1}: "${value.trim()}"`);
            console.log(`    -> use: ${fix}`);
            violations++;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (violations > 0) {
  console.log(`\ncheck-copy: found ${violations} user-facing copy issue(s).`);
  console.log('See reference/voice/product-copy.md (Canon) for the approved terms.');
  process.exit(1);
}
console.log(`check-copy: user-facing copy OK (${files.length} file(s) scanned).`);
