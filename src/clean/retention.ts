import { existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import type { CleanItem, CleanPlan } from '../api/types.ts';
import type { OrderDoc } from '../orders/model.ts';
import { linkedAncestor, safePackageRoot } from './safety.ts';

/** The longest exact tag or tag-plus-separator prefix owns an artifact folder. */
export function artifactOwner(name: string, docs: OrderDoc[]): OrderDoc | undefined {
  const n = name.toLowerCase();
  return docs.filter(d => { const tag = d.order.tag.toLowerCase(); return n === tag || n.startsWith(tag + '-') || n.startsWith(tag + '_'); })
    .sort((a, b) => b.order.tag.length - a.order.tag.length)[0];
}

export function driveFacts(project: ProjectConfig, read = (dir: string) => { const s = statfsSync(dir); return s.bavail * s.bsize / 2 ** 30; }): NonNullable<CleanPlan['drives']> {
  return (project.clean?.drives ?? []).map(d => {
    try { const free_gb = read(path.resolve(project.root, d.path)); return { ...d, free_gb, low: free_gb < d.min_free_gb }; }
    catch (error) { return { ...d, low: false, error: (error as Error).message }; }
  });
}

export function retentionItems(project: ProjectConfig, orders: Orders, now: number): CleanItem[] {
  const items: CleanItem[] = [], docs = orders.all(), merged = orders.mergedSet(docs);
  for (const rule of project.clean?.packages ?? []) {
    const dir = path.resolve(project.root, rule.dir);
    if (!existsSync(dir) || !safePackageRoot(dir, project.root)) continue;
    const entries = readdirSync(dir).map(name => ({ name, full: path.join(dir, name), st: lstatSync(path.join(dir, name)) }))
      .filter(e => (e.st.isDirectory() || e.st.isSymbolicLink()) && (!rule.prefix || e.name.toLowerCase().startsWith(rule.prefix.toLowerCase()))).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs || b.name.localeCompare(a.name));
    entries.forEach((e, index) => {
      // Package folder names must be an order tag, or begin with tag + a separator (after the rule's prefix, if any).
      const doc = artifactOwner(rule.prefix ? e.name.slice(rule.prefix.length) : e.name, docs);
      const keep = index < rule.keep || !doc || !merged.has(doc.order.tag) || orders.stage(doc).stage === 'awaiting-review';
      items.push({ kind: 'package', pathClass: 'packages', path: e.full, ...(doc ? { tag: doc.order.tag } : {}), targets: [], links: 0, action: keep ? 'keep' : 'delete',
        reason: index < rule.keep ? `One of the newest ${rule.keep} packages.` : !doc ? 'Package owner is unknown; keep it.' : keep ? 'Order is not merged or awaits review.' : 'Older package of a merged order.' });
    });
  }
  const days = project.clean?.logs_days;
  const dir = path.join(project.state_dir, 'runs');
  if (days !== undefined && existsSync(dir) && !linkedAncestor(path.join(dir, '_'))) for (const name of readdirSync(dir)) {
    if (!/\.(?:log|events\.jsonl)$/i.test(name)) continue;
    const full = path.join(dir, name), st = lstatSync(full);
    if (!st.isFile() || now - st.mtimeMs < days * 86400000) continue;
    const run = docs.flatMap(d => d.runs).find(r => r.log && path.resolve(r.log) === full || r.events_file && path.resolve(r.events_file) === full);
    items.push({ kind: 'log', pathClass: 'logs', path: full, targets: [], links: 0, bytes: st.size, action: run && !run.ended ? 'keep' : 'delete', reason: run && !run.ended ? 'Run is still open.' : `Run log older than ${days} days.` });
  }
  return items;
}
