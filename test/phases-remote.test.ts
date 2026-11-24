import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { verifierArgs } from '../src/review/independent.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { tempOrders } from './helpers.ts';

test('the SSH worker disables host MCP servers and returns a checkout check after the engine exits', () => {
  const { dir } = tempOrders();
  const cwd = path.join(dir, 'tree');
  mkdirSync(cwd);
  execFileSync('git', ['init', '-q', cwd]);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'Initial']);
  mkdirSync(path.join(dir, 'result'));
  for (const [source, dest] of [
    ['workers/adapters/remote-worker.mjs', 'worker.mjs'], ['workers/adapters/read-only.mjs', 'read-only.mjs'], ['run/environment.mjs', 'environment.mjs'],
  ]) copyFileSync(new URL('../src/' + source, import.meta.url), path.join(dir, dest));
  const fixture = path.join(dir, 'sample.cjs'), received = path.join(dir, 'received.json');
  writeFileSync(fixture, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args.includes('mcp')) console.log(JSON.stringify([{ name: 'sample.server' }]));",
    "else { fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(args)); if (process.env.MODIFY === 'yes') fs.writeFileSync('change.txt', 'changed'); }",
  ].join('\n'));
  const win = process.platform === 'win32';
  const program = path.join(dir, win ? 'sample.ps1' : 'sample');
  const quote = (s: string) => "'" + s.replaceAll("'", win ? "''" : "'\\''") + "'";
  writeFileSync(program, win ? `& ${quote(process.execPath)} ${quote(fixture)} @args\nexit $LASTEXITCODE\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`);
  if (!win) chmodSync(program, 0o700);
  const worker = validateWorkers({ workers: [{ id: 'reader', engine: 'codex-cli', launch: { program, args: ['exec', '{prompt_file}'] } }] }, 'workers.yaml').workers[0];
  for (const modify of ['no', 'yes']) {
    const spec = { worktree: cwd, program, args: verifierArgs(worker, cwd, 'Inspect', 'last.txt'), read_only: worker.engine, env: { ARGS_FILE: received, MODIFY: modify }, env_unset: [] };
    writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
    execFileSync(process.execPath, [path.join(dir, 'worker.mjs')], { timeout: 120000, windowsHide: true });
    const args = JSON.parse(readFileSync(received, 'utf8')) as string[];
    assert.ok(args.includes('read-only'));
    assert.ok(args.includes('mcp_servers."sample.server".enabled=false'), JSON.stringify(args));
    assert.equal(readFileSync(path.join(dir, 'result/worktree-check'), 'utf8'), modify === 'yes' ? 'changed' : 'unchanged');
  }
});
