// The root test runs. `pnpm test`: every file, eight at a time, then the timing-sensitive files one at a time (they start real
// serves and processes and race under a loaded machine). `pnpm test:fast`: the quick set while working, without the slow
// integration files. `pnpm test:serial`: every file one at a time, for telling a timing flake from a real failure.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Start real serves, processes or probes and measure time: never run them next to other files. */
const SERIAL = ['serve-reload', 'serve-isolation', 'serve-events', 'machines', 'nightly-gates'];
/** Slow integration files that `test:fast` leaves out (`pnpm test` runs them). */
const SLOW = [...SERIAL, 'acceptance', 'design-integration', 'evidence-gates-real', 'editors', 'remote-workers'];
/** A test still running after this long is hung (the slowest take about a minute): fail it instead of waiting forever. */
const TIMEOUT_MS = 10 * 60_000;

const mode = process.argv[2] ?? 'full';
const extra = process.argv.slice(3);
const all = readdirSync('test').filter(f => f.endsWith('.test.ts')).sort();
const pick = (names) => all.filter(f => names.includes(f.slice(0, -'.test.ts'.length))).map(f => `test/${f}`);
const omit = (names) => all.filter(f => !names.includes(f.slice(0, -'.test.ts'.length))).map(f => `test/${f}`);
const run = (files, concurrency) => files.length === 0 ? 0 : spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', `--test-concurrency=${concurrency}`, `--test-timeout=${TIMEOUT_MS}`, ...extra, ...files], { stdio: 'inherit' }).status ?? 1;

let status;
if (mode === 'fast') status = run(omit(SLOW), 8);
else if (mode === 'serial') status = run(all.map(f => `test/${f}`), 1);
else { const parallel = run(omit(SERIAL), 8); const serial = run(pick(SERIAL), 1); status = parallel || serial; }
process.exit(status);
