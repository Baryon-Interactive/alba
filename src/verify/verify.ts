import { localizedVague } from '../i18n.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, readFileSync, readdirSync, readSync, statSync, closeSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { globToRegExp } from '../check/general.ts';
import { runCheck } from '../check/check.ts';
import type { OrderDoc, Report, Run } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { findOrderFile } from '../run/prompt.ts';
import { orderBaseRef, mergeReadiness, systemReadiness } from '../review/readiness.ts';
import { planWorktree } from '../run/worktree.ts';
import { t } from '../i18n.ts';
import { decodePng, imageFormat, summarizePng, type ImageFormat, type ImageSummary } from './png.ts';
import { decodeJpegBlocks } from './jpeg.ts';

export type VerifyStatus = 'pass' | 'fail' | 'warn';
export interface VerifyItem { name: string; status: VerifyStatus; reason: string; file?: string; details?: Record<string, unknown> }
export interface VerifyReport { tag: string; at: string; run?: string; results: VerifyItem[]; ok: boolean; exitCode: 0 | 1 }

export interface OrderSections {
  acceptance: string[];
  evidence: { path: string; what: string }[];
  allow: string[];
  deny: string[];
  maxLines: { glob: string; max: number }[];
  warnings: string[];
  file?: string;
}

const vague = new Set(['looks good', 'works', 'fine', ...localizedVague]);
const sectionHead = /^##\s+(.+?)\s*$/i;
const bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/;

/** Parse the optional deterministic acceptance sections in an order markdown file. */
export function parseOrderSections(markdown: string, file?: string): OrderSections {
  let section = '';
  const acceptance: string[] = [], evidence: { path: string; what: string }[] = [], allow: string[] = [], deny: string[] = [];
  const maxLines: { glob: string; max: number }[] = [];
  for (const raw of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const h = sectionHead.exec(raw);
    if (h) { section = h[1].trim().toLowerCase(); continue; }
    const b = bullet.exec(raw);
    if (!b) continue;
    const item = b[1].trim();
    if (section === 'acceptance') acceptance.push(item);
    else if (section === 'evidence') {
      const i = item.indexOf(':');
      evidence.push({ path: (i < 0 ? item : item.slice(0, i)).trim(), what: i < 0 ? '' : item.slice(i + 1).trim() });
    } else if (section === 'paths') {
      const m = /^(allow|deny)\s*:\s*(.+)$/i.exec(item);
      if (m) (m[1].toLowerCase() === 'allow' ? allow : deny).push(m[2].trim());
      else {
        const n = /^max-lines\s*:\s*(\d+)\s*(?:for|per)?\s*(.*)$/i.exec(item);
        if (n) maxLines.push({ glob: n[2].trim() || '**', max: Number(n[1]) });
      }
    }
  }
  const warnings: string[] = [];
  if (!acceptance.length) warnings.push('Order has no ## Acceptance section.');
  if (!evidence.length) warnings.push('Order has no ## Evidence section.');
  for (const item of acceptance) if (vague.has(item.toLowerCase())) warnings.push(`Vague acceptance item: ${item}`);
  return { acceptance, evidence, allow, deny, maxLines, warnings, ...(file ? { file } : {}) };
}

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
  try { return { code: 0, out: execFileSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', '-C', cwd, ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), err: '' }; }
  catch (e) { const x = e as { status?: number; stdout?: string; stderr?: string }; return { code: x.status ?? 128, out: x.stdout ?? '', err: x.stderr ?? '' }; }
}
const match = (glob: string, file: string): boolean => globToRegExp(glob).test(file.replace(/\\/g, '/'));
const short = (xs: readonly string[]) => xs.slice(0, 6).join(', ') + (xs.length > 6 ? ` and ${xs.length - 6} more` : '');

function changed(worktree: string, base: string): { path: string; added: number; removed: number }[] {
  const r = git(worktree, ['diff', '--numstat', '--no-renames', `${base}...HEAD`]);
  if (r.code !== 0) return [];
  return r.out.split(/\r?\n/).filter(Boolean).map(line => {
    const [a, d, ...p] = line.split('\t');
    return { path: p.join('\t'), added: Number(a) || 0, removed: Number(d) || 0 };
  });
}

// Folders that never hold evidence and can hold millions of files (engine caches, dependencies).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'Intermediate', 'DerivedDataCache', '.vs']);
function filesUnder(root: string, relative = '', includeDirectories = false): string[] {
  const dir = path.join(root, relative);
  if (!existsSync(dir)) return [];
  const out: string[] = includeDirectories && relative ? [relative] : [];
  for (const entry of (awaitlessReaddir(dir))) {
    const rel = path.posix.join(relative.replace(/\\/g, '/'), entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) out.push(...filesUnder(root, rel, includeDirectories)); } else out.push(rel);
  }
  return out;
}
/** The folder part of a glob before its first wildcard segment: only that subtree can match. */
export function globBase(glob: string): string {
  const parts = glob.replace(/\\/g, '/').split('/');
  const fixed: string[] = [];
  for (const part of parts.slice(0, -1)) { if (/[*?[{]/.test(part)) break; fixed.push(part); }
  return fixed.join('/');
}
/** Matching files (and optionally directories), walking only the glob's fixed base folder. Results are kept per verify run. */
function filesForGlob(root: string, glob: string, memo: Map<string, string[]>, includeDirectories = false): string[] {
  const base = globBase(glob);
  const key = `${root}\u0000${base}\u0000${includeDirectories}`;
  let files = memo.get(key);
  if (!files) { files = filesUnder(root, base, includeDirectories); memo.set(key, files); }
  return files.filter(f => match(glob, f) || (includeDirectories && /[\\/]$/.test(glob) && match(glob, `${f}/`) && statSync(path.join(root, f)).isDirectory()));
}
// Kept synchronous so the verifier remains usable by CLI, tick and tests without a probe abstraction.
function awaitlessReaddir(dir: string): { name: string; isDirectory(): boolean }[] {
  return readdirSync(dir, { withFileTypes: true });
}

function resolveEvidence(file: string, worktree: string, projectRoot: string): string {
  if (path.isAbsolute(file)) return file;
  const first = path.resolve(worktree, file);
  return existsSync(first) ? first : path.resolve(projectRoot, file);
}

function evidenceFreshness(file: string, started: number, firstStarted: number): { missing: boolean; fresh: boolean; carried: boolean; directory?: string } {
  if (!existsSync(file)) return { missing: true, fresh: false, carried: false };
  const stats = statSync(file);
  if (!stats.isDirectory()) return { missing: false, fresh: stats.mtimeMs > started, carried: stats.mtimeMs > firstStarted && stats.mtimeMs <= started };
  let total = 0, fresh = 0, carried = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) { total++; const time = statSync(child).mtimeMs; if (time > started) fresh++; else if (time > firstStarted) carried++; }
    }
  };
  walk(file);
  return { missing: total === 0, fresh: fresh > 0, carried: carried > 0, directory: `${fresh} of ${total} files fresh, ${carried} carried over` };
}

export const FRESHNESS_REPAIR = 'Do not change file times or move files to pass this check; rerun the step or cite files from this run.';

const IMAGE_EXTENSIONS: Record<string, ImageFormat> = { '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.gif': 'GIF', '.webp': 'WebP' };
const MAX_PNG_BYTES = 64 * 1024 * 1024;
function fileImageFormat(file: string): ImageFormat {
  const fd = openSync(file, 'r');
  const header = Buffer.alloc(12);
  try { return imageFormat(header.subarray(0, readSync(fd, header, 0, header.length, 0))); }
  finally { closeSync(fd); }
}
const normalized = (file: string): string => path.resolve(file).replace(/\\/g, '/').toLowerCase();

function hashFile(file: string): string {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n = 0;
    while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

const globMemo = new Map<string, string[]>();
function globFiles(glob: string, worktree: string, projectRoot: string): string[] {
  return [...new Set([...filesForGlob(worktree, glob, globMemo), ...filesForGlob(projectRoot, glob, globMemo)].map(f => {
    const inWorktree = path.resolve(worktree, f);
    return existsSync(inWorktree) ? inWorktree : path.resolve(projectRoot, f);
  }))];
}

interface ScreenshotFile {
  path: string;
  bytes: number;
  hash: string;
  summary?: ImageSummary;
  state: 'decoded' | 'not decoded' | 'mismatch' | 'skipped';
  format: ImageFormat;
  reason?: string;
}

function screenshotGate(project: ProjectConfig, worktree: string, sections: OrderSections, report: Report): VerifyItem | undefined {
  const config = project.verify.screenshots;
  if (config === 'off') return undefined;
  const files = new Map<string, string>();
  const add = (file: string) => { if (existsSync(file) && statSync(file).isFile() && (IMAGE_EXTENSIONS[path.extname(file).toLowerCase()] || fileImageFormat(file) !== 'other')) files.set(normalized(file), file); };
  for (const req of sections.evidence) for (const file of globFiles(req.path, worktree, project.root)) add(file);
  for (const named of report.evidence) {
    if (/[*?[]/.test(named)) for (const file of globFiles(named, worktree, project.root)) add(file);
    else add(resolveEvidence(named, worktree, project.root));
  }
  const entries: ScreenshotFile[] = [...files.values()].sort().map(file => {
    const bytes = statSync(file).size;
    const hash = hashFile(file);
    const format = fileImageFormat(file), ext = path.extname(file).toLowerCase();
    if (IMAGE_EXTENSIONS[ext] !== format) {
      const suffix = format === 'JPEG' ? '.jpg' : format === 'PNG' ? '.png' : format === 'GIF' ? '.gif' : '.webp';
      const repair = format === 'other' ? `save it as ${IMAGE_EXTENSIONS[ext] ?? 'an image'}` : `save it as ${IMAGE_EXTENSIONS[ext] ?? 'the named format'} or rename it ${suffix}`;
      return { path: file, bytes, hash, format, state: 'mismatch', reason: `${format === 'other' ? 'Unrecognized' : format} data in a ${ext || 'file without an extension'} file: ${repair}` };
    }
    if (format !== 'PNG' && format !== 'JPEG') return { path: file, bytes, hash, format, state: 'not decoded', reason: `not decoded (${format})` };
    if (bytes > MAX_PNG_BYTES) return { path: file, bytes, hash, format, state: 'skipped' };
    // A JPEG is read at one value per 8x8 block (its DC coefficients): enough for the blank, dark and duplicate checks.
    const decoded = format === 'JPEG' ? decodeJpegBlocks(readFileSync(file)) : decodePng(readFileSync(file));
    return decoded.status === 'ok' ? { path: file, bytes, hash, format, summary: summarizePng(decoded.image), state: 'decoded' } : { path: file, bytes, hash, format, state: 'not decoded', reason: `not decoded (${decoded.reason})` };
  });
  const detailFiles = entries.map(e => ({ path: e.path, bytes: e.bytes, format: e.format, state: e.state, ...(e.reason ? { reason: e.reason } : {}), ...(e.summary ? { mean_luminance: e.summary.meanLuminance, luminance_stddev: e.summary.luminanceStddev, dark_fraction: e.summary.darkFraction } : {}) }));
  const duplicatePairs: string[] = [];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    if (a.hash === b.hash) duplicatePairs.push(`${a.path} = ${b.path}`);
    else if (a.summary && b.summary) {
      const diff = a.summary.thumbnail.reduce((sum, value, index) => sum + Math.abs(value - b.summary!.thumbnail[index]), 0) / 256;
      if (diff < config.duplicate_diff) duplicatePairs.push(`${a.path} ~ ${b.path} (${(diff * 100).toFixed(2)}%)`);
    }
  }
  const blank = entries.filter(e => e.summary && e.summary.luminanceStddev < config.blank_std);
  const dark = entries.filter(e => e.summary && (e.summary.meanLuminance < config.dark_mean || e.summary.darkFraction > config.dark_fraction));
  const skipped = entries.filter(e => e.state === 'skipped');
  const mismatches = entries.filter(e => e.state === 'mismatch');
  const undecoded = entries.filter(e => e.state === 'not decoded');
  const reasons: string[] = [];
  for (const entry of mismatches) reasons.push(`${entry.path}: ${entry.reason}.`);
  if (duplicatePairs.length) reasons.push(t('Duplicate screenshots: {files}.', { files: duplicatePairs.join('; ') }));
  if (blank.length) reasons.push(t('Blank screenshots (luminance standard deviation below {threshold}): {files}.', { threshold: config.blank_std, files: blank.map(e => `${e.path} (${e.summary!.luminanceStddev.toFixed(4)})`).join(', ') }));
  if (dark.length) reasons.push(t('Dark screenshots: {files}.', { files: dark.map(e => `${e.path} (mean ${e.summary!.meanLuminance.toFixed(4)}, dark ${((e.summary!.darkFraction) * 100).toFixed(1)}%)`).join(', ') }));
  if (skipped.length) reasons.push(t('Skipped PNGs over 64 MB: {files}.', { files: skipped.map(e => e.path).join(', ') }));
  for (const entry of undecoded) reasons.push(`${entry.path}: ${entry.reason}.`);
  const status: VerifyStatus = mismatches.length || duplicatePairs.length || blank.length ? 'fail' : dark.length || skipped.length || undecoded.some(e => e.format === 'PNG') ? 'warn' : 'pass';
  const reason = [t('Checked {count} screenshot image(s).', { count: entries.length }), ...reasons].join(' ');
  return { name: 'screenshots', status, reason, details: { files: detailFiles, ...(duplicatePairs.length ? { duplicate_pairs: duplicatePairs } : {}) } };
}

function latestReady(doc: OrderDoc): { report: Report; run?: Run } | undefined {
  const report = [...doc.reports].reverse().find(r => r.status === 'ready');
  if (!report) return undefined;
  return { report, run: report.run ? doc.runs.find(r => r.id === report.run) : undefined };
}

export function verifyOrder(project: ProjectConfig, orders: Orders, tag: string, options: { record?: boolean; manual?: boolean } = {}): VerifyReport {
  globMemo.clear();
  const doc = orders.get(tag);
  const current = latestReady(doc);
  const at = new Date().toISOString();
  const results: VerifyItem[] = [];
  if (!current) {
    results.push({ name: 'report', status: 'fail', reason: 'The order has no ready report.' });
    return { tag: doc.order.tag, at, results, ok: false, exitCode: 1 };
  }
  const report = current.report;
  const run = current.run;
  let sections: OrderSections = { acceptance: [], evidence: [], allow: [], deny: [], maxLines: [], warnings: ['Order has no work-order file.'], };
  try { const file = findOrderFile(project.work_orders, tag); sections = parseOrderSections(readFileSync(file, 'utf8'), file); } catch { /* section warnings are sufficient */ }
  for (const warning of sections.warnings) results.push({ name: 'order', status: 'warn', reason: warning, ...(sections.file ? { file: sections.file } : {}) });

  let worktree: string, base: string;
  try { worktree = doc.order.worktree ?? planWorktree(project, doc.order).path; base = orderBaseRef(project, doc.order); }
  catch (e) {
    results.push({ name: 'repository', status: 'fail', reason: (e as Error).message.split('\n')[0] });
    const out: VerifyReport = { tag: doc.order.tag, at, run: run?.id, results, ok: false, exitCode: 1 };
    if (options.record !== false && (options.manual || !orders.store.events({ tag: doc.order.tag }).some(x => x.type === 'order-verified' && x.data?.run === run?.id))) orders.record(doc.order.tag, 'order-verified', { run: run?.id, ok: false, results });
    return out;
  }
  const commits = report.commits;
  const missing: string[] = [], onBase: string[] = [];
  for (const commit of commits) {
    const exists = git(worktree, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]).code === 0;
    if (!exists) { missing.push(commit); continue; }
    if (git(worktree, ['merge-base', '--is-ancestor', commit, base]).code === 0) onBase.push(commit);
  }
  results.push({ name: 'report', status: missing.length || onBase.length ? 'fail' : 'pass', reason: missing.length ? `Commit(s) do not exist: ${short(missing)}.` : onBase.length ? `Commit(s) are already on the base branch: ${short(onBase)}.` : 'All reported commits exist on the order branch and are not on the base branch.' });

  const started = run?.started ? Date.parse(run.started) : Date.now();
  const firstStarted = Math.min(started, ...doc.runs.map(r => Date.parse(r.started)).filter(Number.isFinite));
  const evidenceFiles = [...report.evidence];
  const stale: string[] = [], absent: string[] = [], carried: string[] = [], directories: string[] = [];
  for (const evidence of evidenceFiles) {
    const resolved = resolveEvidence(evidence, worktree, project.root);
    const state = evidenceFreshness(resolved, started, firstStarted);
    if (state.directory) directories.push(`${evidence} (${state.directory})`);
    if (state.missing) absent.push(evidence);
    else if (!state.fresh) (state.carried ? carried : stale).push(evidence);
  }
  const evidenceReasons: string[] = [];
  if (absent.length) evidenceReasons.push(`Evidence file(s) are missing: ${short(absent)}.`);
  if (stale.length) evidenceReasons.push(`Evidence file(s) are stale (older than the order's first run start): ${short(stale)}. ${FRESHNESS_REPAIR}`);
  if (carried.length) evidenceReasons.push(`Evidence carried over from an earlier run of this order: ${short(carried)}.`);
  if (!evidenceReasons.length) evidenceReasons.push('All reported evidence files exist and are fresh.');
  if (directories.length) evidenceReasons.push(`Directories: ${directories.join('; ')}.`);
  results.push({ name: 'evidence', status: absent.length || stale.length ? 'fail' : carried.length ? 'warn' : 'pass', reason: evidenceReasons.join(' ') });
  const requiredMissing: string[] = [], requiredStale: string[] = [], requiredCarried: string[] = [], requiredDetails: string[] = [];
  for (const req of sections.evidence) {
    const candidates = [...new Set([...filesForGlob(worktree, req.path, globMemo, true), ...filesForGlob(project.root, req.path, globMemo, true)])].map(f => {
      const inWorktree = path.resolve(worktree, f);
      return existsSync(inWorktree) ? inWorktree : path.resolve(project.root, f);
    });
    const states = candidates.map(file => ({ file, ...evidenceFreshness(file, started, firstStarted) }));
    const fresh = states.filter(s => s.fresh), reused = states.filter(s => !s.fresh && s.carried);
    const describe = (s: typeof states[number]) => s.file + (s.directory ? ` (${s.directory})` : '');
    if (fresh.length) requiredDetails.push(`Fresh files for ${req.path}: ${short(fresh.map(describe))}; ${states.length - fresh.length} leftover match(es) (${reused.length} carried over).`);
    else if (reused.length) {
      requiredCarried.push(req.path);
      requiredDetails.push(`Files carried over from an earlier run of this order: ${short(reused.map(describe))}; ${states.length - reused.length} stale or empty leftover match(es).`);
    } else {
      if (!states.some(state => !state.missing)) requiredMissing.push(req.path);
      else requiredStale.push(req.path);
      const dirs = states.filter(s => s.directory);
      if (dirs.length) requiredDetails.push(`Directories: ${short(dirs.map(describe))}.`);
    }
  }
  if (requiredMissing.length) requiredDetails.push(`Required evidence is missing: ${short(requiredMissing)}.`);
  if (requiredStale.length) requiredDetails.push(`Required evidence is stale (older than the order's first run start): ${short(requiredStale)}. ${FRESHNESS_REPAIR}`);
  if (!sections.evidence.length) requiredDetails.push('The order declares no required evidence.');
  results.push({ name: 'required evidence', status: requiredMissing.length || requiredStale.length ? 'fail' : requiredCarried.length || !sections.evidence.length ? 'warn' : 'pass', reason: requiredDetails.join(' ') });

  const screenshots = screenshotGate(project, worktree, sections, report);
  if (screenshots) results.push(screenshots);

  const diff = changed(worktree, base);
  const protectedHits = diff.filter(f => (project.verify?.protected_gates ?? []).some(g => match(g, f.path))).map(f => f.path);
  results.push({ name: 'tampering', status: protectedHits.length ? 'fail' : 'pass', reason: protectedHits.length ? `Changed protected gate file(s): ${short(protectedHits)}; only a person can accept.` : 'No protected gate files changed.' });
  const denied = diff.filter(f => sections.deny.some(g => match(g, f.path))).map(f => f.path);
  const outside = sections.allow.length ? diff.filter(f => !sections.allow.some(g => match(g, f.path))).map(f => f.path) : [];
  const over = sections.maxLines.flatMap(rule => diff.filter(f => match(rule.glob, f.path) && f.added + f.removed > rule.max).map(f => `${f.path} (${f.added + f.removed} > ${rule.max})`));
  results.push({ name: 'paths', status: denied.length || outside.length || over.length ? 'fail' : 'pass', reason: denied.length ? `Denied path(s) changed: ${short(denied)}.` : outside.length ? `Changed file(s) are outside allow: ${short(outside)}.` : over.length ? `Line limit exceeded: ${short(over)}.` : 'Changed files satisfy the order path rules.' });

  try {
    const check = runCheck(project, orders, tag, [], worktree);
    results.push({ name: 'check', status: check.exitCode === 0 ? 'pass' : 'fail', reason: check.exitCode === 0 ? 'Existing alba checks passed.' : 'Existing alba checks failed.' });
  } catch (e) { results.push({ name: 'check', status: 'fail', reason: (e as Error).message.split('\n')[0] }); }
  try {
    if (!doc.order.branch) throw new Error('The order has no branch for merge readiness.');
    const readiness = mergeReadiness({ repo: project.root, tag, branch: doc.order.branch, baseRef: base, peers: [], now: at }, systemReadiness);
    results.push({ name: 'merge readiness', status: readiness.conflicts ? 'fail' : 'pass', reason: readiness.conflicts ? `Merge conflicts: ${short(readiness.conflictFiles)}.` : 'The branch merges cleanly into its base.' });
  } catch (e) { results.push({ name: 'merge readiness', status: 'fail', reason: (e as Error).message.split('\n')[0] }); }
  const out: VerifyReport = { tag: doc.order.tag, at, run: run?.id, results, ok: results.every(r => r.status !== 'fail'), exitCode: results.some(r => r.status === 'fail') ? 1 : 0 };
  if (options.record !== false) {
    const existing = orders.store.events({ tag: doc.order.tag }).some(e => e.type === 'order-verified' && (!run?.id || e.data?.run === run.id));
    if (options.manual || !existing) orders.record(doc.order.tag, 'order-verified', { run: run?.id, ok: out.ok, results: out.results });
  }
  return out;
}

export function formatVerify(report: VerifyReport): string {
  return [t('alba verify {tag}', { tag: report.tag }), ...report.results.map(r => `  ${t('{status}  {name}: {reason}', { status: r.status.toUpperCase(), name: r.name, reason: `${r.reason}${r.file ? ` (${r.file})` : ''}` })}`), report.ok ? t('All gates passed.') : t('One or more gates failed.')].join('\n');
}
