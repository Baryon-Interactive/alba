import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import type { RunTranscript, TranscriptEntry } from '../src/api/types.ts';
import { stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import {
  ENDED_CACHE_TTL_MS,
  INPUT_CAP_BYTES,
  TEXT_CAP_BYTES,
  TranscriptFold,
  TranscriptRuns,
  unifiedDiff,
} from '../src/run/transcript.ts';
import { systemProbes } from '../src/tick/gather.ts';
import { createBoard, type Board } from '../src/web/server.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { openStream } from './helpers.ts';
import { validateProject } from './state-helper.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const FIXED_AT = '2026-02-10T12:00:00.000Z';

const prevMachineDir = process.env.ALBA_MACHINE_DIR;
const prevLockDir = process.env.ALBA_LOCK_DIR;
const sandboxRoot = mkdtempSync(path.join(tmpdir(), 'alba-transcript-env-'));
process.env.ALBA_MACHINE_DIR = path.join(sandboxRoot, 'machine');
process.env.ALBA_LOCK_DIR = path.join(sandboxRoot, 'locks');

const boards: Board[] = [];
const closeBoards = () => {
  for (const b of boards.splice(0)) {
    b.hub.stop();
    b.server.closeAllConnections();
    b.server.close();
  }
};
afterEach(closeBoards);
after(() => {
  closeBoards();
  if (prevMachineDir === undefined) delete process.env.ALBA_MACHINE_DIR;
  else process.env.ALBA_MACHINE_DIR = prevMachineDir;
  if (prevLockDir === undefined) delete process.env.ALBA_LOCK_DIR;
  else process.env.ALBA_LOCK_DIR = prevLockDir;
});

function foldText(raw: string, at = FIXED_AT): TranscriptFold {
  const fold = new TranscriptFold();
  fold.push(raw, at);
  return fold;
}

test('Codex dialect: reasoning, plan pairing, full successful command output, search, mcp tool, edit diff, message and unknown events', () => {
  const raw = readFileSync(path.join(FIXTURES, 'transcript-codex.jsonl'), 'utf8');
  const fold = new TranscriptFold();
  const lines = raw.trim().split('\n');

  // Feed up to cmd1 started (`running`) and verify pairing transitions `running` -> `done` keeping seq.
  for (const line of lines.slice(0, 6)) fold.line(line, FIXED_AT);
  const mid = fold.entries();
  assert.deepEqual(mid.map(e => [e.seq, e.kind, e.state]), [
    [0, 'reasoning', 'done'],
    [1, 'plan', 'running'],
    [2, 'command', 'running'],
  ]);
  assert.equal(mid[0].text, 'Inspecting src/main.c before compiling.\nChecking return code handling.');

  for (const line of lines.slice(6)) fold.line(line, FIXED_AT);
  const entries = fold.entries();
  assert.deepEqual(entries.map(e => [e.seq, e.kind, e.state]), [
    [0, 'reasoning', 'done'],
    [1, 'plan', 'done'],
    [2, 'command', 'done'],
    [3, 'search', 'done'],
    [4, 'tool', 'done'],
    [5, 'edit', 'done'],
    [6, 'message', 'done'],
  ]);

  // Successful command keeps its full output, exit code, and computed duration.
  const cmd = entries[2];
  assert.equal(cmd.title, 'pwsh -File build.ps1');
  assert.equal(cmd.exit_code, 0);
  assert.equal(cmd.output, 'Compiling src/main.c\nLinked demo.exe (0 warnings)\n');
  assert.equal(cmd.duration_seconds, 2.5);

  // Plan updated in place at seq 1.
  assert.deepEqual(entries[1].plan, [
    { step: 'Compile src/main.c', status: 'done' },
    { step: 'Run smoke check', status: 'done' },
  ]);

  // Search and MCP tool entries.
  assert.equal(entries[3].title, 'c11 stdatomic memory_order_acq_rel');
  assert.equal(entries[4].title, 'docs.lookup');
  assert.deepEqual(entries[4].input, { symbol: 'atomic_fetch_add' });
  assert.equal(entries[4].output, 'atomic_fetch_add(obj, arg)');

  // File change builds unified diff from before/after.
  assert.equal(entries[5].edit?.[0].path, 'src/main.c');
  assert.match(entries[5].edit?.[0].diff ?? '', /--- a\/src\/main\.c\n\+\+\+ b\/src\/main\.c[\s\S]*-int count = 0;\n\+int count = 1;/);

  // Also check existing codex-turns.jsonl fixture folds cleanly.
  const turns = foldText(readFileSync(path.join(FIXTURES, 'codex-turns.jsonl'), 'utf8')).entries();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, 'command');
  assert.equal(turns[0].output, 'src/example.ts');
});

test('Claude dialect: thinking, text, Edit turned into unified diff, Write, paired tool_use/tool_result and final result usage', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: 's-demo' },
    {
      type: 'assistant',
      alba_at: '2026-02-10T11:00:00.000Z',
      message: {
        id: 'm1',
        content: [
          { type: 'thinking', thinking: 'Need to update greeting in src/main.c and run tests.' },
          { type: 'text', text: 'Updating `src/main.c` first.' },
          {
            type: 'tool_use',
            id: 'tu-edit',
            name: 'Edit',
            input: { file_path: 'src/main.c', old_string: 'const char *msg = "old";\nint ok = 1;\n', new_string: 'const char *msg = "new";\nint ok = 1;\n' },
          },
          {
            type: 'tool_use',
            id: 'tu-bash',
            name: 'Bash',
            input: { command: 'node --test test/smoke.test.js' },
          },
        ],
      },
    },
    {
      type: 'user',
      alba_at: '2026-02-10T11:00:01.000Z',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-edit', content: 'Updated src/main.c' },
        ],
      },
    },
    {
      type: 'user',
      alba_at: '2026-02-10T11:00:03.000Z',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-bash', is_error: true, content: [{ type: 'text', text: 'FAIL: expected 0 got 1' }] },
        ],
      },
    },
    {
      type: 'result',
      alba_at: '2026-02-10T11:00:04.000Z',
      subtype: 'success',
      num_turns: 2,
      total_cost_usd: 0.042,
      usage: { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 200 },
      result: 'Finished investigating.',
    },
  ];

  const fold = new TranscriptFold();
  fold.event(events[0], FIXED_AT);
  fold.event(events[1], FIXED_AT);
  // Before user tool_result arrives, both tool_use entries are `running`.
  assert.deepEqual(fold.entries().map(e => [e.seq, e.kind, e.state]), [
    [0, 'reasoning', 'done'],
    [1, 'message', 'done'],
    [2, 'edit', 'running'],
    [3, 'command', 'running'],
  ]);

  for (const ev of events.slice(2)) fold.event(ev, FIXED_AT);
  const out = fold.entries();
  assert.deepEqual(out.map(e => [e.seq, e.kind, e.state]), [
    [0, 'reasoning', 'done'],
    [1, 'message', 'done'],
    [2, 'edit', 'done'],
    [3, 'command', 'failed'],
    [4, 'result', 'done'],
  ]);

  const edit = out[2].edit?.[0];
  assert.ok(edit?.diff);
  assert.equal(edit.path, 'src/main.c');
  assert.match(edit.diff, /--- a\/src\/main\.c\n\+\+\+ b\/src\/main\.c\n@@ -1,2 \+1,2 @@\n-const char \*msg = "old";\n\+const char \*msg = "new";\n int ok = 1;/);
  assert.equal(out[3].output, 'FAIL: expected 0 got 1');
  assert.equal(out[3].duration_seconds, 3);
  assert.equal(out[4].usage?.cost_usd, 0.042);
  assert.equal(out[4].usage?.turns, 2);

  // Also check existing claude-stream.jsonl fixture.
  const streamEntries = foldText(readFileSync(path.join(FIXTURES, 'claude-stream.jsonl'), 'utf8')).entries();
  assert.deepEqual(streamEntries.map(e => [e.kind, e.state]), [
    ['message', 'done'],
    ['command', 'failed'],
    ['command', 'failed'],
    ['command', 'failed'],
    ['message', 'done'],
    ['result', 'done'],
  ]);
});

test('agy dialect: empty agent_response skipped, streaming text_delta joined by step_index, paired tool/edit/command, error and result', () => {
  const raw = readFileSync(path.join(FIXTURES, 'transcript-agy.jsonl'), 'utf8');
  const lines = raw.trim().split('\n');
  const fold = new TranscriptFold();

  // Feed through first ACTIVE text_delta and ACTIVE edit_file.
  for (const l of lines.slice(0, 7)) fold.line(l, FIXED_AT);
  assert.deepEqual(fold.entries().map(e => [e.seq, e.kind, e.state, e.title]), [
    [0, 'message', 'done', 'Checking src/main.c now.'],
    [1, 'edit', 'running', 'edit_file src/main.c'],
  ]);

  for (const l of lines.slice(7)) fold.line(l, FIXED_AT);
  const out = fold.entries();
  assert.deepEqual(out.map(e => [e.seq, e.kind, e.state]), [
    [0, 'message', 'done'],
    [1, 'edit', 'done'],
    [2, 'command', 'done'],
    [3, 'error', 'failed'],
    [4, 'result', 'done'],
  ]);
  assert.equal(out[0].text, 'Checking src/main.c now.');
  assert.match(out[1].edit?.[0].diff ?? '', /-return 1;\n\+return 0;/);
  assert.equal(out[2].output, 'Build succeeded: 0 errors\n');
  assert.equal(out[2].duration_seconds, 1.2);
  assert.equal(out[3].text, 'Transient warning from tool channel');
  assert.equal(out[4].usage?.total_tokens, 460);
  assert.equal(out[4].usage?.turns, 2);
});

test('OpenCode and Grok dialects: part pairing, streaming Grok text deltas, tool_call updates and end usage', () => {
  const openCodeEvents = [
    { type: 'step_start', timestamp: 1700000000000, part: { id: 'p0', type: 'step-start' } },
    { type: 'text', timestamp: 1700000000100, part: { id: 'p-ws', type: 'text', text: '   ' } },
    { type: 'reasoning', timestamp: 1700000000200, part: { id: 'p-r1', type: 'reasoning', text: 'Checking config paths.' } },
    { type: 'tool_use', timestamp: 1700000001000, part: { id: 'call-1', tool: 'bash', state: { status: 'running', input: { command: 'pnpm test' } } } },
    { type: 'tool_use', timestamp: 1700000002500, part: { id: 'call-1', tool: 'bash', state: { status: 'completed', input: { command: 'pnpm test' }, output: '12 passed\n', metadata: { exit: 0 }, time: { start: 1700000001000, end: 1700000002500 } } } },
    { type: 'tool_use', timestamp: 1700000003000, part: { id: 'call-2', tool: 'edit', state: { status: 'completed', input: { filePath: 'src/app.ts', oldString: 'a = 1;\n', newString: 'a = 2;\n' }, output: 'Applied' } } },
    { type: 'text', timestamp: 1700000004000, part: { id: 'p-t1', type: 'text', text: 'All tests green.' } },
    { type: 'step_finish', timestamp: 1700000004100, part: { id: 'p-end', type: 'step-finish', tokens: { total: 300, input: 250, output: 50 } } },
  ];
  const ocFold = new TranscriptFold();
  for (const ev of openCodeEvents) ocFold.event(ev, FIXED_AT);
  const oc = ocFold.entries();
  assert.deepEqual(oc.map(e => [e.seq, e.kind, e.state]), [
    [0, 'reasoning', 'done'],
    [1, 'command', 'done'],
    [2, 'edit', 'done'],
    [3, 'message', 'done'],
  ]);
  assert.equal(oc[1].output, '12 passed\n');
  assert.equal(oc[1].exit_code, 0);
  assert.equal(oc[1].duration_seconds, 1.5);
  assert.match(oc[2].edit?.[0].diff ?? '', /-a = 1;\n\+a = 2;/);

  // Grok fixture + tool_call pairing
  const grokDone = foldText(readFileSync(path.join(FIXTURES, 'grok-done.log'), 'utf8')).entries();
  assert.deepEqual(grokDone.map(e => [e.seq, e.kind, e.state]), [
    [0, 'message', 'done'],
    [1, 'result', 'done'],
  ]);
  assert.equal(grokDone[0].text, 'resumed ok.');
  assert.equal(grokDone[1].usage?.total_tokens, 19125);

  const grokTools = [
    { type: 'text', data: 'Running ' },
    { type: 'text', data: 'check.' },
    { type: 'tool_call', toolCallId: 'g-1', kind: 'execute', toolName: 'run_terminal_command', rawInput: { command: 'git status --short' } },
    { type: 'tool_call_update', toolCallId: 'g-1', status: 'in_progress', rawOutput: { output_for_prompt: 'M src/main.c\n' } },
    { type: 'tool_call_update', toolCallId: 'g-1', status: 'completed', rawOutput: { output_for_prompt: 'M src/main.c\n', exit_code: 0 } },
    { type: 'end', stopReason: 'end_turn', num_turns: 1, total_cost_usd: 0.02, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
  ];
  const gFold = new TranscriptFold();
  for (const ev of grokTools) gFold.event(ev, FIXED_AT);
  const gEntries = gFold.entries();
  assert.deepEqual(gEntries.map(e => [e.seq, e.kind, e.state]), [
    [0, 'message', 'done'],
    [1, 'command', 'done'],
    [2, 'result', 'done'],
  ]);
  assert.equal(gEntries[0].text, 'Running check.');
  assert.equal(gEntries[1].output, 'M src/main.c\n');
  assert.equal(gEntries[1].exit_code, 0);
});

test('plain-text logs: consecutive lines group up to 200 per entry and preserve ANSI codes', () => {
  const lines = [
    '\x1b[32m[1/250]\x1b[0m Compiling alpha.c',
    ...Array.from({ length: 249 }, (_, i) => `[${i + 2}/250] Compiling unit_${i + 2}.c`),
  ];
  const entries = foldText(lines.join('\n') + '\n').entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'log');
  assert.equal(entries[0].title, '[1/250] Compiling alpha.c');
  assert.ok(entries[0].text?.includes('\x1b[32m[1/250]\x1b[0m'));
  assert.equal(entries[0].text?.split('\n').length, 200);
  assert.equal(entries[1].kind, 'log');
  assert.equal(entries[1].text?.split('\n').length, 50);
});

test('caps and 5,000-entry bound: 64 KiB text/output cap, 16 KiB input cap, and dropping oldest log/reasoning first', () => {
  const headPart = 'HEAD-START-' + 'a'.repeat(20 * 1024);
  const midPart = 'MIDDLE-' + 'm'.repeat(30 * 1024);
  const tailPart = 'b'.repeat(55 * 1024) + '-TAIL-END';
  const hugeOutput = headPart + midPart + tailPart;
  const hugeParam = 'PARAM-HEAD-' + 'p'.repeat(24 * 1024) + '-PARAM-TAIL';

  const fold = new TranscriptFold();
  fold.event(
    {
      type: 'assistant',
      alba_at: FIXED_AT,
      message: {
        id: 'm-cap',
        content: [{ type: 'tool_use', id: 'tu-cap', name: 'Bash', input: { command: 'run-big', script: hugeParam } }],
      },
    },
    FIXED_AT,
  );
  fold.event(
    {
      type: 'user',
      alba_at: FIXED_AT,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-cap', content: hugeOutput }] },
    },
    FIXED_AT,
  );

  const [entry] = fold.entries();
  assert.equal(entry.truncated, true);
  assert.ok(entry.output);
  assert.ok(Buffer.byteLength(entry.output, 'utf8') <= TEXT_CAP_BYTES);
  assert.ok(entry.output.startsWith('HEAD-START-'));
  assert.ok(entry.output.endsWith('-TAIL-END'));
  assert.match(entry.output, /\.\.\. \[truncated \d+ bytes\] \.\.\./);

  const cappedScript = String(entry.input?.script ?? '');
  assert.ok(Buffer.byteLength(cappedScript, 'utf8') <= INPUT_CAP_BYTES);
  assert.ok(cappedScript.startsWith('PARAM-HEAD-'));
  assert.ok(cappedScript.endsWith('-PARAM-TAIL'));
  assert.match(cappedScript, /\.\.\. \[truncated \d+ bytes\] \.\.\./);

  // 5,000-entry limit drops oldest `log` and `reasoning` entries before commands/messages.
  const bounded = new TranscriptFold();
  bounded.event({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'keep-cmd-0', type: 'command_execution', command: 'echo first', exit_code: 0, aggregated_output: 'first' } }, FIXED_AT);
  bounded.line('plain log line to drop first', FIXED_AT);
  bounded.event({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'drop-reason-2', type: 'reasoning', text: 'reasoning to drop second' } }, FIXED_AT);
  bounded.event({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'keep-msg-3', type: 'agent_message', text: 'keep this early message' } }, FIXED_AT);
  for (let i = 0; i < 4998; i++) {
    bounded.event({ type: 'item.completed', alba_at: FIXED_AT, item: { id: `m-${i}`, type: 'agent_message', text: `msg ${i}` } }, FIXED_AT);
  }

  assert.equal(bounded.total, 5002);
  assert.equal(bounded.dropped, 2);
  const kept = bounded.entries();
  assert.equal(kept.length, 5000);
  // seq 0 (command) and seq 3 (message) survived; seq 1 (log) and seq 2 (reasoning) were dropped first!
  assert.equal(kept[0].seq, 0);
  assert.equal(kept[0].kind, 'command');
  assert.equal(kept[1].seq, 3);
  assert.equal(kept[1].kind, 'message');
});

test('chunk-independence, partial UTF-8 last line, rotation rebuild and 10-minute ended-run cache eviction', () => {
  // Include multi-byte UTF-8 characters (em-dash, box-drawing, math symbols) in messages and diffs.
  const mixed = [
    readFileSync(path.join(FIXTURES, 'transcript-codex.jsonl'), 'utf8').trim(),
    readFileSync(path.join(FIXTURES, 'transcript-agy.jsonl'), 'utf8').trim(),
    JSON.stringify({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'utf8', type: 'agent_message', text: 'Symbols: — ✓ Δ λ box ─│┌┐' } }),
    'Plain build line 1 — ok',
    'Plain build line 2 — done',
  ].join('\n') + '\n';

  const whole = foldText(mixed, FIXED_AT).entries();

  // Feed 1 byte at a time through TranscriptFold.push (splits multi-byte UTF-8 sequences across chunks).
  const byteFold = new TranscriptFold();
  const rawBytes = Buffer.from(mixed, 'utf8');
  for (let i = 0; i < rawBytes.length; i++) {
    byteFold.push(rawBytes.subarray(i, i + 1), FIXED_AT);
  }
  assert.deepEqual(byteFold.entries(), whole);

  // Feed prime-sized chunks (7 bytes, 31 bytes) as well.
  for (const step of [7, 31]) {
    const chunkFold = new TranscriptFold();
    for (let i = 0; i < rawBytes.length; i += step) {
      chunkFold.push(rawBytes.subarray(i, Math.min(rawBytes.length, i + step)), FIXED_AT);
    }
    assert.deepEqual(chunkFold.entries(), whole);
  }

  // Incremental file reader: partial last line, completion, rotation (both shrink and larger overwrite), and TTL eviction.
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-transcript-runs-'));
  const file = path.join(dir, 'T1-r1.events.jsonl');
  const line1 = JSON.stringify({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'a', type: 'agent_message', text: 'First step' } });
  const line2 = JSON.stringify({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'b', type: 'agent_message', text: 'Second — step' } });
  const buf2 = Buffer.from(line2 + '\n', 'utf8');
  const half = Math.floor(buf2.length / 2);

  writeFileSync(file, Buffer.concat([Buffer.from(line1 + '\n', 'utf8'), buf2.subarray(0, half)]));
  const reader = new TranscriptRuns();
  const p1 = reader.page(file, { now: new Date('2026-02-10T12:00:00Z') });
  assert.equal(p1.entries.length, 1);
  assert.equal(p1.entries[0].text, 'First step');

  appendFileSync(file, buf2.subarray(half));
  const p2 = reader.page(file, { now: new Date('2026-02-10T12:00:01Z') });
  assert.equal(p2.entries.length, 2);
  assert.equal(p2.entries[1].text, 'Second — step');

  // Byte-by-byte file appends produce identical entries to reading the whole file at once.
  const byteFile = path.join(dir, 'byte-by-byte.events.jsonl');
  writeFileSync(byteFile, '');
  const fixedMtime = new Date(FIXED_AT);
  const byteReader = new TranscriptRuns();
  for (let i = 0; i < rawBytes.length; i += 29) {
    appendFileSync(byteFile, rawBytes.subarray(i, Math.min(rawBytes.length, i + 29)));
    utimesSync(byteFile, fixedMtime, fixedMtime);
    byteReader.sync(byteFile);
  }
  assert.deepEqual(byteReader.page(byteFile, { limit: 1000 }).entries, whole);

  // Rotation 1: file shrinks.
  const rotatedSmaller = JSON.stringify({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'r-small', type: 'agent_message', text: 'Rotated small' } }) + '\n';
  writeFileSync(file, rotatedSmaller);
  const p3 = reader.page(file, { now: new Date('2026-02-10T12:00:02Z') });
  assert.equal(p3.entries.length, 1);
  assert.equal(p3.entries[0].text, 'Rotated small');

  // Rotation 2: file overwritten in place with larger content (header changes).
  const rotatedLarger = [
    JSON.stringify({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'r-big-1', type: 'agent_message', text: 'Rotated larger one with extra text' } }),
    JSON.stringify({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'r-big-2', type: 'agent_message', text: 'Rotated larger two with extra text' } }),
  ].join('\n') + '\n';
  writeFileSync(file, rotatedLarger);
  const p4 = reader.page(file, { ended: true, now: new Date('2026-02-10T12:00:03Z') });
  assert.equal(p4.entries.length, 2);
  assert.equal(p4.entries[0].text, 'Rotated larger one with extra text');

  // Ended run stays cached before 10 minutes, and is evicted once unread for >= 10 minutes while active run stays.
  const activeFile = path.join(dir, 'active.events.jsonl');
  writeFileSync(activeFile, rotatedSmaller);
  const t0 = Date.parse('2026-02-10T12:00:03Z');
  reader.page(activeFile, { ended: false, now: new Date(t0) });
  const beforeCount = reader.cacheCount();
  reader.evict(t0 + ENDED_CACHE_TTL_MS - 1000);
  assert.equal(reader.cacheCount(), beforeCount);
  reader.evict(t0 + ENDED_CACHE_TTL_MS + 1000);
  assert.equal(reader.cacheCount(), beforeCount - 1);

  // Sanity check unifiedDiff on identical input returns empty string.
  assert.equal(unifiedDiff('src/main.c', 'same\n', 'same\n'), '');
});

test('API route and SSE stream: paging, backwards next, running-before-after rule, 404 without file, and live run.transcript events', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-transcript-api-'));
  const root = path.join(dir, 'repo');
  const workOrders = path.join(dir, 'orders');
  const stateDir = path.join(dir, 'state');
  mkdirSync(root, { recursive: true });
  mkdirSync(workOrders, { recursive: true });

  const config = validateProject(
    { id: 'demo', name: 'Demo', root, work_orders: workOrders, state_dir: stateDir },
    path.join(dir, 'alba.yaml'),
  );
  const workers = validateWorkers({ workers: [{ id: 'coder', engine: 'codex-cli', launch: { program: 'codex', args: ['exec', '{prompt_file}'] } }] }, path.join(dir, 'workers.yaml'));
  const orders = new Orders(stateStore(config));

  orders.add({ tag: 'T1', title: 'Live transcript order', kind: 'code' });
  orders.act('T1', 'queue');
  const eventsFile = path.join(dir, 'T1-r1.events.jsonl');
  // Seed 6 entries: seq 0..5, where seq 1 is still `running` (`cmd-open` without `item.completed`)!
  const seedLines = [
    { type: 'item.completed', alba_at: FIXED_AT, item: { id: 'm0', type: 'agent_message', text: 'Step 0' } },
    { type: 'item.started', alba_at: FIXED_AT, item: { id: 'cmd-open', type: 'command_execution', command: 'pwsh -File build.ps1' } },
    { type: 'item.completed', alba_at: FIXED_AT, item: { id: 'm2', type: 'agent_message', text: 'Step 2' } },
    { type: 'item.completed', alba_at: FIXED_AT, item: { id: 'm3', type: 'agent_message', text: 'Step 3' } },
    { type: 'item.completed', alba_at: FIXED_AT, item: { id: 'm4', type: 'agent_message', text: 'Step 4' } },
    { type: 'item.completed', alba_at: FIXED_AT, item: { id: 'm5', type: 'agent_message', text: 'Step 5' } },
  ];
  writeFileSync(eventsFile, seedLines.map(e => JSON.stringify(e)).join('\n') + '\n');
  orders.runStart('T1', { worker: 'coder', extra: { events_file: eventsFile, pid: 12345 } });

  orders.add({ tag: 'T2', title: 'Imported order without file', kind: 'code' });
  orders.act('T2', 'queue');
  orders.runStart('T2', { worker: 'coder' });

  const board = createBoard({
    projects: [config],
    workers,
    port: 0,
    probes: { ...systemProbes, isAlive: () => true },
    uiDir: path.join(dir, 'no-ui'),
    hubCheckMs: 20,
    background: false,
    signIn: false,
  });
  boards.push(board);
  await new Promise<void>(resolve => board.server.once('listening', resolve));
  const base = `http://127.0.0.1:${(board.server.address() as AddressInfo).port}`;

  const getJson = async (urlPath: string): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${urlPath}`);
    return { status: res.status, body: await res.json() };
  };

  // 404 when run has no file or run does not exist.
  const missingFile = await getJson('/api/runs/T2:r1/transcript?project=demo');
  assert.equal(missingFile.status, 404);
  assert.match(missingFile.body.error.message, /T2:r1/);
  assert.equal((await getJson('/api/runs/NOPE:r1/transcript?project=demo')).status, 404);
  assert.equal((await getJson('/api/runs/T1:r1/transcript?project=demo&after=-1')).status, 400);

  // Without `after`, returns the last `limit` entries and `next` points backwards so the UI can page up.
  const tailPage = await getJson('/api/runs/T1:r1/transcript?project=demo&limit=2');
  assert.equal(tailPage.status, 200);
  const tailBody = tailPage.body as RunTranscript;
  assert.equal(tailBody.project, 'demo');
  assert.equal(tailBody.key, 'T1:r1');
  assert.equal(tailBody.total, 6);
  assert.equal(tailBody.dropped, 0);
  assert.equal(tailBody.ended, false);
  assert.deepEqual(tailBody.entries.map(e => e.seq), [4, 5]);
  assert.equal(tailBody.next, 2);

  // Page backwards using `after=next&limit=2`: gets seq 2..3 PLUS seq 1 because seq 1 is still `running` before `after`!
  const midPage = await getJson(`/api/runs/T1:r1/transcript?project=demo&after=${tailBody.next}&limit=2`);
  assert.equal(midPage.status, 200);
  const midBody = midPage.body as RunTranscript;
  assert.deepEqual(midBody.entries.map(e => [e.seq, e.state]), [
    [1, 'running'],
    [2, 'done'],
    [3, 'done'],
  ]);
  assert.equal(midBody.next, 0);

  // Page backwards to the very beginning (`after=0&limit=2`): gets seq 0..1 and `next` is now absent (`undefined`).
  const topPage = await getJson(`/api/runs/T1:r1/transcript?project=demo&after=${midBody.next}&limit=2`);
  const topBody = topPage.body as RunTranscript;
  assert.deepEqual(topBody.entries.map(e => e.seq), [0, 1]);
  assert.equal(topBody.next, undefined);

  // Subscribe to `/api/stream` with `transcripts=T1:r1@6`.
  const s = await openStream(base, `project=demo&transcripts=T1:r1@${tailBody.total}`);
  const hello = await s.next();
  assert.equal(hello.event, 'hello');

  // Append completion of `cmd-open` (seq 1) AND a new message (seq 6), plus a partial line without newline.
  appendFileSync(
    eventsFile,
    [
      JSON.stringify({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'cmd-open', type: 'command_execution', command: 'pwsh -File build.ps1', exit_code: 0, status: 'completed', aggregated_output: 'Build green\n' } }),
      JSON.stringify({ type: 'item.completed', alba_at: FIXED_AT, item: { id: 'm6', type: 'agent_message', text: 'Step 6 live' } }),
    ].join('\n') + '\n{"type":"item.completed","item":{"id":"m7","type":"agent_message","text":"Part',
  );
  board.hub.scan();

  const update1 = await s.next();
  assert.equal(update1.event, 'run.transcript');
  assert.equal(update1.data.project, 'demo');
  assert.equal(update1.data.key, 'T1:r1');
  assert.deepEqual(
    (update1.data.entries as TranscriptEntry[]).map(e => [e.seq, e.kind, e.state, e.output ?? e.text]),
    [
      [1, 'command', 'done', 'Build green\n'],
      [6, 'message', 'done', 'Step 6 live'],
    ],
  );

  // Finish the partial trailing line: now seq 7 arrives.
  appendFileSync(eventsFile, 'ial completed"}}\n');
  board.hub.scan();
  const update2 = await s.next();
  assert.equal(update2.event, 'run.transcript');
  assert.deepEqual(
    (update2.data.entries as TranscriptEntry[]).map(e => [e.seq, e.text]),
    [[7, 'Partial completed']],
  );

  // Now that seq 1 (`cmd-open`) is `done`, requesting `?after=5` no longer includes seq 1.
  const afterDone = await getJson('/api/runs/T1:r1/transcript?project=demo&after=5');
  assert.deepEqual((afterDone.body as RunTranscript).entries.map(e => e.seq), [5, 6, 7]);

  s.close();
});
