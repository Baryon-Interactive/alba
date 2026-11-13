import type { ProjectConfig } from '../config.ts';
import type { Probes } from '../tick/gather.ts';
import type { Problem } from '../tick/plan.ts';
import { readStateJson, updateStateJson } from '../orders/state-files.ts';
import { loadMachines, tcpAddress, type Machine, type MachinesConfig, type ServiceCheck } from './config.ts';
import { capabilityCommand, parseCapabilities, suggestRoles, type Capabilities, type Suggestions } from './capabilities.ts';
import { engineModule } from './engines/index.ts';
import { onMachine } from './commands.ts';
import { machineJobs, startJob, type MachineJob } from './jobs.ts';
import { prepareInstall, type InstallPlan } from './install.ts';

export interface MachineReading {
  id: string; at: string; reachable: boolean; error?: string;
  free_mem_gb?: number; total_mem_gb?: number; load?: number; uptime_seconds?: number;
  disks: { mount: string; free_gb: number; total_gb: number }[];
  services: { id: string; up: boolean }[];
}
export interface MachineView extends Machine { latest: MachineReading | null; history: MachineReading[]; capabilities: Capabilities | null; suggestions: Suggestions;
  /** The latest jobs on this machine, newest first. */
  jobs: MachineJob[] }
type Stored = Record<string, { latest: MachineReading; history: MachineReading[] }>;
const STATE = '_machines.json', CAPS = '_machines-capabilities.json', DAY = 86400000;
const shQuote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const windowsArg = (s: string) => s && !/[\s"]/.test(s) ? s : `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;

/** Only executable names and exit status are collected; command stdout/stderr is discarded. */
export function machineCommand(machine: Machine): string[] {
  let command: string[];
  if (machine.os === 'windows') {
    // Start the executable directly, preserving native argv on Windows PowerShell 5.1.
    // Drain both streams and stop only this check's own pid on timeout.
    const runCheck = `function Test-ServiceCommand($file,$arguments) { $p=New-Object System.Diagnostics.Process; $p.StartInfo.FileName=$file; $p.StartInfo.Arguments=$arguments; $p.StartInfo.UseShellExecute=$false; $p.StartInfo.CreateNoWindow=$true; $p.StartInfo.RedirectStandardOutput=$true; $p.StartInfo.RedirectStandardError=$true; try { [void]$p.Start(); $p.BeginOutputReadLine(); $p.BeginErrorReadLine(); if ($p.WaitForExit(5000)) { return ($p.ExitCode -eq 0) }; $p.Kill(); return $false } catch { return $false } finally { $p.Dispose() } }`;
    const checks = machine.services.flatMap(s => {
      let argv: string[];
      if ('process' in s.check) {
        const inner = `if (Get-Process -Name ${psQuote(s.check.process.replace(/\.exe$/i, ''))} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`;
        argv = ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inner, 'utf16le').toString('base64')];
      } else if ('command' in s.check) argv = s.check.command;
      else return [];
      return [`$services += @{id=${psQuote(s.id)}; up=(Test-ServiceCommand ${psQuote(argv[0])} ${psQuote(argv.slice(1).map(windowsArg).join(' '))})}`];
    });
    const script = `$ErrorActionPreference='Stop'; ${runCheck}; $os=Get-CimInstance Win32_OperatingSystem; $cpu=Get-CimInstance Win32_Processor; $disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{mount=$_.DeviceID; free_gb=$_.FreeSpace/1GB; total_gb=$_.Size/1GB} }); $services=@(); ${checks.join('; ')}; @{free_mem_gb=$os.FreePhysicalMemory/1MB; total_mem_gb=$os.TotalVisibleMemorySize/1MB; load=($cpu | Measure-Object -Property LoadPercentage -Average).Average/100; uptime_seconds=((Get-Date)-$os.LastBootUpTime).TotalSeconds; disks=$disks; services=$services} | ConvertTo-Json -Depth 5 -Compress`;
    command = ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else {
    const metrics = machine.os === 'linux' ? `awk '/MemAvailable:/{a=$2}/MemTotal:/{t=$2}END{printf "memory\\t%.6f\\t%.6f\\n",a/1048576,t/1048576}' /proc/meminfo
awk '{print "uptime\\t"$1}' /proc/uptime
awk -v cores="$(getconf _NPROCESSORS_ONLN)" '{print "load\\t"$1/cores}' /proc/loadavg` : `total=$(sysctl -n hw.memsize)
vm_stat | awk -v total="$total" 'NR==1{gsub(/[^0-9]/,"",$0);page=$0}/Pages free:|Pages inactive:|Pages speculative:/{gsub(/[^0-9]/,"",$0);free+=$0}END{printf "memory\\t%.6f\\t%.6f\\n",free*page/1073741824,total/1073741824}'
boot=$(sysctl -n kern.boottime | awk '{gsub(/,/,"",$4);print $4}')
printf 'uptime\\t%s\\n' "$(($(date +%s)-boot))"
sysctl -n vm.loadavg | awk -v cores="$(sysctl -n hw.ncpu)" '{print "load\\t"$2/cores}'`;
    const checks = machine.services.flatMap(s => {
      let check: string;
      if ('process' in s.check) check = `ps -A -o comm= | awk -F/ -v name=${shQuote(s.check.process)} '$NF==name {found=1}END{exit !found}'`;
      else if ('command' in s.check) check = `exec ${s.check.command.map(shQuote).join(' ')}`;
      else return [];
      // Watchdog owns only the child pid it starts. No process command lines are read.
      return [`(${check}) >/dev/null 2>&1 & check_pid=$!
(sleep 5; kill -TERM "$check_pid" 2>/dev/null; sleep 0.1; kill -KILL "$check_pid" 2>/dev/null) >/dev/null 2>&1 & watch_pid=$!
if wait "$check_pid"; then check_up=1; else check_up=0; fi
kill "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
printf 'service\\t${s.id}\\t%s\\n' "$check_up"`];
    });
    const script = `export LC_ALL=C
${metrics}
df -Pk ${machine.os === 'linux' ? '-l' : ''} | awk 'NR>1 && $2+0>0 {mount=$6;for(i=7;i<=NF;i++)mount=mount" "$i;printf "disk\\t%s\\t%.6f\\t%.6f\\n",mount,$4/1048576,$2/1048576}'
${checks.join('\n')}
printf 'end\\n'`;
    command = ['sh', '-c', script];
  }
  if ('local' in machine.connect) return command;
  const remote = machine.os === 'windows' ? command.join(' ') : command.map(shQuote).join(' ');
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', machine.connect.ssh, remote];
}

function parseReading(output: string): Partial<MachineReading> {
  if (output.trim().startsWith('{')) return JSON.parse(output);
  const result: Partial<MachineReading> = { disks: [], services: [] };
  if (!output.split(/\r?\n/).includes('end')) throw new Error('Incomplete probe.');
  for (const line of output.split(/\r?\n/)) {
    const [kind, a, b, c] = line.split('\t');
    if (kind === 'memory') { result.free_mem_gb = +a; result.total_mem_gb = +b; }
    if (kind === 'load') result.load = +a;
    if (kind === 'uptime') result.uptime_seconds = +a;
    if (kind === 'disk') result.disks!.push({ mount: a, free_gb: +b, total_gb: +c });
    if (kind === 'service') result.services!.push({ id: a, up: b === '1' });
  }
  return result;
}

/** Network checks originate here even when the target machine uses SSH. */
export function hostCheckCommand(check: ServiceCheck): string[] {
  const script = 'const c=JSON.parse(process.argv[1]); const done=ok=>process.exit(ok?0:1); setTimeout(()=>done(false),5000); if(c.tcp){import("node:net").then(({connect})=>{const s=connect(c.tcp,()=>{s.destroy();done(true)});s.on("error",()=>done(false));});}else{fetch(c.http,{redirect:"manual",signal:AbortSignal.timeout(5000)}).then(r=>done(r.status>=200&&r.status<400),()=>done(false));}';
  return [process.execPath, '-e', script, JSON.stringify('tcp' in check ? { tcp: tcpAddress(check.tcp) } : check)];
}
type Run = (command: string[], timeoutSeconds: number) => Promise<string>;
type ProbeRunner = Pick<Probes, 'now' | 'runCommand' | 'runCommandAsync'>;
/** Probes run as child processes without blocking the event loop; the sync runner is only a fallback for injected fakes. */
const runnerOf = (probes: ProbeRunner): Run => probes.runCommandAsync
  ? (command, seconds) => probes.runCommandAsync!(command, seconds)
  : async (command, seconds) => probes.runCommand(command, seconds);
async function reading(machine: Machine, run: Run, at: string): Promise<MachineReading> {
  const result: MachineReading = { id: machine.id, at, reachable: 'local' in machine.connect, disks: [], services: [] };
  try {
    const raw = parseReading(await run(machineCommand(machine), 15 + machine.services.length * 5));
    result.reachable = true;
    for (const k of ['free_mem_gb', 'total_mem_gb', 'load', 'uptime_seconds'] as const) {
      const v = raw[k]; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('Invalid metrics.'); result[k] = v;
    }
    if (!Array.isArray(raw.disks) || raw.disks.some(d => typeof d.mount !== 'string' || !Number.isFinite(d.free_gb) || !Number.isFinite(d.total_gb) || d.free_gb < 0 || d.total_gb <= 0)) throw new Error('Invalid disks.');
    result.disks = raw.disks.map(d => ({ mount: d.mount, free_gb: d.free_gb, total_gb: d.total_gb }));
    result.services = machine.services.filter(s => 'process' in s.check || 'command' in s.check).map(s => ({ id: s.id, up: raw.services?.some(r => r.id === s.id && r.up === true) ?? false }));
  } catch {
    // Runner errors may contain argv or private command output: never persist them.
    result.error = result.reachable ? 'Health metrics unavailable.' : 'SSH probe failed or timed out.';
  }
  const hostChecks = await Promise.all(machine.services.map(async service => {
    if (!('tcp' in service.check || 'http' in service.check)) return undefined;
    try { await run(hostCheckCommand(service.check), 5); return true; } catch { return false; }
  }));
  machine.services.forEach((service, i) => {
    if (hostChecks[i] !== undefined) result.services.push({ id: service.id, up: hostChecks[i]! });
    else if (!result.services.some(s => s.id === service.id)) result.services.push({ id: service.id, up: false });
  });
  return result;
}
/** What is installed on one machine. A failure is kept as `error` (generic text: runner errors may hold argv or private output). */
export async function scanCapabilities(machine: Machine, probes: ProbeRunner, now = probes.now()): Promise<Capabilities> {
  const command = capabilityCommand(machine.os);
  const argv = 'local' in machine.connect ? command : ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', machine.connect.ssh,
    machine.os === 'windows' ? command.join(' ') : command.map(shQuote).join(' ')];
  try {
    const caps = parseCapabilities(await runnerOf(probes)(argv, 60), now.toISOString());
    const module = machine.engine ? engineModule(machine.engine) : undefined;
    if (module) {
      try { caps.engines = { [module.id]: module.parse(await runnerOf(probes)(onMachine(machine, module.command(machine.os)), 60), machine.os) }; }
      catch { caps.engines = { [module.id]: { versions: [], features: {}, error: 'Engine scan failed.' } }; }
    }
    return caps;
  }
  catch { return { at: now.toISOString(), error: 'Capability scan failed.', gpus: [], tools: {} }; }
}
/** Probes one machine that is not saved yet (the add-machine guide): its reading, what it has and the roles that fit. Nothing is stored. */
export async function probeCandidate(machine: Machine, probes: ProbeRunner, now = probes.now()): Promise<{ reading: MachineReading; capabilities?: Capabilities; suggestions?: Suggestions }> {
  const r = await reading(machine, runnerOf(probes), now.toISOString());
  if (!r.reachable) return { reading: r };
  const capabilities = await scanCapabilities(machine, probes, now);
  return { reading: r, capabilities, suggestions: suggestRoles(machine.os, capabilities, machine.role_requirements) };
}
export function machinesView(project: ProjectConfig, config = loadMachines(project), now = new Date()): MachineView[] {
  const stored = readStateJson<Stored>(project, STATE, {}), caps = readStateJson<Record<string, Capabilities>>(project, CAPS, {});
  return config.machines.map(raw => {
    const m = withEngine(project, raw);
    const capabilities = selectedCapabilities(caps[m.id], m.engine);
    return ({ ...m, latest: stored[m.id]?.latest ?? null, history: (stored[m.id]?.history ?? []).filter(r => Date.parse(r.at) >= now.getTime() - DAY),
    capabilities, suggestions: suggestRoles(m.os, capabilities, m.role_requirements), jobs: machineJobs(project, m.id).filter((j, index) => j.status === 'running' || index < 5) }); });
}
export async function probeMachines(project: ProjectConfig, probes: ProbeRunner, options: { force?: boolean; id?: string; config?: MachinesConfig; workersFile?: string } = {}): Promise<MachineView[]> {
  const config = options.config ?? loadMachines(project, options.workersFile), now = probes.now();
  if (options.id && !config.machines.some(m => m.id === options.id)) throw new Error(`Unknown machine "${options.id}".`);
  const previous = readStateJson<Stored>(project, STATE, {}), run = runnerOf(probes);
  const known = readStateJson<Record<string, Capabilities>>(project, CAPS, {});
  const due = config.machines.filter(machine => {
    if (options.id && machine.id !== options.id) return false;
    const last = previous[machine.id]?.latest;
    return options.force || Object.keys(known[machine.id]?.engines ?? {}).join(',') !== (withEngine(project, machine).engine ?? '') || !last || now.getTime() - Date.parse(last.at) >= config.probe_minutes * 60000;
  });
  const updates = await Promise.all(due.map(machine => reading(machine, run, now.toISOString())));
  if (updates.length) updateStateJson<Stored>(project, STATE, {}, stored => {
    for (const r of updates) stored[r.id] = { latest: r, history: [...(stored[r.id]?.history ?? []).filter(p => Date.parse(p.at) >= now.getTime() - DAY), r] };
    for (const key of Object.keys(stored)) if (!config.machines.some(m => m.id === key)) delete stored[key];
    return stored;
  });
  // What is installed changes rarely: scan once a day, on a forced probe, or when the last scan failed.
  const scanDue = due.filter(m => updates.find(r => r.id === m.id)?.reachable && !updates.find(r => r.id === m.id)?.error
    && (options.force || (Object.keys(known[m.id]?.engines ?? {}).join(',') !== (withEngine(project, m).engine ?? '')) || !known[m.id] || known[m.id].error || Object.values(known[m.id].engines ?? {}).some(e => e.error) || now.getTime() - Date.parse(known[m.id].at) >= DAY));
  const scans = await Promise.all(scanDue.map(m => scanCapabilities(withEngine(project, m), probes, now)));
  if (scans.length || Object.keys(known).some(k => !config.machines.some(m => m.id === k))) updateStateJson<Record<string, Capabilities>>(project, CAPS, {}, stored => {
    scanDue.forEach((m, i) => { stored[m.id] = scans[i]; });
    for (const key of Object.keys(stored)) if (!config.machines.some(m => m.id === key)) delete stored[key];
    return stored;
  });
  return machinesView(project, config, now);
}
/** The install plan for a missing item on a machine, looked up with the latest readings and scans. */
export async function machineInstallPlan(project: ProjectConfig, probes: ProbeRunner, config: MachinesConfig, id: string, item: string): Promise<InstallPlan> {
  const views = machinesView(project, config, probes.now());
  const m = views.find(v => v.id === id);
  if (!m) throw new Error(`Unknown machine "${id}".`);
  const host = views.find(v => 'local' in v.connect && v.os === 'windows');
  return prepareInstall(m, item, { caps: m.capabilities, disks: m.latest?.disks, hostCaps: host?.capabilities, run: runnerOf(probes) });
}
/** Starts installing in the background; when it ends, the machine is probed and scanned again. */
export async function startInstall(project: ProjectConfig, probes: ProbeRunner, config: MachinesConfig, id: string, item: string, ended?: (job: MachineJob) => void): Promise<MachineJob> {
  const plan = await machineInstallPlan(project, probes, config, id, item);
  return startJob(project, plan, { now: () => probes.now(), onEnd: job => { void probeMachines(project, probes, { config, force: true, id }).catch(() => undefined).finally(() => ended?.(job)); } });
}

const withEngine = (project: ProjectConfig, machine: Machine): Machine => ({ ...machine, ...(machine.engine || project.engine ? { engine: machine.engine ?? project.engine } : {}) });
/** Never expose an engine that is no longer selected, including while a fresh scan is pending. */
function selectedCapabilities(caps: Capabilities | undefined, engine?: string): Capabilities | null {
  if (!caps) return null;
  // Stored JSON is not a trusted type boundary: expose only canonical capability fields.
  const { at, error, cpu, cores, threads, ram_gb, os_version, gpus, tools, engines } = caps;
  const general: Capabilities = { at, gpus, tools,
    ...(error === undefined ? {} : { error }), ...(cpu === undefined ? {} : { cpu }),
    ...(cores === undefined ? {} : { cores }), ...(threads === undefined ? {} : { threads }),
    ...(ram_gb === undefined ? {} : { ram_gb }), ...(os_version === undefined ? {} : { os_version }) };
  return engine && engines?.[engine] ? { ...general, engines: { [engine]: engines[engine] } } : general;
}
const refreshing = new Set<string>();
/** For tick callers (board, API, routing): start a due probe in the background and return at once.
 * Ticks read the stored readings, so a slow or unreachable machine never stalls a page. One refresh per state dir at a time. */
export function refreshMachines(project: ProjectConfig, probes: ProbeRunner, config: MachinesConfig): void {
  if (!config.machines.length) return;
  const key = project.state_dir;
  if (refreshing.has(key)) return;
  refreshing.add(key);
  probeMachines(project, probes, { config }).catch(() => { /* readings stay stale; the page shows their age */ }).finally(() => refreshing.delete(key));
}
export function checkLabel(check: ServiceCheck): string {
  const [kind, value] = Object.entries(check)[0]; return `${kind}: ${Array.isArray(value) ? value.join(' ') : value}`;
}
export function machineProblems(views: MachineView[]): Problem[] {
  return views.flatMap(m => {
    const r = m.latest; if (!r) return [];
    const issues: string[] = [];
    if (!r.reachable) issues.push('unreachable');
    else if (r.error) issues.push(r.error);
    if (r.free_mem_gb !== undefined && r.free_mem_gb < m.min_free_mem_gb) issues.push(`free memory ${r.free_mem_gb.toFixed(1)} GB below ${m.min_free_mem_gb} GB`);
    for (const d of r.disks) if (d.free_gb / d.total_gb < 0.1) issues.push(`${d.mount} below 10% free disk`);
    const problems: Problem[] = issues.length ? [{ kind: 'machine-down', text: `machine ${m.id}: ${issues.join('; ')}`, evidence: [m.id] }] : [];
    for (const s of m.services) if (!r.services.find(v => v.id === s.id)?.up) problems.push({ kind: 'machine-down', text: `machine ${m.id}: service ${s.id} is down (${checkLabel(s.check)})`, evidence: [m.id, s.id] });
    return problems;
  });
}
