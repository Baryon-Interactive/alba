import { workerAdapter } from '../workers/adapters/index.ts';
import type { WorkerKindHistory } from '../api/types.ts';
import { t } from '../i18n.ts';
import type { WorkerConfig } from '../workers/config.ts';
import type { RankBy, ResolvedRole } from '../roles/config.ts';

export interface WorkerKindScore {
  first_attempts: number;
  first_pass_rate?: number;
  accepts: number;
  cost_per_accept?: number;
  minutes_per_accept?: number;
}

/** A worker as the choice sees it: its configuration and what is true of it now. */
export interface Choosable {
  config: WorkerConfig;
  available: boolean;
  reasons: string[];
  running: number;
  runsToday: number;
  /** False when alba has no way to start it (no launch template and not a card-only worker). Absent counts as true. */
  startable?: boolean;
  overCap?: boolean;
  /** Accepted vs sent back by kind. */
  history?: Record<string, WorkerKindHistory>;
  roleHistory?: Record<string, { samples: number; rate?: number }>;
  scorecard?: Record<string, WorkerKindScore>;
}

export const supportsReadOnly = (worker: WorkerConfig): boolean =>
  !!workerAdapter(worker.engine).verifierArgs && !!worker.launch && !worker.card_only;

export interface RolePolicy { readOnly?: boolean; id?: string; requires?: string[]; prefer?: string[]; avoid?: string[]; only?: string[]; /** The route's worker group, whose members are `prefer` and `only`. */ group?: string; rank_by?: RankBy }
export function rolePolicy(role: ResolvedRole, readOnly = false): RolePolicy | undefined {
  return role.definition ? { ...(readOnly ? { readOnly } : {}), id: role.id, requires: role.definition.requires, ...role.definition.workers, ...(role.definition.group ? { group: role.definition.group } : {}), ...(role.definition.rank_by ? { rank_by: role.definition.rank_by } : {}) } : undefined;
}
export interface RouteInput {
  pinnedWorker?: string;
  role?: RolePolicy;
  kind: string;                 // '' (or the board's default "task") when unclassified
  /** Extra tags that are kinds of the project's vocabulary. */
  tags: string[];
  workerText?: string;
  /** Runs planned in this pass but not yet recorded, by worker id. */
  planned?: Record<string, number>;
}

export type Verdict = 'chosen' | 'passed-over' | 'unavailable' | 'unfit';
export interface Candidate {
  preferred?: boolean;
  worker: string;
  preference?: number;
  warnings?: string[];
  cost: 'included' | 'paid';
  running: number;
  concurrency: number;
  history?: { samples: number; rate?: number };
  verdict: Verdict;
  reason: string;
  /** Why a worker that takes the kind cannot start it now: its quota or switch, or a concurrency or daily limit. */
  blocked?: 'unavailable' | 'limit';
}

export interface Choice {
  named?: 'id' | 'alias';
  outcome: 'chosen' | 'nobody-fits' | 'none-available';
  /** For `none-available`: every worker that takes it is out of quota or switched off (`unavailable`), or at a limit (`limit`). */
  waiting?: 'unavailable' | 'limit';
  chosen?: string;
  ideal?: string;
  why: string;
  candidates: Candidate[];
}

/** Does this free-text worker preference name the worker by id or alias? An id names that worker only. */
export function namedWorkers<W extends { config: WorkerConfig }>(workers: readonly W[], text: string | undefined): { pool: readonly W[]; named?: 'id' | 'alias' } {
  const words = (text ?? '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u);
  const byId = workers.filter(w => words.includes(w.config.id.toLowerCase()));
  if (byId.length) return { pool: byId, named: 'id' };
  const hay = (text ?? '').toLowerCase();
  const byAlias = hay ? workers.filter(w => w.config.aliases.some(a => hay.includes(a.toLowerCase()))) : [];
  return byAlias.length ? { pool: byAlias, named: 'alias' } : { pool: workers };
}

const pct = (h: { samples: number; rate?: number } | undefined) => (h?.rate !== undefined ? `${Math.round(h.rate * 100)}% of ${h.samples} accepted` : undefined);

/** "quota shared with a, b": the other workers that draw on the same subscription or balance as this one (empty when it has none). */
export function sharedQuota(config: WorkerConfig, among: readonly { config: WorkerConfig }[]): string {
  const peers = config.quota ? among.filter(o => o.config.id !== config.id && o.config.quota === config.quota).map(o => o.config.id) : [];
  return peers.length ? t('quota shared with {workers}', { workers: peers.join(', ') }) : '';
}

type Ranked = Candidate & { index: number; load: number; kindScore?: WorkerKindScore };

const fmtUsd = (n: number): string => {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
};

function rankByNote(best: Ranked, other: Ranked | undefined, rankBy: RankBy | undefined, kind: string): string | undefined {
  if (!rankBy || rankBy === 'preference') return undefined;
  const kindOrder = kind ? `${kind} order` : 'order';
  const kindOrders = kind ? `${kind} orders` : 'orders';
  if (rankBy === 'cost-per-accept') {
    if (other) {
      const ca = best.kindScore?.cost_per_accept, cb = other.kindScore?.cost_per_accept;
      if (ca !== undefined && cb !== undefined) {
        const hi = Math.max(ca, cb);
        const tie = hi === 0 || Math.abs(ca - cb) / hi < 0.2 - 1e-9;
        return tie
          ? `cost per accepted ${kindOrder} ${fmtUsd(ca)} vs ${fmtUsd(cb)} (tie, under 20%; ${best.kindScore!.accepts} and ${other.kindScore!.accepts} accepted, 14 days)`
          : `cost per accepted ${kindOrder} ${fmtUsd(ca)} vs ${fmtUsd(cb)} (${best.kindScore!.accepts} and ${other.kindScore!.accepts} accepted, 14 days)`;
      }
      const missing = ca === undefined ? best : other;
      const whyMissing = missing.cost === 'included' ? 'included' : (missing.kindScore?.accepts ?? 0) === 0 ? 'no accepted orders' : 'unknown';
      return `rank_by cost-per-accept: no dollar figure for ${missing.worker} (${whyMissing})`;
    }
    if (best.kindScore?.cost_per_accept !== undefined) {
      return `cost per accepted ${kindOrder} ${fmtUsd(best.kindScore.cost_per_accept)} (${best.kindScore.accepts} accepted, 14 days)`;
    }
    const whyMissing = best.cost === 'included' ? 'included' : (best.kindScore?.accepts ?? 0) === 0 ? 'no accepted orders' : 'unknown';
    return `rank_by cost-per-accept: no dollar figure for ${best.worker} (${whyMissing})`;
  }
  if (other) {
    const fa = best.kindScore?.first_pass_rate, fb = other.kindScore?.first_pass_rate;
    if (fa !== undefined && fb !== undefined) {
      const tie = Math.abs(fa - fb) < 0.1 - 1e-9;
      return tie
        ? `first pass ${Math.round(fa * 100)}% of ${best.kindScore!.first_attempts} ${kindOrders} vs ${Math.round(fb * 100)}% of ${other.kindScore!.first_attempts} (tie, under 10 points)`
        : `first pass ${Math.round(fa * 100)}% of ${best.kindScore!.first_attempts} ${kindOrders} vs ${Math.round(fb * 100)}% of ${other.kindScore!.first_attempts}`;
    }
    const missing = fa === undefined ? best : other;
    return `rank_by acceptance: fewer than 3 first attempts for ${missing.worker} (n=${missing.kindScore?.first_attempts ?? 0})`;
  }
  if (best.kindScore?.first_pass_rate !== undefined) {
    return `first pass ${Math.round(best.kindScore.first_pass_rate * 100)}% of ${best.kindScore.first_attempts} ${kindOrders}`;
  }
  return `rank_by acceptance: fewer than 3 first attempts for ${best.worker} (n=${best.kindScore?.first_attempts ?? 0})`;
}

/** `a` is better than `b`: optional `rank_by` first, then role preference, reviewed yield, cost, load and file order. */
function better(a: Ranked, b: Ranked, rankBy?: RankBy): { wins: boolean; because: string } | undefined {
  if (rankBy === 'acceptance') {
    const fa = a.kindScore?.first_pass_rate, fb = b.kindScore?.first_pass_rate;
    if (fa !== undefined && fb !== undefined && Math.abs(fa - fb) >= 0.1 - 1e-9) {
      return { wins: fa > fb, because: 'acceptance' };
    }
  } else if (rankBy === 'cost-per-accept') {
    const ca = a.kindScore?.cost_per_accept, cb = b.kindScore?.cost_per_accept;
    if (ca !== undefined && cb !== undefined) {
      const hi = Math.max(ca, cb);
      if (hi > 0 && Math.abs(ca - cb) / hi >= 0.2 - 1e-9) {
        return { wins: ca < cb, because: 'cost-per-accept' };
      }
    }
  }
  if (a.preference !== b.preference) return { wins: a.preference! < b.preference!, because: 'role' };
  const ra = a.history?.rate, rb = b.history?.rate;
  if (ra !== undefined && rb !== undefined && ra !== rb) return { wins: ra > rb, because: 'history' };
  if (a.cost !== b.cost) return { wins: a.cost === 'included', because: 'cost' };
  if (a.load !== b.load) return { wins: a.load < b.load, because: 'load' };
  if (a.index !== b.index) return { wins: a.index < b.index, because: 'order' };
  return undefined;
}

/** Orders candidates best first by repeatedly taking the best of those left (the comparison is not a total order when history is missing on one side). */
function rank(list: Ranked[], rankBy?: RankBy): Ranked[] {
  const left = [...list], out: Ranked[] = [];
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (better(left[i], left[best], rankBy)?.wins) best = i;
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

const why = (c: Ranked, kindLabel: string, group?: string, rankNote?: string): string => [
  `${c.worker}: role ${kindLabel}`, c.cost === 'included' ? t('included') : t('paid'), pct(c.history), rankNote,
  c.preferred ? (group ? `group ${group} #${c.preference! + 1}` : `role preference ${c.preference! + 1}`) : 'unlisted fallback', ...(c.warnings ?? []),
  c.load ? t('{n} running', { n: c.running }) : undefined,
].filter(Boolean).join(', ');

/** Pure role eligibility and preference/yield/cost/load/file-order ranking. */
export function chooseWorker(input: RouteInput, workers: readonly Choosable[]): Choice {
  const { pool, named } = input.pinnedWorker ? { pool: workers.filter(w => w.config.id === input.pinnedWorker), named: 'id' as const } : namedWorkers(workers, input.workerText);
  if (!input.role) return { outcome: 'nobody-fits', why: `no role for kind ${input.kind || '(unclassified)'}; configure a matching or default role`, candidates: [] };
  const label = input.role.id ?? input.kind;
  const rankBy = input.role.rank_by;
  const planned = input.planned ?? {};
  const all: Ranked[] = workers.map((w, index) => ({ w, index })).filter(x => pool.includes(x.w)).map(({ w, index }) => {
    const c = w.config;
    const load = w.running + (planned[c.id] ?? 0);
    const h = input.role?.id ? w.roleHistory?.[input.role.id] : undefined;
    const history = h ? { samples: h.samples, ...(h.samples >= 3 && h.rate !== undefined ? { rate: h.rate } : {}) } : undefined;
    const kindScore = w.scorecard?.[input.kind];
    const matches = (name: string) => [c.id, ...c.aliases, c.model_family].some(a => a?.toLowerCase() === name.toLowerCase());
    const preference = input.role!.prefer?.findIndex(matches) ?? -1;
    const missing = (input.role!.requires ?? []).filter(cap => !(c.capabilities ?? []).includes(cap));
    const warnings = named && missing.length ? [`warning: explicit worker is missing capabilities: ${missing.join(', ')}`] : [];
    const base: Ranked = { worker: c.id, preference: preference < 0 ? Number.MAX_SAFE_INTEGER : preference, preferred: preference >= 0, cost: c.cost, running: load, concurrency: c.concurrency, history, kindScore, verdict: 'passed-over', reason: '', index, load, ...(warnings.length ? { warnings } : {}) };
    if (input.role!.readOnly && !supportsReadOnly(c)) return { ...base, verdict: 'unfit' as const, reason: t('requires a read-only engine launch') };
    if ((!named || input.pinnedWorker) && missing.length) return { ...base, verdict: 'unfit' as const, reason: `missing capabilities: ${missing.join(', ')}` };
    if (!named && input.role!.avoid?.some(matches)) return { ...base, verdict: 'unfit' as const, reason: 'avoided by role' };
    if (!named && input.role!.only && !input.role!.only.some(matches)) return { ...base, verdict: 'unfit' as const, reason: input.role!.group ? `not in worker group ${input.role!.group}` : 'outside role workers.only' };
    if (!c.enabled) return { ...base, verdict: 'unavailable' as const, blocked: 'unavailable' as const, reason: 'turned off in the workers file' };
    if (w.overCap) return { ...base, verdict: 'unavailable' as const, blocked: 'limit' as const, reason: 'daily spend cap reached' };
    if (!w.available) return { ...base, verdict: 'unavailable' as const, blocked: 'unavailable' as const, reason: [w.reasons.join('; ') || t('not available'), c.enabled ? sharedQuota(c, workers) : ''].filter(Boolean).join('; ') };
    if (w.startable === false) return { ...base, verdict: 'unavailable' as const, blocked: 'unavailable' as const, reason: t('it has no launch template, so alba cannot start it') };
    if (!c.card_only) {
      if (load >= c.concurrency) return { ...base, verdict: 'unavailable' as const, blocked: 'limit' as const, reason: t('at its concurrency limit ({n}/{max})', { n: load, max: c.concurrency }) };
      if (c.daily_runs !== undefined && w.runsToday + (planned[c.id] ?? 0) >= c.daily_runs) return { ...base, verdict: 'unavailable' as const, blocked: 'limit' as const, reason: t('at its daily limit ({n}/{max} runs today)', { n: w.runsToday + (planned[c.id] ?? 0), max: c.daily_runs }) };
    }
    return base;
  });

  const eligible = all.filter(c => c.verdict === 'passed-over');
  const ranked = rank(eligible, rankBy);
  const best = ranked[0];
  const takers = all.filter(c => c.verdict !== 'unfit');
  // What the order waits for when nobody can start it now: the best by role ranking before availability.
  const ideal = rank(takers, rankBy)[0]?.worker;
  for (const c of ranked.slice(1)) {
    const d = better(best, c, rankBy);
    const note = rankByNote(best, c, rankBy, input.kind);
    const fallbackBecause = d?.because === 'role' ? (input.role.group ? `earlier in worker group ${input.role.group}` : 'earlier role preference wins')
      : d?.because === 'cost' ? t('paid, while {w} is included', { w: best.worker })
      : d?.because === 'history' ? t('fewer accepted ({a} against {b})', { a: pct(c.history) ?? '-', b: pct(best.history) ?? '-' })
      : d?.because === 'load' ? t('busier ({a} running against {b})', { a: c.running, b: best.running })
      : t('later in the workers file');
    const because = d?.because === 'acceptance' || d?.because === 'cost-per-accept'
      ? note!
      : note ? `${note}; ${fallbackBecause}` : fallbackBecause;
    const shared = sharedQuota(workers.find(w => w.config.id === c.worker)!.config, workers.filter(w => w.config.id === best.worker));
    c.reason = `${because}; ${t('{w} is chosen', { w: best.worker })}${shared ? `; ${shared}` : ''}`;
  }
  const bestNote = best ? rankByNote(best, ranked[1], rankBy, input.kind) : undefined;
  if (best) { best.verdict = 'chosen'; best.reason = why(best, label, input.role.group, bestNote); }
  const sorted: Candidate[] = [...ranked, ...all.filter(c => c.verdict === 'unavailable'), ...all.filter(c => c.verdict === 'unfit')].map(({ index: _i, load: _l, kindScore: _s, ...c }) => c);

  if (best) return { ...(named ? { named } : {}), outcome: 'chosen', chosen: best.worker, ...(ideal ? { ideal } : {}), why: why(best, label, input.role.group, bestNote), candidates: sorted };
  if (!takers.length) {
    return { ...(named ? { named } : {}), outcome: 'nobody-fits', why: all.length ? t('nobody takes {kind}: {list}', { kind: `role ${label}`, list: all.map(c => `${c.worker} (${c.reason})`).join('; ') }) : t('there is no worker to choose from'), candidates: sorted };
  }
  const waiting = takers.some(c => c.blocked === 'limit') ? 'limit' : 'unavailable';
  return {
    ...(named ? { named } : {}), outcome: 'none-available', waiting, ...(ideal ? { ideal } : {}),
    why: t('every worker that takes it cannot start it now: {list}', { list: takers.map(c => `${c.worker} (${c.reason})`).join('; ') }), candidates: sorted,
  };
}
