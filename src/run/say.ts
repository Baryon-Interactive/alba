import { fail, t, UserError } from '../i18n.ts';
import { actionProblem } from '../orders/stage.ts';
import type { Run } from '../orders/model.ts';
import { ownerOf } from '../usage/spend.ts';
import type { Probes } from '../tick/gather.ts';
import { sayDeliveryMode } from '../workers/config.ts';
import { appendInbox, type SayDeliveryMode } from './inbox.ts';
import { requeueUndeliveredInbox } from './messages.ts';
import { startRun, type RunContext, type StartResult } from './launch.ts';
import { runProcessMatches } from './kill-tree.ts';

export interface SayResult {
  stage: string;
  restarted: boolean;
  message: string;
  delivery?: SayDeliveryMode;
  started?: Extract<StartResult, { mode: 'start' }>;
}

/** Verifies the recorded OS creation time; older records retain the launch-window check before the stop probe validates them. */
export function isOwnProcess(run: Run, probes: Probes): boolean {
  if (run.imported || !run.pid || !probes.isAlive(run.pid) || !probes.processStartedAt) return false;
  const started = probes.processStartedAt(run.pid);
  return runProcessMatches(started, run.process_started_at, run.started);
}

/**
 * Leaves a message for a running order.
 * Without `restart` it is appended to `.alba/inbox.md` in the worktree (the worker reads that).
 * With `restart` the run's own process is stopped, the message is recorded as a note, and a new run carries it
 * (the same session when the engine can continue one).
 */
export function sayToOrder(ctx: RunContext, tag: string, text: string | undefined, options: { restart?: boolean; reply?: string } = {}): SayResult {
  if (!text?.trim()) fail('A message needs its text (--text).');
  const { orders, workers } = ctx;
  const doc = orders.get(tag);
  const open = doc.runs.find(r => r.ended === undefined);
  const body = text.trim();
  if (options.reply && !doc.outbox?.some(e => e.id === options.reply)) fail('No worker message "{id}".', { id: options.reply });
  if (!open) {
    orders.act(tag, 'message', { note: body, queued: true });
    if (options.reply) orders.answerOutbox(tag, options.reply, { id: `queued-${orders.get(tag).actions.at(-1)!.seq}`, at: orders.now(), text: body });
    return { stage: orders.stage(orders.get(tag)).stage, restarted: false, message: t('Message queued for the next run of {tag}.', { tag: doc.order.tag }) };
  }
  if (!options.restart) {
    const worktree = doc.order.worktree;
    if (!worktree) fail('{tag} has no worktree, so there is nowhere to leave the message.', { tag: doc.order.tag });
    const at = orders.now();
    const id = appendInbox(worktree, { at, author: orders.actor, text: body, reply: options.reply });
    if (options.reply) orders.answerOutbox(tag, options.reply, { id, at, text: body });
    const worker = ownerOf(workers.workers, open.worker);
    const delivery = sayDeliveryMode(worker, open.engine, !!open.host);
    orders.record(doc.order.tag, 'message', { id, at, run: open.id, text: body, delivery, ...(options.reply ? { reply: options.reply } : {}) });
    const message = delivery === 'steer'
      ? t('Message left for {tag} (steer: sent directly into the running Codex turn).', { tag: doc.order.tag })
      : delivery === 'live'
        ? t('Message left for {tag} (live: delivered on the next tool or model call).', { tag: doc.order.tag })
        : t('Message left for {tag} (file: the open run reads it from the worktree inbox).', { tag: doc.order.tag });
    return { stage: orders.stage(orders.get(tag)).stage, restarted: false, delivery, message };
  }
  const problem = actionProblem(orders.stage(doc).stage, 'message');
  if (problem) fail('{tag}: {problem}', { tag: doc.order.tag, problem });
  if (!open) fail('{tag} has no open run to leave a message for.', { tag: doc.order.tag });
  if (open.imported || !open.pid) fail('{tag} has no process this tool started, so it is not stopped.', { tag: doc.order.tag });
  if (ctx.probes.isAlive(open.pid)) {
    if (!isOwnProcess(open, ctx.probes)) fail('Refusing to stop process {pid} of {tag}: it is not the process this run started.', { pid: open.pid, tag: doc.order.tag });
    if (!ctx.probes.kill) fail('Refusing to stop process {pid} of {tag}: it is not the process this run started.', { pid: open.pid, tag: doc.order.tag });
    const stopped = ctx.probes.kill(open.pid, open.process_started_at, open.started);
    if (!stopped.includes(open.pid)) fail('Refusing to stop process {pid} of {tag}: it is not the process this run started.', { pid: open.pid, tag: doc.order.tag });
  }
  const prev = open.id;
  orders.runEnd(doc.order.tag, 'cancelled');
  requeueUndeliveredInbox(orders, doc.order.tag, open);
  orders.act(doc.order.tag, 'message', { note: body });
  const worker = doc.order.next_worker ? workers.workers.find(w => w.id === doc.order.next_worker) : ownerOf(workers.workers, open.worker);
  const after = orders.stage(orders.get(tag));
  if (after.stage !== 'queued' || !worker || worker.card_only || !worker.launch) {
    return { stage: after.stage, restarted: true, message: t('Message recorded; {tag} is {stage}. {why}', { tag: doc.order.tag, stage: after.stage, why: t('The worker cannot be started by the tool, so a person starts the next round.') }) };
  }
  let started: StartResult;
  try { started = startRun(ctx, doc.order.tag, worker.id); } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return { stage: orders.stage(orders.get(tag)).stage, restarted: true, message: t('Message recorded, but the worker could not be started: {why}', { why: e.message.split(/\r?\n/)[0] }) };
  }
  if (started.mode !== 'start') return { stage: orders.stage(orders.get(tag)).stage, restarted: true, message: started.text };
  const line = started.resumed
    ? t('Message recorded; the session of run {prev} continues as run {run} on {worker}.', { prev, run: started.run ?? '-', worker: worker.id })
    : t('Message recorded and run {run} started on {worker}.', { run: started.run ?? '-', worker: worker.id });
  return { stage: orders.stage(orders.get(tag)).stage, restarted: true, started, message: line };
}
