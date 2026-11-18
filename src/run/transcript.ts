import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type {
  RunTranscript,
  RunUsage,
  TranscriptEdit,
  TranscriptEntry,
  TranscriptEntryKind,
  TranscriptEntryState,
  TranscriptPlanStep,
} from '../api/types.ts';
import { agyEvent, type AgyEvent } from '../workers/adapters/agy-protocol.ts';
import { claudeContent, eventText, toolResultText } from '../workers/adapters/claude-protocol.ts';
import { tokenUsage } from '../workers/adapters/usage-fold.ts';

export const TEXT_CAP_BYTES = 64 * 1024;
export const TEXT_HEAD_BYTES = 16 * 1024;
export const INPUT_CAP_BYTES = 16 * 1024;
export const INPUT_HEAD_BYTES = 4 * 1024;
export const MAX_TRANSCRIPT_ENTRIES = 5000;
export const MAX_LOG_GROUP_LINES = 200;
export const ENDED_CACHE_TTL_MS = 10 * 60 * 1000;

const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const HEADER_FINGERPRINT_BYTES = 128;
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

const stripAnsi = (s: string): string => s.replace(ANSI_ESCAPE, '');

function oneLine(s: string, max = 240): string {
  const clean = stripAnsi(s).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function firstLine(s: string, max = 240): string {
  for (const raw of s.split(/\r?\n/)) {
    const clean = oneLine(raw, max);
    if (clean) return clean;
  }
  return '';
}

/** Slices a UTF-8 prefix of at most `maxBytes` without splitting a multi-byte character. */
function utf8Head(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/** Slices a UTF-8 suffix of at most `maxBytes` without starting inside a multi-byte character. */
function utf8Tail(buf: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (buf.length <= maxBytes) return buf;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

/**
 * Caps `value` at `capBytes` UTF-8 bytes by keeping the first `headBytes`, a marker line, and the remaining tail bytes.
 * For 64 KiB text/output: first 16 KiB + marker line + last ~48 KiB (total <= 64 KiB).
 */
export function capString(value: string, capBytes = TEXT_CAP_BYTES, headBytes = TEXT_HEAD_BYTES): { value: string; truncated: boolean } {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= capBytes) return { value, truncated: false };
  const head = utf8Head(buf, headBytes);
  // First estimate omitted bytes so the marker itself fits inside `capBytes`.
  const roughOmitted = Math.max(1, buf.length - head.length - (capBytes - headBytes));
  let marker = `\n... [truncated ${roughOmitted} bytes] ...\n`;
  let tailBudget = Math.max(0, capBytes - head.length - Buffer.byteLength(marker, 'utf8'));
  let tail = utf8Tail(buf, tailBudget);
  const exactOmitted = buf.length - head.length - tail.length;
  marker = `\n... [truncated ${exactOmitted} bytes] ...\n`;
  const over = head.length + Buffer.byteLength(marker, 'utf8') + tail.length - capBytes;
  if (over > 0) {
    tailBudget = Math.max(0, tail.length - over);
    tail = utf8Tail(buf, tailBudget);
    const finalOmitted = buf.length - head.length - tail.length;
    marker = `\n... [truncated ${finalOmitted} bytes] ...\n`;
  }
  return { value: head.toString('utf8') + marker + tail.toString('utf8'), truncated: true };
}

function capValue(raw: unknown): { value: unknown; truncated: boolean } {
  if (typeof raw === 'string') return capString(raw, INPUT_CAP_BYTES, INPUT_HEAD_BYTES);
  if (raw === null || raw === undefined || typeof raw === 'number' || typeof raw === 'boolean') return { value: raw, truncated: false };
  if (Array.isArray(raw)) {
    let truncated = false;
    const mapped = raw.map(item => {
      const r = capValue(item);
      if (r.truncated) truncated = true;
      return r.value;
    });
    const json = JSON.stringify(mapped);
    if (Buffer.byteLength(json, 'utf8') > INPUT_CAP_BYTES) {
      const cut = capString(json, INPUT_CAP_BYTES, INPUT_HEAD_BYTES);
      return { value: cut.value, truncated: true };
    }
    return { value: mapped, truncated };
  }
  if (typeof raw === 'object') {
    let truncated = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === undefined) continue;
      const r = capValue(v);
      if (r.truncated) truncated = true;
      out[k] = r.value;
    }
    const json = JSON.stringify(out);
    if (Buffer.byteLength(json, 'utf8') > INPUT_CAP_BYTES) {
      const cut = capString(json, INPUT_CAP_BYTES, INPUT_HEAD_BYTES);
      return { value: cut.value, truncated: true };
    }
    return { value: out, truncated };
  }
  return { value: String(raw), truncated: false };
}

export function sanitizeInput(raw: Record<string, unknown> | undefined): { input?: Record<string, unknown>; truncated: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { truncated: false };
  const keys = Object.keys(raw).filter(k => raw[k] !== undefined);
  if (!keys.length) return { truncated: false };
  let truncated = false;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const r = capValue(raw[k]);
    if (r.truncated) truncated = true;
    out[k] = r.value;
  }
  return { input: out, truncated };
}

function splitLines(s: string): string[] {
  if (!s) return [];
  const norm = s.replace(/\r\n/g, '\n');
  const body = norm.endsWith('\n') ? norm.slice(0, -1) : norm;
  return body.split('\n');
}

type DiffOp = { op: ' ' | '-' | '+'; line: string; oldNo: number; newNo: number };

/** Builds a unified diff from `before` and `after` with `context` surrounding lines; no external dependency. */
export function unifiedDiff(filePath: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const ops: DiffOp[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let i = 0; i < prefix; i++) ops.push({ op: ' ', line: a[i], oldNo: oldNo++, newNo: newNo++ });

  const m = midA.length;
  const n = midB.length;
  if (m === 0) {
    for (let j = 0; j < n; j++) ops.push({ op: '+', line: midB[j], oldNo, newNo: newNo++ });
  } else if (n === 0) {
    for (let i = 0; i < m; i++) ops.push({ op: '-', line: midA[i], oldNo: oldNo++, newNo });
  } else if (m * n <= 400_000) {
    const width = n + 1;
    const dp = new Int32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      const row = i * width;
      const nextRow = (i + 1) * width;
      const ai = midA[i];
      for (let j = n - 1; j >= 0; j--) {
        dp[row + j] = ai === midB[j] ? dp[nextRow + j + 1] + 1 : Math.max(dp[nextRow + j], dp[row + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        ops.push({ op: ' ', line: midA[i], oldNo: oldNo++, newNo: newNo++ });
        i++;
        j++;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        ops.push({ op: '-', line: midA[i++], oldNo: oldNo++, newNo });
      } else {
        ops.push({ op: '+', line: midB[j++], oldNo, newNo: newNo++ });
      }
    }
    while (i < m) ops.push({ op: '-', line: midA[i++], oldNo: oldNo++, newNo });
    while (j < n) ops.push({ op: '+', line: midB[j++], oldNo, newNo: newNo++ });
  } else {
    for (let i = 0; i < m; i++) ops.push({ op: '-', line: midA[i], oldNo: oldNo++, newNo });
    for (let j = 0; j < n; j++) ops.push({ op: '+', line: midB[j], oldNo, newNo: newNo++ });
  }

  for (let i = a.length - suffix; i < a.length; i++) ops.push({ op: ' ', line: a[i], oldNo: oldNo++, newNo: newNo++ });

  // Group changed ranges with `context` lines around each change into unified hunks.
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].op !== ' ') changed.push(i);
  if (!changed.length) return '';

  const hunks: [number, number][] = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = hunks.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }

  const label = (filePath || 'file').replace(/\\/g, '/').replace(/^\/+/, '');
  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (const [start, end] of hunks) {
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i <= end; i++) {
      if (ops[i].op !== '+') oldCount++;
      if (ops[i].op !== '-') newCount++;
    }
    const oldStart = oldCount === 0 ? Math.max(0, ops[start].oldNo - 1) : ops[start].oldNo;
    const newStart = newCount === 0 ? Math.max(0, ops[start].newNo - 1) : ops[start].newNo;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let i = start; i <= end; i++) out.push(`${ops[i].op}${ops[i].line}`);
  }
  return out.join('\n');
}

/** Bounded streaming text accumulator: exact up to 128 KiB, then retains 16 KiB head + rolling 64 KiB tail + byte count. */
class StreamBuffer {
  private exact = '';
  private headBuf?: Buffer;
  private tailBuf?: Buffer;
  private totalBytes = 0;

  append(delta: string): void {
    if (!delta) return;
    if (!this.headBuf) {
      this.exact += delta;
      if (Buffer.byteLength(this.exact, 'utf8') > 128 * 1024) {
        const full = Buffer.from(this.exact, 'utf8');
        this.totalBytes = full.length;
        this.headBuf = utf8Head(full, TEXT_HEAD_BYTES);
        this.tailBuf = utf8Tail(full, TEXT_CAP_BYTES);
        this.exact = '';
      }
      return;
    }
    const add = Buffer.from(delta, 'utf8');
    this.totalBytes += add.length;
    const combined = Buffer.concat([this.tailBuf!, add]);
    this.tailBuf = utf8Tail(combined, TEXT_CAP_BYTES);
  }

  hasNonWhitespace(): boolean {
    if (!this.headBuf) return this.exact.trim().length > 0;
    return this.headBuf.toString('utf8').trim().length > 0 || (this.tailBuf?.toString('utf8').trim().length ?? 0) > 0;
  }

  render(trimEnd = false): { text: string; truncated: boolean } {
    if (!this.headBuf) {
      const s = trimEnd ? this.exact.replace(/\s+$/, '') : this.exact;
      const cut = capString(s, TEXT_CAP_BYTES, TEXT_HEAD_BYTES);
      return { text: cut.value, truncated: cut.truncated };
    }
    const rawTail = trimEnd ? this.tailBuf!.toString('utf8').replace(/\s+$/, '') : this.tailBuf!.toString('utf8');
    const tailBytes = Buffer.from(rawTail, 'utf8');
    const roughOmitted = Math.max(1, this.totalBytes - this.headBuf.length - (TEXT_CAP_BYTES - TEXT_HEAD_BYTES));
    let marker = `\n... [truncated ${roughOmitted} bytes] ...\n`;
    let budget = Math.max(0, TEXT_CAP_BYTES - this.headBuf.length - Buffer.byteLength(marker, 'utf8'));
    let tail = utf8Tail(tailBytes, budget);
    const omitted = Math.max(1, this.totalBytes - this.headBuf.length - tail.length);
    marker = `\n... [truncated ${omitted} bytes] ...\n`;
    const over = this.headBuf.length + Buffer.byteLength(marker, 'utf8') + tail.length - TEXT_CAP_BYTES;
    if (over > 0) {
      budget = Math.max(0, tail.length - over);
      tail = utf8Tail(tailBytes, budget);
      marker = `\n... [truncated ${Math.max(1, this.totalBytes - this.headBuf.length - tail.length)} bytes] ...\n`;
    }
    return { text: this.headBuf.toString('utf8') + marker + tail.toString('utf8'), truncated: true };
  }
}

interface Slot {
  entry: TranscriptEntry;
  key?: string;
  rev: number;
  startedAt: string;
  baseTruncated: boolean;
}

function parseTime(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  if (typeof v === 'string' && v.trim() && Number.isFinite(Date.parse(v))) return v.trim();
  return undefined;
}

function eventTime(e: Record<string, any>, observedAt: string): string {
  const step = obj(e.step_update);
  const result = obj(e.result);
  const part = obj(e.part);
  const partTime = obj(part.time);
  return (
    parseTime(e.timestamp) ??
    parseTime(e.at) ??
    parseTime(e.created_at) ??
    parseTime(step.timestamp) ??
    parseTime(step.created_at) ??
    parseTime(result.timestamp) ??
    parseTime(partTime.start) ??
    parseTime(e.alba_at) ??
    observedAt
  );
}

function elapsedSeconds(startedAt: string, endedAt: string): number | undefined {
  const a = Date.parse(startedAt);
  const b = Date.parse(endedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined;
  return (b - a) / 1000;
}

function makeEditItem(raw: { path: string; kind?: string; before?: string; after?: string; diff?: string }): { item: TranscriptEdit; truncated: boolean } {
  let truncated = false;
  const computedDiff = raw.diff ?? (raw.before !== undefined && raw.after !== undefined ? unifiedDiff(raw.path, raw.before, raw.after) : undefined);
  const item: TranscriptEdit = { path: raw.path };
  if (raw.kind) item.kind = raw.kind;
  if (raw.before !== undefined) {
    const c = capString(raw.before);
    item.before = c.value;
    if (c.truncated) truncated = true;
  }
  if (raw.after !== undefined) {
    const c = capString(raw.after);
    item.after = c.value;
    if (c.truncated) truncated = true;
  }
  if (computedDiff) {
    const c = capString(computedDiff);
    item.diff = c.value;
    if (c.truncated) truncated = true;
  }
  return { item, truncated };
}

function claudeEdits(toolName: string, input: Record<string, any>): { edits: TranscriptEdit[]; truncated: boolean } {
  const path = str(input.file_path ?? input.path ?? input.notebook_path);
  let truncated = false;
  const edits: TranscriptEdit[] = [];
  if (/^multiedit$/i.test(toolName) && Array.isArray(input.edits)) {
    for (const sub of input.edits) {
      const s = obj(sub);
      const before = typeof s.old_string === 'string' ? s.old_string : undefined;
      const after = typeof s.new_string === 'string' ? s.new_string : undefined;
      const built = makeEditItem({ path: str(s.file_path ?? path), kind: 'edit', before, after });
      if (built.truncated) truncated = true;
      edits.push(built.item);
    }
    return { edits, truncated };
  }
  if (/^write$/i.test(toolName)) {
    const after = typeof input.content === 'string' ? input.content : undefined;
    const before = typeof input.old_string === 'string' ? input.old_string : undefined;
    const built = makeEditItem({ path, kind: 'write', before, after });
    return { edits: [built.item], truncated: built.truncated };
  }
  const before = typeof input.old_string === 'string' ? input.old_string : undefined;
  const after = typeof input.new_string === 'string' ? input.new_string : typeof input.new_source === 'string' ? input.new_source : undefined;
  const built = makeEditItem({ path, kind: 'edit', before, after });
  return { edits: [built.item], truncated: built.truncated };
}

function agyEdits(toolName: string, params: Record<string, any>): { edits: TranscriptEdit[]; truncated: boolean } {
  const path = str(params.Path ?? params.TargetFile ?? params.AbsolutePath ?? params.file_path ?? params.path);
  let truncated = false;
  if (Array.isArray(params.ReplacementChunks)) {
    const edits: TranscriptEdit[] = [];
    for (const chunk of params.ReplacementChunks) {
      const c = obj(chunk);
      const before = typeof c.TargetContent === 'string' ? c.TargetContent : typeof c.Target === 'string' ? c.Target : undefined;
      const after = typeof c.ReplacementContent === 'string' ? c.ReplacementContent : typeof c.Replacement === 'string' ? c.Replacement : undefined;
      const built = makeEditItem({ path, kind: 'edit', before, after });
      if (built.truncated) truncated = true;
      edits.push(built.item);
    }
    return { edits, truncated };
  }
  if (/^write/i.test(toolName)) {
    const after = typeof params.Content === 'string' ? params.Content : typeof params.CodeContent === 'string' ? params.CodeContent : typeof params.content === 'string' ? params.content : undefined;
    const built = makeEditItem({ path, kind: 'write', after });
    return { edits: [built.item], truncated: built.truncated };
  }
  const before = typeof params.Target === 'string' ? params.Target : typeof params.TargetContent === 'string' ? params.TargetContent : typeof params.old_string === 'string' ? params.old_string : undefined;
  const after = typeof params.Replacement === 'string' ? params.Replacement : typeof params.ReplacementContent === 'string' ? params.ReplacementContent : typeof params.new_string === 'string' ? params.new_string : undefined;
  const built = makeEditItem({ path, kind: 'edit', before, after });
  return { edits: [built.item], truncated: built.truncated };
}

function reasoningText(item: Record<string, any>): string {
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  if (typeof item.summary === 'string' && item.summary.trim()) return item.summary.trim();
  if (Array.isArray(item.summary)) {
    const parts = item.summary.map((s: any) => (typeof s === 'string' ? s : str(obj(s).text))).filter(Boolean);
    return parts.join('\n').trim();
  }
  return '';
}

function mcpOutputText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const o = raw as Record<string, any>;
  if (typeof o.message === 'string') return o.message;
  if (typeof o.text === 'string') return o.text;
  if (Array.isArray(o.content)) {
    const parts = o.content.map((c: any) => (typeof c === 'string' ? c : str(obj(c).text))).filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  return JSON.stringify(raw);
}

function grokContentText(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const parts: string[] = [];
  for (const item of raw) {
    const o = obj(item);
    const inner = obj(o.content);
    const t = str(inner.text) || str(o.text);
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

function cleanUsage(u: RunUsage): RunUsage | undefined {
  if (u.source === 'unknown' && u.cost_usd === undefined && u.turns === undefined) return undefined;
  const out: Record<string, unknown> = { source: u.source };
  for (const k of ['total_tokens', 'input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'reasoning_tokens', 'turns', 'cost_usd'] as const) {
    if (u[k] !== undefined) out[k] = u[k];
  }
  return out as unknown as RunUsage;
}

/**
 * Folds a run's stream (Codex, Claude, agy, OpenCode, Grok JSON lines, or plain-text lines) into ordered `TranscriptEntry` items.
 * Unknown events are ignored. Feeding the whole file or arbitrary line chunks produces identical entries.
 */
export class TranscriptFold {
  readonly maxEntries: number;
  private slots: Slot[] = [];
  private byKey = new Map<string, Slot>();
  private nextSeq = 0;
  private droppedCount = 0;
  private evictCursor = 0;
  private revCounter = 0;

  private openLog?: { slot: Slot; stream: StreamBuffer; lines: number };
  private grokMessage?: { slot: Slot; stream: StreamBuffer };
  private agyMessages = new Map<number, { slot?: Slot; stream: StreamBuffer; startedAt: string }>();
  private agyThoughts = new Map<number, { slot?: Slot; stream: StreamBuffer; startedAt: string }>();
  private pendingBytes: Buffer = Buffer.alloc(0);

  constructor(maxEntries = MAX_TRANSCRIPT_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get total(): number {
    return this.nextSeq;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get rev(): number {
    return this.revCounter;
  }

  /** Feeds arbitrary UTF-8 byte or string chunks; partial trailing lines wait for their newline. */
  push(chunk: Buffer | string, observedAt: string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (!buf.length) return;
    const combined = this.pendingBytes.length ? Buffer.concat([this.pendingBytes, buf]) : buf;
    const cut = combined.lastIndexOf(10);
    if (cut < 0) {
      this.pendingBytes = Buffer.from(combined);
      return;
    }
    const text = combined.subarray(0, cut).toString('utf8');
    this.pendingBytes = Buffer.from(combined.subarray(cut + 1));
    for (const l of text.split('\n')) this.line(l, observedAt);
  }

  line(rawLine: string, observedAt: string): void {
    const cleaned = rawLine.replace(/\r$/, '');
    const trimmed = cleaned.trim();
    if (trimmed.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.plainLine(cleaned, observedAt);
        return;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const e = parsed as Record<string, any>;
        if (typeof e.type === 'string' || typeof e.event === 'string') {
          this.openLog = undefined;
          this.event(e, observedAt);
          return;
        }
      }
    }
    this.plainLine(cleaned, observedAt);
  }

  event(raw: unknown, observedAt: string): void {
    const e = obj(raw);
    this.openLog = undefined;
    const at = eventTime(e, observedAt);
    const agy = agyEvent(e);
    if (agy) {
      this.closeGrokMessage();
      this.foldAgy(agy, at);
      return;
    }
    const type = str(e.type);
    if (!type) return;

    if (type !== 'text') this.closeGrokMessage();

    // Codex item.* events
    if (type.startsWith('item.')) {
      this.foldCodexItem(type, obj(e.item), at);
      return;
    }
    if (type === 'turn.failed' || type === 'error') {
      const msg = str(e.message) || str(obj(e.error).message) || (e.error ? JSON.stringify(e.error) : '');
      if (msg) this.pushTextEntry('error', 'failed', msg, at);
      return;
    }

    // OpenCode / Grok text & reasoning & tool_use
    if (type === 'reasoning' && e.part && typeof e.part === 'object') {
      const part = obj(e.part);
      const text = str(part.text ?? e.text).trim();
      if (!text) return;
      const id = str(part.id);
      this.upsertText(id ? `opencode-reason:${id}` : undefined, 'reasoning', 'done', text, at);
      return;
    }

    if (type === 'text') {
      if (e.part && typeof e.part === 'object') {
        this.closeGrokMessage();
        const part = obj(e.part);
        const text = str(part.text ?? e.text).trim();
        if (!text) return;
        const id = str(part.id);
        this.upsertText(id ? `opencode-text:${id}` : undefined, 'message', 'done', text, at);
        return;
      }
      if (typeof e.data === 'string') {
        this.appendGrokDelta(e.data, at);
        return;
      }
      this.closeGrokMessage();
      const direct = str(e.text);
      if (direct.trim()) this.pushTextEntry('message', 'done', direct.trim(), at);
      return;
    }

    if (type === 'tool_use') {
      this.foldOpenCodeTool(obj(e.part), at);
      return;
    }

    // Grok tool_call / tool_call_update / end
    if (type === 'tool_call') {
      this.foldGrokStart(e, at);
      return;
    }
    if (type === 'tool_call_update') {
      this.foldGrokUpdate(e, at);
      return;
    }
    if (type === 'end') {
      this.foldGrokEnd(e, at);
      return;
    }

    // Claude assistant / user / result
    if (type === 'assistant' || type === 'message') {
      this.foldClaudeAssistant(e, at);
      return;
    }
    if (type === 'user') {
      this.foldClaudeUser(e, at);
      return;
    }
    if (type === 'result') {
      this.foldClaudeResult(e, at);
      return;
    }
    if (type === 'content' && typeof e.content === 'string' && e.content.trim()) {
      this.pushTextEntry('message', 'done', e.content.trim(), at);
    }
  }

  private plainLine(line: string, at: string): void {
    this.closeGrokMessage();
    if (!this.openLog) {
      if (!line.trim()) return;
      const stream = new StreamBuffer();
      stream.append(line);
      const rendered = stream.render(false);
      const slot = this.createSlot({
        at,
        kind: 'log',
        state: 'done',
        title: firstLine(line) || 'log',
        text: rendered.text,
        ...(rendered.truncated ? { truncated: true } : {}),
      });
      this.openLog = { slot, stream, lines: 1 };
      return;
    }
    if (this.openLog.lines >= MAX_LOG_GROUP_LINES) {
      this.openLog = undefined;
      this.plainLine(line, at);
      return;
    }
    this.openLog.stream.append(`\n${line}`);
    this.openLog.lines++;
    const rendered = this.openLog.stream.render(false);
    this.openLog.slot.entry.text = rendered.text;
    if (rendered.truncated) this.openLog.slot.entry.truncated = true;
    this.touch(this.openLog.slot);
  }

  private appendGrokDelta(delta: string, at: string): void {
    if (!this.grokMessage) {
      const stream = new StreamBuffer();
      stream.append(delta);
      if (!stream.hasNonWhitespace()) return;
      const rendered = stream.render(false);
      const slot = this.createSlot({
        at,
        kind: 'message',
        state: 'running',
        title: firstLine(rendered.text) || 'Message',
        text: rendered.text,
        ...(rendered.truncated ? { truncated: true } : {}),
      });
      this.grokMessage = { slot, stream };
      return;
    }
    this.grokMessage.stream.append(delta);
    const rendered = this.grokMessage.stream.render(false);
    this.grokMessage.slot.entry.text = rendered.text;
    this.grokMessage.slot.entry.title = firstLine(rendered.text) || this.grokMessage.slot.entry.title;
    if (rendered.truncated) this.grokMessage.slot.entry.truncated = true;
    this.touch(this.grokMessage.slot);
  }

  private closeGrokMessage(): void {
    if (!this.grokMessage) return;
    const rendered = this.grokMessage.stream.render(true);
    this.grokMessage.slot.entry.state = 'done';
    this.grokMessage.slot.entry.text = rendered.text;
    this.grokMessage.slot.entry.title = firstLine(rendered.text) || this.grokMessage.slot.entry.title;
    if (rendered.truncated) this.grokMessage.slot.entry.truncated = true;
    this.touch(this.grokMessage.slot);
    this.grokMessage = undefined;
  }

  private foldCodexItem(eventType: string, item: Record<string, any>, at: string): void {
    const kind = str(item.type);
    const rawId = str(item.id);
    const key = rawId ? `codex:${rawId}` : undefined;
    const completed = eventType === 'item.completed';

    if (kind === 'agent_message') {
      const text = str(item.text).trim();
      if (!text && !(key && this.byKey.has(key))) return;
      this.upsertText(key, 'message', completed ? 'done' : 'running', text, at);
      return;
    }

    if (kind === 'reasoning') {
      const text = reasoningText(item);
      if (!text && !(key && this.byKey.has(key))) return;
      this.upsertText(key, 'reasoning', completed ? 'done' : 'running', text, at);
      return;
    }

    if (kind === 'todo_list') {
      if (!Array.isArray(item.items)) return;
      const plan: TranscriptPlanStep[] = item.items
        .map((i: any) => ({ step: str(i.text ?? i.step), status: i.completed === true ? 'done' : str(i.status) || 'todo' }))
        .filter((i: TranscriptPlanStep) => Boolean(i.step));
      if (!plan.length) return;
      const done = plan.filter(p => p.status === 'done' || p.status === 'completed').length;
      const current = plan.find(p => p.status === 'doing' || p.status === 'in_progress')?.step ?? plan.find(p => p.status !== 'done' && p.status !== 'completed')?.step;
      const title = oneLine(current ? `${current} (${done}/${plan.length})` : `Plan (${done}/${plan.length})`);
      const state: TranscriptEntryState = completed || !key ? 'done' : 'running';
      const existing = key ? this.byKey.get(key) : undefined;
      if (existing) {
        existing.entry.state = state;
        existing.entry.title = title;
        existing.entry.plan = plan;
        this.touch(existing);
      } else {
        this.createSlot({ at, kind: 'plan', state, title, plan }, key);
      }
      return;
    }

    if (kind === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      let truncated = false;
      const edits: TranscriptEdit[] = [];
      for (const ch of changes) {
        const c = obj(ch);
        const path = str(c.path);
        if (!path) continue;
        const built = makeEditItem({
          path,
          kind: str(c.kind) || undefined,
          before: typeof c.before === 'string' ? c.before : undefined,
          after: typeof c.after === 'string' ? c.after : undefined,
          diff: typeof c.diff === 'string' ? c.diff : typeof c.patch === 'string' ? c.patch : undefined,
        });
        if (built.truncated) truncated = true;
        edits.push(built.item);
      }
      const summary = oneLine(edits.map(f => (f.kind ? `${f.kind} ${f.path}` : f.path)).join(', ') || 'file change');
      const state: TranscriptEntryState = !completed ? 'running' : item.status === 'failed' ? 'failed' : 'done';
      const existing = key ? this.byKey.get(key) : undefined;
      if (existing) {
        existing.entry.state = state;
        if (summary) existing.entry.title = summary;
        if (edits.length) existing.entry.edit = edits;
        if (truncated || existing.baseTruncated) existing.entry.truncated = true;
        this.touch(existing);
      } else {
        this.createSlot({ at, kind: 'edit', state, title: summary, ...(edits.length ? { edit: edits } : {}), ...(truncated ? { truncated: true } : {}) }, key, truncated);
      }
      return;
    }

    if (kind === 'command_execution') {
      const rawCmd = Array.isArray(item.command) ? item.command.join(' ') : str(item.command);
      const exitCode = num(item.exit_code);
      const failed = item.status === 'failed' || (exitCode !== undefined && exitCode !== 0);
      const state: TranscriptEntryState = !completed ? 'running' : failed ? 'failed' : 'done';
      const rawOut = str(item.aggregated_output ?? item.output) || str(obj(item.error).message);
      const duration = num(item.duration_seconds) ?? (num(item.duration_ms) !== undefined ? num(item.duration_ms)! / 1000 : undefined);
      this.upsertStep(key, 'command', state, oneLine(rawCmd || 'command'), at, {
        output: rawOut || undefined,
        exitCode,
        duration,
      });
      return;
    }

    if (kind === 'mcp_tool_call') {
      const label = [str(item.server), str(item.tool)].filter(Boolean).join('.') || 'mcp_tool_call';
      const args = item.arguments ?? item.input ?? item.params;
      const inputObj = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
      const failed = item.status === 'failed' || Boolean(item.error);
      const state: TranscriptEntryState = !completed ? 'running' : failed ? 'failed' : 'done';
      const rawOut = completed ? mcpOutputText(item.result ?? item.output ?? item.error) : '';
      this.upsertStep(key, 'tool', state, oneLine(label), at, {
        input: inputObj,
        output: rawOut || undefined,
        duration: num(item.duration_seconds),
      });
      return;
    }

    if (kind === 'web_search') {
      const query = str(item.query);
      const state: TranscriptEntryState = !completed ? 'running' : item.status === 'failed' ? 'failed' : 'done';
      const rawOut = str(item.output);
      this.upsertStep(key, 'search', state, oneLine(query || 'web search'), at, {
        input: query ? { query } : undefined,
        output: rawOut || undefined,
      });
    }
  }

  private foldClaudeAssistant(e: Record<string, any>, at: string): void {
    const msg = obj(e.message);
    const msgId = str(msg.id);
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (let i = 0; i < content.length; i++) {
      const c = obj(content[i]);
      const blockType = str(c.type);
      if (blockType === 'thinking') {
        const text = str(c.thinking ?? c.text).trim();
        if (!text) continue;
        this.upsertText(msgId ? `claude-think:${msgId}:${i}` : undefined, 'reasoning', 'done', text, at);
      } else if (blockType === 'text') {
        const text = str(c.text).trim();
        if (!text) continue;
        this.upsertText(msgId ? `claude-text:${msgId}:${i}` : undefined, 'message', 'done', text, at);
      } else if (blockType === 'tool_use') {
        const id = str(c.id);
        const name = str(c.name) || 'tool';
        const rawInput = obj(c.input);
        const key = id ? `claude-tool:${id}` : undefined;
        if (/^(?:bash|powershell|shell|cmd)$/i.test(name)) {
          const cmd = str(rawInput.command ?? rawInput.cmd) || name;
          this.upsertStep(key, 'command', 'running', oneLine(cmd), at, { input: rawInput });
        } else if (/^(?:edit|multiedit|write|notebookedit)$/i.test(name)) {
          const path = str(rawInput.file_path ?? rawInput.path ?? rawInput.notebook_path);
          const built = claudeEdits(name, rawInput);
          this.upsertStep(key, 'edit', 'running', oneLine(`${name} ${path}`.trim()), at, {
            input: rawInput,
            edits: built.edits,
            extraTruncated: built.truncated,
          });
        } else if (/^websearch$/i.test(name)) {
          const query = str(rawInput.query);
          this.upsertStep(key, 'search', 'running', oneLine(query || name), at, { input: rawInput });
        } else if (/^todowrite$/i.test(name) && Array.isArray(rawInput.todos)) {
          const plan: TranscriptPlanStep[] = rawInput.todos
            .map((t: any) => ({ step: str(obj(t).content ?? obj(t).step), status: str(obj(t).status) || 'todo' }))
            .filter((t: TranscriptPlanStep) => Boolean(t.step));
          const done = plan.filter(p => p.status === 'done' || p.status === 'completed').length;
          this.upsertStep(key, 'plan', 'running', oneLine(`Plan (${done}/${plan.length})`), at, { input: rawInput, plan });
        } else {
          const target = str(rawInput.file_path ?? rawInput.path ?? rawInput.pattern ?? rawInput.url);
          this.upsertStep(key, 'tool', 'running', oneLine(`${name} ${target}`.trim()), at, { input: rawInput });
        }
      }
    }
  }

  private foldClaudeUser(e: Record<string, any>, at: string): void {
    for (const c of claudeContent(e)) {
      if (c.type !== 'tool_result') continue;
      const id = str(c.tool_use_id);
      const key = id ? `claude-tool:${id}` : undefined;
      const isError = c.is_error === true;
      const out = toolResultText(c.content);
      const existing = key ? this.byKey.get(key) : undefined;
      if (existing) {
        existing.entry.state = isError ? 'failed' : 'done';
        if (out) {
          const cut = capString(out);
          existing.entry.output = cut.value;
          if (cut.truncated) existing.entry.truncated = true;
        }
        const dur = elapsedSeconds(existing.startedAt, at);
        if (dur !== undefined && dur > 0 && existing.entry.duration_seconds === undefined) existing.entry.duration_seconds = dur;
        this.touch(existing);
      } else {
        this.upsertStep(key, 'tool', isError ? 'failed' : 'done', oneLine(id || 'tool_result'), at, { output: out || undefined });
      }
    }
  }

  private foldClaudeResult(e: Record<string, any>, at: string): void {
    const failed = e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success');
    const errList = Array.isArray(e.errors) ? e.errors.filter((x: unknown): x is string => typeof x === 'string') : [];
    const rawText = (eventText(e) ?? (errList.length ? errList.join('\n') : '')).trim();
    const cut = rawText ? capString(rawText) : undefined;
    const rawUsage = tokenUsage(obj(e.usage), 'claude-json');
    if (num(e.total_cost_usd) !== undefined) rawUsage.cost_usd = num(e.total_cost_usd);
    if (num(e.num_turns) !== undefined) rawUsage.turns = num(e.num_turns);
    const usage = cleanUsage(rawUsage);
    const duration = num(e.duration_seconds) ?? (num(e.duration_ms) !== undefined ? num(e.duration_ms)! / 1000 : undefined);
    this.createSlot({
      at,
      kind: 'result',
      state: failed ? 'failed' : 'done',
      title: firstLine(rawText) || (failed ? 'Run failed' : 'Result'),
      ...(cut?.value ? { text: cut.value } : {}),
      ...(duration !== undefined ? { duration_seconds: duration } : {}),
      ...(usage ? { usage } : {}),
      ...(cut?.truncated ? { truncated: true } : {}),
    });
  }

  private foldOpenCodeTool(part: Record<string, any>, at: string): void {
    const s = obj(part.state);
    const rawInput = obj(s.input);
    const toolName = str(part.tool) || 'tool';
    const rawId = str(part.id || part.callID || part.tool);
    const key = rawId ? `opencode-tool:${rawId}` : undefined;
    const status = str(s.status);
    const running = status === 'running' || status === 'pending';
    const exitCode = num(obj(s.metadata).exit);
    const failed = status === 'error' || (exitCode !== undefined && exitCode !== 0);
    const state: TranscriptEntryState = running ? 'running' : failed ? 'failed' : 'done';
    const rawOut = !running ? str(s.output) || str(s.error) : '';
    const time = obj(s.time);
    const duration = num(time.start) !== undefined && num(time.end) !== undefined && time.end >= time.start ? (time.end - time.start) / 1000 : undefined;

    if (/^(?:bash|shell|cmd|powershell)$/i.test(toolName) || typeof rawInput.command === 'string') {
      const cmd = str(rawInput.command ?? rawInput.cmd) || toolName;
      this.upsertStep(key, 'command', state, oneLine(cmd), at, { input: rawInput, output: rawOut || undefined, exitCode, duration });
      return;
    }
    if (/^(?:edit|write|patch|multiedit)$/i.test(toolName)) {
      const path = str(rawInput.filePath ?? rawInput.file_path ?? rawInput.path);
      const before = typeof rawInput.oldString === 'string' ? rawInput.oldString : typeof rawInput.old_string === 'string' ? rawInput.old_string : undefined;
      const after = typeof rawInput.newString === 'string' ? rawInput.newString : typeof rawInput.new_string === 'string' ? rawInput.new_string : typeof rawInput.content === 'string' ? rawInput.content : undefined;
      const built = makeEditItem({ path, kind: /^write$/i.test(toolName) ? 'write' : 'edit', before, after });
      this.upsertStep(key, 'edit', state, oneLine(`${toolName} ${path}`.trim()), at, {
        input: rawInput,
        output: rawOut || undefined,
        edits: [built.item],
        extraTruncated: built.truncated,
        duration,
      });
      return;
    }
    if (/^(?:websearch|codesearch)$/i.test(toolName)) {
      const query = str(rawInput.query);
      this.upsertStep(key, 'search', state, oneLine(query || toolName), at, { input: rawInput, output: rawOut || undefined, duration });
      return;
    }
    const target = str(rawInput.filePath ?? rawInput.file_path ?? rawInput.path ?? rawInput.url);
    this.upsertStep(key, 'tool', state, oneLine(`${toolName} ${target}`.trim()), at, { input: rawInput, output: rawOut || undefined, exitCode, duration });
  }

  private foldGrokStart(e: Record<string, any>, at: string): void {
    const id = str(e.toolCallId);
    const key = id ? `grok-tool:${id}` : undefined;
    const toolName = str(e.toolName || e.title) || 'tool';
    const rawInput = obj(e.rawInput);
    const grokKind = str(e.kind);
    if (grokKind === 'execute' || /terminal|bash|shell|command/i.test(toolName) || typeof rawInput.command === 'string') {
      const cmd = str(rawInput.command ?? rawInput.cmd) || toolName;
      this.upsertStep(key, 'command', 'running', oneLine(cmd), at, { input: rawInput });
    } else if (grokKind === 'edit' || /write|edit|replace|patch/i.test(toolName)) {
      const path = str(rawInput.path ?? rawInput.file_path);
      const before = typeof rawInput.old_string === 'string' ? rawInput.old_string : typeof rawInput.before === 'string' ? rawInput.before : undefined;
      const after = typeof rawInput.new_string === 'string' ? rawInput.new_string : typeof rawInput.content === 'string' ? rawInput.content : typeof rawInput.after === 'string' ? rawInput.after : undefined;
      const built = makeEditItem({ path, kind: /write/i.test(toolName) ? 'write' : 'edit', before, after });
      this.upsertStep(key, 'edit', 'running', oneLine(`${toolName} ${path}`.trim()), at, {
        input: rawInput,
        edits: [built.item],
        extraTruncated: built.truncated,
      });
    } else if (grokKind === 'search' || /web_search|search_web/i.test(toolName)) {
      const query = str(rawInput.query);
      this.upsertStep(key, 'search', 'running', oneLine(query || toolName), at, { input: rawInput });
    } else {
      const target = str(rawInput.path ?? rawInput.file_path ?? rawInput.url);
      this.upsertStep(key, 'tool', 'running', oneLine(`${toolName} ${target}`.trim()), at, { input: rawInput });
    }
  }

  private foldGrokUpdate(e: Record<string, any>, at: string): void {
    const id = str(e.toolCallId);
    const key = id ? `grok-tool:${id}` : undefined;
    const status = str(e.status);
    const rawOutput = obj(e.rawOutput);
    const outText = str(rawOutput.output_for_prompt) || grokContentText(e.content);
    if (status === 'in_progress') {
      const existing = key ? this.byKey.get(key) : undefined;
      if (existing && str(rawOutput.output_for_prompt)) {
        const cut = capString(str(rawOutput.output_for_prompt));
        existing.entry.output = cut.value;
        if (cut.truncated) existing.entry.truncated = true;
        this.touch(existing);
      }
      return;
    }
    if (status !== 'completed' && status !== 'failed') return;
    const exitCode = num(rawOutput.exit_code);
    const failed = status === 'failed' || rawOutput.timed_out === true || (exitCode !== undefined && exitCode !== 0);
    const existing = key ? this.byKey.get(key) : undefined;
    if (existing) {
      existing.entry.state = failed ? 'failed' : 'done';
      if (exitCode !== undefined) existing.entry.exit_code = exitCode;
      if (outText) {
        const cut = capString(outText);
        existing.entry.output = cut.value;
        if (cut.truncated) existing.entry.truncated = true;
      }
      const dur = elapsedSeconds(existing.startedAt, at);
      if (dur !== undefined && dur > 0 && existing.entry.duration_seconds === undefined) existing.entry.duration_seconds = dur;
      this.touch(existing);
    } else {
      this.upsertStep(key, 'tool', failed ? 'failed' : 'done', oneLine(str(rawOutput.command) || id || 'tool'), at, {
        output: outText || undefined,
        exitCode,
      });
    }
  }

  private foldGrokEnd(e: Record<string, any>, at: string): void {
    const stopReason = str(e.stopReason);
    const failed = Boolean(stopReason && !['end_turn', 'stop', 'success'].includes(stopReason));
    const rawUsage = tokenUsage(obj(e.usage ?? e.tokenUsage), 'grok-end');
    if (num(e.total_cost_usd) !== undefined) rawUsage.cost_usd = num(e.total_cost_usd);
    if (num(e.num_turns) !== undefined) rawUsage.turns = num(e.num_turns);
    const usage = cleanUsage(rawUsage);
    this.createSlot({
      at,
      kind: 'result',
      state: failed ? 'failed' : 'done',
      title: stopReason ? `Result (${stopReason})` : 'Result',
      ...(usage ? { usage } : {}),
    });
  }

  private foldAgy(ev: AgyEvent, at: string): void {
    if (ev.kind === 'step') {
      const s = ev.step;
      if (s.type === 'tool') {
        const key = `agy-tool:${s.index}`;
        const toolName = s.tool ?? 'tool';
        const params = s.parameters;
        const active = s.state === 'ACTIVE';
        const failed = !active && (s.state !== 'DONE' || (s.exitCode !== undefined && s.exitCode !== 0));
        const state: TranscriptEntryState = active ? 'running' : failed ? 'failed' : 'done';
        const out = !active && s.output ? s.output : undefined;

        if (toolName === 'run_command') {
          this.upsertStep(key, 'command', state, oneLine(s.command ?? 'run_command'), at, {
            input: params,
            output: out,
            exitCode: s.exitCode,
            duration: s.durationSeconds,
          });
        } else if (/^(?:write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content|sed_file)$/i.test(toolName) || /^(?:write|replace|edit)/i.test(toolName)) {
          const built = agyEdits(toolName, params ?? {});
          const path = built.edits[0]?.path ?? s.target ?? '';
          this.upsertStep(key, 'edit', state, oneLine(`${toolName} ${path}`.trim()), at, {
            input: params,
            output: out,
            edits: built.edits,
            extraTruncated: built.truncated,
            duration: s.durationSeconds,
          });
        } else if (toolName === 'search_web' || toolName === 'web_search') {
          const query = str(params?.query ?? params?.Query ?? s.target);
          this.upsertStep(key, 'search', state, oneLine(query || toolName), at, {
            input: params,
            output: out,
            duration: s.durationSeconds,
          });
        } else {
          this.upsertStep(key, 'tool', state, oneLine(s.command ?? toolName), at, {
            input: params,
            output: out,
            exitCode: s.exitCode,
            duration: s.durationSeconds,
          });
        }
        return;
      }

      if (s.type === 'agent_response' || s.type === 'thinking' || s.type === 'reasoning') {
        const isReasoning = s.type !== 'agent_response';
        const map = isReasoning ? this.agyThoughts : this.agyMessages;
        const entryKind: TranscriptEntryKind = isReasoning ? 'reasoning' : 'message';
        let acc = map.get(s.index);
        if (!acc) {
          acc = { stream: new StreamBuffer(), startedAt: at };
          map.set(s.index, acc);
        }
        if (s.textDelta) acc.stream.append(s.textDelta);
        const active = s.state === 'ACTIVE';
        if (acc.stream.hasNonWhitespace()) {
          const rendered = acc.stream.render(!active);
          const state: TranscriptEntryState = active ? 'running' : s.state === 'DONE' ? 'done' : 'failed';
          if (!acc.slot) {
            acc.slot = this.createSlot(
              {
                at: acc.startedAt,
                kind: entryKind,
                state,
                title: firstLine(rendered.text) || (isReasoning ? 'Reasoning' : 'Message'),
                text: rendered.text,
                ...(s.durationSeconds !== undefined ? { duration_seconds: s.durationSeconds } : {}),
                ...(rendered.truncated ? { truncated: true } : {}),
              },
              `agy-${entryKind}:${s.index}`,
              rendered.truncated,
            );
          } else {
            acc.slot.entry.state = state;
            acc.slot.entry.text = rendered.text;
            acc.slot.entry.title = firstLine(rendered.text) || acc.slot.entry.title;
            if (s.durationSeconds !== undefined) acc.slot.entry.duration_seconds = s.durationSeconds;
            if (rendered.truncated) acc.slot.entry.truncated = true;
            this.touch(acc.slot);
          }
        }
        if (!active) map.delete(s.index);
        return;
      }

      if (s.type === 'error_message') {
        const msg = s.message || s.textDelta || '';
        const cut = msg ? capString(msg) : undefined;
        this.createSlot({
          at,
          kind: 'error',
          state: 'failed',
          title: firstLine(msg) || 'agy error step',
          ...(cut?.value ? { text: cut.value } : {}),
          ...(cut?.truncated ? { truncated: true } : {}),
        });
      }
      return;
    }

    if (ev.kind === 'result') {
      for (const [, acc] of this.agyMessages) {
        if (acc.slot && acc.slot.entry.state === 'running') {
          const rendered = acc.stream.render(true);
          acc.slot.entry.state = 'done';
          acc.slot.entry.text = rendered.text;
          acc.slot.entry.title = firstLine(rendered.text) || acc.slot.entry.title;
          this.touch(acc.slot);
        }
      }
      this.agyMessages.clear();

      const r = ev.result;
      const failed = r.status !== 'SUCCESS';
      const body = failed && r.error ? (r.response.trim() ? `${r.response.trim()}\n\n${r.error}` : r.error) : r.response.trim();
      const cut = body ? capString(body) : undefined;
      let usage: RunUsage | undefined;
      if (r.usage) {
        const rawUsage = tokenUsage(
          {
            input_tokens: r.usage.input_tokens,
            output_tokens: r.usage.output_tokens,
            cached_input_tokens: r.usage.cache_read_tokens,
            reasoning_tokens: r.usage.thinking_tokens,
            total_tokens: r.usage.total_tokens,
          },
          'agy-json',
        );
        if (r.turns !== undefined) rawUsage.turns = r.turns;
        usage = cleanUsage(rawUsage);
      }
      this.createSlot({
        at,
        kind: 'result',
        state: failed ? 'failed' : 'done',
        title: firstLine(failed && r.error ? r.error : r.response.trim()) || (failed ? `agy ended with status ${r.status || 'ERROR'}` : 'Result'),
        ...(cut?.value ? { text: cut.value } : {}),
        ...(r.durationSeconds !== undefined ? { duration_seconds: r.durationSeconds } : {}),
        ...(usage ? { usage } : {}),
        ...(cut?.truncated ? { truncated: true } : {}),
      });
    }
  }

  private pushTextEntry(kind: TranscriptEntryKind, state: TranscriptEntryState, rawText: string, at: string): Slot {
    const cut = capString(rawText);
    return this.createSlot(
      {
        at,
        kind,
        state,
        title: firstLine(rawText) || kind,
        text: cut.value,
        ...(cut.truncated ? { truncated: true } : {}),
      },
      undefined,
      cut.truncated,
    );
  }

  private upsertText(key: string | undefined, kind: TranscriptEntryKind, state: TranscriptEntryState, rawText: string, at: string): void {
    const existing = key ? this.byKey.get(key) : undefined;
    const cut = rawText ? capString(rawText) : undefined;
    if (existing) {
      existing.entry.state = state;
      if (cut) {
        existing.entry.text = cut.value;
        existing.entry.title = firstLine(rawText) || existing.entry.title;
        if (cut.truncated) existing.entry.truncated = true;
      }
      this.touch(existing);
      return;
    }
    this.createSlot(
      {
        at,
        kind,
        state,
        title: firstLine(rawText) || kind,
        ...(cut ? { text: cut.value } : {}),
        ...(cut?.truncated ? { truncated: true } : {}),
      },
      key,
      cut?.truncated ?? false,
    );
  }

  private upsertStep(
    key: string | undefined,
    kind: TranscriptEntryKind,
    state: TranscriptEntryState,
    title: string,
    at: string,
    extra: {
      input?: Record<string, unknown>;
      output?: string;
      exitCode?: number;
      duration?: number;
      edits?: TranscriptEdit[];
      plan?: TranscriptPlanStep[];
      extraTruncated?: boolean;
    } = {},
  ): void {
    const existing = key ? this.byKey.get(key) : undefined;
    const sanitized = sanitizeInput(extra.input);
    const outCut = extra.output !== undefined ? capString(extra.output) : undefined;
    const truncated = Boolean(sanitized.truncated || outCut?.truncated || extra.extraTruncated);

    if (existing) {
      existing.entry.state = state;
      if (title && (!existing.entry.title || existing.entry.title === 'tool' || existing.entry.title === 'command')) existing.entry.title = title;
      if (sanitized.input && !existing.entry.input) existing.entry.input = sanitized.input;
      if (outCut !== undefined) existing.entry.output = outCut.value;
      if (extra.exitCode !== undefined) existing.entry.exit_code = extra.exitCode;
      if (extra.edits?.length) existing.entry.edit = extra.edits;
      if (extra.plan?.length) existing.entry.plan = extra.plan;
      if (extra.duration !== undefined) existing.entry.duration_seconds = extra.duration;
      else if (state !== 'running' && existing.entry.duration_seconds === undefined) {
        const dur = elapsedSeconds(existing.startedAt, at);
        if (dur !== undefined && dur > 0) existing.entry.duration_seconds = dur;
      }
      if (truncated || existing.baseTruncated) {
        existing.baseTruncated = true;
        existing.entry.truncated = true;
      }
      this.touch(existing);
      return;
    }

    this.createSlot(
      {
        at,
        kind,
        state,
        title: title || kind,
        ...(sanitized.input ? { input: sanitized.input } : {}),
        ...(outCut !== undefined ? { output: outCut.value } : {}),
        ...(extra.exitCode !== undefined ? { exit_code: extra.exitCode } : {}),
        ...(extra.duration !== undefined ? { duration_seconds: extra.duration } : {}),
        ...(extra.edits?.length ? { edit: extra.edits } : {}),
        ...(extra.plan?.length ? { plan: extra.plan } : {}),
        ...(truncated ? { truncated: true } : {}),
      },
      key,
      truncated,
    );
  }

  private createSlot(base: Omit<TranscriptEntry, 'seq'>, key?: string, baseTruncated = false): Slot {
    const entry: TranscriptEntry = { seq: this.nextSeq++, ...base };
    const slot: Slot = { entry, key, rev: ++this.revCounter, startedAt: base.at, baseTruncated };
    this.slots.push(slot);
    if (key) this.byKey.set(key, slot);
    this.enforceCap();
    return slot;
  }

  private touch(slot: Slot): void {
    slot.rev = ++this.revCounter;
  }

  private enforceCap(): void {
    while (this.slots.length > this.maxEntries) {
      while (this.evictCursor < this.slots.length) {
        const k = this.slots[this.evictCursor].entry.kind;
        if (k === 'log' || k === 'reasoning') break;
        this.evictCursor++;
      }
      let dropIdx: number;
      if (this.evictCursor < this.slots.length) {
        dropIdx = this.evictCursor;
      } else {
        dropIdx = 0;
        if (this.evictCursor > 0) this.evictCursor--;
      }
      const [removed] = this.slots.splice(dropIdx, 1);
      if (removed?.key && this.byKey.get(removed.key) === removed) this.byKey.delete(removed.key);
      if (this.openLog?.slot === removed) this.openLog = undefined;
      if (this.grokMessage?.slot === removed) this.grokMessage = undefined;
      this.droppedCount++;
    }
  }

  entries(): TranscriptEntry[] {
    return this.slots.map(s => structuredClone(s.entry));
  }

  changedSince(rev: number): TranscriptEntry[] {
    return this.slots.filter(s => s.rev > rev).map(s => structuredClone(s.entry));
  }

  /**
   * Slices a page of entries:
   * - Without `after`: returns the last `limit` retained entries, with `next` pointing backwards to the preceding page's `after` `seq`.
   * - With `after`: returns any entry still `running` with `seq < after`, followed by up to `limit` entries with `seq >= after`,
   *   and `next` pointing backwards to the preceding page's `after` `seq` when earlier retained entries exist.
   */
  page(options: { after?: number; limit?: number } = {}): Omit<RunTranscript, 'project' | 'key' | 'ended'> {
    const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 200)));
    const len = this.slots.length;
    if (len === 0) return { entries: [], total: this.nextSeq, dropped: this.droppedCount };

    if (options.after === undefined) {
      const startIdx = Math.max(0, len - limit);
      const entries = this.slots.slice(startIdx, len).map(s => structuredClone(s.entry));
      const next = startIdx > 0 ? this.slots[Math.max(0, startIdx - limit)].entry.seq : undefined;
      return { entries, ...(next !== undefined ? { next } : {}), total: this.nextSeq, dropped: this.droppedCount };
    }

    const after = options.after;
    const runningBefore: TranscriptEntry[] = [];
    let firstAfterIdx = len;
    for (let i = 0; i < len; i++) {
      const e = this.slots[i].entry;
      if (e.seq >= after) {
        firstAfterIdx = i;
        break;
      }
      if (e.state === 'running') runningBefore.push(structuredClone(e));
    }
    const pageSlice = this.slots.slice(firstAfterIdx, firstAfterIdx + limit).map(s => structuredClone(s.entry));
    const next = firstAfterIdx > 0 ? this.slots[Math.max(0, firstAfterIdx - limit)].entry.seq : undefined;
    return {
      entries: [...runningBefore, ...pageSlice],
      ...(next !== undefined ? { next } : {}),
      total: this.nextSeq,
      dropped: this.droppedCount,
    };
  }
}

interface CacheRecord {
  fold: TranscriptFold;
  offset: number;
  birthtimeMs?: number;
  ino?: bigint;
  head?: Buffer;
  ended: boolean;
  lastReadAt: number;
  generation: number;
}

export interface TranscriptSyncResult {
  fold: TranscriptFold;
  rev: number;
  total: number;
  generation: number;
}

/** Incremental per-process transcript cache keyed by file path, with rotation rebuild and 10-minute TTL for ended runs. */
export class TranscriptRuns {
  private readonly caches = new Map<string, CacheRecord>();
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_TRANSCRIPT_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  cacheCount(): number {
    return this.caches.size;
  }

  evict(nowMs = Date.now()): void {
    for (const [key, rec] of this.caches) {
      if (rec.ended && nowMs - rec.lastReadAt >= ENDED_CACHE_TTL_MS) this.caches.delete(key);
    }
  }

  sync(file: string, options: { ended?: boolean; now?: Date } = {}): TranscriptSyncResult {
    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    let rec = this.caches.get(file);
    if (!rec) {
      rec = { fold: new TranscriptFold(this.maxEntries), offset: 0, ended: Boolean(options.ended), lastReadAt: nowMs, generation: 1 };
      this.caches.set(file, rec);
    }
    if (options.ended) rec.ended = true;
    rec.lastReadAt = nowMs;

    try {
      const stat = statSync(file, { bigint: true });
      const size = Number(stat.size);
      const birth = Number(stat.birthtimeMs);
      const ino = stat.ino;
      const rotatedMeta =
        size < rec.offset ||
        (rec.birthtimeMs !== undefined && birth !== rec.birthtimeMs) ||
        (rec.ino !== undefined && ino !== 0n && rec.ino !== 0n && ino !== rec.ino);
      if (rotatedMeta) {
        rec.fold = new TranscriptFold(this.maxEntries);
        rec.offset = 0;
        rec.head = undefined;
        rec.generation++;
      }
      rec.birthtimeMs = birth;
      rec.ino = ino;

      if (size > 0) {
        const fd = openSync(file, 'r');
        try {
          if (rec.offset > 0 && rec.head && rec.head.length > 0) {
            const check = Buffer.allocUnsafe(rec.head.length);
            const got = readSync(fd, check, 0, check.length, 0);
            if (got !== rec.head.length || !check.equals(rec.head)) {
              rec.fold = new TranscriptFold(this.maxEntries);
              rec.offset = 0;
              rec.head = undefined;
              rec.generation++;
            }
          }
          const observedAt = new Date(Number(stat.mtimeMs)).toISOString();
          while (rec.offset < size) {
            // Read up to READ_CHUNK_BYTES; if a single line spans past READ_CHUNK_BYTES, scan forward to its newline.
            let span = Math.min(READ_CHUNK_BYTES, size - rec.offset);
            let buffer = Buffer.allocUnsafe(span);
            let n = readSync(fd, buffer, 0, span, rec.offset);
            let cut = buffer.subarray(0, n).lastIndexOf(10);
            while (cut < 0 && rec.offset + n < size) {
              const extraSpan = Math.min(READ_CHUNK_BYTES, size - (rec.offset + n));
              const extra = Buffer.allocUnsafe(extraSpan);
              const m = readSync(fd, extra, 0, extraSpan, rec.offset + n);
              if (m <= 0) break;
              buffer = Buffer.concat([buffer.subarray(0, n), extra.subarray(0, m)]);
              n += m;
              cut = buffer.lastIndexOf(10);
            }
            if (cut < 0) break;
            if (!rec.head && rec.offset === 0) {
              rec.head = Buffer.from(buffer.subarray(0, Math.min(cut + 1, HEADER_FINGERPRINT_BYTES)));
            }
            const text = buffer.subarray(0, cut).toString('utf8');
            rec.offset += cut + 1;
            for (const line of text.split('\n')) rec.fold.line(line, observedAt);
          }
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      /* file not created yet or rotated concurrently */
    }

    this.evict(nowMs);
    // Keep the record we just read even if it was already marked ended before this read.
    rec.lastReadAt = nowMs;
    this.caches.set(file, rec);
    return { fold: rec.fold, rev: rec.fold.rev, total: rec.fold.total, generation: rec.generation };
  }

  page(file: string, options: { after?: number; limit?: number; ended?: boolean; now?: Date } = {}): Omit<RunTranscript, 'project' | 'key' | 'ended'> {
    const { fold } = this.sync(file, { ended: options.ended, now: options.now });
    return fold.page({ after: options.after, limit: options.limit });
  }

  changedSince(file: string, rev: number, options: { ended?: boolean; now?: Date } = {}): { entries: TranscriptEntry[]; rev: number; generation: number } {
    const synced = this.sync(file, options);
    return { entries: synced.fold.changedSince(rev), rev: synced.rev, generation: synced.generation };
  }
}

export const transcriptRuns = new TranscriptRuns();
