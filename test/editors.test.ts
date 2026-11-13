import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { answers, findEditors, stopEditors, type EditorSpec } from '../src/editors/editor-helper.mjs';
import { editorSlots, reconcileEditors } from '../src/editors/pool.ts';
import { capHolds, heavyOf, usesOf } from '../src/resources/leases.ts';

const ident = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const base = 18000 + Math.floor(Math.random() * 800) * 2;

/** A stand-in for UnrealEditor: answers MCP on -ModelContextProtocolPort after -delay ms, or never with -never. */
function fakeEditor(dir: string): string {
  const file = path.join(dir, 'fake-editor.mjs');
  writeFileSync(file, `
import http from 'node:http';
const arg = n => process.argv.find(a => a.startsWith(n + '='))?.split('=')[1];
const port = Number(arg('-ModelContextProtocolPort'));
setTimeout(() => {
  if (process.argv.includes('-never')) return;
  http.createServer((q, r) => { q.resume(); q.on('end', () => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'fake-unreal' } } })); }); }).listen(port, '127.0.0.1');
}, Number(arg('-delay') ?? 0));
setInterval(() => {}, 1000);
`);
  return file.replace(/\\/g, '/');
}

function project(dir: string, editor: string, extra: Record<string, unknown> = {}) {
  mkdirSync(path.join(dir, 'orders'), { recursive: true });
  mkdirSync(path.join(dir, 'repo'), { recursive: true });
  return validateProject({
    id: 'demo', name: 'Demo', root: path.join(dir, 'repo'), work_orders: path.join(dir, 'orders'), state_dir: path.join(dir, 'state'),
    dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'refs/heads/main', caps: { ue: 3 } },
    resources: { 'editor-build': { slots: 3 } },
    editors: { 'ue-editor': {
      program: process.execPath, args: [editor, '{worktree}/game/Game.uproject', '-ModelContextProtocolPort={port}', '-abslog={log}', '-delay=300'],
      url: 'http://127.0.0.1:{port}/mcp', holds: ['editor-build'], cap: 'ue', ready_minutes: 1,
      machines: { local: { ports: [base, base + 1] } },
    } },
    ...extra,
  }, path.join(dir, 'alba.yaml'));
}

test('editors config: the pool is a resource, an editor holds editor-build and counts against the ue cap; broken pools are refused', () => {
  const { dir, orders } = tempOrders();
  const cfg = project(dir, 'e.mjs');
  assert.deepEqual(cfg.resources!['ue-editor'], { slots: 2, exclusive: false, blocks: [], lease_minutes: 480, note: 'editor pool ue-editor' });
  orders.add({ tag: 'MAP1', title: 'Map', kind: 'code', uses: ['ue-editor'] });
  orders.add({ tag: 'SIM1', title: 'Sim', kind: 'code' });
  assert.deepEqual(usesOf(cfg, orders.get('MAP1')).sort(), ['editor-build', 'ue-editor']);
  assert.equal(heavyOf(cfg, orders.get('MAP1')), 'ue');
  assert.equal(heavyOf(cfg, orders.get('SIM1')), undefined);
  assert.deepEqual(capHolds(cfg, orders, orders.get('MAP1')).map(c => c.key), ['ue']);
  const bad = (editors: unknown, pattern: RegExp) => assert.throws(() => project(dir, 'e.mjs', { editors }), pattern);
  const ok = { program: 'ue', args: ['-ModelContextProtocolPort={port}'], url: 'http://127.0.0.1:{port}/mcp', machines: { local: { ports: [9001] } } };
  bad({ x: { ...ok, args: ['-x'] } }, /editors\.x\.args" must pass \{port\}/);
  bad({ x: { ...ok, url: 'http://127.0.0.1:9000/mcp' } }, /editors\.x\.url" must be the MCP endpoint with \{port\}/);
  bad({ x: { ...ok, holds: ['gpu'] } }, /editors\.x\.holds": "gpu" is not a resource/);
  bad({ x: { ...ok, cap: 'big' } }, /editors\.x\.cap" must be a cap under "dispatch\.caps" \(ue\)/);
  bad({ x: ok, y: ok }, /editors\.y\.machines\.local\.ports": 9001 is also a port of editors\.x/);
  bad({ x: { ...ok, machines: { local: { ports: [80] } } } }, /ports from 1024 to 65535/);
});

test('editor helper: run starts the editor, waits for MCP, runs the worker, and stops the editor at the end; stop and start keep the port', async () => {
  const { dir } = tempOrders();
  const editor = fakeEditor(dir);
  const port = base + 100;
  const spec: EditorSpec = { pool: 'ue-editor', port, program: process.execPath, args: [editor, `-ModelContextProtocolPort=${port}`, '-delay=500'], url: `http://127.0.0.1:${port}/mcp`, match: `-ModelContextProtocolPort=${port}`, log: path.join(dir, 'editor.log'), ready_minutes: 1, state_file: path.join(dir, 'editor-state.json') };
  const specFile = path.join(dir, 'editor.json');
  writeFileSync(specFile, JSON.stringify(spec));
  const helper = path.resolve('src/editors/editor-helper.mjs');
  const env = { ...process.env, ALBA_EDITOR_SPEC: specFile };
  // The worker sees the editor answering, then ends; the editor is gone afterwards.
  const workerScript = `fetch('${spec.url}', { method: 'POST', body: '{}' }).then(r => { console.log('worker saw ' + r.status); process.exit(3); })`;
  const run = spawnSync(process.execPath, [helper, 'run', '--', process.execPath, '-e', workerScript], { env, encoding: 'utf8', timeout: 90000 });
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stdout, /worker saw 200/);
  assert.match(run.stderr, /\[alba editor\] the editor answers on .* after \d+ s/);
  assert.match(run.stderr, /the run ended; stopped the editor/);
  assert.deepEqual(findEditors(spec), []);
  assert.equal(await answers(spec.url, 2000), false);
  // The worker's own stop / start around a build: same port.
  assert.equal(spawnSync(process.execPath, [helper, 'start'], { env, encoding: 'utf8', timeout: 90000 }).status, 0);
  assert.equal(await answers(spec.url), true);
  assert.equal(JSON.parse(readFileSync(spec.state_file!, 'utf8')).state, 'up');
  const stopped = spawnSync(process.execPath, [helper, 'stop'], { env, encoding: 'utf8', timeout: 90000 });
  assert.match(stopped.stderr, /stopped the editor/);
  assert.equal(await answers(spec.url, 2000), false);
  // An editor that never answers: the worker is not started, the editor is stopped, and the reason is in the log line Alba reads.
  const never: EditorSpec = { ...spec, args: [...spec.args, '-never'], ready_minutes: 0.15 };
  writeFileSync(specFile, JSON.stringify(never));
  const failed = spawnSync(process.execPath, [helper, 'run', '--', process.execPath, '-e', 'console.log("worker ran")'], { env, encoding: 'utf8', timeout: 90000 });
  assert.equal(failed.status, 86);
  assert.doesNotMatch(failed.stdout, /worker ran/);
  assert.match(failed.stderr, /\[alba editor\] the run does not start: the editor's MCP server did not answer on http:\/\/127\.0\.0\.1:\d+\/mcp within 0\.15 min/);
  assert.deepEqual(findEditors(never), []);
});

test('run start: a free port on the machine, the editor helper in front of the worker, the MCP server attached, NO_PROXY; the tick stops a leftover editor', async () => {
  const { tempOrders: temp } = await import('./helpers.ts');
  const { startRun } = await import('../src/run/launch.ts');
  const { validateWorkers } = await import('../src/workers/config.ts');
  const { dir, orders } = temp();
  const editor = fakeEditor(dir);
  const cfg = project(dir, editor);
  const root = cfg.root;
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, ...ident, 'commit', '-q', '--allow-empty', '-m', 'Initial']);
  for (const tag of ['MAP1', 'MAP2', 'MAP3']) { writeFileSync(path.join(cfg.work_orders, `${tag}-x.md`), `# ${tag}`); orders.add({ tag, title: tag, kind: 'code', uses: ['ue-editor'] }); orders.act(tag, 'queue'); }
  const workers = validateWorkers({ workers: [{ id: 'fake', engine: 'codex-cli', launch: { program: 'fake-engine', args: ['exec', '{prompt_file}'] } }] }, path.join(dir, 'workers.yaml'));
  const spawned: { program: string; args: string[]; env: Record<string, string> }[] = [];
  const probes = { now: () => new Date(), spawnDetached: (program: string, args: string[], o: { env: Record<string, string> }) => { spawned.push({ program, args, env: o.env }); return 4242; }, processStartedAt: () => undefined } as unknown as import('../src/tick/gather.ts').Probes;
  startRun({ project: cfg, orders, workers, probes }, 'MAP1', 'fake');
  const [first] = spawned;
  const tree = orders.get('MAP1').order.worktree!;
  assert.equal(first!.program, process.execPath);
  assert.deepEqual(first!.args.slice(0, 4), [`${tree.replace(/\\/g, '/')}/.alba/bin/editor.mjs`, 'run', '--', 'fake-engine']);
  assert.ok(first!.args.includes(`mcp_servers.unreal.url="http://127.0.0.1:${base}/mcp"`), first!.args.join(' '));
  assert.match(first!.env.NO_PROXY!, /127\.0\.0\.1,localhost$/);
  const spec = JSON.parse(readFileSync(path.join(tree, '.alba', 'editor.json'), 'utf8'));
  assert.equal(spec.port, base); assert.equal(spec.match, `-ModelContextProtocolPort=${base}`); assert.equal(spec.match_worktree, `${tree.replace(/\\/g, '/')}/game/Game.uproject`);
  assert.equal(spec.args[1], `${tree.replace(/\\/g, '/')}/game/Game.uproject`);
  assert.ok(existsSync(path.join(tree, '.alba', 'bin', 'editor.mjs')));
  const run = orders.get('MAP1').runs[0]!;
  assert.deepEqual((run as unknown as { editor: unknown }).editor, { pool: 'ue-editor', machine: 'local', port: base, url: `http://127.0.0.1:${base}/mcp`, log: `${tree.replace(/\\/g, '/')}/.alba/editor.log` });
  assert.match(readFileSync(run.prompt_file!, 'utf8'), /## The editor of this run[\s\S]*node \.alba\/bin\/editor\.mjs stop/);
  // The second order gets the other port; the third finds none (the pool resource itself is full first).
  startRun({ project: cfg, orders, workers, probes }, 'MAP2', 'fake');
  assert.equal(editorSlots(cfg).find(s => s.tag === 'MAP2')!.port, base + 1);
  assert.throws(() => startRun({ project: cfg, orders, workers, probes }, 'MAP3', 'fake'), /MAP3 cannot start now: resource ue-editor is full \(2\/2, held by MAP1, MAP2\)/);
  // MAP1's run ends with its editor still up (its wrapper was killed): the tick stops that editor and gives the port back.
  const leftover = spawn(process.execPath, spec.args, { stdio: 'ignore', detached: true });
  leftover.unref();
  const until = Date.now() + 20000;
  while (!(await answers(spec.url, 1000)) && Date.now() < until) await new Promise(r => setTimeout(r, 300));
  assert.equal(await answers(spec.url), true);
  orders.runEnd('MAP1', 'cancelled');
  const done = reconcileEditors(cfg, orders);
  assert.match(done.join('\n'), new RegExp(`MAP1: gave back ue-editor port ${base} on local \\(stopped the editor \\(\\d+\\)\\)`));
  assert.equal(await answers(spec.url, 2000), false);
  assert.deepEqual(editorSlots(cfg).map(s => s.tag), ['MAP2']);
  assert.deepEqual(orders.store.events({ tag: 'MAP1' }).map(e => e.type).filter(t => t.startsWith('editor')), ['editor-slot', 'editor-released']);
  await stopEditors(spec);
});

test('URL MCP servers mount as http for Claude, url for Codex and remote for OpenCode', async () => {
  const { mountRole } = await import('../src/workers/adapters/role-mount.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const role = { id: 'r', source: 'project', definition: { mcp: { unreal: { url: 'http://127.0.0.1:8101/mcp', command: '', args: [] } } } } as unknown as import('../src/roles/config.ts').ResolvedRole;
  for (const engine of ['codex-cli', 'claude-cli', 'opencode']) {
    const cwd = mkdtempSync(path.join(tmpdir(), 'alba-editor-mount-'));
    execFileSync('git', ['init', '-q', cwd]);
    const mount = mountRole(cwd, engine, role);
    if (engine === 'codex-cli') assert.deepEqual(mount.args, ['-c', 'mcp_servers.unreal.url="http://127.0.0.1:8101/mcp"']);
    else if (engine === 'claude-cli') assert.deepEqual(JSON.parse(readFileSync(mount.args[1]!, 'utf8')), { mcpServers: { unreal: { type: 'http', url: 'http://127.0.0.1:8101/mcp' } } });
    else assert.deepEqual(JSON.parse(readFileSync(path.join(cwd, '.opencode/opencode.json'), 'utf8')).mcp.servers, { unreal: { type: 'remote', url: 'http://127.0.0.1:8101/mcp' } });
  }
});

test('editor helper: a server already answering on the port that is not this run editor (other worktree) is refused, never adopted or stopped', async () => {
  const { dir } = tempOrders();
  const editor = fakeEditor(dir);
  const port = base + 200;
  const fwd = dir.split(path.sep).join('/');
  const mine = `${fwd}/mine/game/Game.uproject`, theirs = `${fwd}/theirs/game/Game.uproject`;
  const other = spawn(process.execPath, [editor, theirs, `-ModelContextProtocolPort=${port}`], { stdio: 'ignore' });
  try {
    const until = Date.now() + 20000;
    while (!(await answers(`http://127.0.0.1:${port}/mcp`, 1000)) && Date.now() < until) await new Promise(r => setTimeout(r, 200));
    const spec: EditorSpec = { pool: 'ue-editor', port, program: process.execPath, args: [editor, mine, `-ModelContextProtocolPort=${port}`], url: `http://127.0.0.1:${port}/mcp`, match: `-ModelContextProtocolPort=${port}`, match_worktree: mine, log: path.join(dir, 'editor.log'), ready_minutes: 0.2 };
    assert.deepEqual(findEditors(spec), [], 'the other worktree editor is not ours');
    assert.deepEqual(findEditors({ ...spec, match_worktree: theirs }), [other.pid]);
    const specFile = path.join(dir, 'editor.json');
    writeFileSync(specFile, JSON.stringify(spec));
    const run = spawnSync(process.execPath, [path.resolve('src/editors/editor-helper.mjs'), 'run', '--', process.execPath, '-e', 'console.log("worker ran")'], { env: { ...process.env, ALBA_EDITOR_SPEC: specFile }, encoding: 'utf8', timeout: 90000 });
    assert.equal(run.status, 86);
    assert.match(run.stderr, /already answers, but not from this run's editor/);
    assert.doesNotMatch(run.stdout, /worker ran/);
    assert.equal(await answers(spec.url), true, 'the other editor is left running');
  } finally { other.kill(); }
});

test('editors config: prepare is a command list or a mapping; paths stay in the worktree; numbers have bounds', () => {
  const { dir } = tempOrders();
  const ok = { program: 'ue', args: ['-ModelContextProtocolPort={port}'], url: 'http://127.0.0.1:{port}/mcp', machines: { local: { ports: [9001] } } };
  const pool = (prepare: unknown) => project(dir, 'e.mjs', { editors: { x: { ...ok, prepare } } }).editors!.x!.prepare;
  assert.deepEqual(pool(['python', 'tools/build_ue.py']), { command: ['python', 'tools/build_ue.py'], retry_exit_codes: [], retries: 2, retry_seconds: 30, timeout_minutes: 60 });
  assert.deepEqual(pool({ command: ['node', '.alba/bin/lock.mjs', 'ue', '--', 'python', 'tools/build_ue.py'], skip_if_newer: { outputs: ['game/Binaries/Win64'], inputs: ['game/Source', 'game/G.uproject'] }, retry_exit_codes: [10], retries: 3, retry_seconds: 5, timeout_minutes: 90 }),
    { command: ['node', '.alba/bin/lock.mjs', 'ue', '--', 'python', 'tools/build_ue.py'], skip_if_newer: { outputs: ['game/Binaries/Win64'], inputs: ['game/Source', 'game/G.uproject'] }, retry_exit_codes: [10], retries: 3, retry_seconds: 5, timeout_minutes: 90 });
  const bad = (prepare: unknown, pattern: RegExp) => assert.throws(() => pool(prepare), pattern);
  bad([], /prepare\.command" must be the program/);
  bad({ command: ['x'], when: 1 }, /prepare": unknown key\(s\): when/);
  bad({ command: ['x'], skip_if_newer: { outputs: ['/abs'], inputs: ['src'] } }, /skip_if_newer" must be/);
  bad({ command: ['x'], skip_if_newer: { outputs: ['../out'], inputs: ['src'] } }, /skip_if_newer" must be/);
  bad({ command: ['x'], retry_exit_codes: [0] }, /retry_exit_codes" must be a list of exit codes other than 0/);
  bad({ command: ['x'], retries: 11 }, /retries" must be a whole number from 0 to 10/);
});

test('editor helper: the prepare step runs in the worktree before the editor, is skipped when its outputs are newer, is tried again on a listed exit code, and a failure quotes its log', async () => {
  const { prepareEditor } = await import('../src/editors/editor-helper.mjs');
  const { dir } = tempOrders();
  const wt = path.join(dir, 'wt').split(path.sep).join('/');
  mkdirSync(path.join(wt, 'Source'), { recursive: true }); mkdirSync(path.join(wt, '.alba'), { recursive: true });
  writeFileSync(path.join(wt, 'Source', 'game.cpp'), 'int main() {}\n');
  // A build that fails with 10 (another build holds the tool) the first time, then writes the binary.
  writeFileSync(path.join(wt, 'build.mjs'), `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
if (!existsSync('.alba/tried')) { writeFileSync('.alba/tried', '1'); console.log('another build is running'); process.exit(10); }
mkdirSync('Binaries', { recursive: true }); writeFileSync('Binaries/game.dll', 'built'); console.log('built in', process.cwd());`);
  const prepare = { command: [process.execPath, 'build.mjs'], cwd: wt, log: `${wt}/.alba/editor-prepare.log`, skip_if_newer: { outputs: ['Binaries'], inputs: ['Source'] }, retry_exit_codes: [10], retries: 1, retry_seconds: 0, timeout_minutes: 1 };
  const spec = { pool: 'ue-editor', port: 1, program: 'x', args: [], url: 'http://127.0.0.1:1/mcp', match: '-p=1', log: `${wt}/.alba/editor.log`, ready_minutes: 1, state_file: `${wt}/.alba/editor-state.json`, prepare } as EditorSpec;
  assert.equal(await prepareEditor(spec), 'done');
  assert.equal(readFileSync(path.join(wt, 'Binaries', 'game.dll'), 'utf8'), 'built');
  assert.match(readFileSync(prepare.log, 'utf8'), /another build is running[\s\S]*built in/);
  assert.equal(await prepareEditor(spec), 'skipped', 'the binary is newer than the sources');
  await new Promise(r => setTimeout(r, 20));
  writeFileSync(path.join(wt, 'Source', 'game.cpp'), 'int main() { return 1; }\n');
  writeFileSync(path.join(wt, 'build.mjs'), `console.log('error C2065: undeclared'); process.exit(6);`);
  await assert.rejects(prepareEditor(spec), /prepare step failed with exit code 6 .*see .*editor-prepare\.log\): .*error C2065: undeclared/);
  assert.match(readFileSync(spec.state_file!, 'utf8'), /"state": "failed"/);
  assert.equal(await prepareEditor({ ...spec, prepare: undefined }), undefined);
});

test('editor helper: an editor that gives up quotes the dialog it showed (Unreal logs it under -unattended), or its critical error', async () => {
  const { editorSaid } = await import('../src/editors/editor-helper.mjs');
  const { dir } = tempOrders();
  const log = path.join(dir, 'editor.log');
  writeFileSync(log, '[2026.11.13-13.29.06:001][  0]LogInit: Display: Starting\n[2026.11.13-13.29.07:019][  0]Message dialog closed, result: Ok, title: Message, text: The game module \'Game\' could not be found. Please ensure that this module exists and that it is compiled.\n[2026.11.13-13.29.07:020][  0]LogExit: Exiting.\n');
  assert.equal(editorSaid(log), 'The game module \'Game\' could not be found. Please ensure that this module exists and that it is compiled.');
  writeFileSync(log, 'LogWindows: Error: === Critical error: ===\r\nLogWindows: Error: Assertion failed: Module != nullptr\r\n');
  assert.equal(editorSaid(log), 'Assertion failed: Module != nullptr');
  writeFileSync(log, 'nothing to say\n');
  assert.equal(editorSaid(log), undefined);
  assert.equal(editorSaid(path.join(dir, 'missing.log')), undefined);
});
