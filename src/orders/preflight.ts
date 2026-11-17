import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { globToRegExp } from '../check/general.ts';
import type { ProjectConfig } from '../config.ts';
import { removeTreeSync } from '../fs/remove-tree.mjs';
import type { OrderDoc, Stage } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { namedPaths } from '../producer/drafting.ts';
import { orderBaseRef } from '../review/readiness.ts';
import { findOrderFile } from '../run/prompt.ts';
import { parseOrderSections } from '../verify/verify.ts';
import { findSectionHeadings, normalizeSectionHeading, resolveOrderTemplate } from './templates.ts';

export type PreflightCode = 'file' | 'sections' | 'paths' | 'needs' | 'tool-dirs' | 'checks';
export type PreflightSeverity = 'hold' | 'warn';

export interface PreflightProblem {
  code: PreflightCode;
  severity: PreflightSeverity;
  text: string;
  fix: string;
}

export interface PreflightCheckRun {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  code?: number | null;
  reason?: string;
  output?: string;
}

export interface PreflightResult {
  tag: string;
  stage: Stage;
  ok: boolean;
  hash: string;
  base: string;
  baseHead: string;
  waitingNeeds?: string[];
  checksWaiting?: boolean;
  checksExecuted?: boolean;
  problems: PreflightProblem[];
  checks?: PreflightCheckRun[];
}

export interface PreflightOptions {
  /** Record a `preflight-checked` event on the order. */
  record?: boolean;
  /** Run only check 4 (`needs`), used by the tick for `waiting-needs` orders. */
  needsOnly?: boolean;
  /** Whether check commands may execute in a scratch checkout when `run_checks` is enabled (default true; false on dry-run ticks or when the per-pass budget is spent). */
  runChecks?: boolean;
  /** Ignore cached check-command results for the current file hash and run them fresh (used by `alba orders preflight`). */
  forceChecks?: boolean;
  /** Whether a file without `## Acceptance` bullets is a `file` hold (default true; false in tick gather when `orders:` is absent). */
  requireAcceptance?: boolean;
}

const READING_HEADING = /(?:read|background|context|reference|report)/i;
const COMMAND_BULLET = /^command\s*:\s*(`+)(.+?)\1(?:\s|$)/i;
const COMMAND_PATH_EXT = /\.(?:[cm]?[jt]sx?|py|sh|ps1|cmd|bat|exe|md|json|ya?ml|toml|xml|html|css|cs|cpp|cc|c|h|hpp|rs|go|lua|gd|uproject|uasset|umap|png|jpe?g|txt|log|sql)$/i;

export function readOrderFileWithHash(project: ProjectConfig, tag: string): { file?: string; hash: string; body: string } {
  let file: string | undefined;
  try {
    file = findOrderFile(project.work_orders, tag);
  } catch {
    return { hash: '', body: '' };
  }
  const bytes = readFileSync(file);
  return {
    file,
    hash: createHash('sha256').update(bytes).digest('hex'),
    body: bytes.toString('utf8'),
  };
}

function resolveBaseHead(root: string, baseRef: string): string {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function baseObjectTypes(root: string, baseRef: string, paths: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  if (!paths.length) return found;
  try {
    const input = paths.map(p => `${baseRef}:${p}`).join('\n') + '\n';
    const out = execFileSync('git', ['--no-optional-locks', '-C', root, 'cat-file', '--batch-check'], {
      input,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = out.split(/\r?\n/);
    for (let i = 0; i < paths.length; i++) {
      const line = lines[i] ?? '';
      if (!line || line.endsWith(' missing')) continue;
      const parts = line.split(' ');
      if (parts.length >= 2) found.set(paths[i], parts[1]);
    }
  } catch {
    for (const rel of paths) {
      try {
        const kind = execFileSync('git', ['--no-optional-locks', '-C', root, 'cat-file', '-t', `${baseRef}:${rel}`], {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (kind) found.set(rel, kind);
      } catch { /* absent */ }
    }
  }
  return found;
}

function nonReadingBody(markdown: string): string {
  let h2 = '';
  let h3 = '';
  let h2Norm = '';
  const kept: string[] = [];
  for (const raw of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m2 = /^##\s+(.+?)\s*$/i.exec(raw);
    if (m2) {
      h2 = m2[1];
      h3 = '';
      h2Norm = normalizeSectionHeading(m2[1]);
      continue;
    }
    const m3 = /^#{3,6}\s+(.+?)\s*$/i.exec(raw);
    if (m3) {
      h3 = m3[1];
      continue;
    }
    if (h2Norm === 'paths' || READING_HEADING.test(h2) || READING_HEADING.test(h3)) continue;
    kept.push(raw);
  }
  return kept.join('\n');
}

function normalizeRepoRelPath(raw: string): string | undefined {
  if (!raw || raw.startsWith('-') || raw.startsWith('@')) return undefined;
  const slash = raw.replace(/\\/g, '/').replace(/[.:!?]+$/, '');
  if (path.isAbsolute(slash) || slash.startsWith('/') || slash.startsWith('../') || slash.includes('/../') || /^[A-Za-z]:/.test(slash)) return undefined;
  const clean = slash.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/.test(clean)) return undefined;
  return clean;
}

export function extractCheckCommands(markdown: string, acceptanceBullets: readonly string[]): string[] {
  const commands: string[] = [];
  let section = '';
  let fence = '';
  for (const raw of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (fence) {
      if (new RegExp(`^\\s*${fence}\\s*$`).test(raw)) {
        fence = '';
        continue;
      }
      if (section === 'checks') {
        const trimmed = raw.trim();
        if (trimmed && !trimmed.startsWith('#')) commands.push(trimmed);
      }
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (open) {
      fence = open[1];
      continue;
    }
    const h = /^##\s+(.+?)\s*$/i.exec(raw);
    if (h) {
      section = normalizeSectionHeading(h[1]);
      continue;
    }
  }
  for (const bullet of acceptanceBullets) {
    const m = COMMAND_BULLET.exec(bullet.trim());
    if (m && m[2].trim()) commands.push(m[2].trim());
  }
  return commands;
}

function commandCandidatePaths(command: string): string[] {
  const cleaned = command
    .replace(/https?:\/\/[^\s<>`)]+/g, ' ')
    .replace(/\\[nrt0"'\\]/g, ' ');
  const base = namedPaths(cleaned);
  const tokens = (cleaned.match(/[^\s`<>"'()[\],;]+/g) ?? [])
    .map(tok => tok.replace(/[.:!?]+$/, ''))
    .filter(tok => !/[{}*?]/.test(tok) && (COMMAND_PATH_EXT.test(tok) || tok.startsWith('./')));
  const out: string[] = [];
  for (const candidate of [...base, ...tokens]) {
    if (!COMMAND_PATH_EXT.test(candidate) && !candidate.startsWith('./')) continue;
    const rel = normalizeRepoRelPath(candidate);
    if (rel && !out.includes(rel)) out.push(rel);
  }
  return out;
}

function removeScratchCheckoutSync(root: string, folder: string): string | undefined {
  try {
    execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', '--force', folder], {
      timeout: 60_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return undefined;
  } catch {
    let cleanupProblem: string | undefined;
    removeTreeSync(folder, { onError: (msg: string) => { cleanupProblem = msg; } });
    try {
      execFileSync('git', ['-C', root, 'worktree', 'prune'], {
        timeout: 60_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      cleanupProblem ??= `Scratch prune deferred: ${(error as Error).message}`;
    }
    if (!cleanupProblem && existsSync(folder)) cleanupProblem = `Scratch folder still exists: ${folder}`;
    return cleanupProblem;
  }
}

function runChecksInScratch(
  project: ProjectConfig,
  tag: string,
  baseHead: string,
  runnable: readonly string[],
  timeoutSeconds: number,
): { runs: PreflightCheckRun[]; problems: PreflightProblem[] } {
  const folder = path.join(project.state_dir, 'preflight', tag);
  const runs: PreflightCheckRun[] = [];
  const problems: PreflightProblem[] = [];
  if (existsSync(folder)) removeScratchCheckoutSync(project.root, folder);
  mkdirSync(path.dirname(folder), { recursive: true });
  try {
    execFileSync('git', ['-C', project.root, 'worktree', 'add', '--detach', folder, baseHead], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    removeScratchCheckoutSync(project.root, folder);
    const err = error as { stderr?: string; stdout?: string; message: string };
    const detail = `${err.stderr ?? ''}\n${err.stdout ?? ''}`.trim() || err.message;
    problems.push({
      code: 'checks',
      severity: 'hold',
      text: `Could not create preflight checkout at ${folder}: ${detail.split(/\r?\n/)[0]}`,
      fix: `Command: git worktree add --detach ${folder} ${baseHead.slice(0, 7)}\n${detail.split(/\r?\n/).slice(-20).join('\n')}`,
    });
    return { runs, problems };
  }

  try {
    if (project.dispatch.provision?.length) {
      const [program, ...args] = project.dispatch.provision;
      const provCmd = project.dispatch.provision.join(' ');
      const prov = spawnSync(program, args, {
        cwd: folder,
        encoding: 'utf8',
        timeout: timeoutSeconds * 1000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timedOut = (prov.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      if (timedOut || prov.status !== 0 || prov.error) {
        const code = timedOut ? null : (prov.status ?? 1);
        const combined = `${prov.stdout ?? ''}${prov.stderr ?? ''}`.trim() || (prov.error?.message ?? '');
        const tail = combined ? combined.split(/\r?\n/).slice(-20).join('\n') : '';
        runs.push({ command: provCmd, status: 'failed', code, ...(tail ? { output: tail } : {}) });
        problems.push({
          code: 'checks',
          severity: 'hold',
          text: timedOut ? `Provision command timed out after ${timeoutSeconds}s: ${provCmd}` : `Provision command exited ${code}: ${provCmd}`,
          fix: [`Command: ${provCmd} (${timedOut ? `timed out after ${timeoutSeconds}s` : `exit ${code}`})`, ...(tail ? [tail] : [])].join('\n'),
        });
        return { runs, problems };
      }
    }

    for (const command of runnable) {
      const r = spawnSync(command, {
        cwd: folder,
        shell: true,
        encoding: 'utf8',
        timeout: timeoutSeconds * 1000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      if (!timedOut && r.status === 0 && !r.error) {
        runs.push({ command, status: 'passed', code: 0 });
        continue;
      }
      const code = timedOut ? null : (r.status ?? 1);
      const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || (r.error?.message ?? '');
      const tail = combined ? combined.split(/\r?\n/).slice(-20).join('\n') : '';
      runs.push({ command, status: 'failed', code, ...(tail ? { output: tail } : {}) });
      const exitDesc = timedOut ? `timed out after ${timeoutSeconds}s` : `exit ${code}`;
      problems.push({
        code: 'checks',
        severity: 'hold',
        text: `Check command failed on base ${baseHead.slice(0, 7)} (${exitDesc}): ${command}`,
        fix: [`Command: ${command} (${exitDesc})`, ...(tail ? [tail] : [])].join('\n'),
      });
      break;
    }
  } finally {
    const removalIssue = removeScratchCheckoutSync(project.root, folder);
    if (removalIssue) {
      problems.push({
        code: 'checks',
        severity: 'warn',
        text: `Preflight scratch checkout cleanup warning: ${removalIssue}`,
        fix: `Remove ${folder} and run "git -C ${project.root} worktree prune".`,
      });
    }
  }

  return { runs, problems };
}

function checkNeeds(orders: Orders, doc: OrderDoc, allDocs: readonly OrderDoc[], merged: ReadonlySet<string>): { problems: PreflightProblem[]; waitingNeeds: string[] } {
  const byLower = new Map(allDocs.map(d => [d.order.tag.toLowerCase(), d]));
  const problems: PreflightProblem[] = [];
  const waitingNeeds: string[] = [];
  for (const rawNeed of doc.order.needs) {
    const need = rawNeed.trim();
    if (!need) continue;
    const needed = byLower.get(need.toLowerCase());
    if (!needed) {
      problems.push({
        code: 'needs',
        severity: 'hold',
        text: `Needed order "${need}" is not a known order.`,
        fix: `Drop "${need}" in ${doc.order.tag}'s fields (console or src/orders/edit-fields.ts) or in the dispatch table, or add and close "${need}" if its work is on the base.`,
      });
      continue;
    }
    const neededStage = orders.stage(needed, merged).stage;
    if (neededStage === 'cancelled') {
      problems.push({
        code: 'needs',
        severity: 'hold',
        text: `Needed order "${needed.order.tag}" is cancelled.`,
        fix: `Drop "${needed.order.tag}" in ${doc.order.tag}'s fields (console or src/orders/edit-fields.ts) or in the dispatch table, or close "${needed.order.tag}" if its work is on the base.`,
      });
      continue;
    }
    if (!merged.has(needed.order.tag)) waitingNeeds.push(needed.order.tag);
  }
  return { problems, waitingNeeds };
}

function cachedChecksForHash(orders: Orders, tag: string, hash: string): { checks: PreflightCheckRun[]; problems: PreflightProblem[] } | undefined {
  if (!hash) return undefined;
  const events = orders.store.events({ tag });
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== 'preflight-checked') continue;
    if (ev.data?.hash === hash && ev.data?.checks_executed === true && Array.isArray(ev.data?.checks)) {
      const checkProblems = Array.isArray(ev.data?.problems)
        ? (ev.data.problems as PreflightProblem[]).filter(p => p.code === 'checks')
        : [];
      return { checks: ev.data.checks as PreflightCheckRun[], problems: checkProblems };
    }
  }
  return undefined;
}

/** Runs the preflight checks for one order (`alba orders preflight <TAG>` and the tick gather step). */
export function preflight(project: ProjectConfig, orders: Orders, tag: string, options: PreflightOptions = {}): PreflightResult {
  const doc = orders.get(tag);
  const allDocs = orders.all();
  const merged = orders.mergedSet(allDocs);
  const stage = orders.stage(doc, merged).stage;
  const base = orderBaseRef(project, doc.order);
  const baseHead = resolveBaseHead(project.root, base);
  const baseShort = base.replace(/^refs\/heads\//, '');
  const { file: orderFile, hash, body } = readOrderFileWithHash(project, doc.order.tag);

  const problems: PreflightProblem[] = [];
  let checks: PreflightCheckRun[] | undefined;
  let checksWaiting = false;
  let checksExecuted = false;

  const { problems: needProblems, waitingNeeds } = checkNeeds(orders, doc, allDocs, merged);

  if (options.needsOnly) {
    problems.push(...needProblems);
  } else {
    const sections = orderFile ? parseOrderSections(body, orderFile) : undefined;
    const headings = orderFile ? findSectionHeadings(body) : [];
    const template = resolveOrderTemplate(project, doc.order.kind || 'default', doc.order.tag);

    // 1. file (hold)
    if (!orderFile) {
      problems.push({
        code: 'file',
        severity: 'hold',
        text: `${doc.order.tag} has no work-order file in ${project.work_orders}.`,
        fix: `Write ${path.posix.join(project.work_orders.replace(/\\/g, '/'), `${doc.order.tag}-<slug>.md`)} with a "## Acceptance" bullet list.`,
      });
    } else if (options.requireAcceptance !== false && (!sections || sections.acceptance.length === 0)) {
      problems.push({
        code: 'file',
        severity: 'hold',
        text: `${path.basename(orderFile)} has no "## Acceptance" section with bullet items.`,
        fix: template?.acceptance.length
          ? `## Acceptance\n${template.acceptance.map(b => `- ${b}`).join('\n')}`
          : `Add "## Acceptance" with at least one "- <verifiable condition>" bullet to ${path.basename(orderFile)}.`,
      });
    }

    // 2. sections (warn)
    if (orderFile && sections && template) {
      const presentHeadings = new Set(headings.map(h => h.name));
      if (template.evidence.length > 0 && !presentHeadings.has('evidence') && sections.evidence.length === 0) {
        problems.push({
          code: 'sections',
          severity: 'warn',
          text: `${path.basename(orderFile)} is missing "## Evidence" from the "${template.sourceKind}" template.`,
          fix: `## Evidence\n${template.evidence.map(b => `- ${b}`).join('\n')}`,
        });
      }
      if (template.paths.length > 0 && !presentHeadings.has('paths') && sections.allow.length === 0 && sections.deny.length === 0 && sections.maxLines.length === 0) {
        problems.push({
          code: 'sections',
          severity: 'warn',
          text: `${path.basename(orderFile)} is missing "## Paths" from the "${template.sourceKind}" template.`,
          fix: `## Paths\n${template.paths.map(b => `- ${b}`).join('\n')}`,
        });
      }
    }

    // 3. paths (hold)
    if (orderFile && sections && sections.allow.length > 0 && baseHead) {
      const candidates = namedPaths(nonReadingBody(body))
        .map(normalizeRepoRelPath)
        .filter((p): p is string => p !== undefined);
      const uniqueCandidates = [...new Set(candidates)];
      const existingTypes = baseObjectTypes(project.root, base, uniqueCandidates);
      for (const rel of uniqueCandidates) {
        const objType = existingTypes.get(rel);
        if (!objType) continue;
        const matches = (glob: string) => globToRegExp(glob).test(rel) || (objType === 'tree' && globToRegExp(glob).test(`${rel}/`));
        const allowed = sections.allow.some(matches);
        const denied = sections.deny.some(matches);
        if (!allowed || denied) {
          problems.push({
            code: 'paths',
            severity: 'hold',
            text: denied
              ? `Existing path "${rel}" on ${baseShort} is named outside reading sections and matches a deny: glob in ## Paths.`
              : `Existing path "${rel}" on ${baseShort} is named outside reading sections and does not match any allow: glob in ## Paths.`,
            fix: `- allow: ${rel}`,
          });
        }
      }
    }

    // 4. needs (hold)
    problems.push(...needProblems);

    // 5. tool folders (warn)
    const toolDirs = project.orders?.preflight.tool_dirs;
    if (orderFile && toolDirs && Object.keys(toolDirs).length > 0) {
      const orderKinds = new Set([doc.order.kind.toLowerCase(), ...(doc.order.routing?.kind ? [doc.order.routing.kind.toLowerCase()] : [])].filter(Boolean));
      const normBody = body.replace(/\\/g, '/');
      for (const [tool, spec] of Object.entries(toolDirs)) {
        if (spec.kinds?.length && !spec.kinds.some(k => orderKinds.has(k.toLowerCase()))) continue;
        const normDir = spec.dir.replace(/\\/g, '/').replace(/\/+$/, '');
        if (!normBody.includes(normDir)) {
          problems.push({
            code: 'tool-dirs',
            severity: 'warn',
            text: `${path.basename(orderFile)} does not name tool folder "${spec.dir}" for ${tool}.`,
            fix: `- tool-dir: ${spec.dir} (${tool})`,
          });
        }
      }
    }

    // 6. checks (hold), only when orders.preflight.run_checks is true
    if (orderFile && sections && project.orders?.preflight.run_checks === true) {
      const cached = !options.forceChecks ? cachedChecksForHash(orders, doc.order.tag, hash) : undefined;
      if (cached) {
        checks = cached.checks;
        checksExecuted = true;
        problems.push(...cached.problems);
      } else {
        const extracted = extractCheckCommands(body, sections.acceptance);
        if (extracted.length === 0) {
          checks = [];
          checksExecuted = true;
        } else if (!baseHead) {
          if (options.runChecks !== false) {
            problems.push({
              code: 'checks',
              severity: 'hold',
              text: `Base ref "${base}" could not be resolved in ${project.root} to run preflight check commands.`,
              fix: `Ensure "${base}" exists in ${project.root} or set dispatch.base_ref.`,
            });
          } else {
            checksWaiting = true;
          }
        } else {
          const allCmdPaths = [...new Set(extracted.flatMap(commandCandidatePaths))];
          const cmdPathTypes = baseObjectTypes(project.root, base, allCmdPaths);
          const preRuns: PreflightCheckRun[] = [];
          const runnable: string[] = [];
          for (const cmd of extracted) {
            const cmdPaths = commandCandidatePaths(cmd);
            const missingPath = cmdPaths.find(p => !cmdPathTypes.has(p));
            if (missingPath) {
              preRuns.push({ command: cmd, status: 'skipped', reason: 'skipped: tests what the order creates' });
            } else {
              runnable.push(cmd);
            }
          }
          if (runnable.length === 0) {
            checks = preRuns;
            checksExecuted = true;
          } else if (options.runChecks === false) {
            checksWaiting = true;
          } else {
            const timeout = project.orders?.preflight.check_timeout_seconds ?? 300;
            const executed = runChecksInScratch(project, doc.order.tag, baseHead, runnable, timeout);
            checks = [...preRuns, ...executed.runs];
            checksExecuted = true;
            problems.push(...executed.problems);
          }
        }
      }
    }
  }

  const ok = !problems.some(p => p.severity === 'hold');
  const result: PreflightResult = {
    tag: doc.order.tag,
    stage,
    ok,
    hash,
    base,
    baseHead,
    ...(waitingNeeds.length ? { waitingNeeds } : {}),
    ...(checksWaiting ? { checksWaiting: true } : {}),
    ...(checksExecuted ? { checksExecuted: true } : {}),
    problems,
    ...(checks !== undefined ? { checks } : {}),
  };

  if (options.record) {
    orders.record(doc.order.tag, 'preflight-checked', {
      hash,
      base_head: baseHead,
      ok,
      problems,
      ...(checks !== undefined ? { checks, checks_executed: checksExecuted } : {}),
    });
  }

  return result;
}

export function formatPreflight(result: PreflightResult): string {
  const baseShort = result.base.replace(/^refs\/heads\//, '');
  const lines: string[] = [`${result.tag}: preflight ${result.ok ? 'ok' : 'held'} (stage: ${result.stage}, base: ${baseShort}${result.hash ? `, sha256: ${result.hash.slice(0, 12)}` : ''})`];
  if (result.stage === 'waiting-needs' || result.waitingNeeds?.length) {
    lines.push(`  stage waiting-needs: waiting for ${(result.waitingNeeds ?? []).join(', ') || 'needed orders'} to be merged`);
  }
  for (const p of result.problems) {
    lines.push(`  [${p.severity}] ${p.code}: ${p.text} -> fix: ${p.fix.replace(/\r?\n/g, ' | ')}`);
  }
  for (const c of result.checks ?? []) {
    const suffix = c.reason ? ` (${c.reason})` : c.code !== undefined && c.code !== null ? ` (exit ${c.code})` : '';
    lines.push(`  check [${c.status}]: ${c.command}${suffix}`);
  }
  if (!result.ok) {
    lines.push(`  override: alba orders act ${result.tag} queue --override --note "<why>"`);
  }
  return lines.join('\n');
}
