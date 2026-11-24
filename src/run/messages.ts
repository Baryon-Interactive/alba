import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Orders } from '../orders/service.ts';
import type { OrderDoc, Run } from '../orders/model.ts';
import { appendDisposed, inboxPath, parseInbox, readAckIds, readDelivered, readDisposed, readInbox } from './inbox.ts';
import { runFollowedNotes } from './prompt.ts';
import type { LiveState } from './live.ts';

import type { OutboxEntry, ThreadEntry } from '../api/live-types.ts';
export type { OutboxEntry, ThreadEntry } from '../api/live-types.ts';

/**
 * The complete lines of a worker's `.alba/outbox.jsonl`. A byte order mark (Windows PowerShell writes one) is ignored; an entry
 * without a usable `at` gets `missingAt` (the time alba reads it) when given, and is skipped otherwise.
 */
export function parseOutbox(text: string, missingAt?: string): OutboxEntry[] {
  return text.split('\n').slice(0, -1).flatMap((line, index) => {
    try {
      const e = JSON.parse(line.replace(/^\uFEFF/, ''));
      const at = typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)) ? e.at : missingAt;
      if (!['question', 'blocker', 'note', 'eta'].includes(e.kind) || typeof e.text !== 'string' || !e.text.trim() || !at) return [];
      const id = `out-${createHash('sha256').update(`${index}\n${line}`).digest('hex').slice(0, 20)}`;
      return [{ id, at, kind: e.kind, text: e.text, ...(Array.isArray(e.options) ? { options: e.options.filter((v: unknown) => typeof v === 'string') } : {}), ...(typeof e.reply === 'string' ? { reply: e.reply } : {}) }];
    } catch { return []; }
  });
}

/** Durable idempotent pickup; a partial final line waits for its newline. Called by the server and real ticks. */
export function pickupOutbox(orders: Orders, tag: string): void {
  const doc = orders.get(tag), worktree = doc.order.worktree;
  if (!worktree) return;
  try {
    const entries = parseOutbox(readFileSync(path.join(worktree, '.alba', 'outbox.jsonl'), 'utf8'), orders.now());
    for (const entry of entries) if (!doc.outbox?.some(e => e.id === entry.id)) orders.receiveOutbox(tag, entry);
  } catch { /* no outbox yet */ }
}

/**
 * Questions and blockers from the run that no person has answered: an `answer` action after the entry also counts as its answer.
 * A blocker the worker wrote anything after (a note that it went on, another blocker) is past: the worker is not stuck on it any more.
 * Times are alba's own pickup times where recorded (a worker's `at` may be made up or in another offset).
 */
export const unanswered = (doc: OrderDoc): OutboxEntry[] => {
  // Times are compared as instants: a run may write its own offset (+08:00) while alba writes UTC.
  const lastAnswer = Math.max(-Infinity, ...doc.actions.filter(a => a.kind === 'answer').map(a => Date.parse(a.at)).filter(Number.isFinite));
  const out = doc.outbox ?? [];
  return out.filter((e, i) => ['question', 'blocker'].includes(e.kind) && !e.answered && !(lastAnswer >= Date.parse(e.received ?? e.at)) && !(e.kind === 'blocker' && i < out.length - 1));
};

/** The worker's open questions: these, not blockers or notes, put a running order in front of a person (`awaiting-user`). */
export const openQuestions = (doc: OrderDoc): OutboxEntry[] => unanswered(doc).filter(e => e.kind === 'question');

/** Collects model activity timestamps (messages, tool calls, commands, file changes) from a `LiveState`. */
export function liveActivityTimes(live?: LiveState): string[] {
  if (!live) return [];
  const times: string[] = [];
  if (live.last_activity_at) times.push(live.last_activity_at);
  for (const a of live.recent) if (a.kind !== 'error' && a.kind !== 'log') times.push(a.at);
  for (const m of live.messages) times.push(m.at);
  return times;
}

/**
 * Requeues (or drops, for terminal orders) inbox entries written during a run that ended before the entry was
 * delivered, acknowledged, or marked seen. Idempotent: a message is requeued or dropped at most once.
 * Remote runs keep their file inbox and are skipped because remote ack/seen files are not synced back locally.
 */
export function requeueUndeliveredInbox(
  orders: Orders,
  tag: string,
  run: Pick<Run, 'id' | 'started' | 'ended' | 'cwd' | 'host'> | undefined,
): { requeued: number; dropped: number } {
  if (!run || run.host) return { requeued: 0, dropped: 0 };
  const doc = orders.get(tag);
  const worktree = doc.order.worktree ?? run.cwd;
  if (!worktree) return { requeued: 0, dropped: 0 };
  const file = inboxPath(worktree);
  if (!existsSync(file)) return { requeued: 0, dropped: 0 };
  let entries;
  try { entries = parseInbox(readFileSync(file, 'utf8')); } catch { return { requeued: 0, dropped: 0 }; }
  if (!entries.length) return { requeued: 0, dropped: 0 };

  const delivered = readDelivered(worktree);
  const ackIds = readAckIds(worktree);
  const disposed = readDisposed(worktree);
  const outbox = doc.outbox ?? [];
  const existingRequeued = new Set(doc.actions.map(a => a.requeued_from).filter((x): x is string => !!x));
  const stage = orders.stage(doc).stage;
  const terminal = stage === 'merged' || stage === 'cancelled' || stage === 'dropped';
  const startMs = Date.parse(run.started);

  let requeued = 0;
  let dropped = 0;
  for (const m of entries) {
    const mMs = Date.parse(m.at);
    if (Number.isFinite(mMs) && Number.isFinite(startMs) && mMs < startMs) continue;
    if (m.seen || ackIds.has(m.id) || delivered.has(m.id) || disposed.has(m.id) || existingRequeued.has(m.id)) continue;
    if (outbox.some(e => e.reply === m.id)) continue;
    const at = orders.now();
    if (terminal) {
      const reason = `order is ${stage}`;
      appendDisposed(worktree, { id: m.id, state: 'dropped', at, run: run.id, reason });
      orders.record(doc.order.tag, 'inbox-dropped', { id: m.id, run: run.id, at, reason });
      disposed.set(m.id, { id: m.id, state: 'dropped', at, run: run.id, reason });
      dropped++;
      continue;
    }
    const updated = orders.act(doc.order.tag, 'message', {
      note: m.text,
      queued: true,
      force: true,
      author: m.author,
      requeuedFrom: m.id,
    });
    const action = [...updated.actions].reverse().find(a => a.requeued_from === m.id);
    const actionSeq = action?.seq;
    const rec = { id: m.id, state: 'requeued' as const, at, run: run.id, ...(actionSeq !== undefined ? { action_seq: actionSeq } : {}) };
    appendDisposed(worktree, rec);
    orders.record(doc.order.tag, 'inbox-requeued', { id: m.id, run: run.id, at, ...(actionSeq !== undefined ? { action_seq: actionSeq } : {}) });
    disposed.set(m.id, rec);
    existingRequeued.add(m.id);
    requeued++;
  }
  return { requeued, dropped };
}

export function threadOf(doc: OrderDoc, live?: LiveState): ThreadEntry[] {
  const messages = doc.order.worktree ? readInbox(doc.order.worktree, { openedAt: live?.inbox_opened_at, activityAt: liveActivityTimes(live) }) : [];
  const out = doc.outbox ?? [];
  const thread: ThreadEntry[] = messages.map(m => {
    const answered = out.some(e => e.reply === m.id) || (m.seen && live?.messages.some(e => e.at >= m.seen! && e.at > m.at));
    return {
      id: m.id,
      at: m.at,
      kind: 'inbox',
      text: m.text,
      ...(m.reply ? { reply: m.reply } : {}),
      ...(m.delivered_at ? { delivered_at: m.delivered_at } : {}),
      ...(m.via ? { via: m.via } : {}),
      ...(m.seen ? { seen: m.seen } : {}),
      ...(m.requeued_at ? { requeued_at: m.requeued_at } : {}),
      ...(m.action_seq !== undefined ? { action_seq: m.action_seq } : {}),
      ...(m.dropped_at ? { dropped_at: m.dropped_at } : {}),
      ...(m.drop_reason ? { drop_reason: m.drop_reason } : {}),
      delivery: answered ? 'answered' : m.delivery,
    };
  });
  for (const e of out) thread.push({ ...e, delivery: e.answered ? 'answered' : undefined });
  for (const r of doc.reports) thread.push({ id: `report-${r.seq}`, at: r.at, kind: 'report', text: [r.summary, r.question].filter(Boolean).join('\n') });
  for (const a of doc.actions.filter(a => ['answer', 'rework', 'message'].includes(a.kind))) {
    if (a.kind === 'message' && a.requeued_from) {
      const laterRuns = doc.runs.filter(r => r.seq > a.seq).sort((x, y) => x.seq - y.seq);
      const followed = laterRuns.find(r => runFollowedNotes(doc, r));
      const firstRun = laterRuns[0];
      thread.push({
        id: `action-${a.seq}`,
        at: a.at,
        kind: a.kind,
        text: a.note ?? '',
        ...(followed
          ? { delivery: 'read', delivered_at: followed.started, seen: followed.ended }
          : firstRun
            ? { delivery: 'delivered', delivered_at: firstRun.started }
            : { delivery: 'sent' }),
      });
    } else {
      thread.push({ id: `action-${a.seq}`, at: a.at, kind: a.kind, text: a.note ?? '' });
    }
  }
  return thread.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
