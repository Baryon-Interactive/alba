// The editor of one Alba run, copied into the worktree as .alba/bin/editor.mjs next to .alba/editor.json. Node only, no packages.
//   node .alba/bin/editor.mjs run -- <worker program> <args...>   (Alba's wrapper) start the editor, wait for its MCP server,
//                                                                  run the worker, and stop the editor when the worker ends
//   node .alba/bin/editor.mjs stop | start | restart | status     (for the worker) stop it before a C++ build (it locks the game's
//                                                                  binaries), start it again after; the port, and so the MCP URL, stay
// An editor is found by its command line: the editor program with this run's port argument. Nothing else is ever stopped.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const say = text => process.stderr.write(`[alba editor] ${text}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Command lines compared with forward slashes (and without case on Windows). */
const norm = text => { const s = String(text).replace(/\\/g, '/'); return process.platform === 'win32' ? s.toLowerCase() : s; };

/** Is this command line this run's editor: its port argument, and its worktree argument when the editor is given one. */
const ours = (spec, commandLine) => norm(commandLine).includes(norm(spec.match)) && (!spec.match_worktree || norm(commandLine).includes(norm(spec.match_worktree)));

/** The editor processes of a spec: the program's file name, and in the command line the port argument and the worktree argument. */
export function findEditors(spec) {
  const exe = path.basename(spec.program).toLowerCase();
  if (process.platform === 'win32') {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='${exe.replace(/'/g, "''")}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    let rows = [];
    try { const v = JSON.parse(r.stdout || '[]'); rows = Array.isArray(v) ? v : [v]; } catch { return []; }
    return rows.filter(p => typeof p.CommandLine === 'string' && ours(spec, p.CommandLine)).map(p => p.ProcessId);
  }
  const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '').split('\n').map(l => l.trim().match(/^(\d+)\s+(.*)$/)).filter(m => m && path.basename(m[2].split(' ')[0]).toLowerCase() === exe && ours(spec, m[2])).map(m => Number(m[1]));
}

/** Stops the spec's editors (and what they started) at once, without waiting. Answers the pids. */
export function stopEditorsNow(spec) {
  const pids = findEditors(spec);
  for (const pid of pids) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 60000 });
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  return pids;
}

/** Stops the spec's editors (and what they started) and waits until they are gone. Answers the pids it stopped. */
export async function stopEditors(spec, waitMs = 60000) {
  const pids = findEditors(spec);
  for (const pid of pids) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 60000 });
    else { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  const until = Date.now() + waitMs;
  while (pids.length && findEditors(spec).length && Date.now() < until) await sleep(1000);
  if (process.platform !== 'win32') for (const pid of findEditors(spec)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  return pids;
}

/** Does the MCP endpoint answer `initialize`? */
export async function answers(url, timeoutMs = 10000) {
  try {
    const r = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'alba-editor-check', version: '1' } } }),
    });
    await r.body?.cancel().catch(() => {});
    return r.ok;
  } catch { return false; }
}

function state(spec, fields) {
  if (!spec.state_file) return;
  try { writeFileSync(spec.state_file, JSON.stringify({ port: spec.port, url: spec.url, log: spec.log, at: new Date().toISOString(), ...fields }, null, 2) + '\n'); } catch { /* the state is only for status */ }
}

/** The newest modification time (ms) of the files at or under the paths (relative to cwd); 0 when none exists. */
function newestUnder(cwd, paths) {
  let newest = 0;
  const visit = p => {
    let s;
    try { s = statSync(p); } catch { return; }
    if (s.isDirectory()) { for (const name of readdirSync(p)) visit(path.join(p, name)); }
    else if (s.mtimeMs > newest) newest = s.mtimeMs;
  };
  for (const p of paths) visit(path.resolve(cwd, p));
  return newest;
}

/** Does the prepare step have nothing to do: every output exists (a folder with a file in it) and is newer than every input. */
function upToDate(prepare) {
  const skip = prepare.skip_if_newer;
  if (!skip) return false;
  const outputs = skip.outputs.map(p => newestUnder(prepare.cwd, [p]));
  if (outputs.some(t => t === 0)) return false;
  return Math.min(...outputs) >= newestUnder(prepare.cwd, skip.inputs);
}

/** The last lines of a text file, joined on one line (for a message). */
function tailLine(file, lines = 4) {
  try { return readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-lines).map(l => l.trim()).filter(Boolean).join(' | ').slice(-600); } catch { return ''; }
}

/** Runs the prepare command once with its output appended to the log; answers its exit code (null when it timed out). */
function runPrepare(prepare) {
  return new Promise(resolve => {
    let out;
    try { out = openSync(prepare.log, 'a'); } catch { out = 'ignore'; }
    if (typeof out === 'number') writeSync(out, `\n=== ${new Date().toISOString()} ${prepare.command.join(' ')}\n`);
    const [program, ...args] = prepare.command;
    const child = spawn(program, args, { cwd: prepare.cwd, stdio: ['ignore', out, out], windowsHide: true });
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 60000 });
      else { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      finish(null);
    }, prepare.timeout_minutes * 60000);
    let done = false;
    const finish = code => { if (done) return; done = true; clearTimeout(timer); if (typeof out === 'number') { try { closeSync(out); } catch { /* closed */ } } resolve(code); };
    child.on('error', e => { if (typeof out === 'number') { try { writeSync(out, `could not start: ${e.message}\n`); } catch { /* closed */ } } finish(-1); });
    child.on('exit', code => finish(code ?? -1));
  });
}

/**
 * The pool's prepare step (editors.<pool>.prepare) before the editor starts: for example compiling a C++ game module that a new
 * worktree does not have yet. Skipped when its outputs are newer than its inputs; tried again on the listed exit codes.
 * Answers 'skipped', 'done', or undefined when there is no step; throws with the end of its log when it fails.
 */
export async function prepareEditor(spec) {
  const prepare = spec.prepare;
  if (!prepare) return undefined;
  if (upToDate(prepare)) { say('prepare skipped: its outputs are newer than its inputs'); return 'skipped'; }
  for (let attempt = 0; ; attempt++) {
    say(`preparing: ${prepare.command.join(' ')} (log ${prepare.log})`);
    state(spec, { state: 'preparing', attempt: attempt + 1 });
    const started = Date.now();
    const code = await runPrepare(prepare);
    if (code === 0) { say(`prepared in ${Math.round((Date.now() - started) / 1000)} s`); return 'done'; }
    if (code !== null && prepare.retry_exit_codes.includes(code) && attempt < prepare.retries) {
      say(`prepare ended with ${code}; trying again in ${prepare.retry_seconds} s (${attempt + 1} of ${prepare.retries})`);
      await sleep(prepare.retry_seconds * 1000);
      continue;
    }
    const end = tailLine(prepare.log);
    const why = `the editor's prepare step ${code === null ? `did not end within ${prepare.timeout_minutes} min` : `failed with exit code ${code}`} (${prepare.command.join(' ')}; see ${prepare.log})${end ? `: ${end}` : ''}`;
    state(spec, { state: 'failed', reason: why });
    throw new Error(why);
  }
}

/**
 * What the editor told a person before it gave up: the last message dialog in its log (Unreal writes "Message dialog closed,
 * result: ..., title: ..., text: ..."; under -unattended nobody sees the dialog), or the line after a critical error.
 */
export function editorSaid(log) {
  let text;
  try {
    const size = statSync(log).size;
    const fd = openSync(log, 'r');
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    closeSync(fd);
    text = buffer.toString('utf8');
  } catch { return undefined; }
  const dialogs = [...text.matchAll(/Message dialog closed, result: [^,\r\n]*, title: [^,\r\n]*, text: ([^\r\n]+)/g)];
  if (dialogs.length) return dialogs.at(-1)[1].trim().slice(0, 500);
  const critical = /=== Critical error: ===\s*\r?\n(?:[^\r\n]*\]\s*)?([^\r\n]+)/.exec(text);
  return critical ? critical[1].replace(/^LogWindows: Error:\s*/, '').trim().slice(0, 500) : undefined;
}

/** Starts the editor unless it is up, and waits until its MCP server answers. Throws with the reason when it does not. */
export async function startEditor(spec) {
  if (await answers(spec.url)) {
    const pids = findEditors(spec);
    // Something answers on this port: it is ours only when it is this run's editor (port and worktree); never drive another one.
    if (!pids.length) { const why = `port ${spec.port} already answers, but not from this run's editor (another program or another worktree's editor uses it)`; state(spec, { state: 'failed', reason: why }); throw new Error(why); }
    say(`the editor already answers on ${spec.url}`); state(spec, { state: 'up', pids }); return;
  }
  if (findEditors(spec).length) { say('an editor with this port is still running but does not answer; stopping it first'); await stopEditors(spec); }
  await prepareEditor(spec);
  const started = Date.now();
  say(`starting ${path.basename(spec.program)} on port ${spec.port} (log ${spec.log})`);
  state(spec, { state: 'starting' });
  const child = spec.desktop && process.env.ALBA_DESKTOP_RUN
    ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', process.env.ALBA_DESKTOP_RUN, '-TimeoutMinutes', '1440', '--', spec.program, ...spec.args], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(spec.program, spec.args, { detached: true, stdio: 'ignore', windowsHide: false });
  let failed;
  child.on('error', e => { failed = e.message; });
  child.unref();
  const until = started + spec.ready_minutes * 60000;
  let seen = false;
  while (Date.now() < until) {
    if (failed) break;
    if (await answers(spec.url)) {
      const pids = findEditors(spec);
      say(`the editor answers on ${spec.url} after ${Math.round((Date.now() - started) / 1000)} s`);
      state(spec, { state: 'up', pids, ready_seconds: Math.round((Date.now() - started) / 1000) });
      return;
    }
    // A minute in, the editor must exist: when it is gone, it crashed or never started.
    const running = findEditors(spec).length > 0;
    if (running) seen = true;
    else if (seen || Date.now() - started > 90000) {
      const said = editorSaid(spec.log);
      failed = `the editor ${seen ? 'exited' : 'did not start'} before its MCP server answered${said ? `; it said: "${said}"` : ''} (see ${spec.log})`;
      break;
    }
    await sleep(5000);
  }
  failed ??= `the editor's MCP server did not answer on ${spec.url} within ${spec.ready_minutes} min (see ${spec.log})`;
  await stopEditors(spec);
  state(spec, { state: 'failed', reason: failed });
  throw new Error(failed);
}

export function readSpec(file) {
  if (!existsSync(file)) throw new Error(`no editor for this run (${file} is missing)`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const spec = readSpec(process.env.ALBA_EDITOR_SPEC || path.join(here, '..', 'editor.json'));
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'status') {
    const up = await answers(spec.url);
    console.log(JSON.stringify({ port: spec.port, url: spec.url, up, pids: findEditors(spec), log: spec.log }, null, 2));
    return 0;
  }
  if (command === 'stop') { const pids = await stopEditors(spec); state(spec, { state: 'stopped' }); say(pids.length ? `stopped the editor (${pids.join(', ')})` : 'no editor was running'); return 0; }
  if (command === 'start') { await startEditor(spec); return 0; }
  if (command === 'restart') { await stopEditors(spec); await startEditor(spec); return 0; }
  if (command !== 'run' || rest[0] !== '--' || rest.length < 2) { say('usage: editor.mjs run -- <program> <args...> | start | stop | restart | status'); return 2; }
  try { await startEditor(spec); }
  catch (e) { say(`the run does not start: ${e.message}`); return 86; }
  const [program, ...args] = rest.slice(1);
  const worker = spawn(program, args, { stdio: 'inherit', windowsHide: true });
  let ending = false;
  const end = async (code) => {
    if (ending) return; ending = true;
    const pids = await stopEditors(spec);
    state(spec, { state: 'stopped' });
    say(pids.length ? `the run ended; stopped the editor (${pids.join(', ')})` : 'the run ended; no editor was running');
    process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, () => { try { worker.kill(); } catch { /* gone */ } void end(1); });
  worker.on('error', e => { say(`the worker did not start: ${e.message}`); void end(1); });
  worker.on('exit', code => { void end(code ?? 1); });
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().then(code => { if (code !== undefined) process.exit(code); }, e => { say(e.message); process.exit(1); });
}
