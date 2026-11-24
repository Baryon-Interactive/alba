// The root test runs. `pnpm test`: every file, eight at a time, then the timing-sensitive files one at a time (they start real
// serves and processes and race under a loaded machine). `pnpm test:fast`: the quick set while working, without the slow
// integration files. `pnpm test:serial`: every file one at a time, for telling a timing flake from a real failure.
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Start real serves, processes or probes and measure time: never run them next to other files. */
const SERIAL = ['serve-reload', 'serve-isolation', 'serve-events', 'machines', 'nightly-gates'];
/** Slow integration files that `test:fast` leaves out (`pnpm test` runs them). */
const SLOW = [...SERIAL, 'acceptance', 'design-integration', 'evidence-gates-real', 'editors', 'remote-workers'];
/** Bound each file, including multi-minute subprocess integration suites on loaded hosts. */
const TIMEOUT_MS = 10 * 60_000;

const mode = process.argv[2] ?? 'full';
const extra = process.argv.slice(3);
const all = readdirSync('test').filter(f => f.endsWith('.test.ts')).sort();
const pick = (names) => all.filter(f => names.includes(f.slice(0, -'.test.ts'.length))).map(f => `test/${f}`);
const omit = (names) => all.filter(f => !names.includes(f.slice(0, -'.test.ts'.length))).map(f => `test/${f}`);
const timingDir = mode === 'full' ? mkdtempSync(path.join(tmpdir(), 'alba-test-times-')) : undefined;
const timings = [];
function reporters(concurrency) {
  if (!timingDir) return [];
  const output = path.join(timingDir, String(concurrency));
  timings.push(output);
  return ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./scripts/test-file-times.mjs', `--test-reporter-destination=${output}`];
}
const run = (files, concurrency) => files.length === 0 ? 0 : spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', `--test-concurrency=${concurrency}`, `--test-timeout=${TIMEOUT_MS}`, ...reporters(concurrency), ...extra, ...files], { stdio: 'inherit' }).status ?? 1;

let status;
if (mode === 'fast') status = run(omit(SLOW), 8);
else if (mode === 'serial') status = run(all.map(f => `test/${f}`), 1);
else {
  try {
    const parallel = run(omit(SERIAL), 8);
    const serial = run(pick(SERIAL), 1);
    status = parallel || serial;
    const rows = timings.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    console.log('Slowest test files:');
    for (const { name, ms } of rows.sort((a, b) => b.ms - a.ms).slice(0, 5)) console.log(`  ${(ms / 1000).toFixed(1)}s  ${name}`);
  } finally { rmSync(timingDir, { recursive: true, force: true }); }
}
process.exit(status);
