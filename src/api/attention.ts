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
  const runs: Run[] = [], reports: Report[] = [], actions: Action[] = [];
  const facts: { at: string; seq: number; apply(): void }[] = [];
  for (const run of doc.runs) {
    const copy = { ...run, ended: undefined } as Run;
    facts.push({ at: run.started, seq: run.seq, apply: () => runs.push(copy) });
    if (run.ended) facts.push({ at: run.ended, seq: run.seq + 0.5, apply: () => { copy.ended = run.ended; } });
  }
  for (const report of doc.reports) facts.push({ at: report.at, seq: report.seq, apply: () => reports.push(report) });
  for (const action of doc.actions) facts.push({ at: action.at, seq: action.seq, apply: () => actions.push(action) });
  let point: Point | undefined;
  function consider(at: string, reason: Point['reason'], text: string) {
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && (!point || ms >= Date.parse(point.at))) point = { at: new Date(ms).toISOString(), reason, text };
  }
  let previous: Stage | undefined;
  const merged = new Set<string>();
  for (const fact of facts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq)) {
    fact.apply();
    const { stage, why } = inferStage(doc.order, runs, reports, actions, merged);
    if (stage !== previous && stages.has(stage)) consider(fact.at, 'stage', why);
    previous = stage;
  }
  for (const run of runs) if (run.ended) consider(run.ended, 'run-ended', t('Run {id} ended', { id: run.id }));
  for (const question of openQuestions(doc)) consider(question.received ?? question.at, 'question', question.text);
  return { ...(point && { attention: point }), ...(mark?.seen_at && { seen: mark.seen_at }), ...(mark?.muted && { muted: true }),
    unread: !!point && (!mark?.seen_at || point.at > mark.seen_at) };
}
