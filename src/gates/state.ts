import type { ProjectConfig } from '../config.ts';
import { readStateJson } from '../orders/state-files.ts';
import type { ProcessInfo } from '../run/kill-tree.ts';

export interface GateResult {
  gate: string; commit: string; started: string; ended: string;
  status: 'passed' | 'failed' | 'error'; exit: number | null; timedOut: boolean; value?: number; reason?: string; log: string;
}
export interface NightlyRun {
  id: string; night: string; commit: string; from?: string; mergedOrders: string[];
  started: string; ended?: string; status: 'running' | 'waiting' | 'passed' | 'failed' | 'error' | 'abandoned'; reason?: string;
  forced?: boolean;
  deadline?: string;
  /** How many times this night's run started; a run that ended in `error` is reopened at most twice, an hour apart. */
  attempts?: number;
  full: boolean; names: string[]; definition: string; results: GateResult[];
}
/** A gate process tree that could not be confirmed gone: its leases stay held and the stop is retried every pass. */
export interface StuckTree { run: string; gate: string; tag: string; pid: number; startedAt?: string; notBefore: number; since: string; reason: string; members?: ProcessInfo[]; retryAt?: number; retries?: number; reported?: boolean }
export interface GatesState {
  runs: NightlyRun[];
  stuck?: StuckTree[];
  /** Notices already sent, key to the night they were sent for (so a persistent problem is reported once per night). */
  notices?: Record<string, string>;
  lastFull?: { commit: string; at: string };
  lastPass?: { commit: string; at: string };
  failures: Record<string, { run: string; result: GateResult; from?: string; mergedOrders: string[] }>;
}
export const GATES_STATE = '_nightly-gates.json';
export const gatesState = (project: ProjectConfig): GatesState => readStateJson(project, GATES_STATE, { runs: [], failures: {} });

/** Reads only durable state; disabled projects retain their previous response shape. */
export function gatesStatus(project: ProjectConfig) {
  if (!project.gates?.nightly.length) return undefined;
  const state = gatesState(project), last = state.runs.at(-1);
  return { window: project.gates.window, only_if_merged: project.gates.only_if_merged, last,
    lastPass: state.lastPass,
    gates: project.gates.nightly.map(g => ({ name: g.name, last: state.runs.flatMap(r => r.results).findLast(r => r.gate === g.name) })) };
}

export function nightlyCaseInputs(project: ProjectConfig) {
  if (!project.gates?.nightly.length) return [];
  const names = new Set(project.gates.nightly.map(g => g.name));
  return Object.entries(gatesState(project).failures).filter(([name]) => names.has(name)).map(([gate, failure]) => ({
    key: `nightly/${gate}`, trigger: 'nightly-gate-failed', project: project.id,
    facts: { gate, commit: failure.result.commit, from: failure.from ?? null, mergedOrders: failure.mergedOrders, result: failure.result, run: failure.run },
    card: { trigger: 'nightly-gate-failed', summary: `Nightly gate ${gate} failed at ${failure.result.commit.slice(0, 12)}. ${failure.result.reason ?? ''} Review the merged orders and propose a fix or revert for a person.`,
      pointers: [failure.result.log, ...failure.mergedOrders.map(tag => `order:${tag}`)], untrusted: ['gate output'] },
  }));
}
