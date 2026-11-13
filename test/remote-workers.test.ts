import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateMachines } from '../src/machines/config.ts';
import { capabilityCommand, suggestRoles } from '../src/machines/capabilities.ts';
import { installPlan } from '../src/machines/install.ts';
import { validateWorkers } from '../src/workers/config.ts';
import { remoteTarget, writeRemoteSpec, workerAdapter } from '../src/workers/adapters/index.ts';
import { runRemote } from '../src/workers/adapters/remote-run.mjs';
import { removeTreeSync } from '../src/fs/remove-tree.mjs';
import type { ProjectConfig } from '../src/config.ts';
import { startRun } from '../src/run/launch.ts';
import { tempOrders } from './helpers.ts';
import { validateProject } from './state-helper.ts';
import { closeStateStores } from '../src/orders/backend.ts';
import type { Probes } from '../src/tick/gather.ts';

const registry = (extra = {}) => ({ machines: [{ id: 'box', name: 'Box', os: 'windows', connect: { ssh: 'box' }, workspace: path.win32.join('W:', path.win32.sep, 'Work', 'alba').replaceAll('\\', '/'), ...extra }] });
const worker = () => validateWorkers({ workers: [{ id: 'remote', engine: 'script', host: 'box', tunnel: 1234, launch: { program: 'node', args: ['worker.mjs', '{tunnel_port}'] } }] }, 'workers.yaml').workers[0]!;

test('remote configuration validates host, tunnel and target OS before dispatch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-remote-config-'));
  try {
    const file = path.join(dir, 'machines.yaml');
    const p = { id: 'game', machines: file } as ProjectConfig;
    const target = (extra = {}) => { writeFileSync(file, JSON.stringify(registry(extra))); return remoteTarget(p, worker(), path.join(dir, 'tree')); };
    assert.equal(target().values.tunnel_port, '{tunnel_port}');
    assert.ok(target().values.prompt_file.endsWith('/.alba/order/prompt.md'));
    assert.throws(() => target({ workspace: undefined }), new RegExp('workspace'));
    assert.throws(() => target({ connect: { local: true } }), /SSH/);
    for (const os of ['linux', 'macos']) assert.throws(() => target({ os, workspace: path.posix.join(path.posix.sep, 'work', 'alba') }), new RegExp(`${os} hosts are unsupported`));
    assert.throws(() => validateMachines(registry({ workspace: 'relative' })), /absolute/);
    assert.throws(() => validateMachines(registry({ workspace: 'bad path' })), /absolute/);
    for (const tunnel of [0, 65536, 1.5, '123']) assert.throws(() => validateWorkers({ workers: [{ id: 'w', engine: 'script', host: 'box', tunnel }] }, 'workers.yaml'), /port number/);
    assert.throws(() => validateWorkers({ workers: [{ id: 'w', engine: 'script', tunnel: 123 }] }, 'workers.yaml'), /requires "host"/);
  } finally { removeTreeSync(dir); }
});

test('project role tools are opt-in, report Python gaps, and expose only supported installers', () => {
  const requirement = { custom: { tools: ['compiler', 'cmake', 'python', 'external'], min_threads: 8, min_ram_gb: 15 } };
  const machine = validateMachines(registry({ role_requirements: requirement })).machines[0]!;
  const caps = { at: 'now', gpus: [], tools: {}, threads: 16, ram_gb: 32 };
  assert.deepEqual(suggestRoles(machine.os, caps), { roles: [], missing: [] });
  const missing = suggestRoles(machine.os, caps, machine.role_requirements).missing;
  assert.deepEqual(missing.map(m => m.item), ['compiler', 'cmake', 'python', undefined]);
  for (const os of ['windows', 'linux', 'macos'] as const) {
    for (const item of ['python', 'node', 'opencode', 'claude-code']) assert.ok(installPlan({ ...machine, os }, item).steps.length);
    assert.equal(suggestRoles(os, { ...caps, tools: { clang: '19', cmake: '4', python: '3', external: '1' } }, requirement).roles[0]!.role, 'custom');
  }
  const command = capabilityCommand('windows');
  assert.match(Buffer.from(command.at(-1)!, 'base64').toString('utf16le'), /WindowsApps/);
  assert.throws(() => validateMachines(registry({ role_requirements: { custom: { tools: [] } } })), /tools/);
});

test('OpenCode requests a UTF-8 final file only when the launch does not already name it', () => {
  const w = { ...worker(), engine: 'opencode' }, adapter = workerAdapter('opencode');
  assert.match(adapter.finalMessagePrompt!(w, 'last.txt'), /last.txt \(UTF-8/);
  assert.equal(adapter.finalMessagePrompt!({ ...w, launch: { ...w.launch!, args: ['--last', '{last_file}'] } }, 'last.txt'), '');
  assert.equal(workerAdapter('script').finalMessagePrompt, undefined);
});

test('core dispatch starts the adapter runner with host paths and no local Claude home or control values', () => {
  const { dir, orders } = tempOrders();
  try {
    const root = path.join(dir, 'project'), orderDir = path.join(dir, 'orders'), machines = path.join(dir, 'machines.yaml');
    mkdirSync(root); mkdirSync(orderDir);
    execFileSync('git', ['init', '-q', '-b', 'main', root], { windowsHide: true });
    execFileSync('git', ['-C', root, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.test', 'commit', '--allow-empty', '-qm', 'Initial'], { windowsHide: true });
    writeFileSync(path.join(orderDir, 'TASK1.md'), '# Assigned task');
    writeFileSync(machines, JSON.stringify(registry()));
    const project = validateProject({ id: 'demo', name: 'Demo', root, state_dir: path.join(dir, 'state'), work_orders: orderDir, machines, dispatch: { worktree_parent: path.join(dir, 'trees'), base_ref: 'main' }, roles: { general: { default: true } } }, path.join(dir, 'alba.yaml'));
    const workers = validateWorkers({ workers: [{ id: 'remote', engine: 'claude-cli', host: 'box', tunnel: 1234, launch: { program: 'claude', args: ['{prompt_file}'], env: { URL: 'http://127.0.0.1:{tunnel_port}', ALBA_PROJECT: 'private', ALBA_SERVICE_TOKEN: 'control' } } }] }, path.join(dir, 'workers.yaml'));
    let started: { program: string; args: string[]; options: any } | undefined;
    const probes = { now: () => new Date(), spawnDetached: (program: string, args: string[], options: any) => { started = { program, args, options }; return 123; } } as unknown as Probes;
    orders.add({ tag: 'TASK1', title: 'Task', kind: 'task' }); orders.act('TASK1', 'queue');
    startRun({ project, orders, workers, probes }, 'TASK1', 'remote');
    assert.equal(started!.program, process.execPath); assert.match(started!.args[0]!, /remote-run\.mjs$/);
    const spec = JSON.parse(readFileSync(started!.args[1]!, 'utf8'));
    assert.deepEqual(started!.options.env, {});
    assert.equal(spec.env.ALBA_PROJECT, undefined); assert.equal(spec.env.ALBA_SERVICE_TOKEN, undefined);
    assert.equal(spec.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(spec.env.URL, 'http://127.0.0.1:{tunnel_port}');
    assert.ok(spec.args.some((a: string) => a.endsWith('/.alba/order/prompt.md')));
    assert.equal(orders.get('TASK1').runs[0]!.host, 'box');
    // A Windows host has no desktop over SSH: the worker is told how to start a program that needs a window.
    const prompt = readFileSync(orders.get('TASK1').runs[0]!.prompt_file!, 'utf8');
    assert.match(prompt, /## This run is on box over SSH/);
    assert.match(prompt, /-File "\$env:ALBA_DESKTOP_RUN" -TimeoutMinutes 30 -- <program> <arguments>/);
  } finally { closeStateStores(); removeTreeSync(dir); }
});

test('desktop-run.ps1 runs a command in the logged-on desktop session, prints its output and passes its exit code', { timeout: 120_000, skip: (process.platform !== 'win32' || !!process.env.CI) && 'needs Windows with a logged-on desktop' }, () => {
  const script = fileURLToPath(new URL('../src/workers/adapters/desktop-run.ps1', import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-desktop-'));
  try {
    const probe = path.join(dir, 'probe.ps1');
    writeFileSync(probe, '"session $((Get-Process -Id $PID).SessionId) in $((Get-Location).Path)"; "arg: $($args[0])"; exit 7\n');
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TimeoutMinutes', '2', '-WorkingDirectory', dir, '--', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe, 'two words'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 7, r.stderr);
    const session = /session (\d+) in (.+)/.exec(r.stdout);
    assert.ok(session && Number(session[1]) > 0, r.stdout);   // session 0 is the services' session, without a desktop
    assert.equal(path.resolve(session![2].trim()).toLowerCase(), path.resolve(dir).toLowerCase());
    assert.match(r.stdout, /arg: two words/);
  } finally { removeTreeSync(dir); }
});

test('a failed archive sender cannot report success and removes its temporary stage', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-remote-transfer-'));
  try {
    const prompt = path.join(dir, 'prompt.md'); writeFileSync(prompt, 'Prompt');
    const spec = { id: 'task-r1', os: 'windows', local_stage: path.join(dir, 'stage'), local_worktree: dir, overlay_roots: [], order_files: [], prompt_file: prompt, rewrite: [], workspace: path.join(dir, 'host'), ssh: 'stand-in' };
    const run = (() => ({ status: 0, stdout: '', stderr: '' })) as unknown as typeof spawnSync;
    const children: ReturnType<typeof spawn>[] = [];
    const closed = new Set<ReturnType<typeof spawn>>();
    const start = ((_program: string, _args: string[], options: any) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(7)'], options);
      children.push(child); child.on('close', () => closed.add(child)); return child;
    }) as typeof spawn;
    await assert.rejects(runRemote(spec, { run, spawn: start, say: () => {} }), /File transfer failed|EPIPE/);
    assert.equal(closed.size, children.length, 'both archive processes close before cleanup and rejection');
    assert.ok(!readdirSync(dir).some(name => /^remote-(stage|result)-/.test(name)));
  } finally { removeTreeSync(dir); }
});

async function remoteRoundTrip(editDuringCollection = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-remote-sync-'));
  const local = path.join(dir, 'local'), workspace = path.join(dir, 'remote'), repo = path.join(workspace, 'repos/game.git'), wt = path.join(workspace, 'wt/order');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(local); mkdirSync(workspace);
    git('init', '-b', 'order', local); git('-C', local, 'config', 'user.name', 'Demo'); git('-C', local, 'config', 'user.email', 'demo@example.test');
    writeFileSync(path.join(local, '.gitignore'), '.alba/\n');
    writeFileSync(path.join(local, 'delete.txt'), 'delete me');
    writeFileSync(path.join(local, 'dirty.txt'), 'initial');
    writeFileSync(path.join(local, 'worker.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const name of ['ALBA_PROJECT','ALBA_SERVICE_TOKEN','CONSOLE_TOKEN','REMOVE']) assert.equal(process.env[name], undefined);
assert.equal(process.env.KEEP, 'ordinary');
assert.equal(process.env.ALBA_EXPLICIT, 'explicit');
assert.equal(process.env.URL, 'http://127.0.0.1:' + process.argv[2]);
assert.ok(readFileSync(process.env.ALBA_PROMPT_FILE,'utf8').includes('.alba/order/order.md'));
assert.equal(readFileSync('.alba/skills/check.md','utf8'), 'Overlay skill');
writeFileSync('committed.txt','remote commit');
const git = (...args) => execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
git('add','committed.txt'); git('commit','-m','Remote work');
writeFileSync('dirty.txt','uncommitted change'); writeFileSync('new.txt','untracked result'); rmSync('delete.txt');
writeFileSync(process.env.ALBA_LAST_FILE,'Remote final message');
`);
    git('-C', local, 'add', '.'); git('-C', local, 'commit', '-m', 'Initial');
    mkdirSync(path.join(local, '.alba/skills'), { recursive: true }); writeFileSync(path.join(local, '.alba/skills/check.md'), 'Overlay skill');
    const prompt = path.join(dir, 'prompt.md'), last = path.join(dir, 'last.txt'), order = path.join(dir, 'order.md'), specFile = path.join(dir, 'remote.json');
    writeFileSync(order, 'Assigned order'); writeFileSync(prompt, `Read ${order.replaceAll('\\', '/')}`);
    const target = { machine: validateMachines(registry()).machines[0]!, ssh: 'box', workspace, repo, worktree: wt, values: {} };
    writeRemoteSpec({ target, worker: worker(), id: 'order-r1', branch: 'order', localWorktree: local, promptFile: prompt, lastFile: last, orderFiles: [order], overlayRoots: ['.alba'], program: process.execPath, args: ['worker.mjs', '{tunnel_port}'],
      env: { ALBA_PROJECT: 'blocked', ALBA_SERVICE_TOKEN: 'blocked', CONSOLE_TOKEN: 'blocked', ALBA_EXPLICIT: 'explicit', ALBA_PROMPT_FILE: prompt, ALBA_LAST_FILE: last, URL: 'http://127.0.0.1:{tunnel_port}' }, envUnset: ['REMOVE'], specFile });
    const spec = JSON.parse(readFileSync(specFile, 'utf8'));
    assert.equal(spec.env.ALBA_PROJECT, undefined); assert.equal(spec.env.CONSOLE_TOKEN, undefined);
    let attempts = 0;
    const commands: string[][] = [], notes: string[] = [];
    const run = ((program: string, args: string[], options: any) => {
      commands.push([program, ...args]);
      if (program === 'ssh') {
        if (args.at(-1)!.includes('-Mode prepare')) { mkdirSync(path.dirname(repo), { recursive: true }); return spawnSync('git', ['init', '--bare', repo], options); }
        return spawnSync(process.execPath, ['-e', ''], options);
      }
      const rewritten = args.filter(a => !a.startsWith('--receive-pack=') && !a.startsWith('--upload-pack=')).map(a => a === `box:${repo}` ? repo : a);
      return spawnSync(program, rewritten, options);
    }) as typeof spawnSync;
    const start = ((program: string, args: string[], options: any) => {
      commands.push([program, ...args]);
      if (program !== 'ssh') return spawn(program, args, options);
      const command = args.at(-1)!;
      // Native cwd accepts Windows paths in both GNU tar and bsdtar; MSYS tar's -C does not accept backslashes.
      if (command.startsWith('tar -xf')) return spawn('tar', ['-xf', '-'], { ...options, cwd: workspace });
      if (command.startsWith('tar -cf')) {
        if (editDuringCollection) writeFileSync(path.join(local, 'dirty.txt'), 'local edit during transfer');
        return spawn('tar', ['-cf', '-', '.'], { ...options, cwd: path.join(workspace, 'runs/order-r1/result') });
      }
      if (++attempts === 1) return spawn(process.execPath, ['-e', 'process.stderr.write("remote port forwarding failed");process.exit(255)'], options);
      const port = command.match(/-Port (\d+)$/)![1]!;
      if (process.platform === 'win32') return spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(workspace, 'runs/order-r1/run.ps1'), '-Mode', 'run', '-Port', port], { ...options, env: { ...process.env, ALBA_PROJECT: 'remote-private', ALBA_SERVICE_TOKEN: 'remote-control', CONSOLE_TOKEN: 'remote-console', KEEP: 'ordinary', REMOVE: 'gone' } });
      return spawn(process.execPath, [fileURLToPath(new URL('./fixtures/remote-host.mjs', import.meta.url)), path.join(workspace, 'runs/order-r1'), port], options);
    }) as typeof spawn;
    const result = runRemote(spec, { run, spawn: start, say: text => notes.push(text) });
    if (editDuringCollection) {
      await assert.rejects(result, /Local worktree changed during result transfer/);
      assert.equal(readFileSync(path.join(local, 'dirty.txt'), 'utf8'), 'local edit during transfer');
      assert.equal(existsSync(path.join(local, 'new.txt')), false);
      assert.equal(existsSync(path.join(local, 'delete.txt')), true);
      assert.equal(existsSync(last), false);
      return;
    }
    assert.equal(await result, 0);
    assert.equal(attempts, 2); assert.ok(commands.some(c => c.includes('-R')));
    assert.equal(readFileSync(path.join(local, 'committed.txt'), 'utf8'), 'remote commit');
    assert.equal(git('-C', local, 'log', '-1', '--format=%s'), 'Remote work');
    assert.equal(readFileSync(path.join(local, 'dirty.txt'), 'utf8'), 'uncommitted change');
    assert.equal(readFileSync(path.join(local, 'new.txt'), 'utf8'), 'untracked result');
    assert.equal(existsSync(path.join(local, 'delete.txt')), false);
    assert.equal(readFileSync(last, 'utf8'), 'Remote final message');
    assert.ok(!readdirSync(dir).some(name => /^remote-(stage|result)-/.test(name)));
    await assert.rejects(runRemote(spec, { run, spawn: start, say: () => {} }), /clean local worktree/);
    assert.ok(!readdirSync(dir).some(name => /^remote-(stage|result)-/.test(name)), 'failure also cleans staging');
  } finally { removeTreeSync(dir); }
}

test('injected SSH syncs commits, dirty files, deletions, reports and environment; retries a tunnel collision', { timeout: 90_000 }, () => remoteRoundTrip());
test('local edits made while collecting remote results are preserved', { timeout: 90_000 }, () => remoteRoundTrip(true));

/**
 * A branch with Git LFS files dispatched to a host whose bare repository has no LFS objects (the push skips them): the objects
 * the host lacks are copied into <bare>/lfs/objects and the worker finds real files; an object missing everywhere stops the
 * dispatch before the worker starts. Runs the real remote-run.ps1 (Windows PowerShell), so it needs Windows and Git LFS.
 */
async function lfsDispatch(dropOne: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-remote-lfs-'));
  const local = path.join(dir, 'local'), workspace = path.join(dir, 'remote'), repo = path.join(workspace, 'repos/game.git').replaceAll('\\', '/'), wt = path.join(workspace, 'wt/order').replaceAll('\\', '/');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(local); mkdirSync(workspace);
    git('init', '-q', '-b', 'order', local); git('-C', local, 'config', 'user.name', 'Demo'); git('-C', local, 'config', 'user.email', 'demo@example.test');
    git('-C', local, 'lfs', 'install', '--local');
    writeFileSync(path.join(local, '.gitattributes'), '*.uasset filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(path.join(local, '.gitignore'), '.alba/\n');
    writeFileSync(path.join(local, 'Hero.uasset'), 'real hero asset bytes');
    writeFileSync(path.join(local, 'Map.uasset'), 'real map asset bytes');
    // The worker checks it got real files, then makes an LFS file of its own and commits it on the host.
    writeFileSync(path.join(local, 'worker.mjs'), `
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
for (const f of ['Hero.uasset', 'Map.uasset']) if (readFileSync(f, 'utf8').startsWith('version https://git-lfs')) { console.error(f + ' is a pointer'); process.exit(9); }
writeFileSync('Made.uasset', 'made on the host');
execFileSync('git', ['add', 'Made.uasset']); execFileSync('git', ['commit', '-q', '-m', 'Host asset']);
writeFileSync(process.env.ALBA_LAST_FILE, 'assets were real');
`);
    git('-C', local, 'add', '.'); git('-C', local, 'commit', '-q', '-m', 'Initial');
    const oids = git('-C', local, 'lfs', 'ls-files', '-l').split('\n').map(l => l.slice(0, 64));
    assert.equal(oids.length, 2);
    if (dropOne) {
      // Settle the index first: a file written in the same second as the index is "racily clean", and the next git command runs
      // the LFS clean filter on it again, which puts the deleted object back into the store.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
      git('-C', local, 'status', '--porcelain');
      rmSync(path.join(local, '.git/lfs/objects', oids[0]!.slice(0, 2), oids[0]!.slice(2, 4), oids[0]!));
    }
    const prompt = path.join(dir, 'prompt.md'), last = path.join(dir, 'last.txt'), order = path.join(dir, 'order.md'), specFile = path.join(dir, 'remote.json');
    writeFileSync(order, 'Assigned order'); writeFileSync(prompt, 'Prompt');
    const target = { machine: validateMachines(registry()).machines[0]!, ssh: 'box', workspace: workspace.replaceAll('\\', '/'), repo, worktree: wt, values: {} };
    writeRemoteSpec({ target, worker: worker(), id: 'order-r1', branch: 'order', localWorktree: local, promptFile: prompt, lastFile: last, orderFiles: [order], overlayRoots: ['.alba'], program: process.execPath, args: ['worker.mjs'], env: { ALBA_LAST_FILE: '.alba/order/last.txt' }, envUnset: [], specFile });
    const spec = JSON.parse(readFileSync(specFile, 'utf8'));
    const ps = (mode: string, extra: string[] = []) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(workspace, 'runs/order-r1/run.ps1'), '-Mode', mode, ...extra];
    const notes: string[] = [];
    const run = ((program: string, args: string[], options: any) => {
      if (program === 'ssh') return args.at(-1)!.includes('-Mode prepare') ? spawnSync('powershell', ps('prepare'), options) : spawnSync(process.execPath, ['-e', ''], options);
      return spawnSync(program, args.filter(a => !a.startsWith('--receive-pack=') && !a.startsWith('--upload-pack=')).map(a => a === `box:${repo}` ? repo : a), options);
    }) as typeof spawnSync;
    const start = ((program: string, args: string[], options: any) => {
      if (program !== 'ssh') return spawn(program, args, options);
      const command = args.at(-1)!;
      const into = /^tar -xf - -C "(.+)"$/.exec(command)?.[1];
      if (into) { mkdirSync(into, { recursive: true }); return spawn('tar', ['-xf', '-'], { ...options, cwd: into }); }
      const from = /^tar -cf - -C "(.+?)" (.+)$/.exec(command);
      if (from) return spawn('tar', ['-cf', '-', ...from[2]!.split(' ')], { ...options, cwd: from[1] });
      return spawn('powershell', ps('run', ['-Port', '0']), options);
    }) as typeof spawn;
    const result = runRemote(spec, { run, spawn: start, say: text => notes.push(text) });
    if (dropOne) {
      await assert.rejects(result, /Remote dispatch failed: 1 Git LFS file\(s\) are still pointer files after checkout.*(Hero|Map)\.uasset/);
      assert.ok(notes.some(n => /1 LFS object\(s\) the branch needs are not in the local store either/.test(n)), notes.join('\n'));
      return;
    }
    assert.equal(await result, 0, notes.join('\n'));
    assert.ok(notes.some(n => /sending 2 LFS object\(s\)/.test(n)), notes.join('\n'));
    assert.equal(readFileSync(path.join(wt, 'Hero.uasset'), 'utf8'), 'real hero asset bytes');
    assert.equal(readFileSync(last, 'utf8'), 'assets were real');
    // The way back: the object of the file the worker committed on the host comes home, and the local file is real.
    assert.ok(notes.some(n => /fetching 1 LFS object\(s\) the host's commits added/.test(n)), notes.join('\n'));
    assert.equal(git('-C', local, 'log', '-1', '--format=%s'), 'Host asset');
    assert.equal(readFileSync(path.join(local, 'Made.uasset'), 'utf8'), 'made on the host');
    assert.equal(git('-C', local, 'status', '--porcelain'), '');
  } finally { removeTreeSync(dir); }
}
const lfsHost = process.platform === 'win32' && spawnSync('git', ['lfs', 'version']).status === 0;
test('remote dispatch copies the LFS objects the host lacks, so the worker gets real files, not pointers', { timeout: 120_000, skip: !lfsHost && 'needs Windows PowerShell and Git LFS' }, () => lfsDispatch(false));
test('remote dispatch stops before the worker starts when an LFS file is still a pointer on the host', { timeout: 120_000, skip: !lfsHost && 'needs Windows PowerShell and Git LFS' }, () => lfsDispatch(true));
