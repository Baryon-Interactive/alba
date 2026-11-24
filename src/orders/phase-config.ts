import { fail } from '../i18n.ts';
import { chooseWorker, rolePolicy } from '../routing/choose.ts';
import { effectiveRoles, resolveRole } from '../roles/config.ts';
import type { ProjectConfig } from '../config.ts';
import type { WorkersFile } from '../workers/config.ts';

export interface Phase {
  id: string;
  mode: 'read-only' | 'write';
  role?: string;
  timeout_minutes?: number;
}
export type Phases = Record<string, Phase[]>;

export function parsePhases(raw: unknown): Phases {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('phases must map order kinds to phase lists.');
  const result: Phases = Object.create(null);
  for (const [kind, list] of Object.entries(raw)) {
    if (!kind.trim() || !Array.isArray(list) || list.length < 2) throw new Error(`phases.${kind} needs read-only phases followed by one write phase.`);
    const seen = new Set<string>();
    result[kind] = list.map((p, index) => {
      if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['id', 'mode', 'role', 'timeout_minutes'].includes(k))
        || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(p.id) || seen.has(p.id)
        || p.mode !== (index === list.length - 1 ? 'write' : 'read-only')
        || (p.role !== undefined && (typeof p.role !== 'string' || !p.role.trim()))
        || (p.timeout_minutes !== undefined && (!Number.isFinite(p.timeout_minutes) || p.timeout_minutes <= 0))) {
        throw new Error(`Invalid phase at phases.${kind}[${index}]. Check its unique id, mode, role and timeout.`);
      }
      seen.add(p.id);
      return { ...p };
    });
  }
  return result;
}

export function validatePhaseWorkers(project: ProjectConfig, workers: WorkersFile): void {
  const roles = effectiveRoles(project, workers);
  for (const [kind, phases] of Object.entries(project.phases ?? {})) for (const phase of phases) {
    const role = rolePolicy(resolveRole(roles, { kind, role: phase.role }));
    if (phase.mode !== 'read-only') continue;
    const candidates = workers.workers.map(config => ({ config, available: true, running: 0, runsToday: 0, reasons: [] }));
    const choice = chooseWorker({ kind, tags: [], role: role && { ...role, readOnly: true } }, candidates);
    if (!choice.candidates.some(c => c.verdict !== 'unfit')) throw new Error(`phases.${kind}.${phase.id} has no worker with an enforced read-only launch for its role.`);
  }
}

export function phasesOverride(value: unknown): 'none' | undefined {
  if (value === undefined || value === 'none') return value;
  return fail('Order phases must be none.');
}
