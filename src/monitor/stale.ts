import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { OrderDoc, MonitorSpec } from '../orders/model.ts';
import { startedAtForCheck, type Probes } from '../tick/gather.ts';

/** Observe output in full and named files, retaining only a digest and paths/times. */
export function monitorObservation(spec: MonitorSpec, cwd: string, output: string, probes: Probes, status?: unknown): string {
  const named = [spec.done_when, spec.fail_when].flatMap(c => c && 'file_exists' in c ? [c.file_exists] : []);
  const tokens = [...spec.check.slice(1), ...output.split(/\s+/)].map(s => s.replace(/^["'`([{]+|["'`\])},;:]+$/g, ''));
  for (const token of tokens) if (/[\\/]|\.[a-z][a-z0-9]{0,7}$/i.test(token) && !token.startsWith('-') && !token.includes('://')) named.push(token);
  const files = [...new Set(named)].sort().map(file => [path.resolve(cwd, file), probes.fileTime(path.resolve(cwd, file)) ?? null]);
  return createHash('sha256').update(JSON.stringify([status, output, files])).digest('hex');
}

export function staleMonitor(project: ProjectConfig, doc: OrderDoc, probes: Probes): { reason: string; evidence: Record<string, unknown> } | undefined {
  const m = doc.monitor;
  if (!m || m.resolved) return;
  const spec = doc.reports.find(r => r.seq === m.report_seq)?.monitor;
  if (!spec) return;
  const pid = m.pid ?? spec.pid;
  if (pid) {
    const actual = startedAtForCheck(probes, pid);
    const evidence = { pid, recordedStart: m.process_started_at ?? null, actualStart: actual ?? null, monitorStarted: m.started };
    if (!probes.isAlive(pid)) return { reason: `Monitor PID ${pid} no longer exists. Inspect the job output and repair the failed step before restarting.`, evidence };
    if (actual && (Date.parse(actual) > Date.parse(m.started) || (m.process_started_at && Date.parse(actual) !== Date.parse(m.process_started_at)))) return { reason: `Monitor PID ${pid} was reused by a different process. Find the original job result and repair or replace its check; do not wait on this PID.`, evidence };
  }
  const since = m.changed_at ?? m.started, limit = project.monitor?.stale_minutes ?? 45;
  if (m.observation && probes.now().getTime() - Date.parse(since) >= limit * 60000) return { reason: `Monitor output and named files have not changed for ${limit} minutes. Inspect the job and repair its check or failed step before handing it back to monitoring.`, evidence: { unchangedSince: since, observation: m.observation, tail: m.tail } };
}

