// The detached capture process owns the worker. Codex events need a receipt timestamp and an exit receipt.
import { spawn } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [program, args, eventsFile = process.argv[3]] = JSON.parse(process.argv[2]);
const exitFile = typeof eventsFile === 'string' && eventsFile
  ? eventsFile.replace(/\.events\.jsonl$/i, '').replace(/\.jsonl$/i, '') + '.exit.json'
  : undefined;

let lines = 0, lastEvent = null, openTurn = false, written = false, rlClosed = false, exitResult = null;
const openItems = new Map();

function track(event, at) {
  lines++;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return;
  const type = typeof event.type === 'string' ? event.type : typeof event.event === 'string' ? event.event : undefined;
  if (!type) return;
  lastEvent = { type, at };
  if (type === 'turn.started' || type === 'step_start' || type === 'step-start') openTurn = true;
  else if (type === 'turn.completed' || type === 'turn.failed' || type === 'step_finish' || type === 'step-finish' || type === 'end' || type === 'result') openTurn = false;
  const item = event.item;
  if (type === 'item.started' && item && typeof item === 'object') {
    const id = typeof item.id === 'string' ? item.id : String(item.id ?? '');
    const itemType = typeof item.type === 'string' ? item.type : 'unknown';
    const rawCmd = typeof item.command === 'string' ? item.command
      : Array.isArray(item.command) ? item.command.join(' ')
      : [item.server, item.tool, item.query].filter(x => typeof x === 'string' && x).join(' ');
    openItems.set(id || `${itemType}:${openItems.size}`, {
      id,
      type: itemType,
      ...(rawCmd ? { command: rawCmd.slice(0, 300) } : {}),
    });
  } else if (type === 'item.completed' && item && typeof item === 'object' && item.id !== undefined) {
    openItems.delete(String(item.id));
  }
}

function writeReceipt(code, signal) {
  if (written || !exitFile) return;
  written = true;
  const receipt = {
    code: typeof code === 'number' ? code : null,
    signal: signal ?? null,
    ended_at: new Date().toISOString(),
    lines,
    last_event: lastEvent,
    open_turn: openTurn,
    open_items: [...openItems.values()].slice(0, 5),
  };
  const tmp = `${exitFile}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(receipt) + '\n', 'utf8');
    renameSync(tmp, exitFile);
  } catch {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

function flushReceipt() {
  if (exitResult && rlClosed) writeReceipt(exitResult.code, exitResult.signal);
}

const child = spawn(program, args, { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true });
const rl = createInterface({ input: child.stdout });
rl.on('line', line => {
  let parsed, at;
  try {
    parsed = JSON.parse(line);
    at = new Date().toISOString();
    process.stdout.write(JSON.stringify({ ...parsed, alba_at: at }) + '\n');
  } catch {
    process.stderr.write(line + '\n');
    return;
  }
  track(parsed, at);
});
rl.on('close', () => { rlClosed = true; flushReceipt(); });
child.on('error', error => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
  exitResult ??= { code: 1, signal: null };
  if (!child.pid) { rlClosed = true; rl.close(); }
  flushReceipt();
});
child.on('close', (code, signal) => {
  process.exitCode = code ?? 1;
  exitResult = { code: code ?? null, signal: signal ?? null };
  flushReceipt();
});
process.on('exit', code => {
  if (exitResult) writeReceipt(exitResult.code, exitResult.signal);
  else if (rlClosed) writeReceipt(code ?? 1, null);
});
process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} });
