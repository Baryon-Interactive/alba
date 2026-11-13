import { translate } from '../i18n.ts';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ProducerBriefConfig, ProjectConfig } from '../config.ts';
import type { OrderDoc, OrderEvent } from '../orders/model.ts';
import { readStateJson, updateStateJson, writeStateFile } from '../orders/state-files.ts';
import type { FactsSnapshot } from './facts/engine.ts';
import { readFacts } from './facts/snapshot.ts';
import { standingDirection, type DirectionVersion } from './conversation-state.ts';
import { producerState, type ProducerAction } from './producer.ts';
import type { Orders } from '../orders/service.ts';
import type { TickReport } from '../tick/plan.ts';

export const BRIEFS_STATE = '_producer-briefs.json';
const READINGS = '_producer-brief-readings.json';
export interface BriefReadings { report: TickReport; activity: Record<string, { lastCommitAt?: string }> }
export interface BriefFact { id: string; value: number | string | null; unit: string; sources: string[] }
export interface ProducerBrief {
  kind?: 'round';
  round?: { status: string; cases: { id: string; revision: number; facts: Record<string, unknown> }[] };
  id: string; at: string; since: string; language: string; skeleton: string; text: string; fingerprint: string;
  facts: BriefFact[]; snapshot?: FactsSnapshot; direction: DirectionVersion; riskKeys: string[];
  rewritten?: boolean; rewriteError?: string; hook?: { status: 'pending' | 'sent' | 'failed'; error?: string };
}
export interface BriefInput {
  now: string; language: string; orders: readonly OrderDoc[]; events: readonly OrderEvent[];
  snapshot?: FactsSnapshot; readings?: BriefReadings; actions?: readonly ProducerAction[]; previous?: ProducerBrief; direction: DirectionVersion;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const eventId = (e: OrderEvent) => `event:${e.tag}:${e.type}:${e.at}`;
const key = (s: string) => encodeURIComponent(s).replace(/\./g, '%2E');
const riskKey = (r: NonNullable<FactsSnapshot['analysis']>['risks'][number]) => `${r.id}:${r.count}`;
export const producerBriefs = (p: ProjectConfig) => readStateJson<ProducerBrief[]>(p, BRIEFS_STATE, []).sort((a, b) => b.at.localeCompare(a.at));
export function saveBriefReadings(p: ProjectConfig, readings: BriefReadings): void { writeStateFile(p, READINGS, JSON.stringify(readings)); }

/** Deterministic skeleton plus its immutable evidence ledger; never invokes an engine. */
export function buildBrief(input: BriefInput): ProducerBrief {
  const { now, snapshot, orders, readings, previous } = input;
  const word = (key: string, vars: Record<string, string | number> = {}) => translate(/^zh|chinese/i.test(input.language) ? 'zh' : 'en', key, vars);
  const since = previous?.at ?? new Date(Date.parse(now) - 86400_000).toISOString();
  const events = input.events.filter(e => Date.parse(e.at) > Date.parse(since) && Date.parse(e.at) <= Date.parse(now));
  const running = orders.flatMap(d => d.runs.filter(r => !r.ended).map(r => ({ tag: d.order.tag, run: r, commit: readings?.activity[d.order.tag]?.lastCommitAt })));
  const stalled = readings?.report.problems.filter(p => ['stalled', 'commit-nudge', 'start-failed', 'looping'].includes(p.kind)) ?? [];
  const latest = orders.map(d => ({ d, report: [...d.reports].sort((a, b) => b.seq - a.seq)[0], action: [...d.actions].sort((a, b) => b.seq - a.seq)[0] }));
  const held = latest.filter(({ d, action }) => action?.kind === 'hold' && !d.runs.some(r => !r.ended) && Date.parse(now) - Date.parse(action.at) > 3 * 86400_000);
  const questions = latest.filter(({ d, report, action }) => (d.questions ?? []).some(q => !q.answered) || (report?.question && ['waiting', 'blocked'].includes(report.status) && (!action || action.seq < report.seq)));
  const cardOrders = questions.filter(({ report }) => report?.waiting_for === 'card');
  const cards = (input.actions ?? []).filter(a => a.status === 'proposed' || (a.messageId && a.status === 'would-do'));
  const slots = snapshot?.windows['7d'].slots ?? [];
  const risks = snapshot?.analysis?.risks ?? [], riskKeys = risks.map(riskKey);
  const fingerprint = digest({ events: input.events.filter(e => Date.parse(e.at) <= Date.parse(now)).map(eventId), running: running.map(r => [r.tag, r.run.id, r.commit]),
    stalled, held: held.map(h => h.d.order.tag), questions: questions.map(q => q.d.order.tag), cards: [...cards.map(c => c.id), ...cardOrders.map(c => c.d.order.tag)],
    slots: slots.map(s => [s.cap, s.current]), constraint: snapshot?.analysis?.constraint, risks: riskKeys, direction: input.direction.version });
  const brief: ProducerBrief = { id: randomUUID(), at: now, since, language: input.language, skeleton: '', text: '', fingerprint, facts: [], snapshot, direction: input.direction, riskKeys };
  if (previous?.fingerprint === fingerprint) { brief.skeleton = brief.text = word("Nothing changed since the last brief."); return brief; }
  const lines: string[] = [];
  const fact = (id: string, value: BriefFact['value'], unit: string, sources: string[]) => {
    const full = `F:brief.${id}`; brief.facts.push({ id: full, value, unit, sources }); return `[${full}]`;
  };
  const groups: [string, OrderEvent[]][] = [
    ['merged', events.filter(e => e.type === 'action-approve')],
    ['delivered', events.filter(e => e.type === 'report' && e.data?.status === 'ready')],
    ['sent back', events.filter(e => e.type === 'action-rework')],
    ['failed', events.filter(e => e.type === 'report' && e.data?.status === 'failed' || e.type === 'run-end' && e.data?.outcome === 'failed' && !orders.some(d => d.order.tag === e.tag && d.reports.some(r => r.run === e.data?.run && r.status === 'failed' && Date.parse(r.at) <= Date.parse(now))))],
    ['dispatched', events.filter(e => e.type === 'run-start')],
    ['held', events.filter(e => e.type === 'action-hold')],
  ];
  lines.push(word("Changes since the last brief:"));
  for (const [en, records] of groups) lines.push(`${word(en)}: ${records.length} ${fact(`changes.${en.replace(/ /g, '_')}`, records.length, 'events', records.length ? records.map(eventId) : [`event-range:${since}/${now}`])}${records.length ? ` — ${[...new Set(records.map(e => e.tag))].join(', ')}` : ''}`);
  lines.push(word("Running orders:"));
  if (!running.length) lines.push(word("None."));
  for (const row of running) {
    const minutes = row.commit ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(row.commit)) / 60000)) : null;
    const cite = fact(`running.${key(row.tag)}.commit_minutes`, minutes, 'minutes', row.commit ? [`git:${row.tag}:${row.commit}`, `tick:${readings!.report.at}`] : [`run:${row.run.id}`]);
    lines.push(`${row.tag}: ${minutes === null ? word("last commit unavailable") : word('{minutes} minutes since last commit', { minutes })} ${cite}`);
  }
  lines.push(`${word("Stalled orders")}: ${readings ? new Set(stalled.map(s => s.tag)).size : word("unavailable")} ${fact('stalled', readings ? new Set(stalled.map(s => s.tag)).size : null, 'orders', readings ? [`tick:${readings.report.at}`] : [])}`);
  for (const row of stalled) lines.push(`${row.tag ?? ''}: ${row.kind} [F:brief.stalled]`);
  lines.push(word("Free slots and dispatch blockers:"));
  if (!snapshot) lines.push(word("Slot facts unavailable."));
  for (const slot of slots) {
    const id = `F:slot.${key(slot.cap)}.current.idle.7d`;
    const source = snapshot!.facts.find(f => f.id === id);
    if (!source) continue;
    brief.facts.push({ id, value: source.value, unit: source.unit, sources: [`snapshot:${snapshot!.at}`] });
    lines.push(`${slot.cap}: ${source.value} ${word("free")} [${id}]`);
  }
  if (!readings) lines.push(word("Dispatch readings unavailable."));
  else if (readings.report.heldBack.length) {
    for (const row of readings.report.heldBack) {
      const cite = fact(`dispatch.${key(row.tag)}.reason`, row.why, 'reason', [`tick:${readings.report.at}`]);
      lines.push(`${row.tag}: ${row.why} ${cite}`);
    }
  } else {
    const reasons = [...readings.report.unavailable.flatMap(w => w.reasons), ...readings.report.problems.filter(p => ['no-worker', 'no-fit', 'quota', 'launch'].includes(p.kind)).map(p => p.text)];
    const status = reasons.length ? reasons.join('; ') : readings.report.moves.length ? word("Dispatch candidates remain; next tick applies routing and caps.") : word("No dispatch candidate in the recorded tick.");
    lines.push(`${status} ${fact('dispatch', status, 'status', [`tick:${readings.report.at}`])}`);
  }
  lines.push(word("Waiting on a person:"));
  lines.push(`${word("Cards")}: ${cards.length + cardOrders.length} ${fact('waiting.cards', cards.length + cardOrders.length, 'cards', [...cards.map(c => `action:${c.id}`), ...cardOrders.map(c => `order:${c.d.order.tag}`)])}`);
  for (const row of cards) lines.push(`${row.target ?? row.caseId}: ${row.kind} [F:brief.waiting.cards]`);
  for (const row of cardOrders) lines.push(`${row.d.order.tag} [F:brief.waiting.cards]`);
  lines.push(`${word("Questions")}: ${questions.length} ${fact('waiting.questions', questions.length, 'orders', questions.map(q => `order:${q.d.order.tag}`))}`);
  for (const row of questions) lines.push(`${row.d.order.tag} [F:brief.waiting.questions]`);
  lines.push(`${word("Held orders older than three days")}: ${held.length} ${fact('waiting.held', held.length, 'orders', held.map(h => `action:${h.d.order.tag}:${h.action!.seq}`))}`);
  for (const row of held) lines.push(`${row.d.order.tag} [F:brief.waiting.held]`);
  const constraint = snapshot?.analysis?.constraint;
  lines.push(`${word("Constraint")}: ${constraint?.title ?? word("unavailable")} ${constraint?.factIds.map(id => `[${id}]`).join(' ') ?? ''}`);
  for (const id of constraint?.factIds ?? []) { const f = snapshot?.facts.find(f => f.id === id); if (f) brief.facts.push({ id, value: f.value, unit: f.unit, sources: [`snapshot:${snapshot!.at}`] }); }
  lines.push(word("New risks:"));
  const newRisks = risks.filter(r => !previous?.riskKeys.includes(riskKey(r)));
  if (!newRisks.length) lines.push(word("None."));
  for (const r of newRisks) {
    lines.push(`${r.title}; ${word("occurrences")}: ${r.count} ${fact(`risk.${key(r.id)}`, r.count, 'occurrences', r.factIds)}`);
  }
  brief.skeleton = brief.text = lines.join('\n');
  return brief;
}

const citations = (text: string) => text.match(/\[(?:F:|event:)[^\]\n]+\]/g) ?? [];
export const briefNumbers = (text: string): string[] => text.replace(/\[(?:F:|event:)[^\]\n]+\]/g, '').match(/[-+]?\d+(?:\.\d+)?%?/g) ?? [];
/** Rewriting is optional: preserve every numeric token and every citation, reject invented ones. */
export function validBriefProse(skeleton: string, prose: string): boolean {
  if (!prose.trim() || prose.length > skeleton.length * 3 + 500) return false;
  const numbers = (s: string) => briefNumbers(s).sort().join('|');
  const refs = (s: string) => [...new Set(citations(s))].sort().join('|');
  return numbers(skeleton) === numbers(prose) && refs(skeleton) === refs(prose);
}

export function briefDue(config: ProducerBriefConfig, now: string, previous?: ProducerBrief): boolean {
  if (!previous) return true;
  if (Date.parse(now) - Date.parse(previous.at) >= config.every_minutes * 60000) return true;
  if (!config.daily_at) return false;
  const daily = `${now.slice(0, 10)}T${config.daily_at}:00.000Z`;
  return Date.parse(now) >= Date.parse(daily) && Date.parse(previous.at) < Date.parse(daily);
}

/** The notification text goes only to stdin; argv comes only from configuration. */
export async function notifyBrief(command: readonly string[], text: string, cwd: string, timeoutMs = 10000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Brief notification timed out.')); }, timeoutMs);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.stdin.on('error', () => { /* exit/error below reports delivery failure */ });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Brief notification exited with ${code}.`)); });
    child.stdin.end(text, 'utf8');
  });
}

const active = new Set<string>();
export async function scheduledBrief(p: ProjectConfig, orders: Orders, options: { now?: string; rewrite?: (skeleton: string, language: string) => Promise<string | undefined> } = {}): Promise<ProducerBrief | undefined> {
  const config = p.producer.brief, now = options.now ?? new Date().toISOString();
  if (!p.producer.enabled || !config || producerState(p).paused || active.has(p.state_dir)) return;
  const previous = producerBriefs(p).find(b => b.kind !== 'round');
  if (!briefDue(config, now, previous)) return;
  active.add(p.state_dir);
  try {
    const brief = buildBrief({ now, language: config.language, orders: orders.all(), events: orders.store.events(), snapshot: readFacts(p), readings: readStateJson<BriefReadings | undefined>(p, READINGS, undefined), actions: producerState(p).actions, previous, direction: standingDirection(p) });
    if (p.producer.session.enabled && options.rewrite && brief.text.includes('\n')) {
      try {
        const prose = await options.rewrite(brief.skeleton, config.language);
        if (prose && validBriefProse(brief.skeleton, prose)) { brief.text = prose; brief.rewritten = true; }
        else if (prose) brief.rewriteError = 'Rewrite changed numbers or citations; retained skeleton.';
      } catch { brief.rewriteError = 'Rewrite unavailable; retained skeleton.'; }
    }
    if (config.command) brief.hook = { status: 'pending' };
    // Persist before notifying. A restart never repeats a possibly delivered hook.
    updateStateJson<ProducerBrief[]>(p, BRIEFS_STATE, [], rows => [...rows, brief].slice(-200));
    if (config.command) {
      try { await notifyBrief(config.command, brief.text, p.root); brief.hook = { status: 'sent' }; }
      catch (error) { brief.hook = { status: 'failed', error: (error as Error).message }; }
      updateStateJson<ProducerBrief[]>(p, BRIEFS_STATE, [], rows => rows.map(row => row.id === brief.id ? brief : row));
    }
    return brief;
  } finally { active.delete(p.state_dir); }
}
