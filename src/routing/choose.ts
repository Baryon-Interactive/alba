import type { WorkerKindHistory } from '../api/types.ts';
import { t } from '../i18n.ts';
import type { WorkerConfig } from '../workers/config.ts';
import type { ResolvedRole } from '../roles/config.ts';

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
}

export interface RolePolicy { id?: string; requires?: string[]; prefer?: string[]; avoid?: string[]; only?: string[]; /** The route's worker group, whose members are `prefer` and `only`. */ group?: string }
export function rolePolicy(role: ResolvedRole): RolePolicy | undefined {
  return role.definition ? { id: role.id, requires: role.definition.requires, ...role.definition.workers, ...(role.definition.group ? { group: role.definition.group } : {}) } : undefined;
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

type Ranked = Candidate & { index: number; load: number };

/** `a` is better than `b`: the first of role preference, reviewed yield, cost, load and file order that differs. Returns what decided it. */
function better(a: Ranked, b: Ranked): { wins: boolean; because: string } | undefined {
  if (a.preference !== b.preference) return { wins: a.preference! < b.preference!, because: 'role' };
  const ra = a.history?.rate, rb = b.history?.rate;
  if (ra !== undefined && rb !== undefined && ra !== rb) return { wins: ra > rb, because: 'history' };
  if (a.cost !== b.cost) return { wins: a.cost === 'included', because: 'cost' };
  if (a.load !== b.load) return { wins: a.load < b.load, because: 'load' };
  if (a.index !== b.index) return { wins: a.index < b.index, because: 'order' };
  return undefined;
}

/** Orders candidates best first by repeatedly taking the best of those left (the comparison is not a total order when history is missing on one side). */
function rank(list: Ranked[]): Ranked[] {
  const left = [...list], out: Ranked[] = [];
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (better(left[i], left[best])?.wins) best = i;
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

const why = (c: Ranked, kindLabel: string, group?: string): string => [
  `${c.worker}: role ${kindLabel}`, c.cost === 'included' ? t('included') : t('paid'), pct(c.history),
  c.preferred ? (group ? `group ${group} #${c.preference! + 1}` : `role preference ${c.preference! + 1}`) : 'unlisted fallback', ...(c.warnings ?? []),
  c.load ? t('{n} running', { n: c.running }) : undefined,
].filter(Boolean).join(', ');

/** Pure role eligibility and preference/yield/cost/load/file-order ranking. */
export function chooseWorker(input: RouteInput, workers: readonly Choosable[]): Choice {
  const { pool, named } = input.pinnedWorker ? { pool: workers.filter(w => w.config.id === input.pinnedWorker), named: 'id' as const } : namedWorkers(workers, input.workerText);
  if (!input.role) return { outcome: 'nobody-fits', why: `no role for kind ${input.kind || '(unclassified)'}; configure a matching or default role`, candidates: [] };
  const label = input.role.id ?? input.kind;
  const planned = input.planned ?? {};
  const all: Ranked[] = workers.map((w, index) => ({ w, index })).filter(x => pool.includes(x.w)).map(({ w, index }) => {
    const c = w.config;
    const load = w.running + (planned[c.id] ?? 0);
    const h = input.role?.id ? w.roleHistory?.[input.role.id] : undefined;
    const history = h ? { samples: h.samples, ...(h.samples >= 3 && h.rate !== undefined ? { rate: h.rate } : {}) } : undefined;
    const matches = (name: string) => [c.id, ...c.aliases, c.model_family].some(a => a?.toLowerCase() === name.toLowerCase());
    const preference = input.role!.prefer?.findIndex(matches) ?? -1;
    const missing = (input.role!.requires ?? []).filter(cap => !(c.capabilities ?? []).includes(cap));
    const warnings = named && missing.length ? [`warning: explicit worker is missing capabilities: ${missing.join(', ')}`] : [];
    const base: Ranked = { worker: c.id, preference: preference < 0 ? Number.MAX_SAFE_INTEGER : preference, preferred: preference >= 0, cost: c.cost, running: load, concurrency: c.concurrency, history, verdict: 'passed-over', reason: '', index, load, ...(warnings.length ? { warnings } : {}) };
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
  const ranked = rank(eligible);
  const best = ranked[0];
  const takers = all.filter(c => c.verdict !== 'unfit');
  // What the order waits for when nobody can start it now: the best by role ranking before availability.
  const ideal = rank(takers)[0]?.worker;
  for (const c of ranked.slice(1)) {
    const d = better(best, c);
    const because = d?.because === 'role' ? (input.role.group ? `earlier in worker group ${input.role.group}` : 'earlier role preference wins')
      : d?.because === 'cost' ? t('paid, while {w} is included', { w: best.worker })
      : d?.because === 'history' ? t('fewer accepted ({a} against {b})', { a: pct(c.history) ?? '-', b: pct(best.history) ?? '-' })
      : d?.because === 'load' ? t('busier ({a} running against {b})', { a: c.running, b: best.running })
      : t('later in the workers file');
    const shared = sharedQuota(workers.find(w => w.config.id === c.worker)!.config, workers.filter(w => w.config.id === best.worker));
    c.reason = `${because}; ${t('{w} is chosen', { w: best.worker })}${shared ? `; ${shared}` : ''}`;
  }
  if (best) { best.verdict = 'chosen'; best.reason = why(best, label, input.role.group); }
  const sorted: Candidate[] = [...ranked, ...all.filter(c => c.verdict === 'unavailable'), ...all.filter(c => c.verdict === 'unfit')].map(({ index: _i, load: _l, ...c }) => c);

  if (best) return { ...(named ? { named } : {}), outcome: 'chosen', chosen: best.worker, ...(ideal ? { ideal } : {}), why: why(best, label, input.role.group), candidates: sorted };
  if (!takers.length) {
    return { ...(named ? { named } : {}), outcome: 'nobody-fits', why: all.length ? t('nobody takes {kind}: {list}', { kind: `role ${label}`, list: all.map(c => `${c.worker} (${c.reason})`).join('; ') }) : t('there is no worker to choose from'), candidates: sorted };
  }
  const waiting = takers.some(c => c.blocked === 'limit') ? 'limit' : 'unavailable';
  return {
    ...(named ? { named } : {}), outcome: 'none-available', waiting, ...(ideal ? { ideal } : {}),
    why: t('every worker that takes it cannot start it now: {list}', { list: takers.map(c => `${c.worker} (${c.reason})`).join('; ') }), candidates: sorted,
  };
}
