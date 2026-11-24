import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { pauseSchedule, resumeSchedule, runScheduleNow, scheduleViews } from '../schedules/engine.ts';
import { table } from './format.ts';

export function runSchedulesCli(
  cfg: ProjectConfig,
  orders: Orders,
  command: string | undefined,
  rest: string[],
  values: { json?: boolean; note?: string },
  now: Date = new Date(),
): string {
  const usage = 'Usage: alba schedules [list] [--json] | schedules run <id> [--json] | schedules pause <id> [--note text] [--json] | schedules resume <id> [--json]';
  const cmd = command ?? 'list';

  if (cmd === 'list') {
    if (rest.length) fail(usage);
    const items = scheduleViews(cfg, orders, now);
    if (values.json) return JSON.stringify({ project: cfg.id, at: now.toISOString(), schedules: items }, null, 2);
    if (!items.length) return t('This project has no schedules ("schedules:" in the project file).');
    return table(
      ['ID', 'STATE', 'SCHEDULE', 'NEXT', 'LAST FIRE', 'OPEN'],
      items.map(s => {
        const stateText = s.autoPaused ? 'paused (auto)' : s.state;
        const lastText = !s.lastFire
          ? '-'
          : s.lastFire.status === 'created'
            ? `${s.lastFire.firedAt} ${s.lastFire.orderTag ?? ''}`.trim()
            : `${s.lastFire.firedAt} skipped (${s.lastFire.reason ?? ''})`;
        return [
          s.id,
          s.pausedReason ? `${stateText}: ${s.pausedReason}` : stateText,
          s.cadence,
          s.nextAt ?? '-',
          lastText,
          `${s.openCount}/${s.maxOpen}`,
        ];
      }),
    );
  }

  if (cmd === 'run') {
    if (rest.length !== 1) fail('Usage: alba schedules run <id> [--json]');
    const outcome = runScheduleNow(cfg, orders, rest[0], now);
    if (values.json) return JSON.stringify(outcome, null, 2);
    if (outcome.status === 'created') {
      return t('Schedule {id}: created order {tag} (planned {at}).', { id: outcome.scheduleId, tag: outcome.orderTag ?? '', at: outcome.plannedAt });
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
