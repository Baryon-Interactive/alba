import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { planWorktree } from '../run/worktree.ts';
import { systemGit } from '../sync/git.ts';
import { findWorktree } from '../tick/gather.ts';
import { deliveryChecks } from './delivery.ts';
import { generalChecks, type CheckItem } from './general.ts';
import { compare, loadRefs, mergeResults, parseResults, type RefRow } from './refs.ts';

export interface CheckReport {
  tag: string;
  worktree: string;
  base: string;
  general: CheckItem[];
  lint?: CheckItem[];
  refs?: { file: string; results: string[]; rows: RefRow[] };
  /** 0 everything passed, 1 something differs or is missing or a general item failed. (A configuration error is an exception, exit 2.) */
  exitCode: 0 | 1;
}

/**
 * The checks to run before a person accepts an order: the general ones on the worktree, and the comparison of result files
 * with the reference values. Records one event on the order with what was found.
 */
export function runCheck(project: ProjectConfig, orders: Orders, tag: string, results: string[], worktreeOverride?: string, options: { delivery?: boolean } = {}): CheckReport {
  const doc = orders.get(tag);
  const cfg = project.checks;
  if (results.length && (!cfg.references || !cfg.result_parser)) fail('{file}: "checks.references" and "checks.result_parser" are needed to compare result files.', { file: project.file });
  const worktree = worktreeOverride ?? doc.order.worktree ?? findWorktree(doc.order.tag, systemGit.worktrees(project.root));
  if (!worktree) fail('No worktree found for {tag}. Give the order a worktree, name a branch folder that contains the tag, or pass --worktree <folder>.', { tag: doc.order.tag });
  const baseRef = planWorktree(project, doc.order).baseRef;
  const lint = deliveryChecks(project, doc, worktree);
  const general = [...generalChecks(cfg, worktree, baseRef), ...lint];
  const report: CheckReport = { tag: doc.order.tag, worktree, base: baseRef.replace(/^refs\/heads\//, ''), general, ...(lint.length ? { lint } : {}), exitCode: 0 };
  if (results.length) {
    const parsed = results.map(file => {
      try { return { file, parsed: parseResults(cfg.result_parser!, readFileSync(file, 'utf8')) }; }
      catch (e) { return fail('Cannot read the result file {file}: {why}', { file, why: (e as Error).message.split('\n')[0] }); }
    });
    report.refs = { file: cfg.references!, results: results.map(f => path.basename(f)), rows: compare(loadRefs(cfg.references!), mergeResults(parsed)) };
  }
  if (general.some(g => !g.ok) || report.refs?.rows.some(r => r.status === 'different' || r.status === 'missing')) report.exitCode = 1;
  orders.record(doc.order.tag, 'check', {
    ...(lint.length ? { lint, report: doc.reports.at(-1)?.seq, ...(options.delivery ? { delivery: true } : {}) } : {}),
    ok: report.exitCode === 0, base: report.base, worktree,
    general: general.map(g => ({ name: g.name, ok: g.ok, detail: g.detail })),
    ...(report.refs ? { results: report.refs.results, refs: summary(report.refs.rows) } : {}),
  });
  return report;
}

/** What goes into the event: counts, and every row that is not the same. */
export function summary(rows: RefRow[]) {
  return { same: rows.filter(r => r.status === 'same').length, other: rows.filter(r => r.status !== 'same').map(r => ({ name: r.name, status: r.status, reference: r.reference, got: r.got, from: r.from, why: r.why })) };
}

const cut = (v: string | undefined) => (v && v.length > 18 ? `${v.slice(0, 16)}..` : v ?? '');

export function formatCheck(r: CheckReport): string {
  const out = [t('alba check {tag}  (worktree {worktree}, base {base})', { tag: r.tag, worktree: r.worktree, base: r.base }), ''];
  for (const g of r.general) out.push(`  ${g.ok ? 'PASS' : 'FAIL'}  ${g.name}${g.detail ? ` — ${g.detail}` : ''}`);
  if (r.refs) {
    const count = (s: string) => r.refs!.rows.filter(x => x.status === s).length;
    out.push('', t('Reference values ({file}); results in order: {files}', { file: path.basename(r.refs.file), files: r.refs.results.join(', ') }));
    out.push(t('  {same} same, {different} different, {missing} missing, {added} new', { same: count('same'), different: count('different'), missing: count('missing'), added: count('new') }));
    const w = Math.max(4, ...r.refs.rows.map(x => x.name.length));
    out.push(`  ${'NAME'.padEnd(w)}  ${'STATUS'.padEnd(9)}  ${'REFERENCE'.padEnd(18)}  ${'RESULT'.padEnd(18)}  FROM`);
    for (const x of r.refs.rows) out.push(`  ${x.name.padEnd(w)}  ${x.status.padEnd(9)}  ${cut(x.reference).padEnd(18)}  ${cut(x.got).padEnd(18)}  ${x.from ?? ''}${x.why ? ` (${x.why})` : ''}`);
  }
  out.push('', r.exitCode === 0 ? t('All checks passed.') : t('Something differs, is missing or failed (exit 1).'));
  return out.join('\n');
}
