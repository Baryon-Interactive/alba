import { validateSubtasks } from './subtasks.ts';
import { phasesOverride } from './phase-config.ts';
import type { Action, ActionKind, Mandate, MonitorResult, OptionInput, Order, OrderDoc, QuoteHold, Report, ReportStatus, Run, RunEnd, RunOutcome, Stage, StoredQuestion, StoredQuote, WorkerReroute } from './model.ts';
import { ACTION_KINDS, RUN_OUTCOMES, nextSeq, normalizeSparseDirs } from './model.ts';
import { writeFileAtomic, StaleWrite, type OrderStore } from './store.ts';
import { actionProblem, inferStage, type StageResult } from './stage.ts';
import type { ReportInput } from './report.ts';
import { UserError, fail, t, withLang } from '../i18n.ts';
import { pendingNotes } from '../run/prompt.ts';
import { openQuestions, requeueUndeliveredInbox, type OutboxEntry } from '../run/messages.ts';
import { processStartedAt } from '../monitor/process.ts';
import { runProcessMatches, stopWarning, stopProcessTreeVerified } from '../run/kill-tree.ts';

/** The engine: every change to an order goes through here, so every change is validated and logged. */
/**
 * What starting a held order takes: a release, and a queue when the order under the hold is not queued but may be queued
 * (it ended idle, failed, blocked or dropped). An order under review or waiting for an answer is not started this way.
 */
export function heldStartPlan(orders: Orders, doc: OrderDoc): { actions: ('release' | 'queue')[]; problem?: string } {
  const probe: OrderDoc = { ...doc, actions: [...doc.actions, { seq: nextSeq(doc), at: '', kind: 'release' }] };
  const under = orders.stage(probe).stage;
  if (under === 'queued') return { actions: ['release'] };
  if (actionProblem(under, 'queue')) return { actions: [], problem: t('it is held over a {stage} order; release it and decide that first.', { stage: under }) };
  const queued: OrderDoc = { ...probe, actions: [...probe.actions, { seq: nextSeq(probe), at: '', kind: 'queue' }] };
  const then = orders.stage(queued).stage;
  if (then !== 'queued') return { actions: [], problem: t('it would be {stage} once released, not ready for a worker.', { stage: then }) };
  return { actions: ['release', 'queue'] };
}

export class Orders {
  readonly store: OrderStore;
  private readonly clock: () => string;
  readonly actor: string;
  private readonly processStart: typeof processStartedAt;
  private readonly processes: { alive(pid: number): boolean; stop: typeof stopProcessTreeVerified };
  constructor(store: OrderStore, clock: () => string = () => new Date().toISOString(), actor = 'cli', processStart = processStartedAt, processes = { alive: (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }, stop: stopProcessTreeVerified }) {
    this.store = store;
    this.clock = clock;
    this.actor = actor;
    this.processStart = processStart;
    this.processes = processes;
  }

  now(): string { return this.clock(); }

  /** Finds the stored tag ignoring case (file systems on Windows and macOS do). */
  resolveTag(tag: string): string | undefined {
    return this.store.tags().find(t => t.toLowerCase() === tag.toLowerCase());
  }

  get(tag: string): OrderDoc {
    const real = this.resolveTag(tag);
    const doc = real ? this.store.read(real) : undefined;
    if (!doc) fail('No order "{tag}". Known orders: {known}', { tag, known: this.store.tags().join(', ') || '(none)' });
    return doc;
  }

  all(): OrderDoc[] {
    if (this.store.all) return this.store.all();
    return this.store.tags().map(t => this.store.read(t)).filter((d): d is OrderDoc => d !== undefined);
  }

  /** Tags of orders whose stage is merged. Merged does not depend on `needs`, so no recursion is needed. */
  mergedSet(docs?: readonly OrderDoc[]): Set<string> {
    const none = new Set<string>();
    if (!docs) {
      // A stage without an explicit merged set used to read every order again, so a list of n orders read n x n files.
      // Keep the set for a moment: long enough for one request or one tick, short enough that another process's change shows.
      const at = Date.now();
      if (this.mergedMemo && at - this.mergedMemo.at < Orders.MERGED_MEMO_MS) return this.mergedMemo.set;
      const set = this.mergedSet(this.all());
      this.mergedMemo = { at, set };
      return set;
    }
    return new Set(docs.filter(d => inferStage(d.order, d.runs, d.reports, d.actions, none).stage === 'merged').map(d => d.order.tag));
  }

  children(doc: OrderDoc): OrderDoc[] {
    const decision = doc.actions.find(a => a.kind === 'accept-split');
    return (decision?.children ?? []).map(tag => this.get(tag));
  }

  stage(doc: OrderDoc, merged: ReadonlySet<string> = this.mergedSet()): StageResult {
    const pending = this.children(doc).filter(child => !['merged', 'cancelled'].includes(inferStage(child.order, child.runs, child.reports, child.actions, merged).stage));
    const stage = inferStage(doc.order, doc.runs, doc.reports, doc.actions, merged, pending.length);
    // Only a question waits on a person; a blocker or a note while the run goes on is shown, not a stage.
    const waiting = openQuestions(doc)[0];
    return waiting && stage.stage === 'running' ? { stage: 'awaiting-user', why: waiting.text, waitingFor: 'answer' } : stage;
  }

  receiveOutbox(tag: string, entry: OutboxEntry): void {
    this.retry(() => {
      const doc = this.get(tag);
      if (doc.outbox?.some(e => e.id === entry.id)) return;
      (doc.outbox ??= []).push({ ...entry, received: entry.received ?? this.now() });
      this.save(doc, 'outbox', { ...entry });
    });
  }

  answerOutbox(tag: string, reply: string, answer: { id: string; at: string; text: string }): void {
    this.retry(() => {
      const doc = this.get(tag), entry = doc.outbox?.find(e => e.id === reply);
      if (!entry) fail('No worker message "{id}".', { id: reply });
      entry.answered = answer;
      this.save(doc, 'outbox-answered', { reply, ...answer });
    });
  }

  private static readonly MERGED_MEMO_MS = 2000;
  private mergedMemo?: { at: number; set: Set<string> };

  /** Records something that happened to an order without changing the order (a check, a reference update). */
  record(tag: string, type: string, data: Record<string, unknown> = {}): void {
    this.store.appendEvent({ at: this.now(), tag, type, by: this.actor, data });
  }

  private save(doc: OrderDoc, type: string, data: Record<string, unknown> = {}): void {
    this.mergedMemo = undefined;
    const at = this.now();
    doc.order.updated = at;
    this.store.transaction(() => {
      this.store.write(doc);
      this.store.appendEvent({ at, tag: doc.order.tag, type, by: this.actor, data });
    });
  }

  private retry<T>(change: () => T): T {
    for (let attempt = 0; ; attempt++) {
      try { return change(); }
      catch (error) {
        if (!(error instanceof StaleWrite) || attempt >= 3) throw error;
        this.mergedMemo = undefined;
      }
    }
  }

  add(input: { parent?: string; phases?: 'none'; check?: Order['check']; review?: 'manual' | 'auto'; planned?: boolean; intent?: string; role?: string; priority?: number; tag: string; title: string; kind: string; needs?: string[]; worker?: string; model?: string; heavy?: string; mandate?: Mandate; tags?: string[]; skills?: string[]; routing?: Order['routing']; uses?: string[]; tools?: string[]; branch?: string; base_ref?: string; worktree?: string; sparse?: string[]; condition?: string; source?: Order['source']; scheduled?: Order['scheduled'] }): OrderDoc {
    return this.retry(() => {
      const taken = this.resolveTag(input.tag);
      if (taken) {
        const stage = this.stage(this.get(taken)).stage;
        fail('Order "{tag}" already exists ({stage}; a merged or cancelled order keeps its tag). The next free tag like it is {next}.', { tag: taken, stage, next: nextFreeTag(input.tag, this.store.tags()) });
      }
      if (!input.title.trim()) fail('An order needs a title.');
      if (input.priority !== undefined && (!Number.isInteger(input.priority) || Math.abs(input.priority) > 1000000)) fail('Priority must be a bounded integer.');
      const needs = [...new Set((input.needs ?? []).map(n => n.trim()).filter(Boolean))];
      if (needs.some(n => n.toLowerCase() === input.tag.toLowerCase())) fail('An order cannot need itself.');
      const at = this.now();
      const order: Order = { tag: input.tag, title: input.title.trim(), kind: input.kind, needs, created: at, updated: at };
      if (input.parent) order.parent = input.parent;
      if (input.tag.includes('.') && (!input.parent || input.tag.slice(0, -2) !== input.parent)) fail('Numbered child tags are reserved for splits.');
      if (input.phases !== undefined) order.phases = phasesOverride(input.phases);
      if (input.check !== undefined) {
        if (!['independent', 'none'].includes(input.check)) fail('Check must be independent or none.');
        order.check = input.check;
      }
      if (input.review !== undefined) {
        if (!['manual', 'auto'].includes(input.review)) fail('Review must be manual or auto.');
        order.review = input.review;
      }
      if (input.planned) order.planned = true;
      if (input.intent) order.intent = input.intent;
      if (input.role) { if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.role)) fail('Invalid role identifier.'); order.role = input.role; }
      if (input.priority !== undefined) order.priority = input.priority;
      if (input.worker) order.worker = input.worker;
      if (input.model?.trim()) order.model = input.model.trim();
      if (input.heavy) order.heavy = input.heavy;
      if (input.mandate && Object.keys(input.mandate).length) order.mandate = input.mandate;
      if (input.tags?.length) order.tags = [...new Set(input.tags.map(x => x.trim().toLowerCase()).filter(Boolean))];
      if (input.skills?.length) order.skills = [...new Set(input.skills.map(x => x.trim()).filter(Boolean))];
      if (input.routing) order.routing = input.routing;
      if (input.uses?.length) order.uses = [...new Set(input.uses.map(x => x.trim()).filter(Boolean))];
      if (input.tools?.length) order.tools = [...new Set(input.tools.map(x => x.trim()).filter(Boolean))];
      if (input.branch) order.branch = input.branch;
      if (input.base_ref) order.base_ref = input.base_ref;
      if (input.worktree) order.worktree = input.worktree;
      if (input.sparse !== undefined) {
        const checked = normalizeSparseDirs(input.sparse);
        if (!checked.ok) fail('sparse {error}.', { error: checked.error });
        order.sparse = checked.dirs;
      }
      if (input.condition) order.condition = input.condition;
      if (input.source) order.source = input.source;
      if (input.scheduled) order.scheduled = input.scheduled;
      const doc: OrderDoc = { version: 1, order, runs: [], reports: [], actions: [] };
      this.save(doc, 'order-added', { title: order.title, kind: order.kind, needs, ...(order.scheduled ? { source: order.scheduled.source, planned_at: order.scheduled.planned_at } : {}) });
      return doc;
    });
  }

  /** Changes definition fields (not facts). Used when a table is imported again. */
  update(tag: string, patch: Partial<Pick<Order, 'phases' | 'check' | 'review' | 'planned' | 'intent' | 'role' | 'priority' | 'title' | 'worker' | 'model' | 'needs' | 'condition' | 'source' | 'kind' | 'heavy' | 'branch' | 'base_ref' | 'worktree' | 'sparse' | 'tags' | 'skills' | 'routing' | 'uses' | 'tools'>>): OrderDoc {
    return this.retry(() => {
      const doc = this.get(tag);
      phasesOverride(patch.phases);
      if (patch.check !== undefined && !['independent', 'none'].includes(patch.check)) fail('Check must be independent or none.');
      if (patch.review !== undefined && !['manual', 'auto'].includes(patch.review)) fail('Review must be manual or auto.');
      if (patch.role !== undefined && patch.role !== '' && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(patch.role)) fail('Invalid role identifier.');
      if (patch.priority !== undefined && (!Number.isInteger(patch.priority) || Math.abs(patch.priority) > 1000000)) fail('Priority must be a bounded integer.');
      if (patch.needs?.some(need => need.toLowerCase() === tag.toLowerCase())) fail('An order cannot need itself.');
      const normalizedPatch = { ...patch };
      if (patch.sparse !== undefined) {
        const checked = normalizeSparseDirs(patch.sparse);
        if (!checked.ok) fail('sparse {error}.', { error: checked.error });
        normalizedPatch.sparse = checked.dirs;
      }
      const changed = Object.entries(normalizedPatch).filter(([k, v]) => JSON.stringify(doc.order[k as keyof Order]) !== JSON.stringify(v));
      const clearPin = Object.hasOwn(normalizedPatch, 'worker') && !!doc.order.next_worker;
      if (!changed.length && !clearPin) return doc;
      if (clearPin) delete doc.order.next_worker;
      Object.assign(doc.order, normalizedPatch);
      this.save(doc, 'order-updated', { fields: [...changed.map(([k]) => k), ...(clearPin ? ['next_worker'] : [])] });
      return doc;
    });
  }

  /** Clear a producer pin, recording the person's override or the invalid configuration. */
  clearWorkerPin(tag: string, reason: string, worker?: string): void {
    this.retry(() => {
      const doc = this.get(tag);
      if (!doc.order.next_worker) return;
      const from = doc.order.next_worker;
      delete doc.order.next_worker;
      if (worker !== undefined) doc.order.worker = worker;
      this.save(doc, 'worker-pin-cleared', { from, ...(worker !== undefined ? { to: worker, person: true } : {}), reason });
    });
  }

  /** Pin supply and enqueue its brief atomically, without touching an active run. */
  reroute(tag: string, input: Omit<WorkerReroute, 'seq' | 'by'>, validate: (doc: OrderDoc) => void): OrderDoc {
    return this.retry(() => this.store.transaction(() => {
      const doc = this.get(tag);
      if (doc.reroutes?.some(r => r.id === input.id)) return doc;
      validate(doc);
      const stage = this.stage(doc).stage;
      if (['held', 'merged', 'cancelled'].includes(stage)) fail('Reroute refused: order is {stage}.', { stage });
      const seq = nextSeq(doc);
      doc.order.next_worker = input.to;
      (doc.reroutes ??= []).push({ ...input, by: this.actor, seq });
      const queue = !doc.runs.some(r => !r.ended) && (['failed', 'blocked'].includes(stage) || stage === 'awaiting-review' && ['failed', 'blocked'].includes(doc.reports.at(-1)?.status ?? ''));
      doc.actions.push({ seq, at: input.at, kind: queue ? 'queue' : 'message', note: input.note, ...(queue ? {} : { queued: true }) });
      this.save(doc, 'worker-rerouted', { id: input.id, from: input.from, to: input.to, note: input.note });
      return doc;
    }));
  }

  /**
   * Records where an order's work is: the branch, the worktree and the branch it starts from. For orders that never got
   * them (imported from a table, or done in a session of a person's own). Each value is checked for shape only; a branch
   * that does not exist is found out by the merge check. Logged as `order-git-set` with the old and new values.
   */
  setGit(tag: string, patch: { branch?: string; worktree?: string; base_ref?: string }): OrderDoc {
    return this.retry(() => {
      const doc = this.get(tag);
      const clean = (name: string, value: string | undefined, branchName: boolean): string | undefined => {
        if (value === undefined) return undefined;
        const v = (branchName ? value.trim().replace(/^refs\/heads\//, '') : value.trim());
        if (!v) fail('{name} cannot be empty.', { name });
        if (branchName && (/\s/.test(v) || v.startsWith('-') || v.includes('..'))) fail('"{value}" is not a branch name.', { value: v });
        return v;
      };
      const next = { branch: clean('branch', patch.branch, true), worktree: clean('worktree', patch.worktree, false), base_ref: clean('base_ref', patch.base_ref, true) };
      const changes = (Object.keys(next) as (keyof typeof next)[]).filter(k => next[k] !== undefined && doc.order[k] !== next[k]);
      if (!changes.length) return doc;
      const from: Record<string, string | undefined> = {};
      const to: Record<string, string> = {};
      for (const k of changes) { from[k] = doc.order[k]; to[k] = next[k]!; doc.order[k] = next[k]; }
      this.save(doc, 'order-git-set', { fields: changes, to, from });
      return doc;
    });
  }

  recordSplit(tag: string, report: number, children: string[], branch: string): void {
    const doc = this.get(tag);
    doc.actions.push({ seq: nextSeq(doc), kind: 'accept-split', at: this.now(), author: this.actor, report, children, branch });
    this.save(doc, 'action-accept-split', { report, children, branch });
  }

  /** A person's action. `force` skips the legality check (used by the table importer, which records what the table says). */
  act(tag: string, kind: ActionKind, options: { confirm?: boolean; phase?: string; note?: string; commit?: string; force?: boolean; imported?: boolean; choice?: number; override?: boolean; bounce?: boolean; lint?: boolean; queued?: boolean; author?: string; requeuedFrom?: string; onStopWarning?: (warning: string) => void } = {}): OrderDoc {
    if (kind === 'accept-split') fail('Accept the split proposal through the split decision.');
    if (kind === 'cancel') {
      const doc = this.get(tag);
      if (doc.actions.some(a => a.kind === 'accept-split')) {
        if (!options.confirm) fail('Confirm cancellation of the parent and its open children with --confirm.');
        return this.store.transaction(() => {
          for (const child of this.children(this.get(tag))) {
            if (!['merged', 'cancelled'].includes(this.stage(child).stage)) this.act(child.order.tag, 'cancel', options);
          }
          return this.applyAction(tag, kind, options);
        });
      }
    }
    return this.applyAction(tag, kind, options);
  }

  private applyAction(tag: string, kind: ActionKind, options: NonNullable<Parameters<Orders['act']>[2]>): OrderDoc {
    // Queueing a held order (stopped with "alba stop") releases it, and queues it too when it had ended: what a person means by it.
    if (kind === 'queue' && !options.force && this.stage(this.get(tag)).stage === 'held') {
      const plan = heldStartPlan(this, this.get(tag));
      if (plan.problem) fail('{tag}: {problem}', { tag: this.get(tag).order.tag, problem: plan.problem });
      this.act(tag, 'release', { note: options.note });
      return plan.actions.includes('queue') ? this.act(tag, 'queue', options) : this.get(tag);
    }
    return this.retry(() => {
      if (!ACTION_KINDS.includes(kind)) fail('Unknown action "{kind}". Allowed: {allowed}.', { kind, allowed: ACTION_KINDS.join(', ') });
      if (kind === 'rework' && !options.note?.trim() && !options.force) fail('Rework needs a note (--note): it becomes the instruction for the next run.');
      if (kind === 'answer' && !options.note?.trim()) fail('An answer needs its text (--text).');
      if (kind === 'message' && !options.note?.trim()) fail('A message needs its text (--text).');
      if (kind === 'done-by-lead' && (options.note?.trim().length ?? 0) < 10 && !options.force) fail('Closing with done-by-lead needs a note of at least 10 characters.');
      if (kind === 'merged-elsewhere' && !options.commit?.trim() && !options.force) fail('Closing with merged-elsewhere needs a commit on the base branch.');
      const doc = this.get(tag);
      const now = this.stage(doc);
      const stage = now.stage;
      const overrideStage = ['failed', 'blocked', 'idle'].includes(stage) || (stage === 'awaiting-user' && doc.reports.length > 0);
      if (kind === 'approve' && doc.reports.at(-1)?.subtasks && now.waitingFor === 'card') fail('Decide the split before approving the parent.');
      if (kind === 'approve' && overrideStage && !options.override && !options.force) {
        fail('{tag} is {stage}; approving it needs --override and a note of at least 10 characters.', { tag: doc.order.tag, stage });
      }
      if (kind === 'approve' && overrideStage && options.override && (options.note?.trim().length ?? 0) < 10 && !options.force) {
        fail('An override approval needs a note of at least 10 characters.');
      }
      // Approval never runs beside a worker: its run could still change what is being approved.
      const openRun = doc.runs.find(r => r.ended === undefined);
      if (kind === 'approve' && openRun && !options.force) fail('Run {run} of {tag} is still open; wait for it to end (or stop it) before approving.', { run: openRun.id, tag: doc.order.tag });
      if ((kind === 'merged-elsewhere' || kind === 'done-by-lead') && openRun && !options.force) fail('Run {run} of {tag} is still open; stop the run first before closing.', { run: openRun.id, tag: doc.order.tag });
      const problem = kind === 'approve' && options.override && overrideStage ? undefined : actionProblem(stage, kind);
      // The English text travels with the message: a code that tells the kinds of error apart reads it, not the translation.
      if (problem && !options.force) throw new UserError(t('{tag}: {problem}', { tag: doc.order.tag, problem }), `${doc.order.tag}: ${withLang('en', () => actionProblem(stage, kind))}`);
      if (kind === 'answer' && now.waitingFor === 'card' && !options.force) fail('{tag}: the order waits for a card to be clicked, not for an answer. Click the card in a session of your own, or send it back with a rework note.', { tag: doc.order.tag });
      // Holding (and stopping) ends the open run: its process and every process under it, after their identity is checked.
      // Cancelling does the same when the process can be verified; one that cannot is left alone, as before, and its end is recorded later.
      const closedRuns: Run[] = [];
      if (kind === 'hold' || kind === 'cancel') {
        for (const run of doc.runs.filter(r => !r.ended)) {
          if (run.pid && this.processes.alive(run.pid)) {
            // A run whose process creation time was never recorded is identified by its launch window instead.
            const verified = !run.imported && runProcessMatches(this.processStart(run.pid), run.process_started_at, run.started);
            const result = verified ? this.processes.stop(run.pid, run.process_started_at, { launchedAt: run.started }) : undefined;
            const warning = result && stopWarning(result);
            if (warning) options.onStopWarning?.(warning);
            if (!result?.stopped.includes(run.pid)) {
              if (kind === 'cancel') continue;
              if (warning) fail('Cannot hold {tag}. {warning}', { tag: doc.order.tag, warning });
              fail('Cannot hold {tag}: process {pid} cannot be verified as this run; no hold was recorded.', { tag: doc.order.tag, pid: run.pid });
            }
          }
          run.ended = this.now(); run.outcome = 'cancelled';
          closedRuns.push(run);
        }
      }
      const action: Action = { seq: nextSeq(doc), at: this.now(), kind };
      if (kind === 'message' && options.queued) action.queued = true;
      if (options.note?.trim()) action.note = options.note.trim();
      if (options.author?.trim()) action.author = options.author.trim();
      if (options.requeuedFrom) action.requeued_from = options.requeuedFrom;
      if (options.commit?.trim()) action.commit = options.commit.trim();
      if (kind === 'rework') {
        const proposal = doc.reports.at(-1);
        const splitPhase = proposal?.subtasks && doc.runs.find(r => r.id === proposal.run)?.phase;
        if (splitPhase && now.waitingFor === 'card') action.phase = splitPhase;
        else if (options.phase) action.phase = options.phase;
        if (doc.actions.some(a => a.kind === 'accept-split') && action.phase && doc.runs.some(r => r.split_kinds && r.phase === action.phase)) fail('An accepted split cannot be repeated.');
      }
      if (options.choice !== undefined) action.choice = options.choice;
      if (options.imported) action.imported = true;
      if (options.override) action.override = true;
      if (options.bounce) action.bounce = true;
      if (options.lint) action.lint = true;
      doc.actions.push(action);
      this.save(doc, `action-${kind}`, { note: action.note, from: stage, ...(action.author ? { author: action.author } : {}), ...(action.requeued_from ? { requeued_from: action.requeued_from } : {}), ...(kind === 'merged-elsewhere' || kind === 'done-by-lead' || action.commit ? { commit: action.commit } : {}), ...(action.choice !== undefined ? { choice: action.choice } : {}), ...(action.override ? { override: true } : {}), ...(action.bounce ? { bounce: true } : {}) });
      for (const run of closedRuns) requeueUndeliveredInbox(this, doc.order.tag, run);
      return closedRuns.length ? this.get(doc.order.tag) : doc;
    });
  }

  /**
   * Opens a run. `fromHeld` (a person started a held order on a worker they named): the release, and the queue when the order
   * was not queued under the hold, are written in the same save as the run, so no tick can take the order in between.
   */
  runStart(tag: string, input: { worker: string; session?: string; extra?: Partial<Run> }, imported = false, options: { fromHeld?: { note?: string } } = {}): { doc: OrderDoc; run: Run } {
    return this.retry(() => {
      const doc = this.get(tag);
      let stage = this.stage(doc).stage;
      let released = false;
      if (stage === 'held' && options.fromHeld && !imported) {
        const plan = heldStartPlan(this, doc);
        if (plan.problem) fail('{tag}: {problem}', { tag: doc.order.tag, problem: plan.problem });
        for (const kind of plan.actions) doc.actions.push({ seq: nextSeq(doc), at: this.now(), kind, ...(options.fromHeld.note ? { note: options.fromHeld.note } : {}) });
        stage = this.stage(doc).stage;
        released = true;
      }
      if (doc.order.planned || (['merged', 'cancelled', 'held', 'waiting-children'].includes(stage) && !imported)) fail('{tag} is {stage}; a run cannot start.', { tag: doc.order.tag, stage });
      if (stage === 'awaiting-user' && doc.reports.at(-1)?.subtasks) fail('Decide the split before starting a run.');
      const open = doc.runs.find(r => r.ended === undefined);
      if (open) fail('{tag} already has an open run ({id}). End it first with run-end.', { tag: doc.order.tag, id: open.id });
      if (!input.worker.trim()) fail('A run needs a worker (--worker).');
      const seq = nextSeq(doc);
      const run: Run = { id: `r${doc.runs.length + 1}`, seq, worker: input.worker.trim(), started: this.now() };
      if (input.session) run.session = input.session;
      if (imported) run.imported = true;
      if (input.extra) Object.assign(run, input.extra, { id: run.id, seq: run.seq, worker: run.worker, started: run.started });
      // Every note that no run has really followed travels with this run (a transient ending does not drop them).
      const waiting = pendingNotes(doc);
      if (waiting.length === 1) run.note = waiting[0].text;
      else if (waiting.length) run.note = waiting.map(n => n.text).join('\n\n');
      doc.runs.push(run);
      this.save(doc, 'run-start', { run: run.id, worker: run.worker, session: run.session, ...(released ? { released: true } : {}), ...(run.role ? { role: run.role, role_source: run.role_source, mcp_servers: run.mcp_servers, role_warnings: run.role_warnings } : {}), ...(run.routing ? { routing: run.routing } : {}), ...(run.skills ? { skills: run.skills } : {}) });
      return { doc, run };
    });
  }

  /** Adds facts to a run after the fact (for example the pid once the process exists). */
  patchRun(tag: string, runId: string, patch: Partial<Run>): OrderDoc {
    return this.retry(() => {
      const doc = this.get(tag);
      const run = doc.runs.find(r => r.id === runId);
      if (!run) fail('{tag} has no run {id}.', { tag: doc.order.tag, id: runId });
      Object.assign(run, patch, { id: run.id, seq: run.seq });
      this.save(doc, 'run-updated', { run: runId, fields: Object.keys(patch) });
      return doc;
    });
  }

  runEnd(tag: string, outcome: RunOutcome = 'completed', end?: RunEnd): { doc: OrderDoc; run: Run } {
    return this.retry(() => {
      if (!RUN_OUTCOMES.includes(outcome)) fail('Unknown outcome "{outcome}". Allowed: {allowed}.', { outcome, allowed: RUN_OUTCOMES.join(', ') });
      const doc = this.get(tag);
      const run = [...doc.runs].reverse().find(r => r.ended === undefined);
      if (!run) fail('{tag} has no open run.', { tag: doc.order.tag });
      run.ended = this.now();
      run.outcome = outcome;
      if (end) run.end = end;
      this.save(doc, 'run-end', { run: run.id, outcome, ...(end ?? {}) });
      return { doc, run };
    });
  }

  report(tag: string, input: ReportInput, from?: string, imported = false): { doc: OrderDoc; report: Report } {
    return this.retry(() => {
      const doc = this.get(tag);
      const run = doc.runs.find(r => r.ended === undefined) ?? doc.runs[doc.runs.length - 1];
      if (run?.split_kinds && input.status === 'ready') validateSubtasks(input.subtasks, run.split_kinds);
      else if (input.subtasks) fail('Only a ready split phase may propose subtasks.');
      if (!run?.split_kinds && run?.next_phase && input.status === 'ready' && !input.plan?.trim()) fail('A ready planning report needs a nonempty plan.');
      const report: Report = { seq: nextSeq(doc), at: this.now(), status: input.status as ReportStatus, summary: input.summary, evidence: input.evidence, commits: input.commits };
      if (input.subtasks) report.subtasks = input.subtasks;
      if (input.plan !== undefined) {
        if (Buffer.byteLength(input.plan) > 24 * 1024) fail('Report plan must be Markdown text of at most 24 KiB.');
        report.plan = input.plan;
        if (run?.plan_file) writeFileAtomic(run.plan_file, input.plan);
      }
      if (input.revision) report.revision = input.revision;
      if (input.delivery_text !== undefined) report.delivery_text = input.delivery_text;
      if (run) report.run = run.id;
      if (input.question) report.question = input.question;
      if (input.options?.length) report.options = input.options;
      if (input.waiting_for) report.waiting_for = input.waiting_for;
      if (input.scope === 'project') report.scope = 'project';
      if (input.skill_suggestions?.length) report.skill_suggestions = input.skill_suggestions;
      if (input.design_changes?.length) report.design_changes = input.design_changes;
      if (input.monitor) report.monitor = input.monitor;
      if (from) report.from = from;
      if (input.source) report.source = input.source;
      if (imported) report.imported = true;
      doc.reports.push(report);
      if (report.monitor) {
        const started = this.now();
        doc.monitor = { report_seq: report.seq, started, deadline: new Date(Date.parse(started) + report.monitor.deadline_minutes * 60000).toISOString(), checks: 0 };
        if (report.monitor.pid) {
          doc.monitor.pid = report.monitor.pid;
          doc.monitor.process_started_at = this.processStart(report.monitor.pid);
        }
      }
      this.save(doc, 'report', { status: report.status, summary: report.summary, question: report.question, ...(report.options ? { options: report.options.length } : {}), ...(report.monitor ? { monitor: report.monitor.check?.length ? report.monitor.check.join(' ') : 'condition' } : {}) });
      return { doc, report };
    });
  }

  /**
   * Notes one run of a monitor's check command. The state keeps the number of checks and what the last said; an event is written only
   * when what it said differs from the one before (the same result and the same end of output, again, is not logged again; numbers
   * such as percentages and timestamps do not count as a difference).
   */
  monitorChecked(tag: string, check: { result: MonitorResult; tail: string; observation?: string }): OrderDoc {
    return this.retry(() => {
      const doc = this.get(tag);
      const m = doc.monitor;
      if (!m) fail('{tag} has no monitor.', { tag: doc.order.tag });
      // Numbers are left out of the comparison: a progress counter or a clock in the output is not a new state worth an event.
      const signature = `${check.result}|${check.tail.trim().slice(-300).replace(/\d+/g, '#')}`;
      const changed = signature !== m.last_signature;
      if (check.observation !== undefined && check.observation !== m.observation) {
        m.observation = check.observation; m.changed_at = this.now();
      }
      m.checks += 1; m.last_at = this.now(); m.last_result = check.result; m.last_signature = signature; m.tail = check.tail;
      if (changed) this.save(doc, 'monitor-check', { result: check.result, checks: m.checks, tail: check.tail.trim().slice(-400) });
      else this.store.write(doc);
      return doc;
    });
  }

  /** The monitor ended (`done`, `failed`, past its `deadline`, or its check was `refused`): the order is queued to be continued; `note` is what the worker is told. */
  monitorResolved(tag: string, result: Exclude<MonitorResult, 'waiting'>, tail: string, note: string): OrderDoc {
    return this.retry(() => this.store.transaction(() => {
      const doc = this.get(tag);
      const m = doc.monitor;
      if (!m) fail('{tag} has no monitor.', { tag: doc.order.tag });
      m.resolved = { at: this.now(), result, tail };
      this.save(doc, 'monitor-end', { result, checks: m.checks });
      return this.act(tag, 'monitor', { note });
    }));
  }

  /**
   * Asks a question with 2 to 4 options (the recommended one first) on an order. The question is stored, and a waiting report carries it
   * so that the order shows up as waiting for an answer. Picking an option (`pick`) answers it.
   */
  ask(tag: string, input: { text: string; options: OptionInput[] }, by = this.actor): { doc: OrderDoc; question: StoredQuestion } {
    return this.retry(() => {
      if (!input.text.trim()) fail('A question needs its text.');
      if (input.options.length < 2 || input.options.length > 4) fail('A question with options needs 2 to 4 options, the recommended one first.');
      const doc = this.get(tag);
      const stage = this.stage(doc).stage;
      if (['merged', 'cancelled'].includes(stage)) fail('{tag} is {stage}; a question cannot be asked.', { tag: doc.order.tag, stage });
      const questions = doc.questions ??= [];
      const question: StoredQuestion = { id: `Q${questions.length + 1}`, text: input.text.trim(), options: input.options, by, at: this.now() };
      questions.push(question);
      const report: Report = { seq: nextSeq(doc), at: this.now(), status: 'waiting', summary: question.text, question: question.text, options: input.options, waiting_for: 'answer', question_id: question.id, from: 'ask', evidence: [], commits: [] };
      const run = doc.runs.find(r => r.ended === undefined) ?? doc.runs[doc.runs.length - 1];
      if (run) report.run = run.id;
      doc.reports.push(report);
      this.save(doc, 'question-asked', { id: question.id, text: question.text, options: question.options.map(o => o.label), by });
      return { doc, question };
    });
  }

  /** Makes a quote for a paid resource on an order: what is wanted to be spent, waiting for a person to approve it with a cap of their own. */
  /** `unpriced`: the service could not price it; the quote may then ask for 0 and a person sets the cap. */
  quote(tag: string, input: { id?: string; service: string; unit?: string; unit_price?: number; quantity?: number; cap_requested: number; note?: string; unpriced?: boolean }, by = this.actor): { doc: OrderDoc; quote: StoredQuote } {
    return this.retry(() => {
      if (!input.service?.trim()) fail('A quote needs the service it is for.');
      if (!(input.cap_requested > 0) && !(input.unpriced && input.cap_requested === 0)) fail('A quote needs a requested cap above 0.');
      for (const key of ['unit_price', 'quantity'] as const) if (input[key] !== undefined && !(input[key]! >= 0)) fail('"{key}" must be a number >= 0.', { key });
      const doc = this.get(tag);
      const stage = this.stage(doc).stage;
      if (['merged', 'cancelled'].includes(stage)) fail('{tag} is {stage}; a quote cannot be made.', { tag: doc.order.tag, stage });
      const quotes = doc.quotes ??= [];
      const id = input.id?.trim() || `C${quotes.length + 1}`;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id)) fail('A quote id is letters, digits, "-" and "_", starting with a letter.');
      if (quotes.some(q => q.id.toLowerCase() === id.toLowerCase())) fail('{tag} has a quote {id} already.', { tag: doc.order.tag, id });
      const quote: StoredQuote = {
        id, service: input.service.trim(), unit: input.unit?.trim() || 'credits',
        ...(input.unit_price !== undefined ? { unit_price: input.unit_price } : {}), ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.unit_price !== undefined && input.quantity !== undefined ? { total: Math.round(input.unit_price * input.quantity * 1e6) / 1e6 } : {}),
        cap_requested: input.cap_requested, ...(input.note?.trim() ? { note: input.note.trim() } : {}), created: this.now(), by, status: 'pending', ledger: [],
      };
      quotes.push(quote);
      this.save(doc, 'quote-made', { id, service: quote.service, unit: quote.unit, cap_requested: quote.cap_requested, by });
      return { doc, quote };
    });
  }

  private quoteOf(doc: OrderDoc, id: string): StoredQuote {
    return doc.quotes?.find(q => q.id.toLowerCase() === id.toLowerCase()) ?? fail('{tag} has no quote {id}.', { tag: doc.order.tag, id });
  }

  /** A person approves a pending quote with a cap of their own (whatever was asked), or rejects it. */
  decideQuote(tag: string, id: string, decision: { approve: true; cap: number; note?: string } | { approve: false; note?: string }): { doc: OrderDoc; quote: StoredQuote } {
    return this.retry(() => {
      const doc = this.get(tag);
      const quote = this.quoteOf(doc, id);
      if (quote.status !== 'pending') fail('Quote {id} of {tag} was decided already ({status}).', { id: quote.id, tag: doc.order.tag, status: quote.status });
      if (decision.approve) {
        if (!(decision.cap > 0)) fail('An approval needs a cap above 0.');
        quote.status = 'approved';
        quote.approval = { cap: decision.cap, ...(decision.note?.trim() ? { note: decision.note.trim() } : {}), by: this.actor, at: this.now() };
      } else {
        quote.status = 'rejected';
        if (decision.note?.trim()) quote.approval = { cap: 0, note: decision.note.trim(), by: this.actor, at: this.now() };
      }
      this.save(doc, decision.approve ? 'quote-approved' : 'quote-rejected', { id: quote.id, ...(decision.approve ? { cap: decision.cap } : {}), ...(decision.note?.trim() ? { note: decision.note.trim() } : {}), by: this.actor });
      return { doc, quote };
    });
  }

  /** Holds that have not lapsed, without the one under `except` (a caller's own). */
  activeHolds(quote: StoredQuote, except?: string): QuoteHold[] {
    const now = Date.parse(this.now());
    return (quote.holds ?? []).filter(h => Date.parse(h.until) > now && h.key !== except);
  }

  /**
   * Sets money aside on an approved quote for a call about to be made (what `credits gate` does): refused when the cap, less what
   * was spent and what other holds keep, does not cover it. The same key again renews its hold. Lapsed holds are dropped here.
   */
  hold(tag: string, id: string, input: { amount: number; key: string; minutes?: number }): { doc: OrderDoc; quote: StoredQuote; hold: QuoteHold; remaining: number } {
    return this.retry(() => {
      const doc = this.get(tag);
      const quote = this.quoteOf(doc, id);
      if (quote.status !== 'approved' || !quote.approval) fail('Quote {id} of {tag} is {status}: nothing can be spent on it.', { id: quote.id, tag: doc.order.tag, status: quote.status });
      if (!(input.amount > 0)) fail('An amount above 0 is needed.');
      if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(input.key)) fail('A key is letters, digits, ":", ".", "_" and "-", up to 80 characters.');
      if (quote.ledger.some(e => e.key === input.key)) fail('Quote {id} of {tag} already has a booking with key {key}.', { id: quote.id, tag: doc.order.tag, key: input.key });
      const others = this.activeHolds(quote, input.key);
      const spent = quote.ledger.reduce((n, e) => n + e.amount, 0), held = others.reduce((n, h) => n + h.amount, 0);
      const remaining = Math.round((quote.approval.cap - spent - held) * 1e6) / 1e6;
      if (input.amount > remaining + 1e-9) fail('Quote {id} of {tag} has {remaining} {unit} left, {need} are needed; do not spend.', { id: quote.id, tag: doc.order.tag, remaining, unit: quote.unit, need: input.amount });
      const at = this.now();
      const hold: QuoteHold = { key: input.key, amount: input.amount, at, until: new Date(Date.parse(at) + (input.minutes ?? 60) * 60000).toISOString(), by: this.actor };
      quote.holds = [...others, hold];
      this.save(doc, 'quote-held', { id: quote.id, key: hold.key, amount: hold.amount, unit: quote.unit, until: hold.until, by: this.actor });
      return { doc, quote, hold, remaining: Math.round((remaining - input.amount) * 1e6) / 1e6 };
    });
  }

  /** Lets a hold go without booking it (the call it was for spent nothing). Nothing happens when there is no such hold. */
  releaseHold(tag: string, id: string, key: string): void {
    this.retry(() => {
      const doc = this.get(tag);
      const quote = this.quoteOf(doc, id);
      if (!quote.holds?.some(h => h.key === key)) return;
      quote.holds = quote.holds.filter(h => h.key !== key);
      if (!quote.holds.length) delete quote.holds;
      this.save(doc, 'quote-hold-released', { id: quote.id, key, by: this.actor });
    });
  }

  /**
   * Books money spent against an approved quote. Refused above the approved cap (less what other holds keep): the cap is a hard
   * ceiling. With a key the booking happens once: the same key again returns the first booking. The hold under that key is
   * booked; a booking without a key takes the place of the oldest holds up to its amount.
   */
  spend(tag: string, id: string, input: { amount: number; what: string; unknown?: boolean; key?: string }): { doc: OrderDoc; quote: StoredQuote; repeated?: boolean } {
    return this.retry(() => {
      const doc = this.get(tag);
      const quote = this.quoteOf(doc, id);
      const key = input.key?.trim() || undefined;
      const booked = key ? quote.ledger.find(e => e.key === key) : undefined;
      if (booked) {
        if (Math.abs(booked.amount - input.amount) > 1e-9) fail('Quote {id} of {tag} already booked {amount} {unit} with key {key}.', { id: quote.id, tag: doc.order.tag, amount: booked.amount, unit: quote.unit, key: key! });
        return { doc, quote, repeated: true };
      }
      if (quote.status !== 'approved' || !quote.approval) fail('Quote {id} of {tag} is {status}: nothing can be spent on it.', { id: quote.id, tag: doc.order.tag, status: quote.status });
      if (!(input.amount > 0)) fail('An amount above 0 is needed.');
      if (!input.what?.trim()) fail('Say what the money was spent on.');
      if (key && !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(key)) fail('A key is letters, digits, ":", ".", "_" and "-", up to 80 characters.');
      let holds = this.activeHolds(quote, key);
      if (!key) {
        // Without a key the booking stands for the call the oldest holds were made for.
        let left = input.amount;
        holds = [...holds].sort((a, b) => a.at.localeCompare(b.at)).flatMap(h => {
          const used = Math.min(left, h.amount); left -= used;
          return h.amount - used > 1e-9 ? [{ ...h, amount: Math.round((h.amount - used) * 1e6) / 1e6 }] : [];
        });
      }
      const spent = quote.ledger.reduce((n, e) => n + e.amount, 0), held = holds.reduce((n, h) => n + h.amount, 0);
      if (spent + held + input.amount > quote.approval.cap + 1e-9) fail('{amount} {unit} would go above the approved cap of {cap} {unit} ({spent} spent already).', { amount: input.amount, unit: quote.unit, cap: quote.approval.cap, spent: Math.round((spent + held) * 1e6) / 1e6 });
      quote.ledger.push({ at: this.now(), amount: input.amount, what: input.what.trim(), by: this.actor, ...(input.unknown ? { unknown: true as const } : {}), ...(key ? { key } : {}) });
      quote.holds = holds;
      if (!quote.holds.length) delete quote.holds;
      this.save(doc, 'quote-spent', { id: quote.id, amount: input.amount, unit: quote.unit, what: input.what.trim(), by: this.actor, ...(input.unknown ? { unknown: true } : {}), ...(key ? { key } : {}) });
      return { doc, quote };
    });
  }

  /** Picks an option of a stored question: the question is marked answered, and the answer is recorded on the order (it goes back to queued). */
  pick(tag: string, id: string, input: { choice: number; note?: string; who?: string }): { doc: OrderDoc; question: StoredQuestion } {
    return this.retry(() => this.store.transaction(() => {
      const doc = this.get(tag);
      const question = doc.questions?.find(q => q.id.toLowerCase() === id.toLowerCase());
      if (!question) fail('{tag} has no question {id}.', { tag: doc.order.tag, id });
      if (question.answered) fail('Question {id} of {tag} was answered already.', { id: question.id, tag: doc.order.tag });
      if (!Number.isInteger(input.choice) || input.choice < 1 || input.choice > question.options.length) fail('Choose an option from 1 to {n}.', { n: question.options.length });
      const option = question.options[input.choice - 1];
      const text = optionAnswer(option, input.choice, input.note);
      this.act(doc.order.tag, 'answer', { note: text, choice: input.choice });
      const after = this.get(tag);
      const stored = after.questions!.find(q => q.id === question.id)!;
      stored.answered = { choice: [input.choice], ...(input.note?.trim() ? { note: input.note.trim() } : {}), by: this.actor, ...(input.who?.trim() ? { who: input.who.trim() } : {}), at: this.now() };
      this.save(after, 'question-answered', { id: stored.id, choice: input.choice, label: option.label, ...(stored.answered.note ? { note: stored.answered.note } : {}), by: this.actor, ...(stored.answered.who ? { who: stored.answered.who } : {}) });
      return { doc: after, question: stored };
    }));
  }

  /** Orders that a scheduler could start now: queued, with every needed order merged. */
  ready(): OrderDoc[] {
    const docs = this.all();
    const merged = this.mergedSet(docs);
    return docs.filter(d => this.stage(d, merged).stage === 'queued' && d.order.needs.every(n => merged.has(n)));
  }
}

/** The text an answer that picked option `n` records (it becomes the worker's instruction). */
/**
 * The next tag like `tag` that no order has: `FACT1` -> `FACT4` when FACT1..FACT3 exist (one past the highest number with that
 * prefix), `REN2A` -> `REN2C` when REN2A and REN2B exist (the next letter). A tag without a number gets `2`, `3`, ...
 */
export function nextFreeTag(tag: string, existing: readonly string[]): string {
  const have = new Set(existing.map(t => t.toLowerCase()));
  const lettered = /^(.*?\d+)([A-Za-z])$/.exec(tag);
  if (lettered) {
    const [, stem, letter] = lettered;
    const upper = letter === letter.toUpperCase();
    for (let c = letter.toLowerCase().charCodeAt(0) + 1; c <= 122; c++) {
      const next = stem + (upper ? String.fromCharCode(c).toUpperCase() : String.fromCharCode(c));
      if (!have.has(next.toLowerCase())) return next;
    }
  }
  const m = /^(.*?)(\d*)$/.exec(lettered ? lettered[1] : tag)!;
  const prefix = m[1];
  const numbers = existing.map(t => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)[A-Za-z]?$`, 'i').exec(t)).filter(x => !!x).map(x => Number(x![1]));
  let n = Math.max(m[2] ? Number(m[2]) : 1, ...numbers) + 1;
  while (have.has(`${prefix}${n}`.toLowerCase())) n++;
  return `${prefix}${n}`;
}

export function optionAnswer(option: OptionInput, n: number, note?: string): string {
  return `Chosen: option ${n}, ${option.label}${option.note ? ` (${option.note})` : ''}.${note?.trim() ? `\n\n${note.trim()}` : ''}`;
}

export const STAGE_PRIORITY: readonly Stage[] = [
  'awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped', 'running', 'queued', 'waiting-needs', 'waiting-children', 'idle', 'held', 'planned', 'draft', 'merged', 'cancelled',
];
