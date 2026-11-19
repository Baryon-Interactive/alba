import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Orders } from '../orders/service.ts';
import type { OrderDoc } from '../orders/model.ts';
import { readInbox } from './inbox.ts';
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

export function threadOf(doc: OrderDoc, live?: LiveState): ThreadEntry[] {
  const messages = doc.order.worktree ? readInbox(doc.order.worktree, { openedAt: live?.inbox_opened_at, activityAt: liveActivityTimes(live) }) : [];
  const out = doc.outbox ?? [];
  const thread: ThreadEntry[] = messages.map(m => ({
    id: m.id,
    at: m.at,
    kind: 'inbox',
    text: m.text,
    ...(m.reply ? { reply: m.reply } : {}),
    ...(m.delivered_at ? { delivered_at: m.delivered_at } : {}),
    ...(m.via ? { via: m.via } : {}),
    ...(m.seen ? { seen: m.seen } : {}),
    delivery: out.some(e => e.reply === m.id) || (m.seen && live?.messages.some(e => e.at >= m.seen! && e.at > m.at)) ? 'answered' : m.delivery,
  }));
  for (const e of out) thread.push({ ...e, delivery: e.answered ? 'answered' : undefined });
  for (const r of doc.reports) thread.push({ id: `report-${r.seq}`, at: r.at, kind: 'report', text: [r.summary, r.question].filter(Boolean).join('\n') });
  for (const a of doc.actions.filter(a => ['answer', 'rework', 'message'].includes(a.kind))) thread.push({ id: `action-${a.seq}`, at: a.at, kind: a.kind, text: a.note ?? '' });
  return thread.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
