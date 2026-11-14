import { execFileSync } from 'node:child_process';
import { readdirSync, readlinkSync } from 'node:fs';
import { startedAtForCheck, type Probes } from '../tick/gather.ts';

export interface ExecutableProcess { pid: number; executable: string }

/** Only executable paths, never command lines. Failure is handled conservatively by cleanup. */
export function executableProcesses(): ExecutableProcess[] {
  if (process.platform === 'win32') {
    const rows = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', 'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath)'],
      { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    return rows.filter((p: { ExecutablePath?: string }) => p.ExecutablePath).map((p: { ProcessId: number; ExecutablePath: string }) => ({ pid: p.ProcessId, executable: p.ExecutablePath }));
  }
  if (process.platform === 'linux') return readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(n => {
    try { return [{ pid: Number(n), executable: readlinkSync(`/proc/${n}/exe`) }]; } catch { return []; }
  });
  return execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 30000 }).split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\/.*)$/.exec(line); return m ? [{ pid: Number(m[1]), executable: m[2] }] : [];
  });
}

/** A PID is evidence only when its creation time identifies this run. ps has one-second precision. */
export function runProcess(pid: number | undefined, started: string, recorded: string | undefined, probes: Probes): { active: boolean; reason?: string } {
  if (!pid) return { active: true }; // an open launch or detached monitor still protects its owner
  if (!probes.isAlive(pid)) return { active: false };
  const actual = Date.parse(startedAtForCheck(probes, pid) ?? '');
  const expected = Date.parse(recorded ?? started);
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return { active: true, reason: `Cannot verify the creation time of pid ${pid}.` };
  const matches = recorded ? Math.abs(actual - expected) <= 1000 : actual >= expected - 1000;
  return matches ? { active: true } : { active: false, reason: `pid ${pid} belongs to another process now` };
}
