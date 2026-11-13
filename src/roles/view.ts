import { readFileSync } from 'node:fs';
import type { ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { UsageRow } from '../usage/types.ts';
import type { WorkersFile } from '../workers/config.ts';
import { chooseWorker, type Choosable, type Candidate } from '../routing/choose.ts';
import { effectiveRoles, groupMembers, type RoleConfig } from './config.ts';
import { roleResults, type RoleWorkerResult } from './statistics.ts';

export interface RoleView extends RoleConfig { id: string; results: RoleWorkerResult[]; candidates: Candidate[]; qualifying: string[]; rulesText?: string; rulesProblem?: string }
/** A worker group: its own list, the workers it comes to in order (named groups expanded) and the routes that draw on it. */
export interface GroupView { name: string; list: string[]; members: string[]; routes: string[]; source: 'project' | 'workers' }
export interface RolesView { roles: RoleView[]; groups: GroupView[] }
/** Current availability is supplied by the caller's quota snapshot, never probed once per role. */
export function rolesView(project: ProjectConfig, workers?: WorkersFile, docs: readonly OrderDoc[] = [], usage: readonly UsageRow[] = [], states?: readonly Choosable[]): RolesView {
  const results = roleResults(docs, usage);
  const pool = states ?? (workers?.workers ?? []).map(config => ({ config, available: config.enabled && !config.quota, reasons: config.quota ? ['quota not checked'] : [], running: 0, runsToday: 0, startable: !!config.launch || config.card_only }));
  const effective = effectiveRoles(project, workers);
  const all = { ...workers?.worker_groups, ...project.worker_groups };
  const groups: GroupView[] = Object.entries(all).map(([name, list]) => ({ name, list, members: groupMembers(all, name, `group ${name}`), routes: Object.entries(effective).filter(([, r]) => r.group === name).map(([id]) => id), source: project.worker_groups && Object.hasOwn(project.worker_groups, name) ? 'project' : 'workers' }));
  return { groups, roles: Object.entries(effective).map(([id, role]) => {
    const candidates = chooseWorker({ kind: '', tags: [], role: { id, requires: role.requires, ...role.workers, ...(role.group ? { group: role.group } : {}) } }, pool).candidates;
    let rulesText: string | undefined, rulesProblem: string | undefined;
    if (role.rules) { try { rulesText = readFileSync(role.rules, 'utf8'); } catch { rulesProblem = 'Rules file cannot be read'; } }
    return { id, ...role, results: results.filter(r => r.role === id), candidates, qualifying: candidates.filter(c => c.verdict === 'chosen' || c.verdict === 'passed-over').map(c => c.worker), ...(rulesText !== undefined ? { rulesText } : {}), ...(rulesProblem ? { rulesProblem } : {}) };
  }) };
}
