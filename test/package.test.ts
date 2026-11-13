import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('package: the files list carries what the built code reads at run time, and packing builds it', () => {
  // dist/ is the code; the rest is read beside it (../../templates, ../../plugins, ../../ui/dist, and the intake prompt names docs/, schema/, examples/).
  for (const folder of ['bin/', 'dist/', 'plugins/', 'templates/', 'schema/', 'docs/', 'examples/', 'ui/dist/']) assert.ok(pkg.files.includes(folder), folder);
  assert.ok(!pkg.files.some((f: string) => f.startsWith('src') || f.startsWith('test')), 'sources and tests stay out of the package');
  assert.equal(pkg.bin.alba, 'bin/alba.mjs');
  assert.equal(pkg.scripts.prepack, 'node scripts/build.mjs');
  // Helper scripts beside the sources are copied by the build (.mjs and .ps1); any other kind would be left out.
  const kinds = new Set<string>();
  const walk = (dir: string): void => { for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(path.join(dir, e.name)) : kinds.add(e.name.replace(/^[^.]*/, '')); };
  walk(path.join(root, 'src'));
  assert.deepEqual([...kinds].filter(k => !['.ts', '.mjs', '.ps1', '.d.mts'].includes(k)), []);
});

test('package: the built JavaScript runs through bin/alba.mjs when there is no src/ (as under node_modules)', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'alba-package-'));
  execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--out', path.join(out, 'dist')], { cwd: root, stdio: 'pipe' });
  for (const helper of ['run/environment.mjs', 'run/capture.mjs', 'workers/adapters/remote-run.mjs', 'workers/adapters/remote-run.ps1']) assert.ok(existsSync(path.join(out, 'dist', helper)), helper);
  const main = readFileSync(path.join(out, 'dist/cli/main.js'), 'utf8');
  assert.doesNotMatch(main, /from ["']\.{1,2}\/[^"']*\.ts["']/, 'relative imports point at .js files');
  mkdirSync(path.join(out, 'bin'));
  copyFileSync(path.join(root, 'bin/alba.mjs'), path.join(out, 'bin/alba.mjs'));
  copyFileSync(path.join(root, 'package.json'), path.join(out, 'package.json'));
  // The one runtime dependency, as an installation would have it.
  mkdirSync(path.join(out, 'node_modules'));
  symlinkSync(realpathSync(path.join(root, 'node_modules/yaml')), path.join(out, 'node_modules/yaml'), 'junction');
  const help = execFileSync(process.execPath, [path.join(out, 'bin/alba.mjs'), '--help'], { cwd: out, encoding: 'utf8', env: { ...process.env, ALBA_LANG: 'en' } });
  assert.match(help, /Usage: alba \[--project <alba\.yaml>\] <command>/);
});
