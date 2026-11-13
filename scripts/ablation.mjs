import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, copyFileSync } from 'node:fs';
import { removeTreeSync } from '../src/fs/remove-tree.mjs';
import path from 'node:path';
import { sourceFiles } from './source-files.mjs';
import { stopTreeAsync } from '../src/run/kill-tree.ts';

const root = path.resolve(import.meta.dirname, '..');
const faults = [
  { id: 'report-parsing', file: 'src/orders/report.ts', before: 'lines.lastIndexOf(REPORT_END)', after: 'lines.indexOf(REPORT_END)', tests: ['test/report.test.ts'] },
  { id: 'dispatch-gate', file: 'src/tick/plan.ts', before: "o.stage === 'queued' && !(o.spendCapUsd", after: "o.stage !== 'running' && !(o.spendCapUsd", tests: ['test/tick.test.ts'] },
  { id: 'review-merge', file: 'src/run/worktree.ts', before: "return gitOk(project.root, ['merge-base', '--is-ancestor', ref, baseRefOf(project)]);", after: 'return true;', tests: ['test/run.test.ts'], pattern: 'review approve' },
  { id: 'worktree-cleanup', file: 'src/clean/clean.ts', before: 'if (orderMerged && inBase) {', after: 'if (orderMerged) {', tests: ['test/clean.test.ts'], pattern: '^clean plan:' },
  { id: 'service-lock', file: 'src/serve/lock.ts', before: 'if (holder) fail(', after: 'if (false) fail(', tests: ['test/serve.test.ts'], pattern: '^lock:' },
  { id: 'process-tree', file: 'src/run/kill-tree.ts', before: 'ordered.push(child.pid);', after: '// Fault: omit descendants.', tests: ['test/kill-tree.test.ts'] },
  { id: 'library-format', file: 'src/library/config.ts', before: "if (raw.format !== undefined && raw.format !== 'alba')", after: 'if (false)', tests: ['test/packaging.test.ts'], pattern: '^library formats' },
  { id: 'demo-protocol', file: 'examples/demo/worker.mjs', before: '--- alba-report ---', after: '--- invalid-report ---', tests: ['test/demo.test.ts'], pattern: '^demo: dispatch a local script' },
  { id: 'worker-environment', file: 'src/run/spawn.ts', before: 'workerEnvironment(process.env, options.env, options.envUnset)', after: '{ ...process.env, ...options.env }', tests: ['test/demo.test.ts'], pattern: '^demo: a dispatched worker' },
];
const parent = path.join(root, '.alba/ablation'); mkdirSync(parent, { recursive: true });
const copy = mkdtempSync(path.join(parent, 'run-')), results = [];

async function run(fault) {
  const args = ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', '--test-reporter=tap', ...(fault.pattern ? [`--test-name-pattern=${fault.pattern}`] : []), ...fault.tests];
  const temp = path.join(copy, '.alba/tmp'); mkdirSync(temp, { recursive: true });
  return new Promise(resolve => {
    const notBefore = Date.now();
    const child = spawn(process.execPath, args, { cwd: copy, env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', expired = false;
    let stopping = Promise.resolve();
    const timer = setTimeout(() => { expired = true; stopping = child.pid ? stopTreeAsync({ pid: child.pid, notBefore, ownsRoot: true }, 30_000).then(() => {}) : Promise.resolve(); }, 240_000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; });
    child.on('error', error => { clearTimeout(timer); resolve({ status: 'infrastructure-error', reason: error.code ?? 'spawn failure' }); });
    child.on('close', async code => {
      clearTimeout(timer);
      await stopping;
      const tests = Number(/^# tests (\d+)/m.exec(output)?.[1] ?? 0);
      const passed = Number(/^# pass (\d+)/m.exec(output)?.[1] ?? 0);
      const failed = Number(/^# fail (\d+)/m.exec(output)?.[1] ?? 0);
      const assertions = /ERR_ASSERTION|AssertionError/.test(output);
      const infrastructure = /SyntaxError|ERR_MODULE_NOT_FOUND|timed out|timeout|ENOENT|EACCES/i.test(output);
      if (expired || !tests || infrastructure) return resolve({ status: 'infrastructure-error', reason: expired ? 'timeout' : 'test setup, syntax, timeout or missing dependency failure' });
      resolve({ status: code === 0 && passed > 0 ? 'passed' : failed > 0 && assertions ? 'assertion-failed' : 'infrastructure-error', tests, passed, failed });
    });
  });
}

try {
  for (const file of sourceFiles(root)) {
    const target = path.join(copy, file); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(path.join(root, file), target);
  }
  symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(path.join(root, 'ui/node_modules'), path.join(copy, 'ui/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const fault of faults) {
    const file = path.join(copy, fault.file), original = readFileSync(file, 'utf8');
    if (original.split(fault.before).length !== 2) { results.push({ id: fault.id, status: 'infrastructure-error', reason: 'mutation anchor must occur exactly once' }); continue; }
    console.log(`${fault.id}: checking unmodified baseline`);
    const baseline = await run(fault);
    if (baseline.status !== 'passed') { results.push({ id: fault.id, status: 'infrastructure-error', reason: 'unmodified baseline failed', baseline }); continue; }
    writeFileSync(file, original.replace(fault.before, fault.after));
    try {
      const outcome = await run(fault);
      const status = outcome.status === 'assertion-failed' ? 'caught' : outcome.status === 'passed' ? 'survived' : 'infrastructure-error';
      results.push({ id: fault.id, status, ...('reason' in outcome ? { reason: outcome.reason } : {}), tests: outcome.tests, passed: outcome.passed, failed: outcome.failed });
      console.log(`${fault.id}: ${status}`);
    } finally { writeFileSync(file, original); }
  }
} finally {
  if (!path.resolve(copy).startsWith(path.resolve(parent) + path.sep)) throw new Error('Unsafe temporary copy path');
  // Unlink dependency junctions before recursively deleting only this owned copy.
  for (const dir of ['node_modules', 'ui/node_modules']) removeTreeSync(path.join(copy, dir), { onError: console.error });
  removeTreeSync(copy, { onError: console.error });
}
const caught = results.filter(r => r.status === 'caught').length;
const report = `# Fault injection results\n\nGenerated by \`pnpm test:ablation\` on ${process.platform}, Node ${process.version}. Each baseline passes before its mutation runs once.\n\n| Fault | Related test | Result | Assertion failures |\n|---|---|---|---|\n${results.map((r, i) => `| ${r.id} | ${faults[i].tests.join(', ')} | ${r.status}${r.reason ? ': ' + r.reason : ''} | ${r.failed ?? '-'} |`).join('\n')}\n\nCaught: ${caught}/${faults.length}. Surviving faults: ${results.filter(r => r.status === 'survived').map(r => r.id).join(', ') || 'none'}. Infrastructure errors: ${results.filter(r => r.status === 'infrastructure-error').map(r => r.id).join(', ') || 'none'}.\n\nA caught mutation means a regression assertion rejected it; it is not cross-platform or production acceptance. See [method and limits](testing.md).\n`;
writeFileSync(path.join(root, 'docs/ablation-results.md'), report);
console.log(JSON.stringify(results, null, 2));
if (caught !== faults.length) process.exitCode = 1;
