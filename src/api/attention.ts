import { inferStage } from '../orders/stage.ts';
import type { Action, OrderDoc, Report, Run, Stage } from '../orders/model.ts';
import type { AttentionMark } from '../orders/attention-store.ts';
import { openQuestions } from '../run/messages.ts';
import { t } from '../i18n.ts';
import type { AttentionState } from './types.ts';

const stages = new Set<Stage>(['awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped', 'merged', 'idle']);
type Point = NonNullable<AttentionState['attention']>;

/** Replay stage-changing facts so edits, repeated reports and later queueing preserve the actual entry time. */
export function attentionState(doc: OrderDoc, mark?: AttentionMark): AttentionState {
  // Only the latest report, latest run, any still-open runs and last action of each kind can affect inferStage.
  const actions = new Map<Action['kind'], Action>();
  const open = new Map<string, Run>();
  let latestRun: Run | undefined, latestReport: Report | undefined;
  const pending = new Map<string, string>();
  const facts: { at: string; seq: number; apply(): void }[] = [];
  for (const run of doc.runs) {
    const copy: Run = { ...run, ended: undefined };
    facts.push({ at: run.started, seq: run.seq, apply: () => {
      open.set(run.id, copy);
      if (!latestRun || copy.seq > latestRun.seq) latestRun = copy;
    } });
    if (run.ended) facts.push({ at: run.ended, seq: run.seq + 0.5, apply: () => { copy.ended = run.ended; open.delete(run.id); } });
  }
  for (const report of doc.reports) facts.push({ at: report.at, seq: report.seq, apply: () => {
    if (!latestReport || report.seq > latestReport.seq) latestReport = report;
  } });
  for (const q of doc.outbox ?? []) {
    if (q.kind !== 'question') continue;
    facts.push({ at: q.received ?? q.at, seq: Infinity, apply: () => { pending.set(q.id, q.text); } });
    if (q.answered) facts.push({ at: q.answered.at, seq: Infinity, apply: () => { pending.delete(q.id); } });
  }
  for (const action of doc.actions) facts.push({ at: action.at, seq: action.seq, apply: () => {
    if (action.kind === 'message' && action.queued) return;
    if (action.seq > (actions.get(action.kind)?.seq ?? -1)) actions.set(action.kind, action);
    if (action.kind === 'answer') pending.clear();
  } });
  let point: Point | undefined;
  function consider(at: string, reason: Point['reason'], text: string) {
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && (!point || ms >= Date.parse(point.at))) point = { at: new Date(ms).toISOString(), reason, text };
  }
  let previous: Stage | undefined;
  const merged = new Set<string>();
  for (const fact of facts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq)) {
    fact.apply();
    const runs = [...open.values()];
    if (latestRun?.ended) runs.push(latestRun);
    const base = inferStage(doc.order, runs, latestReport ? [latestReport] : [], [...actions.values()], merged);
    const first = pending.values().next().value;
    const { stage, why } = base.stage === 'running' && first ? { stage: 'awaiting-user' as const, why: first } : base;
    if (stage !== previous && stages.has(stage)) consider(fact.at, 'stage', why);
    previous = stage;
  }
  for (const run of doc.runs) if (run.ended) consider(run.ended, 'run-ended', t('Run {id} ended', { id: run.id }));
  for (const question of openQuestions(doc)) consider(question.received ?? question.at, 'question', question.text);
  return { ...(point && { attention: point }), ...(mark?.seen_at && { seen: mark.seen_at }), ...(mark?.muted && { muted: true }),
    unread: !!point && (!mark?.seen_at || point.at > mark.seen_at) };
}
