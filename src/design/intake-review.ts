import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { applyChangeSet, readChangeSet } from './library.ts';
import { intakeOutputDir } from './docs.ts';
import { DesignError } from './model.ts';

export interface IntakeReviewInput {
  accept?: string[];
  reject?: string[];
  drop?: string[];
  note?: string;
}

export function reviewIntakeSystems(project: ProjectConfig, orders: Orders, tag: string, input: IntakeReviewInput): { system: string; status: string; note?: string; result?: unknown }[] {
  const note = input.note?.trim() ?? '';
  const accepted = [...new Set((input.accept ?? []).map(String).map(value => value.trim()).filter(Boolean))];
  const rejected = [...new Set((input.reject ?? []).map(String).map(value => value.trim()).filter(Boolean))];
  const dropped = [...new Set((input.drop ?? []).map(String).map(value => value.trim()).filter(Boolean))];
  if ((rejected.length || dropped.length) && !note) throw new DesignError('Rejecting or dropping an intake system needs a non-empty note.');
  const overlap = accepted.filter(system => rejected.includes(system) || dropped.includes(system)).concat(rejected.filter(system => dropped.includes(system)));
  if (overlap.length) throw new DesignError(`An intake system cannot be accepted, rejected and dropped together: ${[...new Set(overlap)].join(', ')}`);
  const root = intakeOutputDir(project, orders, tag), changesDir = path.join(root, '.alba', 'design', 'changes'), events: { system: string; status: string; note?: string; result?: unknown }[] = [];
  const available = new Set(existsSync(changesDir) ? readdirSync(changesDir).filter(file => /^intake-.+\.json$/i.test(file)).map(file => file.replace(/^intake-/i, '').replace(/\.json$/i, '')) : []);
  const requested = [...new Set([...accepted, ...rejected, ...dropped])];
  const unknown = requested.filter(system => !available.has(system));
  if (unknown.length) throw new DesignError(`No intake change set for ${unknown.join(', ')}.`, 404);
  for (const system of accepted) {
    const file = path.join(changesDir, `intake-${system}.json`);
    if (!existsSync(file)) throw new DesignError(`No intake change set for ${system}.`, 404);
    const result = applyChangeSet(project, orders, readChangeSet(file), { by: 'accept', order: tag, idempotent: true });
    orders.store.appendEvent({ at: new Date().toISOString(), tag, type: 'intake-system-accepted', by: orders.actor, data: { system, source: 'intake' } });
    events.push({ system, status: 'accepted', result });
  }
  if (rejected.length) {
    const details = rejected.map(system => `${system}: ${note}`).join('; ');
    const reworkNote = `Intake systems returned for rework: ${details}. Only these systems need rework; accepted systems remain unchanged.`;
    orders.act(tag, 'rework', { note: reworkNote });
    for (const system of rejected) { orders.store.appendEvent({ at: new Date().toISOString(), tag, type: 'intake-system-rejected', by: orders.actor, data: { system, note } }); events.push({ system, status: 'rejected', note }); }
  }
  for (const system of dropped) { orders.store.appendEvent({ at: new Date().toISOString(), tag, type: 'intake-system-dropped', by: orders.actor, data: { system, note } }); events.push({ system, status: 'dropped', note }); }
  return events;
}

