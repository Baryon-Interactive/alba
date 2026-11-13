import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { baseRefOf } from '../run/worktree.ts';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { projectFile } from './files.ts';
import { applyChangeSets, librarySnapshot, readChangeSet, stableJson } from './library.ts';
import { mergedPaths } from './read.ts';
import { excludeLocally } from '../skills/mount.ts';

export const WORKER_DESIGN_README = `# Design library

snapshot.json contains the whole library at run start. resolved_values are read from the worktree's JSON files. This is a read-only snapshot, not the source of truth.

Propose changes in .alba/design/changes/*.json. The document has title, optional decision/order, and changes. Each change has op (create/update/retire), kind, id, fields. Update and retire need base_version from the snapshot. Only rules retire; their superseded_by must name another rule or a ledger decision. Parameter values belong in gameplay JSON, never in change-set fields.

Example:

    {"title":"Clarify income","changes":[{"op":"update","kind":"rule","id":"ECON-R01","base_version":1,"fields":{"text":"Credit income once per turn."}}]}

List every proposed file in the final report's design_changes array, e.g. "design_changes":[".alba/design/changes/income.json"]. Keep those files available through approval. Acceptance also discovers committed change sets added or modified by this branch since its merge base, excluding inherited files. All discovered and listed files apply together after merge, against the combined next library and merged project root; every pending file is refused on any validation error or version conflict. Put each entity in only one file. Fix and retry, or a person can explicitly skip with an override note.
`;

export function writeDesignSnapshot(project: ProjectConfig, worktree: string): void {
  if (!project.design?.enabled) return;
  excludeLocally(worktree, ['.alba/design/']);
  const dir = path.join(worktree, '.alba/design');
  mkdirSync(path.join(dir, 'changes'), { recursive: true });
  writeFileSync(path.join(dir, 'snapshot.json'), stableJson(librarySnapshot({ ...project, root: worktree })), 'utf8');
  writeFileSync(path.join(dir, 'README.md'), WORKER_DESIGN_README, 'utf8');
}
export class DesignAcceptanceError extends Error {}
const parseChangeSetText = (text: string, file: string): unknown => {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch (error) { throw new Error(`${file}: ${(error as Error).message}`); }
};
const changeSetPath = /^\.alba\/design\/changes\/[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/;

/**
 * Before review: the change sets a delivery proposes (listed in its report, or added or changed on its branch), tried against the
 * library with the worktree's files and nothing written: the same apply that acceptance runs after the merge. The problem the apply
 * would refuse with, or undefined. Intake change sets are left to the intake review, as at acceptance.
 */
export function designChangeProblem(project: ProjectConfig, orders: Orders, tag: string): { files: string[]; reason: string } | undefined {
  if (!project.design?.enabled) return undefined;
  const doc = orders.get(tag), worktree = doc.order.worktree;
  if (!worktree || !existsSync(worktree)) return undefined;
  const files = [...(doc.reports.at(-1)?.design_changes ?? [])];
  if (doc.order.branch) {
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', project.root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const base = git('merge-base', baseRefOf(project), doc.order.branch);
      for (const file of git('diff', '--name-only', '--no-renames', '--diff-filter=AM', base, doc.order.branch, '--', '.alba/design/changes').split('\n')) if (/^\.alba\/design\/changes\/[^/]+\.json$/.test(file) && !files.includes(file)) files.push(file);
    } catch { /* the branch is not in the main repository yet: the report's list is what there is */ }
  }
  const tried = doc.order.kind === 'intake' ? files.filter(file => !/^\.alba\/design\/changes\/intake-[^/]+\.json$/i.test(file)) : files;
  if (!tried.length) return undefined;
  try {
    const proposals = tried.map(file => {
      if (!changeSetPath.test(file)) throw new Error(`Invalid design change-set path: ${file}`);
      return readChangeSet(projectFile(worktree, file));
    });
    applyChangeSets({ ...project, root: worktree }, orders, proposals, { by: 'accept', order: tag, idempotent: true, dryRun: true });
    return undefined;
  } catch (error) {
    return { files: tried, reason: (error as Error).message };
  }
}

/** What the worker is told when its change sets would be refused: the reason, the files, and how to fix them. */
export const designBounceNote = (problem: { files: string[]; reason: string }): string => [
  `The design change sets of this delivery would be refused at approval: ${problem.reason}`,
  '',
  `Files: ${problem.files.join(', ')}.`,
  '',
  'Fix them before the review: ids and base_version come from .alba/design/snapshot.json (create only a new id, update or retire an existing one at its current version), and the README there lists the fields. Keep every file listed in the report field design_changes, commit, and end with a new report block.',
].join('\n');

/** The text of a file in a commit, or undefined when the commit does not have it. */
function fileInCommit(project: ProjectConfig, commit: string, file: string): string | undefined {
  try { return execFileSync('git', ['-C', project.root, 'show', `${commit}:${file}`], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
  catch { return undefined; }
}

/**
 * The change sets a delivery lists that its branch does not commit (they live only in the worktree), with their text now. The
 * acceptance trial takes them into its fingerprint and the merge applies exactly these texts, so an edit in the worktree after
 * the trial cannot reach the library.
 */
export function pinnedDesignChanges(project: ProjectConfig, orders: Orders, tag: string, branchCommit: string): Record<string, string> {
  const doc = orders.get(tag), worktree = doc.order.worktree;
  const pins: Record<string, string> = {};
  for (const file of doc.reports.at(-1)?.design_changes ?? []) {
    if (!changeSetPath.test(file) || fileInCommit(project, branchCommit, file) !== undefined) continue;
    if (worktree && existsSync(path.join(worktree, file))) pins[file] = readFileSync(projectFile(worktree, file), 'utf8');
  }
  return pins;
}

/** Where accepted change sets are read from: committed files from `commit` (the merge, or the merged branch); the others from `pinned` when given, else from the worktree. */
export interface DesignSource { commit?: string; pinned?: Record<string, string> }

/** Called only after Git confirms/finishes merging. Its library changes are written in the caller's transaction, if there is one. */
export function acceptDesignChanges(project: ProjectConfig, orders: Orders, tag: string, override = false, note = '', source: DesignSource = {}): void {
  const doc = orders.get(tag), reportFiles = doc.reports.at(-1)?.design_changes ?? [];
  let diffFiles: string[] = [];
  if (project.design?.enabled && doc.order.branch) {
    try {
      const trial = orders.store.events().filter(e => e.tag === tag && e.type === 'accept-trial' && Array.isArray(e.data?.changed)).at(-1);
      orders.record(tag, 'design-accepted-tree', { changed: trial?.data?.changed ?? mergedPaths(project, doc.order.branch) });
    } catch { /* stale query exposes unknown Git paths */ }
  }
  const files = [...reportFiles];
  const started = Date.now();
  try {
    // Use the delivery's merge base, excluding proposals inherited from its base.
    // Projects without a design library never look for proposals in the diff.
    if (project.design?.enabled && doc.order.branch) diffFiles = mergedPaths(project, doc.order.branch, { branchOnly: true, diffFilter: 'AM' }).filter(file => /^\.alba\/design\/changes\/[^/]+\.json$/.test(file));
    const sources = { report: reportFiles, diff: diffFiles };
    files.push(...diffFiles.filter(file => !files.includes(file)));
    const skipped = doc.order.kind === 'intake' ? files.filter(file => /^\.alba\/design\/changes\/intake-[^/]+\.json$/i.test(file)) : [];
    if (skipped.length) {
      for (const file of skipped) files.splice(files.indexOf(file), 1);
      orders.record(tag, 'accept-step', { name: 'design-changesets', status: 'skipped', duration_ms: 0, files: skipped, sources, reason: 'Intake change sets are applied only by per-system intake review.' });
    }
    if (!files.length) return;
    if (diffFiles.length && !reportFiles.length) orders.record(tag, 'accept-warning', { name: 'design-changesets', files: diffFiles, sources, reason: 'Delivery diff contains design change sets but the latest report lists none.' });
    const proposals = files.map(file => {
      if (!changeSetPath.test(file)) throw new Error(`Invalid design change-set path: ${file}`);
      // A committed proposal is read from the merge, never from a worktree that may have changed since the review.
      const committed = source.commit ? fileInCommit(project, source.commit, file) : undefined;
      if (committed !== undefined) return parseChangeSetText(committed, file);
      if (source.pinned) {
        if (source.pinned[file] === undefined) throw new Error(`Design change set ${file} is neither in the merge nor in the reviewed delivery.`);
        return parseChangeSetText(source.pinned[file], file);
      }
      // Proposals can be operational files. Gameplay values always resolve in the merged root.
      const workerRoot = doc.order.worktree && existsSync(doc.order.worktree) ? doc.order.worktree : project.root;
      return readChangeSet(projectFile(diffFiles.includes(file) ? project.root : workerRoot, file));
    });
    const results = applyChangeSets(project, orders, proposals, { by: 'accept', order: tag, idempotent: true });
    // Inside an approval's transaction the library change is taken back with it: the retry applies it again.
    for (const result of results) if (result.export_error) throw new Error(result.export_error.replace(/^Change set is committed; export failed/, 'Design export failed'));
    orders.record(tag, 'accept-step', { name: 'design-changesets', status: 'passed', duration_ms: Date.now() - started, files, sources });
  } catch (error) {
    const reason = (error as Error).message;
    orders.record(tag, 'accept-step', { name: 'design-changesets', status: 'failed', duration_ms: Date.now() - started, files, sources: { report: reportFiles, diff: diffFiles }, reason });
    if (override && note.trim().length >= 10) { orders.record(tag, 'accept-step', { name: 'design-changesets', status: 'skipped', duration_ms: 0, files, sources: { report: reportFiles, diff: diffFiles }, reason, note }); return; }
    throw new DesignAcceptanceError(`Design change sets refused after merge: ${reason}. Fix and retry approval, or explicitly skip with --override and a note of at least 10 characters.`);
  }
}
