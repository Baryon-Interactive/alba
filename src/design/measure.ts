import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { stateTransaction, writeStateFile } from '../orders/state-files.ts';
import { activeLeases, occupants, readLeases, startBlocked } from '../resources/leases.ts';
import { globToRegExp } from '../check/general.ts';
import { applyChangeSet, readLibrary, stableJson } from './library.ts';
import { pointerValue, projectFile } from './files.ts';
import { DesignError, type Measure, type MeasurementResult, type MeasurementView, type Target } from './model.ts';
import { validateMeasure } from './measure-validate.ts';

const tagFor = (id: string) => `measure-${id}`;
export function measurementEvents(orders: Orders): MeasurementResult[] {
  return orders.store.events().filter(e => e.type === 'design-measurement').map(e => e.data as unknown as MeasurementResult);
}
function mergeKey(orders: Orders, t: Target): string | undefined {
  const patterns = t.measure?.when.after_merge_paths?.map(globToRegExp) ?? [];
  const event = orders.store.events().filter(e => ['design-accepted-tree', 'accept-merged'].includes(e.type) && Array.isArray(e.data?.changed) && (e.data!.changed as string[]).some(p => patterns.some(re => re.test(p)))).at(-1);
  return event ? JSON.stringify([event.tag, event.at, event.data?.merge ?? event.data?.commit]) : undefined;
}
export function measurementViews(project: ProjectConfig, orders: Orders, now = new Date()): MeasurementView[] {
  const events = measurementEvents(orders), leases = activeLeases(project, orders);
  return readLibrary(project).target.map(t => {
    const last = events.filter(e => e.target === t.id).at(-1);
    const running = leases.some(l => l.tag === tagFor(t.id) && l.acceptance?.measurement);
    const due = !!t.measure && (!last || last.definition !== stableJson(t.measure) || mergeKey(orders, t) !== last.merge || now.getTime() - Date.parse(last.at) >= (t.measure.when.every_hours ?? (last.status === 'failed' ? 1 : Infinity)) * 3600000);
    return { target: t.id, due, running, ...(last ? { last } : {}) };
  });
}
export function measurementCwd(root: string, cwd = '.'): string {
  const realRoot = realpathSync(root), full = realpathSync(path.resolve(root, cwd)), rel = path.relative(realRoot, full);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !statSync(full).isDirectory()) throw new DesignError('Measurement cwd leaves the project or is not a directory.');
  return full;
}
export function parseMeasuredValue(measure: Measure, stdout: string, cwd: string): number {
  let value: unknown;
  if ('json_pointer' in measure.value) {
    const input = measure.value.file ? readFileSync(projectFile(cwd, measure.value.file), 'utf8') : stdout;
    value = pointerValue(JSON.parse(input.replace(/^\uFEFF/, '')), measure.value.json_pointer);
  } else {
    const match = new RegExp(measure.value.regex).exec(stdout), raw = match?.[measure.value.group];
    if (raw === undefined || !raw.trim()) throw new DesignError('Regex did not capture a value.');
    value = Number(raw);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DesignError('Measurement value is not a finite number.');
  return value;
}
export interface MeasureOptions { targets?: string[]; dryRun?: boolean; now?: Date; freeRamGb?: () => number | undefined; ordersFirst?: boolean | (() => boolean) }
export interface MeasureOutcome { target: string; status: 'ok' | 'failed' | 'waiting' | 'dry-run'; reason?: string; value?: number; log?: string }

/** The reservation and cap check share the order transaction; dispatch sees these same leases. */
function reserve(project: ProjectConfig, orders: Orders, t: Target, now: Date, ram: number | undefined, dryRun = false): string | undefined {
  return stateTransaction(project, () => {
    const min = project.dispatch.min_free_ram_gb;
    if (min !== undefined && (ram === undefined || ram < min)) return 'Free memory is below the minimum or unavailable.';
    const leases = activeLeases(project, orders), running = occupants(project, orders), m = t.measure!, tag = tagFor(t.id);
    if (leases.some(l => l.tag === tag)) return 'Measurement is already running.';
    if (m.kind) {
      const count = running.filter(o => o.kind === m.kind).length + orders.all().filter(d => ['running', 'monitoring'].includes(orders.stage(d).stage) && d.order.heavy === m.kind).length + leases.filter(l => !l.acceptance?.measurement && !l.acceptance?.nightly && l.acceptance?.cap === m.kind).length;
      if (count >= project.dispatch.caps[m.kind]) return `Kind cap ${m.kind} is full (${count}/${project.dispatch.caps[m.kind]}).`;
    }
    const reason = startBlocked(project.resources ?? {}, leases, running, { tag, kind: m.kind ?? 'measure', uses: m.uses ?? [] });
    if (reason) return reason;
    if (dryRun) return undefined;
    const names = [...new Set([`measure:${t.id}`, ...(m.uses ?? [])])];
    const all = readLeases(project);
    for (const [index, resource] of names.entries()) all.push({ resource, tag, since: now.toISOString(), expires: new Date(now.getTime() + m.timeout_minutes * 60000).toISOString(), acceptance: { pid: process.pid, measurement: true, kind: m.kind, ...(index === 0 && m.kind ? { cap: m.kind } : {}) } });
    writeStateFile(project, '_leases.json', JSON.stringify({ leases: all }));
    return undefined;
  });
}

export async function runMeasurements(project: ProjectConfig, orders: Orders, options: MeasureOptions = {}): Promise<MeasureOutcome[]> {
  const library = readLibrary(project), views = measurementViews(project, orders, options.now);
  if (options.targets?.some(id => !library.target.some(t => t.id === id))) throw new DesignError('Unknown measurement target.', 404);
  const targets = library.target.filter(t => options.targets?.length ? options.targets.includes(t.id) : views.find(v => v.target === t.id)?.due);
  const out: MeasureOutcome[] = [];
  for (const t of targets) {
    if (!t.measure) { out.push({ target: t.id, status: 'waiting', reason: 'No structured measure is configured.' }); continue; }
    validateMeasure(t.measure, project);
    if (typeof options.ordersFirst === 'function' ? options.ordersFirst() : options.ordersFirst) { out.push({ target: t.id, status: 'waiting', reason: 'Eligible orders have dispatch priority.' }); continue; }
    const now = options.now ?? new Date(), m = t.measure;
    const blocked = reserve(project, orders, t, now, (options.freeRamGb ?? (() => os.freemem() / 2 ** 30))(), options.dryRun);
    if (blocked) { out.push({ target: t.id, status: 'waiting', reason: blocked }); continue; }
    if (options.dryRun) { out.push({ target: t.id, status: 'dry-run', reason: views.find(v => v.target === t.id)?.due ? 'Due' : 'Requested explicitly' }); continue; }
    const result: MeasurementResult = { target: t.id, at: now.toISOString(), commit: '', status: 'failed', log: `.alba/design/measurements/${t.id}-${randomUUID()}.log`, merge: mergeKey(orders, t), definition: stableJson(m) };
    let stdout = '', overflow = false;
    try {
      const log = path.join(project.root, result.log); mkdirSync(path.dirname(log), { recursive: true }); writeFileSync(log, '');
      result.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project.root, encoding: 'utf8', windowsHide: true }).trim();
      const cwd = measurementCwd(project.root, m.cwd);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(m.argv[0], m.argv.slice(1), { cwd, shell: false, windowsHide: true, timeout: m.timeout_minutes * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
        if (child.pid) stateTransaction(project, () => {
          const leases = readLeases(project); for (const l of leases) if (l.tag === tagFor(t.id)) l.acceptance!.child_pid = child.pid!;
          writeStateFile(project, '_leases.json', JSON.stringify({ leases }));
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (data: string) => { appendFileSync(log, data); if (stdout.length + data.length < 8 * 1024 * 1024) stdout += data; else overflow = true; });
        child.stderr.on('data', (data: Buffer) => appendFileSync(log, data));
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Measurement exited ${code ?? signal ?? 'without a code'} (timeout ${m.timeout_minutes} minutes).`)));
      });
      if (overflow) throw new DesignError('Measurement stdout exceeded 8 MiB.');
      result.value = parseMeasuredValue(m, stdout, cwd);
      // A concurrent definition edit or merge invalidates this result rather than stamping a new tree with an old value.
      const current = readLibrary(project).target.find(row => row.id === t.id)!;
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project.root, encoding: 'utf8', windowsHide: true }).trim();
      if (current.version !== t.version || head !== result.commit) throw new DesignError('Target or base HEAD changed during measurement; retry.');
      applyChangeSet(project, orders, { title: `Measure ${t.id}`, changes: [{ op: 'update', kind: 'target', id: t.id, base_version: t.version, fields: { last_value: result.value, measured_at: new Date().toISOString(), measured_commit: result.commit, evidence: [{ kind: 'file', ref: result.log }] } }] }, { by: 'measure' });
      result.status = 'ok';
    } catch (e) {
      result.reason = (e as Error).message;
      try { appendFileSync(path.join(project.root, result.log), `\nFAILED: ${result.reason}\n`); } catch { /* event still explains the failure */ }
    } finally {
      // Reservation may now name the exited child's pid. Remove this target's leases explicitly.
      stateTransaction(project, () => writeStateFile(project, '_leases.json', JSON.stringify({ leases: readLeases(project).filter(l => l.tag !== tagFor(t.id)) })));
    }
    orders.store.appendEvent({ at: new Date().toISOString(), tag: '_design', type: 'design-measurement', by: 'measure', data: { ...result } });
    out.push({ target: t.id, status: result.status, reason: result.reason, value: result.value, log: result.log });
  }
  return out;
}
