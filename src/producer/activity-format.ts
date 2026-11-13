import { textConventions } from '../i18n-zh.ts';
/** Shared vocabulary for the console and the plain-text producer digest. No state or UI imports. */
export const activityVerbs: Record<string, string> = {
  reroute: 'rerouted', 'tool-call': 'called tool',
  accept: 'merged', 'accept-part': 'accepted part', rework: 'sent back', 'lint-bounce': 'sent back',
  nudge: 'nudged', queue: 'queued', dispatch: 'dispatched', hold: 'held', clean: 'cleaned',
  answer: 'answered', ask: 'asked', 'draft-order': 'drafted', 'add-order': 'drafted',
  reprioritize: 'reprioritized', note: 'noted', broadcast: 'announced', 'close-case': 'closed case',
  pause: 'paused', resume: 'resumed', 'session-start': 'started session', 'session-stop': 'stopped session',
  'session-error': 'session failed', 'budget-exhausted': 'exhausted budget',
};
export function activityVerb(row: { kind: string; status: string }): string {
  return row.status === 'proposed' ? 'proposed' : row.status === 'would-do' ? 'would do' : ['failed', 'refused', 'superseded', 'rejected'].includes(row.status) ? row.status : activityVerbs[row.kind] ?? row.kind;
}
/** A marker for a claim in text, never a judgement that the verification happened or passed. */
export function verificationClaim(kind: string, note: string): boolean {
  return ['accept', 'accept-part', 'rework', 'lint-bounce'].includes(kind) && textConventions.activity_format_2.test(note);
}
export function activityLine(row: { at: string; kind: string; status: string; mode: string; order?: string; result?: string; firstLine: string; claim: boolean }, translate: (key: string) => string = s => s): string {
  return [row.at, translate(activityVerb(row)), row.status !== 'done' ? translate(row.kind) : '', row.order, `[${translate(row.mode)} / ${translate(row.status)}]`, row.result, row.claim ? `[${translate('claim')}]` : '', row.firstLine].filter(Boolean).join(' · ').replace(/[\r\n]+/g, ' ');
}
