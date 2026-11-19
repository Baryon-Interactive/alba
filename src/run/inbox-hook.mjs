import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER = /^## (\S+) (\S+) (\S+)$/;
const SEEN = /^seen (\S+)$/;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const TRUNC_NOTE = '\n... [truncated; full message is in .alba/inbox.md]';

const VALID_PAIRS = new Set([
  'claude:post-tool-use',
  'claude:stop',
  'agy:pre-invocation',
  'agy:stop',
]);

function parseInbox(text) {
  const out = [];
  let cur;
  const body = [];
  const flush = () => {
    if (!cur) return;
    const message = body.join('\n').trim();
    if (message) out.push({ ...cur, text: message });
    body.length = 0;
  };
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) { flush(); cur = { id: header[1], at: header[2], author: header[3] }; continue; }
    if (!cur) continue;
    if (/^reply \S+$/.test(line) && body.every(l => !l.trim())) { cur.reply = line.slice(6); continue; }
    const seen = SEEN.exec(line);
    if (seen && cur.seen === undefined) { cur.seen = seen[1]; continue; }
    body.push(line);
  }
  flush();
  return out;
}

function readDeliveredIds(file) {
  const ids = new Set();
  if (!existsSync(file)) return ids;
  const text = readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.id === 'string' && parsed.id) ids.add(parsed.id);
    } catch { /* ignore broken lines */ }
  }
  return ids;
}

function readAckIds(file) {
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8').split(/\s+/).filter(Boolean));
}

function frameMessage(m) {
  return [
    `[alba message id=${m.id} from=${m.author} at=${m.at}]`,
    m.text,
    `After acting on this message, append ${m.id} to .alba/inbox-ack; if a reply is needed, append a JSON line to .alba/outbox.jsonl with "reply": "${m.id}".`,
  ].join('\n');
}

function capPayload(text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_PAYLOAD_BYTES) return text;
  const noteBytes = Buffer.byteLength(TRUNC_NOTE, 'utf8');
  let end = Math.max(0, MAX_PAYLOAD_BYTES - noteBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + TRUNC_NOTE;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const engine = process.argv[2] ?? '';
  const event = process.argv[3] ?? '';
  if (!VALID_PAIRS.has(`${engine}:${event}`)) return;

  // Drain stdin (hook JSON payload); ignore unreadable or malformed stdin.
  const rawStdin = readStdin();
  let stdinJson = {};
  if (rawStdin.trim()) {
    try {
      const parsed = JSON.parse(rawStdin);
      if (parsed && typeof parsed === 'object') stdinJson = parsed;
    } catch { /* ignore malformed stdin */ }
  }

  // Derive worktree root from <worktree>/.alba/bin/inbox-hook.mjs.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const worktree = path.resolve(scriptDir, '..', '..');
  const albaDir = path.join(worktree, '.alba');
  const inboxFile = path.join(albaDir, 'inbox.md');

  if (!existsSync(inboxFile)) {
    if (engine === 'agy' && event === 'stop') process.stdout.write('{}\n');
    return;
  }

  const rawInbox = readFileSync(inboxFile, 'utf8');
  const entries = parseInbox(rawInbox);
  // Treat a non-empty file with no valid message headers as broken: print nothing and exit 0.
  if (rawInbox.trim().length > 0 && entries.length === 0) return;

  const ackIds = readAckIds(path.join(albaDir, 'inbox-ack'));
  const deliveredFile = path.join(albaDir, 'inbox-delivered');
  const deliveredIds = readDeliveredIds(deliveredFile);

  const waiting = entries.filter(m => !m.seen && !ackIds.has(m.id) && !deliveredIds.has(m.id));
  if (waiting.length === 0) {
    // When nothing new is waiting (including stop_hook_active), never block.
    if (engine === 'agy' && event === 'stop') process.stdout.write('{}\n');
    return;
  }

  const claimDir = path.join(albaDir, 'inbox-claimed');
  mkdirSync(claimDir, { recursive: true });
  const claimed = [];
  for (const m of waiting) {
    const key = createHash('sha256').update(m.id).digest('hex');
    const claimFile = path.join(claimDir, `${key}.claim`);
    try {
      const fd = openSync(claimFile, 'wx');
      closeSync(fd);
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
    claimed.push(m);
  }

  if (claimed.length === 0) {
    if (engine === 'agy' && event === 'stop') process.stdout.write('{}\n');
    return;
  }

  const now = new Date().toISOString();
  const lines = claimed.map(m => JSON.stringify({ id: m.id, at: now, via: 'hook', event })).join('\n') + '\n';
  appendFileSync(deliveredFile, lines, 'utf8');

  const payload = capPayload(claimed.map(frameMessage).join('\n\n'));
  let out;
  if (engine === 'claude' && event === 'post-tool-use') {
    out = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: payload } };
  } else if (engine === 'claude' && event === 'stop') {
    out = { decision: 'block', reason: payload };
  } else if (engine === 'agy' && event === 'pre-invocation') {
    out = { injectSteps: [{ userMessage: payload }] };
  } else if (engine === 'agy' && event === 'stop') {
    out = { decision: 'continue', reason: payload };
  }
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  main();
} catch {
  // Never break the worker: any error prints nothing and exits 0.
}
process.exitCode = 0;
