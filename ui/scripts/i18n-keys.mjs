// Lists the texts passed to t('...') in src/ and checks that src/i18n/zh.ts has a Chinese text for each of them.
// Usage: node scripts/i18n-keys.mjs [--list]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') && !p.includes('mocks') && !p.endsWith('zh.ts')) files.push(p);
  }
})(root);

const used = new Set();
const call = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(call)) used.add((m[1] ?? m[2]).replace(/\\'/g, "'"));
}

const zhText = readFileSync(join(root, 'i18n', 'zh.ts'), 'utf8');
const have = new Set();
for (const m of zhText.matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:/gm)) have.add((m[1] ?? m[2]).replace(/\\'/g, "'"));

if (process.argv.includes('--list')) console.log([...used].sort().join('\n'));
const missing = [...used].filter(k => !have.has(k)).sort();
const unused = [...have].filter(k => !used.has(k)).sort();
if (unused.length) console.log(`unused in zh.ts (${unused.length}):\n  ` + unused.join('\n  '));
if (missing.length) { console.log(`missing in zh.ts (${missing.length}):\n  ` + missing.join('\n  ')); process.exit(1); }
console.log(`i18n ok: ${used.size} texts`);
