import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnDetachedProgram } from '../src/run/spawn.ts';
import { stopProcessTree } from '../src/run/kill-tree.ts';
import { systemProbes } from '../src/tick/gather.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const waitFor = async (what: () => boolean, ms = 10000) => { for (let i = 0; i < ms / 100 && !what(); i++) await sleep(100); return what(); };

for (const capture of [false, true]) test(`spawnDetachedProgram: 100k UTF-8 context reaches stdin with EOF${capture ? ' through capture' : ''}`, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-stdin-')), input = path.join(dir, 'prompt.md'), log = path.join(dir, 'run.log'), events = path.join(dir, 'events.jsonl');
  const prompt = '€'.repeat(100000); writeFileSync(input, prompt);
  const pid = spawnDetachedProgram(process.execPath, ['-e', 'let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",v=>text+=v);process.stdin.on("end",()=>console.log(JSON.stringify({length:text.length,last:text.slice(-1)})))'], { cwd: dir, env: {}, envUnset: [], logFile: log, stdinFile: input, ...(capture ? { eventsFile: events } : {}) });
  try {
    assert.ok(await waitFor(() => !alive(pid)), 'stdin is closed and child finishes');
    const result = JSON.parse(readFileSync(capture ? events : log, 'utf8').trim());
    assert.equal(result.length, prompt.length); assert.equal(result.last, '€');
  } finally { if (alive(pid)) process.kill(pid); }
});

test('spawnDetachedProgram: returns the pid of the program itself, with its output appended to the log and the given environment', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-spawn-'));
  const log = path.join(dir, 'sub', 'run.log');
  const pid = spawnDetachedProgram(process.execPath, ['-e', 'console.log("hello " + process.env.ALBA_PROBE + " " + process.cwd()); setTimeout(() => {}, 1500)'], { cwd: dir, env: { ALBA_PROBE: 'yes' }, envUnset: [], logFile: log });
  assert.ok(pid > 0);
  assert.ok(alive(pid), 'the pid is the running program');
  assert.ok(await waitFor(() => !alive(pid)), 'the program ends on its own');
  const text = readFileSync(log, 'utf8');
  assert.match(text, /hello yes /);
  assert.ok(text.toLowerCase().includes(path.basename(dir).toLowerCase()));
});

test('spawnDetachedProgram: a program that cannot be started is an error, not a pid', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-spawn-'));
  assert.throws(() => spawnDetachedProgram(path.join(dir, 'no-such-program'), [], { cwd: dir, env: {}, envUnset: [], logFile: path.join(dir, 'x.log') }), /Could not start/);
});

test('spawnDetachedProgram: the program survives the end of the whole process tree that started it', { skip: process.platform !== 'win32' ? 'Windows tree kill' : false }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alba-spawn-'));
  const marker = `alba-survivor-${Date.now()}`;
  const module = pathToFileURL(path.resolve('src/run/spawn.ts')).href;
  // a stand-in for `alba serve`: starts a long program through spawnDetachedProgram, prints its pid, and keeps running
  const serve = `import { spawnDetachedProgram } from ${JSON.stringify(module)};
    const pid = spawnDetachedProgram(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(marker)}], { cwd: ${JSON.stringify(dir)}, env: {}, envUnset: [], logFile: ${JSON.stringify(path.join(dir, 'run.log'))} });
    console.log('PID ' + pid);
    setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', serve], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let worker = 0;
  try {
    let out = '';
    parent.stdout.on('data', d => { out += d; });
    assert.ok(await waitFor(() => /PID \d+/.test(out), 20000), 'the stand-in started the program: ' + out);
    worker = Number(/PID (\d+)/.exec(out)![1]);
    assert.notEqual(worker, parent.pid);
    const cmd = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${worker}").CommandLine`], { encoding: 'utf8' });
    assert.ok(cmd.includes(marker), 'the pid belongs to the program, not to a helper: ' + cmd);
    const startedAt = systemProbes.processStartedAt!(parent.pid!);
    assert.ok(startedAt, 'the stand-in creation time is readable');
    assert.ok(stopProcessTree(parent.pid!, startedAt).includes(parent.pid!));
    assert.ok(await waitFor(() => !alive(parent.pid!)), 'the stand-in is gone');
    await sleep(1000);
    assert.ok(alive(worker), 'the program is still running');
  } finally {
    if (worker && alive(worker)) process.kill(worker);
    if (parent.pid && alive(parent.pid)) process.kill(parent.pid);
  }
});
