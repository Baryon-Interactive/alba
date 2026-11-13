import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { StateProject } from '../orders/backend.ts';
import { readStateJson, updateStateJson } from '../orders/state-files.ts';
import { InstallRefused, type InstallPlan, type InstallStep } from './install.ts';

/** A job alba runs on a machine (for now: installing something). Jobs with the same lock on a machine run one at a time. */
export interface MachineJob {
  id: string; machine: string; kind: 'install'; item: string; title: string;
  /** Jobs with the same lock on one machine run one at a time. */
  lock?: string;
  display: string[];
  status: 'running' | 'ok' | 'failed' | 'cancelled' | 'interrupted';
  started: string; ended?: string;
  step?: string; exit_code?: number;
  /** The last part of the output (steps' stdout and stderr together). */
  output: string;
  /** The alba process running it; a job whose runner is gone was interrupted (serve restarted). */
  runner_pid: number;
}
const JOBS = '_machine-jobs.json', KEEP = 100, TAIL = 16 * 1024;
const live = new Map<string, { job: MachineJob; children: Set<ChildProcess> }>();
const alive = (pid: number) => { if (pid === process.pid) return true; try { process.kill(pid, 0); return true; } catch { return false; } };

/** All jobs, newest first; a running job whose runner process is gone shows as interrupted. */
export function machineJobs(project: StateProject, machine?: string): MachineJob[] {
  return readStateJson<MachineJob[]>(project, JOBS, [])
    .filter(j => !machine || j.machine === machine)
    .map(j => j.status === 'running' && !alive(j.runner_pid) ? { ...j, status: 'interrupted' as const } : j)
    .sort((a, b) => b.started.localeCompare(a.started));
}
export function runningJob(project: StateProject, machine: string, lock?: string): MachineJob | undefined {
  return machineJobs(project, machine).find(j => j.status === 'running' && (lock === undefined || (j.lock ?? 'install') === lock));
}

function save(project: StateProject, job: MachineJob) {
  updateStateJson<MachineJob[]>(project, JOBS, [], jobs => [job, ...jobs.filter(j => j.id !== job.id)].sort((a, b) => b.started.localeCompare(a.started)).filter((j, i) => j.status === 'running' || i < KEEP));
}

type Spawn = (argv: string[]) => ChildProcess;
const defaultSpawn: Spawn = argv => spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

/** Starts the plan in the background and returns the job at once. `onEnd` runs after it finished (for a rescan). */
export function startJob(project: StateProject, plan: InstallPlan, opts: { now?: () => Date; spawn?: Spawn; onEnd?: (job: MachineJob) => void } = {}): MachineJob {
  const lock = plan.lock ?? 'install';
  const busy = runningJob(project, plan.machine, lock);
  if (busy) throw new InstallRefused(`Machine ${plan.machine} is already running ${busy.title}. Wait for it or cancel it.`);
  const now = opts.now ?? (() => new Date()), run = opts.spawn ?? defaultSpawn;
  const job: MachineJob = { id: randomUUID(), machine: plan.machine, kind: 'install', item: plan.item, title: plan.title, lock, display: plan.display, status: 'running', started: now().toISOString(), output: '', runner_pid: process.pid };
  updateStateJson<MachineJob[]>(project, JOBS, [], jobs => {
    const busy = jobs.find(j => j.machine === plan.machine && j.status === 'running' && alive(j.runner_pid) && (j.lock ?? 'install') === lock);
    if (busy) throw new InstallRefused(`Machine ${plan.machine} is already running ${busy.title}. Wait for it or cancel it.`);
    return [job, ...jobs];
  });
  const children = new Set<ChildProcess>();
  live.set(job.id, { job, children });
  let dirty = false;
  const write = (text: string) => { job.output = (job.output + text).slice(-TAIL); dirty = true; };
  const timer = setInterval(() => { if (dirty) { dirty = false; save(project, job); } }, 3000);
  timer.unref?.();

  const watch = (child: ChildProcess) => {
    children.add(child);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', write);
    return new Promise<number>(resolve => {
      child.on('error', e => { write(`\n${e.message}\n`); resolve(-1); });
      child.on('close', code => { children.delete(child); resolve(code ?? -1); });
    });
  };
  const runStep = async (step: InstallStep): Promise<number> => {
    if ('argv' in step) {
      const child = run(step.argv); child.stdin?.end(); child.stdout?.setEncoding('utf8'); child.stdout?.on('data', write);
      return watch(child);
    }
    // Pipes (copying files) run side by side: many small files are slow one after another, on both ends.
    // Count what passes through instead of printing it.
    let bytes = 0, shown = 0;
    const one = async (p: { from: string[]; to: string[] }) => {
      const from = run(p.from), to = run(p.to);
      from.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes - shown >= 2 ** 30) { shown = bytes; write(`Copied ${(bytes / 2 ** 30).toFixed(1)} GB\n`); }
      });
      from.stdout!.pipe(to.stdin!);
      to.stdout?.setEncoding('utf8'); to.stdout?.on('data', write);
      to.stdin!.on('error', () => undefined);
      const [a, b] = await Promise.all([watch(from), watch(to)]);
      return a !== 0 ? a : b;
    };
    const codes = await Promise.all(('pipes' in step ? step.pipes : [step.pipe]).map(one));
    write(`Copied ${(bytes / 2 ** 30).toFixed(1)} GB in total\n`);
    return codes.find(c => c !== 0) ?? 0;
  };
  void (async () => {
    let code = 0;
    try {
    for (const step of plan.steps) {
      if (job.status !== 'running') break;
      job.step = step.label; write(`== ${step.label}\n`); save(project, job);
      code = await runStep(step);
      if (code !== 0 && !(plan.ok_codes ?? []).includes(code)) break;
      code = 0;
    }
    } catch (e) { code = -1; write(`\n${(e as Error).message}\n`); }
    clearInterval(timer);
    live.delete(job.id);
    if (job.status === 'running') job.status = code === 0 ? 'ok' : 'failed';
    job.exit_code = code; job.ended ??= now().toISOString();
    save(project, job);
    try { opts.onEnd?.(job); } catch { /* a failed rescan leaves the old scan */ }
  })();
  return job;
}

/** Stops a job this alba process runs. Stopping the local ssh client may leave a remote installer to finish on its own. */
export function cancelJob(project: StateProject, id: string, now = new Date()): MachineJob {
  const job = machineJobs(project).find(j => j.id === id);
  if (!job) throw new InstallRefused(`No job ${id}.`);
  if (job.status !== 'running') throw new InstallRefused(`Job ${id} is not running.`);
  const entry = live.get(id);
  if (!entry) throw new InstallRefused('This job runs in another alba process; stop it there.');
  // The runner sees the status and keeps it when the killed steps return.
  Object.assign(entry.job, { status: 'cancelled', ended: now.toISOString(), output: (entry.job.output + '\nCancelled.\n').slice(-TAIL) });
  save(project, entry.job);
  for (const child of entry.children) child.kill();
  return entry.job;
}
