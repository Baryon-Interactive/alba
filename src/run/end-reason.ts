import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OrderEvent, Run } from '../orders/model.ts';
import type { Probes } from '../tick/gather.ts';
import type { WorkerConfig } from '../workers/config.ts';
import { parseStreamLog, textSessionId, workerAdapter } from '../workers/adapters/index.ts';
import { classifyEndpoint, unreachableWhy } from './endpoint.ts';
import { exitFileOf } from './spawn.ts';
import { eventErrors, isLimitError, isTransientError } from './transient.ts';

export const END_KINDS = [
  'report',
  'exit-0-no-report',
  'nonzero-exit',
  'stream-cut-mid-turn',
  'output-limit',
  'context-limit',
  'quota',
  'unreachable',
  'killed-by-alba',
  'vanished',
] as const;
export type EndKind = (typeof END_KINDS)[number];

export const SILENT_END_KINDS = ['stream-cut-mid-turn', 'vanished', 'output-limit', 'context-limit'] as const;
export const isSilentEnd = (kind: EndKind | undefined): boolean =>
  !!kind && (SILENT_END_KINDS as readonly string[]).includes(kind);

export const ROLLOUT_TAIL_BYTES = 256 * 1024;
export const EVENTS_TAIL_BYTES = 65536;
const RECEIPT_MAX_BYTES = 16384;
const HEAD_BYTES = 65536;

export interface ExitReceipt {
  code: number | null;
  signal: string | null;
  ended_at: string;
  lines: number;
  last_event: { type: string; at: string } | null;
  open_turn: boolean;
  open_items: { id: string; type: string; command?: string }[];
}

export interface EndReason {
  kind: EndKind;
  detail: string;
  exit_code?: number;
  signal?: string;
  last_event?: { type: string; at: string };
  open_turn?: boolean;
  open_items?: { id: string; type: string; command?: string }[];
}

export interface RunEnd extends EndReason {
  why: string;
  wip_ref?: string;
  wip_files?: number;
  wip_skipped?: boolean;
  wip_skipped_paths?: string[];
  wip_error?: string;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Bounded file access so end classification never reads an entire log or rollout. */
export interface TailReader {
  tail(file: string, maxBytes: number): { text: string; cut: boolean };
  head?(file: string, maxBytes: number): string;
  exists?(file: string): boolean;
  readdir?(dir: string): DirEntry[];
}

export const systemTailReader: TailReader = {
  tail(file, maxBytes) {
    if (!existsSync(file)) return { text: '', cut: false };
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      const buf = Buffer.alloc(length);
      if (length > 0) readSync(fd, buf, 0, length, start);
      return { text: buf.toString('utf8'), cut: start > 0 };
    } finally { closeSync(fd); }
  },
  head(file, maxBytes) {
    if (!existsSync(file)) return '';
    const fd = openSync(file, 'r');
    try {
      const length = Math.min(fstatSync(fd).size, maxBytes);
      const buf = Buffer.alloc(length);
      if (length > 0) readSync(fd, buf, 0, length, 0);
      return buf.toString('utf8');
    } finally { closeSync(fd); }
  },
  exists: file => existsSync(file),
  readdir(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
    } catch { return []; }
  },
};

export function probesTailReader(probes: Probes): TailReader {
  return {
    tail(file, maxBytes) {
      try {
        const text = probes.tail(file, maxBytes);
        return { text, cut: Buffer.byteLength(text) >= maxBytes };
      } catch {
        return { text: '', cut: false };
      }
    },
    head(file, maxBytes) {
      try {
        if (probes.head) return probes.head(file, maxBytes);
        return probes.readText(file)?.slice(0, maxBytes) ?? systemTailReader.head!(file, maxBytes);
      } catch {
        return '';
      }
    },
    exists: file => probes.fileTime(file) !== undefined || existsSync(file),
    readdir: dir => systemTailReader.readdir!(dir),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const oneLine = (text: string, max = 200): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

const NOISE = /rmcp::transport|ignoring unrecognized|unrecognized configuration|OutputTextDelta without active item|failed to refresh available models|^Reading additional input from stdin\.\.\.$/i;
const OUTPUT_LIMIT_RE = /Incomplete response returned,\s*reason:\s*(?:max_output_tokens|length)\b|\bmax_output_tokens\b|finish_reason["':=\s]+length\b|stop_reason["':=\s]+max_tokens\b/i;
const CONTEXT_LIMIT_RE = /context_length_exceeded|context_window_exceeded|model_context_window_exceeded|context window exceeded|ran out of room in the model's context window|maximum context length|prompt is too long/i;
const STDERR_ERROR_LINE = /^(?:\S*\d{4}-\d\d-\d\dT\S*\s+)?(?:ERROR|FATAL)\b|^(?:error|fatal)\b\s*[:\[]|^Error:/i;
const QUOTA_RE = /usage limit|hit your (?:usage |rate )?limit|limit (?:has been )?reached|(?:5|five)[- ]hour limit|weekly limit|insufficient[_ ]quota|exceeded your current quota|quota (?:exceeded|exhausted|used up)|out of (?:credits|quota)|billing hard limit/i;

export function readExitReceipt(exitFile: string | undefined, reader: TailReader = systemTailReader): ExitReceipt | undefined {
  if (!exitFile) return undefined;
  const { text, cut } = reader.tail(exitFile, RECEIPT_MAX_BYTES);
  if (!text.trim() || cut) return undefined;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isRecord(raw)) return undefined;
    const code = typeof raw.code === 'number' && Number.isFinite(raw.code) ? raw.code : null;
    const signal = typeof raw.signal === 'string' && raw.signal ? raw.signal : null;
    const lastRaw = isRecord(raw.last_event) && typeof raw.last_event.type === 'string' && typeof raw.last_event.at === 'string'
      ? { type: raw.last_event.type, at: raw.last_event.at }
      : null;
    const items = Array.isArray(raw.open_items)
      ? raw.open_items.filter(isRecord).slice(0, 5).map(i => ({
        id: str(i.id),
        type: str(i.type) || 'unknown',
        ...(typeof i.command === 'string' && i.command ? { command: i.command.slice(0, 300) } : {}),
      }))
      : [];
    return {
      code,
      signal,
      ended_at: str(raw.ended_at),
      lines: typeof raw.lines === 'number' && Number.isFinite(raw.lines) ? raw.lines : 0,
      last_event: lastRaw,
      open_turn: raw.open_turn === true,
      open_items: items,
    };
  } catch { return undefined; }
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Calendar day folders (`YYYY/MM/DD`) covering `[started, ended]` in both UTC and local time. */
export function sessionDayFolders(started: string | undefined, ended: string | undefined, now = new Date()): [string, string, string][] {
  const startMs = started && Number.isFinite(Date.parse(started)) ? Date.parse(started) : now.getTime();
  const endRaw = ended && Number.isFinite(Date.parse(ended)) ? Date.parse(ended) : now.getTime();
  const from = Math.min(startMs, endRaw);
  const to = Math.min(Math.max(startMs, endRaw), from + 366 * 86_400_000);
  const seen = new Set<string>();
  const out: [string, string, string][] = [];
  const add = (y: number, m: number, d: number) => {
    const parts: [string, string, string] = [String(y), pad2(m), pad2(d)];
    const key = parts.join('/');
    if (!seen.has(key)) { seen.add(key); out.push(parts); }
  };
  const points: number[] = [];
  for (let t = from; t <= to; t += 86_400_000) points.push(t);
  points.push(to);
  for (const t of points) {
    const d = new Date(t);
    add(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    add(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return out;
}

const rolloutCache = new Map<string, string | null>();
const MAX_ROLLOUT_CACHE = 512;

export function clearRolloutCache(): void { rolloutCache.clear(); }

/**
 * Finds a Codex rollout file by session id, looking only in `sessions/` top-level files and the day folders from the run's
 * start to its end. Cached per `(codexHome, sessionId)` so a run's rollout path is looked up at most once.
 */
export function findCodexRollout(
  sessionId: string | undefined,
  options: { codexHome?: string; started?: string; ended?: string; now?: Date; reader?: TailReader } = {},
): string | undefined {
  if (!sessionId || !/^[a-zA-Z0-9_-]{8,100}$/.test(sessionId)) return undefined;
  const reader = options.reader ?? systemTailReader;
  const readdir = reader.readdir ?? systemTailReader.readdir!;
  const exists = reader.exists ?? systemTailReader.exists!;
  const home = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const cacheKey = `${path.resolve(home)}:${sessionId}`;
  if (rolloutCache.has(cacheKey)) {
    const hit = rolloutCache.get(cacheKey);
    if (hit && exists(hit)) return hit;
    if (hit === null) return undefined;
  }
  const root = path.join(home, 'sessions');
  if (!exists(root)) return undefined;
  const remember = (found: string | null): string | undefined => {
    if (rolloutCache.size >= MAX_ROLLOUT_CACHE) {
      const oldest = rolloutCache.keys().next().value;
      if (oldest !== undefined) rolloutCache.delete(oldest);
    }
    rolloutCache.set(cacheKey, found);
    return found ?? undefined;
  };
  for (const e of readdir(root)) {
    if (e.isFile && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) return remember(path.join(root, e.name));
  }
  for (const [y, m, d] of sessionDayFolders(options.started, options.ended, options.now)) {
    const dayDir = path.join(root, y, m, d);
    for (const e of readdir(dayDir)) {
      if (e.isFile && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) return remember(path.join(dayDir, e.name));
    }
  }
  return remember(null);
}

interface StopSignal {
  kind: 'output-limit' | 'context-limit' | 'quota';
  detail: string;
}

function classifyErrorMessage(msg: string, errorInfo?: string): StopSignal | undefined {
  if (errorInfo === 'context_window_exceeded' || CONTEXT_LIMIT_RE.test(msg)) {
    return { kind: 'context-limit', detail: oneLine(msg || 'model context window exceeded') };
  }
  if ((errorInfo === 'response_incomplete' && !/content_filter/i.test(msg) && !QUOTA_RE.test(msg)) || OUTPUT_LIMIT_RE.test(msg)) {
    return { kind: 'output-limit', detail: oneLine(msg || 'response cut off at max_output_tokens') };
  }
  if ((errorInfo && ['usage_limit_exceeded', 'quota_exceeded', 'usage_not_included', 'session_budget_exceeded'].includes(errorInfo)) || QUOTA_RE.test(msg)) {
    return { kind: 'quota', detail: oneLine(msg || 'usage window or quota exhausted') };
  }
  return undefined;
}

interface ParsedRolloutTail {
  stop?: StopSignal;
  openTurn: boolean;
  sawActivity: boolean;
  lastLineType?: string;
}

export function parseRolloutTail(text: string, cut = false): ParsedRolloutTail {
  const lines = text.split(/\r?\n/).slice(cut ? 1 : 0);
  let stop: StopSignal | undefined;
  let openTurn = false;
  let sawActivity = false;
  let lastLineType: string | undefined;
  let rateLimitStop: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let j: unknown;
    try { j = JSON.parse(line); } catch { continue; }
    if (!isRecord(j)) continue;
    const topType = str(j.type);
    const p = isRecord(j.payload) ? j.payload : undefined;
    const subType = str(p?.type);
    if (topType) lastLineType = subType ? `${topType}:${subType}` : topType;

    if (topType === 'response_item' || topType === 'token_usage_record') {
      openTurn = true;
      sawActivity = true;
    }
    const inc = [p?.incomplete_details, j.incomplete_details, isRecord(j.response) ? j.response.incomplete_details : undefined].find(isRecord);
    if (inc) {
      const reason = str(inc.reason);
      if (reason === 'max_output_tokens' || reason === 'length') stop = { kind: 'output-limit', detail: `response incomplete (${reason})` };
      else if (/context/i.test(reason)) stop = { kind: 'context-limit', detail: `response incomplete (${reason})` };
    }
    if (topType !== 'event_msg' || !p) continue;
    if (subType === 'task_started' || subType === 'turn_started' || subType === 'item_started' || subType === 'item_completed' || subType === 'token_count') {
      openTurn = true;
      sawActivity = true;
    }
    if (subType === 'token_count' && isRecord(p.rate_limits)) {
      const rl = p.rate_limits;
      if (rl.spend_control_reached === true || (typeof rl.rate_limit_reached_type === 'string' && rl.rate_limit_reached_type)) {
        rateLimitStop = str(rl.rate_limit_reached_type) || 'spend_control_reached';
      } else {
        rateLimitStop = undefined;
      }
    }
    if (subType === 'task_complete' || subType === 'turn_complete') {
      openTurn = false;
      stop = undefined;
    }
    if (subType === 'error' || subType === 'stream_error' || subType === 'turn_aborted') {
      if (subType === 'turn_aborted') openTurn = false;
      const infoRaw = p.codex_error_info;
      const info = typeof infoRaw === 'string' ? infoRaw : isRecord(infoRaw) ? Object.keys(infoRaw)[0] : undefined;
      const msg = [p.message, p.reason, p.additional_details].filter((x): x is string => typeof x === 'string' && x.length > 0).join(': ');
      const found = classifyErrorMessage(msg, info);
      if (found) stop = found;
      else if (subType === 'turn_aborted' && rateLimitStop) stop = { kind: 'quota', detail: `Codex rate limit reached (${rateLimitStop})` };
    }
  }
  return { stop, openTurn, sawActivity, lastLineType };
}

interface ParsedEventsTail {
  stop?: StopSignal;
  openTurn: boolean;
  lastEvent?: { type: string; at: string };
  sawEvents: boolean;
}

function parseEventsTail(text: string, cut = false): ParsedEventsTail {
  const lines = text.split(/\r?\n/).slice(cut ? 1 : 0);
  let stop: StopSignal | undefined;
  let openTurn = false;
  let sawTurnStart = false;
  let lastEvent: { type: string; at: string } | undefined;
  let sawEvents = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    if (!isRecord(e)) continue;
    const type = str(e.type) || str(e.event);
    if (!type) continue;
    sawEvents = true;
    const at = str(e.alba_at) || (typeof e.timestamp === 'number' ? new Date(e.timestamp).toISOString() : str(e.timestamp)) || str(e.at);
    if (at) lastEvent = { type, at };
    const item = isRecord(e.item) ? e.item : undefined;

    if (type === 'turn.started' || type === 'step_start' || type === 'step-start') {
      openTurn = true;
      sawTurnStart = true;
    } else if (type === 'item.started' || type === 'item.updated') {
      openTurn = true;
    } else if (type === 'item.completed') {
      if (str(item?.type) !== 'agent_message' || sawTurnStart) openTurn = true;
    } else if (type === 'turn.completed' || type === 'turn.failed' || type === 'step_finish' || type === 'step-finish' || type === 'end' || type === 'result') {
      openTurn = false;
      sawTurnStart = false;
      if (type !== 'turn.failed' && type !== 'result') stop = undefined;
    }

    if (type === 'error' || type === 'turn.failed') {
      const errObj = isRecord(e.error) ? e.error : undefined;
      const infoRaw = e.codex_error_info ?? errObj?.codex_error_info;
      const info = typeof infoRaw === 'string' ? infoRaw : isRecord(infoRaw) ? Object.keys(infoRaw)[0] : undefined;
      const msg = [e.message, errObj?.message, errObj?.code, errObj?.type].filter((x): x is string => typeof x === 'string' && x.length > 0).join(': ');
      const found = classifyErrorMessage(msg, info);
      if (found) stop = found;
    }
    if (type === 'turn.completed' || type === 'end' || type === 'result' || type === 'step_finish' || type === 'step-finish' || type === 'assistant') {
      const msgObj = isRecord(e.message) ? e.message : undefined;
      const partObj = isRecord(e.part) ? e.part : undefined;
      const inc = [e.incomplete_details, msgObj?.incomplete_details].find(isRecord);
      const incReason = str(inc?.reason);
      const stopReason = str(e.stop_reason ?? e.stopReason ?? msgObj?.stop_reason ?? partObj?.reason ?? e.finish_reason);
      if (incReason === 'max_output_tokens' || stopReason === 'max_tokens' || stopReason === 'max_output_tokens' || stopReason === 'length') {
        stop = { kind: 'output-limit', detail: `stopped at ${incReason || stopReason}` };
      } else if (/context_(?:length|window)_exceeded|model_context_window_exceeded/i.test(`${incReason} ${stopReason}`)) {
        stop = { kind: 'context-limit', detail: `stopped at ${incReason || stopReason}` };
      }
      if (type === 'result' && (e.is_error === true || (typeof e.status === 'string' && e.status !== 'SUCCESS'))) {
        const errs = Array.isArray(e.errors) ? e.errors.filter((x): x is string => typeof x === 'string').join(': ') : '';
        const msg = [errs, str(e.error), str(e.result)].filter(Boolean).join(': ');
        const found = classifyErrorMessage(msg);
        if (found) stop = found;
      }
    }
  }
  return { stop, openTurn, lastEvent, sawEvents };
}

function parseStderrTail(stderrTail: string): { stop?: StopSignal; errorLine?: string } {
  const lines = stderrTail
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('{') && !NOISE.test(l))
    .slice(-15);
  if (!lines.length) return {};
  // Limits are read only from lines that are errors themselves (`<time> ERROR ...`, `error: ...`): the lines after an error
  // can be file content an engine echoes (a failed apply_patch prints the lines it looked for), which may mention any limit.
  const errorLines = lines.filter(l => STDERR_ERROR_LINE.test(l));
  const joined = errorLines.join('\n');
  if (CONTEXT_LIMIT_RE.test(joined)) {
    const hit = errorLines.find(l => CONTEXT_LIMIT_RE.test(l)) ?? lines.at(-1)!;
    return { stop: { kind: 'context-limit', detail: oneLine(hit) }, errorLine: oneLine(hit) };
  }
  if (OUTPUT_LIMIT_RE.test(joined)) {
    const hit = errorLines.find(l => OUTPUT_LIMIT_RE.test(l)) ?? lines.at(-1)!;
    return { stop: { kind: 'output-limit', detail: oneLine(hit) }, errorLine: oneLine(hit) };
  }
  if (QUOTA_RE.test(joined)) {
    const hit = errorLines.find(l => QUOTA_RE.test(l)) ?? lines.at(-1)!;
    return { stop: { kind: 'quota', detail: oneLine(hit) }, errorLine: oneLine(hit) };
  }
  return { errorLine: oneLine(lines.at(-1)!) };
}

export interface ClassifyEndInput {
  receipt?: ExitReceipt;
  eventsTail?: string;
  eventsCut?: boolean;
  stderrTail?: string;
  rolloutTail?: string;
  rolloutCut?: boolean;
  hasReport?: boolean;
  reportStatus?: string;
  hasFinalOrBrokenReport?: boolean;
  albaEvents?: readonly Pick<OrderEvent, 'type' | 'data'>[];
  runId?: string;
  worker?: WorkerConfig;
  engine?: string;
  usageTotal?: number;
  expectsReceipt?: boolean;
}

const ALBA_KILL_EVENTS = ['loop-stopped', 'lingering-stopped', 'token-cap-stopped', 'stall-stopped'] as const;

export function classifyEndReason(input: ClassifyEndInput): EndReason {
  const { receipt, eventsTail = '', stderrTail = '', rolloutTail = '' } = input;
  const ev = parseEventsTail(eventsTail, input.eventsCut);
  const ro = rolloutTail ? parseRolloutTail(rolloutTail, input.rolloutCut) : { openTurn: false, sawActivity: false };
  const err = parseStderrTail(stderrTail);

  const baseFields: Omit<EndReason, 'kind' | 'detail'> = {
    ...(typeof receipt?.code === 'number' ? { exit_code: receipt.code } : {}),
    ...(receipt?.signal ? { signal: receipt.signal } : {}),
    ...((receipt?.last_event ?? ev.lastEvent) ? { last_event: (receipt?.last_event ?? ev.lastEvent)! } : {}),
    ...(receipt ? { open_turn: receipt.open_turn } : ev.sawEvents || ro.sawActivity ? { open_turn: ev.openTurn || ro.openTurn } : {}),
    ...(receipt?.open_items.length ? { open_items: receipt.open_items } : {}),
  };

  const eventsList = input.albaEvents ?? [];
  const killedIdx = eventsList.findLastIndex((e, idx) =>
    (ALBA_KILL_EVENTS as readonly string[]).includes(e.type)
    && (!input.runId || e.data?.run === input.runId || (!e.data?.run && !eventsList.slice(idx + 1).some(x => x.type === 'run-start'))),
  );
  const killed = killedIdx >= 0 ? eventsList[killedIdx] : undefined;
  if (killed) {
    return { ...baseFields, kind: 'killed-by-alba', detail: `stopped by alba (${killed.type})` };
  }

  if (input.hasReport) {
    return { ...baseFields, kind: 'report', detail: input.reportStatus ? `report block read (${input.reportStatus})` : 'report block read' };
  }

  const limitStop = ro.stop ?? ev.stop ?? err.stop;
  if (limitStop?.kind === 'output-limit') return { ...baseFields, kind: 'output-limit', detail: limitStop.detail };
  if (limitStop?.kind === 'context-limit') return { ...baseFields, kind: 'context-limit', detail: limitStop.detail };

  const streamSource = eventsTail || stderrTail;
  const verdict = classifyEndpoint({
    events: streamSource,
    log: stderrTail,
    cut: Boolean(input.eventsCut),
    usageTotal: input.usageTotal,
    worker: input.worker,
  });
  if (verdict.kind === 'unreachable') {
    return { ...baseFields, kind: 'unreachable', detail: oneLine(unreachableWhy(verdict.endpoint)) };
  }

  const stream = parseStreamLog(streamSource, { cut: Boolean(input.eventsCut) });
  const endText = [stderrTail, eventErrors(eventsTail), stream.events ? stream.errors.slice(-5).join('\n') : streamSource].join('\n');
  const engine = input.worker?.engine ?? input.engine;
  const adapterStop = engine ? workerAdapter(engine).failure?.(endText, input.worker) : undefined;

  if (limitStop?.kind === 'quota' || adapterStop?.limit || isLimitError(endText)) {
    return { ...baseFields, kind: 'quota', detail: oneLine(limitStop?.detail ?? adapterStop?.why ?? err.errorLine ?? 'usage window or balance exhausted') };
  }

  const explicitFailure =
    /Remote dispatch failed: (.+)/.exec(stderrTail)?.[1]?.trim()
    ?? /\[alba editor\] the run does not start: (.+)/.exec(`${stderrTail}\n${streamSource}`)?.[1]?.trim()
    ?? (stream.blockedCommand ? `permission required: ${stream.blockedCommand}` : undefined)
    ?? (stream.stopReason === 'max_turn_requests' ? 'stopped at max_turn_requests' : undefined)
    ?? adapterStop?.why
    ?? (verdict.kind === 'capacity' || isTransientError(endText) ? (err.errorLine ?? 'transient service error') : undefined);

  if (receipt) {
    if (receipt.open_turn && !receipt.signal && !explicitFailure) {
      const last = (receipt.last_event ?? ev.lastEvent)?.type ?? ro.lastLineType ?? 'turn.started';
      return { ...baseFields, kind: 'stream-cut-mid-turn', detail: oneLine(`stream ended mid-turn after ${last} (exit ${receipt.code ?? 'null'})`) };
    }
    if (receipt.code === 0 && !receipt.signal) {
      return { ...baseFields, kind: 'exit-0-no-report', detail: oneLine(explicitFailure ?? 'process exited 0 without a report block') };
    }
    const how = receipt.signal ? `signal ${receipt.signal}` : `exit code ${receipt.code ?? 1}`;
    return { ...baseFields, kind: 'nonzero-exit', detail: oneLine(explicitFailure ? `${how}: ${explicitFailure}` : `process ended with ${how}`) };
  }

  if (!explicitFailure && !input.hasFinalOrBrokenReport && !stream.finalText.trim() && (ev.openTurn || ro.openTurn)) {
    const last = ev.lastEvent?.type ?? ro.lastLineType ?? 'turn.started';
    return { ...baseFields, kind: 'stream-cut-mid-turn', detail: oneLine(`stream ended mid-turn after ${last} (no exit receipt)`) };
  }

  if (input.hasFinalOrBrokenReport || stream.finalText.trim()) {
    return { ...baseFields, kind: 'exit-0-no-report', detail: 'final message had no valid report block' };
  }

  if (explicitFailure || (!input.expectsReceipt && err.errorLine)) {
    return { ...baseFields, kind: 'nonzero-exit', detail: oneLine(explicitFailure ?? err.errorLine!) };
  }

  return { ...baseFields, kind: 'vanished', detail: 'no exit receipt and worker process is gone' };
}

export interface ReadRunEndOptions {
  run: Pick<Run, 'id' | 'engine' | 'session' | 'started' | 'ended' | 'log' | 'events_file' | 'exit_file'>;
  worker?: WorkerConfig;
  albaEvents?: readonly Pick<OrderEvent, 'type' | 'data'>[];
  hasReport?: boolean;
  reportStatus?: string;
  hasFinalOrBrokenReport?: boolean;
  usageTotal?: number;
  codexHome?: string;
  now?: Date;
  reader?: TailReader;
}

/** Reads only bounded heads/tails of the run's files (and at most the last 256 KB of a Codex rollout) and classifies how it ended. */
export function readRunEndReason(options: ReadRunEndOptions): EndReason {
  const reader = options.reader ?? systemTailReader;
  const { run } = options;
  const exitPath = run.exit_file ?? (run.events_file ? exitFileOf(run.events_file) : undefined);
  const receipt = readExitReceipt(exitPath, reader);
  const eventsRead = run.events_file ? reader.tail(run.events_file, EVENTS_TAIL_BYTES) : { text: '', cut: false };
  const stderrRead = run.log ? reader.tail(run.log, EVENTS_TAIL_BYTES) : { text: '', cut: false };

  const engine = options.worker?.engine ?? run.engine;
  const isCodex = engine === 'codex-cli' || (!engine && Boolean(run.events_file));
  let rolloutRead = { text: '', cut: false };
  if (isCodex && !options.hasReport) {
    const head = reader.head ?? systemTailReader.head!;
    const eventsHead = run.events_file ? head(run.events_file, HEAD_BYTES) : '';
    const logHead = run.log ? head(run.log, 4096) : '';
    const sessionId =
      parseStreamLog(eventsHead).sessionId
      ?? parseStreamLog(eventsRead.text, { cut: eventsRead.cut }).sessionId
      ?? textSessionId(logHead)
      ?? run.session;
    const rolloutFile = findCodexRollout(sessionId, {
      codexHome: options.codexHome,
      started: run.started,
      ended: run.ended,
      now: options.now,
      reader,
    });
    if (rolloutFile) rolloutRead = reader.tail(rolloutFile, ROLLOUT_TAIL_BYTES);
  }

  return classifyEndReason({
    receipt,
    eventsTail: eventsRead.text,
    eventsCut: eventsRead.cut,
    stderrTail: stderrRead.text,
    rolloutTail: rolloutRead.text,
    rolloutCut: rolloutRead.cut,
    hasReport: options.hasReport,
    reportStatus: options.reportStatus,
    hasFinalOrBrokenReport: options.hasFinalOrBrokenReport,
    albaEvents: options.albaEvents,
    runId: run.id,
    worker: options.worker,
    engine,
    usageTotal: options.usageTotal,
    expectsReceipt: Boolean(run.exit_file || run.events_file),
  });
}
