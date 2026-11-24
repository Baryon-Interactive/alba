// Fake Codex app-server for test/codex-app.test.ts.
// Speaks the JSON-RPC stdio protocol of `codex app-server` (verified on codex-cli 0.167.2).
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_APP_MODE ?? 'ok';
const logFile = process.env.FAKE_CODEX_APP_LOG;
const pidFile = process.env.FAKE_CODEX_APP_PID;

if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8');
const record = entry => { if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8'); };
const emit = msg => process.stdout.write(JSON.stringify(msg) + '\n');

record({ event: 'spawn', pid: process.pid, args, cwd: process.cwd() });

let threadId = 'thread-fake-1';
let turnNum = 0;
let activeTurn = null;
let totalIn = 0;
let totalCached = 0;
let totalOut = 0;

function reportBlock(summary) {
  return `${summary}\n\n--- alba-report ---\n${JSON.stringify({ status: 'ready', summary, evidence: [], commits: [] })}\n--- end ---`;
}

function finishTurn(tid, summary) {
  totalIn += 500;
  totalCached += 200;
  totalOut += 80;
  emit({ method: 'item/completed', params: { threadId, turnId: tid, item: { id: `msg-${tid}`, type: 'agentMessage', text: reportBlock(summary) } } });
  emit({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId: tid,
      tokenUsage: {
        total: { totalTokens: totalIn + totalOut, inputTokens: totalIn, cachedInputTokens: totalCached, cacheWriteInputTokens: 0, outputTokens: totalOut, reasoningOutputTokens: 10 },
        last: { totalTokens: 580, inputTokens: 500, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 80, reasoningOutputTokens: 10 },
        modelContextWindow: 200000,
      },
    },
  });
  activeTurn = null;
  emit({ method: 'turn/completed', params: { threadId, turn: { id: tid, status: 'completed', error: null } } });
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  record(req);

  if (req.method === 'initialize') {
    emit({ id: req.id, result: { userAgent: 'fake-codex-app/1.0' } });
    return;
  }
  if (req.method === 'initialized') return;

  if (req.method === 'thread/start') {
    emit({ id: req.id, result: { thread: { id: threadId }, model: req.params?.model ?? 'gpt-test', cwd: req.params?.cwd } });
    return;
  }
  if (req.method === 'thread/resume') {
    threadId = req.params?.threadId ?? threadId;
    emit({ id: req.id, result: { thread: { id: threadId }, model: req.params?.model ?? 'gpt-test', cwd: req.params?.cwd } });
    return;
  }
  if (req.method === 'turn/start') {
    turnNum++;
    const tid = `turn-${turnNum}`;
    activeTurn = tid;
    emit({ id: req.id, result: { turn: { id: tid, status: 'inProgress', items: [], error: null } } });
    emit({ method: 'turn/started', params: { threadId, turn: { id: tid } } });

    if (mode === 'fail') {
      activeTurn = null;
      emit({ method: 'turn/completed', params: { threadId, turn: { id: tid, status: 'failed', error: { message: 'Synthetic model failure' } } } });
      return;
    }
    if (mode === 'hang') {
      emit({ method: 'item/started', params: { threadId, turnId: tid, item: { id: 'cmd-hang', type: 'commandExecution', command: 'sleep forever', status: 'inProgress' } } });
      return;
    }
    if ((mode === 'steer' || mode === 'refused-steer') && turnNum === 1) {
      emit({ method: 'item/started', params: { threadId, turnId: tid, item: { id: 'cmd-1', type: 'commandExecution', command: 'build.ps1', status: 'inProgress' } } });
      return;
    }
    const text = req.params?.input?.[0]?.text ?? '';
    emit({ method: 'item/started', params: { threadId, turnId: tid, item: { id: `cmd-${tid}`, type: 'commandExecution', command: 'echo ok', status: 'inProgress' } } });
    emit({ method: 'item/completed', params: { threadId, turnId: tid, item: { id: `cmd-${tid}`, type: 'commandExecution', command: 'echo ok', exitCode: 0, status: 'completed', aggregatedOutput: 'ok\n' } } });
    const summary = turnNum === 1 ? 'First turn done' : `Follow-up turn ${turnNum}: ${text.split('\n')[1] ?? text}`;
    setTimeout(() => finishTurn(tid, summary), 30);
    return;
  }
  if (req.method === 'turn/steer') {
    const tid = req.params?.expectedTurnId;
    if (mode === 'refused-steer') {
      // Simulate race: turn finished just before steer arrived
      emit({ id: req.id, error: { code: -32000, message: 'Expected turn is no longer active' } });
      if (activeTurn) finishTurn(activeTurn, 'Turn 1 ended before steer');
      return;
    }
    emit({ id: req.id, result: { turnId: tid } });
    const steeredText = req.params?.input?.[0]?.text ?? '';
    emit({ method: 'item/completed', params: { threadId, turnId: tid, item: { id: 'u-steer', type: 'userMessage', content: [{ type: 'text', text: steeredText }] } } });
    emit({ method: 'item/completed', params: { threadId, turnId: tid, item: { id: 'cmd-1', type: 'commandExecution', command: 'build.ps1', exitCode: 0, status: 'completed', aggregatedOutput: 'built\n' } } });
    setTimeout(() => finishTurn(tid, `Steered turn done: ${steeredText.split('\n')[1] ?? ''}`), 30);
  }
});

// Keep event loop open in hang mode even if stdin is closed until killed. A test that fails before it stops the run must
// not leave this process behind for good (it would hold the test runner's pipes open), so hang mode ends itself after
// FAKE_CODEX_APP_MAX_MS (default two minutes).
if (mode === 'hang') {
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(0), Number(process.env.FAKE_CODEX_APP_MAX_MS) || 120_000);
}
