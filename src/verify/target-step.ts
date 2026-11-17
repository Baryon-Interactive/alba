import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { matchCaptureRecipe } from '../capture/config.ts';
import type { CaptureManifest } from '../capture/types.ts';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import type { AcceptanceTrial, AcceptStepResult } from '../review/acceptance.ts';
import { targetSheet } from '../review/sheet.ts';
import { findOrderFile } from '../run/prompt.ts';
import { decodePng, type DecodedPng } from './png.ts';
import {
  computeBlockTrend,
  computeRowTrend,
  evaluateTargetRule,
  parseTargetSection,
  type TargetBlockTrend,
  type TargetResult,
  type TargetRow,
  type TargetTrend,
} from './target.ts';

export type { TargetResult, TargetRow, TargetTrend, TargetBlockTrend } from './target.ts';

export interface TargetHistoryMetric {
  shot: string;
  metric: string;
  label: string;
  value: number;
  pass: boolean;
  trend?: TargetTrend;
}

export interface TargetHistoryEntry {
  round: number;
  report: number;
  revision: string;
  pass: boolean;
  unmeasured?: string;
  trend?: TargetBlockTrend;
  stalled?: boolean;
  metrics: TargetHistoryMetric[];
  line: string;
}

export interface TargetReviewView {
  tag: string;
  status: 'passed' | 'missed' | 'unmeasured';
  exitCode: 0 | 1 | 2;
  round?: number;
  reason?: string;
  notConverging?: { rounds: number; max: number; reason: string };
  blocks: TargetResult[];
  sheets: string[];
  history: TargetHistoryEntry[];
}

function fmtNum(n: number, metric: string): string {
  return metric === 'motion' ? n.toFixed(2) : n.toFixed(3);
}

function formatHistoryLine(entry: Omit<TargetHistoryEntry, 'line'>): string {
  const rev = entry.revision ? entry.revision.slice(0, 12) : '-';
  if (entry.unmeasured) {
    return `round ${entry.round}  report #${entry.report}  rev ${rev}  UNMEASURED (${entry.unmeasured})`;
  }
  const status = entry.pass ? 'PASS' : 'MISS';
  const badge = entry.stalled ? ' [stalled]' : entry.trend ? ` [${entry.trend}]` : '';
  const cols = entry.metrics.map(m => {
    const val = fmtNum(m.value, m.metric);
    const tr = m.trend ? `,${m.trend}` : '';
    return `${m.shot}:${m.label}=${val}(${m.pass ? 'PASS' : 'MISS'}${tr})`;
  });
  return `round ${entry.round}  report #${entry.report}  rev ${rev}  ${status}${badge}  ${cols.join('  ')}`;
}

function toHistoryEntry(report: number, fallbackRevision: string, blocks: readonly TargetResult[], roundNumber: number): TargetHistoryEntry {
  const revision = blocks.find(b => b.revision)?.revision || fallbackRevision || '';
  const unmeasured = blocks.find(b => b.unmeasured)?.unmeasured;
  const pass = blocks.length > 0 && blocks.every(b => b.pass && !b.unmeasured);
  const stalled = blocks.some(b => b.stalled === true || b.trend === 'stalled');
  const firstTrend = blocks.find(b => b.trend)?.trend;
  const trend: TargetBlockTrend | undefined = stalled ? 'stalled' : firstTrend;
  const metrics: TargetHistoryMetric[] = blocks.flatMap(b =>
    b.rows.map(r => ({
      shot: b.shot,
      metric: r.metric,
      label: r.label,
      value: r.value,
      pass: r.pass,
      ...(r.trend ? { trend: r.trend } : {}),
    })),
  );
  const partial: Omit<TargetHistoryEntry, 'line'> = {
    round: roundNumber,
    report,
    revision,
    pass,
    ...(unmeasured ? { unmeasured } : {}),
    ...(trend ? { trend } : {}),
    ...(stalled ? { stalled: true } : {}),
    metrics,
  };
  return { ...partial, line: formatHistoryLine(partial) };
}

/** Ordered target rounds recorded across reports of `tag` (optionally strictly before `beforeReport`). */
export function targetRoundRecords(
  orders: Orders,
  tag: string,
  beforeReport?: number,
): { report: number; revision: string; blocks: TargetResult[]; entry: TargetHistoryEntry }[] {
  const canonical = orders.get(tag).order.tag;
  const byReport = new Map<number, { report: number; revision: string; blocks: TargetResult[] }>();
  for (const ev of orders.store.events({ tag: canonical })) {
    if (ev.type !== 'accept-trial' || !ev.data) continue;
    const trial = ev.data as unknown as AcceptanceTrial;
    if (typeof trial.report !== 'number' || !Number.isFinite(trial.report)) continue;
    if (beforeReport !== undefined && trial.report >= beforeReport) continue;
    const step = Array.isArray(trial.steps) ? trial.steps.find(s => s.name === 'target' && Array.isArray(s.target) && s.target.length > 0) : undefined;
    if (!step?.target?.length) continue;
    byReport.set(trial.report, { report: trial.report, revision: trial.branch ?? '', blocks: step.target });
  }
  const ordered = [...byReport.values()].sort((a, b) => a.report - b.report);
  return ordered.map((item, idx) => ({
    ...item,
    entry: toHistoryEntry(item.report, item.revision, item.blocks, item.blocks[0]?.round ?? idx + 1),
  }));
}

export function formatTargetHistory(history: readonly TargetHistoryEntry[]): string {
  if (!history.length) return '  (no rounds recorded)';
  return history.map(h => `  ${h.line}`).join('\n');
}

export function formatTargetBlocks(tag: string, blocks: readonly TargetResult[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    const headBits = [
      `${tag} shot ${b.shot} (round ${b.round}${b.revision ? `, rev ${b.revision.slice(0, 12)}` : ''}${b.reference ? `, ref ${b.reference}` : ''})`,
      b.unmeasured ? 'UNMEASURED' : b.pass ? 'PASS' : 'MISS',
      ...(b.stalled ? ['[stalled]'] : b.trend ? [`[${b.trend}]`] : []),
    ];
    lines.push(headBits.join('  '));
    if (b.unmeasured) {
      lines.push(`  unmeasured: ${b.unmeasured}`);
    } else {
      for (const r of b.rows) {
        const refPart = r.reference !== undefined ? `  ref ${fmtNum(r.reference, r.metric)}` : '';
        const trendPart = r.trend ? `  [${r.trend}]` : '';
        lines.push(`  ${r.pass ? 'PASS' : 'MISS'}  ${r.metric.padEnd(10)}  ${r.label}: ${fmtNum(r.value, r.metric)}${refPart}  (${r.bound})${trendPart}`);
      }
    }
    if (b.sheet) lines.push(`  sheet: ${b.sheet}`);
  }
  return lines.join('\n');
}

export function summarizeTargetFailure(blocks: readonly TargetResult[]): string {
  const unmeasured = blocks.filter(b => b.unmeasured);
  if (unmeasured.length) {
    return unmeasured.map(b => `unmeasured (${b.shot}): ${b.unmeasured}`).join('; ');
  }
  const missed = blocks.flatMap(b =>
    b.rows.filter(r => !r.pass).map(r => `${b.shot} ${r.label} ${fmtNum(r.value, r.metric)} (${r.bound})`),
  );
  return missed.length ? `missed target: ${missed.join('; ')}` : 'visual target missed';
}

function readGitBlob(repoRoot: string, commit: string, repoPath: string): { ok: true; data: Buffer } | { ok: false; reason: string } {
  try {
    const data = execFileSync('git', ['--no-optional-locks', '-C', repoRoot, 'show', `${commit}:${repoPath}`], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, data };
  } catch {
    return { ok: false, reason: `reference "${repoPath}" is absent on base commit ${commit.slice(0, 12)}` };
  }
}

class UnmeasuredShotError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Run the `target` acceptance step right after `capture` in `trialAcceptance` when the order has a `## Target` section.
 */
export function runTargetStep(
  project: ProjectConfig,
  orders: Orders,
  tag: string,
  trial: AcceptanceTrial,
): AcceptStepResult | undefined {
  if (trial.retryable) return undefined;
  if (trial.steps.some(s => s.name !== 'capture' && s.status === 'failed')) return undefined;

  const doc = orders.get(tag);
  let markdown: string;
  try {
    const orderFile = findOrderFile(project.work_orders, doc.order.tag);
    markdown = readFileSync(orderFile, 'utf8');
  } catch {
    return undefined;
  }

  const parsed = parseTargetSection(markdown);
  if (!parsed.blocks.length) return undefined;

  const started = Date.now();
  const earlier = targetRoundRecords(orders, doc.order.tag, trial.report);
  const round = 1 + earlier.length;
  const previousBlocks = earlier.at(-1)?.blocks;

  const captureStep = trial.steps.find(s => s.name === 'capture');
  const manifestPath = captureStep?.capture?.manifest ?? (trial.log_dir ? path.join(trial.log_dir, 'capture', 'manifest.json') : '');
  let manifest: CaptureManifest | undefined;
  if (manifestPath && existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CaptureManifest;
    } catch {
      manifest = undefined;
    }
  }

  const matchedRecipe = matchCaptureRecipe(project, doc);
  const noCaptureReason = !matchedRecipe
    ? `no capture recipe matched order ${doc.order.tag}`
    : !captureStep
      ? 'no capture step ran in this trial'
      : 'capture manifest is missing or unreadable';

  const decodedShots = new Map<string, { ok: true; image: DecodedPng } | { ok: false; unmeasured: string }>();
  const getShot = (shotName: string): { ok: true; image: DecodedPng } | { ok: false; unmeasured: string } => {
    const cached = decodedShots.get(shotName);
    if (cached) return cached;
    if (!manifest || !manifestPath) {
      const res = { ok: false as const, unmeasured: noCaptureReason };
      decodedShots.set(shotName, res);
      return res;
    }
    const shotEntry = manifest.shots.find(s => s.name === shotName);
    if (!shotEntry) {
      const res = { ok: false as const, unmeasured: `shot "${shotName}" is missing from capture manifest (${manifest.recipe})` };
      decodedShots.set(shotName, res);
      return res;
    }
    if (shotEntry.status !== 'ok') {
      const res = { ok: false as const, unmeasured: `shot "${shotName}" failed in capture manifest: ${shotEntry.reason || 'shot failed'}` };
      decodedShots.set(shotName, res);
      return res;
    }
    const filePath = path.resolve(path.dirname(manifestPath), shotEntry.file);
    if (!existsSync(filePath)) {
      const res = { ok: false as const, unmeasured: `captured file for shot "${shotName}" does not exist (${shotEntry.file})` };
      decodedShots.set(shotName, res);
      return res;
    }
    let decoded;
    try {
      decoded = decodePng(readFileSync(filePath));
    } catch (e) {
      const res = { ok: false as const, unmeasured: `decode error on shot "${shotName}": ${(e as Error).message}` };
      decodedShots.set(shotName, res);
      return res;
    }
    if (decoded.status !== 'ok') {
      const res = { ok: false as const, unmeasured: `decode error on shot "${shotName}": ${decoded.reason}` };
      decodedShots.set(shotName, res);
      return res;
    }
    const res = { ok: true as const, image: decoded.image };
    decodedShots.set(shotName, res);
    return res;
  };

  const decodedRefs = new Map<string, { ok: true; image: DecodedPng } | { ok: false; unmeasured: string }>();
  const getReference = (refPath: string): { ok: true; image: DecodedPng } | { ok: false; unmeasured: string } => {
    const cached = decodedRefs.get(refPath);
    if (cached) return cached;
    if (!trial.base) {
      const res = { ok: false as const, unmeasured: `base commit is unknown for reference "${refPath}"` };
      decodedRefs.set(refPath, res);
      return res;
    }
    const blob = readGitBlob(project.root, trial.base, refPath);
    if (!blob.ok) {
      const res = { ok: false as const, unmeasured: blob.reason };
      decodedRefs.set(refPath, res);
      return res;
    }
    const decoded = decodePng(blob.data);
    if (decoded.status !== 'ok') {
      const res = { ok: false as const, unmeasured: `decode error on reference "${refPath}": ${decoded.reason}` };
      decodedRefs.set(refPath, res);
      return res;
    }
    const res = { ok: true as const, image: decoded.image };
    decodedRefs.set(refPath, res);
    return res;
  };

  const revision = manifest?.revision || captureStep?.capture?.revision || trial.branch || '';
  const results: TargetResult[] = [];

  for (let bIdx = 0; bIdx < parsed.blocks.length; bIdx++) {
    const block = parsed.blocks[bIdx]!;
    const prevBlock = previousBlocks?.[bIdx]?.shot === block.shot
      ? previousBlocks[bIdx]
      : previousBlocks?.find(p => p.shot === block.shot);

    if (block.unmeasured) {
      results.push({
        shot: block.shot,
        reference: block.reference ?? '',
        revision,
        rows: [],
        pass: false,
        unmeasured: block.unmeasured,
        sheet: '',
        round,
      });
      continue;
    }

    if (!captureStep || !manifest) {
      results.push({
        shot: block.shot,
        reference: block.reference ?? '',
        revision,
        rows: [],
        pass: false,
        unmeasured: noCaptureReason,
        sheet: '',
        round,
      });
      continue;
    }

    const shotRes = getShot(block.shot);
    if (!shotRes.ok) {
      results.push({
        shot: block.shot,
        reference: block.reference ?? '',
        revision,
        rows: [],
        pass: false,
        unmeasured: shotRes.unmeasured,
        sheet: '',
        round,
      });
      continue;
    }

    let refImage: DecodedPng | undefined;
    if (block.reference) {
      const refRes = getReference(block.reference);
      if (!refRes.ok) {
        results.push({
          shot: block.shot,
          reference: block.reference,
          revision,
          rows: [],
          pass: false,
          unmeasured: refRes.unmeasured,
          sheet: '',
          round,
        });
        continue;
      }
      refImage = refRes.image;
    }

    let sheetPath = '';
    if (refImage && trial.log_dir) {
      const structRule = block.rows.find(r => r.metric === 'structure');
      const [cols, rows] = structRule?.cells ?? [16, 9];
      const outFile = path.join(trial.log_dir, 'target', `${block.shot}.png`);
      sheetPath = targetSheet(refImage, shotRes.image, outFile, { cols, rows }).out;
    }

    let unmeasuredDuringRows: string | undefined;
    const measuredRows: TargetRow[] = [];

    for (let rIdx = 0; rIdx < block.rows.length; rIdx++) {
      const rule = block.rows[rIdx]!;
      try {
        const row = evaluateTargetRule(rule, shotRes.image, refImage, name => {
          const s = getShot(name);
          if (!s.ok) throw new UnmeasuredShotError(s.unmeasured);
          return s.image;
        });
        if (prevBlock) {
          const prevRow = prevBlock.rows[rIdx]?.metric === row.metric && prevBlock.rows[rIdx]?.label === row.label
            ? prevBlock.rows[rIdx]
            : prevBlock.rows.find(pr => pr.metric === row.metric && pr.label === row.label);
          if (prevRow) {
            row.trend = computeRowTrend(rule, row, prevRow.value);
          }
        }
        measuredRows.push(row);
      } catch (e) {
        unmeasuredDuringRows = e instanceof UnmeasuredShotError ? e.message : `decode/measurement error: ${(e as Error).message}`;
        break;
      }
    }

    if (unmeasuredDuringRows) {
      results.push({
        shot: block.shot,
        reference: block.reference ?? '',
        revision,
        rows: [],
        pass: false,
        unmeasured: unmeasuredDuringRows,
        sheet: sheetPath,
        round,
      });
      continue;
    }

    const { trend, stalled } = computeBlockTrend(measuredRows, prevBlock?.trend);
    const pass = measuredRows.length > 0 && measuredRows.every(r => r.pass);
    results.push({
      shot: block.shot,
      reference: block.reference ?? '',
      revision,
      rows: measuredRows,
      pass,
      sheet: sheetPath,
      round,
      ...(trend ? { trend } : {}),
      ...(stalled ? { stalled: true } : {}),
    });
  }

  const allPass = results.length > 0 && results.every(b => b.pass && !b.unmeasured);
  const anyUnmeasured = results.some(b => !!b.unmeasured);
  const tailText = formatTargetBlocks(doc.order.tag, results);

  let logFile: string | undefined;
  if (trial.log_dir) {
    const targetDir = path.join(trial.log_dir, 'target');
    mkdirSync(targetDir, { recursive: true });
    logFile = path.join(targetDir, 'target.json');
    writeFileSync(logFile, JSON.stringify(results, null, 2) + '\n', 'utf8');
  }

  const stepResult: AcceptStepResult = {
    name: 'target',
    status: allPass ? 'passed' : 'failed',
    duration_ms: Date.now() - started,
    code: allPass ? 0 : anyUnmeasured ? 2 : 1,
    tail: tailText,
    ...(logFile ? { log: logFile } : {}),
    target: results,
  };

  trial.steps.push(stepResult);
  orders.record(doc.order.tag, 'accept-step', { trial: trial.id, ...stepResult });

  if (stepResult.status === 'failed' && trial.status !== 'failed') {
    trial.status = 'failed';
    trial.reason = `Step target failed: ${summarizeTargetFailure(results)}`;
  }

  return stepResult;
}

/** Read-only CLI view for `alba review <TAG> target [--json]`. */
export function reviewTarget(project: ProjectConfig, orders: Orders, tag: string): TargetReviewView {
  const doc = orders.get(tag);
  const canonical = doc.order.tag;
  const records = targetRoundRecords(orders, canonical);
  const history = records.map(r => r.entry);
  const latest = records.at(-1);

  if (!latest) {
    let reason = `No target measurements recorded for ${canonical}.`;
    try {
      const orderFile = findOrderFile(project.work_orders, canonical);
      const parsed = parseTargetSection(readFileSync(orderFile, 'utf8'));
      if (!parsed.blocks.length) reason = `Order ${canonical} has no ## Target section.`;
      else if (parsed.warnings.length) reason = parsed.warnings.join('; ');
    } catch { /* keep default reason */ }
    return {
      tag: canonical,
      status: 'unmeasured',
      exitCode: 2,
      reason,
      blocks: [],
      sheets: [],
      history: [],
    };
  }

  const blocks = latest.blocks;
  const sheets = blocks.map(b => b.sheet).filter(Boolean);
  const unmeasured = blocks.find(b => b.unmeasured)?.unmeasured;
  const allPass = blocks.length > 0 && blocks.every(b => b.pass && !b.unmeasured);
  const status: TargetReviewView['status'] = unmeasured ? 'unmeasured' : allPass ? 'passed' : 'missed';
  const exitCode: 0 | 1 | 2 = status === 'passed' ? 0 : status === 'missed' ? 1 : 2;

  const ncEvent = orders.store
    .events({ tag: canonical })
    .filter(e => e.type === 'target-not-converging' && e.data?.report === latest.report)
    .at(-1);
  const notConverging = ncEvent?.data
    ? {
        rounds: Number(ncEvent.data.rounds) || history.length,
        max: Number(ncEvent.data.max) || 0,
        reason: String(ncEvent.data.reason ?? ''),
      }
    : undefined;

  return {
    tag: canonical,
    status,
    exitCode,
    round: blocks[0]?.round ?? history.length,
    ...(unmeasured ? { reason: unmeasured } : {}),
    ...(notConverging ? { notConverging } : {}),
    blocks,
    sheets,
    history,
  };
}

export function formatReviewTarget(view: TargetReviewView): string {
  const lines: string[] = [
    `${view.tag} target: ${view.status.toUpperCase()}${view.round ? ` (round ${view.round})` : ''}${view.reason ? ` - ${view.reason}` : ''}`,
  ];
  if (view.notConverging) {
    const nc = view.notConverging;
    lines.push(
      nc.reason === 'not converging'
        ? `Not converging after ${nc.rounds} rounds (max_visual_rounds: ${nc.max}).`
        : `To the lead: ${nc.reason}.`,
    );
  }
  if (view.blocks.length) {
    lines.push(formatTargetBlocks(view.tag, view.blocks));
  }
  if (view.sheets.length) {
    lines.push('Sheets:');
    for (const s of view.sheets) lines.push(`  ${s}`);
  }
  if (view.history.length) {
    lines.push('History:');
    lines.push(formatTargetHistory(view.history));
  }
  return lines.join('\n');
}
