import type { ProjectConfig } from '../config.ts';
import { loadWorkers } from '../workers/config.ts';
import { scheduleSpend } from '../schedules/health.ts';
import { fail, t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { pauseSchedule, resumeSchedule, runScheduleNow, scheduleViews } from '../schedules/engine.ts';
import { table } from './format.ts';

export function runSchedulesCli(
  cfg: ProjectConfig,
  orders: Orders,
  command: string | undefined,
  rest: string[],
  values: { json?: boolean; note?: string; workers?: string },
  now: Date = new Date(),
): string {
  const usage = 'Usage: alba schedules [list] [--json] | schedules run <id> [--json] | schedules pause <id> [--note text] [--json] | schedules resume <id> [--json]';
  const cmd = command ?? 'list';

  if (cmd === 'list') {
    if (rest.length) fail(usage);
    const file = values.workers ?? process.env.ALBA_WORKERS ?? cfg.workers;
    let workers: ReturnType<typeof loadWorkers> | undefined;
    const items = scheduleViews(cfg, orders, now, (docs, at) => {
      if (file) workers ??= loadWorkers(file);
      return scheduleSpend(docs, at, workers?.workers);
    });
    if (values.json) return JSON.stringify({ project: cfg.id, at: now.toISOString(), schedules: items }, null, 2);
    if (!items.length) return t('This project has no schedules ("schedules:" in the project file).');
    return table(
      ['ID', 'STATE', 'SCHEDULE', 'NEXT', 'LAST FIRE', 'OPEN', '7D USD', 'HEALTH'],
      items.map(s => {
        const stateText = s.autoPaused ? 'paused (auto)' : s.state;
        const lastText = !s.lastFire
          ? '-'
          : s.lastFire.status === 'created'
            ? `${s.lastFire.firedAt} created ${s.lastFire.orderTag ?? ''}`.trim()
            : `${s.lastFire.firedAt} ${s.lastFire.status} (${s.lastFire.reason ?? ''})`;
        return [
          s.id,
          s.pausedReason ? `${stateText}: ${s.pausedReason}` : stateText,
          s.cadence,
          s.nextAt ?? '-',
          lastText,
          `${s.openCount}/${s.maxOpen}`, String(s.spend7dUsd), s.healthReason ?? '-',
        ];
      }),
    ) + items.flatMap(s => s.history.map(h => `\n${s.id}  ${h.firstPlannedAt ? h.firstPlannedAt + ' .. ' : ''}${h.plannedAt}  ${h.status}  ${h.orderTag ?? h.reason ?? ''}${h.count ? ' x' + h.count : ''}${h.precheck ? ' (precheck bypassed)' : ''}${h.output ? '\n' + h.output : ''}`)).join('');
  }

  if (cmd === 'run') {
    if (rest.length !== 1) fail('Usage: alba schedules run <id> [--json]');
    const outcome = runScheduleNow(cfg, orders, rest[0], now);
    if (values.json) return JSON.stringify(outcome, null, 2);
    if (outcome.status === 'created') {
      return t('Schedule {id}: created order {tag} (planned {at}).', { id: outcome.scheduleId, tag: outcome.orderTag ?? '', at: outcome.plannedAt }) + (outcome.precheck ? ` (${t('precheck bypassed')})` : '');
    }
    if (outcome.status === 'duplicate') {
      return outcome.orderTag
        ? t('Schedule {id}: already ran for {at} (order {tag}).', { id: outcome.scheduleId, at: outcome.plannedAt, tag: outcome.orderTag })
        : t('Schedule {id}: already ran for {at}.', { id: outcome.scheduleId, at: outcome.plannedAt });
    }
    return t('Schedule {id}: skipped ({reason}).', { id: outcome.scheduleId, reason: outcome.reason ?? '' });
  }

  if (cmd === 'pause') {
    if (rest.length !== 1) fail('Usage: alba schedules pause <id> [--note text] [--json]');
    const state = pauseSchedule(cfg, orders, rest[0], { reason: values.note, now });
    if (values.json) return JSON.stringify(state, null, 2);
    return t('Schedule {id} paused.', { id: state.schedule_id });
  }

  if (cmd === 'resume') {
    if (rest.length !== 1) fail('Usage: alba schedules resume <id> [--json]');
    const state = resumeSchedule(cfg, orders, rest[0], now);
    if (values.json) return JSON.stringify(state, null, 2);
    return t('Schedule {id} resumed.', { id: state.schedule_id });
  }

  return fail(usage);
}
