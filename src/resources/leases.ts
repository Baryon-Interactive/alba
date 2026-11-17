import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig, ResourceConfig } from '../config.ts';
import type { Lease, ResourceQueueEntry, ResourceView } from '../api/types.ts';
import { currentLang, fail, t } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import { Orders } from '../orders/service.ts';
import { stateStore } from '../orders/backend.ts';
import { routingOf } from '../routing/classify.ts';
import { orderTools, toolResources } from '../plugins/tools.ts';
import { isGenericKind } from '../routing/kinds.ts';
import { findOrderFile } from '../run/prompt.ts';
import { readStateJson, stateProject, writeStateFile, stateTransaction } from '../orders/state-files.ts';
import { forgetStartedAt, knownStartedAt, primeStartedAt, processStartedAtAsync } from '../monitor/process.ts';
import { processStartMatches, type ProcessInfo } from '../run/kill-tree.ts';
import {
  estimateWaitMinutes, existingMachineStore, hasMachineResources, machineStoreFor, projectMachineContext,
  type MachineLeaseRow, type WaiterPriority,
} from './machine-store.ts';

/** A hold on one resource by one order, or a machine-wide foreign/queued entry returned by `activeLeases`. */
export interface StoredLease {
  resource: string;
  tag: string;
  run?: string;
  since: string;
  expires: string;
  project?: string;
  foreign?: true;
  queued?: { position: number; priority: WaiterPriority; enqueuedAt?: string; etaMinutes?: number };
  acceptance?: { pid: number; started_at?: string; child_pid?: number; child_started_at?: string; tree_members?: ProcessInfo[]; cap?: string; measurement?: boolean; nightly?: boolean; kind?: string; unverified?: boolean };
}

interface MachineMeta {
  project: string;
  nowMs: number;
  effectiveSlots: Map<string, number>;
  medianMinutes: Map<string, number | undefined>;
}

const MACHINE_META = Symbol('alba.machineMeta');

function attachMachineMeta<T extends object>(target: T, meta: MachineMeta): T {
  Object.defineProperty(target, MACHINE_META, { value: meta, enumerable: false, configurable: true });
  return target;
}

function readMachineMeta(leases: readonly StoredLease[]): MachineMeta | undefined {
  const direct = (leases as unknown as { [MACHINE_META]?: MachineMeta })[MACHINE_META];
  if (direct) return direct;
  for (const l of leases) {
    const found = (l as unknown as { [MACHINE_META]?: MachineMeta })[MACHINE_META];
    if (found) return found;
  }
  return undefined;
}

/** English ordinal for a 1-based position (`1st`, `2nd`, `3rd`, `4th`, `11th`, `21st`). */
export function ordinal(n: number): string {
  const mod100 = Math.abs(n) % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = Math.abs(n) % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

const isMachineResource = (project: ProjectConfig, name: string): boolean => project.resources?.[name]?.scope === 'machine';

const isPidAlive = (pid: number | undefined): pid is number => {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

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
  if (pid === process.pid) return ownStartedAt ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
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

/** Reuses `acceptanceLeaseActive` for any machine-store lease row that carries a recorded process identity. */
export function machineLeaseProcessActive(row: MachineLeaseRow, now = new Date(), identify: (pid: number) => string | undefined = cachedStartedAt): boolean {
  if (row.pid === undefined) return false;
  return acceptanceLeaseActive({
    resource: row.resource,
    tag: row.tag,
    since: row.since,
    expires: row.expires,
    acceptance: {
      pid: row.pid,
      ...(row.started_at ? { started_at: row.started_at } : {}),
      ...(row.unverified ? { unverified: true } : {}),
      ...(row.kind === 'nightly' ? { nightly: true } : {}),
      ...(row.kind !== 'dispatch' && row.kind !== 'nightly' ? { kind: row.kind } : {}),
    },
  }, now, identify);
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
  if (hasMachineResources(project)) {
    for (const row of machineStoreFor(project).allLeases()) {
      if (row.started_at && row.pid && row.pid !== process.pid) pids.add(row.pid);
    }
  }
  await Promise.all([...pids].map(pid => { try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') { forgetStartedAt(pid); return undefined; } } return primeStartedAt(pid); }));
}

function recoverForProject(project: ProjectConfig, now: Date) {
  const store = machineStoreFor(project);
  const ctx = projectMachineContext(project);
  return { store, ctx, runRecoverInTx: () => store.recoverStaleInTx(now, machineLeaseProcessActive, { print: ctx?.print, everyMinutes: ctx?.everyMinutes }) };
}

function formatMachineWaitReason(
  name: string,
  position: number,
  etaMinutes: number | undefined,
  holders: readonly { project?: string; tag: string; heldMinutes: number }[],
): string {
  const place = currentLang() === 'zh' ? t('No. {n} in queue', { n: position }) : `${ordinal(position)} in queue`;
  const eta = etaMinutes === undefined ? t('unknown') : t('about {min} min', { min: etaMinutes });
  if (!holders.length) return t('waiting for {name} slot ({place}, {eta})', { name, place, eta });
  const who = holders
    .map(h => t('{holder} for {min} min', { holder: h.project ? `${h.project}:${h.tag}` : h.tag, min: h.heldMinutes }))
    .join(', ');
  return t('waiting for {name} slot ({place}, {eta}; held by {who})', { name, place, eta, who });
}

function checkMachineTakeInTx(project: ProjectConfig, name: string, tag: string, now: Date): string | undefined {
  const r = project.resources?.[name];
  if (!r) return t('it uses the resource "{name}", which the project does not declare under "resources"', { name });
  const store = machineStoreFor(project);
  const allHolders = store.leasesFor([name]);
  if (allHolders.some(h => h.project === project.id && h.tag.toLowerCase() === tag.toLowerCase())) return undefined;
  const otherHolders = allHolders.filter(h => !(h.project === project.id && h.tag.toLowerCase() === tag.toLowerCase()));
  if (otherHolders.some(h => h.kind === 'nightly')) return t('resource {name} is reserved for nightly gates', { name });
  const { effectiveSlots } = store.declarationsOf(name, r.slots, now);
  const freeSlots = effectiveSlots - otherHolders.length;
  const waiters = store.waitersFor(name);
  const ownIdx = waiters.findIndex(w => w.project === project.id && w.tag.toLowerCase() === tag.toLowerCase());
  const ahead = (ownIdx >= 0 ? waiters.slice(0, ownIdx) : waiters)
    .filter(w => !otherHolders.some(h => h.project === w.project && h.tag.toLowerCase() === w.tag.toLowerCase()));
  if (freeSlots > ahead.length) return undefined;
  const pos = ownIdx >= 0 ? waiters[ownIdx].position : ahead.length + 1;
  const nowMs = now.getTime();
  const holderViews = otherHolders.map(h => ({
    project: h.project,
    tag: h.tag,
    heldMinutes: Math.max(0, Math.round((nowMs - Date.parse(h.since)) / 60000)),
  }));
  const eta = estimateWaitMinutes(store.medianHoldMinutes(name), pos, effectiveSlots, holderViews.map(h => h.heldMinutes));
  return formatMachineWaitReason(name, pos, eta, holderViews);
}

/** Reserve acceptance resources atomically against dispatch leases and running kind caps. */
export function acquireAcceptanceResources(project: ProjectConfig, orders: Orders, tag: string, names: string[], now = new Date()): string | undefined {
  return stateTransaction(project, () => {
    const leases = readLeases(project).filter(l => !l.acceptance || acceptanceLeaseActive(l));
    const running = occupants(project, orders);
    const machineNames: string[] = [];
    for (const name of names) {
      if (project.resources?.[name]) {
        if (isMachineResource(project, name)) machineNames.push(name);
        else {
          const reason = startBlocked(project.resources, leases, running, { tag, kind: 'acceptance', uses: [name] });
          if (reason) return reason;
        }
      } else if (Object.hasOwn(project.dispatch.caps, name)) {
        const count = orders.all().filter(d => ['running', 'monitoring'].includes(orders.stage(d).stage) && [kindOfOrder(project, d), d.order.heavy].includes(name)).length + leases.filter(l => l.acceptance?.cap === name).length;
        if (count >= project.dispatch.caps[name]) return `cap for ${name} is full (${count}/${project.dispatch.caps[name]})`;
      } else throw new Error(`Acceptance resource ${name} is not a declared resource or cap.`);
    }
    if (machineNames.length) {
      const { store, ctx, runRecoverInTx } = recoverForProject(project, now);
      store.noteNow(now);
      const blocked = store.transaction(() => {
        runRecoverInTx();
        store.syncDeclaredInTx(project, now);
        for (const name of machineNames) {
          const why = checkMachineTakeInTx(project, name, tag, now);
          if (why) return why;
        }
        const id = leaseProcessIdentity();
        const nowIso = now.toISOString();
        for (const name of machineNames) {
          const minutes = project.resources?.[name]?.lease_minutes ?? 480;
          store.upsertLeaseInTx({
            resource: name, project: project.id, state_dir: path.resolve(project.state_dir), tag,
            since: nowIso, expires: new Date(now.getTime() + minutes * 60000).toISOString(),
            pid: id.pid, ...(id.started_at ? { started_at: id.started_at } : {}), ...(id.unverified ? { unverified: true } : {}),
            ...(ctx?.everyMinutes !== undefined ? { every_minutes: ctx.everyMinutes } : {}),
            kind: 'acceptance', heartbeat_at: nowIso,
          });
        }
        return undefined;
      });
      if (blocked) return blocked;
    }
    let wroteLocal = false;
    for (const name of names) {
      if (isMachineResource(project, name)) {
        orders.record(tag, 'lease-acquired', { resource: name, acceptance: true, scope: 'machine' });
        continue;
      }
      const cap = project.resources?.[name] ? undefined : name;
      leases.push({ resource: cap ? `accept-cap:${cap}` : name, tag, since: now.toISOString(), expires: new Date(now.getTime() + (project.resources?.[name]?.lease_minutes ?? 480) * 60000).toISOString(), acceptance: { ...leaseProcessIdentity(), ...(cap ? { cap } : {}) } });
      orders.record(tag, 'lease-acquired', { resource: name, acceptance: true });
      wroteLocal = true;
    }
    if (wroteLocal) writeLeases(project, leases);
    return undefined;
  });
}

export function releaseAcceptanceResources(project: ProjectConfig, orders: Orders, tag: string, now = new Date()): void {
  stateTransaction(project, () => {
    const leases = readLeases(project);
    const mine = leases.filter(l => l.tag === tag && l.acceptance?.pid === process.pid);
    if (mine.length) {
      writeLeases(project, leases.filter(l => !mine.includes(l)));
      for (const l of mine) orders.record(tag, 'lease-released', { resource: l.resource, acceptance: true });
    }
    if (hasMachineResources(project)) {
      const store = machineStoreFor(project);
      store.noteNow(now);
      const released = store.transaction(() => {
        const rows = store.projectLeases(project.id).filter(r => r.tag.toLowerCase() === tag.toLowerCase() && r.kind === 'acceptance' && r.pid === process.pid);
        return rows.flatMap(r => { const out = store.removeLeaseInTx(r.resource, project.id, r.tag, now, true); return out ? [out] : []; });
      });
      for (const r of released) orders.record(tag, 'lease-released', { resource: r.removed.resource, acceptance: true, heldMinutes: r.heldMinutes, scope: 'machine' });
    }
  });
}

/**
 * Leases for a tool job (`holder` is `tool:<job>`): one slot of each named resource, held by this process like an acceptance lease
 * (released by `releaseToolLeases`, or by the tick once the process is gone). Returns why it cannot start, or undefined when it holds them.
 */
export function acquireToolLeases(project: ProjectConfig, orders: Orders, holder: string, names: string[], now = new Date()): string | undefined {
  if (!names.length) return undefined;
  return stateTransaction(project, () => {
    const localNames = names.filter(n => !isMachineResource(project, n));
    const machineNames = names.filter(n => isMachineResource(project, n));
    const leases = readLeases(project).filter(l => !l.acceptance || acceptanceLeaseActive(l));
    if (localNames.length) {
      const reason = startBlocked(project.resources ?? {}, leases, occupants(project, orders), { tag: holder, kind: 'tool', uses: localNames });
      if (reason) return reason;
    }
    if (machineNames.length) {
      const { store, ctx, runRecoverInTx } = recoverForProject(project, now);
      store.noteNow(now);
      const blocked = store.transaction(() => {
        runRecoverInTx();
        store.syncDeclaredInTx(project, now);
        for (const name of machineNames) {
          const why = checkMachineTakeInTx(project, name, holder, now);
          if (why) return why;
        }
        const id = leaseProcessIdentity();
        const nowIso = now.toISOString();
        for (const name of machineNames) {
          const minutes = project.resources?.[name]?.lease_minutes ?? 480;
          store.upsertLeaseInTx({
            resource: name, project: project.id, state_dir: path.resolve(project.state_dir), tag: holder,
            since: nowIso, expires: new Date(now.getTime() + minutes * 60000).toISOString(),
            pid: id.pid, ...(id.started_at ? { started_at: id.started_at } : {}), ...(id.unverified ? { unverified: true } : {}),
            ...(ctx?.everyMinutes !== undefined ? { every_minutes: ctx.everyMinutes } : {}),
            kind: 'tool', heartbeat_at: nowIso,
          });
        }
        return undefined;
      });
      if (blocked) return blocked;
    }
    for (const name of localNames) {
      leases.push({ resource: name, tag: holder, since: now.toISOString(), expires: new Date(now.getTime() + (project.resources?.[name]?.lease_minutes ?? 480) * 60000).toISOString(), acceptance: { ...leaseProcessIdentity(), kind: 'tool' } });
      orders.record(holder, 'lease-acquired', { resource: name, tool_job: true });
    }
    for (const name of machineNames) orders.record(holder, 'lease-acquired', { resource: name, tool_job: true, scope: 'machine' });
    if (localNames.length) writeLeases(project, leases);
    return undefined;
  });
}

export function releaseToolLeases(project: ProjectConfig, orders: Orders, holder: string, now = new Date()): void {
  stateTransaction(project, () => {
    const leases = readLeases(project);
    const mine = leases.filter(l => l.tag === holder);
    if (mine.length) {
      writeLeases(project, leases.filter(l => !mine.includes(l)));
      for (const l of mine) orders.record(holder, 'lease-released', { resource: l.resource, tool_job: true });
    }
    if (hasMachineResources(project)) {
      const store = machineStoreFor(project);
      store.noteNow(now);
      const released = store.transaction(() => {
        const rows = store.projectLeases(project.id).filter(r => r.tag.toLowerCase() === holder.toLowerCase() && r.kind === 'tool');
        return rows.flatMap(r => { const out = store.removeLeaseInTx(r.resource, project.id, r.tag, now, true); return out ? [out] : []; });
      });
      for (const r of released) orders.record(holder, 'lease-released', { resource: r.removed.resource, tool_job: true, heldMinutes: r.heldMinutes, scope: 'machine' });
    }
  });
}

/** Reserves nightly gate resources across project-scope and machine-scope resources. */
export function acquireNightlyLeases(project: ProjectConfig, orders: Orders, tag: string, names: string[], expires: Date, gateKind?: string, now = new Date()): string | undefined {
  if (!names.length) return undefined;
  return stateTransaction(project, () => {
    const localNames = names.filter(n => !isMachineResource(project, n));
    const machineNames = names.filter(n => isMachineResource(project, n));
    const leases = readLeases(project).filter(l => !l.acceptance || acceptanceLeaseActive(l));
    if (localNames.length) {
      const declaredLocal = localNames.filter(n => project.resources?.[n]);
      if (declaredLocal.length) {
        const reason = startBlocked(project.resources ?? {}, leases, occupants(project, orders), { tag, kind: gateKind ?? 'nightly', uses: declaredLocal });
        if (reason) return reason;
      }
    }
    if (machineNames.length) {
      const { store, ctx, runRecoverInTx } = recoverForProject(project, now);
      store.noteNow(now);
      const blocked = store.transaction(() => {
        runRecoverInTx();
        store.syncDeclaredInTx(project, now);
        for (const name of machineNames) {
          const why = checkMachineTakeInTx(project, name, tag, now);
          if (why) return why;
        }
        const id = leaseProcessIdentity();
        const nowIso = now.toISOString();
        for (const name of machineNames) {
          store.upsertLeaseInTx({
            resource: name, project: project.id, state_dir: path.resolve(project.state_dir), tag,
            since: nowIso, expires: expires.toISOString(),
            pid: id.pid, ...(id.started_at ? { started_at: id.started_at } : {}), ...(id.unverified ? { unverified: true } : {}),
            ...(ctx?.everyMinutes !== undefined ? { every_minutes: ctx.everyMinutes } : {}),
            kind: 'nightly', heartbeat_at: nowIso,
          });
        }
        return undefined;
      });
      if (blocked) return blocked;
    }
    for (const name of localNames) {
      leases.push({ resource: name, tag, since: now.toISOString(), expires: expires.toISOString(), acceptance: { ...leaseProcessIdentity(), nightly: true, ...(gateKind ? { kind: gateKind } : {}) } });
      orders.record(tag, 'lease-acquired', { resource: name, nightly: true });
    }
    for (const name of machineNames) orders.record(tag, 'lease-acquired', { resource: name, nightly: true, scope: 'machine' });
    if (localNames.length) writeLeases(project, leases);
    return undefined;
  });
}

export function releaseNightlyLeases(project: ProjectConfig, orders: Orders | undefined, tag: string, confirmedGone = false, now = new Date()): void {
  stateTransaction(project, () => {
    const leases = readLeases(project);
    const mine = leases.filter(l => l.tag === tag && (l.acceptance?.pid === process.pid || (confirmedGone && l.acceptance?.nightly)));
    if (mine.length) {
      writeLeases(project, leases.filter(l => !mine.includes(l)));
      if (orders) for (const l of mine) orders.record(tag, 'lease-released', { resource: l.resource, nightly: true });
    }
    if (hasMachineResources(project)) {
      const store = machineStoreFor(project);
      store.noteNow(now);
      const released = store.transaction(() => {
        const rows = store.projectLeases(project.id).filter(r => r.tag.toLowerCase() === tag.toLowerCase() && r.kind === 'nightly' && (r.pid === process.pid || confirmedGone));
        return rows.flatMap(r => { const out = store.removeLeaseInTx(r.resource, project.id, r.tag, now, true); return out ? [out] : []; });
      });
      if (orders) for (const r of released) orders.record(tag, 'lease-released', { resource: r.removed.resource, nightly: true, heldMinutes: r.heldMinutes, scope: 'machine' });
    }
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

const heldBy = (leases: readonly StoredLease[], resource: string, except: string) =>
  leases.filter(l => !l.queued && l.resource === resource && (l.foreign || l.tag.toLowerCase() !== except.toLowerCase()));

/**
 * Why an order cannot start now because of the resources, or undefined when it can. Pure.
 *  - every resource it uses must have a free slot (leases of other orders, and the ones planned in this pass, count);
 *  - machine-scoped resources also respect the cross-project waiter queue (rework before new, then FIFO);
 *  - while an exclusive resource is held by another order, no order of the kinds it blocks starts;
 *  - an order that uses an exclusive resource waits until no other order of the kinds it blocks is running or monitored.
 */
export function startBlocked(resources: Record<string, ResourceConfig>, leases: readonly StoredLease[], running: readonly Occupant[], order: StartWanted, planned: readonly StartWanted[] = []): string | undefined {
  const meta = readMachineMeta(leases);
  for (const name of order.uses) {
    const r = resources[name];
    if (!r) return t('it uses the resource "{name}", which the project does not declare under "resources"', { name });
    const leaseHolders = heldBy(leases, name, order.tag);
    if (leaseHolders.some(l => l.acceptance?.nightly)) return t('resource {name} is reserved for nightly gates', { name });
    if (r.scope === 'machine') {
      const slots = meta?.effectiveSlots.get(name) ?? r.slots;
      const plannedHolders = planned.filter(p =>
        p.tag.toLowerCase() !== order.tag.toLowerCase()
        && p.uses.includes(name)
        && !leaseHolders.some(l => !l.foreign && l.tag.toLowerCase() === p.tag.toLowerCase()));
      const freeSlots = slots - (leaseHolders.length + plannedHolders.length);
      const queuedForName = leases
        .filter(l => l.queued && l.resource === name)
        .sort((a, b) => a.queued!.position - b.queued!.position);
      const ownIdx = queuedForName.findIndex(q => !q.foreign && q.tag.toLowerCase() === order.tag.toLowerCase());
      const ahead = (ownIdx >= 0 ? queuedForName.slice(0, ownIdx) : queuedForName).filter(q => {
        const qTag = q.tag.toLowerCase();
        if (!q.foreign && plannedHolders.some(p => p.tag.toLowerCase() === qTag)) return false;
        return !leaseHolders.some(h => (h.foreign ? q.foreign && h.project === q.project : !q.foreign) && h.tag.toLowerCase() === qTag);
      });
      if (freeSlots <= ahead.length) {
        const pos = ownIdx >= 0 ? queuedForName[ownIdx].queued!.position : ahead.length + 1;
        const nowMs = meta?.nowMs ?? Date.now();
        const holderViews = [
          ...leaseHolders.map(h => ({
            project: h.project ?? meta?.project,
            tag: h.tag,
            heldMinutes: Math.max(0, Math.round((nowMs - Date.parse(h.since)) / 60000)),
          })),
          ...plannedHolders.map(p => ({ project: meta?.project, tag: p.tag, heldMinutes: 0 })),
        ];
        const median = meta?.medianMinutes.get(name);
        const eta = ownIdx >= 0 && queuedForName[ownIdx].queued?.etaMinutes !== undefined && !plannedHolders.length
          ? queuedForName[ownIdx].queued!.etaMinutes
          : estimateWaitMinutes(median, pos, slots, holderViews.map(h => h.heldMinutes));
        return formatMachineWaitReason(name, pos, eta, holderViews);
      }
      continue;
    }
    const taken = [...leaseHolders.map(l => l.tag), ...planned.filter(p => p.tag !== order.tag && p.uses.includes(name)).map(p => p.tag)];
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

/** Priority in the machine-resource queue: `rework` when the order's last action is `rework`, `answer` or `monitor`, else `new`. */
export function waiterPriority(doc: OrderDoc): WaiterPriority {
  const last = [...doc.actions].sort((a, b) => b.seq - a.seq)[0];
  return last && (last.kind === 'rework' || last.kind === 'answer' || last.kind === 'monitor') ? 'rework' : 'new';
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

/** The leases of orders that still need them (plus foreign holders and waiters for machine-scoped resources). */
export function activeLeases(project: ProjectConfig, orders: Orders, now?: Date): StoredLease[] {
  const docs = new Map(orders.all().map(d => [d.order.tag.toLowerCase(), d]));
  const local = readLeases(project)
    .filter(l => !isMachineResource(project, l.resource))
    .filter(l => {
      if (l.acceptance) return acceptanceLeaseActive(l);
      const d = docs.get(l.tag.toLowerCase());
      return !!d && leaseKept(orders, d);
    });
  if (!hasMachineResources(project)) return local;

  const store = machineStoreFor(project);
  const effectiveNow = store.effectiveNow(now);
  const { runRecoverInTx } = recoverForProject(project, effectiveNow);
  const machineNames = Object.entries(project.resources ?? {}).filter(([, r]) => r.scope === 'machine').map(([name]) => name);
  const effectiveSlots = new Map<string, number>();
  const medianMinutes = new Map<string, number | undefined>();
  const machineEntries: StoredLease[] = [];

  store.transaction(() => {
    runRecoverInTx();
    store.syncDeclaredInTx(project, effectiveNow);
    const rows = store.leasesFor(machineNames);
    const nowMs = effectiveNow.getTime();
    for (const name of machineNames) {
      const r = project.resources![name];
      const { effectiveSlots: slots } = store.declarationsOf(name, r.slots, effectiveNow);
      effectiveSlots.set(name, slots);
      const median = store.medianHoldMinutes(name);
      medianMinutes.set(name, median);
      const holdersForName: StoredLease[] = [];
      for (const row of rows.filter(x => x.resource === name)) {
        const own = row.project === project.id;
        if (own && row.kind === 'dispatch') {
          const d = docs.get(row.tag.toLowerCase());
          if (!d || !leaseKept(orders, d)) continue;
        }
        holdersForName.push({
          resource: row.resource,
          tag: row.tag,
          project: row.project,
          ...(own ? {} : { foreign: true as const }),
          ...(row.run ? { run: row.run } : {}),
          since: row.since,
          expires: row.expires,
          ...(row.kind !== 'dispatch' && row.pid !== undefined ? {
            acceptance: {
              pid: row.pid,
              ...(row.started_at ? { started_at: row.started_at } : {}),
              ...(row.unverified ? { unverified: true } : {}),
              ...(row.kind === 'nightly' ? { nightly: true } : { kind: row.kind }),
            },
          } : {}),
        });
      }
      const holdMins = holdersForName.map(h => Math.max(0, Math.round((nowMs - Date.parse(h.since)) / 60000)));
      machineEntries.push(...holdersForName);
      for (const w of store.waitersFor(name)) {
        const eta = estimateWaitMinutes(median, w.position, slots, holdMins);
        machineEntries.push({
          resource: name,
          tag: w.tag,
          project: w.project,
          ...(w.project === project.id ? {} : { foreign: true as const }),
          since: w.enqueued_at,
          expires: w.enqueued_at,
          queued: {
            position: w.position,
            priority: w.priority,
            enqueuedAt: w.enqueued_at,
            ...(eta !== undefined ? { etaMinutes: eta } : {}),
          },
        });
      }
    }
  });

  const meta: MachineMeta = { project: project.id, nowMs: effectiveNow.getTime(), effectiveSlots, medianMinutes };
  for (const entry of machineEntries) attachMachineMeta(entry, meta);
  return attachMachineMeta([...local, ...machineEntries], meta);
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
    const declared = uses.filter(name => !!project.resources?.[name]);
    const localUses = declared.filter(name => !isMachineResource(project, name));
    const machineUses = declared.filter(name => isMachineResource(project, name));

    if (machineUses.length) {
      const { store, ctx, runRecoverInTx } = recoverForProject(project, now);
      store.noteNow(now);
      const acquiredMachine = store.transaction(() => {
        runRecoverInTx();
        store.syncDeclaredInTx(project, now);
        const nowIso = now.toISOString();
        const newlyAcquired: { name: string; expires: string }[] = [];
        for (const name of machineUses) {
          const why = checkMachineTakeInTx(project, name, doc.order.tag, now);
          if (why) fail('{tag} cannot start now: {why}.', { tag: doc.order.tag, why });
        }
        for (const name of machineUses) {
          const r = project.resources![name];
          const existing = store.leasesFor([name]).find(h => h.project === project.id && h.tag.toLowerCase() === doc.order.tag.toLowerCase());
          store.removeWaiterInTx(name, project.id, doc.order.tag);
          if (existing) {
            store.touchDispatchLeaseInTx(name, project.id, existing.tag, nowIso, { ...(run ? { run } : {}), ...(ctx?.everyMinutes !== undefined ? { every_minutes: ctx.everyMinutes } : {}) });
            continue;
          }
          const expires = new Date(now.getTime() + r.lease_minutes * 60000).toISOString();
          store.upsertLeaseInTx({
            resource: name, project: project.id, state_dir: path.resolve(project.state_dir), tag: doc.order.tag,
            ...(run ? { run } : {}), since: nowIso, expires,
            ...(ctx?.everyMinutes !== undefined ? { every_minutes: ctx.everyMinutes } : {}),
            kind: 'dispatch', heartbeat_at: nowIso,
          });
          newlyAcquired.push({ name, expires });
        }
        return newlyAcquired;
      });
      for (const item of acquiredMachine) {
        orders.record(doc.order.tag, 'lease-acquired', { resource: item.name, ...(run ? { run } : {}), expires: item.expires, scope: 'machine' });
      }
    }

    if (localUses.length) {
      const all = readLeases(project);
      for (const name of localUses) {
        const r = project.resources![name];
        const have = all.find(l => l.resource === name && l.tag === doc.order.tag);
        if (have) { if (run) have.run = run; continue; }
        all.push({ resource: name, tag: doc.order.tag, ...(run ? { run } : {}), since: now.toISOString(), expires: new Date(now.getTime() + r.lease_minutes * 60000).toISOString() });
        orders.record(doc.order.tag, 'lease-acquired', { resource: name, ...(run ? { run } : {}), expires: all.at(-1)!.expires });
      }
      writeLeases(project, all);
    }
    return uses;
  });
}

function recordForeignRelease(stateDir: string, tag: string, resource: string, why: string, heldMinutes: number, now: Date): void {
  if (!existsSync(stateDir)) return;
  try {
    const foreignOrders = new Orders(stateStore(stateProject(stateDir)), () => now.toISOString(), 'cli');
    foreignOrders.record(tag, 'lease-released', { resource, why, heldMinutes, scope: 'machine' });
  } catch { /* foreign state folder unavailable */ }
}

/** Releases a machine lease of a named project directly from the machine store, without requiring that project's config file. */
export function releaseMachineLease(resource: string, tag: string, targetProject: string, why: string, now = new Date()): boolean {
  const store = existingMachineStore();
  if (!store) return false;
  store.noteNow(now);
  const out = store.transaction(() => store.removeLeaseInTx(resource, targetProject, tag, now, true));
  if (!out) return false;
  recordForeignRelease(out.removed.state_dir, out.removed.tag, resource, why, out.heldMinutes, now);
  return true;
}

/** Gives a lease back. `why` is what the event says: the run ended, the order was cancelled, or a person took it back. */
export function releaseLease(project: ProjectConfig, orders: Orders, resource: string, tag: string, why: string, now: Date, targetProject?: string): boolean {
  if (targetProject && targetProject !== project.id) {
    return releaseMachineLease(resource, tag, targetProject, why, now);
  }
  if (isMachineResource(project, resource)) {
    return stateTransaction(project, () => {
      const store = machineStoreFor(project);
      store.noteNow(now);
      const out = store.transaction(() =>
        store.removeLeaseInTx(resource, project.id, tag, now, true)
        ?? (targetProject ? undefined : store.removeUniqueLeaseByTagInTx(resource, tag, now, true)));
      if (!out) return false;
      if (out.removed.project === project.id) {
        orders.record(out.removed.tag, 'lease-released', { resource, why, heldMinutes: out.heldMinutes, scope: 'machine' });
      } else {
        recordForeignRelease(out.removed.state_dir, out.removed.tag, resource, why, out.heldMinutes, now);
      }
      return true;
    });
  }
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
 * Releases the leases of orders that no longer run or wait to be continued, and refreshes this project's machine-resource waiters.
 * Returns what it released, one line each.
 */
export function reconcileLeases(project: ProjectConfig, orders: Orders, now: Date): string[] {
  return stateTransaction(project, () => {
    const out: string[] = [];
    const allDocs = orders.all();
    const docs = new Map(allDocs.map(d => [d.order.tag.toLowerCase(), d]));
    for (const l of readLeases(project)) {
      if (acceptanceLeaseActive(l)) continue;
      const d = docs.get(l.tag.toLowerCase());
      if (d && leaseKept(orders, d)) continue;
      if (releaseLease(project, orders, l.resource, l.tag, d ? t('the order is {stage}', { stage: orders.stage(d).stage }) : t('the order is gone'), now)) {
        out.push(t('{tag}: released {resource} (the order is no longer running)', { tag: l.tag, resource: l.resource }));
      }
    }
    if (!hasMachineResources(project)) return out;

    const { store, ctx, runRecoverInTx } = recoverForProject(project, now);
    store.noteNow(now);
    const nowIso = now.toISOString();
    const merged = orders.mergedSet(allDocs);
    const sortedDocs = [...allDocs].sort((a, b) =>
      (a.order.source?.row ?? Infinity) - (b.order.source?.row ?? Infinity)
      || a.order.created.localeCompare(b.order.created)
      || a.order.tag.localeCompare(b.order.tag));

    const releasedMachine = store.transaction(() => {
      runRecoverInTx();
      store.syncDeclaredInTx(project, now);
      const released: { tag: string; resource: string; why: string; heldMinutes: number }[] = [];
      for (const row of store.projectLeases(project.id)) {
        if (row.kind !== 'dispatch') {
          store.db.prepare('UPDATE leases SET heartbeat_at = ? WHERE resource = ? AND project = ? AND tag = ?').run(nowIso, row.resource, project.id, row.tag);
          continue;
        }
        const d = docs.get(row.tag.toLowerCase());
        if (d && leaseKept(orders, d) && isMachineResource(project, row.resource)) {
          const open = d.runs.find(r => r.ended === undefined);
          const candidatePid = open?.pid ?? d.monitor?.pid;
          const candidateStarted = open ? open.process_started_at : d.monitor?.process_started_at;
          if (isPidAlive(candidatePid)) {
            store.touchDispatchLeaseInTx(row.resource, project.id, row.tag, nowIso, {
              ...(open ? { run: open.id } : {}),
              pid: candidatePid,
              started_at: candidateStarted ?? null,
              ...(ctx?.everyMinutes !== undefined ? { every_minutes: ctx.everyMinutes } : {}),
            });
          } else if (!open) {
            store.touchDispatchLeaseInTx(row.resource, project.id, row.tag, nowIso, {
              pid: null,
              started_at: null,
              ...(ctx?.everyMinutes !== undefined ? { every_minutes: ctx.everyMinutes } : {}),
            });
          } else {
            store.touchDispatchLeaseInTx(row.resource, project.id, row.tag, nowIso, {
              run: open.id,
              ...(ctx?.everyMinutes !== undefined ? { every_minutes: ctx.everyMinutes } : {}),
            });
          }
          continue;
        }
        const rem = store.removeLeaseInTx(row.resource, project.id, row.tag, now, true);
        if (rem) {
          released.push({
            tag: rem.removed.tag,
            resource: rem.removed.resource,
            why: d ? t('the order is {stage}', { stage: orders.stage(d, merged).stage }) : t('the order is gone'),
            heldMinutes: rem.heldMinutes,
          });
        }
      }
      const heldSet = new Set(store.projectLeases(project.id).map(r => `${r.resource}\0${r.tag.toLowerCase()}`));
      const wanted: { resource: string; tag: string; priority: WaiterPriority }[] = [];
      for (const d of sortedDocs) {
        if (orders.stage(d, merged).stage !== 'queued') continue;
        const prio = waiterPriority(d);
        for (const name of usesOf(project, d)) {
          if (!isMachineResource(project, name)) continue;
          if (heldSet.has(`${name}\0${d.order.tag.toLowerCase()}`)) continue;
          wanted.push({ resource: name, tag: d.order.tag, priority: prio });
        }
      }
      store.refreshProjectWaitersInTx(project.id, wanted, now);
      return released;
    });

    for (const r of releasedMachine) {
      orders.record(r.tag, 'lease-released', { resource: r.resource, why: r.why, heldMinutes: r.heldMinutes, scope: 'machine' });
      out.push(t('{tag}: released {resource} (the order is no longer running)', { tag: r.tag, resource: r.resource }));
    }
    return out;
  });
}

/** Every resource with its scope, effective slots, holders, and queue. */
export function resourceViews(project: ProjectConfig, orders: Orders, now: Date): ResourceView[] {
  const active = activeLeases(project, orders, now);
  const store = hasMachineResources(project) ? machineStoreFor(project) : undefined;
  return Object.entries(project.resources ?? {}).map(([name, r]) => {
    const scope = r.scope ?? 'project';
    const decl = scope === 'machine' && store ? store.declarationsOf(name, r.slots, now) : undefined;
    const slots = decl ? decl.effectiveSlots : r.slots;
    const leases: Lease[] = active.filter(l => !l.queued && l.resource === name).map(l => ({
      resource: name,
      project: l.project ?? project.id,
      tag: l.tag,
      ...(l.run ? { run: l.run } : {}),
      since: l.since,
      expires: l.expires,
      expired: now.getTime() > Date.parse(l.expires),
      heldMinutes: Math.max(0, Math.round((now.getTime() - Date.parse(l.since)) / 60000)),
    }));
    const queue: ResourceQueueEntry[] = scope === 'machine'
      ? active
          .filter(l => l.queued && l.resource === name)
          .sort((a, b) => a.queued!.position - b.queued!.position)
          .map(l => ({
            project: l.project ?? project.id,
            tag: l.tag,
            priority: l.queued!.priority,
            enqueuedAt: l.queued!.enqueuedAt ?? l.since,
            position: l.queued!.position,
            ...(l.queued!.etaMinutes !== undefined ? { etaMinutes: l.queued!.etaMinutes } : {}),
          }))
      : [];
    return {
      name,
      scope,
      slots,
      ...(decl?.mismatch ? { slotMismatch: decl.mismatch } : {}),
      used: leases.length,
      ...(r.note ? { note: r.note } : {}),
      exclusive: r.exclusive,
      blocks: r.exclusive ? r.blocks : [],
      leases,
      queue,
    };
  });
}
