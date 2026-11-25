// The root test runs. `pnpm test`: every file, eight at a time, then the timing-sensitive files one at a time (they start real
// serves and processes and race under a loaded machine). `pnpm test:fast`: the quick set while working, without the slow
// integration files. `pnpm test:serial`: every file one at a time, for telling a timing flake from a real failure.
//
// Every mode gives the test processes their own temporary folder (TEMP, TMP and TMPDIR point into one run folder), then fails
// the run if a test left anything in it and removes the run folder. Tests make temporary folders with `tmpDir` from
// `test/tmp.ts`, which removes them when the test or file ends; anything else they leave is a leak this check reports.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Start real serves, processes or probes and measure time: never run them next to other files. */
const SLOW_SERIAL = ['serve-reload', 'serve-isolation', 'serve-events', 'machines', 'nightly-gates', 'nightly-gates-scheduling', 'acceptance', 'remote-workers'];
// The process-table latency check is quick enough for the fast set, but sensitive to parallel integration work.
const SERIAL = [...SLOW_SERIAL, 'process-table'];
/** Slow integration files that `test:fast` leaves out (`pnpm test` runs them). */
const SLOW = [...SLOW_SERIAL, 'design-integration', 'evidence-gates-real', 'editors'];
/** Keep the Node runner's ten-minute test timeout. Subprocess integration files can take several minutes. */
const TIMEOUT_MS = 10 * 60_000;

const mode = process.argv[2] ?? 'full';
const extra = process.argv.slice(3);
const all = readdirSync('test').filter(f => f.endsWith('.test.ts')).sort();
const pick = (names) => all.filter(f => names.includes(f.slice(0, -'.test.ts'.length))).map(f => `test/${f}`);
const omit = (names) => all.filter(f => !names.includes(f.slice(0, -'.test.ts'.length))).map(f => `test/${f}`);
const runDir = mkdtempSync(path.join(tmpdir(), 'alba-test-run-'));
const testTemp = path.join(runDir, 'tmp');
mkdirSync(testTemp);
const env = { ...process.env, TEMP: testTemp, TMP: testTemp, TMPDIR: testTemp };
const timingDir = mode === 'fast' || mode === 'serial' ? undefined : path.join(runDir, 'times');
if (timingDir) mkdirSync(timingDir);
const timings = [];
function reporters(concurrency) {
  if (!timingDir) return [];
  const output = path.join(timingDir, String(concurrency));
  timings.push(output);
  return ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./scripts/test-file-times.mjs', `--test-reporter-destination=${output}`];
}
const run = (files, concurrency) => files.length === 0 ? 0 : spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', `--test-concurrency=${concurrency}`, `--test-timeout=${TIMEOUT_MS}`, ...reporters(concurrency), ...extra, ...files], { stdio: 'inherit', env }).status ?? 1;

/** Not made by Alba or its tests: Node's compile cache (TypeScript's tsc turns it on; one shared, reused folder) and the
 * script-policy probe files PowerShell itself writes at start-up and leaves behind when a process is stopped early. */
const FOREIGN = [/^node-compile-cache$/, /^__PSScriptPolicyTest_/];
/** Fails the run when the tests left temporary folders or files behind; lists them by name prefix. */
function leftovers() {
  const all = readdirSync(testTemp), left = all.filter(name => !FOREIGN.some(pattern => pattern.test(name)));
  if (all.length > left.length) console.log(`Ignored ${all.length - left.length} temporary entries made by Node or PowerShell themselves.`);
  if (!left.length) { console.log('Temporary folders left by the tests: 0'); return 0; }
  const groups = new Map();
  for (const name of left) { const prefix = name.replace(/[A-Za-z0-9]{6}$/, '').replace(/[-_.\d]+$/, '') || name; groups.set(prefix, (groups.get(prefix) ?? 0) + 1); }
  console.error(`Temporary folders left by the tests: ${left.length} (each test must remove what it makes; use tmpDir from test/tmp.ts)`);
  for (const [prefix, count] of [...groups].sort((a, b) => b[1] - a[1])) console.error(`  ${String(count).padStart(5)}  ${prefix}*`);
  return 1;
}

let status;
try {
  if (mode === 'fast') status = run(omit(SLOW), 8);
  else if (mode === 'serial') status = run(all.map(f => `test/${f}`), 1);
  else {
    const parallel = run(omit(SERIAL), 8);
    const serial = run(pick(SERIAL), 1);
    status = parallel || serial;
    const rows = timings.flatMap(file => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } });
    console.log('Slowest test files:');
    for (const { name, ms } of rows.sort((a, b) => b.ms - a.ms).slice(0, 5)) console.log(`  ${(ms / 1000).toFixed(1)}s  ${name}`);
  }
  status = leftovers() || status;
} finally {
  try { rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) { console.error(`Could not remove the test run folder ${runDir}: ${error.message}`); }
}
process.exit(status);
