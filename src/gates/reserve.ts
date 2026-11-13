import os from 'node:os';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { stateTransaction, writeStateFile } from '../orders/state-files.ts';
import { activeLeases, kindOfOrder, leaseProcessIdentity, occupants, readLeases, startBlocked } from '../resources/leases.ts';
import type { NightlyGate } from './config.ts';
import { yieldDecision } from './priority.ts';

export const LOCK = 'nightly:run';
export const tagFor = (name: string) => `nightly:gate:${name}`;
const write = (project: ProjectConfig, leases: unknown[]) => writeStateFile(project, '_leases.json', JSON.stringify({ leases }));

export interface ReserveOptions { now: Date; freeRamGb?: () => number | undefined; ordersFirst?: boolean | (() => boolean) }

/** Why the gate cannot start now; reads only. Callbacks that gather work run here, never under the transaction in `reserve`. */
export function blockedReason(project: ProjectConfig, orders: Orders, gate: NightlyGate, options: ReserveOptions): { reason?: string; capped?: string } {
  const decision = yieldDecision(project, orders, { name: gate.name, uses: gate.uses, kind: gate.kind }, options.now, options.ordersFirst);
  if (decision.reason) return decision;
  const minimum = project.dispatch.min_free_ram_gb, ram = (options.freeRamGb ?? (() => os.freemem() / 2 ** 30))();
  if (minimum !== undefined && (ram === undefined || ram < minimum)) return { ...decision, reason: 'Free memory is below the minimum or unavailable.' };
  const leases = activeLeases(project, orders), running = occupants(project, orders), tag = tagFor(gate.name);
  if (leases.some(l => l.tag === tag)) return { ...decision, reason: `Gate ${gate.name} is still stopping a previous run.` };
  const held = leases.find(l => gate.uses?.includes(l.resource));
  if (held) return { ...decision, reason: `Resource ${held.resource} is held by ${held.acceptance ? 'job' : 'order'} ${held.tag}.` };
  if (gate.kind) {
    const count = orders.all().filter(d => d.runs.some(r => !r.ended) || ['running', 'monitoring'].includes(orders.stage(d).stage))
      .filter(d => kindOfOrder(project, d) === gate.kind || d.order.heavy === gate.kind).length + leases.filter(l => l.acceptance?.cap === gate.kind).length;
    if (count >= project.dispatch.caps[gate.kind]) return { ...decision, reason: `Kind cap ${gate.kind} is full (${count}/${project.dispatch.caps[gate.kind]}).` };
  }
  const reason = startBlocked(project.resources ?? {}, leases, running, { tag, kind: gate.kind ?? 'nightly', uses: gate.uses ?? [] });
  return reason ? { ...decision, reason } : decision;
}

/** Takes the gate's leases, rechecking everything inside the same transaction as dispatch. */
export function reserve(project: ProjectConfig, orders: Orders, gate: NightlyGate, options: ReserveOptions): { reason?: string; capped?: string } {
  const early = blockedReason(project, orders, gate, options);
  if (early.reason) return early;
  const reason = stateTransaction(project, () => {
    // Only state that other processes can change is checked again; the callbacks above are not repeated.
    const leases = activeLeases(project, orders), running = occupants(project, orders), tag = tagFor(gate.name);
    const held = leases.find(l => l.tag === tag || gate.uses?.includes(l.resource));
    if (held) return `Resource ${held.resource} is held by ${held.acceptance ? 'job' : 'order'} ${held.tag}.`;
    if (gate.kind) {
      const count = orders.all().filter(d => d.runs.some(r => !r.ended) || ['running', 'monitoring'].includes(orders.stage(d).stage))
        .filter(d => kindOfOrder(project, d) === gate.kind || d.order.heavy === gate.kind).length + leases.filter(l => l.acceptance?.cap === gate.kind).length;
      if (count >= project.dispatch.caps[gate.kind]) return `Kind cap ${gate.kind} is full (${count}/${project.dispatch.caps[gate.kind]}).`;
    }
    const blocked = startBlocked(project.resources ?? {}, leases, running, { tag, kind: gate.kind ?? 'nightly', uses: gate.uses ?? [] });
    if (blocked) return blocked;
    const all = readLeases(project), since = new Date().toISOString();
    for (const [i, resource] of [...new Set([tag, ...(gate.uses ?? [])])].entries()) all.push({ resource, tag, since,
      expires: new Date(Date.now() + gate.timeout_minutes * 60000 + 120000).toISOString(), acceptance: { ...leaseProcessIdentity(), nightly: true, kind: gate.kind, ...(i === 0 && gate.kind ? { cap: gate.kind } : {}) } });
    write(project, all);
    return undefined;
  });
  return { ...early, ...(reason ? { reason } : {}) };
}

/** Gives back our leases, or any nightly owner's leases after its tree is confirmed gone. */
export function release(project: ProjectConfig, tag: string, confirmedGone = false): void {
  stateTransaction(project, () => write(project, readLeases(project).filter(l => !(l.tag === tag && (l.acceptance?.pid === process.pid || (confirmedGone && l.acceptance?.nightly))))));
}

/** Keeps a tag's leases alive for another while, for a tree that could not be confirmed gone. */
export function extend(project: ProjectConfig, tag: string, untilMs: number): void {
  stateTransaction(project, () => write(project, readLeases(project).map(l => l.tag === tag && l.acceptance?.pid === process.pid ? { ...l, expires: new Date(Math.max(Date.parse(l.expires), untilMs)).toISOString() } : l)));
}
