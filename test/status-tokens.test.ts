import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from '../src/config.ts';
import { formatStatus, statusRows } from '../src/cli/live.ts';
import type { Probes } from '../src/tick/gather.ts';

test('a Codex run that has not finished its turn shows its tokens as not reported yet, not as 0', async () => {
  const { orders, dir } = tempOrders();
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const project = validateProject({ id: 'demo', name: 'Demo', root: dir, work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state') }, path.join(dir, 'alba.yaml'));
  mkdirSync(path.join(dir, 'runs'), { recursive: true });
  const events = path.join(dir, 'runs', 'A1-r1.events.jsonl');
  // codex exec --json: events while it works, usage only in turn.completed
  writeFileSync(events, [
    { type: 'thread.started', thread_id: 't-1' }, { type: 'turn.started' },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'git status', status: 'in_progress' } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  orders.add({ tag: 'A1', title: 'Sample', kind: 'code' }); orders.act('A1', 'queue');
  orders.runStart('A1', { worker: 'codex', extra: { events_file: events, engine: 'codex-cli' } });
  const probes = { now: () => new Date(), readText: () => undefined, fileTime: () => undefined, tail: () => '', isAlive: () => true } as unknown as Probes;
  let [row] = await statusRows([{ project, orders }], probes);
  assert.equal(row.tokens_reported, false);
  assert.match(formatStatus([row]), /tokens not reported yet/);
  appendFileSync(events, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300 } }) + '\n');
  [row] = await statusRows([{ project, orders }], probes);
  assert.equal(row.tokens_reported, true);
  assert.equal(row.tokens, 1500);
  assert.match(formatStatus([row]), /1500 tokens/);
});
