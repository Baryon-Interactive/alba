import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import type * as A from '../api/types.ts';
import type { ProjectConfig, ScheduleConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { OrderDoc, Stage } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { fillOrderBody } from '../orders/templates.ts';
import { syncScheduleCases } from '../producer/producer.ts';
import { classifyByRules, orderText } from '../routing/classify.ts';
import { findOrderFile } from '../run/prompt.ts';
import { slugOf } from '../service/new-order.ts';
import { writeBack } from '../table/write.ts';
import {
  cadenceLabel,
  floorToMinute,
  formatLocalDate,
  formatLocalDay,
  formatLocalTime,
  latestPlannedAtOrBefore,
  nextPlannedAfter,
} from './cron.ts';
import {
  allScheduleStates,
  getScheduleFire,
  getScheduleState,
  insertScheduleFire,
  listScheduleFires,
  setScheduleState,
  type ScheduleFireRow,
  type ScheduleStateRow,
} from './store.ts';

export const MAX_FIRES_PER_DAY = 48;
export const FAILURES_TO_PAUSE = 3;
export const DEFAULT_PASS_INTERVAL_MS = 15 * 60_000;

const ENDED_STAGES = new Set<Stage>(['merged', 'cancelled', 'dropped']);
const FAILED_STAGES = new Set<Stage>(['failed', 'dropped']);

export interface ScheduleFireOutcome {
  scheduleId: string;
  plannedAt: string;
  status: 'created' | 'skipped' | 'duplicate' | 'paused';
  orderTag?: string;
  file?: string;
  reason?: string;
  autoPaused?: boolean;
}

export interface SchedulePassResult {
  created: ScheduleFireOutcome[];
  skipped: ScheduleFireOutcome[];
  paused: { scheduleId: string; reason: string }[];
  done: string[];
}

export interface RunSchedulesOptions {
  now?: Date;
  passIntervalMs?: number;
}

function expandPlaceholders(text: string, scheduleId: string, plannedAt: Date): string {
  const date = formatLocalDate(plannedAt);
  const time = formatLocalTime(plannedAt);
  const iso = plannedAt.toISOString();
  return text
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{planned_at}', iso)
    .replaceAll('{schedule}', scheduleId);
}

export function expandTag(pattern: string, plannedAt: Date): string {
  return pattern
    .replaceAll('{date}', formatLocalDate(plannedAt))
    .replaceAll('{time}', formatLocalTime(plannedAt));
}

function titleFromBody(body: string, schedule: ScheduleConfig, plannedAt: Date): string {
  if (schedule.title) return expandPlaceholders(schedule.title, schedule.id, plannedAt);
  const heading = /^\s*#\s+(.+?)\s*$/m.exec(body);
  if (heading && heading[1].trim()) return heading[1].trim();
  return `${schedule.id} (${formatLocalDate(plannedAt)})`;
}

function scheduleOrders(orders: Orders, scheduleId: string, fires: readonly ScheduleFireRow[]): OrderDoc[] {
  const sourceTag = `schedule:${scheduleId}`;
  const fireTags = new Set(fires.filter(f => f.status === 'created' && f.order_tag).map(f => f.order_tag!.toLowerCase()));
  return orders.all().filter(d => d.order.scheduled?.source === sourceTag || fireTags.has(d.order.tag.toLowerCase()));
}

function countOpen(orders: Orders, scheduleId: string, fires: readonly ScheduleFireRow[]): number {
  const docs = orders.all();
  const merged = orders.mergedSet(docs);
  const sourceTag = `schedule:${scheduleId}`;
  const fireTags = new Set(fires.filter(f => f.status === 'created' && f.order_tag).map(f => f.order_tag!.toLowerCase()));
  let open = 0;
  for (const doc of docs) {
    if (doc.order.scheduled?.source !== sourceTag && !fireTags.has(doc.order.tag.toLowerCase())) continue;
    const stage = orders.stage(doc, merged).stage;
    if (!ENDED_STAGES.has(stage)) open++;
  }
  return open;
}

function countFiresToday(fires: readonly ScheduleFireRow[], now: Date): number {
  const today = formatLocalDay(now);
  return fires.filter(f => f.status === 'created' && formatLocalDay(new Date(f.fired_at)) === today).length;
}

function checkFailureAutoPause(orders: Orders, schedule: ScheduleConfig, state: ScheduleStateRow | undefined, fires: readonly ScheduleFireRow[], nowIso: string): { paused: true; reason: string; tags: string[] } | undefined {
  if (state?.paused) return undefined;
  const resumedAt = state?.resumed_at;
  const created = fires.filter(f => f.status === 'created' && f.order_tag && (!resumedAt || f.fired_at > resumedAt));
  if (created.length < FAILURES_TO_PAUSE) return undefined;
  const docs = orders.all();
  const merged = orders.mergedSet(docs);
  const byTag = new Map(docs.map(d => [d.order.tag.toLowerCase(), d]));
  const lastN = created.slice(-FAILURES_TO_PAUSE);
  const resolved: { tag: string; stage: Stage }[] = [];
  for (const fire of lastN) {
    const doc = byTag.get(fire.order_tag!.toLowerCase());
    if (!doc) return undefined;
    resolved.push({ tag: doc.order.tag, stage: orders.stage(doc, merged).stage });
  }
  if (!resolved.every(r => FAILED_STAGES.has(r.stage))) return undefined;
  const tags = resolved.map(r => r.tag);
  const reason = t('last {n} orders ended failed or dropped ({tags})', { n: FAILURES_TO_PAUSE, tags: tags.join(', ') });
  setScheduleState(orders.store, {
    schedule_id: schedule.id,
    paused: true,
    paused_at: nowIso,
    paused_reason: reason,
    auto_paused: true,
    ...(resumedAt ? { resumed_at: resumedAt } : {}),
    updated_at: nowIso,
  });
  orders.store.appendEvent({
    at: nowIso,
    tag: '*',
    type: 'schedule-paused',
    by: orders.actor,
    data: { schedule: schedule.id, auto: true, reason, orders: tags },
  });
  return { paused: true, reason, tags };
}

function fireOne(
  project: ProjectConfig,
  orders: Orders,
  schedule: ScheduleConfig,
  plannedAt: Date,
  now: Date,
  manual: boolean,
): { outcome: ScheduleFireOutcome; needsCaseSync: boolean; needsTableWriteBack: boolean } {
  const plannedAtIso = plannedAt.toISOString();
  const nowIso = now.toISOString();
  let needsCaseSync = false;
  let needsTableWriteBack = false;

  const outcome = orders.store.transaction((): ScheduleFireOutcome => {
    const existing = getScheduleFire(orders.store, schedule.id, plannedAtIso);
    if (existing) {
      return {
        scheduleId: schedule.id,
        plannedAt: plannedAtIso,
        status: 'duplicate',
        orderTag: existing.order_tag,
        reason: existing.reason,
      };
    }

    const state = getScheduleState(orders.store, schedule.id);
    const fires = listScheduleFires(orders.store, schedule.id);

    if (!manual) {
      if (state?.paused) {
        return { scheduleId: schedule.id, plannedAt: plannedAtIso, status: 'paused', reason: state.paused_reason };
      }
      const auto = checkFailureAutoPause(orders, schedule, state, fires, nowIso);
      if (auto) {
        needsCaseSync = true;
        return { scheduleId: schedule.id, plannedAt: plannedAtIso, status: 'paused', reason: auto.reason, autoPaused: true };
      }
    }

    const firesToday = countFiresToday(fires, now);
    if (firesToday >= MAX_FIRES_PER_DAY) {
      const reason = t('daily fire limit ({max}) reached', { max: MAX_FIRES_PER_DAY });
      insertScheduleFire(orders.store, {
        schedule_id: schedule.id,
        planned_at: plannedAtIso,
        fired_at: nowIso,
        status: 'skipped',
        reason,
        manual,
      });
      orders.store.appendEvent({
        at: nowIso,
        tag: '*',
        type: 'schedule-skipped',
        by: orders.actor,
        data: { schedule: schedule.id, planned_at: plannedAtIso, reason, manual },
      });
      return { scheduleId: schedule.id, plannedAt: plannedAtIso, status: 'skipped', reason };
    }

    const open = countOpen(orders, schedule.id, fires);
    if (open >= schedule.max_open) {
      const reason = t('max_open reached ({open}/{max})', { open, max: schedule.max_open });
      insertScheduleFire(orders.store, {
        schedule_id: schedule.id,
        planned_at: plannedAtIso,
        fired_at: nowIso,
        status: 'skipped',
        reason,
        manual,
      });
      orders.store.appendEvent({
        at: nowIso,
        tag: '*',
        type: 'schedule-skipped',
        by: orders.actor,
        data: { schedule: schedule.id, planned_at: plannedAtIso, reason, open, max_open: schedule.max_open, manual },
      });
      return { scheduleId: schedule.id, plannedAt: plannedAtIso, status: 'skipped', reason };
    }

    const tag = expandTag(schedule.tag, plannedAt);
    const taken = orders.resolveTag(tag);
    if (taken) {
      const reason = t('order tag "{tag}" already exists', { tag: taken });
      insertScheduleFire(orders.store, {
        schedule_id: schedule.id,
        planned_at: plannedAtIso,
        fired_at: nowIso,
        status: 'skipped',
        order_tag: taken,
        reason,
        manual,
      });
      orders.store.appendEvent({
        at: nowIso,
        tag: taken,
        type: 'schedule-skipped',
        by: orders.actor,
        data: { schedule: schedule.id, planned_at: plannedAtIso, tag: taken, reason, manual },
      });
      return { scheduleId: schedule.id, plannedAt: plannedAtIso, status: 'skipped', orderTag: taken, reason };
    }

    let existingFile: string | undefined;
    try { existingFile = findOrderFile(project.work_orders, tag); } catch { /* none */ }
    if (existingFile) {
      const reason = t('work-order file for "{tag}" already exists ({file})', { tag, file: existingFile });
      insertScheduleFire(orders.store, {
        schedule_id: schedule.id,
        planned_at: plannedAtIso,
        fired_at: nowIso,
        status: 'skipped',
        order_tag: tag,
        reason,
        manual,
      });
      orders.store.appendEvent({
        at: nowIso,
        tag,
        type: 'schedule-skipped',
        by: orders.actor,
        data: { schedule: schedule.id, planned_at: plannedAtIso, tag, reason, manual },
      });
      return { scheduleId: schedule.id, plannedAt: plannedAtIso, status: 'skipped', orderTag: tag, reason };
    }

    if (!existsSync(schedule.order)) {
      fail('Schedule "{id}" template file not found: {file}', { id: schedule.id, file: schedule.order });
    }
    const rawTemplate = readFileSync(schedule.order, 'utf8');
    const expanded = expandPlaceholders(rawTemplate, schedule.id, plannedAt);
    if (!expanded.trim()) fail('Schedule "{id}" template file is empty: {file}', { id: schedule.id, file: schedule.order });

    const title = titleFromBody(expanded, schedule, plannedAt);
    const kind = schedule.kind?.trim() || 'task';
    const templateKind = schedule.kind?.trim() || 'default';
    const filled = fillOrderBody(project, templateKind, tag, expanded);
    const bodyToWrite = filled.body;
    const file = path.join(project.work_orders, `${tag}-${slugOf(title)}.md`).replace(/\\/g, '/');

    if (existsSync(file)) {
      const reason = t('work-order file for "{tag}" already exists ({file})', { tag, file });
      insertScheduleFire(orders.store, {
        schedule_id: schedule.id,
        planned_at: plannedAtIso,
        fired_at: nowIso,
        status: 'skipped',
        order_tag: tag,
        reason,
        manual,
      });
      orders.store.appendEvent({
        at: nowIso,
        tag,
        type: 'schedule-skipped',
        by: orders.actor,
        data: { schedule: schedule.id, planned_at: plannedAtIso, tag, reason, manual },
      });
      return { scheduleId: schedule.id, plannedAt: plannedAtIso, status: 'skipped', orderTag: tag, reason };
    }

    // Reserve the receipt in this transaction before touching disk or creating the order.
    const inserted = insertScheduleFire(orders.store, {
      schedule_id: schedule.id,
      planned_at: plannedAtIso,
      fired_at: nowIso,
      status: 'created',
      order_tag: tag,
      manual,
    });
    if (!inserted) {
      const prior = getScheduleFire(orders.store, schedule.id, plannedAtIso);
      return {
        scheduleId: schedule.id,
        plannedAt: plannedAtIso,
        status: 'duplicate',
        orderTag: prior?.order_tag,
        reason: prior?.reason,
      };
    }

    mkdirSync(project.work_orders, { recursive: true });
    let wroteFile = false;
    try {
      const fd = openSync(file, 'wx');
      try {
        writeSync(fd, bodyToWrite.endsWith('\n') ? bodyToWrite : bodyToWrite + '\n');
        wroteFile = true;
      } finally {
        closeSync(fd);
      }

      const draft: OrderDoc = {
        version: 1,
        order: { tag, title, kind, needs: schedule.needs ?? [], created: nowIso, updated: nowIso },
        runs: [],
        reports: [],
        actions: [],
      };
      const routing = project.kinds?.length ? classifyByRules(project, draft, orderText(project, tag), nowIso) : undefined;
      orders.add({
        tag,
        title,
        kind,
        needs: schedule.needs,
        worker: schedule.worker,
        priority: schedule.priority,
        ...(routing ? { routing } : {}),
        scheduled: { id: schedule.id, source: `schedule:${schedule.id}`, planned_at: plannedAtIso },
      });
      if (filled.filled.length) {
        orders.record(tag, 'order-template-filled', { kind: templateKind, sections: filled.filled });
      }
      orders.act(tag, 'queue', { note: `schedule:${schedule.id}` });
      orders.store.appendEvent({
        at: nowIso,
        tag,
        type: 'schedule-fired',
        by: orders.actor,
        data: { schedule: schedule.id, planned_at: plannedAtIso, tag, manual },
      });
      needsTableWriteBack = !!project.dispatch_table?.write_back;
      return { scheduleId: schedule.id, plannedAt: plannedAtIso, status: 'created', orderTag: tag, file };
    } catch (err) {
      if (wroteFile) rmSync(file, { force: true });
      throw err;
    }
  });

  if (needsTableWriteBack && project.dispatch_table?.write_back) {
    try { writeBack(orders, project.dispatch_table, project.dispatch_table.file, project.state_dir, now); } catch { /* ignore table write-back warnings */ }
  }
  return { outcome, needsCaseSync, needsTableWriteBack };
}

/** Runs one schedule evaluation pass for a project (called from serve loop and real ticks). */
export function runSchedules(project: ProjectConfig, orders: Orders, options: RunSchedulesOptions = {}): SchedulePassResult {
  const result: SchedulePassResult = { created: [], skipped: [], paused: [], done: [] };
  if (!project.schedules?.length) return result;

  const now = options.now ?? new Date(orders.now());
  const nowIso = now.toISOString();
  const passIntervalMs = options.passIntervalMs ?? DEFAULT_PASS_INTERVAL_MS;
  let syncCases = false;

  for (const schedule of project.schedules) {
    if (!schedule.enabled) continue;

    // First check auto-pause even if no new planned time is due yet.
    const autoCheck = orders.store.transaction(() => {
      const state = getScheduleState(orders.store, schedule.id);
      if (state?.paused) return { alreadyPaused: true as const };
      const fires = listScheduleFires(orders.store, schedule.id);
      const auto = checkFailureAutoPause(orders, schedule, state, fires, nowIso);
      return auto ? { auto } : { alreadyPaused: false as const };
    });

    if ('auto' in autoCheck && autoCheck.auto) {
      syncCases = true;
      result.paused.push({ scheduleId: schedule.id, reason: autoCheck.auto.reason });
      result.done.push(t('schedule {id} paused automatically: {reason}', { id: schedule.id, reason: autoCheck.auto.reason }));
      continue;
    }
    if ('alreadyPaused' in autoCheck && autoCheck.alreadyPaused) continue;

    const latestDue = latestPlannedAtOrBefore(schedule, now);
    if (!latestDue) continue;

    if (schedule.catch_up === 'none') {
      const ageMs = now.getTime() - latestDue.getTime();
      if (ageMs > passIntervalMs) continue;
    }

    const latestDueIso = latestDue.toISOString();
    const priorFires = listScheduleFires(orders.store, schedule.id);
    if (priorFires.some(f => f.planned_at === latestDueIso || (!f.manual && f.planned_at > latestDueIso))) {
      continue;
    }

    const { outcome, needsCaseSync } = fireOne(project, orders, schedule, latestDue, now, false);
    if (needsCaseSync) syncCases = true;
    if (outcome.status === 'created') {
      result.created.push(outcome);
      result.done.push(t('schedule {id} created order {tag} (planned {at})', { id: schedule.id, tag: outcome.orderTag ?? '', at: outcome.plannedAt }));
    } else if (outcome.status === 'skipped') {
      result.skipped.push(outcome);
      result.done.push(t('schedule {id} skipped ({reason})', { id: schedule.id, reason: outcome.reason ?? '' }));
    } else if (outcome.status === 'paused' && outcome.autoPaused) {
      result.paused.push({ scheduleId: schedule.id, reason: outcome.reason ?? '' });
      result.done.push(t('schedule {id} paused automatically: {reason}', { id: schedule.id, reason: outcome.reason ?? '' }));
    }
  }

  if (syncCases) syncScheduleCases(project, nowIso);
  return result;
}

function findSchedule(project: ProjectConfig, id: string): ScheduleConfig {
  const found = project.schedules?.find(s => s.id === id);
  if (!found) fail('No schedule "{id}".', { id });
  return found;
}

/** Fires a configured schedule immediately, keyed on the current minute so double runs create one order. */
export function runScheduleNow(project: ProjectConfig, orders: Orders, id: string, now: Date = new Date(orders.now())): ScheduleFireOutcome {
  const schedule = findSchedule(project, id);
  const minute = floorToMinute(now);
  const { outcome, needsCaseSync } = fireOne(project, orders, schedule, minute, now, true);
  if (needsCaseSync) syncScheduleCases(project, now.toISOString());
  return outcome;
}

/** Pauses a schedule in durable state (does not edit alba.yaml). */
export function pauseSchedule(project: ProjectConfig, orders: Orders, id: string, options: { reason?: string; now?: Date } = {}): ScheduleStateRow {
  const schedule = findSchedule(project, id);
  const now = options.now ?? new Date(orders.now());
  const nowIso = now.toISOString();
  const reason = options.reason?.trim() || t('paused by {actor}', { actor: orders.actor });
  return orders.store.transaction(() => {
    const existing = getScheduleState(orders.store, schedule.id);
    const next: ScheduleStateRow = {
      schedule_id: schedule.id,
      paused: true,
      paused_at: nowIso,
      paused_reason: reason,
      auto_paused: false,
      ...(existing?.resumed_at ? { resumed_at: existing.resumed_at } : {}),
      updated_at: nowIso,
    };
    setScheduleState(orders.store, next);
    orders.store.appendEvent({
      at: nowIso,
      tag: '*',
      type: 'schedule-paused',
      by: orders.actor,
      data: { schedule: schedule.id, auto: false, reason },
    });
    return next;
  });
}

/** Resumes a paused schedule in durable state and clears any schedule-paused producer card. */
export function resumeSchedule(project: ProjectConfig, orders: Orders, id: string, now: Date = new Date(orders.now())): ScheduleStateRow {
  const schedule = findSchedule(project, id);
  const nowIso = now.toISOString();
  const next = orders.store.transaction(() => {
    const row: ScheduleStateRow = {
      schedule_id: schedule.id,
      paused: false,
      auto_paused: false,
      resumed_at: nowIso,
      updated_at: nowIso,
    };
    setScheduleState(orders.store, row);
    orders.store.appendEvent({
      at: nowIso,
      tag: '*',
      type: 'schedule-resumed',
      by: orders.actor,
      data: { schedule: schedule.id },
    });
    return row;
  });
  syncScheduleCases(project, nowIso);
  return next;
}

/** Builds the read model for CLI, API, and console. */
export function scheduleViews(project: ProjectConfig, orders: Orders, now: Date = new Date(orders.now())): A.ScheduleView[] {
  const configured = project.schedules ?? [];
  if (!configured.length) return [];
  const states = new Map(allScheduleStates(orders.store).map(s => [s.schedule_id, s]));
  const allFires = listScheduleFires(orders.store);
  const firesBySchedule = new Map<string, ScheduleFireRow[]>();
  for (const fire of allFires) {
    const list = firesBySchedule.get(fire.schedule_id);
    if (list) list.push(fire);
    else firesBySchedule.set(fire.schedule_id, [fire]);
  }
  const projectDir = path.dirname(project.file);

  return configured.map((schedule): A.ScheduleView => {
    const st = states.get(schedule.id);
    const fires = firesBySchedule.get(schedule.id) ?? [];
    const last = fires.at(-1);
    const paused = st?.paused === true;
    const autoPaused = paused && st?.auto_paused === true;
    const state: A.ScheduleView['state'] = !schedule.enabled ? 'disabled' : paused ? 'paused' : 'active';
    const next = state === 'active' ? nextPlannedAfter(schedule, now) : undefined;
    const relOrder = path.relative(projectDir, schedule.order).replace(/\\/g, '/');

    return {
      id: schedule.id,
      order: relOrder,
      tag: schedule.tag,
      cadence: cadenceLabel(schedule),
      catchUp: schedule.catch_up,
      maxOpen: schedule.max_open,
      openCount: countOpen(orders, schedule.id, fires),
      enabled: schedule.enabled,
      paused,
      autoPaused,
      ...(paused && st?.paused_at ? { pausedAt: st.paused_at } : {}),
      ...(paused && st?.paused_reason ? { pausedReason: st.paused_reason } : {}),
      state,
      ...(next ? { nextAt: next.toISOString() } : {}),
      ...(last ? {
        lastFire: {
          plannedAt: last.planned_at,
          firedAt: last.fired_at,
          status: last.status,
          ...(last.order_tag ? { orderTag: last.order_tag } : {}),
          ...(last.reason ? { reason: last.reason } : {}),
          ...(last.manual ? { manual: true } : {}),
        },
      } : {}),
      firesToday: countFiresToday(fires, now),
      ...(schedule.kind ? { kind: schedule.kind } : {}),
      ...(schedule.worker ? { worker: schedule.worker } : {}),
      ...(schedule.priority !== undefined ? { priority: schedule.priority } : {}),
      ...(schedule.needs?.length ? { needs: schedule.needs } : {}),
    };
  });
}

export { scheduleOrders };
