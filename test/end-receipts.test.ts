import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyClean, planClean, systemClean, type CleanEnv } from '../src/clean/clean.ts';
import { Orders } from '../src/orders/service.ts';
import { REPORT_BEGIN, REPORT_END } from '../src/orders/report.ts';
import {
  clearRolloutCache,
  ROLLOUT_TAIL_BYTES,
  readExitReceipt,
  readRunEndReason,
  systemTailReader,
  type TailReader,
} from '../src/run/end-reason.ts';
import { applyFinish, findFinishes } from '../src/run/finish.ts';
import { startRun } from '../src/run/launch.ts';
import { startServe } from '../src/serve/serve.ts';
import { systemProbes, tick, type Probes } from '../src/tick/gather.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { git } from './api-fixture.ts';
import { alba, projectDir } from './cli-helper.ts';
import { openStream, tempOrders } from './helpers.ts';
import { loadProject, testStore, validateProject } from './state-helper.ts';

const CAPTURE_MJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/run/capture.mjs');
const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), './fixtures/end-reason');

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, '.gitignore'), '*.ignored\nLibrary/\n');
  writeFileSync(path.join(root, 'tracked.txt'), 'initial tracked line\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
}

test('1. capture.mjs writes atomic exit receipts on exit codes, open turns/items with caps, and SIGTERM; launch sets exit_file', async () => {
  const { dir } = tempOrders();

  // (a) Child prints two JSON lines + one plain line and exits 3 -> code 3, lines 2, last_event.type, open_turn false.
  const eventsA = path.join(dir, 'A1-r1.events.jsonl');
  const scriptA = [
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "t-01" }));',
    'console.log("plain non-json diagnostic");',
    'console.log(JSON.stringify({ type: "turn.completed" }));',
    'process.exit(3);',
  ].join('\n');
  const runA = spawnSync(
    process.execPath,
    [CAPTURE_MJS, JSON.stringify([process.execPath, ['-e', scriptA], eventsA])],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  assert.equal(runA.status, 3);
  const stampedLines = runA.stdout.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  assert.equal(stampedLines.length, 2);
  assert.equal(typeof stampedLines[0]!.alba_at, 'string');
  assert.equal(typeof stampedLines[1]!.alba_at, 'string');
  assert.match(runA.stderr, /plain non-json diagnostic/);
  const receiptA = readExitReceipt(path.join(dir, 'A1-r1.exit.json'));
  assert.ok(receiptA);
  assert.equal(receiptA.code, 3);
  assert.equal(receiptA.signal, null);
  assert.equal(receiptA.lines, 2);
  assert.equal(receiptA.last_event?.type, 'turn.completed');
  assert.equal(receiptA.open_turn, false);
  assert.deepEqual(receiptA.open_items, []);

  // (b) Child prints turn.started and one item.started, then exits 0 -> open_turn true, one open item.
  const eventsB = path.join(dir, 'B1-r1.events.jsonl');
  const scriptB = [
    'console.log(JSON.stringify({ type: "turn.started" }));',
    'console.log(JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "git log -n 3" } }));',
    'process.exit(0);',
  ].join('\n');
  const runB = spawnSync(
    process.execPath,
    [CAPTURE_MJS, JSON.stringify([process.execPath, ['-e', scriptB], eventsB])],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  assert.equal(runB.status, 0);
  const receiptB = readExitReceipt(path.join(dir, 'B1-r1.exit.json'));
  assert.ok(receiptB);
  assert.equal(receiptB.code, 0);
  assert.equal(receiptB.open_turn, true);
  assert.deepEqual(receiptB.open_items, [{ id: 'item_1', type: 'command_execution', command: 'git log -n 3' }]);

  // Verify open_items cap (at most 5) and command length cap (300 characters).
  const eventsCap = path.join(dir, 'CAP-r1.events.jsonl');
  const longCommand = 'x'.repeat(450);
  const scriptCap = [
    'console.log(JSON.stringify({ type: "turn.started" }));',
    `console.log(JSON.stringify({ type: "item.started", item: { id: "i0", type: "command_execution", command: ${JSON.stringify(longCommand)} } }));`,
    'console.log(JSON.stringify({ type: "item.started", item: { id: "closed", type: "command_execution", command: "echo done" } }));',
    'console.log(JSON.stringify({ type: "item.completed", item: { id: "closed", type: "command_execution" } }));',
    'for (let k = 1; k <= 6; k++) console.log(JSON.stringify({ type: "item.started", item: { id: "i" + k, type: "command_execution", command: "cmd " + k } }));',
  ].join('\n');
  spawnSync(process.execPath, [CAPTURE_MJS, JSON.stringify([process.execPath, ['-e', scriptCap], eventsCap])], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const receiptCap = readExitReceipt(path.join(dir, 'CAP-r1.exit.json'))!;
  assert.equal(receiptCap.open_items.length, 5);
  assert.equal(receiptCap.open_items[0]!.command?.length, 300);
  assert.ok(!receiptCap.open_items.some(i => i.id === 'closed'));

  // (c) SIGTERM from the test: receipt is still written after the child exits.
  const eventsSig = path.join(dir, 'SIG-r1.events.jsonl');
  const childWait = 'console.log(JSON.stringify({ type: "turn.started" })); setInterval(() => {}, 1000);';
  const winIpcPreload = 'data:text/javascript,process.on("message",m=>{if(m==="SIGTERM"){process.disconnect();process.emit("SIGTERM","SIGTERM");}})';
  const useIpc = process.platform === 'win32';
  const proc = spawn(
    process.execPath,
    [...(useIpc ? ['--import', winIpcPreload] : []), CAPTURE_MJS, JSON.stringify([process.execPath, ['-e', childWait], eventsSig])],
    { stdio: ['ignore', 'pipe', 'pipe', ...(useIpc ? ['ipc' as const] : [])], windowsHide: true },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('capture child did not emit turn.started')), 10000);
      proc.stdout!.on('data', chunk => {
        if (String(chunk).includes('turn.started')) { clearTimeout(timer); resolve(); }
      });
      proc.once('error', err => { clearTimeout(timer); reject(err); });
    });
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('capture did not exit after SIGTERM')), 10000);
      proc.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (useIpc) proc.send('SIGTERM');
    else proc.kill('SIGTERM');
    await closed;
  } finally {
    try { proc.kill(); } catch { /* already exited */ }
  }
  const receiptSig = readExitReceipt(path.join(dir, 'SIG-r1.exit.json'));
  assert.ok(receiptSig, 'receipt must be written on SIGTERM');
  assert.equal(receiptSig.lines, 1);
  assert.equal(receiptSig.last_event?.type, 'turn.started');
  assert.equal(receiptSig.open_turn, true);

  // Run.exit_file is set wherever Run.events_file is set (src/run/launch.ts).
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  mkdirSync(path.join(repo, 'orders'), { recursive: true });
  writeFileSync(path.join(repo, 'orders', 'LN1.md'), '# Order LN1\n\nDo the work.\n');
  const cfg = validateProject({ id: 'demo', name: 'Demo', root: repo, work_orders: path.join(repo, 'orders'), state_dir: path.join(dir, 'ln-state'), dispatch: { worktree_parent: dir, base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  const orders = new Orders(testStore(cfg.state_dir));
  orders.add({ tag: 'LN1', title: 'Launch exit file', kind: 'sim' });
  orders.act('LN1', 'queue');
  const workers = validateWorkers({
    workers: [{ id: 'codex-test', engine: 'codex-cli', capabilities: ['shell', 'edit', 'git'], launch: { program: 'codex', args: ['exec', '--json', '-C', '{cwd}', '-'] } }],
  }, path.join(dir, 'workers.yaml'));
  startRun({
    project: cfg,
    orders,
    workers,
    probes: { ...systemProbes, spawnDetached: () => 42424, processStartedAt: () => '2026-11-16T00:00:00.000Z' },
  }, 'LN1', 'codex-test', { explicitWorker: true });
  const launched = orders.get('LN1').runs[0]!;
  assert.ok(launched.events_file?.endsWith('LN1-r1.events.jsonl'));
  assert.equal(launched.exit_file, launched.events_file!.replace(/\.events\.jsonl$/, '.exit.json'));
});

test('2. end-reason fixtures classify every kind, stop max_output_tokens from retrying as capacity, and bound rollout lookup by day folder', () => {
  clearRolloutCache();
  const { dir, orders } = tempOrders();
  const codexHome = path.join(dir, 'codex-home');
  const day14 = path.join(codexHome, 'sessions', '2026', '11', '14');
  const day15 = path.join(codexHome, 'sessions', '2026', '11', '15');
  const dayOld = path.join(codexHome, 'sessions', '2026', '11', '01');
  const dayFuture = path.join(codexHome, 'sessions', '2026', '11', '28');
  for (const d of [day14, day15, dayOld, dayFuture]) mkdirSync(d, { recursive: true });

  writeFileSync(path.join(day14, 'rollout-2026-11-14T18-23-01-019a0000-0000-7000-8000-000000000001.jsonl'), readFileSync(path.join(FIXTURES_DIR, 'mid-turn.rollout.jsonl')));
  writeFileSync(path.join(day15, 'rollout-2026-11-15T10-00-01-019a0000-0000-7000-8000-000000000002.jsonl'), readFileSync(path.join(FIXTURES_DIR, 'output-limit.rollout.jsonl')));
  writeFileSync(path.join(day15, 'rollout-2026-11-15T12-00-01-019a0000-0000-7000-8000-000000000003.jsonl'), readFileSync(path.join(FIXTURES_DIR, 'context-limit.rollout.jsonl')));
  writeFileSync(path.join(day15, 'rollout-2026-11-15T13-00-01-019a0000-0000-7000-8000-000000000004.jsonl'), readFileSync(path.join(FIXTURES_DIR, 'quota.rollout.jsonl')));

  const writeReceiptFile = (name: string, obj: Record<string, unknown>) => {
    const f = path.join(dir, `${name}.exit.json`);
    writeFileSync(f, JSON.stringify({
      code: 0, signal: null, ended_at: '2026-11-15T12:00:00Z', lines: 3,
      last_event: { type: 'turn.completed', at: '2026-11-15T11:59:59Z' }, open_turn: false, open_items: [],
      ...obj,
    }) + '\n');
    return f;
  };
  const writeEventsFile = (name: string, content: string) => {
    const f = path.join(dir, `${name}.events.jsonl`);
    writeFileSync(f, content);
    return f;
  };
  const writeLogFile = (name: string, content: string) => {
    const f = path.join(dir, `${name}.log`);
    writeFileSync(f, content);
    return f;
  };

  // report
  const reportRes = readRunEndReason({
    run: { id: 'r1', engine: 'codex-cli', started: '2026-11-15T10:00:00Z', ended: '2026-11-15T10:05:00Z', exit_file: writeReceiptFile('rep', { code: 0 }) },
    hasReport: true,
    reportStatus: 'ready',
  });
  assert.equal(reportRes.kind, 'report');
  assert.equal(reportRes.exit_code, 0);

  // exit-0-no-report
  const exit0Res = readRunEndReason({
    run: {
      id: 'r1', engine: 'codex-cli', started: '2026-11-15T10:00:00Z', ended: '2026-11-15T10:05:00Z',
      events_file: writeEventsFile('exit0', '{"type":"turn.started","alba_at":"2026-11-15T10:00:01Z"}\n{"type":"turn.completed","alba_at":"2026-11-15T10:04:59Z"}\n'),
      exit_file: writeReceiptFile('exit0', { code: 0, open_turn: false }),
    },
    codexHome,
  });
  assert.equal(exit0Res.kind, 'exit-0-no-report');

  // nonzero-exit
  const nzRes = readRunEndReason({
    run: {
      id: 'r1', engine: 'codex-cli', started: '2026-11-15T10:00:00Z', ended: '2026-11-15T10:05:00Z',
      log: writeLogFile('nz', 'fatal: worker crashed unexpectedly\n'),
      exit_file: writeReceiptFile('nz', { code: 2, open_turn: false }),
    },
    codexHome,
  });
  assert.equal(nzRes.kind, 'nonzero-exit');
  assert.equal(nzRes.exit_code, 2);
  assert.match(nzRes.detail, /exit code 2/);

  // stream-cut-mid-turn + bounded rollout day-folder lookup check
  const readdirCalls: string[] = [];
  const trackingReader: TailReader = {
    ...systemTailReader,
    readdir(d) {
      readdirCalls.push(path.normalize(d));
      return systemTailReader.readdir!(d);
    },
  };
  const midEventsFile = writeEventsFile('mid', readFileSync(path.join(FIXTURES_DIR, 'mid-turn.events.jsonl'), 'utf8'));
  const midRun = {
    id: 'r1', engine: 'codex-cli', started: '2026-11-14T18:23:00Z', ended: '2026-11-14T19:00:00Z',
    events_file: midEventsFile,
  };
  const midNoReceipt = readRunEndReason({ run: midRun, codexHome, reader: trackingReader });
  assert.equal(midNoReceipt.kind, 'stream-cut-mid-turn');
  assert.equal(midNoReceipt.open_turn, true);
  assert.equal(midNoReceipt.last_event?.type, 'item.completed');
  assert.ok(!readdirCalls.includes(path.normalize(dayOld)), 'older day folder outside [started, ended] must not be scanned');
  assert.ok(!readdirCalls.includes(path.normalize(dayFuture)), 'later day folder outside [started, ended] must not be scanned');
  const countAfterFirst = readdirCalls.length;
  const midCached = readRunEndReason({ run: midRun, codexHome, reader: trackingReader });
  assert.equal(midCached.kind, 'stream-cut-mid-turn');
  assert.equal(readdirCalls.length, countAfterFirst, 'rollout path is cached per run session id');

  const midWithReceipt = readRunEndReason({
    run: { ...midRun, exit_file: writeReceiptFile('mid-rec', { code: 1, open_turn: true, last_event: { type: 'item.completed', at: '2026-11-14T18:23:06.000Z' } }) },
    codexHome,
  });
  assert.equal(midWithReceipt.kind, 'stream-cut-mid-turn');
  assert.equal(midWithReceipt.exit_code, 1);

  // output-limit (from Codex rollout event_msg shape, even when message begins with "stream disconnected before completion:")
  const outEvents = writeEventsFile('outlim', '{"type":"thread.started","thread_id":"019a0000-0000-7000-8000-000000000002","alba_at":"2026-11-15T10:00:01Z"}\n{"type":"turn.started","alba_at":"2026-11-15T10:00:02Z"}\n{"type":"error","message":"stream disconnected before completion: Incomplete response returned, reason: max_output_tokens","alba_at":"2026-11-15T11:58:10Z"}\n');
  const outLimitRes = readRunEndReason({
    run: { id: 'r1', engine: 'codex-cli', started: '2026-11-15T10:00:00Z', ended: '2026-11-15T12:00:00Z', events_file: outEvents, exit_file: writeReceiptFile('outlim', { code: 1, open_turn: true }) },
    codexHome,
  });
  assert.equal(outLimitRes.kind, 'output-limit');
  assert.match(outLimitRes.detail, /max_output_tokens/);

  // Verify findFinishes treats output-limit as failed (not transient capacity retry).
  const cfg = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: dir, state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({ workers: [{ id: 'codex-w', engine: 'codex-cli', launch: { program: 'codex', args: ['exec', '--json'], env: { CODEX_HOME: codexHome } } }] }, path.join(dir, 'w.yaml'));
  orders.add({ tag: 'OL1', title: 'Output limit order', kind: 'sim' });
  orders.act('OL1', 'queue');
  const { run: olRun } = orders.runStart('OL1', { worker: 'codex-w', extra: { pid: 99991, events_file: outEvents, exit_file: path.join(dir, 'outlim.exit.json'), engine: 'codex-cli' } });
  const olFinish = findFinishes(cfg, orders, { ...systemProbes, isAlive: () => false }, workers).find(f => f.tag === 'OL1');
  assert.ok(olFinish);
  assert.equal(olFinish.run, olRun.id);
  assert.equal(olFinish.outcome, 'failed', 'max_output_tokens must not retry as transient capacity');
  assert.equal(olFinish.end?.kind, 'output-limit');

  // context-limit
  const ctxEvents = writeEventsFile('ctxlim', '{"type":"thread.started","thread_id":"019a0000-0000-7000-8000-000000000003","alba_at":"2026-11-15T12:00:01Z"}\n{"type":"turn.started","alba_at":"2026-11-15T12:00:02Z"}\n');
  const ctxRes = readRunEndReason({
    run: { id: 'r1', engine: 'codex-cli', started: '2026-11-15T12:00:00Z', ended: '2026-11-15T12:20:00Z', events_file: ctxEvents, exit_file: writeReceiptFile('ctxlim', { code: 1, open_turn: true }) },
    codexHome,
  });
  assert.equal(ctxRes.kind, 'context-limit');
  assert.match(ctxRes.detail, /context window/i);

  // quota
  const quotaEvents = writeEventsFile('quota', '{"type":"thread.started","thread_id":"019a0000-0000-7000-8000-000000000004","alba_at":"2026-11-15T13:00:01Z"}\n{"type":"turn.started","alba_at":"2026-11-15T13:00:02Z"}\n');
  const quotaRes = readRunEndReason({
    run: { id: 'r1', engine: 'codex-cli', started: '2026-11-15T13:00:00Z', ended: '2026-11-15T13:10:00Z', events_file: quotaEvents, exit_file: writeReceiptFile('quota', { code: 1, open_turn: true }) },
    codexHome,
  });
  assert.equal(quotaRes.kind, 'quota');

  // unreachable
  const gwWorker = validateWorkers({
    workers: [{ id: 'gw', engine: 'codex-cli', launch: { program: 'codex', args: ['exec', '--json'], env: { OPENAI_BASE_URL: 'http://127.0.0.1:43199/v1' } } }],
  }, path.join(dir, 'gw.yaml')).workers[0]!;
  const unrLog = writeLogFile('unr', 'Error: connect ECONNREFUSED http://127.0.0.1:43199/v1/responses\n');
  const unrRes = readRunEndReason({
    run: { id: 'r1', engine: 'codex-cli', started: '2026-11-15T14:00:00Z', ended: '2026-11-15T14:01:00Z', log: unrLog, exit_file: writeReceiptFile('unr', { code: 1, open_turn: false }) },
    worker: gwWorker,
    codexHome,
  });
  assert.equal(unrRes.kind, 'unreachable');
  assert.match(unrRes.detail, /127\.0\.0\.1:43199/);

  // killed-by-alba (with a loop-stopped event)
  const killedRes = readRunEndReason({
    run: { id: 'r1', engine: 'codex-cli', started: '2026-11-15T15:00:00Z', ended: '2026-11-15T15:10:00Z', events_file: midEventsFile },
    albaEvents: [{ type: 'loop-stopped', data: { run: 'r1' } }],
    codexHome,
  });
  assert.equal(killedRes.kind, 'killed-by-alba');
  assert.match(killedRes.detail, /loop-stopped/);

  // vanished (no receipt and pid gone)
  const vanishedRes = readRunEndReason({
    run: { id: 'r1', engine: 'codex-cli', started: '2026-11-15T16:00:00Z', ended: '2026-11-15T16:05:00Z', events_file: path.join(dir, 'missing.events.jsonl'), exit_file: path.join(dir, 'missing.exit.json') },
    codexHome,
  });
  assert.equal(vanishedRes.kind, 'vanished');

  // file content echoed after an error line (a failed apply_patch) does not count as a limit; the error line itself does
  const echoLog = writeLogFile('echo', '2026-11-15T17:00:00Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in src/a.ts:\n  const cap = { max_output_tokens: 128, note: "prompt is too long" };\n');
  const echoRes = readRunEndReason({
    run: { id: 'r1', engine: 'codex-cli', started: '2026-11-15T17:00:00Z', ended: '2026-11-15T17:01:00Z', log: echoLog, exit_file: writeReceiptFile('echo', { code: 1, open_turn: false }) },
    codexHome,
  });
  assert.equal(echoRes.kind, 'nonzero-exit');
  const limitLog = writeLogFile('limit', '2026-11-15T17:00:00Z ERROR codex_core::codex: Incomplete response returned, reason: max_output_tokens\n');
  const limitRes = readRunEndReason({
    run: { id: 'r1', engine: 'codex-cli', started: '2026-11-15T17:00:00Z', ended: '2026-11-15T17:01:00Z', log: limitLog, exit_file: writeReceiptFile('limit', { code: 1, open_turn: false }) },
    codexHome,
  });
  assert.equal(limitRes.kind, 'output-limit');
});

test('3. rollout reader reads only the 256 KB tail of a 50 MB rollout file', () => {
  clearRolloutCache();
  const { dir } = tempOrders();
  const codexHome = path.join(dir, 'codex-50m');
  const dayDir = path.join(codexHome, 'sessions', '2026', '11', '16');
  mkdirSync(dayDir, { recursive: true });
  const sessionId = '019a0000-0000-7000-8000-500000000050';
  const rolloutFile = path.join(dayDir, `rollout-2026-11-16T08-00-00-${sessionId}.jsonl`);

  // Write >50 MB of JSONL filler followed by a real max_output_tokens rollout error event.
  const fd = openSync(rolloutFile, 'w');
  try {
    const line = '{"timestamp":"2026-11-16T08:00:02.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"Reasoning","id":"r"}}}\n';
    const chunk = Buffer.from(line.repeat(4096), 'utf8');
    const targetBytes = 50 * 1024 * 1024;
    let written = 0;
    while (written < targetBytes) {
      writeSync(fd, chunk);
      written += chunk.length;
    }
    const ending = '{"timestamp":"2026-11-16T09:59:59.000Z","type":"event_msg","payload":{"type":"error","message":"Incomplete response returned, reason: max_output_tokens","codex_error_info":"response_incomplete"}}\n';
    writeSync(fd, Buffer.from(ending, 'utf8'));
  } finally {
    closeSync(fd);
  }
  const totalSize = statSync(rolloutFile).size;
  assert.ok(totalSize > 50 * 1024 * 1024);

  const bytesReadByFile = new Map<string, number>();
  const addBytes = (file: string, n: number) => bytesReadByFile.set(path.resolve(file), (bytesReadByFile.get(path.resolve(file)) ?? 0) + n);
  const cappedReader: TailReader = {
    tail(file, maxBytes) {
      if (!existsSync(file)) return { text: '', cut: false };
      const handle = openSync(file, 'r');
      try {
        const size = fstatSync(handle).size;
        const start = Math.max(0, size - maxBytes);
        const length = size - start;
        const buf = Buffer.alloc(length);
        if (length > 0) readSync(handle, buf, 0, length, start);
        addBytes(file, length);
        return { text: buf.toString('utf8'), cut: start > 0 };
      } finally {
        closeSync(handle);
      }
    },
    head(file, maxBytes) {
      if (!existsSync(file)) return '';
      const handle = openSync(file, 'r');
      try {
        const length = Math.min(fstatSync(handle).size, maxBytes);
        const buf = Buffer.alloc(length);
        if (length > 0) readSync(handle, buf, 0, length, 0);
        addBytes(file, length);
        return buf.toString('utf8');
      } finally {
        closeSync(handle);
      }
    },
    exists: systemTailReader.exists,
    readdir: systemTailReader.readdir,
  };

  try {
    const eventsFile = path.join(dir, 'BIG-r1.events.jsonl');
    writeFileSync(eventsFile, `{"type":"thread.started","thread_id":"${sessionId}","alba_at":"2026-11-16T08:00:00.000Z"}\n{"type":"turn.started","alba_at":"2026-11-16T08:00:01.000Z"}\n`);
    const reason = readRunEndReason({
      run: { id: 'r1', engine: 'codex-cli', started: '2026-11-16T08:00:00Z', ended: '2026-11-16T10:00:00Z', events_file: eventsFile },
      codexHome,
      reader: cappedReader,
    });
    assert.equal(reason.kind, 'output-limit');
    assert.match(reason.detail, /max_output_tokens/);
    const rolloutBytesRead = bytesReadByFile.get(path.resolve(rolloutFile)) ?? 0;
    assert.equal(rolloutBytesRead, ROLLOUT_TAIL_BYTES);
    assert.ok(rolloutBytesRead <= 256 * 1024, `expected <= 256 KB read from 50 MB rollout, got ${rolloutBytesRead}`);
  } finally {
    rmSync(rolloutFile, { force: true });
  }
});

test('4. Run.end and run-end event store kind, detail, exit_code and wip_ref; alba orders show and alba status --json print them', () => {
  const { dir } = tempOrders();
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  const wt = path.join(dir, 'demo-sh1');
  git(repo, 'worktree', 'add', '-q', '-b', 'demo-sh1', wt, 'main');
  writeFileSync(path.join(wt, 'tracked.txt'), 'uncommitted progress in SH1\n');

  const projectFile = projectDir(repo, `dispatch:\n  worktree_parent: ${JSON.stringify(dir)}\n  base_ref: refs/heads/main\n`);
  const cfg = loadProject(projectFile);
  const orders = new Orders(testStore(cfg.state_dir));

  orders.add({ tag: 'SH1', title: 'Show order', kind: 'sim', worktree: wt, branch: 'demo-sh1' });
  orders.act('SH1', 'queue');
  const eventsFile = path.join(dir, 'SH1-r1.events.jsonl');
  const exitFile = path.join(dir, 'SH1-r1.exit.json');
  const recentAt = new Date(Date.now() - 5 * 60_000).toISOString();
  writeFileSync(eventsFile, [
    JSON.stringify({ type: 'thread.started', thread_id: '019a0000-0000-7000-8000-000000000099', alba_at: recentAt }),
    JSON.stringify({ type: 'turn.started', alba_at: recentAt }),
    JSON.stringify({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', exit_code: 0 }, alba_at: recentAt }),
  ].join('\n') + '\n');
  writeFileSync(exitFile, JSON.stringify({
    code: 2,
    signal: null,
    ended_at: recentAt,
    lines: 3,
    last_event: { type: 'item.completed', at: recentAt },
    open_turn: true,
    open_items: [],
  }) + '\n');
  orders.runStart('SH1', { worker: 'coder', extra: { pid: 77771, events_file: eventsFile, exit_file: exitFile, engine: 'codex-cli' } });

  const finishes = findFinishes(cfg, orders, { ...systemProbes, isAlive: () => false });
  assert.equal(finishes.length, 1);
  applyFinish(orders, finishes[0]!, cfg);

  const storedRun = orders.get('SH1').runs[0]!;
  assert.ok(storedRun.end);
  assert.equal(storedRun.end.kind, 'stream-cut-mid-turn');
  assert.equal(storedRun.end.exit_code, 2);
  assert.match(storedRun.end.detail, /item\.completed/);
  assert.equal(storedRun.end.wip_ref, 'refs/alba/wip/SH1-r1');
  assert.equal(storedRun.end.wip_files, 1);

  const runEndEvent = orders.store.events({ tag: 'SH1' }).find(e => e.type === 'run-end');
  assert.ok(runEndEvent?.data);
  assert.equal(runEndEvent.data.run, 'r1');
  assert.equal(runEndEvent.data.outcome, 'failed');
  assert.equal(runEndEvent.data.kind, 'stream-cut-mid-turn');
  assert.equal(runEndEvent.data.exit_code, 2);
  assert.equal(runEndEvent.data.detail, storedRun.end.detail);
  assert.equal(runEndEvent.data.wip_ref, 'refs/alba/wip/SH1-r1');

  // Add an older ended run (>24 h ago) to verify alba status --json only includes ended runs from the last 24 hours.
  const oldClock = new Orders(orders.store, () => new Date(Date.now() - 30 * 3600_000).toISOString());
  oldClock.add({ tag: 'OLD1', title: 'Old order', kind: 'sim' });
  oldClock.act('OLD1', 'queue');
  oldClock.runStart('OLD1', { worker: 'coder' });
  oldClock.runEnd('OLD1', 'failed', { kind: 'nonzero-exit', detail: 'old failure', why: 'old', exit_code: 1 });

  const shown = alba(projectFile, ['orders', 'show', 'SH1']);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /stream-cut-mid-turn/);
  assert.match(shown.out, /exit 2/);
  assert.match(shown.out, /last item\.completed/);
  assert.match(shown.out, /refs\/alba\/wip\/SH1-r1/);
  assert.match(shown.out, /git show --stat refs\/alba\/wip\/SH1-r1/);
  assert.match(shown.out, /git checkout refs\/alba\/wip\/SH1-r1 -- <path>/);

  const statusJson = alba(projectFile, ['status', '--json']);
  assert.equal(statusJson.code, 0, statusJson.err);
  const statusRows = JSON.parse(statusJson.out) as { tag: string; run: string; end?: { kind: string; exit_code?: number; wip_ref?: string } }[];
  const shRow = statusRows.find(r => r.tag === 'SH1' && r.run === 'r1');
  assert.ok(shRow, 'run ended within 24h must appear in alba status --json');
  assert.equal(shRow.end?.kind, 'stream-cut-mid-turn');
  assert.equal(shRow.end?.exit_code, 2);
  assert.equal(shRow.end?.wip_ref, 'refs/alba/wip/SH1-r1');
  assert.equal(statusRows.some(r => r.tag === 'OLD1'), false, 'run ended >24h ago must be excluded');
});

test('5. WIP snapshot saves modified and untracked files, skips ignored and oversized files, leaves tree/index/HEAD byte-identical, skips report ends, and records errors safely', () => {
  const { dir } = tempOrders();
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  const wt = path.join(dir, 'demo-wip1');
  git(repo, 'worktree', 'add', '-q', '-b', 'demo-wip1', wt, 'main');

  // 1 modified tracked file, 1 new untracked file, 1 ignored file, 1 file over the lowered cap (512 bytes).
  writeFileSync(path.join(wt, 'tracked.txt'), 'modified tracked content\n');
  mkdirSync(path.join(wt, 'sub'), { recursive: true });
  writeFileSync(path.join(wt, 'sub', 'untracked.txt'), 'new untracked content\n');
  writeFileSync(path.join(wt, 'scratch.ignored'), 'ignored content\n');
  writeFileSync(path.join(wt, 'too-big.bin'), Buffer.alloc(2048, 0x62));

  const indexPath = path.resolve(wt, git(wt, 'rev-parse', '--git-path', 'index').trim());
  const headBefore = git(wt, 'rev-parse', 'HEAD').trim();
  const indexBytesBefore = readFileSync(indexPath);
  const statusBefore = git(wt, 'status', '--porcelain=v1', '-z', '--ignored');
  const treeBytesBefore = {
    tracked: readFileSync(path.join(wt, 'tracked.txt')),
    untracked: readFileSync(path.join(wt, 'sub', 'untracked.txt')),
    ignored: readFileSync(path.join(wt, 'scratch.ignored')),
    big: readFileSync(path.join(wt, 'too-big.bin')),
  };

  const cfg = validateProject({ id: 'demo', name: 'Demo', root: repo, work_orders: repo, state_dir: path.join(dir, 'state'), dispatch: { worktree_parent: dir, base_ref: 'refs/heads/main' } }, path.join(dir, 'alba.yaml'));
  const orders = new Orders(testStore(cfg.state_dir));
  orders.add({ tag: 'WIP1', title: 'WIP test', kind: 'sim', worktree: wt, branch: 'demo-wip1' });
  orders.act('WIP1', 'queue');
  orders.runStart('WIP1', { worker: 'coder', extra: { pid: 55501, cwd: wt } });

  applyFinish(orders, {
    tag: 'WIP1',
    run: 'r1',
    outcome: 'failed',
    missing_report: true,
    report: { status: 'failed', summary: 'worker exited mid-turn', evidence: [], commits: [] },
    end: { kind: 'stream-cut-mid-turn', detail: 'stream ended mid-turn', why: 'no report', exit_code: 1 },
    why: 'no report',
  }, cfg, { maxFileBytes: 512 });

  const end = orders.get('WIP1').runs[0]!.end!;
  assert.equal(end.wip_ref, 'refs/alba/wip/WIP1-r1');
  assert.equal(end.wip_files, 2);
  assert.equal(end.wip_skipped, true);
  assert.deepEqual(end.wip_skipped_paths, ['too-big.bin']);

  // Ref exists and holds exact modified + untracked contents; ignored and oversized files are absent.
  const wipSha = git(repo, 'rev-parse', '--verify', 'refs/alba/wip/WIP1-r1').trim();
  assert.match(wipSha, /^[0-9a-f]{40}$/);
  assert.equal(git(repo, 'show', 'refs/alba/wip/WIP1-r1:tracked.txt'), 'modified tracked content\n');
  assert.equal(git(repo, 'show', 'refs/alba/wip/WIP1-r1:sub/untracked.txt'), 'new untracked content\n');
  const treeFiles = git(repo, 'ls-tree', '-r', '--name-only', 'refs/alba/wip/WIP1-r1').trim().split(/\r?\n/);
  assert.ok(treeFiles.includes('tracked.txt'));
  assert.ok(treeFiles.includes('sub/untracked.txt'));
  assert.equal(treeFiles.includes('scratch.ignored'), false);
  assert.equal(treeFiles.includes('too-big.bin'), false);

  // Working tree, real index and HEAD are byte-for-byte unchanged.
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), headBefore);
  assert.equal(Buffer.compare(readFileSync(indexPath), indexBytesBefore), 0);
  assert.equal(git(wt, 'status', '--porcelain=v1', '-z', '--ignored'), statusBefore);
  assert.equal(Buffer.compare(readFileSync(path.join(wt, 'tracked.txt')), treeBytesBefore.tracked), 0);
  assert.equal(Buffer.compare(readFileSync(path.join(wt, 'sub', 'untracked.txt')), treeBytesBefore.untracked), 0);
  assert.equal(Buffer.compare(readFileSync(path.join(wt, 'scratch.ignored')), treeBytesBefore.ignored), 0);
  assert.equal(Buffer.compare(readFileSync(path.join(wt, 'too-big.bin')), treeBytesBefore.big), 0);

  // No ref is made after a report end.
  const wtRep = path.join(dir, 'demo-rep1');
  git(repo, 'worktree', 'add', '-q', '-b', 'demo-rep1', wtRep, 'main');
  writeFileSync(path.join(wtRep, 'tracked.txt'), 'dirty at report end\n');
  orders.add({ tag: 'REP1', title: 'Report end', kind: 'sim', worktree: wtRep, branch: 'demo-rep1' });
  orders.act('REP1', 'queue');
  orders.runStart('REP1', { worker: 'coder', extra: { pid: 55502, cwd: wtRep } });
  applyFinish(orders, {
    tag: 'REP1',
    run: 'r1',
    outcome: 'completed',
    report: { status: 'ready', summary: 'done cleanly', evidence: [], commits: [] },
    end: { kind: 'report', detail: 'report block read (ready)', why: 'report read' },
    why: 'report read',
  }, cfg);
  assert.equal(orders.get('REP1').runs[0]!.end?.wip_ref, undefined);
  assert.equal(git(repo, 'for-each-ref', 'refs/alba/wip/REP1-r1').trim(), '');

  // A snapshot error is recorded on end.wip_error and does not change the run outcome.
  orders.add({ tag: 'ERR1', title: 'Snapshot failure', kind: 'sim', worktree: wt, branch: 'demo-wip1' });
  orders.act('ERR1', 'queue');
  orders.runStart('ERR1', { worker: 'coder', extra: { pid: 55503, cwd: wt } });
  applyFinish(orders, {
    tag: 'ERR1',
    run: 'r1',
    outcome: 'capacity',
    limit: 'capacity',
    missing_report: true,
    end: { kind: 'nonzero-exit', detail: 'transient service error', why: 'transient' },
    why: 'transient',
  }, cfg, { runGit: () => { throw new Error('simulated index lock failure'); } });
  const errRun = orders.get('ERR1').runs[0]!;
  assert.equal(errRun.outcome, 'capacity');
  assert.match(errRun.end?.wip_error ?? '', /simulated index lock failure/);
});

test('6. alba clean removes merged worktrees and branches while leaving refs/alba/wip/* intact', () => {
  const { dir } = tempOrders();
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  const wt = path.join(dir, 'demo-cln1');
  git(repo, 'worktree', 'add', '-q', '-b', 'demo-cln1', wt, 'main');

  const cfg = validateProject({
    id: 'demo', name: 'Demo', root: repo, work_orders: repo, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: dir, base_ref: 'refs/heads/main' },
    clean: { idle_hours: 0, caches: ['Library'] },
  }, path.join(dir, 'alba.yaml'));
  const orders = new Orders(testStore(cfg.state_dir), () => '2026-01-01T00:00:00Z');
  orders.add({ tag: 'CLN1', title: 'Clean test', kind: 'sim', worktree: wt, branch: 'demo-cln1' });
  orders.act('CLN1', 'queue');
  orders.runStart('CLN1', { worker: 'coder', extra: { pid: 60001, cwd: wt } });

  // Run 1 ends abnormally with uncommitted work -> creates refs/alba/wip/CLN1-r1.
  writeFileSync(path.join(wt, 'draft.txt'), 'saved wip draft\n');
  applyFinish(orders, {
    tag: 'CLN1',
    run: 'r1',
    outcome: 'failed',
    missing_report: true,
    report: { status: 'failed', summary: 'cut off', evidence: [], commits: [] },
    end: { kind: 'stream-cut-mid-turn', detail: 'cut mid-turn', why: 'cut' },
    why: 'cut',
  }, cfg);
  const wipCommit = git(repo, 'rev-parse', '--verify', 'refs/alba/wip/CLN1-r1').trim();

  // Later work commits, merges into main, and is approved; worktree is now clean and idle.
  git(wt, 'add', 'draft.txt');
  git(wt, 'commit', '-q', '-m', 'finish CLN1');
  git(repo, 'merge', '--ff-only', 'demo-cln1');
  orders.act('CLN1', 'approve', { force: true });

  const cleanEnv: CleanEnv = {
    ...systemClean({ ...systemProbes, now: () => new Date(Date.now() + 3600_000), isAlive: () => true, processStartedAt: () => '2026-01-01T00:00:01Z' }),
    sizeBudgetMs: Infinity,
    processes: () => [],
    executableProcesses: () => [],
    runGit: (cwd, args) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CEILING_DIRECTORIES: dir }, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  };
  const plan = planClean(cfg, orders, cleanEnv);
  const item = plan.items.find(i => i.tag === 'CLN1')!;
  assert.equal(item.action, 'remove', item.reason);
  applyClean(cfg, orders, plan, cleanEnv);

  assert.equal(existsSync(wt), false, 'merged worktree was removed');
  assert.equal(git(repo, 'for-each-ref', 'refs/heads/demo-cln1').trim(), '', 'merged branch was deleted');
  assert.equal(git(repo, 'rev-parse', '--verify', 'refs/alba/wip/CLN1-r1').trim(), wipCommit, 'WIP ref must stay intact after alba clean');
  assert.equal(git(repo, 'show', 'refs/alba/wip/CLN1-r1:draft.txt'), 'saved wip draft\n');
});

test('7. silent end raises a silent-end tick problem and an immediate serve.notice via the coordinator process-gone path, while report ends do not', async () => {
  const { dir } = tempOrders();
  const repo = path.join(dir, 'repo');
  initRepo(repo);
  const wtSil = path.join(dir, 'demo-sil1');
  git(repo, 'worktree', 'add', '-q', '-b', 'demo-sil1', wtSil, 'main');
  writeFileSync(path.join(wtSil, 'partial.txt'), 'half-done work\n');

  const cfg = validateProject({
    id: 'demo', name: 'Demo', root: repo, work_orders: repo, state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: dir, base_ref: 'refs/heads/main' },
  }, path.join(dir, 'alba.yaml'));
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', enabled: false }] }, path.join(dir, 'workers.yaml'));
  const orders = new Orders(testStore(cfg.state_dir));

  // SIL1: open run whose process died mid-turn.
  orders.add({ tag: 'SIL1', title: 'Silent cut-off', kind: 'sim', worktree: wtSil, branch: 'demo-sil1' });
  orders.act('SIL1', 'queue');
  const silEvents = path.join(dir, 'SIL1-r1.events.jsonl');
  writeFileSync(silEvents, readFileSync(path.join(FIXTURES_DIR, 'mid-turn.events.jsonl')));
  orders.runStart('SIL1', { worker: 'coder', extra: { pid: 88001, cwd: wtSil, events_file: silEvents, engine: 'codex-cli' } });

  // OK1: open run whose process ended cleanly with a valid report block.
  orders.add({ tag: 'OK1', title: 'Normal report', kind: 'sim' });
  orders.act('OK1', 'queue');
  const okLast = path.join(repo, 'OK1.last.txt');
  const okStarted = new Date(Date.now() - 10_000).toISOString();
  writeFileSync(okLast, `Done.\n${REPORT_BEGIN}\n{"status":"ready","summary":"all good","question":"","evidence":[],"commits":[]}\n${REPORT_END}\n`);
  const { run: okRun } = orders.runStart('OK1', { worker: 'coder', extra: { pid: 88002, last_file: okLast, engine: 'codex-cli' } });
  orders.patchRun('OK1', okRun.id, { started: okStarted });

  // Hold alive=true until the initial start tick completes, then flip alive=false so ONLY the watcher + followUp path
  // can detect the gone processes (the next scheduled tick is 15 minutes away).
  let alive = true;
  const probes: Probes = {
    now: () => new Date(),
    isAlive: () => alive,
    tail: systemProbes.tail,
    head: systemProbes.head,
    readText: systemProbes.readText,
    fileTime: systemProbes.fileTime,
    runCommand: () => '[]',
    freeRamGb: () => 32,
    worktrees: () => [],
    gitActivity: () => ({}),
    spawnDetached: () => 1,
  };
  const printed: string[] = [];
  const serve = startServe({
    projects: [cfg],
    workers,
    port: 0,
    probes,
    everyMinutes: 15,
    maxDispatch: 0,
    watchMs: 40,
    followUpMs: 40,
    eventMs: 200,
    print: line => printed.push(line),
    reloadConfigs: false,
  });

  try {
    await new Promise<void>(resolve => serve.server.once('listening', resolve));
    const port = (serve.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'x-alba-token': serve.board.ctx.token };
    const stream = await openStream(base, 'project=demo', headers);
    try {
      const hello = await stream.next(5000);
      assert.equal(hello.event, 'hello');

      // Wait for the one-shot startup tick while both processes are still alive; after this, the scheduled loop will not fire for 15 min.
      for (;;) {
        const frame = await stream.next(5000);
        if (frame.event === 'tick.done' && frame.data?.source === 'start') break;
      }

      // Flip both worker processes to gone: the watcher + followUp path must emit serve.notice and tick.done(source: "finish") well under 15 min.
      alive = false;
      const frames: { event: string; data: Record<string, unknown> }[] = [];
      let sawFinishTick = false;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const frame = await stream.next(5000);
        frames.push(frame);
        if (frame.event === 'tick.done' && frame.data?.source === 'finish') {
          sawFinishTick = true;
          break;
        }
      }
      assert.equal(sawFinishTick, true, 'coordinator process-gone watcher must run finish tick without waiting 15 min');

      const notices = frames.filter(f => f.event === 'serve.notice').map(f => f.data);
      const silNotice = notices.find(n => n.kind === 'silent-end' && n.tag === 'SIL1');
      assert.ok(silNotice, `expected silent-end serve.notice for SIL1, got ${JSON.stringify(notices)}`);
      assert.match(String(silNotice.text), /stream-cut-mid-turn/);
      assert.match(String(silNotice.text), /refs\/alba\/wip\/SIL1-r1/);
      assert.equal(notices.some(n => n.tag === 'OK1'), false, 'report end must not emit a silent-end notice');

      // Verify tick() and /api/overview include the silent-end problem for SIL1 and not for OK1.
      const tickRes = tick(cfg, new Orders(testStore(cfg.state_dir)), workers, probes, { record: false });
      const silProblems = tickRes.report.problems.filter(p => p.kind === 'silent-end');
      assert.equal(silProblems.length, 1);
      assert.equal(silProblems[0]!.tag, 'SIL1');
      assert.match(silProblems[0]!.text, /stream-cut-mid-turn/);
      assert.match(silProblems[0]!.text, /refs\/alba\/wip\/SIL1-r1/);

      const ovResp = await fetch(`${base}/api/overview?project=demo`, { headers });
      assert.equal(ovResp.status, 200);
      const ov = (await ovResp.json()) as { problems: { items: { kind: string; tag?: string; text: string }[] } };
      assert.ok(ov.problems.items.some(p => p.kind === 'silent-end' && p.tag === 'SIL1'));
      assert.equal(ov.problems.items.some(p => p.kind === 'silent-end' && p.tag === 'OK1'), false);
    } finally {
      stream.close();
    }
  } finally {
    await serve.stop();
  }
});
