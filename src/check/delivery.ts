import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ChecksConfig, ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import { parseReportFile } from '../orders/report.ts';
import { baseRefOf } from '../run/worktree.ts';
import { findOrderFile } from '../run/prompt.ts';
import { parseOrderSections } from '../verify/verify.ts';
import { changedFiles, globToRegExp, type CheckItem } from './general.ts';

export const hasDeliveryChecks = (c: ChecksConfig): boolean => !!(c.report_required || c.revision_is_head || c.base_merged || c.generated_paths?.length || c.evidence_required || c.report_must_match?.length || c.report_must_not_match?.length);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function expandTag(text: string, tag: string, regex = false): string {
  return text.replace(/\{(tag|tag_lower)\}/g, (_, key) => {
    const value = key === 'tag_lower' ? tag.toLowerCase() : tag;
    return regex ? escapeRegex(value) : value;
  });
}

/** Walk only the fixed prefix of a glob; never follow directory symlinks or scan dependency caches. */
function worktreeMatches(root: string, glob: string): boolean {
  if (!/[*?]/.test(glob)) { const file = path.resolve(root, glob); return existsSync(file) && statSync(file).isFile(); }
  const normalized = glob.replace(/\\/g, '/');
  const prefix = normalized.slice(0, normalized.search(/[*?]/));
  const base = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  const matches = globToRegExp(normalized);
  const walk = (relative: string): boolean => {
    const dir = path.resolve(root, relative);
    if (!existsSync(dir)) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isFile() && matches.test(file)) return true;
      if (entry.isDirectory() && !['.git', 'node_modules', 'Intermediate', 'DerivedDataCache'].includes(entry.name) && walk(file)) return true;
    }
    return false;
  };
  return walk(base);
}

/** Optional checks, shared by the delivery gate and the explicit check command. */
export function deliveryChecks(project: ProjectConfig, doc: OrderDoc, worktree: string): CheckItem[] {
  const cfg = project.checks;
  if (!hasDeliveryChecks(cfg)) return [];
  const items: CheckItem[] = [];
  const report = [...doc.reports].sort((a, b) => b.seq - a.seq)[0];
  const run = report?.run ? doc.runs.find(r => r.id === report.run) : doc.runs.at(-1);
  const files = [run?.last_file, report?.from && path.resolve(project.work_orders, report.from), path.join(project.work_orders, `${doc.order.tag}.last.txt`)];
  let last = report?.delivery_text ?? '', file = report?.from ?? '';
  for (const candidate of last ? [] : files) if (candidate && existsSync(candidate)) { last = readFileSync(candidate, 'utf8'); file = candidate; break; }
  const add = (name: string, check: () => { ok: boolean; detail: string }) => {
    try { items.push({ name, ...check() }); }
    catch (e) { items.push({ name, ok: false, detail: `${(e as Error).message.split('\n')[0]}; repair the delivery and rerun alba check.` }); }
  };
  if (cfg.report_required) add('report_required', () => {
    if (!last) return { ok: false, detail: 'No final report file found; write a valid final report block.' };
    if (!/\.json$/i.test(file) && !/--- end ---\s*$/.test(last)) return { ok: false, detail: 'The final message does not end with a report block; print a complete valid report block at the end.' };
    parseReportFile(file, last);
    return { ok: !report?.source, detail: report?.source ? 'Delivery was inferred; write a valid final report block.' : 'Final report parses.' };
  });
  if (cfg.revision_is_head) add('revision_is_head', () => {
    const head = git(worktree, ['rev-parse', 'HEAD']);
    const revision = report?.revision;
    const resolved = revision && /^[0-9a-f]{7,40}$/i.test(revision) ? git(worktree, ['rev-parse', '--verify', `${revision}^{commit}`]) : undefined;
    return { ok: !!resolved && resolved === head, detail: resolved === head ? `Revision ${head} is HEAD.` : `Reported revision ${revision ?? '(missing)'}; branch HEAD ${head}. Report the current HEAD revision.` };
  });
  const base = baseRefOf(project);
  if (cfg.base_merged) add('base_merged', () => {
    const max = typeof cfg.base_merged === 'object' ? cfg.base_merged.max_behind : 0;
    const behind = Number(git(worktree, ['rev-list', '--count', `HEAD..${base}`]));
    return { ok: behind <= max, detail: `${behind} base commit(s) behind ${base}, allowed ${max}.${behind > max ? ' Merge the base branch into this branch and resolve conflicts.' : ''}` };
  });
  if (cfg.generated_paths?.length) add('generated_paths', () => {
    const hit = changedFiles(worktree, base).filter(f => cfg.generated_paths!.some(g => globToRegExp(g).test(f.path))).map(f => f.path);
    return { ok: !hit.length, detail: hit.length ? `Changed generated files: ${hit.join(', ')}. Restore these paths from the merge base; do not commit build-regenerated data.` : 'Generated paths are unchanged against the merge base.' };
  });
  if (cfg.evidence_required) add('evidence_required', () => {
    const orderFile = findOrderFile(project.work_orders, doc.order.tag);
    const required = parseOrderSections(readFileSync(orderFile, 'utf8')).evidence.map(e => expandTag(e.path.replace(/^`|`$/g, ''), doc.order.tag));
    const branchFiles = required.length ? git(worktree, ['ls-tree', '-r', '--name-only', 'HEAD']).split(/\r?\n/) : [];
    const missing = required.filter(g => !branchFiles.some(f => globToRegExp(g).test(f)) && !worktreeMatches(worktree, g));
    return { ok: !missing.length, detail: missing.length ? `Missing required evidence: ${missing.join(', ')}. Create these files in this order's branch or worktree.` : 'All declared evidence paths exist.' };
  });
  const { delivery_text: _raw, ...structured } = report ?? {};
  const text = `${JSON.stringify(structured)}\n${last}`;
  for (const key of ['report_must_match', 'report_must_not_match'] as const) {
    for (const [i, rule] of (cfg[key] ?? []).entries()) add(`${key}[${i}]`, () => {
      const pattern = expandTag(rule.pattern, doc.order.tag, true);
      const matched = new RegExp(pattern, 'm').test(text);
      const ok = key === 'report_must_match' ? matched : !matched;
      return { ok, detail: ok ? `Pattern /${pattern}/ ${matched ? 'matched' : 'absent'}.` : `Pattern /${pattern}/ ${matched ? 'matched forbidden text' : 'did not match'}. ${expandTag(rule.message, doc.order.tag)}` };
    });
  }
  return items;
}
