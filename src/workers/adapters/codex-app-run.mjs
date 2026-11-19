import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER = /^## (\S+) (\S+) (\S+)$/;
const SEEN = /^seen (\S+)$/;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const TRUNC_NOTE = '\n... [truncated; full message is in .alba/inbox.md]';

/** Parses `.alba/inbox.md` with the same rules as `src/run/inbox.ts`. */
export function parseInboxText(text) {
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

export function frameMessages(messages, maxBytes = MAX_PAYLOAD_BYTES) {
  const framed = messages.map(m => [
    `[alba message id=${m.id} from=${m.author} at=${m.at}]`,
    m.text,
    `After acting on this message, append ${m.id} to .alba/inbox-ack; if a reply is needed, append a JSON line to .alba/outbox.jsonl with "reply": "${m.id}".`,
  ].join('\n')).join('\n\n');
  const buf = Buffer.from(framed, 'utf8');
  if (buf.length <= maxBytes) return framed;
  const noteBytes = Buffer.byteLength(TRUNC_NOTE, 'utf8');
  let end = Math.max(0, maxBytes - noteBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + TRUNC_NOTE;
}

function mapStatus(status) {
  if (status === 'inProgress') return 'in_progress';
  if (status === 'declined') return 'failed';
  return status;
}

function mapPatchKind(kind) {
  if (typeof kind === 'string') return kind;
  if (kind && typeof kind === 'object' && typeof kind.type === 'string') return kind.type;
  return 'update';
}

function parsePlanText(text) {
  if (typeof text !== 'string') return [];
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:[-*]|\d+\.)\s*(?:\[([ xX])\]\s*)?(.+?)\s*$/.exec(raw);
    if (m && m[2]) items.push({ text: m[2], completed: (m[1] ?? '').toLowerCase() === 'x' });
  }
  return items;
}

/** Converts one Codex app-server `ThreadItem` into the `codex exec --json` snake_case item shape. */
export function convertAppItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  const type = raw.type;
  if (type === 'agentMessage') {
    return { ...(id ? { id } : {}), type: 'agent_message', text: typeof raw.text === 'string' ? raw.text : '' };
  }
  if (type === 'userMessage') {
    const content = Array.isArray(raw.content) ? raw.content : [];
    const text = content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
    return { ...(id ? { id } : {}), type: 'user_message', text };
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(raw.summary) ? raw.summary.filter(s => typeof s === 'string' && s.trim()) : [];
    const content = Array.isArray(raw.content) ? raw.content.filter(s => typeof s === 'string' && s.trim()) : [];
    if (summary.length) return { ...(id ? { id } : {}), type: 'reasoning', summary };
    return { ...(id ? { id } : {}), type: 'reasoning', text: content.join('\n') };
  }
  if (type === 'commandExecution') {
    const out = {
      ...(id ? { id } : {}),
      type: 'command_execution',
      command: typeof raw.command === 'string' ? raw.command : '',
    };
    if (typeof raw.exitCode === 'number') out.exit_code = raw.exitCode;
    if (typeof raw.status === 'string') out.status = mapStatus(raw.status);
    if (typeof raw.aggregatedOutput === 'string') out.aggregated_output = raw.aggregatedOutput;
    if (typeof raw.durationMs === 'number') out.duration_ms = raw.durationMs;
    return out;
  }
  if (type === 'fileChange') {
    const changes = (Array.isArray(raw.changes) ? raw.changes : []).map(ch => ({
      path: typeof ch.path === 'string' ? ch.path : '',
      kind: mapPatchKind(ch.kind),
      ...(typeof ch.diff === 'string' && ch.diff ? { diff: ch.diff } : {}),
      ...(typeof ch.before === 'string' ? { before: ch.before } : {}),
      ...(typeof ch.after === 'string' ? { after: ch.after } : {}),
    }));
    return {
      ...(id ? { id } : {}),
      type: 'file_change',
      ...(typeof raw.status === 'string' ? { status: mapStatus(raw.status) } : {}),
      changes,
    };
  }
  if (type === 'mcpToolCall') {
    const out = {
      ...(id ? { id } : {}),
      type: 'mcp_tool_call',
      server: typeof raw.server === 'string' ? raw.server : '',
      tool: typeof raw.tool === 'string' ? raw.tool : '',
    };
    if (typeof raw.status === 'string') out.status = mapStatus(raw.status);
    if (raw.arguments !== undefined) out.arguments = raw.arguments;
    if (raw.result !== undefined && raw.result !== null) out.result = raw.result;
    if (raw.error !== undefined && raw.error !== null) out.error = raw.error;
    if (typeof raw.durationMs === 'number') out.duration_ms = raw.durationMs;
    return out;
  }
  if (type === 'webSearch') {
    const out = {
      ...(id ? { id } : {}),
      type: 'web_search',
      query: typeof raw.query === 'string' ? raw.query : '',
    };
    if (typeof raw.status === 'string') out.status = mapStatus(raw.status);
    if (typeof raw.output === 'string') out.output = raw.output;
    else if (Array.isArray(raw.results) && raw.results.length) {
      out.output = raw.results.length === 1 && typeof raw.results[0] === 'string' ? raw.results[0] : JSON.stringify(raw.results);
    }
    return out;
  }
  if (type === 'todoList' || type === 'plan') {
    const items = Array.isArray(raw.items) ? raw.items : parsePlanText(raw.text);
    return { ...(id ? { id } : {}), type: 'todo_list', items };
  }
  return null;
}

/** Creates a stateful translator converting Codex app-server notifications into `codex exec --json` events. */
export function createAppEventTranslator() {
  let prevTotal = { input: 0, cached: 0, output: 0, reasoning: 0 };
  let latestTotal = null;
  let lastBreakdown = null;
  let startedTurnId = null;

  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  function consumeTurnUsage() {
    if (latestTotal) {
      const usage = {
        input_tokens: Math.max(0, latestTotal.input - prevTotal.input),
        cached_input_tokens: Math.max(0, latestTotal.cached - prevTotal.cached),
        output_tokens: Math.max(0, latestTotal.output - prevTotal.output),
      };
      const reasoning = Math.max(0, latestTotal.reasoning - prevTotal.reasoning);
      if (reasoning > 0) usage.reasoning_output_tokens = reasoning;
      prevTotal = { ...latestTotal };
      latestTotal = null;
      lastBreakdown = null;
      return usage;
    }
    if (lastBreakdown) {
      const usage = {
        input_tokens: lastBreakdown.input,
        cached_input_tokens: lastBreakdown.cached,
        output_tokens: lastBreakdown.output,
      };
      if (lastBreakdown.reasoning > 0) usage.reasoning_output_tokens = lastBreakdown.reasoning;
      lastBreakdown = null;
      return usage;
    }
    return undefined;
  }

  return {
    markTurnStarted(turnId) {
      if (turnId && startedTurnId === turnId) return null;
      startedTurnId = turnId ?? '__turn__';
      return { type: 'turn.started' };
    },
    translate(msg) {
      if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return [];
      const p = msg.params && typeof msg.params === 'object' ? msg.params : {};
      const at = typeof msg.alba_at === 'string' ? { alba_at: msg.alba_at } : {};

      if (msg.method === 'thread/started') {
        const threadId = p.thread?.id ?? p.threadId;
        return typeof threadId === 'string' && threadId ? [{ type: 'thread.started', thread_id: threadId, ...at }] : [];
      }
      if (msg.method === 'turn/started') {
        const turnId = p.turn?.id ?? p.turnId;
        if (turnId && startedTurnId === turnId) return [];
        startedTurnId = turnId ?? '__turn__';
        return [{ type: 'turn.started', ...at }];
      }
      if (msg.method === 'item/started' || msg.method === 'item/completed') {
        const item = convertAppItem(p.item);
        if (!item) return [];
        return [{ type: msg.method === 'item/started' ? 'item.started' : 'item.completed', item, ...at }];
      }
      if (msg.method === 'thread/tokenUsage/updated') {
        const tu = p.tokenUsage;
        if (tu && typeof tu === 'object') {
          if (tu.total && typeof tu.total === 'object') {
            latestTotal = {
              input: num(tu.total.inputTokens),
              cached: num(tu.total.cachedInputTokens),
              output: num(tu.total.outputTokens),
              reasoning: num(tu.total.reasoningOutputTokens),
            };
          }
          if (tu.last && typeof tu.last === 'object') {
            lastBreakdown = {
              input: num(tu.last.inputTokens),
              cached: num(tu.last.cachedInputTokens),
              output: num(tu.last.outputTokens),
              reasoning: num(tu.last.reasoningOutputTokens),
            };
          }
        }
        return [];
      }
      if (msg.method === 'turn/completed') {
        startedTurnId = null;
        const status = p.turn?.status;
        if (status === 'failed' || status === 'interrupted') {
          const message = p.turn?.error?.message ?? `Codex turn ${status}`;
          return [{ type: 'turn.failed', error: { message }, ...at }];
        }
        const usage = consumeTurnUsage();
        return [{ type: 'turn.completed', ...(usage ? { usage } : {}), ...at }];
      }
      if (msg.method === 'error') {
        const message = p.error?.message ?? p.message ?? 'Codex app-server error';
        return [{ type: 'error', message, ...at }];
      }
      return [];
    },
  };
}

function codexCommand(program) {
  return /\.(?:mjs|cjs|js)$/i.test(program) ? { program: process.execPath, prefix: [program] } : { program, prefix: [] };
}

function readDeliveredIds(file) {
  const ids = new Set();
  if (!existsSync(file)) return ids;
  try {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.id === 'string' && parsed.id) ids.add(parsed.id);
      } catch { /* ignore broken lines */ }
    }
  } catch { /* ignore */ }
  return ids;
}

function readAckIds(file) {
  if (!existsSync(file)) return new Set();
  try {
    return new Set(readFileSync(file, 'utf8').split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

function claimWaitingInbox(worktree) {
  const albaDir = path.join(worktree, '.alba');
  const inboxFile = path.join(albaDir, 'inbox.md');
  if (!existsSync(inboxFile)) return [];
  let entries;
  try {
    entries = parseInboxText(readFileSync(inboxFile, 'utf8'));
  } catch {
    return [];
  }
  if (!entries.length) return [];
  const ackIds = readAckIds(path.join(albaDir, 'inbox-ack'));
  const deliveredIds = readDeliveredIds(path.join(albaDir, 'inbox-delivered'));
  const waiting = entries.filter(m => !m.seen && !ackIds.has(m.id) && !deliveredIds.has(m.id));
  if (!waiting.length) return [];

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
  return claimed;
}

function recordDelivered(worktree, messages, via) {
  const file = path.join(worktree, '.alba', 'inbox-delivered');
  mkdirSync(path.dirname(file), { recursive: true });
  const at = new Date().toISOString();
  const lines = messages.map(m => JSON.stringify({ id: m.id, at, via })).join('\n') + '\n';
  appendFileSync(file, lines, 'utf8');
}

function writeLastMessage(lastFile, text) {
  if (!lastFile || !text) return;
  try {
    mkdirSync(path.dirname(lastFile), { recursive: true });
    writeFileSync(lastFile, text, 'utf8');
  } catch { /* non-fatal */ }
}

function parseCliArgs(argv) {
  let specFile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--spec' && argv[i + 1]) {
      specFile = argv[++i];
    }
  }
  if (!specFile) throw new Error('Usage: node codex-app-run.mjs --spec <file>');
  return JSON.parse(readFileSync(specFile, 'utf8'));
}

export async function runCodexApp(spec) {
  const cwd = spec.cwd ?? process.cwd();
  const pollMs = typeof spec.pollIntervalMs === 'number' && spec.pollIntervalMs > 0 ? spec.pollIntervalMs : 1000;
  const idleGraceMs = typeof spec.idleGraceMs === 'number' && spec.idleGraceMs >= 0 ? spec.idleGraceMs : 3000;
  const liveMessages = spec.liveMessages !== false;
  const configArgs = Array.isArray(spec.config) ? spec.config.flatMap(v => ['-c', String(v)]) : [];
  const cmd = codexCommand(spec.codexProgram || 'codex');

  const emit = event => { process.stdout.write(JSON.stringify(event) + '\n'); };
  const translator = createAppEventTranslator();

  let child;
  let shuttingDown = false;
  let finished = false;
  let exitCode = 0;
  let seq = 0;
  const pending = new Map();
  let threadId = null;
  let activeTurnId = null;
  let steeringInFlight = false;
  let startingTurn = false;
  const pendingStartQueue = [];
  let lastAgentMessage = '';
  let graceTimer = null;
  let pollTimer = null;
  let stderrTail = '';

  const clearTimers = () => {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  const stopChild = async () => {
    const c = child;
    if (!c) return;
    child = null;
    if (c.exitCode !== null || c.killed) return;
    const closed = new Promise(resolve => c.once('close', resolve));
    try { c.stdin.end(); } catch { /* ignore */ }
    const killTimer = setTimeout(() => { try { c.kill(); } catch { /* ignore */ } }, 300);
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1500))]);
    clearTimeout(killTimer);
    if (c.exitCode === null) { try { c.kill(); } catch { /* ignore */ } }
  };

  const rejectAll = error => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const writeRpc = msg => {
    if (!child || !child.stdin.writable) throw new Error('codex app-server is not writable.');
    child.stdin.write(JSON.stringify(msg) + '\n');
  };

  const rpc = (method, params, timeoutMs = 120000) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex app-server ${method} timed out.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        writeRpc({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  };

  let finishResolve;
  const donePromise = new Promise(resolve => { finishResolve = resolve; });

  const finalize = async (code, errorMessage) => {
    if (finished) return;
    finished = true;
    shuttingDown = true;
    exitCode = code;
    clearTimers();
    if (errorMessage) process.stderr.write(errorMessage.endsWith('\n') ? errorMessage : `${errorMessage}\n`);
    writeLastMessage(spec.lastFile, lastAgentMessage);
    rejectAll(new Error(errorMessage || 'codex-app-run finished'));
    await stopChild();
    finishResolve(exitCode);
  };

  const onSignal = sig => {
    shuttingDown = true;
    clearTimers();
    if (child && child.exitCode === null) {
      try { child.kill(); } catch { /* ignore */ }
    }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGHUP', () => onSignal('SIGHUP'));
  process.on('exit', () => {
    if (child && child.exitCode === null) {
      try { child.kill(); } catch { /* ignore */ }
    }
  });

  const startNewTurn = async (text, deliveredMessages, via) => {
    if (finished || !threadId) return;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    startingTurn = true;
    try {
      const res = await rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      if (deliveredMessages && deliveredMessages.length) {
        recordDelivered(cwd, deliveredMessages, via);
      }
      const tid = res?.turn?.id ?? res?.turnId ?? null;
      if (tid) activeTurnId = tid;
      const startedEv = translator.markTurnStarted(tid);
      if (startedEv) emit(startedEv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: 'turn.failed', error: { message: msg } });
      await finalize(1, msg);
    } finally {
      startingTurn = false;
    }
  };

  const scheduleGraceExit = () => {
    if (finished || activeTurnId || steeringInFlight || startingTurn) return;
    if (pendingStartQueue.length > 0) {
      void flushPendingStarts();
      return;
    }
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(async () => {
      graceTimer = null;
      if (finished || activeTurnId || steeringInFlight || startingTurn) return;
      if (liveMessages) {
        const late = claimWaitingInbox(cwd);
        if (late.length) {
          await startNewTurn(frameMessages(late), late, 'turn');
          return;
        }
      }
      await finalize(0);
    }, idleGraceMs);
  };

  const flushPendingStarts = async () => {
    if (finished || activeTurnId || startingTurn || !pendingStartQueue.length) return;
    const batch = pendingStartQueue.splice(0);
    const messages = batch.flatMap(b => b.messages);
    const payload = frameMessages(messages);
    await startNewTurn(payload, messages, 'turn');
  };

  const pollInbox = async () => {
    if (!liveMessages || finished || !threadId || steeringInFlight || startingTurn) return;
    const claimed = claimWaitingInbox(cwd);
    if (!claimed.length) return;
    const payload = frameMessages(claimed);
    if (activeTurnId) {
      steeringInFlight = true;
      const targetTurn = activeTurnId;
      try {
        await rpc('turn/steer', {
          threadId,
          expectedTurnId: targetTurn,
          input: [{ type: 'text', text: payload, text_elements: [] }],
        });
        recordDelivered(cwd, claimed, 'steer');
      } catch {
        // Server refused steer (e.g. turn ended): fall back to a fresh turn/start.
        pendingStartQueue.push({ messages: claimed, payload });
      } finally {
        steeringInFlight = false;
      }
      if (!activeTurnId) {
        if (pendingStartQueue.length) await flushPendingStarts();
        else scheduleGraceExit();
      }
    } else {
      await startNewTurn(payload, claimed, 'turn');
    }
  };

  const handleMessage = msg => {
    if (!msg || typeof msg !== 'object') return;
    // Response to our RPC request
    if (msg.id !== undefined && !msg.method) {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      }
      return;
    }
    // Server-initiated RPC request: refuse interactive prompts in headless runs
    if (msg.id !== undefined && msg.method) {
      try { writeRpc({ id: msg.id, error: { code: -32601, message: 'Headless worker does not accept interactive requests.' } }); } catch { /* ignore */ }
      return;
    }
    const p = msg.params && typeof msg.params === 'object' ? msg.params : {};
    if (msg.method === 'turn/started') {
      const tid = p.turn?.id ?? p.turnId;
      if (typeof tid === 'string' && tid) activeTurnId = tid;
    }
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
      lastAgentMessage = p.item.text;
    }
    const translated = translator.translate(msg);
    for (const ev of translated) emit(ev);

    if (msg.method === 'turn/completed') {
      activeTurnId = null;
      const status = p.turn?.status;
      if (status === 'failed' || status === 'interrupted') {
        const errMsg = p.turn?.error?.message ?? `Codex turn ${status}`;
        void finalize(1, errMsg);
        return;
      }
      writeLastMessage(spec.lastFile, lastAgentMessage);
      if (steeringInFlight) return; // wait for in-flight steer to resolve/reject
      if (pendingStartQueue.length) {
        void flushPendingStarts();
        return;
      }
      if (liveMessages) {
        const waiting = claimWaitingInbox(cwd);
        if (waiting.length) {
          void startNewTurn(frameMessages(waiting), waiting, 'turn');
          return;
        }
      }
      scheduleGraceExit();
    } else if (msg.method === 'error' && !p.willRetry) {
      const errMsg = p.error?.message ?? p.message ?? 'Codex app-server error';
      void finalize(1, errMsg);
    }
  };

  child = spawn(cmd.program, [...cmd.prefix, ...configArgs, 'app-server'], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdoutBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch (err) {
        stderrTail = `${stderrTail}\nInvalid JSON from codex app-server: ${String(err)}`.slice(-4000);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk).slice(-4000);
    process.stderr.write(chunk);
  });
  child.on('error', err => {
    if (!shuttingDown) {
      const msg = `Failed to start codex app-server: ${err.message}`;
      emit({ type: 'error', message: msg });
      void finalize(1, msg);
    }
  });
  child.on('close', code => {
    if (stdoutBuf.trim()) {
      try { handleMessage(JSON.parse(stdoutBuf.trim())); } catch { /* ignore */ }
      stdoutBuf = '';
    }
    if (!shuttingDown && !finished) {
      const msg = `codex app-server exited unexpectedly (code ${code ?? 'unknown'})${stderrTail.trim() ? `: ${stderrTail.trim().split('\n').at(-1)}` : ''}`;
      emit({ type: 'error', message: msg });
      void finalize(code && code !== 0 ? code : 1, msg);
    }
  });

  try {
    await rpc('initialize', {
      clientInfo: { name: 'alba_worker', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    writeRpc({ method: 'initialized', params: {} });

    const threadParams = {
      cwd,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.approvalPolicy ? { approvalPolicy: spec.approvalPolicy } : {}),
      ...(spec.sandbox ? { sandbox: spec.sandbox } : {}),
    };
    const threadRes = spec.resume
      ? await rpc('thread/resume', { threadId: spec.resume, ...threadParams })
      : await rpc('thread/start', threadParams);
    threadId = threadRes?.thread?.id ?? spec.resume;
    if (!threadId) throw new Error('codex app-server returned no thread id.');
    emit({ type: 'thread.started', thread_id: threadId });

    const promptText = readFileSync(spec.promptFile, 'utf8');
    if (liveMessages) {
      pollTimer = setInterval(() => { void pollInbox(); }, pollMs);
    }
    await startNewTurn(promptText, null, null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', message: msg });
    await finalize(1, msg);
  }

  return donePromise;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const spec = parseCliArgs(process.argv.slice(2));
    const code = await runCodexApp(spec);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
