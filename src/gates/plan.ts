import type { GatesState, NightlyRun } from './state.ts';

/** An error result is the night's result for scheduling: it is retried an hour later, at most this many attempts a night. */
export const RETRY_AFTER_MS = 3_600_000;
export const MAX_ATTEMPTS = 3;
/** Waiting forced batches expire after a day so scheduled nights cannot be starved indefinitely. */
export const FORCED_WAIT_MS = 24 * 3_600_000;

export interface PlanInput {
  state: GatesState;
  now: Date;
  window: { inside: boolean; night: string };
  force: boolean;
  /** A single gate was selected on the command line. */
  selected: boolean;
  names: string[];
  definition: string;
  /** The base head; only called when a new batch is being considered. */
  head: () => Promise<string>;
  /** Did anything merge since the last full run (only called with the head)? */
  hasMerges: (commit: string) => Promise<boolean>;
  onlyIfMerged: boolean;
}
export type Action =
  | { kind: 'skip'; reason: string }
  | { kind: 'resume'; run: NightlyRun }
  | { kind: 'retry'; run: NightlyRun }
  | { kind: 'new'; commit: string };
export interface Plan { action: Action; stale: NightlyRun[] }

const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a pass should do. Reads only. Outside the window nothing is decided or changed, except that a forced run (asked for
 * by a person) is continued wherever it stands: forced runs survive until they finish or a person cancels them.
 */
export async function planPass(i: PlanInput): Promise<Plan> {
  const open = i.state.runs.filter(r => !r.ended);
  // Forced runs are continued by any pass (serve has no selection); a pass with a selection continues only a matching one.
  const expired = (r: NightlyRun) => r.forced && i.now.getTime() >= Date.parse(r.deadline ?? new Date(Date.parse(r.started) + FORCED_WAIT_MS).toISOString());
  const forcedOk = (r: NightlyRun) => r.forced === true && !expired(r) && r.definition === i.definition && (i.force || i.selected ? same(r.names, i.names) : true);
  const scheduledOk = (r: NightlyRun) => !r.forced && r.night === i.window.night && r.definition === i.definition && same(r.names, i.names);
  const resumable = (r: NightlyRun) => i.force ? forcedOk(r) : r.forced ? forcedOk(r) : i.window.inside && scheduledOk(r);
  // A forced run goes stale only when the gate definition changed or a newer forced run replaces it; a scheduled run goes stale
  // when its night, definition or selection no longer matches (decided only inside the window).
  const stale = open.filter(r => r.forced ? expired(r) || r.definition !== i.definition || (i.force && !forcedOk(r)) : !i.force && i.window.inside && !scheduledOk(r));
  const resume = open.findLast(resumable);
  if (resume) return { action: { kind: 'resume', run: resume }, stale };
  if (!i.force) {
    if (!i.window.inside) return { action: { kind: 'skip', reason: 'Outside the nightly window.' }, stale };
    const tonight = i.state.runs.filter(r => !r.forced && r.night === i.window.night && r.definition === i.definition);
    if (!i.selected && tonight.some(r => r.full && ['passed', 'failed'].includes(r.status))) return { action: { kind: 'skip', reason: 'This night already has a full run.' }, stale };
    const errored = tonight.findLast(r => r.status === 'error' && r.ended && same(r.names, i.names));
    if (errored) {
      const attempts = errored.attempts ?? 1, next = Date.parse(errored.ended!) + RETRY_AFTER_MS;
      if (attempts >= MAX_ATTEMPTS) return { action: { kind: 'skip', reason: `The last attempt ended in an error and this night's ${MAX_ATTEMPTS} attempts are used up.` }, stale };
      if (i.now.getTime() < next) return { action: { kind: 'skip', reason: `The last attempt ended in an error; the next attempt is not before ${new Date(next).toISOString()}.` }, stale };
      return { action: { kind: 'retry', run: errored }, stale };
    }
  }
  const commit = await i.head();
  // Most passes stop at this cheap head check without scanning history or events.
  if (!i.force && i.onlyIfMerged && !(await i.hasMerges(commit))) return { action: { kind: 'skip', reason: 'Nothing merged since the last full run.' }, stale };
  return { action: { kind: 'new', commit }, stale };
}
