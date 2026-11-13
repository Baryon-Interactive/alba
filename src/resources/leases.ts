import { existsSync, readFileSync } from 'node:fs';
import type { ProjectConfig, ResourceConfig } from '../config.ts';
import type { Lease, ResourceView } from '../api/types.ts';
import { t } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { routingOf } from '../routing/classify.ts';
import { orderTools, toolResources } from '../plugins/tools.ts';
import { isGenericKind } from '../routing/kinds.ts';
import { findOrderFile } from '../run/prompt.ts';
import { readStateJson, writeStateFile, stateTransaction } from '../orders/state-files.ts';
import { forgetStartedAt, knownStartedAt, primeStartedAt, processStartedAtAsync } from '../monitor/process.ts';
import { processStartMatches, type ProcessInfo } from '../run/kill-tree.ts';

/** A hold on one resource by one order. */
export interface StoredLease { resource: string; tag: string; run?: string; since: string; expires: string; acceptance?: { pid: number; started_at?: string; child_pid?: number; child_started_at?: string; tree_members?: ProcessInfo[]; cap?: string; measurement?: boolean; nightly?: boolean; kind?: string; unverified?: boolean } }

let ownStartedAt: string | undefined;
let ownLookup: Promise<string | undefined> | undefined;

/**
 * Records this process's own start time once. The lookup is asynchronous and retried a few times; call it at startup and before
 * taking leases. If it never succeeds, leases written by this process are marked `unverified` (alive means held), never dead.
 */
export function ensureOwnStartedAt(attempts = 3): Promise<string | undefined> {
  if (ownStartedAt) return Promise.resolve(ownStartedAt);
  ownLookup ??= (async () => {
    for (let i = 0; i < attempts && !ownStartedAt; i++) ownStartedAt = await processStartedAtAsync(process.pid);
    return ownStartedAt;
  })().finally(() => { ownLookup = undefined; });
  return ownLookup;
}
/** Identity written into a lease. Never blocks: an unknown start time is flagged instead of looked up. */
export const leaseProcessIdentity = (): { pid: number; started_at?: string; unverified?: boolean } => ({ pid: process.pid, ...(ownStartedAt ? { started_at: ownStartedAt } : { unverified: true }) });

/** What the lease checks use to compare start times: the cache only (never a child process). A miss starts a background lookup. */
const cachedStartedAt = (pid: number): string | undefined => {
  if (pid === process.pid) return ownStartedAt;
  const at = knownStartedAt(pid);
  if (at === undefined) void primeStartedAt(pid);
  return at;
};

/**
 * Is the process behind an acceptance, measurement or nightly lease still the one that took it?
 * Dead pid or a different recorded start time: no. Anything that cannot be established (lookup not done yet, lookup failed,
 * identity not recorded because the host could not read it): keep the lease while the pid is alive. Expiry alone cannot
 * release a resource that a live process is still using.
 */
export function acceptanceLeaseActive(lease: StoredLease, _now = new Date(), identify: (pid: number) => string | undefined = cachedStartedAt): boolean {
  if (!lease.acceptance) return false;
  const a = lease.acceptance;
  return [[a.pid, a.started_at],[a.child_pid, a.child_started_at], ...(a.tree_members ?? []).map(p => [p.pid, p.createdAt])].some(([pid, started]) => {
    if (typeof pid !== 'number' || !pid) return false;
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') { forgetStartedAt(pid); return false; } }
    // Acceptance/measurement leases conservatively protect live pids when identity lookup fails. Nightly leases need an identity or the
    // explicit `unverified` flag (written when the host could not read its own start time).
    if (!started) return a.unverified === true || (!a.nightly && !a.started_at && !a.child_started_at);
    const actual = identify(pid);
    return actual === undefined || processStartMatches(actual, String(started));
  });
}

/** Looks up (asynchronously, outside any transaction) the start times the lease checks will compare against. */
export async function primeLeaseIdentities(project: ProjectConfig): Promise<void> {
  const pids = new Set<number>();
  for (const l of readLeases(project)) {
    const a = l.acceptance;
    if (!a) continue;
    if (a.started_at && a.pid !== process.pid) pids.add(a.pid);
    if (a.child_started_at && a.child_pid) pids.add(a.child_pid);
    for (const member of a.tree_members ?? []) pids.add(member.pid);
  }
  await Promise.all([...pids].map(pid => { try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') { forgetStartedAt(pid); return undefined; } } return primeStartedAt(pid); }));
}

/** Reserve acceptance resources atomically against dispatch leases and running kind caps. */
export function acquireAcceptanceResources(project: ProjectConfig, orders: Orders, tag: string, names: string[], now = new Date()): string | undefined {
  return stateTransaction(project, () => {
    const leases = readLeases(project).filter(l => !l.acceptance || acceptanceLeaseActive(l));
    const running = occupants(project, orders);
    for (const name of names) {
      if (project.resources?.[name]) {
        const reason = startBlocked(project.resources, leases, running, { tag, kind: 'acceptance', uses: [name] });
        if (reason) return reason;
      } else if (Object.hasOwn(project.dispatch.caps, name)) {
        const count = orders.all().filter(d => ['running', 'monitoring'].includes(orders.stage(d).stage) && [kindOfOrder(project, d), d.order.heavy].includes(name)).length + leases.filter(l => l.acceptance?.cap === name).length;
        if (count >= project.dispatch.caps[name]) return `cap for ${name} is full (${count}/${project.dispatch.caps[name]})`;
      } else throw new Error(`Acceptance resource ${name} is not a declared resource or cap.`);
    }
    for (const name of names) {
      const cap = project.resources?.[name] ? undefined : name;
      leases.push({ resource: cap ? `accept-cap:${cap}` : name, tag, since: now.toISOString(), expires: new Date(now.getTime() + (project.resources?.[name]?.lease_minutes ?? 480) * 60000).toISOString(), acceptance: { ...leaseProcessIdentity(), ...(cap ? { cap } : {}) } });
      orders.record(tag, 'lease-acquired', { resource: name, acceptance: true });
    }
    writeLeases(project, leases);
    return undefined;
  });
}

export function releaseAcceptanceResources(project: ProjectConfig, orders: Orders, tag: string): void {
  stateTransaction(project, () => {
    const leases = readLeases(project);
    const mine = leases.filter(l => l.tag === tag && l.acceptance?.pid === process.pid);
    writeLeases(project, leases.filter(l => !mine.includes(l)));
    for (const l of mine) orders.record(tag, 'lease-released', { resource: l.resource, acceptance: true });
  });
}

/**
 * Leases for a tool job (`holder` is `tool:<job>`): one slot of each named resource, held by this process like an acceptance lease
 * (released by `releaseToolLeases`, or by the tick once the process is gone). Returns why it cannot start, or undefined when it holds them.
 */
export function acquireToolLeases(project: ProjectConfig, orders: Orders, holder: string, names: string[], now = new Date()): string | undefined {
  if (!names.length) return undefined;
  return stateTransaction(project, () => {
    const leases = readLeases(project).filter(l => !l.acceptance || acceptanceLeaseActive(l));
    const reason = startBlocked(project.resources ?? {}, leases, occupants(project, orders), { tag: holder, kind: 'tool', uses: names });
    if (reason) return reason;
    for (const name of names) {
      leases.push({ resource: name, tag: holder, since: now.toISOString(), expires: new Date(now.getTime() + (project.resources?.[name]?.lease_minutes ?? 480) * 60000).toISOString(), acceptance: { ...leaseProcessIdentity(), kind: 'tool' } });
      orders.record(holder, 'lease-acquired', { resource: name, tool_job: true });
    }
    writeLeases(project, leases);
    return undefined;
  });
}

export function releaseToolLeases(project: ProjectConfig, orders: Orders, holder: string): void {
  stateTransaction(project, () => {
    const leases = readLeases(project);
    const mine = leases.filter(l => l.tag === holder);
    if (!mine.length) return;
    writeLeases(project, leases.filter(l => !mine.includes(l)));
    for (const l of mine) orders.record(holder, 'lease-released', { resource: l.resource, tool_job: true });
  });
}

export function readLeases(project: ProjectConfig): StoredLease[] {
  return readStateJson(project, '_leases.json', { leases: [] as StoredLease[] }).leases;
}
function writeLeases(project: ProjectConfig, leases: StoredLease[]): void {
  writeStateFile(project, '_leases.json', JSON.stringify({ leases }, null, 2) + '\n');
}

/** How much of the work-order file the `match` of a resource is tried against. */
const TEXT_CHARS = 4000;

/** Shared by dispatch and draft preview; offsets refer to the returned search text. */
export function resourceMatches(project: ProjectConfig, order: Pick<OrderDoc['order'], 'title' | 'condition'>, body: string) {
  const prefix = `${order.title}\n${order.condition ?? ''}\n`;
  const text = prefix + body.slice(0, TEXT_CHARS);
  const resources = Object.entries(project.resources ?? {}).flatMap(([resource, r]) => {
    if (!r.match) return [];
    const matches = [...text.matchAll(new RegExp(r.match, 'giu'))].map(m => ({ start: m.index!, end: m.index! + m[0].length, text: m[0] }));
    return matches.length ? [{ resource, pattern: r.match, matches }] : [];
  });
  return { text, bodyStart: prefix.length, resources };
}

/**
 * The resources an order uses: those it names itself (`uses`, set by hand or by the `uses` of a table kind rule) and those whose `match`
 * (a regular expression) is found in its title, its condition or the start of its work-order file. The rules are read again every time.
 */
export function usesOf(project: ProjectConfig, doc: OrderDoc): string[] {
  const resources = project.resources ?? {};
  const out = new Set<string>(doc.order.uses ?? []);
  // The resources of the order's tools (named on the order, or by its kind under plugins.by_kind).
  if (project.plugins && (doc.order.tools?.length || Object.keys(project.plugins.by_kind).length)) {
    const kind = Object.keys(project.plugins.by_kind).length ? routingOf(project, doc).kind || doc.order.kind : doc.order.kind;
    for (const name of toolResources(orderTools(project, doc, kind).tools)) out.add(name);
  }
  const rules = Object.entries(resources).filter(([name, r]) => r.match && !out.has(name));
  if (rules.length) {
    let body = '';
    try { const f = findOrderFile(project.work_orders, doc.order.tag); if (existsSync(f)) body = readFileSync(f, 'utf8'); } catch { /* no file yet */ }
    for (const hit of resourceMatches(project, doc.order, body).resources) out.add(hit.resource);
  }
  // An editor holds the resources its pool names (for example the editor-build slots) for as long as the run has it.
  for (const pool of Object.values(project.editors ?? {})) if (out.has(pool.name)) for (const h of pool.holds) out.add(h);
  return [...out];
}

/** The heavy class an order counts against: its own, else the cap of the editor it uses (an Unreal editor counts against `ue`). */
export function heavyOf(project: ProjectConfig, doc: OrderDoc): string | undefined {
  if (doc.order.heavy || !project.editors) return doc.order.heavy;
  const uses = usesOf(project, doc);
  return Object.values(project.editors).find(p => p.cap && uses.includes(p.name))?.cap;
}

/** A running or monitored order, as far as the blocking rules care. */
export interface Occupant { tag: string; kind: string }

export interface StartWanted { tag: string; kind: string; uses: string[] }

const heldBy = (leases: readonly StoredLease[], resource: string, except: string) => leases.filter(l => l.resource === resource && l.tag !== except);

/**
 * Why an order cannot start now because of the resources, or undefined when it can. Pure.
 *  - every resource it uses must have a free slot (leases of other orders, and the ones planned in this pass, count);
 *  - while an exclusive resource is held by another order, no order of the kinds it blocks starts;
 *  - an order that uses an exclusive resource waits until no other order of the kinds it blocks is running or monitored.
 */
export function startBlocked(resources: Record<string, ResourceConfig>, leases: readonly StoredLease[], running: readonly Occupant[], order: StartWanted, planned: readonly StartWanted[] = []): string | undefined {
  for (const name of order.uses) {
    const r = resources[name];
    if (!r) return t('it uses the resource "{name}", which the project does not declare under "resources"', { name });
    if (heldBy(leases, name, order.tag).some(l => l.acceptance?.nightly)) return t('resource {name} is reserved for nightly gates', { name });
    const taken = [...heldBy(leases, name, order.tag).map(l => l.tag), ...planned.filter(p => p.tag !== order.tag && p.uses.includes(name)).map(p => p.tag)];
    if (taken.length >= r.slots) return t('resource {name} is full ({n}/{slots}, held by {who})', { name, n: taken.length, slots: r.slots, who: [...new Set(taken)].join(', ') });
    if (r.exclusive) {
      const others = [...running, ...planned].filter(o => o.tag !== order.tag && r.blocks.includes(o.kind));
      if (others.length) return t('resource {name} is exclusive and needs the machine to itself: {kinds} orders are running ({who})', { name, kinds: r.blocks.join('/'), who: [...new Set(others.map(o => o.tag))].join(', ') });
    }
  }
  for (const [name, r] of Object.entries(resources)) {
    if (!r.exclusive || !r.blocks.includes(order.kind) || order.uses.includes(name)) continue;
    const holders = [...heldBy(leases, name, order.tag).map(l => l.tag), ...planned.filter(p => p.tag !== order.tag && p.uses.includes(name)).map(p => p.tag)];
    if (holders.length) return t('resource {name} is exclusive and held by {who}: no {kind} order is started meanwhile', { name, who: [...new Set(holders)].join(', '), kind: order.kind });
  }
  return undefined;
}

/** Does the order still need its leases? While it runs or is monitored, and while it waits to be continued after a monitor ended. */
export function leaseKept(orders: Orders, doc: OrderDoc): boolean {
  if (doc.runs.some(r => !r.ended)) return true;
  const stage = orders.stage(doc).stage;
  if (stage === 'running' || stage === 'monitoring') return true;
  if (stage !== 'queued') return false;
  const last = [...doc.actions].sort((a, b) => b.seq - a.seq).find(a => a.kind === 'queue' || a.kind === 'rework' || a.kind === 'answer' || a.kind === 'monitor');
  return last?.kind === 'monitor';
}

/** The leases of orders that still need them (the rest are about to be released by the next real tick). */
export function activeLeases(project: ProjectConfig, orders: Orders): StoredLease[] {
  const docs = new Map(orders.all().map(d => [d.order.tag, d]));
  return readLeases(project).filter(l => { if (l.acceptance) return acceptanceLeaseActive(l); const d = docs.get(l.tag); return !!d && leaseKept(orders, d); });
}

/** The kind an order counts as (its own, else what it was classified as). */
export const kindOfOrder = (project: ProjectConfig, doc: OrderDoc): string => (isGenericKind(doc.order.kind) ? routingOf(project, doc).kind || doc.order.kind : doc.order.kind);

/** The orders that hold a machine now: running or monitored. */
export function occupants(project: ProjectConfig, orders: Orders): Occupant[] {
  return [...orders.all().filter(d => { const s = orders.stage(d).stage; return d.runs.some(r => !r.ended) || s === 'running' || s === 'monitoring'; }).map(d => ({ tag: d.order.tag, kind: kindOfOrder(project, d) })), ...new Map(readLeases(project).filter(l => (l.acceptance?.measurement || (l.acceptance?.nightly && l.acceptance.kind)) && acceptanceLeaseActive(l)).map(l => [l.tag, { tag: l.tag, kind: l.acceptance!.kind ?? 'measure' }])).values()];
}

/** One kind cap (`dispatch.caps`) an order counts against: its kind or its heavy class, and the other orders holding a slot of it now. */
export interface CapHold { key: string; cap: number; others: string[] }

/**
 * The caps an order counts against, with who else holds them: other running or monitored orders of that kind or heavy class,
 * and acceptance runs holding the cap. The tick plans with the same counts; `alba run` and the console's run check them here.
 */
export function capHolds(project: ProjectConfig, orders: Orders, doc: OrderDoc): CapHold[] {
  const caps = project.dispatch.caps;
  const keys = [...new Set([kindOfOrder(project, doc), heavyOf(project, doc)].filter((k): k is string => !!k && Object.hasOwn(caps, k)))];
  if (!keys.length) return [];
  const busy = orders.all().filter(d => d.order.tag !== doc.order.tag && (d.runs.some(r => !r.ended) || ['running', 'monitoring'].includes(orders.stage(d).stage)));
  const accepting = readLeases(project).filter(l => l.acceptance?.cap && l.tag !== doc.order.tag && acceptanceLeaseActive(l));
  return keys.map(key => ({ key, cap: caps[key], others: [...busy.filter(d => [kindOfOrder(project, d), heavyOf(project, d)].includes(key)).map(d => d.order.tag), ...accepting.filter(l => l.acceptance!.cap === key).map(l => `${l.tag} (acceptance)`)] }));
}

/** The first cap that is full for this order, as a sentence, or undefined. `reserve`: slots above the cap this start may use (the tick's rework reserve). */
export const capFull = (holds: readonly CapHold[], reserve = 0): string | undefined => {
  const full = holds.find(h => h.others.length >= h.cap + reserve);
  return full && t('cap for "{key}" is full ({used}/{cap}: {who})', { key: full.key, used: full.others.length, cap: full.cap, who: full.others.join(', ') });
};

/** Takes the leases for an order that is starting (again taking what it holds is not an error). Returns the resources it holds. */
export function acquireLeases(project: ProjectConfig, orders: Orders, doc: OrderDoc, run: string | undefined, now: Date): string[] {
  return stateTransaction(project, () => {
    const uses = usesOf(project, doc);
    if (!uses.length) return [];
    const all = readLeases(project);
    for (const name of uses) {
      const r = project.resources?.[name];
      if (!r) continue;
      const have = all.find(l => l.resource === name && l.tag === doc.order.tag);
      if (have) { if (run) have.run = run; continue; }
      all.push({ resource: name, tag: doc.order.tag, ...(run ? { run } : {}), since: now.toISOString(), expires: new Date(now.getTime() + r.lease_minutes * 60000).toISOString() });
      orders.record(doc.order.tag, 'lease-acquired', { resource: name, ...(run ? { run } : {}), expires: all.at(-1)!.expires });
    }
    writeLeases(project, all);
    return uses;
  });
}

/** Gives a lease back. `why` is what the event says: the run ended, the order was cancelled, or a person took it back. */
export function releaseLease(project: ProjectConfig, orders: Orders, resource: string, tag: string, why: string, now: Date): boolean {
  return stateTransaction(project, () => {
    const all = readLeases(project);
    const left = all.filter(l => !(l.resource === resource && l.tag.toLowerCase() === tag.toLowerCase()));
    if (left.length === all.length) return false;
    const held = all.find(l => l.resource === resource && l.tag.toLowerCase() === tag.toLowerCase())!;
    writeLeases(project, left);
    orders.record(held.tag, 'lease-released', { resource, why, heldMinutes: Math.max(0, Math.round((now.getTime() - Date.parse(held.since)) / 60000)) });
    return true;
  });
}

/**
 * Releases the leases of orders that no longer run or wait to be continued. Returns what it released, one line each.
 * One transaction: the orders and leases are read under the state lock, so a start of the same order meanwhile (which writes its
 * run and leases in one step) is either seen as running or not started yet, never released from under it.
 */
export function reconcileLeases(project: ProjectConfig, orders: Orders, now: Date): string[] {
  return stateTransaction(project, () => {
    const out: string[] = [];
    const docs = new Map(orders.all().map(d => [d.order.tag, d]));
    for (const l of readLeases(project)) {
      if (acceptanceLeaseActive(l)) continue;
      const d = docs.get(l.tag);
      if (d && leaseKept(orders, d)) continue;
      if (releaseLease(project, orders, l.resource, l.tag, d ? t('the order is {stage}', { stage: orders.stage(d).stage }) : t('the order is gone'), now)) out.push(t('{tag}: released {resource} (the order is no longer running)', { tag: l.tag, resource: l.resource }));
    }
    return out;
  });
}

/** Every resource with who holds it and for how long. */
export function resourceViews(project: ProjectConfig, orders: Orders, now: Date): ResourceView[] {
  const active = activeLeases(project, orders);
  return Object.entries(project.resources ?? {}).map(([name, r]) => {
    const leases: Lease[] = active.filter(l => l.resource === name).map(l => ({
      resource: name, tag: l.tag, ...(l.run ? { run: l.run } : {}), since: l.since, expires: l.expires, expired: now.getTime() > Date.parse(l.expires),
      heldMinutes: Math.max(0, Math.round((now.getTime() - Date.parse(l.since)) / 60000)),
    }));
    return { name, slots: r.slots, used: leases.length, ...(r.note ? { note: r.note } : {}), exclusive: r.exclusive, blocks: r.exclusive ? r.blocks : [], leases };
  });
}
