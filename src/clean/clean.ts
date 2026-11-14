import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readlinkSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { removeTreeSync } from '../fs/remove-tree.mjs';
import path from 'node:path';
import type * as A from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { baseRefOf, planWorktree } from '../run/worktree.ts';
import { systemGit, type GitProbe } from '../sync/git.ts';
import { findWorktree, type Probes } from '../tick/gather.ts';
import { inside } from '../monitor/monitor.ts';
import { cleanSignature, linkedAncestor, safePackageRoot, worktreeSignature } from './safety.ts';
import { artifactOwner, driveFacts, retentionItems } from './retention.ts';
import { executableProcesses, runProcess, type ExecutableProcess } from './processes.ts';
import { writeStateFile } from '../orders/state-files.ts';

/** Everything `alba clean` reads from the machine, so that tests can stand in for it. */
export interface CleanEnv {
  probes: Probes;
  git: GitProbe;
  /** Names of the programs that run now (`Godot.exe`, `dotnet`); throws when the list cannot be read. */
  processes(): string[];
  executableProcesses?(): ExecutableProcess[];
  /** Runs git in a folder; throws with git's message when it fails. */
  runGit(cwd: string, args: string[]): string;
  /** How long the plan may spend counting bytes in all (default 5000 ms); what is not counted in time has no size. */
  sizeBudgetMs?: number;
  freeDiskGb?(dir: string): number;
}

export const systemClean = (probes: Probes): CleanEnv => ({
  probes, git: systemGit,
  executableProcesses,
  processes() {
    if (process.platform === 'win32') {
      return execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/).map(l => /^"([^"]+)"/.exec(l)?.[1]).filter((x): x is string => !!x);
    }
    return execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map(l => path.basename(l.trim())).filter(Boolean);
  },
  runGit(cwd, args) {
    try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 300000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
      const err = e as { stderr?: Buffer | string; message: string };
      throw new Error(String(err.stderr ?? err.message).trim().split('\n')[0]);
    }
  },
});

const slash = (p: string) => p.replace(/\\/g, '/');
const same = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Only immediate links in explicitly configured, unlinked folders, with an exact lexical destination. */
function unlinkPackageReferences(project: ProjectConfig, target: string): number {
  let removed = 0;
  for (const rule of project.clean?.packages ?? []) {
    if (!same(path.dirname(target), path.resolve(project.root, rule.dir))) continue;
    for (const from of rule.links_from ?? []) {
      const dir = path.resolve(project.root, from);
      if (!existsSync(dir) || isLink(dir) || linkedAncestor(path.join(dir, '_'))) continue;
      for (const name of readdirSync(dir)) {
        const link = path.join(dir, name);
        if (!isLink(link) || !same(path.resolve(dir, readlinkSync(link)), target)) continue;
        try { unlinkSync(link); } catch { rmdirSync(link); }
        removed++;
      }
    }
  }
  return removed;
}

const SIZE_LIMIT_ENTRIES = 30000;

/** Folder size, counting what is inside without following links; undefined when there are too many entries to count quickly. */
function sizeOf(dir: string, deadline: number): { bytes: number; complete: boolean } {
  if (Date.now() >= deadline) return { bytes: 0, complete: false };
  try { const st = lstatSync(dir); if (st.isSymbolicLink()) return { bytes: 0, complete: true }; if (!st.isDirectory()) return { bytes: st.size, complete: true }; } catch { return { bytes: 0, complete: false }; }
  let total = 0, seen = 0;
  const walk = (d: string): boolean => {
    let names: string[];
    try { names = readdirSync(d); } catch { return false; }
    for (const name of names) {
      if (++seen > SIZE_LIMIT_ENTRIES || Date.now() >= deadline) return false;
      const full = path.join(d, name);
      let st;
      try { st = lstatSync(full); } catch { return false; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (!walk(full)) return false; } else total += st.size;
    }
    return true;
  };
  const complete = walk(dir);
  return { bytes: total, complete };
}

/** Links (symbolic links and junctions) in a tree, not followed. Infinite depth visits all levels. */
export function findLinks(dir: string, depth = 3, deadline = Infinity): string[] {
  if (isLink(dir)) return [dir];
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    if (Date.now() > deadline) return;
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const full = path.join(d, name);
      if (isLink(full)) { out.push(full); continue; }
      if (level < depth) { try { if (lstatSync(full).isDirectory()) walk(full, level + 1); } catch { /* gone meanwhile */ } }
    }
  };
  walk(dir, 0);
  return out;
}

/** Removes every link in the tree (the link itself, never what it points at), so that a recursive delete cannot follow it out. */
export function unlinkLinks(dir: string): number {
  const links = findLinks(dir, Infinity);
  for (const link of links) {
    try { unlinkSync(link); } catch { rmdirSync(link); } // a junction to a folder is removed like an empty folder
  }
  return links.length;
}

const processMatches = (running: readonly string[], wanted: string): string | undefined => {
  const w = wanted.toLowerCase().replace(/\.exe$/, '');
  return running.find(r => r.toLowerCase().replace(/\.exe$/, '') === w);
};

/**
 * What `alba clean` would do, and nothing else. A worktree whose order is merged, whose branch is in the base branch, that has no
 * uncommitted file and that nobody has touched for `idle_hours` is removed together with its branch; a worktree whose work is not
 * merged keeps everything except the configured cache folders; build folders keep the newest `keep`. Nothing is touched while a run
 * of the order is alive or while a configured program is running.
 */
export function planClean(project: ProjectConfig, orders: Orders, env: CleanEnv): A.CleanPlan {
  const cfg = project.clean ?? { idle_hours: 24, caches: [], builds: [], busy_processes: [] };
  const now = env.probes.now().getTime();
  const errors: string[] = [];
  const items: A.CleanItem[] = [];
  const deadline = Date.now() + (env.sizeBudgetMs ?? 5000);
  const docs = orders.all();
  const merged = orders.mergedSet(docs);
  const list = env.probes.worktrees(project.root);
  const openRuns = docs.flatMap(d => [
    ...d.runs.filter(r => !r.ended).map(r => ({ tag: d.order.tag, pid: r.pid, cwd: r.cwd ?? d.order.worktree, ...runProcess(r.pid, r.started, r.process_started_at, env.probes) })),
    ...(d.monitor && !d.monitor.resolved ? [{ tag: d.order.tag, pid: d.monitor.pid, cwd: d.order.worktree, ...runProcess(d.monitor.pid, d.monitor.started, d.monitor.process_started_at, env.probes) }] : []),
  ]);
  const aliveRuns = openRuns.filter(r => r.active);
  const runReason = (r: typeof openRuns[number]) => r.reason ?? (r.pid ? t('A run of {tag} is alive (pid {pid}).', { tag: r.tag, pid: r.pid }) : `A run or monitor of ${r.tag} is still open.`);

  let running: string[] = [];
  let busy: string | undefined;
  if (cfg.busy_processes.length) {
    try {
      running = env.processes();
      for (const name of cfg.busy_processes) { const hit = processMatches(running, name); if (hit) { busy = hit; break; } }
    } catch (e) {
      busy = '?';
      errors.push(t('The list of running programs could not be read ({why}); nothing is deleted.', { why: (e as Error).message.split('\n')[0] }));
    }
  }

  const ownerOf = (w: { path: string; branch?: string }): OrderDoc | undefined =>
    docs.find(d => d.order.worktree && same(d.order.worktree, w.path)) ?? docs.find(d => findWorktree(d.order.tag, [w]) !== undefined);

  for (const w of list) {
    if (same(w.path, project.root)) continue;                         // the main checkout stays
    const doc = ownerOf(w);
    const tag = doc?.order.tag;
    const base: Pick<A.CleanItem, 'kind' | 'path' | 'branch' | 'tag' | 'targets' | 'links'> = { kind: 'worktree', path: slash(w.path), ...(w.branch ? { branch: w.branch } : {}), ...(tag ? { tag } : {}), targets: [], links: 0 };
    const item = (action: A.CleanItem['action'], reason: string, targets: string[] = []): A.CleanItem => {
      const dirs = targets.length ? targets.map(x => path.join(w.path, x)) : [w.path];
      const links = action === 'remove' || action === 'prune' ? dirs.flatMap(d => (existsSync(d) ? findLinks(d, 3, deadline) : [])).length : 0;
      return { ...base, action, reason, targets, links };
    };
    if (!existsSync(w.path)) { items.push(item('skip', t('The folder is gone; `git worktree prune` clears the record.'))); continue; }
    if (inside(project.root, w.path) || isLink(w.path) || linkedAncestor(w.path)) { items.push(item('skip', 'Worktree is inside the base checkout or traverses a link.')); continue; }
    const open = aliveRuns.find(r => (tag && r.tag === tag) || (r.cwd && same(r.cwd, w.path)));
    if (open) { items.push(item('skip', runReason(open))); continue; }
    let baseRef: string;
    try { baseRef = doc ? planWorktree(project, doc.order).baseRef : baseRefOf(project); } catch { baseRef = baseRefOf(project); }
    const facts = env.git.facts(w.path, baseRef);
    if (!facts) { items.push(item('skip', t('git could not read it.'))); continue; }
    if (facts.dirty) { items.push(item('skip', t('{n} uncommitted file(s).', { n: facts.dirty }))); continue; }
    const orderMerged = doc ? merged.has(doc.order.tag) || orders.stage(doc, merged).stage === 'cancelled' : true;
    const inBase = facts.ahead.length === 0;
    if (orderMerged && inBase) {
      const idleHours = (now - Math.max(Date.parse(facts.lastAt) || 0, safeMtime(w.path))) / 3_600_000;
      if (idleHours >= cfg.idle_hours) items.push(item('remove', doc ? t('{tag} is merged or cancelled, its branch is in the base branch, nothing changed for {h} h.', { tag: doc.order.tag, h: Math.floor(idleHours) }) : t('No order owns it, its branch is in the base branch, nothing changed for {h} h.', { h: Math.floor(idleHours) })));
      else items.push(item('keep', t('Merged, but changed {h} h ago (idle_hours is {n}).', { h: Math.floor(idleHours), n: cfg.idle_hours })));
      continue;
    }
    // Build output (UE Intermediate/Cooked/StagedBuilds, DDC, sim build trees: tens of GB per worktree) is rebuilt on
    // demand, so it goes from every idle worktree that has to stay, approved-but-ahead ones included.
    const caches = cfg.caches.filter(c => existsSync(path.join(w.path, c)));
    const stage = doc ? orders.stage(doc, merged).stage : '-';
    const kept = orderMerged ? t('Approved, but its branch has {n} commit(s) the base branch lacks.', { n: facts.ahead.length }) : t('Work not merged yet.');
    if (!caches.length) { items.push(item('keep', kept)); continue; }
    if (stage === 'awaiting-review' || stage === 'monitoring') { items.push(item('keep', t('{stage}: the cache folders stay until it is decided.', { stage }))); continue; }
    const cacheIdle = (now - Math.max(Date.parse(facts.lastAt) || 0, safeMtime(w.path), ...caches.map(c => safeMtime(path.join(w.path, c))))) / 3_600_000;
    if (cacheIdle < cfg.idle_hours) { items.push(item('keep', t('{kept} Its cache folders changed {h} h ago (idle_hours is {n}).', { kept, h: Math.floor(cacheIdle), n: cfg.idle_hours }))); continue; }
    items.push(item('prune', orderMerged ? t('Approved, but its branch has {n} commit(s) the base branch lacks: only the cache folders go.', { n: facts.ahead.length }) : t('Work not merged yet ({stage}): only the cache folders go.', { stage }), caches));
  }

  for (const b of cfg.builds) {
    const dir = path.resolve(project.root, b.dir);
    if (!existsSync(dir)) continue;
    if (isLink(dir) || linkedAncestor(path.join(dir, '_'))) continue;
    const entries = readdirSync(dir).map(name => ({ name, full: path.join(dir, name) })).filter(e => { try { return lstatSync(e.full).isDirectory() || isLink(e.full); } catch { return false; } })
      .map(e => ({ ...e, at: safeMtime(e.full) })).sort((a, c) => c.at - a.at || (a.name < c.name ? 1 : -1));
    entries.forEach((e, i) => {
      const keep = i < b.keep;
      const links = keep ? 0 : findLinks(e.full, 3, deadline).length;
      const owner = artifactOwner(e.name, docs);
      items.push({ kind: 'build', path: slash(e.full), ...(owner ? { tag: owner.order.tag } : {}), action: keep ? 'keep' : 'delete', reason: keep ? t('One of the newest {n} builds.', { n: b.keep }) : t('Older than the newest {n} builds.', { n: b.keep }), targets: [], links });
    });
  }
  items.push(...retentionItems(project, orders, now));

  let executables: ExecutableProcess[] = [], processError = false;
  if (items.some(i => ['build', 'package'].includes(i.kind) && i.action === 'delete')) {
    try { if (!env.executableProcesses) throw new Error('No executable process probe.'); executables = env.executableProcesses(); }
    catch { processError = true; }
  }
  // Busy programs are project-wide; run and executable vetoes protect only their own artifacts.
  for (const it of items) {
    if (!['remove', 'prune', 'delete'].includes(it.action)) continue;
    if (busy) { it.action = 'skip'; it.reason = busy === '?' ? t('The list of running programs could not be read.') : t('{program} is running.', { program: busy }); continue; }
    if (it.kind === 'package' || it.kind === 'build') {
      const ownerRun = aliveRuns.find(r => r.tag === it.tag);
      const executable = executables.find(p => inside(it.path, p.executable));
      if (ownerRun || executable || processError) {
        it.action = 'skip'; it.reason = ownerRun ? runReason(ownerRun) : executable ? `pid ${executable.pid} has an executable inside this folder.` : 'Cannot read executable paths of running processes.';
      }
    }
  }
  for (const it of items) {
    it.pathClass ??= it.kind === 'worktree' ? it.action === 'prune' ? 'caches' : 'worktrees' : 'builds';
    const reused = openRuns.filter(r => !r.active && r.reason && ((it.tag && r.tag === it.tag) || (r.cwd && same(r.cwd, it.path))));
    if (reused.length) it.reason += `; ${reused.map(r => r.reason).join('; ')}`;
    if (!['remove', 'prune', 'delete'].includes(it.action)) continue;
    const targets = it.targets.length ? it.targets.map(t => path.resolve(it.path, t)) : [it.path];
    if (['build', 'package'].includes(it.kind) || it.action === 'prune') {
      const checkout = it.kind === 'worktree' ? it.path : project.root;
      const relative = targets.map(target => path.relative(checkout, target));
      try {
        const externalPackage = it.kind === 'package' && !inside(project.root, it.path);
        if (externalPackage) {
          // An external package is allowed only below a configured safe retention root.
          if (!(cfg.packages ?? []).some(r => same(path.dirname(it.path), path.resolve(project.root, r.dir)) && safePackageRoot(path.resolve(project.root, r.dir), project.root))) throw new Error('Unsafe package root.');
          try {
            env.runGit(it.path, ['rev-parse', '--show-toplevel']);
            // Packages inside another repository are not disposable build output.
            throw new Error('Package belongs to another Git checkout.');
          } catch (error) { if (!/not a git repository/i.test((error as Error).message)) throw error; }
        } else if (relative.some(r => !r || r.startsWith('..') || path.isAbsolute(r) || r.split(path.sep).includes('.git'))
          || env.runGit(checkout, ['ls-files', '--', ...relative]).trim()
          || env.runGit(checkout, ['status', '--porcelain', '--untracked-files=all', '--', ...relative]).trim()) {
          it.action = 'skip'; it.reason = 'Target is outside the base artifact folders, tracked, or contains uncommitted files.'; continue;
        }
      } catch { it.action = 'skip'; it.reason = 'Git could not verify the artifact folder.'; continue; }
    }
    let snapshotFailure = '';
    const failed = (why: string) => { snapshotFailure = why; };
    it.signature = it.kind === 'worktree' && it.action === 'remove'
      ? worktreeSignature(it.path, (cwd, args) => env.runGit(cwd, args), failed)
      : cleanSignature(targets, failed, { entries: cfg.snapshot_entries, seconds: cfg.snapshot_seconds });
    if (!it.signature) { it.action = 'skip'; it.reason = `Cannot safely snapshot the target: ${snapshotFailure}`; continue; }
    if (it.bytes === undefined) {
      const sizes = targets.map(dir => sizeOf(dir, deadline));
      const measured = sizes.reduce((sum, size) => sum + size.bytes, 0);
      if (sizes.every(size => size.complete)) it.bytes = measured;
      else if (measured > 0) it.measuredBytes = measured;
    }
  }
  return { project: project.id, at: env.probes.now().toISOString(), items, errors, drives: driveFacts(project, env.freeDiskGb) };
}

const safeMtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };

/** Carries out a plan: only items whose action deletes. Every action leaves an event and a `result` on its item. */
export function applyClean(project: ProjectConfig, orders: Orders, plan: A.CleanPlan, env: CleanEnv): A.CleanPlan {
  const fresh = planClean(project, orders, env);
  if (plan.project !== project.id) throw new Error('Clean refused: wrong project.');
  // Check every selected item before deleting any. Added unrelated candidates are never included.
  for (const item of plan.items.filter(i => ['remove', 'prune', 'delete'].includes(i.action))) {
    const match = fresh.items.find(i => path.resolve(i.path) === path.resolve(item.path));
    if (!match || match.action !== item.action || match.kind !== item.kind || match.tag !== item.tag || match.pathClass !== item.pathClass || match.branch !== item.branch || JSON.stringify(match.targets) !== JSON.stringify(item.targets) || !item.signature || match.signature !== item.signature) throw new Error(`Clean refused: stale plan for ${item.path}; ${match?.reason ?? 'target disappeared'}`);
  }
  for (const it of plan.items) {
    if (!['remove', 'prune', 'delete'].includes(it.action)) continue;
    try {
      if (it.kind === 'worktree' && it.action === 'remove') {
        const links = unlinkLinks(it.path);
        env.runGit(project.root, ['worktree', 'remove', '--force', it.path]);
        if (existsSync(it.path)) removeTreeSync(it.path);
        let branch = '';
        if (it.branch) {
          try { env.runGit(project.root, ['branch', '-d', it.branch]); branch = t('; branch {branch} deleted', { branch: it.branch }); } catch (e) { branch = t('; branch {branch} kept ({why})', { branch: it.branch, why: (e as Error).message }); }
        }
        it.result = t('removed{links}{branch}', { links: links ? t(' ({n} link(s) unlinked first)', { n: links }) : '', branch });
      } else {
        const targets = it.kind === 'worktree' ? it.targets.map(x => path.join(it.path, x)) : [it.path];
        let links = 0, references = 0;
        for (const target of targets) {
          // Safety: deletion stays inside the worktree, state folder, or configured artifact root.
          const packageRule = it.kind === 'package' ? project.clean?.packages?.find(r => same(path.dirname(target), path.resolve(project.root, r.dir)) && safePackageRoot(path.resolve(project.root, r.dir), project.root)) : undefined;
          if (it.kind === 'package' && !packageRule) throw new Error('Unsafe package retention root.');
          const root = it.kind === 'worktree' ? it.path : it.kind === 'log' ? project.state_dir : packageRule ? path.resolve(project.root, packageRule.dir) : project.root;
          const rel = path.relative(path.resolve(root), path.resolve(target));
          if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') throw new Error(t('{target} is not inside {root}.', { target, root }));
          if (!existsSync(target) && !isLink(target)) continue;
          links += unlinkLinks(target);
          removeTreeSync(target);
          if (it.kind === 'package' && !existsSync(target) && !isLink(target)) references += unlinkPackageReferences(project, target);
        }
        it.result = t('deleted{links}', { links: links ? t(' ({n} link(s) unlinked first)', { n: links }) : '' }) + (references ? `; ${references} package reference link(s) removed` : '');
      }
    } catch (e) {
      it.result = t('failed: {why}', { why: (e as Error).message.split('\n')[0] });
    }
    orders.record(it.tag ?? '*', 'clean', { action: it.action, kind: it.kind, path: it.path, ...(it.branch ? { branch: it.branch } : {}), ...(it.targets.length ? { targets: it.targets } : {}), result: it.result, ...(it.bytes !== undefined ? { bytes: it.bytes } : {}) });
  }
  writeStateFile(project, '_producer-last-clean.json', JSON.stringify(plan));
  return plan;
}

export function formatClean(plan: A.CleanPlan, applied: boolean): string {
  const lines: string[] = [];
  const mb = (b?: number) => (b === undefined ? '' : `  ${(b / 1048576).toFixed(1)} MB`);
  for (const it of plan.items) {
    const what = it.targets.length ? `${it.path}  [${it.targets.join(', ')}]` : it.path;
    const size = it.bytes !== undefined ? mb(it.bytes) : it.measuredBytes ? `  ≥${mb(it.measuredBytes).trim()} (partial)` : '  size unknown';
    lines.push(`${it.action.padEnd(6)} ${it.kind.padEnd(8)} ${what}${size}${it.links ? `  (${it.links} link(s))` : ''}`);
    lines.push(`         ${it.reason}${it.result ? `  -> ${it.result}` : ''}`);
  }
  if (!plan.items.length) lines.push(t('Nothing to clean.'));
  for (const e of plan.errors) lines.push(`warning: ${e}`);
  const todo = plan.items.filter(i => ['remove', 'prune', 'delete'].includes(i.action));
  lines.push('', applied ? t('Applied: {n} action(s).', { n: todo.length }) : todo.length ? t('Plan only: {n} action(s) would be done. Nothing was deleted; run again with --apply to do them.', { n: todo.length }) : t('Plan only: nothing would be deleted.'));
  return lines.join('\n');
}
