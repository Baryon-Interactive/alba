// Builds what the npm package runs: src/**/*.ts compiled to dist/ (relative imports rewritten to .js), the helper scripts of
// src/ (.mjs, .ps1) copied next to them, and the console (ui/dist) when its dependencies are installed. A checkout needs none
// of this: bin/alba.mjs runs src/ directly. Runs on `npm pack` / `pnpm pack` (prepack) and by hand with `pnpm build`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (args, cwd = root) => {
  const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) { console.error(`build: ${args.join(' ')} failed`); process.exit(r.status ?? 1); }
};
const bin = (from, pkg, file) => path.join(path.dirname(createRequire(path.join(from, 'package.json')).resolve(`${pkg}/package.json`)), file);

// `--out <folder>` builds the code somewhere else (the tests do); the console is then not built.
const at = process.argv.indexOf('--out');
const dist = at > 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : path.join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
run([bin(root, 'typescript', 'bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', dist]);

let copied = 0;
const copy = (from, to) => {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copy(a, b);
    else if (/\.(?:mjs|ps1)$/.test(e.name)) { mkdirSync(to, { recursive: true }); copyFileSync(a, b); copied++; }
  }
};
copy(path.join(root, 'src'), dist);
console.log(`build: dist/ written (${copied} helper files copied)`);

const ui = path.join(root, 'ui');
if (at > 0 || process.env.ALBA_BUILD_UI === '0') console.log('build: console not built');
else if (existsSync(path.join(ui, 'node_modules', 'vite'))) {
  run([bin(ui, 'typescript', 'bin/tsc'), '-p', 'tsconfig.json'], ui);
  run([bin(ui, 'vite', 'bin/vite.js'), 'build'], ui);
} else console.warn(`build: ui/node_modules is missing, so the console (ui/dist) is ${existsSync(path.join(ui, 'dist')) ? 'packed as it is' : 'not in the package; `alba serve` then offers /legacy and /api only'}. Run pnpm install first.`);
