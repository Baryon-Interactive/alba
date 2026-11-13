import { test } from 'node:test';
import { runDemo } from '../examples/demo/run.ts';
import { removeTreeSync } from '../src/fs/remove-tree.mjs';
import { closeStateStores } from '../src/orders/backend.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadProject } from '../src/config.ts';
import { stateStore } from '../src/orders/backend.ts';
import { Orders } from '../src/orders/service.ts';
import { loadWorkers } from '../src/workers/config.ts';
import { collectUsage, usageReport } from '../src/usage/accounting.ts';
import { systemProbes } from '../src/tick/gather.ts';

test('demo: dispatch a local script in a worktree, ingest its report, review and display it over HTTP', { timeout: 120_000 }, async () => {
  const result = await runDemo({ showcase: true });
  const project = loadProject(path.join(result.directory, 'project/alba.yaml'));
  const orders = new Orders(stateStore(project));
  assert.deepEqual(['DEMO1', 'DEMO2', 'DEMO3', 'DEMO4'].map(tag => orders.stage(orders.get(tag)).stage), ['merged', 'running', 'awaiting-user', 'awaiting-review']);
  const workers = loadWorkers(path.join(project.root, 'workers.yaml'));
  const usage = collectUsage(project, orders.all(), workers, systemProbes);
  const total = usageReport(usage.rows).total;
  assert.equal(total.unknown, 0);
  assert.equal(total.tokens, 182000);
  assert.ok(total.estimates.USD! > 0);
  closeStateStores();
  removeTreeSync(result.directory);
});

test('demo: a dispatched worker receives explicit protocol variables but no inherited Alba settings or control tokens', { timeout: 120_000 }, async () => {
  const values = { ALBA_PROJECT: 'private-project', ALBA_WORKERS: 'private-workers', ALBA_SERVICE_TOKEN: 'private-control-value', CONSOLE_TOKEN: 'console-value', alba_private_probe: 'private-setting', ALBA_PROMPT_FILE: 'stale-prompt', ALBA_LAST_FILE: 'stale-report', DEMO_REMOVE: 'remove', DEMO_INHERIT: 'ordinary' };
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    const result = await runDemo({ checkEnvironment: true });
    closeStateStores();
    removeTreeSync(result.directory);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
