import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadProject, type ProjectConfig } from '../src/config.ts';
import { closeStateStores, stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { validateMonitor, validateReport } from '../src/orders/report.ts';
import { runMonitors } from '../src/monitor/monitor.ts';
import type { Probes } from '../src/tick/gather.ts';

function makeProject(): { project: ProjectConfig; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-mon-'));
  const root = path.join(dir, 'repo');
  const work = path.join(dir, 'work');
  const state = path.join(dir, 'state');
  mkdirSync(root, { recursive: true });
  mkdirSync(work, { recursive: true });
  const file = path.join(dir, 'alba.yaml');
  writeFileSync(file, [
    'id: demo',
    'name: Demo',
    `root: ${root.replace(/\\/g, '/')}`,
    `work_orders: ${work.replace(/\\/g, '/')}`,
    `state_dir: ${state.replace(/\\/g, '/')}`,
  ].join('\n') + '\n', 'utf8');
  return {
    project: loadProject(file),
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

test('validateMonitor accepts optional check only with order_stage/after criteria', () => {
  const stageOnly = validateMonitor({
    done_when: { order_stage: { tag: 'T2', stage: ['merged', 'awaiting-review'] } },
    fail_when: { order_stage: { tag: 'T2', stage: ['failed', 'cancelled'] } },
    deadline_minutes: 60,
  });
  assert.equal(stageOnly.check, undefined);
  assert.deepEqual(stageOnly.done_when, { order_stage: { tag: 'T2', stage: ['merged', 'awaiting-review'] } });

  const afterOnly = validateMonitor({
    done_when: { after: '2026-06-01T12:00:00Z' },
    deadline_minutes: 120,
  });
  assert.equal(afterOnly.check, undefined);
  assert.deepEqual(afterOnly.done_when, { after: '2026-06-01T12:00:00Z' });

  // Report validation accepts monitoring without check for order_stage/after
  const rep = validateReport({
    status: 'monitoring',
    summary: 'waiting for T2',
    evidence: [],
    commits: [],
    monitor: {
      done_when: { order_stage: { tag: 'T2', stage: ['merged'] } },
      deadline_minutes: 30,
    },
  });
  assert.equal(rep.monitor?.check, undefined);

  // Missing check is still rejected for command-based criteria
  assert.throws(() => validateMonitor({
    done_when: { exit_code: 0 },
    deadline_minutes: 30,
  }), /monitor\.check/);
  assert.throws(() => validateMonitor({
    done_when: { file_exists: 'done.txt' },
    deadline_minutes: 30,
  }), /monitor\.check/);
  assert.throws(() => validateMonitor({
    done_when: { output_matches: 'OK' },
    deadline_minutes: 30,
  }), /monitor\.check/);
  // Mixed: done_when is after, fail_when needs check -> rejected without check
  assert.throws(() => validateMonitor({
    done_when: { after: '2026-06-01T12:00:00Z' },
    fail_when: { exit_code: 1 },
    deadline_minutes: 30,
  }), /monitor\.check/);

  // Invalid order_stage / after values rejected
  assert.throws(() => validateMonitor({
    done_when: { order_stage: { tag: 'T2', stage: ['not-a-stage'] } },
    deadline_minutes: 30,
  }), /stage/);
  assert.throws(() => validateMonitor({
    done_when: { after: 'not-a-date' },
    deadline_minutes: 30,
  }), /ISO 8601/);
});

test('order_stage monitor: not holding, unknown tag adds observation, holding resolves, fail_when resolves failed', () => {
  const env = makeProject();
  try {
    let clock = new Date('2026-06-01T10:00:00Z');
    const orders = new Orders(stateStore(env.project), () => clock.toISOString(), 'tick');
    orders.add({ tag: 'T1', title: 'Waiter', kind: 'code' });
    orders.add({ tag: 'T2', title: 'Dependency', kind: 'code' });
    orders.add({ tag: 'T3', title: 'Unknown waiter', kind: 'code' });

    // T1 waits for T2 to reach merged or awaiting-review (no check command, probes.runCheck omitted!)
    orders.report('T1', {
      status: 'monitoring',
      summary: 'waiting for T2',
      evidence: [],
      commits: [],
      monitor: {
        done_when: { order_stage: { tag: 'T2', stage: ['merged', 'awaiting-review'] } },
        fail_when: { order_stage: { tag: 'T2', stage: ['failed', 'cancelled'] } },
        deadline_minutes: 120,
        note: 'Continue once T2 is reviewed.',
      },
    });
    // T3 waits for an unknown tag NOPE
    orders.report('T3', {
      status: 'monitoring',
      summary: 'waiting for NOPE',
      evidence: [],
      commits: [],
      monitor: {
        done_when: { order_stage: { tag: 'NOPE', stage: ['merged'] } },
        deadline_minutes: 120,
      },
    });

    // Pass 1: T2 is draft (not holding); NOPE is unknown (not holding, adds observation)
    const p1 = runMonitors(env.project, orders, fakeProbes(() => clock));
    assert.equal(p1.resolved.length, 0);
    assert.equal(orders.stage(orders.get('T1')).stage, 'monitoring');
    assert.equal(orders.get('T1').monitor?.last_result, 'waiting');
    assert.match(orders.get('T1').monitor?.tail ?? '', /T2 is draft/);
    assert.equal(orders.stage(orders.get('T3')).stage, 'monitoring');
    assert.equal(orders.get('T3').monitor?.last_result, 'waiting');
    assert.match(orders.get('T3').monitor?.tail ?? '', /unknown order "NOPE"/);

    // Move T2 to awaiting-review -> Pass 2 resolves T1 as done!
    orders.report('T2', { status: 'ready', summary: 'done', evidence: [], commits: [] });
    clock = new Date('2026-06-01T10:15:00Z');
    const p2 = runMonitors(env.project, orders, fakeProbes(() => clock));
    assert.deepEqual(p2.resolved, ['T1']);
    assert.equal(orders.get('T1').monitor?.resolved?.result, 'done');
    assert.equal(orders.stage(orders.get('T1')).stage, 'queued');

    // Test fail_when with order_stage
    orders.add({ tag: 'T4', title: 'Failing dep waiter', kind: 'code' });
    orders.add({ tag: 'T5', title: 'Failing dep', kind: 'code' });
    orders.report('T4', {
      status: 'monitoring',
      summary: 'waiting for T5',
      evidence: [],
      commits: [],
      monitor: {
        done_when: { order_stage: { tag: 'T5', stage: ['merged'] } },
        fail_when: { order_stage: { tag: 'T5', stage: ['cancelled', 'failed'] } },
        deadline_minutes: 120,
      },
    });
    orders.act('T5', 'cancel');
    const p3 = runMonitors(env.project, orders, fakeProbes(() => clock));
    assert.deepEqual(p3.resolved, ['T4']);
    assert.equal(orders.get('T4').monitor?.resolved?.result, 'failed');
  } finally {
    env.cleanup();
  }
});

test('after monitor: waiting before timestamp, resolves once clock passes it (both done_when and fail_when)', () => {
  const env = makeProject();
  try {
    let clock = new Date('2026-06-01T10:00:00Z');
    const orders = new Orders(stateStore(env.project), () => clock.toISOString(), 'tick');
    orders.add({ tag: 'A1', title: 'Timed wake', kind: 'code' });
    orders.add({ tag: 'A2', title: 'Timed fail', kind: 'code' });

    orders.report('A1', {
      status: 'monitoring',
      summary: 'wait until 11:00',
      evidence: [],
      commits: [],
      monitor: {
        done_when: { after: '2026-06-01T11:00:00Z' },
        deadline_minutes: 240,
      },
    });
    orders.report('A2', {
      status: 'monitoring',
      summary: 'fail after 10:30',
      evidence: [],
      commits: [],
      monitor: {
        done_when: { order_stage: { tag: 'A1', stage: ['merged'] } },
        fail_when: { after: '2026-06-01T10:30:00Z' },
        deadline_minutes: 240,
      },
    });

    // At 10:15 -> both still waiting
    clock = new Date('2026-06-01T10:15:00Z');
    const p1 = runMonitors(env.project, orders, fakeProbes(() => clock));
    assert.equal(p1.resolved.length, 0);
    assert.equal(orders.get('A1').monitor?.last_result, 'waiting');
    assert.equal(orders.get('A2').monitor?.last_result, 'waiting');

    // At 10:31 -> A2 fails via fail_when.after, A1 still waiting
    clock = new Date('2026-06-01T10:31:00Z');
    const p2 = runMonitors(env.project, orders, fakeProbes(() => clock));
    assert.deepEqual(p2.resolved, ['A2']);
    assert.equal(orders.get('A2').monitor?.resolved?.result, 'failed');
    assert.equal(orders.stage(orders.get('A1')).stage, 'monitoring');

    // At 11:00 -> A1 resolves done
    clock = new Date('2026-06-01T11:00:00Z');
    const p3 = runMonitors(env.project, orders, fakeProbes(() => clock));
    assert.deepEqual(p3.resolved, ['A1']);
    assert.equal(orders.get('A1').monitor?.resolved?.result, 'done');
    assert.equal(orders.stage(orders.get('A1')).stage, 'queued');
  } finally {
    env.cleanup();
  }
});
