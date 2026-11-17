import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { matchCaptureRecipe } from '../capture/config.ts';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { reviewOf } from '../producer/producer.ts';
import type { AcceptanceTrial } from '../review/acceptance.ts';
import { rework, reworkCount } from '../run/review.ts';
import {
  formatTargetHistory,
  targetRoundRecords,
  type TargetHistoryEntry,
  type TargetResult,
  type TargetRow,
} from './target-step.ts';

function parseWithinTolerance(bound: string): string | undefined {
  const m = /^within\s+(.+)$/i.exec(bound.trim());
  return m ? m[1]!.trim() : undefined;
}

function boundDirection(value: number, bound: string, lowWord: string, highWord: string): string {
  const between = /^between\s+(\S+)\s+and\s+(\S+)$/i.exec(bound);
  if (between) {
    const min = Number(between[1]), max = Number(between[2]);
    return value < min ? lowWord : value > max ? highWord : 'out of bounds';
  }
  const minMax = /^min\s+(\S+)\s+max\s+(\S+)$/i.exec(bound);
  if (minMax) {
    const min = Number(minMax[1]), max = Number(minMax[2]);
    return value < min ? lowWord : value > max ? highWord : 'out of bounds';
  }
  if (/^min\s+/i.test(bound)) return lowWord;
  if (/^max\s+/i.test(bound)) return highWord;
  return 'out of bounds';
}

function describeMissedRow(block: TargetResult, row: TargetRow): string {
  const prefix = `${block.shot}: ${row.label}`;
  const tol = parseWithinTolerance(row.bound);

  if (row.metric === 'luminance') {
    if (tol !== undefined && row.reference !== undefined) {
      const why = row.value < row.reference ? 'too dark' : 'too bright';
      return `- ${prefix} ${row.value.toFixed(3)}, target ${row.reference.toFixed(3)} +/- ${tol}: ${why}`;
    }
    const why = boundDirection(row.value, row.bound, 'too dark', 'too bright');
    return `- ${prefix} ${row.value.toFixed(3)}, bound ${row.bound}: ${why}`;
  }

  if (row.metric === 'saturation') {
    if (tol !== undefined && row.reference !== undefined) {
      const why = row.value < row.reference ? 'too desaturated (washed out)' : 'too saturated';
      return `- ${prefix} ${row.value.toFixed(3)}, target ${row.reference.toFixed(3)} +/- ${tol}: ${why}`;
    }
    const why = boundDirection(row.value, row.bound, 'too desaturated (washed out)', 'too saturated');
    return `- ${prefix} ${row.value.toFixed(3)}, bound ${row.bound}: ${why}`;
  }

  if (row.metric === 'histogram') {
    return `- ${prefix} ${row.value.toFixed(3)}, reference 0.000, bound ${row.bound}: colours differ from reference`;
  }

  if (row.metric === 'structure') {
    return `- ${prefix} ${row.value.toFixed(3)}, reference 0.000, bound ${row.bound}: per-cell luminance layout differs from reference`;
  }

  const why = boundDirection(row.value, row.bound, 'too static', 'too much motion');
  return `- ${prefix} ${row.value.toFixed(2)}, bound ${row.bound}: ${why}`;
}

export function buildTargetReworkNote(
  blocks: readonly TargetResult[],
  autoRound: number,
  maxRounds: number,
  recipe: string,
  revision: string,
): string {
  const lines: string[] = [
    `Visual target missed (automatic round ${autoRound} of ${maxRounds}; after ${maxRounds} a person decides):`,
  ];
  for (const b of blocks) {
    if (b.pass) continue;
    for (const r of b.rows) {
      if (!r.pass) lines.push(describeMissedRow(b, r));
    }
    if (b.sheet) {
      lines.push(`Side-by-side sheet (${b.shot}): ${b.sheet}`);
    }
  }
  const revShort = revision ? revision.slice(0, 12) : 'HEAD';
  lines.push(
    `Alba captured branch HEAD (${revShort}) with recipe "${recipe}", so the worker's own pictures do not count for this check.`,
  );
  return lines.join('\n');
}

function ensureCurrentInHistory(
  history: TargetHistoryEntry[],
  trial: AcceptanceTrial,
  blocks: readonly TargetResult[],
): TargetHistoryEntry[] {
  if (history.some(h => h.report === trial.report)) return history;
  const round = blocks[0]?.round ?? history.length + 1;
  const revision = blocks.find(b => b.revision)?.revision || trial.branch || '';
  const stalled = blocks.some(b => b.stalled === true || b.trend === 'stalled');
  const trend = stalled ? ('stalled' as const) : blocks.find(b => b.trend)?.trend;
  const metrics = blocks.flatMap(b =>
    b.rows.map(r => ({
      shot: b.shot,
      metric: r.metric,
      label: r.label,
      value: r.value,
      pass: r.pass,
      ...(r.trend ? { trend: r.trend } : {}),
    })),
  );
  const rev = revision ? revision.slice(0, 12) : '-';
  const badge = stalled ? ' [stalled]' : trend ? ` [${trend}]` : '';
  const cols = metrics.map(m => {
    const val = m.metric === 'motion' ? m.value.toFixed(2) : m.value.toFixed(3);
    const tr = m.trend ? `,${m.trend}` : '';
    return `${m.shot}:${m.label}=${val}(${m.pass ? 'PASS' : 'MISS'}${tr})`;
  });
  const line = `round ${round}  report #${trial.report}  rev ${rev}  MISS${badge}  ${cols.join('  ')}`;
  return [
    ...history,
    {
      round,
      report: trial.report,
      revision,
      pass: false,
      ...(trend ? { trend } : {}),
      ...(stalled ? { stalled: true } : {}),
      metrics,
      line,
    },
  ];
}

/**
 * Apply the visual-target round policy after `attemptAcceptance` (never from `mergeAcceptance`).
 * Acts at most once per `trial.id`.
 */
export function applyTargetOutcome(
  project: ProjectConfig,
  orders: Orders,
  tag: string,
  trial: AcceptanceTrial | undefined,
): void {
  if (!trial) return;
  const targetIdx = trial.steps.findIndex(s => s.name === 'target');
  if (targetIdx < 0) return;

  const targetStep = trial.steps[targetIdx]!;
  const blocks = targetStep.target ?? [];
  if (!blocks.length) return;

  // Every earlier step must have passed (skipped is allowed).
  if (trial.steps.slice(0, targetIdx).some(s => s.status === 'failed')) return;

  // Unmeasured targets fail the step and are never sent back automatically.
  if (blocks.some(b => !!b.unmeasured)) return;

  const doc = orders.get(tag);
  const canonical = doc.order.tag;

  // Idempotent per trial id.
  const events = orders.store.events({ tag: canonical });
  if (events.some(e => ['target-round', 'target-bounced', 'target-not-converging'].includes(e.type) && e.data?.trial === trial.id)) {
    return;
  }

  const round = blocks[0]!.round;

  // Passed target step: record target-round and stop.
  if (blocks.every(b => b.pass)) {
    orders.record(canonical, 'target-round', {
      trial: trial.id,
      report: trial.report,
      round,
      pass: true,
    });
    return;
  }

  const maxVisualRounds = project.verify?.max_visual_rounds ?? 2;
  const doneReworks = reworkCount(doc);
  const maxReworks = project.dispatch.max_reworks;
  const stage = orders.stage(doc).stage;
  const manual = reviewOf(project, doc.order) === 'manual';

  let stopReason: string | undefined;
  let header: string | undefined;

  if (stage === 'held') {
    stopReason = 'order is held';
    header = 'To the lead: order is held';
  } else if (manual) {
    stopReason = 'review is manual';
    header = 'To the lead: review is manual';
  } else if (maxVisualRounds === 0) {
    stopReason = 'max_visual_rounds is 0';
    header = 'To the lead: max_visual_rounds is 0';
  } else if (doneReworks >= maxVisualRounds) {
    stopReason = 'not converging';
  } else if (maxReworks !== undefined && doneReworks >= maxReworks) {
    stopReason = 'max_reworks reached';
    header = 'To the lead: max_reworks reached';
  }

  if (!stopReason) {
    const captureStep = trial.steps.find(s => s.name === 'capture');
    const recipe = captureStep?.capture?.recipe ?? matchCaptureRecipe(project, doc)?.name ?? 'capture';
    const revision = blocks.find(b => b.revision)?.revision || captureStep?.capture?.revision || trial.branch || '';
    const note = buildTargetReworkNote(blocks, doneReworks + 1, maxVisualRounds, recipe, revision);
    rework(orders, canonical, note, { max: project.dispatch.max_reworks });
    const actionSeq = orders.get(canonical).actions.at(-1)?.seq ?? null;
    orders.record(canonical, 'target-bounced', {
      trial: trial.id,
      report: trial.report,
      round,
      action: actionSeq,
    });
    return;
  }

  const history = ensureCurrentInHistory(
    targetRoundRecords(orders, canonical).map(r => r.entry),
    trial,
    blocks,
  );
  const finalHeader = header ?? `Not converging after ${history.length} rounds:`;
  targetStep.tail = [finalHeader, formatTargetHistory(history), '', targetStep.tail].filter((s, i) => i < 2 || s !== '').join('\n');

  orders.record(canonical, 'target-not-converging', {
    trial: trial.id,
    report: trial.report,
    rounds: history.length,
    max: maxVisualRounds,
    reason: stopReason,
    history,
  });

  if (trial.log_dir && existsSync(trial.log_dir)) {
    writeFileSync(path.join(trial.log_dir, 'trial.json'), JSON.stringify(trial, null, 2) + '\n', 'utf8');
  }
  orders.record(canonical, 'accept-step', { trial: trial.id, ...targetStep });
  orders.record(canonical, 'accept-trial', { ...trial });
}
