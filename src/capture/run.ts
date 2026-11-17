import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../config.ts';
import { fail } from '../i18n.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { writeFileAtomic } from '../orders/store.ts';
import { stopProcessTree } from '../run/kill-tree.ts';
import {
  albaPackageRoot,
  expandCaptureCommand,
  expandCaptureString,
  matchCaptureRecipe,
  shotFinalTemplate,
  type CapturePlaceholders,
  type CaptureRecipe,
} from './config.ts';
import type { CaptureRunnerJob } from './runner.ts';
import type { CaptureManifest, CaptureSummary } from './types.ts';

export interface RunCaptureOptions {
  recipe?: string;
  trial?: string;
  outDir: string;
  expectedRevision?: string;
  /** Optional backstop override in milliseconds for testing runner stop handling. */
  backstopMs?: number;
}

export interface CaptureRunResult {
  manifest: CaptureManifest;
  summary: CaptureSummary;
  busy: boolean;
  duration_ms: number;
  warnings: string[];
}

export interface CaptureDryRunResult {
  dryRun: true;
  tag: string;
  recipe: string;
  lock: string;
  done: 'exit' | 'file';
  worktree: string;
  revision: string;
  outDir: string;
  build?: string[];
  artifact?: string;
  size?: [number, number];
  baseline?: string;
  shots: { name: string; command: string[]; timeout_seconds: number; done: 'exit' | 'file' }[];
}

const slash = (p: string) => p.replace(/\\/g, '/');

function git(cwd: string, ...args: string[]): string {
  const out = execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return args.includes('-z') ? out : out.trim();
}

function listDirtyFiles(worktree: string, maxFiles = 20): string[] {
  try {
    const out = git(worktree, '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '--untracked-files=all');
    if (!out) return [];
    return out.split(/\r?\n/).filter(Boolean).map(line => line.slice(3).trim()).filter(Boolean).slice(0, maxFiles);
  } catch {
    return [];
  }
}

export function resolveCaptureRecipe(project: ProjectConfig, doc: OrderDoc, recipeName?: string): CaptureRecipe {
  if (!project.capture?.recipes.length) {
    fail('{file} has no "capture" recipes configured.', { file: project.file });
  }
  if (recipeName !== undefined) {
    const named = project.capture.recipes.find(r => r.name === recipeName);
    if (!named) {
      fail('Unknown capture recipe "{recipe}" in {file}. Known recipes: {known}.', {
        recipe: recipeName,
        file: project.file,
        known: project.capture.recipes.map(r => r.name).join(', '),
      });
    }
    return named;
  }
  const matched = matchCaptureRecipe(project, doc);
  if (!matched) {
    fail('No capture recipe in {file} matches order {tag}.', { file: project.file, tag: doc.order.tag });
  }
  return matched;
}

export function toCaptureSummary(manifest: CaptureManifest, outDir: string): CaptureSummary {
  const absOut = path.resolve(outDir);
  const manifestPath = path.join(absOut, 'manifest.json');
  const sheetCandidate = manifest.sheet ? path.join(absOut, manifest.sheet) : '';
  const sheetPath = sheetCandidate && existsSync(sheetCandidate) ? sheetCandidate : '';
  return {
    recipe: manifest.recipe,
    manifest: manifestPath,
    sheet: sheetPath,
    revision: manifest.revision,
    status: manifest.status,
    ...(manifest.reason ? { reason: manifest.reason } : {}),
    shots: manifest.shots.map(s => ({
      name: s.name,
      file: path.join(absOut, s.file),
      status: s.status,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.width !== undefined ? { width: s.width } : {}),
      ...(s.height !== undefined ? { height: s.height } : {}),
      ...(s.sha256 ? { sha256: s.sha256 } : {}),
    })),
    gates: manifest.gates,
  };
}

function writeFailedManifest(
  outDir: string,
  partial: {
    tag: string;
    recipe: string;
    report: number | null;
    trial: string | null;
    branch: string;
    revision: string;
    dirty: string[];
    lockName: string;
    waitedMs: number;
    started: string;
    reason: string;
  },
): CaptureManifest {
  mkdirSync(outDir, { recursive: true });
  const manifest: CaptureManifest = {
    version: 1,
    tag: partial.tag,
    recipe: partial.recipe,
    report: partial.report,
    trial: partial.trial,
    branch: partial.branch,
    revision: partial.revision,
    dirty: partial.dirty,
    lock: { name: partial.lockName, waited_ms: partial.waitedMs },
    build: null,
    artifact: null,
    started: partial.started,
    ended: new Date().toISOString(),
    status: 'failed',
    reason: partial.reason,
    shots: [],
    gates: [],
    sheet: null,
  };
  writeFileAtomic(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function dryRunCapture(
  project: ProjectConfig,
  orders: Orders,
  tag: string,
  options: { recipe?: string; outDir?: string } = {},
): CaptureDryRunResult {
  const doc = orders.get(tag);
  const recipe = resolveCaptureRecipe(project, doc, options.recipe);
  const absOut = path.resolve(options.outDir ?? path.join(project.state_dir, 'capture', `${doc.order.tag}-dry-run`));
  const worktree = doc.order.worktree ? path.resolve(doc.order.worktree) : project.root;
  let revision = 'HEAD';
  if (doc.order.worktree && existsSync(doc.order.worktree)) {
    try { revision = git(doc.order.worktree, 'rev-parse', '--verify', 'HEAD^{commit}'); } catch { /* preview fallback */ }
  }
  const albaDir = albaPackageRoot();
  const baseVars: CapturePlaceholders = {
    tag: doc.order.tag,
    worktree: slash(worktree),
    out_dir: slash(absOut),
    revision,
    alba: slash(albaDir),
    alba_skills: slash(path.join(albaDir, 'templates', 'skills')),
  };
  return {
    dryRun: true,
    tag: doc.order.tag,
    recipe: recipe.name,
    lock: recipe.lock,
    done: recipe.done,
    worktree: slash(worktree),
    revision,
    outDir: slash(absOut),
    ...(recipe.build ? { build: expandCaptureCommand(recipe.build, baseVars) } : {}),
    ...(recipe.artifact ? { artifact: expandCaptureString(recipe.artifact, baseVars) } : {}),
    ...(recipe.size ? { size: recipe.size } : {}),
    ...(recipe.baseline ? { baseline: recipe.baseline } : {}),
    shots: recipe.shots.map(shot => {
      const out = slash(path.join(absOut, `${shot.name}.png`));
      const vars: CapturePlaceholders = { ...baseVars, out, shot: shot.name };
      return {
        name: shot.name,
        command: expandCaptureCommand(shotFinalTemplate(recipe, shot), vars),
        timeout_seconds: shot.timeout_seconds,
        done: shot.done ?? recipe.done,
      };
    }),
  };
}

export function runCapture(
  project: ProjectConfig,
  orders: Orders,
  tag: string,
  options: RunCaptureOptions,
): CaptureRunResult {
  const startedMs = Date.now();
  const startedIso = new Date(startedMs).toISOString();
  const doc = orders.get(tag);
  const recipe = resolveCaptureRecipe(project, doc, options.recipe);
  const outDir = path.resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  const reportSeq = doc.reports.at(-1)?.seq ?? null;
  const trialId = options.trial ?? null;
  const branchName = doc.order.branch ?? '';
  const warnings: string[] = [];

  const failEarly = (reason: string, revision = '', dirty: string[] = [], busy = false, waitedMs = 0): CaptureRunResult => {
    const manifest = writeFailedManifest(outDir, {
      tag: doc.order.tag,
      recipe: recipe.name,
      report: reportSeq,
      trial: trialId,
      branch: branchName,
      revision,
      dirty,
      lockName: recipe.lock,
      waitedMs,
      started: startedIso,
      reason,
    });
    return {
      manifest,
      summary: toCaptureSummary(manifest, outDir),
      busy,
      duration_ms: Date.now() - startedMs,
      warnings,
    };
  };

  const openRun = doc.runs.find(r => r.ended === undefined);
  if (openRun) {
    return failEarly(`Run ${openRun.id} of ${doc.order.tag} is still open.`);
  }

  if (!doc.order.worktree) {
    return failEarly(`Order ${doc.order.tag} has no worktree.`);
  }
  const worktree = path.resolve(doc.order.worktree);
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) {
    return failEarly(`Worktree ${worktree} of ${doc.order.tag} does not exist.`);
  }

  if (!branchName) {
    return failEarly(`Order ${doc.order.tag} has no recorded branch.`);
  }

  let branchTip: string;
  try {
    branchTip = git(project.root, 'rev-parse', '--verify', `refs/heads/${branchName}^{commit}`);
  } catch (e) {
    return failEarly(`Branch refs/heads/${branchName} cannot be resolved: ${(e as Error).message.split('\n')[0]}`);
  }

  let worktreeHead: string;
  try {
    worktreeHead = git(worktree, 'rev-parse', '--verify', 'HEAD^{commit}');
  } catch (e) {
    return failEarly(`Worktree HEAD cannot be resolved: ${(e as Error).message.split('\n')[0]}`);
  }

  if (worktreeHead !== branchTip) {
    return failEarly(
      `Worktree HEAD ${worktreeHead.slice(0, 12)} is not the tip of refs/heads/${branchName} (${branchTip.slice(0, 12)}).`,
      worktreeHead,
    );
  }
  if (options.expectedRevision && worktreeHead !== options.expectedRevision) {
    return failEarly(
      `Worktree HEAD ${worktreeHead.slice(0, 12)} does not match trial branch ${options.expectedRevision.slice(0, 12)}.`,
      worktreeHead,
    );
  }

  const dirty = listDirtyFiles(worktree, 20);
  if (dirty.length > 0) {
    warnings.push(`Worktree has uncommitted files (${dirty.length}): ${dirty.join(', ')}`);
  }

  const scratchDir = path.join(tmpdir(), `alba-capture-${process.pid}-${randomUUID()}`);
  mkdirSync(scratchDir, { recursive: true });
  const jobFile = path.join(scratchDir, 'job.json');
  const pidFile = path.join(scratchDir, 'runner.pid.json');

  const spawnedAt = Date.now();
  const job: CaptureRunnerJob = {
    tag: doc.order.tag,
    report: reportSeq,
    trial: trialId,
    branch: branchName,
    revision: worktreeHead,
    worktree,
    outDir,
    albaDir: albaPackageRoot(),
    dirty,
    recipe,
    screenshots: project.verify.screenshots,
    spawnedAt,
    pidFile,
  };
  writeFileSync(jobFile, JSON.stringify(job), 'utf8');

  const lockHelper = fileURLToPath(new URL('../run/lock-helper.mjs', import.meta.url));
  const runnerTs = fileURLToPath(new URL('./runner.ts', import.meta.url));
  const runnerScript = existsSync(runnerTs) ? runnerTs : fileURLToPath(new URL('./runner.js', import.meta.url));
  const backstopMs = options.backstopMs ?? Math.ceil(((recipe.build ? recipe.build_timeout_minutes : 0) + recipe.timeout_minutes + recipe.lock_wait_minutes + 2) * 60_000);

  try {
    const ran = spawnSync(
      process.execPath,
      [
        lockHelper,
        recipe.lock,
        '--wait-minutes',
        String(recipe.lock_wait_minutes),
        '--',
        process.execPath,
        '--disable-warning=ExperimentalWarning',
        runnerScript,
        jobFile,
      ],
      {
        cwd: worktree,
        shell: false,
        windowsHide: true,
        timeout: backstopMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const errCode = (ran.error as NodeJS.ErrnoException | undefined)?.code;
    const hitBackstop = errCode === 'ETIMEDOUT' || !!ran.signal;

    if (hitBackstop && existsSync(pidFile)) {
      try {
        const info = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: number; startedAt?: string; launchedAt?: string };
        if (typeof info.pid === 'number' && info.pid > 0) {
          stopProcessTree(info.pid, info.startedAt, info.launchedAt);
        }
      } catch { /* ignore unreadable pid file */ }
    }

    if (ran.status === 75) {
      return failEarly(`capture lock "${recipe.lock}" busy`, worktreeHead, dirty, true, Math.max(0, Date.now() - spawnedAt));
    }

    if (hitBackstop) {
      return failEarly(
        `Capture backstop timeout (${Math.round(backstopMs / 1000)} s) exceeded; runner stopped.`,
        worktreeHead,
        dirty,
        false,
        Math.max(0, Date.now() - spawnedAt),
      );
    }

    const manifestFile = path.join(outDir, 'manifest.json');
    if (!existsSync(manifestFile)) {
      const stderrTail = String(ran.stderr || ran.error?.message || `runner exited with code ${ran.status ?? 'unknown'}`).trim().slice(-1000);
      return failEarly(`Capture runner produced no manifest: ${stderrTail}`, worktreeHead, dirty, false, Math.max(0, Date.now() - spawnedAt));
    }

    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as CaptureManifest;
    return {
      manifest,
      summary: toCaptureSummary(manifest, outDir),
      busy: false,
      duration_ms: Date.now() - startedMs,
      warnings,
    };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

export function formatCaptureRun(tag: string, result: CaptureRunResult): string {
  const { summary, warnings } = result;
  const lines = [
    `${tag} (${summary.recipe} @ ${summary.revision ? summary.revision.slice(0, 12) : '-'}): ${summary.status.toUpperCase()}${summary.reason ? ` - ${summary.reason}` : ''}`,
  ];
  for (const w of warnings) lines.push(`  warning: ${w}`);
  for (const s of summary.shots) {
    const dims = s.width && s.height ? ` ${s.width}x${s.height}` : '';
    lines.push(`  shot ${s.name}: ${s.status.toUpperCase()}${dims}${s.reason ? ` - ${s.reason}` : ''} (${s.file})`);
  }
  for (const g of summary.gates) {
    lines.push(`  gate ${g.name}: ${g.status.toUpperCase()} - ${g.detail}`);
  }
  lines.push(`  sheet: ${summary.sheet || '(none)'}`);
  lines.push(`  manifest: ${summary.manifest}`);
  return lines.join('\n');
}

export function formatCaptureDryRun(plan: CaptureDryRunResult): string {
  const lines = [
    `${plan.tag}: recipe ${plan.recipe} (lock ${plan.lock}, done ${plan.done}, revision ${plan.revision.slice(0, 12)})`,
    `  out_dir: ${plan.outDir}`,
  ];
  if (plan.build) lines.push(`  build: ${plan.build.join(' ')}`);
  if (plan.artifact) lines.push(`  artifact: ${plan.artifact}`);
  if (plan.size) lines.push(`  size: ${plan.size[0]}x${plan.size[1]}`);
  if (plan.baseline) lines.push(`  baseline: ${plan.baseline}`);
  for (const shot of plan.shots) {
    lines.push(`  shot ${shot.name} (${shot.timeout_seconds}s, ${shot.done}): ${shot.command.join(' ')}`);
  }
  return lines.join('\n');
}
