import { randomBytes } from 'node:crypto';
import { existsSync, readSync, openSync, closeSync, statSync, watch, type FSWatcher } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { stateStore, type StateProject } from '../orders/backend.ts';
import { Orders } from '../orders/service.ts';
import { stateProject } from '../orders/state-files.ts';
import { SqliteStore } from '../orders/sqlite-store.ts';
import { transcriptRuns } from '../run/transcript.ts';
import type { OrderEvent, QuotaPoint, StreamEventName, StreamEvents } from './types.ts';

export interface HubProject { id: string; stateDir: string; config?: StateProject }

interface Message { n: number; project: string; name: StreamEventName; data: unknown }

interface Client {
  res: ServerResponse;
  project: string;
  /** Run log subscriptions: key -> byte offset up to which the client has been sent lines. */
  logs: Map<string, { path: string; offset: number }>;
  /** Run transcript subscriptions: key -> revision up to which the client has been sent entries. */
  transcripts: Map<string, { path: string; rev: number; generation: number }>;
}

/** The name an entry of the event log goes out under. */
export function streamName(type: string): StreamEventName {
  if (type === 'order-added') return 'order.added';
  if (type === 'order-updated') return 'order.updated';
  if (type.startsWith('action-')) return 'order.action';
  if (type === 'report') return 'order.report';
  if (type === 'run-start') return 'run.start';
  if (type === 'run-updated') return 'run.updated';
  if (type === 'run-end') return 'run.end';
  if (type === 'check') return 'check.done';
  if (type === 'refs-adopt') return 'refs.adopted';
  if (type === 'decision') return 'decision.added';
  if (type === 'workers.edited') return 'workers.edited';
  if (type === 'skills.edited') return 'skills.edited';
  if (type === 'question-asked') return 'question.asked';
  if (type === 'question-answered') return 'question.answered';
  if (type.startsWith('quote-')) return 'credits.changed';
  if (type === 'clean') return 'clean.done';
  return 'log.other';
}

export interface HubOptions {
  /** How long after a file change the scan runs, so that a burst of writes is one scan (default 50 ms). */
  watchDelayMs?: number;
  ringSize?: number;
  /** How often the files are looked at besides the file-system watchers. */
  checkMs?: number;
  pingMs?: number;
  /** Where the log of a run is: `key` is `<TAG>:<run id>`. */
  resolveLog(project: string, key: string): string | undefined;
  /** Where the transcript stream (`events_file ?? log`) of a run is; falls back to the project's orders, then `resolveLog`. */
  resolveTranscript?(project: string, key: string): string | undefined;
}

const MAX_LOG_CHUNK = 256 * 1024;

/**
 * Server-Sent Events for the board. It watches each project's state folder (`events.jsonl`, `quota-history.jsonl`) and the logs that a
 * client subscribed to, and sends what was appended. It keeps the last messages in memory to replay them after a reconnect.
 */
export class Hub {
  readonly boot = randomBytes(4).toString('hex');
  private seq = 0;
  private readonly ring: Message[] = [];
  private readonly clients = new Set<Client>();
  private readonly marks = new Map<string, { events: number; eventCount: number; quota: number }>();
  private readonly watchers: FSWatcher[] = [];
  private timers: NodeJS.Timeout[] = [];
  private readonly ringSize: number;
  private readonly options: HubOptions;
  private readonly projects: HubProject[];
  private scanning = false;
  /** Called when something new was found in a state folder (the board drops its cached view). */
  onChange?: () => void;
  /** Live run and mailbox polling, shared with the one-second stream scan. */
  onScan?: () => void;

  constructor(projects: HubProject[], options: HubOptions) {
    this.projects = projects;
    this.options = options;
    this.ringSize = options.ringSize ?? 2000;
    for (const p of projects) {
      const store = stateStore(p.config ?? stateProject(p.stateDir));
      this.marks.set(p.id, { events: sizeOf(path.join(p.stateDir, 'events.jsonl')), eventCount: store instanceof SqliteStore ? store.lastEventId() : countLines(path.join(p.stateDir, 'events.jsonl')), quota: store instanceof SqliteStore ? store.lastQuotaId() : sizeOf(path.join(p.stateDir, 'quota-history.jsonl')) });
    }
  }

  /** Starts the file-system watchers and the slow safety check. */
  start(): void {
    for (const p of this.projects) {
      if (!existsSync(p.stateDir)) continue;
      try {
        const w = watch(p.stateDir, { persistent: false }, (_event, file) => { if (!file || /^(events\.jsonl|quota-history\.jsonl|state\.sqlite(?:-wal)?)$/.test(String(file))) this.scanSoon(); });
        w.on('error', () => { /* the slow check still runs */ });
        this.watchers.push(w);
      } catch { /* the slow check still runs */ }
    }
    this.timers.push(setInterval(() => this.scan(), this.options.checkMs ?? 1000).unref());
    this.timers.push(setInterval(() => { for (const c of this.clients) c.res.write(': ping\n\n'); }, this.options.pingMs ?? 20_000).unref());
  }

  /**
   * A scan shortly after a file change: every write to the SQLite log fires the watcher (a tick writes dozens of rows), and a
   * burst of them becomes one scan.
   */
  private soon?: NodeJS.Timeout;
  scanSoon(): void {
    if (this.soon) return;
    this.soon = setTimeout(() => { this.soon = undefined; this.scan(); }, this.options.watchDelayMs ?? 50);
    this.soon.unref();
  }

  stop(): void {
    if (this.soon) { clearTimeout(this.soon); this.soon = undefined; }
    for (const w of this.watchers) w.close();
    for (const t of this.timers) clearInterval(t);
    this.watchers.length = 0;
    this.timers = [];
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  clientCount(): number { return this.clients.size; }

  /** Sends a message to the clients of the project and keeps it for replay. */
  publish<N extends StreamEventName>(project: string, name: N, data: StreamEvents[N]): number {
    const message: Message = { n: ++this.seq, project, name, data };
    this.ring.push(message);
    if (this.ring.length > this.ringSize) this.ring.shift();
    for (const c of this.clients) if (c.project === project) this.write(c, message);
    return message.n;
  }

  private frame(message: Message): string {
    return `id: ${this.boot}.${message.n}\nevent: ${message.name}\ndata: ${JSON.stringify(message.data)}\n\n`;
  }

  private write(client: Client, message: Message): void {
    client.res.write(this.frame(message));
  }

  /** Looks for new entries in the event logs and quota files and for new lines in the subscribed logs. Safe to call at any time. */
  scan(): void {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const before = this.seq;
      this.onScan?.();
      for (const p of this.projects) { this.scanEvents(p); this.scanQuota(p); }
      if (this.seq !== before) this.onChange?.();
      for (const c of this.clients) { this.scanLogs(c); this.scanTranscripts(c); }
    } finally { this.scanning = false; }
  }

  private scanEvents(p: HubProject): void {
    const store = stateStore(p.config ?? stateProject(p.stateDir));
    if (store instanceof SqliteStore) {
      const mark = this.marks.get(p.id)!;
      for (const event of store.eventsAfter(mark.eventCount)) {
        mark.eventCount = event.id;
        this.publish(p.id, streamName(event.type), { ...event, project: p.id } as StreamEvents['order.added']);
      }
      return;
    }
    const file = path.join(p.stateDir, 'events.jsonl');
    const mark = this.marks.get(p.id)!;
    const size = sizeOf(file);
    if (size < mark.events) { mark.events = 0; mark.eventCount = 0; }
    if (size === mark.events) return;
    const { text, end } = readFrom(file, mark.events, size);
    mark.events += end;
    for (const line of text.split('\n').filter(Boolean)) {
      let event: Omit<OrderEvent, 'id'>;
      try { event = JSON.parse(line) as Omit<OrderEvent, 'id'>; } catch { continue; }
      mark.eventCount++;
      this.publish(p.id, streamName(event.type), { ...event, id: mark.eventCount, project: p.id } as StreamEvents['order.added']);
    }
  }

  private scanQuota(p: HubProject): void {
    const store = stateStore(p.config ?? stateProject(p.stateDir));
    if (store instanceof SqliteStore) {
      const mark = this.marks.get(p.id)!;
      if (store.lastQuotaId() === mark.quota) return;
      const rows = store.quotaRowsAfter(mark.quota);
      if (rows.length) mark.quota = rows[rows.length - 1].id;
      const points: QuotaPoint[] = rows.map(({ reading: q }) => ({ source: q.source, at: q.at, ok: q.ok, ...(q.error ? { error: q.error } : {}), ...(q.note ? { note: q.note } : {}), windows: q.windows, ...(q.balance ? { balance: q.balance } : {}) }));
      if (points.length) this.publish(p.id, 'quota', { project: p.id, points });
      return;
    }
    const file = path.join(p.stateDir, 'quota-history.jsonl');
    const mark = this.marks.get(p.id)!;
    const size = sizeOf(file);
    if (size < mark.quota) mark.quota = 0;
    if (size === mark.quota) return;
    const { text, end } = readFrom(file, mark.quota, size);
    mark.quota += end;
    const points: QuotaPoint[] = [];
    for (const line of text.split('\n').filter(Boolean)) {
      try { const q = JSON.parse(line) as QuotaPoint; points.push({ source: q.source, at: q.at, ok: q.ok, ...(q.error ? { error: q.error } : {}), ...(q.note ? { note: q.note } : {}), windows: q.windows ?? [], ...(q.balance ? { balance: q.balance } : {}) }); } catch { /* skip */ }
    }
    if (points.length) this.publish(p.id, 'quota', { project: p.id, points });
  }

  private scanLogs(client: Client): void {
    for (const [key, sub] of client.logs) {
      const size = sizeOf(sub.path);
      if (size < sub.offset) sub.offset = 0;
      if (size === sub.offset) continue;
      const { text, end } = readFrom(sub.path, sub.offset, Math.min(size, sub.offset + MAX_LOG_CHUNK));
      if (!end) continue;
      sub.offset += end;
      const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
      lines.pop();   // text ends with "\n": the last element is empty
      client.res.write(`event: run.log\ndata: ${JSON.stringify({ project: client.project, key, lines, offset: sub.offset })}\n\n`);
    }
  }

  private resolveTranscriptFile(project: string, key: string): string | undefined {
    if (this.options.resolveTranscript) return this.options.resolveTranscript(project, key);
    const p = this.projects.find(x => x.id === project);
    const sep = key.lastIndexOf(':');
    if (p && sep >= 1) {
      try {
        const orders = new Orders(stateStore(p.config ?? stateProject(p.stateDir)), () => new Date().toISOString(), 'web');
        const run = orders.get(key.slice(0, sep)).runs.find(r => r.id === key.slice(sep + 1));
        if (run?.events_file || run?.log) return run.events_file ?? run.log;
      } catch { /* fall back to resolveLog */ }
    }
    return this.options.resolveLog(project, key);
  }

  private scanTranscripts(client: Client): void {
    for (const [key, sub] of client.transcripts) {
      let changed = transcriptRuns.changedSince(sub.path, sub.rev);
      if (changed.generation !== sub.generation) changed = transcriptRuns.changedSince(sub.path, 0);
      sub.rev = changed.rev;
      sub.generation = changed.generation;
      if (changed.entries.length) {
        client.res.write(`event: run.transcript\ndata: ${JSON.stringify({ project: client.project, key, entries: changed.entries })}\n\n`);
      }
    }
  }

  /**
   * Opens an event stream for a project. `lastEventId` comes from the client's `Last-Event-ID` header: messages after it are sent again
   * when it is from this process and still in memory; otherwise the client is told to read the lists again (`resync`).
   */
  connect(req: IncomingMessage, res: ServerResponse, project: string, logs: { key: string; offset?: number }[], lastEventId?: string, transcripts: { key: string; offset?: number }[] = []): void {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    res.write('retry: 3000\n\n');
    const client: Client = { res, project, logs: new Map(), transcripts: new Map() };
    for (const l of logs) {
      const file = this.options.resolveLog(project, l.key);
      if (file) client.logs.set(l.key, { path: file, offset: l.offset ?? sizeOf(file) });
    }
    const catchUps: { key: string; entries: StreamEvents['run.transcript']['entries'] }[] = [];
    for (const tr of transcripts) {
      const file = this.resolveTranscriptFile(project, tr.key);
      if (!file) continue;
      const synced = transcriptRuns.sync(file);
      client.transcripts.set(tr.key, { path: file, rev: synced.rev, generation: synced.generation });
      if (tr.offset !== undefined && synced.total > tr.offset) {
        const page = synced.fold.page({ after: tr.offset, limit: 1000 });
        if (page.entries.length) catchUps.push({ key: tr.key, entries: page.entries });
      }
    }
    let replay: Message[] | undefined = [];
    let reason = '';
    if (lastEventId) {
      const m = /^([0-9a-f]+)\.(\d+)$/.exec(lastEventId);
      const first = this.ring[0]?.n ?? this.seq + 1;
      if (!m || m[1] !== this.boot) { replay = undefined; reason = 'the server was restarted'; }
      else if (Number(m[2]) > this.seq) { replay = undefined; reason = 'unknown event id'; }
      else if (Number(m[2]) + 1 < first) { replay = undefined; reason = 'the missed messages are no longer kept'; }
      else replay = this.ring.filter(x => x.n > Number(m[2]) && x.project === project);
    }
    // hello first, then the messages it counts (or the request to read everything again)
    res.write(`event: hello\ndata: ${JSON.stringify({ boot: this.boot, project, at: new Date().toISOString(), replayed: replay?.length ?? 0 })}\n\n`);
    if (replay === undefined) res.write(`event: resync\ndata: ${JSON.stringify({ reason })}\n\n`);
    else for (const message of replay) this.write(client, message);
    for (const cu of catchUps) res.write(`event: run.transcript\ndata: ${JSON.stringify({ project, key: cu.key, entries: cu.entries })}\n\n`);
    this.clients.add(client);
    req.on('close', () => { this.clients.delete(client); });
  }
}

function sizeOf(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  const { text } = readFrom(file, 0, sizeOf(file));
  return text.split('\n').filter(Boolean).length;
}

/** Reads bytes [from, to) and returns the text up to the last newline, with how many bytes that is. */
function readFrom(file: string, from: number, to: number): { text: string; end: number } {
  if (to <= from) return { text: '', end: 0 };
  const buffer = Buffer.alloc(to - from);
  const fd = openSync(file, 'r');
  try { readSync(fd, buffer, 0, buffer.length, from); } finally { closeSync(fd); }
  const cut = buffer.lastIndexOf(10);
  if (cut < 0) return { text: '', end: 0 };
  return { text: buffer.subarray(0, cut + 1).toString('utf8'), end: cut + 1 };
}
