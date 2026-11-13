import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWorkers } from '../src/workers/config.ts';
import { launchArgs } from '../src/run/prompt.ts';
import { workerAdapter } from '../src/workers/adapters/index.ts';

const worker = (launch: Record<string, unknown>, engine = 'codex-cli') => ({ workers: [{ id: 'w', engine, launch: { program: 'codex', ...launch } }] });
const prepared = (args: string[]) => workerAdapter('codex-cli').prepare([...args], { env: {}, envUnset: [] } as never).args;

test('codex-cli refuses a launch template with neither "exec" nor {engine_flags}, with a message that says why', () => {
  const wrapper = { program: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'run-codex.ps1', '-Prompt', '{prompt_file}'] };
  assert.throws(() => validateWorkers(worker(wrapper), 'w.yaml'), /engine codex-cli adds "--json" right after "exec".*"program" is a shell with no "exec".*\{engine_flags\}/s);
  for (const program of [['C:', 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'].join('\\'), 'pwsh', 'cmd.exe', '/bin/bash', 'sh']) assert.throws(() => validateWorkers(worker({ ...wrapper, program }), 'w.yaml'), /is a shell/, program);
  assert.doesNotThrow(() => validateWorkers(worker({ program: 'node', args: ['fake-codex.mjs', '{prompt_file}'] }), 'w.yaml'), 'a script that stands in for codex keeps working');
  // the wrapper says where the flags go; codex itself with exec; exec inside both session argument lists
  assert.doesNotThrow(() => validateWorkers(worker({ ...wrapper, args: [...wrapper.args, '{engine_flags}'] }), 'w.yaml'));
  assert.doesNotThrow(() => validateWorkers(worker({ args: ['exec', '-C', '{cwd}', '{prompt_file}'] }), 'w.yaml'));
  assert.doesNotThrow(() => validateWorkers(worker({ args: ['{session_args}', '{prompt_file}'], session: { new: ['exec'], resume: ['exec', 'resume', '{session_id}'] } }), 'w.yaml'));
  assert.throws(() => validateWorkers(worker({ program: 'pwsh', args: ['{session_args}', '{prompt_file}'], session: { new: ['exec'], resume: ['resume', '{session_id}'] } }), 'w.yaml'), /is a shell/);
  // the entry is codex-cli's; other engines and partial uses are unknown placeholders
  assert.throws(() => validateWorkers(worker({ args: ['run', '{engine_flags}'] }, 'opencode'), 'w.yaml'), /unknown placeholder \{engine_flags\}/);
  assert.throws(() => validateWorkers(worker({ args: ['exec', '--x={engine_flags}'] }), 'w.yaml'), /unknown placeholder \{engine_flags\}/);
  // other engines are not affected
  assert.doesNotThrow(() => validateWorkers(worker({ args: ['run', '{prompt_file}'] }, 'opencode'), 'w.yaml'));
});

test('codex-cli puts --json where {engine_flags} stands, else right after exec', () => {
  const values = { prompt_file: 'p.md', cwd: '/w' };
  const wrapper = launchArgs({ args: ['-File', 'run-codex.ps1', '-Prompt', '{prompt_file}', '{engine_flags}'] }, values, false);
  assert.deepEqual(wrapper, ['-File', 'run-codex.ps1', '-Prompt', 'p.md', '{engine_flags}'], 'the entry survives the placeholder expansion');
  assert.deepEqual(prepared(wrapper), ['-File', 'run-codex.ps1', '-Prompt', 'p.md', '--json']);
  assert.deepEqual(prepared(['-File', 'x.ps1', '{engine_flags}', '--json']), ['-File', 'x.ps1', '--json'], 'never twice');
  assert.deepEqual(prepared(['exec', '-C', '/w', 'p.md']), ['exec', '--json', '-C', '/w', 'p.md']);
  assert.deepEqual(prepared(['exec', '--json', 'p.md']), ['exec', '--json', 'p.md']);
});
