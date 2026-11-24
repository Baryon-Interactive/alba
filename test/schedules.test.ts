import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject, DEFAULT_SESSION_TRIGGERS, PRODUCER_TRIGGERS, type ProjectConfig } from '../src/config.ts';
import { Orders } from '../src/orders/service.ts';
import { SqliteStore } from '../src/orders/sqlite-store.ts';
import { FileStore } from '../src/orders/store.ts';
import { closeStateStores, stateStore } from '../src/orders/backend.ts';
import { producerCases } from '../src/producer/producer.ts';
import { latestPlannedAtOrBefore, nextPlannedAfter, parseCron } from '../src/schedules/cron.ts';
import {
  MAX_FIRES_PER_DAY,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  runSchedules,
  scheduleViews,
} from '../src/schedules/engine.ts';
import { listScheduleFires } from '../src/schedules/store.ts';
import { runSchedulesCli } from '../src/cli/schedules.ts';
import { startServer } from '../src/web/server.ts';
import type { Probes } from '../src/tick/gather.ts';

function makeTempProject(opts: {
  backend?: 'sqlite' | 'files';
  schedulesYaml: string;
  templateBody?: string;
  templateName?: string;
}): { dir: string; project: ProjectConfig; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-sched-'));
  const root = path.join(dir, 'repo');
  const workOrders = path.join(dir, 'work-orders');
  const stateDir = path.join(dir, 'state');
  const templatesDir = path.join(dir, 'templates');
  mkdirSync(root, { recursive: true });
  mkdirSync(workOrders, { recursive: true });
  mkdirSync(templatesDir, { recursive: true });

  const tplName = opts.templateName ?? 'nightly.md';
  writeFileSync(
    path.join(templatesDir, tplName),
    opts.templateBody ?? '# Nightly check {date} ({time})\n\nSchedule: {schedule}\nPlanned: {planned_at}\n\n## Acceptance\n- Run smoke checks.\n',
    'utf8',
  );

  const yaml = [
    'id: demo',
    'name: Demo Project',
    `root: ${root.replace(/\\/g, '/')}`,
    `work_orders: ${workOrders.replace(/\\/g, '/')}`,
    `state_dir: ${stateDir.replace(/\\/g, '/')}`,
    `state: { backend: ${opts.backend ?? 'sqlite'} }`,
    'schedules:',
    opts.schedulesYaml,
  ].join('\n');

  const cfgFile = path.join(dir, 'alba.yaml');
  writeFileSync(cfgFile, yaml + '\n', 'utf8');
  const project = loadProject(cfgFile);
  return {
    dir,
    project,
    cleanup: () => {
      closeStateStores();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function fakeProbes(getNow: () => Date): Probes {
  return {
    now: getNow,
    runCommand: () => '',
    freeRamGb: () => 16,
    isAlive: () => false,
    worktrees: () => [],
    gitActivity: () => ({ dirtyFiles: 0 }),
    fileTime: () => undefined,
    tail: () => '',
    readText: () => undefined,
    spawnDetached: () => 0,
  };
}

test('timetable math: every_minutes, daily_at, and 5-field cron (steps, lists, ranges, dow, month boundary)', () => {
  // every_minutes
  const base = new Date(2026, 5, 1, 10, 7, 30, 0);
  const nextEvery = nextPlannedAfter({ every_minutes: 30 }, base)!;
  assert.equal(nextEvery.getMinutes() % 30, 0);
  assert.ok(nextEvery.getTime() > base.getTime());
  assert.ok(nextEvery.getTime() - base.getTime() <= 30 * 60_000);
  const prevEvery = latestPlannedAtOrBefore({ every_minutes: 30 }, base)!;
  assert.equal(nextEvery.getTime() - prevEvery.getTime(), 30 * 60_000);

  // daily_at (local time)
  const beforeDaily = new Date(2026, 5, 1, 1, 59, 0, 0);
  const nextDaily1 = nextPlannedAfter({ daily_at: '02:00' }, beforeDaily)!;
  assert.equal(nextDaily1.getFullYear(), 2026);
  assert.equal(nextDaily1.getMonth(), 5);
  assert.equal(nextDaily1.getDate(), 1);
  assert.equal(nextDaily1.getHours(), 2);
  assert.equal(nextDaily1.getMinutes(), 0);

  const atDaily = new Date(2026, 5, 1, 2, 0, 0, 0);
  const nextDaily2 = nextPlannedAfter({ daily_at: '02:00' }, atDaily)!;
  assert.equal(nextDaily2.getDate(), 2);
  assert.equal(nextDaily2.getHours(), 2);
  assert.equal(nextDaily2.getMinutes(), 0);

  // cron */15
  const c15 = nextPlannedAfter({ cron: '*/15 * * * *' }, new Date(2026, 5, 1, 10, 14, 0, 0))!;
  assert.equal(c15.getHours(), 10);
  assert.equal(c15.getMinutes(), 15);
  const c15b = nextPlannedAfter({ cron: '*/15 * * * *' }, new Date(2026, 5, 1, 10, 45, 0, 0))!;
  assert.equal(c15b.getHours(), 11);
  assert.equal(c15b.getMinutes(), 0);

  // cron lists and ranges (hours 9,13-15)
  const listRange = nextPlannedAfter({ cron: '30 9,13-15 * * *' }, new Date(2026, 5, 1, 9, 31, 0, 0))!;
  assert.equal(listRange.getHours(), 13);
  assert.equal(listRange.getMinutes(), 30);

  // cron day-of-week: 2026-06-05 is Friday (5), 2026-06-08 is Monday (1)
  const friAfternoon = new Date(2026, 5, 5, 18, 0, 0, 0);
  assert.equal(friAfternoon.getDay(), 5);
  const nextMon = nextPlannedAfter({ cron: '0 9 * * 1-5' }, friAfternoon)!;
  assert.equal(nextMon.getDay(), 1);
  assert.equal(nextMon.getDate(), 8);
  assert.equal(nextMon.getHours(), 9);

  // cron Sunday as 7
  const nextSun = nextPlannedAfter({ cron: '0 10 * * 7' }, friAfternoon)!;
  assert.equal(nextSun.getDay(), 0);
  assert.equal(nextSun.getDate(), 7);

  // month boundary: Jan 31 -> Mar 31 for day 31 (Feb has no 31st)
  const jan31 = new Date(2026, 0, 31, 23, 0, 0, 0);
  const mar31 = nextPlannedAfter({ cron: '0 8 31 * *' }, jan31)!;
  assert.equal(mar31.getFullYear(), 2026);
  assert.equal(mar31.getMonth(), 2); // March
  assert.equal(mar31.getDate(), 31);
  assert.equal(mar31.getHours(), 8);

  // month boundary: Feb 28 2026 (non-leap) -> Mar 1
  const feb28 = new Date(2026, 1, 28, 23, 30, 0, 0);
  const mar1 = nextPlannedAfter({ cron: '0 0 * * *' }, feb28)!;
  assert.equal(mar1.getMonth(), 2);
  assert.equal(mar1.getDate(), 1);
  assert.equal(mar1.getHours(), 0);

  // invalid cron rejected
  assert.throws(() => parseCron('0 0 * *'), /5 fields/);
  assert.throws(() => parseCron('60 0 * * *'), /outside/);
  assert.throws(() => parseCron('*/0 * * * *'), />= 1/);
});

test('config validation rejects invalid schedule definitions', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-sched-cfg-'));
  try {
    const root = path.join(dir, 'repo');
    const work = path.join(dir, 'work');
    mkdirSync(root, { recursive: true });
    mkdirSync(work, { recursive: true });
    const checkBad = (schedulesYaml: string, pattern: RegExp) => {
      const file = path.join(dir, 'alba.yaml');
      writeFileSync(file, [
        'id: demo',
        'name: Demo',
        `root: ${root.replace(/\\/g, '/')}`,
        `work_orders: ${work.replace(/\\/g, '/')}`,
        'state_dir: state',
        'schedules:',
        schedulesYaml,
      ].join('\n'));
      assert.throws(() => loadProject(file), pattern);
    };
    checkBad('  - id: BAD_ID\n    order: tpl.md\n    tag: N-{date}\n    daily_at: "02:00"', /a-z, 0-9/);
    checkBad('  - id: s1\n    order: tpl.md\n    tag: N-{date}\n    every_minutes: 10', />= 15/);
    checkBad('  - id: s1\n    order: tpl.md\n    tag: N-{date}\n    every_minutes: 30\n    daily_at: "02:00"', /exactly one/);
    checkBad('  - id: s1\n    order: tpl.md\n    tag: N-{date}', /exactly one/);
    checkBad('  - id: s1\n    order: tpl.md\n    tag: N-STATIC\n    daily_at: "02:00"', /\{date\}/);
    checkBad('  - id: s1\n    order: tpl.md\n    tag: N-{date}\n    daily_at: "25:00"', /HH:MM/);
    checkBad('  - id: s1\n    order: tpl.md\n    tag: N-{date}\n    daily_at: "02:00"\n    catch_up: all', /latest.*none/);
    checkBad('  - id: s1\n    order: tpl.md\n    tag: N-{date}\n    daily_at: "02:00"\n    max_open: 0', />= 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('3-day gap: catch_up latest creates exactly one order and none creates none', () => {
  const env = makeTempProject({
    schedulesYaml: [
      '  - id: nightly-latest',
      '    order: templates/nightly.md',
      '    tag: NL-{date}',
      '    daily_at: "02:00"',
      '    catch_up: latest',
      '    max_open: 5',
      '    kind: build',
      '    worker: coder-a',
      '    priority: 10',
      '    needs: [BASE1]',
      '  - id: nightly-none',
      '    order: templates/nightly.md',
      '    tag: NN-{date}',
      '    daily_at: "02:00"',
      '    catch_up: none',
      '    max_open: 5',
    ].join('\n'),
  });
  try {
    let clock = new Date(2026, 5, 1, 2, 1, 0, 0);
    const orders = new Orders(stateStore(env.project), () => clock.toISOString(), 'tick');
    orders.add({ tag: 'BASE1', title: 'Base', kind: 'code' });

    // Day 1 at 02:01 -> both fire once
    const first = runSchedules(env.project, orders, { now: clock, passIntervalMs: 15 * 60_000 });
    assert.equal(first.created.length, 2);
    assert.equal(orders.all().filter(d => d.order.tag.startsWith('NL-')).length, 1);
    assert.equal(orders.all().filter(d => d.order.tag.startsWith('NN-')).length, 1);

    // Verify order fields, source, planned_at, and expanded body
    const nl1 = orders.get('NL-20260601');
    assert.equal(nl1.order.kind, 'build');
    assert.equal(nl1.order.worker, 'coder-a');
    assert.equal(nl1.order.priority, 10);
    assert.deepEqual(nl1.order.needs, ['BASE1']);
    assert.equal(nl1.order.scheduled?.source, 'schedule:nightly-latest');
    assert.equal(nl1.order.scheduled?.planned_at, new Date(2026, 5, 1, 2, 0, 0, 0).toISOString());
    const bodyText = readFileSync(first.created.find(c => c.orderTag === 'NL-20260601')!.file!, 'utf8');
    assert.match(bodyText, /Nightly check 20260601 \(0200\)/);
    assert.match(bodyText, /Schedule: nightly-latest/);
    assert.match(bodyText, new RegExp(nl1.order.scheduled!.planned_at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // Jump 3 days + 6 hours to Day 4 at 08:00 (missed days 2, 3, 4 at 02:00)
    clock = new Date(2026, 5, 4, 8, 0, 0, 0);
    const afterGap = runSchedules(env.project, orders, { now: clock, passIntervalMs: 15 * 60_000 });
    assert.equal(afterGap.created.length, 1);
    assert.equal(afterGap.created[0].scheduleId, 'nightly-latest');
    assert.equal(afterGap.created[0].orderTag, 'NL-20260604');
    // nightly-none did NOT create anything
    assert.equal(orders.all().filter(d => d.order.tag.startsWith('NN-')).length, 1);

    // Running again at 08:05 creates nothing more
    clock = new Date(2026, 5, 4, 8, 5, 0, 0);
    const repeat = runSchedules(env.project, orders, { now: clock, passIntervalMs: 15 * 60_000 });
    assert.equal(repeat.created.length, 0);
  } finally {
    env.cleanup();
  }
});

test('same-minute passes and concurrent SQLite store handles create exactly one order', async () => {
  const env = makeTempProject({
    schedulesYaml: [
      '  - id: hourly',
      '    order: templates/nightly.md',
      '    tag: HR-{date}-{time}',
      '    every_minutes: 60',
      '    max_open: 5',
    ].join('\n'),
  });
  try {
    const t1 = new Date(2026, 5, 2, 10, 0, 5, 0);
    const t2 = new Date(2026, 5, 2, 10, 0, 45, 0);

    // Two separate SqliteStore handles on the same SQLite database file
    const storeA = new SqliteStore(env.project.state_dir);
    const storeB = new SqliteStore(env.project.state_dir);
    try {
      const ordersA = new Orders(storeA, () => t1.toISOString(), 'tick');
      const ordersB = new Orders(storeB, () => t2.toISOString(), 'serve');

      const [resA, resB] = await Promise.all([
        Promise.resolve().then(() => runSchedules(env.project, ordersA, { now: t1 })),
        Promise.resolve().then(() => runSchedules(env.project, ordersB, { now: t2 })),
      ]);

      const totalCreated = resA.created.length + resB.created.length;
      assert.equal(totalCreated, 1);
      assert.equal(ordersA.all().length, 1);

      // A third pass in the same minute also creates nothing
      const resC = runSchedules(env.project, ordersA, { now: t2 });
      assert.equal(resC.created.length, 0);
      assert.equal(ordersA.all().length, 1);
    } finally {
      storeA.close();
      storeB.close();
    }
  } finally {
    env.cleanup();
  }
});

test('max_open skips with reason and existing tag is skipped without overwrite', () => {
  const env = makeTempProject({
    schedulesYaml: [
      '  - id: capped',
      '    order: templates/nightly.md',
      '    tag: CAP-{date}-{time}',
      '    every_minutes: 60',
      '    max_open: 1',
      '  - id: collide',
      '    order: templates/nightly.md',
      '    tag: COL-{date}',
      '    daily_at: "03:00"',
      '    max_open: 5',
    ].join('\n'),
  });
  try {
    let clock = new Date(2026, 5, 3, 3, 5, 0, 0);
    const orders = new Orders(stateStore(env.project), () => clock.toISOString(), 'tick');

    // Pre-create COL-20260603 so collide hits an existing tag
    orders.add({ tag: 'COL-20260603', title: 'Manual existing order', kind: 'code' });

    const r1 = runSchedules(env.project, orders, { now: clock });
    // capped created 1 order; collide skipped existing tag
    assert.equal(r1.created.length, 1);
    assert.equal(r1.created[0].scheduleId, 'capped');
    assert.equal(r1.skipped.length, 1);
    assert.equal(r1.skipped[0].scheduleId, 'collide');
    assert.match(r1.skipped[0].reason ?? '', /already exists/);
    // Existing order was NOT overwritten
    assert.equal(orders.get('COL-20260603').order.title, 'Manual existing order');

    // Next hour: capped has 1 open order (max_open: 1) -> skipped with reason
    clock = new Date(2026, 5, 3, 4, 5, 0, 0);
    const r2 = runSchedules(env.project, orders, { now: clock });
    assert.equal(r2.created.length, 0);
    assert.equal(r2.skipped.length, 1);
    assert.equal(r2.skipped[0].scheduleId, 'capped');
    assert.match(r2.skipped[0].reason ?? '', /max_open/);

    // Close the first capped order as merged -> next hour fires again
    const firstTag = r1.created[0].orderTag!;
    orders.act(firstTag, 'done-by-lead', { note: 'Completed manually in test' });
    clock = new Date(2026, 5, 3, 5, 5, 0, 0);
    const r3 = runSchedules(env.project, orders, { now: clock });
    assert.equal(r3.created.length, 1);
    assert.equal(r3.created[0].scheduleId, 'capped');
  } finally {
    env.cleanup();
  }
});

test('three failed/dropped instances auto-pause schedule, raise schedule-paused card, and resume resets streak', () => {
  assert.ok((PRODUCER_TRIGGERS as readonly string[]).includes('schedule-paused'));
  assert.ok(!DEFAULT_SESSION_TRIGGERS.includes('schedule-paused'));

  const env = makeTempProject({
    schedulesYaml: [
      '  - id: flaky',
      '    order: templates/nightly.md',
      '    tag: FLK-{date}-{time}',
      '    every_minutes: 60',
      '    max_open: 5',
    ].join('\n'),
  });
  try {
    let clock = new Date(2026, 5, 5, 1, 5, 0, 0);
    const orders = new Orders(stateStore(env.project), () => clock.toISOString(), 'tick');

    // Create 3 instances across 3 hours and end them as failed, failed, dropped
    const tags: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock = new Date(2026, 5, 5, 1 + i, 5, 0, 0);
      const pass = runSchedules(env.project, orders, { now: clock });
      assert.equal(pass.created.length, 1);
      const tag = pass.created[0].orderTag!;
      tags.push(tag);
      orders.report(tag, { status: i === 2 ? 'dropped' : 'failed', summary: 'boom', evidence: [], commits: [] });
    }

    // 4th hour: schedule auto-pauses instead of creating a 4th order
    clock = new Date(2026, 5, 5, 4, 5, 0, 0);
    const pausedPass = runSchedules(env.project, orders, { now: clock });
    assert.equal(pausedPass.created.length, 0);
    assert.equal(pausedPass.paused.length, 1);
    assert.equal(pausedPass.paused[0].scheduleId, 'flaky');
    assert.match(pausedPass.paused[0].reason, /failed or dropped/);

    const view = scheduleViews(env.project, orders, clock)[0];
    assert.equal(view.state, 'paused');
    assert.equal(view.autoPaused, true);
    assert.ok(view.pausedReason);

    // Producer card `schedule-paused` is open
    const openCases = producerCases(env.project, true);
    const card = openCases.find(c => c.key === 'schedule/flaky');
    assert.ok(card);
    assert.equal(card.trigger, 'schedule-paused');
    assert.equal(card.card.trigger, 'schedule-paused');
    assert.deepEqual(card.facts.orders, tags);

    // Resuming clears pause, closes card, and allows the 4th order to fire
    clock = new Date(2026, 5, 5, 4, 10, 0, 0);
    resumeSchedule(env.project, orders, 'flaky', clock);
    assert.equal(producerCases(env.project, true).find(c => c.key === 'schedule/flaky'), undefined);

    clock = new Date(2026, 5, 5, 5, 5, 0, 0);
    const resumedPass = runSchedules(env.project, orders, { now: clock });
    assert.equal(resumedPass.created.length, 1);
    assert.equal(resumedPass.paused.length, 0);
  } finally {
    env.cleanup();
  }
});

test('daily fire cap stops at 48 fires per schedule per day', () => {
  const env = makeTempProject({
    schedulesYaml: [
      '  - id: frequent',
      '    order: templates/nightly.md',
      '    tag: FRQ-{date}-{time}',
      '    every_minutes: 15',
      '    max_open: 100',
    ].join('\n'),
  });
  try {
    const start = new Date(2026, 5, 10, 0, 0, 0, 0);
    let clock = new Date(start);
    const orders = new Orders(stateStore(env.project), () => clock.toISOString(), 'tick');

    let created = 0;
    let capped = 0;
    for (let step = 0; step < MAX_FIRES_PER_DAY + 2; step++) {
      clock = new Date(start.getTime() + step * 15 * 60_000);
      const res = runSchedules(env.project, orders, { now: clock });
      created += res.created.length;
      if (res.skipped.some(s => /48/.test(s.reason ?? ''))) capped++;
    }
    assert.equal(created, MAX_FIRES_PER_DAY);
    assert.equal(capped, 2);
  } finally {
    env.cleanup();
  }
});

test('manual run twice in the same minute creates one order; pause and resume survive restart (SQLite)', () => {
  const env = makeTempProject({
    schedulesYaml: [
      '  - id: manual-job',
      '    order: templates/nightly.md',
      '    tag: MJ-{date}-{time}',
      '    daily_at: "02:00"',
      '    max_open: 5',
    ].join('\n'),
  });
  try {
    const t1 = new Date(2026, 5, 6, 14, 22, 10, 0);
    const t2 = new Date(2026, 5, 6, 14, 22, 50, 0);
    const orders1 = new Orders(stateStore(env.project), () => t1.toISOString(), 'cli');

    const run1 = runScheduleNow(env.project, orders1, 'manual-job', t1);
    const run2 = runScheduleNow(env.project, orders1, 'manual-job', t2);
    assert.equal(run1.status, 'created');
    assert.equal(run2.status, 'duplicate');
    assert.equal(run2.orderTag, run1.orderTag);
    assert.equal(orders1.all().length, 1);

    // Pause, close stores (simulate restart), reopen, verify paused
    pauseSchedule(env.project, orders1, 'manual-job', { reason: 'maintenance', now: t2 });
    closeStateStores();

    const orders2 = new Orders(stateStore(env.project), () => t2.toISOString(), 'cli');
    const viewPaused = scheduleViews(env.project, orders2, t2)[0];
    assert.equal(viewPaused.state, 'paused');
    assert.equal(viewPaused.pausedReason, 'maintenance');
    assert.equal(viewPaused.nextAt, undefined);

    // Resume, restart again, verify active
    resumeSchedule(env.project, orders2, 'manual-job', new Date(t2.getTime() + 60_000));
    closeStateStores();

    const orders3 = new Orders(stateStore(env.project), () => t2.toISOString(), 'cli');
    const viewActive = scheduleViews(env.project, orders3, t2)[0];
    assert.equal(viewActive.state, 'active');
    assert.ok(viewActive.nextAt);

    // CLI list/run/pause/resume output sanity
    const listOut = runSchedulesCli(env.project, orders3, 'list', [], {}, t2);
    assert.match(listOut, /manual-job/);
    assert.match(listOut, /active/);
  } finally {
    env.cleanup();
  }
});

test('file backend behaves the same for receipts, deduplication, and pause/resume across restarts', () => {
  const env = makeTempProject({
    backend: 'files',
    schedulesYaml: [
      '  - id: file-job',
      '    order: templates/nightly.md',
      '    tag: FJ-{date}-{time}',
      '    every_minutes: 60',
      '    max_open: 5',
    ].join('\n'),
  });
  try {
    const t1 = new Date(2026, 5, 7, 10, 0, 10, 0);
    const t2 = new Date(2026, 5, 7, 10, 0, 40, 0);
    const store1 = new FileStore(env.project.state_dir);
    const orders1 = new Orders(store1, () => t1.toISOString(), 'tick');

    const p1 = runSchedules(env.project, orders1, { now: t1 });
    const p2 = runSchedules(env.project, orders1, { now: t2 });
    assert.equal(p1.created.length, 1);
    assert.equal(p2.created.length, 0);
    assert.equal(listScheduleFires(store1, 'file-job').length, 1);

    // Same-minute manual run dedup on file backend
    const mTime = new Date(2026, 5, 7, 11, 15, 5, 0);
    const m1 = runScheduleNow(env.project, orders1, 'file-job', mTime);
    const m2 = runScheduleNow(env.project, orders1, 'file-job', new Date(mTime.getTime() + 20_000));
    assert.equal(m1.status, 'created');
    assert.equal(m2.status, 'duplicate');
    assert.equal(m2.orderTag, m1.orderTag);

    // Pause persists across fresh FileStore handle
    pauseSchedule(env.project, orders1, 'file-job', { reason: 'file backend pause', now: mTime });
    const store2 = new FileStore(env.project.state_dir);
    const orders2 = new Orders(store2, () => mTime.toISOString(), 'tick');
    const vPaused = scheduleViews(env.project, orders2, mTime)[0];
    assert.equal(vPaused.state, 'paused');
    assert.equal(vPaused.pausedReason, 'file backend pause');

    // Resume persists across fresh FileStore handle
    resumeSchedule(env.project, orders2, 'file-job', new Date(mTime.getTime() + 60_000));
    const store3 = new FileStore(env.project.state_dir);
    const orders3 = new Orders(store3, () => mTime.toISOString(), 'tick');
    const vActive = scheduleViews(env.project, orders3, mTime)[0];
    assert.equal(vActive.state, 'active');
  } finally {
    env.cleanup();
  }
});

test('HTTP API exposes GET /api/schedules, POST run/pause/resume, and order source/planned_at', async () => {
  const env = makeTempProject({
    schedulesYaml: [
      '  - id: nightly',
      '    order: templates/nightly.md',
      '    tag: API-{date}-{time}',
      '    daily_at: "02:00"',
      '    max_open: 5',
    ].join('\n'),
  });
  let clock = new Date(2026, 5, 8, 9, 30, 12, 0);
  const server = startServer({ projects: [env.project], port: 0, probes: fakeProbes(() => clock), background: false });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const listRes = await fetch(`${base}/api/schedules?project=demo`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json() as { project: string; schedules: { id: string; state: string; nextAt?: string }[] };
    assert.equal(list.project, 'demo');
    assert.equal(list.schedules.length, 1);
    assert.equal(list.schedules[0].id, 'nightly');
    assert.equal(list.schedules[0].state, 'active');
    assert.ok(list.schedules[0].nextAt);

    // Run twice in the same minute via API
    const run1 = await fetch(`${base}/api/schedules/nightly/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'demo' }),
    });
    assert.equal(run1.status, 200);
    const run1Body = await run1.json() as { ok: true; status: string; orderTag: string; plannedAt: string };
    assert.equal(run1Body.status, 'created');
    assert.equal(run1Body.orderTag, 'API-20260608-0930');

    const run2 = await fetch(`${base}/api/schedules/nightly/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'demo' }),
    });
    assert.equal(run2.status, 200);
    const run2Body = await run2.json() as { ok: true; status: string; orderTag: string };
    assert.equal(run2Body.status, 'duplicate');
    assert.equal(run2Body.orderTag, run1Body.orderTag);

    // Order detail shows source and planned_at
    const orderRes = await fetch(`${base}/api/orders/${encodeURIComponent(run1Body.orderTag)}?project=demo`);
    assert.equal(orderRes.status, 200);
    const detail = await orderRes.json() as { order: { source?: string; planned_at?: string } };
    assert.equal(detail.order.source, 'schedule:nightly');
    assert.equal(detail.order.planned_at, run1Body.plannedAt);

    // Pause and resume via API
    const pauseRes = await fetch(`${base}/api/schedules/nightly/pause`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'demo', reason: 'hold off' }),
    });
    assert.equal(pauseRes.status, 200);
    const paused = await pauseRes.json() as { schedule: { state: string; pausedReason?: string } };
    assert.equal(paused.schedule.state, 'paused');
    assert.equal(paused.schedule.pausedReason, 'hold off');

    const resumeRes = await fetch(`${base}/api/schedules/nightly/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'demo' }),
    });
    assert.equal(resumeRes.status, 200);
    const resumed = await resumeRes.json() as { schedule: { state: string } };
    assert.equal(resumed.schedule.state, 'active');

    // Unknown schedule is 404
    const missing = await fetch(`${base}/api/schedules/nope/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'demo' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    env.cleanup();
  }
});
