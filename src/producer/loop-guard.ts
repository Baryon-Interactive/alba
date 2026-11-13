import { textConventions } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import { endingCaseText } from '../run/endpoint.ts';
import { classifyCause } from './facts/engine.ts';
import type { ProducerAction } from './producer.ts';

export const LOOP_REFUSAL = 'same cause twice: change the approach or ask a person';
const normalize = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** One final outcome per run; a successful delivery breaks the failure streak. */
export function repeatedFailure(doc: OrderDoc) {
  const failures: { run: string; cause: string; summary: string }[] = [];
  for (const run of [...doc.runs].sort((a, b) => b.seq - a.seq)) {
    if (!run.ended) continue;
    const report = doc.reports.filter(r => r.run === run.id && r.seq >= run.seq).sort((a, b) => b.seq - a.seq)[0];
    if (report && !['failed', 'blocked'].includes(report.status)) break;
    if (run.outcome === 'cancelled') break;
    const summary = report?.summary ?? endingCaseText(run);
    failures.push({ run: run.id, cause: classifyCause(summary), summary });
    if (failures.length === 2) break;
  }
  return failures.length === 2 && failures[0].cause === failures[1].cause ? failures : undefined;
}

export function loopGuard(doc: OrderDoc, actions: readonly ProducerAction[], note = ''): string | undefined {
  const failures = repeatedFailure(doc);
  if (!failures) return;
  const notes = actions.filter(a => (a.target === doc.order.tag) && ['queue', 'rework', 'answer'].includes(a.kind) && a.status === 'done')
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 2).map(a => a.note ?? '');
  const text = normalize(note);
  const namesCause = classifyCause(note) === failures[0].cause && failures[0].cause !== 'unclassified'
    || failures.some(f => normalize(f.summary).split(' ').filter(w => w.length > 4).some(w => text.includes(w)));
  const namesFix = textConventions.loop_guard_14.test(note);
  // Compare fixes after the cause label as well as the complete note, so a new preamble cannot disguise the same remedy.
  const remedy = (s: string) => normalize(s.replace(/^.*?\b(?:fix|repair|approach)\s*:\s*/is, ''));
  const changed = text && notes.every(old => text !== normalize(old) && remedy(note) !== remedy(old));
  return namesCause && namesFix && changed ? undefined : LOOP_REFUSAL;
}
