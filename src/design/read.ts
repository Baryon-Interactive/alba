import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { globToRegExp } from '../check/general.ts';
import { readLedger } from '../ledger/decisions.ts';
import { baseRefOf } from '../run/worktree.ts';
import { codeRefError, JsonDataCache, dataFiles, numericLeaves, outsideRange, resolveParam, typeMatches } from './files.ts';
import { appliedChangeSet, designHistory, readChangeSet, readLibrary, resolvedValues } from './library.ts';
import { DESIGN_KINDS, DesignError, entityId, type DesignKind, type Entity, type Issue, type Target } from './model.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
/** Find the first base commit containing a delivery, including manual squash-free merges and fast forwards. */
export function mergedPaths(project: ProjectConfig, branch: string, options: { branchOnly?: boolean; diffFilter?: string } = {}): string[] {
  const diff = (before: string, after: string) => {
    if (options.branchOnly) { before = git(project.root, 'merge-base', before, branch); after = branch; }
    return git(project.root, 'diff', '--name-only', '--no-renames', '-z', ...(options.diffFilter ? [`--diff-filter=${options.diffFilter}`] : []), before, after).split('\0').filter(Boolean);
  };
  const commits = git(project.root, 'rev-list', '--first-parent', '--reverse', baseRefOf(project)).split('\n').filter(Boolean);
  const contains = (sha: string) => { try { git(project.root, 'merge-base', '--is-ancestor', branch, sha); return true; } catch { return false; } };
  let low = 0, high = commits.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (contains(commits[middle])) high = middle; else low = middle + 1; }
  if (low === commits.length) throw new DesignError(`Delivery branch is not merged: ${branch}`);
  const parents = git(project.root, 'show', '-s', '--format=%P', commits[low]).split(' ').filter(Boolean);
  // A branch already at the initial base commit introduces no delivery changes.
  if (!parents.length && options.branchOnly) return [];
  if (parents.length < 2) {
    // A fast forward has no integration parent. The base reflog retains its previous tip.
    const tips = git(project.root, 'reflog', 'show', '--format=%H', baseRefOf(project)).split('\n').filter(Boolean).reverse();
    const index = tips.findIndex(contains);
    if (index < 1) throw new DesignError(`Changed paths are unknown for fast-forward delivery ${branch}; approval needs a recorded trial or base reflog.`);
    return diff(tips[index - 1], tips[index]);
  }
  return diff(parents[0], commits[low]);
}
export function staleSystems(project: ProjectConfig, orders: Orders, library = readLibrary(project)): { system: string; orders: string[]; unknown_orders: string[] }[] {
  const merged = orders.all().filter(d => orders.stage(d).stage === 'merged');
  const events = orders.store.events();
  const paths = new Map<string, string[] | undefined>();
  const changed = (tag: string, branch?: string): string[] | undefined => {
    if (paths.has(tag)) return paths.get(tag);
    const recorded = events.filter(e => e.tag === tag && (e.type === 'design-accepted-tree' || e.type === 'accept-trial' || e.type === 'accept-merged')).reverse().find(e => Array.isArray(e.data?.changed));
    let found = recorded?.data?.changed as string[] | undefined;
    if (!found && branch) { try { found = mergedPaths(project, branch); } catch { /* visibly unknown below */ } }
    paths.set(tag, found); return found;
  };
  return library.system.flatMap(s => {
    const tags: string[] = [], unknown: string[] = [], globs = s.code_globs.map(globToRegExp);
    for (const d of merged) {
      const at = d.actions.filter(a => a.kind === 'approve').at(-1)?.at ?? d.order.updated;
      if (s.verified_at && Date.parse(at) <= Date.parse(s.verified_at)) continue;
      if (!globs.length) continue;
      const files = changed(d.order.tag, d.order.branch);
      if (files === undefined) unknown.push(d.order.tag);
      else if (files.some(f => globs.some(re => re.test(f)))) tags.push(d.order.tag);
    }
    return tags.length || unknown.length ? [{ system: s.code, orders: tags, unknown_orders: unknown }] : [];
  });
}
export function showDesign(project: ProjectConfig, id: string): unknown {
  const library = readLibrary(project), found = DESIGN_KINDS.flatMap(kind => library[kind].filter(row => entityId(kind, row) === id).map(row => ({ kind, row })));
  if (!found.length) throw new DesignError(`No design entity ${id}.`, 404);
  if (found.length > 1) throw new DesignError(`Ambiguous design entity ${id}; use search and a kind filter.`, 409);
  const { kind, row } = found[0];
  const values = resolvedValues(project, library), resolve = (entity: Entity) => ({ ...entity, ...values.find(v => v.id === entityId('param', entity)) });
  if (kind === 'param') return resolve(row);
  if (kind !== 'system') return row;
  const linked = library.decision_link.filter(link => link.entity === id || DESIGN_KINDS.some(k => library[k].some(e => entityId(k, e) === link.entity && 'system' in e && e.system === id)));
  const ledger = project.decisions ? readLedger(project.decisions) : [];
  const decisionIds = new Set(linked.map(link => link.decision));
  for (const r of library.rule.filter(r => r.system === id)) for (const s of r.sources) if (s.kind === 'decision') decisionIds.add(s.ref);
  for (const p of library.param.filter(p => p.system === id && p.source === 'decision')) decisionIds.add(p.source_ref);
  return { ...row, rules: library.rule.filter(r => r.system === id), formulas: library.formula.filter(r => r.system === id), params: library.param.filter(r => r.system === id).map(resolve), targets: library.target.filter(r => r.system === id), gaps: library.gap.filter(r => r.system === id), terms: library.term.filter(r => r.system === id), decision_links: linked, decisions: ledger.filter(d => decisionIds.has(d.id)) };
}
export function searchDesign(project: ProjectConfig, text: string): { kind: DesignKind; entity: Entity }[] {
  const library = readLibrary(project), q = text.toLowerCase();
  return DESIGN_KINDS.flatMap(kind => library[kind].filter(row => JSON.stringify(row).toLowerCase().includes(q)).map(entity => ({ kind, entity })));
}
export const targetStatus = (target: Target): 'unmeasured' | 'failing' | 'passing' => target.last_value === null ? 'unmeasured' : outsideRange(target.last_value, target.min, target.max) ? 'failing' : 'passing';
export const DESIGN_QUERIES = ['open-gaps-without-order', 'failing-targets', 'unmeasured-targets', 'milestone', 'stale-systems'] as const;
export function readDesign(project: ProjectConfig, orders: Orders, filters: { system?: string; kind?: string; query?: string } = {}): unknown {
  const library = readLibrary(project);
  if (filters.kind && !DESIGN_KINDS.includes(filters.kind as DesignKind)) throw new DesignError(`Unknown design kind ${filters.kind}.`);
  if (filters.system && !library.system.some(s => s.code === filters.system)) throw new DesignError(`No design system ${filters.system}.`, 404);
  if (filters.query && !(DESIGN_QUERIES as readonly string[]).includes(filters.query)) throw new DesignError(`Unknown design query ${filters.query}.`);
  const belongs = (e: Entity): boolean => {
    if (!filters.system) return true;
    if ('system' in e) return e.system === filters.system;
    if ('code' in e) return e.code === filters.system;
    if ('entity' in e) return library[e.kind].some(row => entityId(e.kind, row) === e.entity && belongs(row));
    return false;
  };
  if (filters.query === 'open-gaps-without-order') return library.gap.filter(g => belongs(g) && g.status === 'open' && !g.order);
  if (filters.query === 'failing-targets' || filters.query === 'unmeasured-targets') return library.target.filter(t => belongs(t) && targetStatus(t) === (filters.query === 'failing-targets' ? 'failing' : 'unmeasured'));
  if (filters.query === 'stale-systems') return staleSystems(project, orders, library).filter(s => !filters.system || s.system === filters.system);
  if (filters.query === 'milestone') {
    const active = library.milestone.find(m => m.status === 'active');
    return active ? { ...active, criteria: active.criteria.map(c => 'text' in c ? { ...c, status: 'manual' } : { ...c, status: targetStatus(library.target.find(t => t.id === c.target)!) }) } : null;
  }
  const values = new Map(resolvedValues(project, library).map(v => [v.id, v]));
  return DESIGN_KINDS.filter(k => !filters.kind || k === filters.kind).flatMap(kind => library[kind].filter(belongs).map(row => ({ kind, ...row, ...(kind === 'param' ? values.get(entityId(kind, row)) : {}) })));
}
export function checkDesign(project: ProjectConfig, orders: Orders): { ok: boolean; issues: Issue[] } {
  const library = readLibrary(project), issues: Issue[] = [], cache = new JsonDataCache();
  const add = (severity: Issue['severity'], code: string, entity: string, message: string, count?: number) => issues.push({ severity, code, entity, message, ...(count === undefined ? {} : { count }) });
  const registered = new Set(library.param.map(p => `${p.location.file}#${p.location.pointer}`));
  const proposals = path.join(project.root, '.alba/design/changes'), history = designHistory(project);
  if (existsSync(proposals)) for (const entry of readdirSync(proposals, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = `.alba/design/changes/${entry.name}`;
    try {
      if (!appliedChangeSet(readChangeSet(path.join(proposals, entry.name)), history)) add('warning', 'unapplied-changeset', file, `Change set has not been applied; run alba design apply ${file} [--order TAG].`);
    } catch (e) { add('warning', 'unapplied-changeset', file, `Cannot read change set: ${(e as Error).message}. Check it, then run alba design apply ${file}.`); }
  }
  for (const file of dataFiles(project.root, project.design!.data_roots)) {
    try {
      const missing = numericLeaves(cache.read(project.root, file)).filter(p => !registered.has(`${file}#${p}`));
      if (missing.length) add('warning', 'unregistered-numbers', file, `${missing.length} numeric leaves have no parameter: ${missing.join(', ')}`, missing.length);
    } catch (e) { add('error', 'data-json', file, (e as Error).message); }
  }
  for (const p of library.param) {
    try { const value = resolveParam(project.root, p, cache); if (!typeMatches(p.type, value)) add('error', 'param-type', p.id, `Live value does not match ${p.type}.`); else if (outsideRange(value, p.range_min, p.range_max)) add('warning', 'param-range', p.id, 'Live value is outside range.'); }
    catch (e) { add('warning', 'param-unresolved', p.id, (e as Error).message); }
  }
  for (const f of library.formula) for (const code of f.code_refs) {
    const error = codeRefError(project.root, code);
    if (error) add('warning', 'code-ref-stale', f.id, error);
  }
  for (const s of library.system) {
    const targets = library.target.filter(t => t.system === s.code).length;
    if (targets < project.design!.min_targets_per_system) add('warning', 'few-targets', s.code, `${targets} targets; minimum ${project.design!.min_targets_per_system}.`);
    if (!library.rule.some(r => r.system === s.code && r.status === 'active')) add('warning', 'no-rules', s.code, 'No active rules.');
  }
  for (const r of library.rule) if (r.implementation !== 'none' && !r.evidence.length) add('error', 'rule-evidence', r.id, 'Implemented rule has no evidence.');
  for (const g of library.gap) if (g.status === 'open' && !g.order) add('warning', 'unowned-gap', g.id, 'Open gap has no order.');
  for (const s of staleSystems(project, orders, library)) {
    if (s.orders.length) add('warning', 'stale-system', s.system, `Merged orders touched code after verification: ${s.orders.join(', ')}.`);
    if (s.unknown_orders.length) add('warning', 'stale-unknown', s.system, `Cannot determine changed paths for merged orders: ${s.unknown_orders.join(', ')}.`);
  }
  return { ok: !issues.some(i => i.severity === 'error'), issues };
}
