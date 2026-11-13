import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../../config.ts';
import { workerEnvironment } from '../../run/environment.ts';
import { loadMachines, type Machine } from '../../machines/config.ts';
import type { WorkerConfig } from '../config.ts';

/** Where a worker with `host:` runs its order: the machine, its folders, and the values its launch template sees there. */
export interface RemoteTarget {
  machine: Machine; ssh: string; workspace: string; repo: string; worktree: string;
  /** Launch-template values on the host (cwd, prompt_file, last_file, …). */
  values: Record<string, string>;
}

const slash = (p: string) => p.replace(/\\/g, '/');
export const REMOTE_RUNNER = fileURLToPath(new URL('./remote-run.mjs', import.meta.url));
/** Remote tunnel ports start this far above the local port, and the next one is tried when one is taken. */
const tunnelBase = (port: number) => port + 10000 <= 65515 ? port + 10000 : port - 10000;

/** The machine and folders for a worker that runs elsewhere; refuses a setup it cannot run. */
export function remoteTarget(project: ProjectConfig, worker: WorkerConfig, localWorktree: string, workersFile?: string): RemoteTarget {
  const machines = loadMachines(project, workersFile).machines;
  const machine = machines.find(m => m.id === worker.host);
  if (!machine) throw new Error(`Worker ${worker.id} runs on machine "${worker.host}", which is not in the machine registry.`);
  if (!('ssh' in machine.connect)) throw new Error(`Worker ${worker.id}: machine "${machine.id}" needs an SSH connection.`);
  if (machine.os !== 'windows') throw new Error(`Remote workers on ${machine.os} hosts are unsupported; select a Windows SSH host. Local workers support Windows, Linux and macOS.`);
  if (!machine.workspace) throw new Error(`Machine "${machine.id}" needs a workspace folder before a remote worker can run there.`);
  const workspace = machine.workspace;
  const repo = machine.repos?.[project.id] ?? path.posix.join(workspace, 'repos', `${project.id}.git`);
  const name = path.basename(slash(localWorktree));
  const worktree = path.posix.join(workspace, 'wt', name);
  const order = path.posix.join(worktree, '.alba', 'order');
  return {
    machine, ssh: machine.connect.ssh, workspace, repo, worktree,
    values: { cwd: worktree, prompt_file: `${order}/prompt.md`, last_file: `${order}/last.txt`, log: `${order}/worker.log`, git_dir: repo, worktree_git_dir: `${repo}/worktrees/${name}`, tunnel_port: '{tunnel_port}' },
  };
}

export interface RemoteSpecInput {
  target: RemoteTarget; worker: WorkerConfig; id: string; branch: string; localWorktree: string;
  promptFile: string; lastFile: string; orderFiles: string[]; overlayRoots: string[];
  program: string; args: string[]; env: Record<string, string>; envUnset: string[]; specFile: string;
}

/** Writes the file the remote runner reads, and returns the program and arguments that start it. */
export function writeRemoteSpec(input: RemoteSpecInput): { program: string; args: string[] } {
  const { target, worker } = input;
  const identity = (key: string) => { try { return execFileSync('git', ['-C', input.localWorktree, 'config', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const order = `${target.worktree}/.alba/order`;
  const spec = {
    id: input.id, ssh: target.ssh, os: target.machine.os, workspace: target.workspace, repo: target.repo, worktree: target.worktree, branch: input.branch,
    local_worktree: slash(input.localWorktree), local_stage: slash(input.specFile.replace(/\.json$/, '.stage')),
    order_files: input.orderFiles.map(slash), prompt_file: slash(input.promptFile), last_file: slash(input.lastFile),
    // The prompt names local paths: the order files and the worktree become their copies on the host.
    rewrite: [[slash(input.promptFile), `${order}/prompt.md`], [slash(input.lastFile), `${order}/last.txt`], ...input.orderFiles.map(f => [slash(f), `${order}/${path.basename(f)}`]), [slash(input.localWorktree), target.worktree]],
    overlay_roots: input.overlayRoots,
    program: input.program, args: input.args, env: workerEnvironment({}, input.env, input.envUnset, 'win32'), env_unset: input.envUnset,
    identity: { name: identity('user.name'), email: identity('user.email') },
    ...(worker.tunnel ? { tunnel: worker.tunnel, tunnel_base: tunnelBase(worker.tunnel) } : {}),
    sync_minutes: 3,
  };
  const rewrite = (s: string) => spec.rewrite.reduce((text, [from, to]) => text.split(from).join(to).split(from.replace(/\//g, '\\')).join(to), s);
  spec.args = spec.args.map(rewrite);
  spec.env = Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, rewrite(value!)]));
  writeFileSync(input.specFile, JSON.stringify(spec, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return { program: process.execPath, args: [REMOTE_RUNNER, input.specFile] };
}
