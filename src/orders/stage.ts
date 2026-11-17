import type { Action, ActionKind, Order, Report, Run, Stage, WaitingFor } from './model.ts';
import { t } from '../i18n.ts';

export interface StageResult {
  stage: Stage;
  why: string;
  /** For `awaiting-user` and `blocked`: whether a person has to click a card or to give an answer. Only an answer can be given as an answer. */
  waitingFor?: WaitingFor;
}

/**
 * The stage of an order, inferred from stored facts only. The first matching row wins, so the rows are
 * mutually exclusive and cover everything. Nothing here is ever set by hand.
 *
 *  1 cancelled        last relevant action is cancel
 *  2 merged           approved and not sent back
 *  3 held             put on hold by a person
 *  4 awaiting-user    the current report is waiting and asks a question
 *  5 awaiting-review  the current report is ready
 *  6 blocked          the current report is blocked
 *  7 failed           the current report is failed
 *  8 dropped          the current report is dropped
 *  9 monitoring       the current report hands a long job to the monitor (no run is open); a person's queue or rework, or the end of the monitor, ends it
 *  9 running          a run is open
 * 10 idle             nothing is pending: a run finished (or the worker is just waiting) and nobody asked for more
 * 11 waiting-needs    queued, but a needed order is not merged yet
 * 12 queued           queued and ready for a worker
 * 13 draft            none of the above
 *
 * A report is "current" only if no person queued/reworked the order and no run started after it was written.
 * `merged` is the set of tags of merged orders (used for `needs`).
 */
export function inferStage(order: Order, runs: readonly Run[], reports: readonly Report[], actions: readonly Action[], merged: ReadonlySet<string>): StageResult {
  let cancelled = false, isMerged = false, held = false, queued = false, lastReset = 0;
  let mergeAction: Action | undefined;
  for (const a of [...actions].sort((x, y) => x.seq - y.seq)) {
    if (a.kind === 'message' && a.queued) continue;
    switch (a.kind) {
      case 'queue': queued = true; cancelled = false; lastReset = a.seq; break;
      case 'answer': case 'rework': case 'monitor': case 'message': queued = true; isMerged = false; mergeAction = undefined; lastReset = a.seq; break;
      case 'cancel': cancelled = true; break;
      case 'hold': held = true; break;
      case 'release': held = false; break;
      case 'approve': isMerged = true; mergeAction = a; break;
      case 'merged-elsewhere': isMerged = true; cancelled = false; mergeAction = a; break;
      case 'done-by-lead': isMerged = true; cancelled = false; mergeAction = a; break;
    }
  }
  const lastStart = runs.reduce((n, r) => Math.max(n, r.seq), 0);
  const cutoff = Math.max(lastReset, lastStart);
  const current = [...reports].filter(r => r.seq > cutoff).sort((x, y) => y.seq - x.seq)[0];
  const open = runs.find(r => r.ended === undefined);
  const lastRun = [...runs].filter(r => r.seq > lastReset).sort((x, y) => y.seq - x.seq)[0];
  const unmet = order.needs.filter(n => !merged.has(n));

  const hit = (stage: Stage, why: string, waitingFor?: WaitingFor): StageResult => ({ stage, why, ...(waitingFor ? { waitingFor } : {}) });
  if (cancelled) return hit('cancelled', t('cancelled by a person'));
  if (isMerged) {
    const why = mergeAction?.kind === 'merged-elsewhere'
      ? t('closed by the lead: merged elsewhere in {sha}', { sha: mergeAction.commit?.slice(0, 7) || '-' })
      : mergeAction?.kind === 'done-by-lead'
        ? t('closed by the lead: done by hand')
        : t('approved by a person');
    return hit('merged', why);
  }
  if (order.planned) return hit('planned', unmet.length ? `Waiting to draft after ${unmet.join(', ')} merges` : 'Ready for producer drafting');
  if (held) return hit('held', t('put on hold by a person'));
  if (current?.status === 'waiting' && current.question) {
    const card = current.waiting_for === 'card';
    return hit('awaiting-user', card ? t('the latest report waits for a card to be clicked: {q}', { q: current.question }) : t('the latest report waits for an answer: {q}', { q: current.question }), card ? 'card' : 'answer');
  }
  if (current?.status === 'ready') return hit('awaiting-review', t('the latest report says ready: {s}', { s: current.summary }));
  if (current?.status === 'blocked') return hit('blocked', t('the latest report says blocked: {s}', { s: current.summary }), 'answer');
  if (current?.status === 'failed') return hit('failed', t('the latest report says failed: {s}', { s: current.summary }));
  if (current?.status === 'dropped') return hit('dropped', t('the latest report says the worker dropped it: {s}', { s: current.summary }));
  if (current?.status === 'monitoring' && !open) return hit('monitoring', t('the worker handed a long job to the monitor: {s}', { s: current.summary }));
  if (open) return hit('running', t('run {id} by {worker} is open', { id: open.id, worker: open.worker }));
  const finished = lastRun?.outcome === 'completed';
  if (current?.status === 'waiting' || finished || (!queued && lastRun)) {
    return hit('idle', current?.status === 'waiting' ? t('the worker is waiting, no question asked') : t('the last run ended and nothing is queued'));
  }
  if (queued && unmet.length) return hit('waiting-needs', t('queued, waiting for {needs} to be merged', { needs: unmet.join(', ') }));
  if (queued) return hit('queued', t('queued and ready for a worker'));
  return hit('draft', t('no one has queued it'));
}

export function stageOf(order: Order, runs: readonly Run[], reports: readonly Report[], actions: readonly Action[], merged: ReadonlySet<string>): Stage {
  return inferStage(order, runs, reports, actions, merged).stage;
}

export const CLOSE_STAGES: readonly Stage[] = [
  'planned', 'draft', 'queued', 'waiting-needs', 'held', 'idle',
  'awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped', 'cancelled',
];

/** Why an action is not allowed in the current stage, or undefined if it is allowed. */
export function actionProblem(stage: Stage, kind: ActionKind): string | undefined {
  const allowed: Record<ActionKind, readonly Stage[]> = {
    queue: ['draft', 'idle', 'monitoring', 'blocked', 'failed', 'dropped', 'cancelled'],
    cancel: ['planned', 'draft', 'queued', 'waiting-needs', 'running', 'monitoring', 'idle', 'held', 'awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped'],
    hold: ['draft', 'queued', 'waiting-needs', 'running', 'monitoring', 'idle', 'awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped'],
    release: ['held'],
    approve: ['awaiting-review', 'idle'],
    rework: ['awaiting-user', 'awaiting-review', 'monitoring', 'blocked', 'failed', 'dropped', 'idle'],
    answer: ['awaiting-user', 'blocked'],
    monitor: ['monitoring'],
    message: ['held', 'draft', 'queued', 'waiting-needs', 'running', 'monitoring', 'idle', 'awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped'],
    'merged-elsewhere': CLOSE_STAGES,
    'done-by-lead': CLOSE_STAGES,
  };
  if (allowed[kind].includes(stage)) return undefined;
  if (kind === 'merged-elsewhere' || kind === 'done-by-lead') {
    if (stage === 'running' || stage === 'monitoring') {
      return t('cannot close an order that is {stage}; stop the run first', { stage });
    }
    return t('cannot close an order that is {stage} (allowed from: {from})', { stage, from: allowed[kind].join(', ') });
  }
  return t('cannot {action} an order that is {stage} (allowed from: {from})', { action: kind, stage, from: allowed[kind].join(', ') });
}
