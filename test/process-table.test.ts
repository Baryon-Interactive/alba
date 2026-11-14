import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProcessTable, refreshProcessTable, resetProcessTable, tableStartedAt } from '../src/monitor/process.ts';
import { startedAtForCheck } from '../src/tick/gather.ts';
import { systemProbes } from '../src/tick/gather.ts';

test('the process table is parsed from one line per process, whatever the platform prints', () => {
  const times = parseProcessTable('  4 2026-11-14T01:02:03.0000000Z\r\n123 Fri Nov 14 09:02:03 2026\nnot a line\n77 never\n');
  assert.equal(times.get(4), '2026-11-14T01:02:03.000Z');
  assert.ok(times.has(123));
  assert.equal(times.has(77), false);
});

test('a start time is answered from the table without waiting; an unknown pid starts one refresh and is unknown until it lands', async () => {
  resetProcessTable();
  let reads = 0;
  let release!: (text: string) => void;
  const pending = refreshProcessTable(() => { reads++; return new Promise(resolve => { release = resolve; }); });
  assert.equal(tableStartedAt(42), undefined);                  // the read is still running: no second one, no wait
  assert.equal(reads, 1);
  release('42 2026-11-14T01:00:00Z\n');
  await pending;
  assert.equal(tableStartedAt(42), '2026-11-14T01:00:00.000Z');
  assert.equal(tableStartedAt(-1), undefined);
  resetProcessTable();
});

test('the system table knows this process, and the probe used by repeated checks never blocks', async () => {
  resetProcessTable();
  const t = performance.now();
  assert.equal(startedAtForCheck(systemProbes, process.pid), undefined);
  assert.ok(performance.now() - t < 200, 'returned at once');
  await refreshProcessTable();
  const at = startedAtForCheck(systemProbes, process.pid);
  assert.ok(at && Math.abs(Date.parse(at) - (Date.now() - process.uptime() * 1000)) < 120_000, `start time of this process: ${at}`);
  // probes other than the system's are asked directly (tests and replays fake the answer)
  assert.equal(startedAtForCheck({ ...systemProbes, processStartedAt: () => '2026-01-01T00:00:00Z' }, process.pid), '2026-01-01T00:00:00Z');
  resetProcessTable();
});
