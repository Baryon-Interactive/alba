import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { stateTransaction, writeStateFile } from '../orders/state-files.ts';
import { activeLeases, ensureOwnStartedAt, leaseProcessIdentity, primeLeaseIdentities, readLeases } from '../resources/leases.ts';
import { stopTreeAsync } from '../run/kill-tree.ts';
import { measurementCwd } from '../design/measure.ts';
import { pointerValue, projectFile } from '../design/files.ts';
import { syncNightlyCases } from '../producer/producer.ts';
import { gatesConfig, type GateValue, type NightlyGate } from './config.ts';
import { GATES_STATE, gatesState, type GateResult, type GatesState, type NightlyRun, type StuckTree } from './state.ts';
import { gateCommand, GateSetupError, gitText, type GateCommandOptions, type GateCommandResult } from './command.ts';
import { FORCED_WAIT_MS, planPass } from './plan.ts';
import { blockedReason, extend, LOCK, release, reserve, tagFor } from './reserve.ts';
import { addScratch, removeScratch } from './scratch.ts';

const save = (project: ProjectConfig, state: GatesState) => writeStateFile(project, GATES_STATE, JSON.stringify(state));
const stamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const baseRef = (project: ProjectConfig): string => {
  const ref = project.dispatch.base_ref ?? 'refs/heads/main';
  if (/^(origin\/|refs\/remotes\/)/.test(ref)) throw new Error(`"dispatch.base_ref" is ${ref}: use a local branch such as refs/heads/main, not a remote-tracking ref.`);
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
};

/** Start inclusive, end exclusive, including windows spanning midnight. */
export function nightlyWindow(window: string, now: Date): { inside: boolean; night: string } {
  const [start, end] = window.split('-').map(s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
  const minute = now.getHours() * 60 + now.getMinutes(), day = new Date(now);
  if (start > end && minute < end) day.setDate(day.getDate() - 1);
  return { inside: start < end ? minute >= start && minute < end : minute >= start || minute < end, night: stamp(day) };
}

/** Attribution uses ancestry, including manual approvals and fast-forwarded deliveries. Git is read asynchronously, in two calls at most. */
async function mergedOrders(project: ProjectConfig, orders: Orders, from: string | undefined, commit: string): Promise<string[]> {
  const result = new Set<string>();
  const commits = new Set((await gitText(project.root, ['rev-list', from ? `${from}..${commit}` : commit])).trim().split(/\s+/));
  for (const event of orders.store.events()) {
    if (!['accept-merged', 'design-accepted-tree'].includes(event.type)) continue;
    const sha = event.data?.merge ?? event.data?.commit;
    if (typeof sha === 'string' && commits.has(sha)) result.add(event.tag);
  }
  const approved = orders.all().filter(d => d.actions.some(a => a.kind === 'approve') && d.order.branch && !result.has(d.order.tag));
  if (approved.length) {
    // One call resolves every branch; a deleted branch simply is not listed (merge events remain authoritative for it).
    const heads = new Map((await gitText(project.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).split('\n').flatMap(line => {
      const [name, sha] = line.trim().split(' ');
      return name && sha ? [[name, sha] as const] : [];
    }));
    for (const doc of approved) { const sha = heads.get(`refs/heads/${doc.order.branch}`); if (sha && commits.has(sha)) result.add(doc.order.tag); }
  }
  return [...result].sort();
}

export interface GateRunOptions {
  now?: Date;
  clock?: () => Date;
  force?: boolean;
  gate?: string;
  /** Replaces the dispatch-priority rule (tests). Without it the same rule applies to the CLI and serve. */
  ordersFirst?: boolean | (() => boolean);
  freeRamGb?: () => number | undefined;
  /** Tests: replace the lookup of start times and the process-tree stop. */
  commandOptions?: GateCommandOptions;
  /** How many nights of runs and their folders are kept (default 14; tests use fewer). */
  keepNights?: number;
}
export interface GateRunOutcome { status: 'skipped' | NightlyRun['status']; reason?: string; run?: NightlyRun }

function valueOf(reader: GateValue, stdout: string, cwd: string): unknown {
  if ('json_pointer' in reader) {
    try { return pointerValue(JSON.parse((reader.file ? readFileSync(projectFile(cwd, reader.file), 'utf8') : stdout).replace(/^\uFEFF/, '')), reader.json_pointer); }
    catch (error) { throw new GateSetupError(`Cannot read gate result: ${(error as Error).message}`); }
  }
  const raw = new RegExp(reader.regex).exec(stdout)?.[reader.group];
  if (raw === undefined || !raw.trim()) throw new Error('Regex did not capture a value.');
  return Number(raw);
}

async function execute(project: ProjectConfig, gate: NightlyGate, scratch: string, run: NightlyRun, log: string, commandOptions?: GateCommandOptions): Promise<{ result: GateResult; stuck?: StuckTree }> {
  const result: GateResult = { gate: gate.name, commit: run.commit, started: new Date().toISOString(), ended: '', status: 'failed', exit: null, timedOut: false, log };
  writeFileSync(log, '');
  let outcome: Partial<GateCommandResult> | undefined;
  try {
    let cwd: string;
    try { cwd = measurementCwd(scratch, gate.cwd); }
    catch (error) { throw new GateSetupError((error as Error).message); }
    let command: GateCommandResult;
    try {
      command = await gateCommand(gate.argv, cwd, gate.timeout_minutes * 60000, log, (pid, startedAt) => {
        stateTransaction(project, () => {
          const leases = readLeases(project);
          for (const l of leases) if ([LOCK, tagFor(gate.name)].includes(l.tag) && l.acceptance?.pid === process.pid) {
            l.acceptance.child_pid = pid; l.acceptance.child_started_at = startedAt;
          }
          writeStateFile(project, '_leases.json', JSON.stringify({ leases }));
        });
      }, { stopDeadlineMs: 120_000, ...commandOptions, onMembers: members => {
        stateTransaction(project, () => {
          const leases = readLeases(project);
          for (const l of leases) if ([LOCK, tagFor(gate.name)].includes(l.tag) && l.acceptance?.pid === process.pid) l.acceptance.tree_members = members;
          writeStateFile(project, '_leases.json', JSON.stringify({ leases }));
        });
        commandOptions?.onMembers?.(members);
      }, beforeStop: () => {
        extend(project, tagFor(gate.name), Date.now() + (commandOptions?.stopDeadlineMs ?? 120_000) + HOUR);
        extend(project, LOCK, Date.now() + (commandOptions?.stopDeadlineMs ?? 120_000) + HOUR);
        commandOptions?.beforeStop?.();
      } });
    } catch (error) { outcome = error as Partial<GateCommandResult>; throw error; }
    outcome = command;
    const { stdout } = command; result.exit = command.exit; result.timedOut = command.timedOut;
    if (result.timedOut) throw new Error(`Gate timed out after ${gate.timeout_minutes} minutes.`);
    if (result.exit !== 0) throw new Error(`Gate exited ${result.exit ?? 'without an exit code'}.`);
    if (gate.result) {
      const p = gate.result.pass;
      const passed = 'json_pointer' in p ? valueOf(p, stdout, cwd) === (Object.hasOwn(p, 'equals') ? p.equals : true) : new RegExp(p.regex).test(stdout);
      if (gate.result.value) {
        const value = valueOf(gate.result.value, stdout, cwd);
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Result value is not a finite number.');
        result.value = value;
      }
      if (!passed) throw new Error('Result reader reported failure.');
    }
    result.status = 'passed';
  } catch (error) { if (error instanceof GateSetupError) result.status = 'error'; result.reason = (error as Error).message; }
  // A tree that is not confirmed gone is an infrastructure problem, whatever the command itself reported.
  let stuck: StuckTree | undefined;
  if (outcome?.tree && !outcome.tree.gone && outcome.pid) {
    const why = outcome.tree.problem ?? 'Processes were still running after the stop attempts.';
    stuck = { run: run.id, gate: gate.name, tag: tagFor(gate.name), pid: outcome.pid, startedAt: outcome.startedAt, notBefore: outcome.spawnedAt ?? Date.now(), since: new Date().toISOString(), reason: why, members: outcome.members };
    result.status = 'error'; result.reason = `${result.reason ? `${result.reason} ` : ''}The gate's processes could not be confirmed stopped (${why}); its resources stay reserved.`;
  }
  if (result.status !== 'passed') { try { appendFileSync(log, `\n${result.status.toUpperCase()}: ${result.reason}\n`); } catch { /* durable result records the failure even if the log is locked */ } }
  result.ended = new Date().toISOString();
  return { result, stuck };
}


const HOUR = 3_600_000;

/**
 * Retries the stop of every gate process tree that could not be confirmed gone. Their leases stay held (and are renewed) until a
 * fresh process listing shows no member; only then are the gate's resources and the batch lock given back.
 */
async function settleStuck(project: ProjectConfig, orders: Orders, options: GateRunOptions): Promise<void> {
  const stuck = gatesState(project).stuck ?? [];
  if (!stuck.length) return;
  const stop = options.commandOptions?.stopTree ?? stopTreeAsync, gone: StuckTree[] = [];
  for (const s of stuck) {
    extend(project, s.tag, Date.now() + HOUR); extend(project, LOCK, Date.now() + HOUR);
    if ((s.retryAt ?? 0) > Date.now()) continue;
    if ((await stop({ pid: s.pid, startedAt: s.startedAt, notBefore: s.notBefore, members: s.members }, 60_000)).gone) gone.push(s);
    else { s.retries = (s.retries ?? 0) + 1; s.retryAt = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(s.retries - 1, 5)); }
  }
  const released = stateTransaction(project, () => {
    const state = gatesState(project);
    const confirmed = (state.stuck ?? []).filter(x => gone.some(g => g.run === x.run && g.gate === x.gate));
    state.stuck = (state.stuck ?? []).filter(x => !confirmed.includes(x)).map(x => stuck.find(s => s.run === x.run && s.gate === x.gate) ?? x);
    save(project, state);
    for (const s of confirmed) release(project, s.tag, true);
    // Only the lock of the batch that left these trees: a batch started later took its lock after they were recorded.
    if (!state.stuck.length && confirmed.length) {
      const recorded = Math.max(...confirmed.map(s => Date.parse(s.since)));
      writeStateFile(project, '_leases.json', JSON.stringify({ leases: readLeases(project).filter(l => !(l.tag === LOCK && l.acceptance?.nightly && Date.parse(l.since) <= recorded)) }));
    }
    return confirmed;
  });
  for (const s of released) {
    orders.store.appendEvent({ at: new Date().toISOString(), tag: '_gates', type: 'nightly-notice', by: 'gates', data: { text: `Nightly gate ${s.gate}: its processes are gone; the reserved resources are free again.` } });
  }
}

/** A person cancels runs that are not finished. Refused while a batch holds the lock. */
export function cancelNightlyRuns(project: ProjectConfig, orders: Orders): { cancelled: number; reason?: string } {
  return stateTransaction(project, () => {
    if (activeLeases(project, orders).some(l => l.tag === LOCK)) return { cancelled: 0, reason: 'A nightly batch is running or still stopping its processes.' };
    const state = gatesState(project), open = state.runs.filter(r => !r.ended), at = new Date().toISOString();
    for (const r of open) { r.status = 'abandoned'; r.reason = 'Cancelled by a person.'; r.ended = at; }
    if (open.length) save(project, state);
    return { cancelled: open.length };
  });
}

/** One batch per local night, serialized across serve and CLI through the dispatch lease transaction. */
export async function runNightlyGates(project: ProjectConfig, orders: Orders, options: GateRunOptions = {}): Promise<GateRunOutcome> {
  await ensureOwnStartedAt();
  if (!project.gates?.nightly.length) {
    if (gatesState(project).runs.some(r => !r.ended) && !activeLeases(project, orders).some(l => l.tag === LOCK)) stateTransaction(project, () => {
      const state = gatesState(project);
      const pending = state.runs.filter(r => !r.ended);
      for (const r of pending) { r.status = 'abandoned'; r.reason = 'Nightly gates disabled.'; r.ended = new Date().toISOString(); }
      if (pending.length) save(project, state);
    });
    return { status: 'skipped', reason: 'No nightly gates configured.' };
  }
  const currentTime = () => options.now ?? options.clock?.() ?? new Date();
  const config = gatesConfig(project.gates, project), now = currentTime(), window = nightlyWindow(config.window, now);
  if (options.gate && !config.nightly.some(g => g.name === options.gate)) throw new Error(`Unknown nightly gate: ${options.gate}`);
  const definition = JSON.stringify(config), names = config.nightly.filter(g => !options.gate || g.name === options.gate).map(g => g.name);
  const parent = path.join(project.state_dir, 'nightly-gates'), checkout = config.worktree_timeout_minutes * 60000;
  const notice = (text: string) => orders.store.appendEvent({ at: new Date().toISOString(), tag: '_gates', type: 'nightly-notice', by: 'gates', data: { text } });
  /** A problem that persists is reported once per night, not on every pass. */
  const noticeOnce = (text: string) => {
    if (gatesState(project).notices?.[text] === window.night) return;
    stateTransaction(project, () => {
      const state = gatesState(project);
      save(project, { ...state, notices: { ...Object.fromEntries(Object.entries(state.notices ?? {}).filter(([, night]) => night === window.night)), [text]: window.night } });
    });
    notice(text);
  };
  const reserveOptions = { now, freeRamGb: options.freeRamGb, ordersFirst: options.ordersFirst };
  // Everything slow or asynchronous happens here, before any transaction: our own start time, other processes' start times, stuck trees.
  await primeLeaseIdentities(project);
  await settleStuck(project, orders, options);
  const decide = (state: GatesState) => {
    let head: string | undefined;
    return planPass({
      state, now, window, force: !!options.force, selected: !!options.gate, names, definition, onlyIfMerged: config.only_if_merged,
      head: async () => head ??= (await gitText(project.root, ['rev-parse', '--verify', `${baseRef(project)}^{commit}`])).trim(),
      hasMerges: async commit => state.lastFull ? commit !== state.lastFull.commit
        : orders.store.events().some(e => ['accept-merged', 'design-accepted-tree'].includes(e.type)) || orders.all().some(d => d.actions.some(a => a.kind === 'approve')) || !!(await gitText(project.root, ['rev-list', '--merges', '-1', commit])).trim(),
    });
  };
  // Cheap checks without the lock or any write: most passes end here.
  try {
    const early = await decide(gatesState(project));
    if (early.action.kind === 'skip' && !early.stale.length) return { status: 'skipped', reason: early.action.reason };
    if (early.action.kind === 'resume' && early.action.run.status === 'waiting' && !early.stale.length) {
      const waiting = early.action.run;
      const next = config.nightly.find(g => waiting.names.includes(g.name) && !waiting.results.some(r => r.gate === g.name));
      const blocked = !next ? undefined : !(waiting.forced || options.force) && !window.inside ? { reason: 'Outside the nightly window.' } : blockedReason(project, orders, next, reserveOptions);
      if (blocked && 'capped' in blocked && blocked.capped) noticeOnce(blocked.capped);
      if (blocked?.reason && blocked.reason === waiting.reason) return { status: 'waiting', reason: blocked.reason, run: waiting };
    }
  } catch (error) { noticeOnce((error as Error).message); return { status: 'error', reason: (error as Error).message }; }
  const identity = leaseProcessIdentity();
  const acquired = stateTransaction(project, () => {
    if (activeLeases(project, orders).some(l => l.tag === LOCK)) return false;
    const all = readLeases(project).filter(l => l.tag !== LOCK);
    const lifetime = config.nightly.reduce((sum, g) => sum + g.timeout_minutes * 60000 + 120000, 120000) + 2 * checkout;
    all.push({ resource: LOCK, tag: LOCK, since: new Date().toISOString(), expires: new Date(Date.now() + lifetime).toISOString(), acceptance: { ...identity, nightly: true } });
    writeStateFile(project, '_leases.json', JSON.stringify({ leases: all })); return true;
  });
  if (!acquired) return { status: 'waiting', reason: 'A nightly batch is already running.' };
  // Renew through setup, execution, stop and cleanup; real time is independent of the scheduling clock.
  const renewal = setInterval(() => {
    try {
      for (const tag of new Set(readLeases(project).filter(l => l.acceptance?.nightly && l.acceptance.pid === process.pid).map(l => l.tag))) extend(project, tag, Date.now() + HOUR);
    } catch (error) { noticeOnce(`Could not renew nightly leases: ${(error as Error).message}`); }
  }, 30_000);
  renewal.unref();
  let run: NightlyRun | undefined, scratch: string | undefined, created = false, stuckRun = false;
  let state: GatesState;
  const updatedRuns = new Set<string>(), updatedFailures = new Set<string>();
  let addedStuck: StuckTree | undefined;
  const persist = (finish = false) => stateTransaction(project, () => {
    // Other processes may settle trees or record notices while a gate runs. Only merge this pass's changes.
    const latest = gatesState(project);
    if (run) updatedRuns.add(run.id);
    for (const changed of state.runs.filter(r => updatedRuns.has(r.id))) {
      const index = latest.runs.findIndex(r => r.id === changed.id);
      if (index < 0) latest.runs.push(changed); else latest.runs[index] = changed;
    }
    for (const name of updatedFailures) {
      if (state.failures[name]) latest.failures[name] = state.failures[name]; else delete latest.failures[name];
    }
    if (addedStuck) latest.stuck = [...(latest.stuck ?? []), addedStuck];
    let expired: NightlyRun[] = [];
    if (finish) {
      if (run?.full && run.ended && !run.forced && ['passed', 'failed'].includes(run.status)) {
        latest.lastFull = { commit: run.commit, at: run.ended };
        if (run.status === 'passed') latest.lastPass = { commit: run.commit, at: run.ended };
      }
      const nights = [...new Set(latest.runs.map(r => r.night))].sort().slice(-(options.keepNights ?? 14));
      expired = latest.runs.filter(r => !nights.includes(r.night));
      latest.runs = latest.runs.filter(r => nights.includes(r.night));
    }
    save(project, latest);
    updatedRuns.clear(); updatedFailures.clear(); addedStuck = undefined;
    return expired;
  });
  try {
    state = gatesState(project);
    const plan = await decide(state);
    for (const old of plan.stale) {
      old.status = 'abandoned'; old.ended = now.toISOString(); old.reason = 'Superseded by a later night or changed gate selection/configuration.';
      updatedRuns.add(old.id);
      orders.store.appendEvent({ at: old.ended, tag: '_gates', type: 'nightly-run', by: 'gates', data: { ...old } });
    }
    if (plan.stale.length) persist();
    if (plan.action.kind === 'skip') return { status: 'skipped', reason: plan.action.reason };
    // A dead host may have left a checkout. The batch lock checks the recorded child too, so cleanup happens only once both
    // the former host and its command have exited. A run with a tree that is not confirmed gone keeps its checkout.
    for (const old of state.runs) if (/^[a-f0-9-]{36}$/.test(old.id) && !state.stuck?.some(s => s.run === old.id)) {
      const abandoned = path.join(parent, `worktree-${old.id}`);
      if (existsSync(abandoned)) { const problem = await removeScratch(project, abandoned, checkout); if (problem) noticeOnce(problem); }
    }
    if (plan.action.kind === 'new') {
      const commit = plan.action.commit, last = state.lastPass?.commit;
      const merged = await mergedOrders(project, orders, last, commit);
      if (!options.force && config.only_if_merged && !state.lastFull && !merged.length && !(await gitText(project.root, ['rev-list', '--merges', '-1', commit])).trim()) return { status: 'skipped', reason: 'Nothing merged since the last full run.' };
      run = { id: randomUUID(), night: window.night, commit, from: last, mergedOrders: merged, started: now.toISOString(), status: 'running', full: names.length === config.nightly.length, forced: !!options.force, ...(options.force ? { deadline: new Date(now.getTime() + FORCED_WAIT_MS).toISOString() } : {}), names, definition, results: [], attempts: 1 };
      state.runs.push(run);
      orders.store.appendEvent({ at: now.toISOString(), tag: '_gates', type: 'nightly-run-start', by: 'gates', data: { ...run } });
    } else {
      run = plan.action.run;
      if (plan.action.kind === 'retry') {
        // The checkout and its logs of an errored attempt stay; only the errored gates run again.
        run.results = run.results.filter(r => r.status !== 'error'); run.attempts = (run.attempts ?? 1) + 1; delete run.ended;
        orders.store.appendEvent({ at: now.toISOString(), tag: '_gates', type: 'nightly-run-start', by: 'gates', data: { ...run } });
      }
    }
    run.status = 'running'; delete run.reason; persist();
    const dir = path.join(parent, `logs-${run.id}`); mkdirSync(dir, { recursive: true });
    for (const gate of config.nightly.filter(g => run!.names.includes(g.name) && !run!.results.some(r => r.gate === g.name))) {
      if (!run.forced && !options.force && !nightlyWindow(config.window, currentTime()).inside) { run.status = 'waiting'; run.reason = 'Outside the nightly window.'; break; }
      const blocked = reserve(project, orders, gate, { ...reserveOptions, now: currentTime() });
      if (blocked.capped) noticeOnce(blocked.capped);
      if (blocked.reason) {
        if (blocked.reason.startsWith('Queued orders') && blocked.reason !== run.reason) notice(blocked.reason);
        run.status = 'waiting'; run.reason = blocked.reason; break;
      }
      let stuck: StuckTree | undefined;
      try {
        extend(project, tagFor(gate.name), Date.now() + checkout + gate.timeout_minutes * 60000 + 120_000 + HOUR);
        extend(project, LOCK, Date.now() + checkout + gate.timeout_minutes * 60000 + 120_000 + HOUR);
        const log = path.join(dir, `${gate.name}.log`);
        let result: GateResult;
        try {
          if (!created) {
            const candidate = path.join(parent, `worktree-${run.id}`);
            try { await addScratch(project, candidate, run.commit, checkout); }
            catch (error) { const problem = (error as { cleanup?: string }).cleanup; if (problem) noticeOnce(problem); throw error; }
            scratch = candidate; created = true;
          }
          ({ result, stuck } = await execute(project, gate, scratch!, run, log, options.commandOptions));
        } catch (error) {
          const at = new Date().toISOString();
          result = { gate: gate.name, commit: run.commit, started: at, ended: at, status: 'error', exit: null, timedOut: false, reason: (error as Error).message, log };
          try { appendFileSync(log, `ERROR: ${result.reason}\n`); } catch { /* the result still records the error */ }
        }
        run.results.push(result);
        if (result.status === 'failed') state.failures[gate.name] = { run: run.id, result, from: run.from, mergedOrders: run.mergedOrders };
        else if (result.status === 'passed') delete state.failures[gate.name];
        else notice(`Nightly gate ${gate.name} ${stuck ? 'could not be stopped' : 'setup error'}: ${result.reason}`);
        if (result.status !== 'error') updatedFailures.add(gate.name);
        if (stuck) { addedStuck = stuck; stuckRun = true; }
        persist();
        orders.store.appendEvent({ at: result.ended, tag: '_gates', type: 'nightly-gate', by: 'gates', data: { run: run.id, ...result } });
        syncNightlyCases(project, result.ended);
        if (stuck || (result.status === 'error' && !created)) break;
      } finally {
        // A tree that is not confirmed gone keeps the gate's resources reserved until a later pass confirms it.
        if (stuck) extend(project, tagFor(gate.name), Date.now() + HOUR); else release(project, tagFor(gate.name));
      }
    }
    if (run.status === 'running') {
      run.status = run.results.some(r => r.status === 'error') ? 'error' : run.results.some(r => r.status === 'failed') ? 'failed' : 'passed'; run.ended = new Date().toISOString();
    }
  } catch (error) {
    if (!run) { noticeOnce((error as Error).message); return { status: 'error', reason: (error as Error).message }; }
    run.status = 'error'; run.reason = (error as Error).message; run.ended = new Date().toISOString(); notice(run.reason);
  } finally {
    if (created && scratch && !stuckRun) { const problem = await removeScratch(project, scratch, checkout); if (problem) noticeOnce(problem); }
    try {
      if (run) {
        const expired = persist(true);
        mkdirSync(path.join(parent, `logs-${run.id}`), { recursive: true });
        writeFileSync(path.join(parent, `logs-${run.id}`, 'run.json'), JSON.stringify(run, null, 2));
        for (const old of expired) if (/^[a-f0-9-]{36}$/.test(old.id)) await rm(path.join(parent, `logs-${old.id}`), { recursive: true, force: true });
        if (run.ended) orders.store.appendEvent({ at: run.ended, tag: '_gates', type: 'nightly-run', by: 'gates', data: { ...run } });
      }
    } finally {
      // The batch lock stays held, and renewed, while any gate process tree is unconfirmed.
      clearInterval(renewal);
      if (stuckRun) extend(project, LOCK, Date.now() + HOUR); else release(project, LOCK);
    }
  }
  return { status: run!.status, reason: run!.reason, run };
}
