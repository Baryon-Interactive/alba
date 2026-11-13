import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../i18n.ts';
import { workerEnvironment } from './environment.ts';

export interface DetachedOptions { cwd: string; env: Record<string, string>; envUnset: string[]; logFile: string; eventsFile?: string; stdinFile?: string }

/**
 * The program that does the real start on Windows. It is run by `spawnDetached`, starts the worker (its output appended to the
 * log), prints the worker's pid and exits at once, so that the worker's parent is a process that no longer exists.
 */
const STARTER = `
const fs = require('fs');
const { spawn } = require('child_process');
const [program, args, cwd, logFile, eventsFile, stdinFile] = JSON.parse(process.argv[1]);
const log = fs.openSync(logFile, 'a');
const output = eventsFile ? fs.openSync(eventsFile, 'a') : log;
const input = stdinFile ? fs.openSync(stdinFile, 'r') : 'ignore';
const child = spawn(program, args, { cwd, detached: true, stdio: [input, output, log], windowsHide: true });
if (typeof input === 'number') fs.closeSync(input);
child.on('error', e => { fs.writeSync(1, 'ERR ' + e.message); process.exit(1); });
child.on('spawn', () => { fs.writeSync(1, 'PID ' + child.pid); child.unref(); process.exit(0); });
`;

/**
 * Starts a program in the background with stdout and stderr appended to a log file, and returns its pid.
 *
 * On Windows a closing terminal can end a whole process tree by following parent pids, and `detached` alone does not take
 * the program out of the tree of the process that started it. So the program is started by a short-lived helper that prints its
 * pid and exits: the program's recorded parent is then gone, and it survives the end of the process that asked for it (for
 * instance `alba serve`). The pid returned is the program's own, not the helper's.
 */
export function spawnDetachedProgram(program: string, args: string[], options: DetachedOptions): number {
  mkdirSync(path.dirname(options.logFile), { recursive: true });
  if (options.eventsFile) {
    mkdirSync(path.dirname(options.eventsFile), { recursive: true });
    args = [fileURLToPath(new URL('./capture.mjs', import.meta.url)), JSON.stringify([program, args])];
    program = process.execPath;
  }
  const env = workerEnvironment(process.env, options.env, options.envUnset);
  if (process.platform === 'win32') {
    const run = spawnSync(process.execPath, ['-e', STARTER, JSON.stringify([program, args, options.cwd, options.logFile, options.eventsFile, options.stdinFile])], { env, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = String(run.stdout ?? '').trim();
    const pid = /^PID (\d+)$/.exec(out)?.[1];
    if (pid) return Number(pid);
    return fail('Could not start {program}: {why}', { program, why: out.replace(/^ERR /, '') || String(run.stderr ?? '').trim().split('\n')[0] || String(run.error?.message ?? 'no answer') });
  }
  const log = openSync(options.logFile, 'a');
  const output = options.eventsFile ? openSync(options.eventsFile, 'a') : log;
  const input = options.stdinFile ? openSync(options.stdinFile, 'r') : 'ignore';
  const child = spawn(program, args, { cwd: options.cwd, env, detached: true, stdio: [input, output, log], windowsHide: true });
  if (typeof input === 'number') closeSync(input);
  closeSync(log);
  if (output !== log) closeSync(output);
  child.on('error', () => { /* a start failure shows up as a missing pid below or an empty log */ });
  child.unref();
  return child.pid ?? fail('Could not start {program}.', { program });
}
