import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../config.ts';
import { gate } from '../credits/credits.ts';
import { fail } from '../i18n.ts';
import { readStateJson, updateStateJson } from '../orders/state-files.ts';
import type { Orders } from '../orders/service.ts';
import { acquireToolLeases, releaseToolLeases } from '../resources/leases.ts';
import { spawnDetachedProgram } from '../run/spawn.ts';
import { answerText, McpStdio, type McpCallResult } from './mcp-client.ts';
import type { ToolOperation } from './manifest.ts';
import type { LoadedTool } from './registry.ts';
import { schemaProblem } from './schema.ts';

/**
 * A run of one tool operation by Alba itself (not by a worker):
 * - `queued`: made, not run yet (or waiting for a resource slot: `waiting` says which);
 * - `waiting-quote`: a paid operation whose quote on the order waits for a person;
 * - `running`: the operation is being called;
 * - `done` / `failed`: it ran; `refused`: it never ran (quote rejected or not enough left, the tool was turned off).
 */
export type ToolJobStatus = 'queued' | 'waiting-quote' | 'running' | 'done' | 'failed' | 'refused';
export interface ToolJob {
  id: string;
  tool: string;
  version: string;
  operation: string;
  /** The order it runs for: its quote, its spend and its evidence. */
  order?: string;
  /** The producer case and action that asked for it. */
  case?: string;
  action?: string;
  by: string;
  input: Record<string, unknown>;
  status: ToolJobStatus;
  created: string;
  started?: string;
  ended?: string;
  /**
   * A paid operation: the price in the tool's unit, and the order's quote it is spent against. `unpriced`: the tool could not price
   * it (it said so, or answered 0), so a person approves it. `auto`/`autoAt`: Alba approved it, when. `manual`: why Alba did not.
   */
  quote?: { unit: string; amount?: number; id?: string; auto?: boolean; autoAt?: string; note?: string; unpriced?: boolean; manual?: string };
  /** What was booked on the quote: the price, or what the tool said it spent (`spent` in its answer). */
  spent?: number;
  /** The real cost is not known (the call may have gone through): `spent` is the most it may have cost. */
  spentUnknown?: boolean;
  /** A spend that could not be written to the quote yet; the tick books it. */
  unbooked?: { amount: number; what: string; unknown?: boolean };
  warning?: string;
  /** The output folder (absolute, forward slashes). */
  out: string;
  files?: string[];
  /** The start of the answer's text (or the program's output). */
  text?: string;
  waiting?: string;
  error?: string;
  /** The process working on the job now. */
  pid?: number;
}

const JOBS = '_tool-jobs.json';
const EPS = 1e-9;
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const TEXT_MAX = 2000;
const slash = (p: string) => p.replace(/\\/g, '/');
const alive = (pid: number | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function toolJobs(project: ProjectConfig): ToolJob[] { return readStateJson<ToolJob[]>(project, JOBS, []); }
export function toolJob(project: ProjectConfig, id: string): ToolJob {
  return toolJobs(project).find(j => j.id.toLowerCase() === id.toLowerCase()) ?? fail('There is no tool job "{id}".', { id });
}
function saveJob(project: ProjectConfig, job: ToolJob): ToolJob {
  updateStateJson<ToolJob[]>(project, JOBS, [], jobs => { const i = jobs.findIndex(j => j.id === job.id); if (i < 0) jobs.push(job); else jobs[i] = job; return jobs; });
  return job;
}
/** Where a job's events go: its order, or `tool:<job>`. */
const eventTag = (job: ToolJob) => job.order ?? `tool:${job.id}`;

/** An enabled tool's operation, or a refusal that names what there is. */
export function operationOf(project: ProjectConfig, toolId: string, name: string): { tool: LoadedTool; operation: ToolOperation } {
  const tools = project.plugins?.tools ?? {};
  const tool = tools[toolId];
  if (!tool) fail('The project does not enable the tool "{id}". Enabled under "plugins.enable": {known}.', { id: toolId, known: Object.keys(tools).join(', ') || '-' });
  const operation = tool.manifest.operations?.[name];
  if (!operation) fail('The tool "{id}" has no operation "{name}". Its operations: {known}.', { id: toolId, name, known: Object.keys(tool.manifest.operations ?? {}).join(', ') || '-' });
  return { tool, operation };
}

/** The operations of the enabled tools, as the producer and `alba tools list` show them. */
export function toolOperations(project: ProjectConfig): { tool: string; version: string; description: string; operations: { name: string; description: string; input: unknown; paid?: { unit: string; fixed?: number; priced_by_tool?: boolean } }[] }[] {
  return Object.values(project.plugins?.tools ?? {}).filter(t => t.manifest.operations).map(t => ({
    tool: t.manifest.id, version: t.manifest.version, description: t.manifest.description,
    operations: Object.entries(t.manifest.operations!).map(([name, o]) => ({
      name, description: o.description, input: o.input,
      ...(o.quote ? { paid: { unit: o.quote.unit, ...(o.quote.fixed !== undefined ? { fixed: o.quote.fixed } : {}), ...(o.quote.tool ? { priced_by_tool: true } : {}) } } : {}),
    })),
  }));
}

export interface ToolJobRequest { tool: string; operation: string; input: unknown; order?: string; quote?: string; by?: string; case?: string; action?: string }

/** Checks a request and stores it as a queued job: the tool and operation exist, the input fits, a paid operation names its order. */
export function checkToolJob(project: ProjectConfig, orders: Orders, req: ToolJobRequest): { tool: LoadedTool; operation: ToolOperation; order?: string } {
  const { tool, operation } = operationOf(project, req.tool, req.operation);
  const problem = schemaProblem(operation.input, req.input);
  if (problem) fail('The input of {tool}/{operation} does not fit: {problem}.', { tool: req.tool, operation: req.operation, problem });
  const order = req.order ? orders.get(req.order).order.tag : undefined;
  if (operation.quote && !order) fail('{tool}/{operation} is paid ({unit}): name the order it is for (--order <TAG>); the quote and the spend are kept on the order.', { tool: req.tool, operation: req.operation, unit: operation.quote.unit });
  if (req.quote) {
    if (!operation.quote) fail('{tool}/{operation} is free; it needs no quote.', { tool: req.tool, operation: req.operation });
    const q = orders.get(order!).quotes?.find(x => x.id.toLowerCase() === req.quote!.toLowerCase());
    if (!q) fail('{tag} has no quote {id}.', { tag: order!, id: req.quote });
    if (q!.unit !== operation.quote!.unit) fail('Quote {id} of {tag} is in {unit}; {tool}/{operation} is priced in {need}.', { id: q!.id, tag: order!, unit: q!.unit, tool: req.tool, operation: req.operation, need: operation.quote!.unit });
  }
  return { tool, operation, ...(order ? { order } : {}) };
}

export function createToolJob(project: ProjectConfig, orders: Orders, req: ToolJobRequest): ToolJob {
  const { tool, operation, order } = checkToolJob(project, orders, req);
  let job!: ToolJob;
  updateStateJson<ToolJob[]>(project, JOBS, [], jobs => {
    const n = Math.max(0, ...jobs.map(j => Number(/^J(\d+)$/.exec(j.id)?.[1] ?? 0))) + 1;
    const id = `J${n}`;
    job = {
      id, tool: tool.manifest.id, version: tool.manifest.version, operation: req.operation, ...(order ? { order } : {}), ...(req.case ? { case: req.case } : {}), ...(req.action ? { action: req.action } : {}),
      by: req.by ?? orders.actor, input: req.input as Record<string, unknown>, status: 'queued', created: orders.now(),
      ...(operation.quote ? { quote: { unit: operation.quote.unit, ...(req.quote ? { id: orders.get(order!).quotes!.find(x => x.id.toLowerCase() === req.quote!.toLowerCase())!.id } : {}) } } : {}),
      out: slash(path.join(project.state_dir, 'tool-jobs', id)),
    };
    return [...jobs, job];
  });
  orders.record(eventTag(job), 'tool-job-queued', { job: job.id, tool: job.tool, operation: job.operation, by: job.by, ...(job.case ? { case: job.case } : {}) });
  return job;
}

/**
 * Calls a quote tool with the input; it answers `{ amount, note? }` (structured, or as JSON text), or a bare number. The note goes on
 * the quote a person approves (for example "the service could not price it; this is the project's ceiling").
 */
async function priceOf(session: McpStdio, toolName: string, input: Record<string, unknown>, timeoutMs: number): Promise<{ amount: number; note?: string; unpriced?: boolean }> {
  const r = await session.callTool(toolName, input, timeoutMs);
  if (r.isError) throw new Error(`the quote tool ${toolName} answered an error: ${answerText(r).slice(0, 300)}`);
  let answer = r.structuredContent as { amount?: unknown; note?: unknown; unpriced?: unknown } | undefined;
  if (answer?.amount === undefined) {
    const text = answerText(r).trim();
    try { const v = JSON.parse(text); answer = typeof v === 'number' ? { amount: v } : v; } catch { /* not JSON */ }
  }
  const amount = answer?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error(`the quote tool ${toolName} answered no amount (it answers { "amount": <number> })`);
  // A paid operation is never free: a price of 0 is a tool that could not price it, like one that says `unpriced: true`.
  return { amount, ...(typeof answer?.note === 'string' && answer.note.trim() ? { note: answer.note.trim().slice(0, 500) } : {}), ...(answer?.unpriced === true || amount === 0 ? { unpriced: true } : {}) };
}

/** What Alba approved by itself in one unit (`plugins.auto_approve`): in the UTC day of `at`, and in the project ever. */
export function autoApproved(jobs: readonly ToolJob[], unit: string, at: string): { today: number; ever: number } {
  const mine = jobs.filter(j => j.quote?.auto && j.quote.unit === unit);
  const sum = (list: readonly ToolJob[]) => round(list.reduce((n, j) => n + (j.quote!.amount ?? 0), 0));
  return { today: sum(mine.filter(j => (j.quote!.autoAt ?? j.created).slice(0, 10) === at.slice(0, 10))), ever: sum(mine) };
}

/**
 * Reserves Alba's approval of a job's quote under the state lock, so two processes cannot both take the last of a day: the amount
 * must be within `plugins.auto_approve.<unit>` for one job and, with what Alba approved before, within `per_day` (a UTC day) and
 * `per_project`. Answers why not when it does not fit.
 */
function reserveAuto(project: ProjectConfig, id: string, unit: string, amount: number, at: string): string | undefined {
  const rule = project.plugins?.auto_approve?.[unit];
  if (!rule) return `plugins.auto_approve names no ${unit}`;
  if (amount > rule.per_job + EPS) return `${amount} ${unit} is over what Alba approves for one job (plugins.auto_approve.${unit} per_job ${rule.per_job})`;
  let why: string | undefined = 'the job is not stored';
  updateStateJson<ToolJob[]>(project, JOBS, [], jobs => {
    const job = jobs.find(j => j.id === id);
    if (!job?.quote) return jobs;
    const { today, ever } = autoApproved(jobs.filter(j => j.id !== id), unit, at);
    if (today + amount > rule.per_day + EPS) why = `Alba approved ${today} ${unit} of tool jobs today; ${amount} more is over plugins.auto_approve.${unit} per_day ${rule.per_day}`;
    else if (rule.per_project !== undefined && ever + amount > rule.per_project + EPS) why = `Alba approved ${ever} ${unit} of tool jobs in this project; ${amount} more is over plugins.auto_approve.${unit} per_project ${rule.per_project}`;
    else { Object.assign(job.quote, { auto: true, autoAt: at }); why = undefined; }
    return jobs;
  });
  return why;
}

/**
 * Books what a paid call cost on its quote, once: what the tool says it spent (`spent` in its answer); else, for a call that went
 * through, the price; else (a call that failed without saying, timed out, whose process is gone, or a tool that could not price it)
 * the most it may have cost, marked unknown, so the ledger never counts less than was spent. The most is the price, or what the
 * quote has left when there is no price. More than the quote has left is booked as what is left, with a warning. A booking that
 * cannot be written stays on the job (`unbooked`) for the tick.
 */
/** The key a tool job holds and books its quote under: one booking per job, also when it is run again after a crash. */
const jobKey = (job: ToolJob): string => `tool-job:${job.id}`;

function bookSpend(orders: Orders, job: ToolJob, how: { reported?: unknown; failed: boolean; why: string }): void {
  const q = job.quote;
  if (!job.order || !q?.id || job.spent !== undefined || job.unbooked) return;
  const key = jobKey(job);
  const prior = orders.get(job.order).quotes?.find(x => x.id === q.id)?.ledger.find(e => e.key === key);
  if (prior) { job.spent = prior.amount; if (prior.unknown) job.spentUnknown = true; return; }
  const said = typeof how.reported === 'number' && Number.isFinite(how.reported) && how.reported >= 0 ? how.reported : undefined;
  const left = gate(orders, job.order, q.id, 0, { key }).remaining ?? 0;
  const priced = !q.unpriced && (q.amount ?? 0) > 0;
  let amount: number;
  let unknown = false;
  if (said !== undefined) amount = said;
  else if (!how.failed && priced) amount = q.amount!;
  else { unknown = true; amount = priced ? Math.min(q.amount!, left) : left; }
  if (amount > left + EPS) { job.warning = `the tool says it spent ${amount} ${q.unit}; only ${left} were left on quote ${q.id}, so ${left} were booked`; amount = left; }
  const what = `tool job ${job.id} (${job.tool}/${job.operation})${said !== undefined ? ' as the tool reported' : unknown ? `: unknown, at most the quote (${how.why})` : ''}`;
  job.spent = amount;
  if (unknown) job.spentUnknown = true;
  if (amount <= 0) { orders.releaseHold(job.order, q.id, key); return; }
  try { orders.spend(job.order, q.id, { amount, what, key, ...(unknown ? { unknown: true } : {}) }); }
  catch (e) {
    delete job.spent; delete job.spentUnknown;
    job.unbooked = { amount, what, ...(unknown ? { unknown: true } : {}) };
    job.warning = `${amount} ${q.unit} could not be booked on quote ${q.id} (${(e as Error).message.split('\n')[0]}); the tick books it`;
  }
}

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'model/gltf-binary': '.glb' };

/** Writes the image, audio and blob blocks of an answer into the output folder. */
function saveBlocks(r: McpCallResult, out: string): void {
  let n = 0;
  for (const c of r.content ?? []) {
    const data = c.data ?? c.resource?.blob;
    if (!data) continue;
    const type = c.mimeType ?? c.resource?.mimeType ?? '';
    const named = c.resource?.uri ? path.basename(c.resource.uri.replace(/[?#].*$/, '')) : '';
    const name = named && /^[\w.-]+$/.test(named) ? named : `${c.type || 'block'}-${++n}${EXT[type] ?? '.bin'}`;
    writeFileSync(path.join(out, name), Buffer.from(data, 'base64'));
  }
}

const globRe = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?')}$`, 'i');
/** The files of the output folder that are the result: all of them, or the ones the patterns name (a pattern without "/" matches the file name). */
function outputFiles(out: string, patterns?: string[]): string[] {
  const all: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { if (depth < 4) walk(full, depth + 1); } else all.push(full);
    }
  };
  if (existsSync(out)) walk(out, 0);
  const res = patterns?.map(globRe);
  return all.filter(f => !res || res.some(re => re.test(slash(path.relative(out, f))) || re.test(path.basename(f)))).map(slash);
}

function runProgram(argv: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error(`${path.basename(argv[0]!)} did not finish within ${Math.round(timeoutMs / 60000)} min`)); }, timeoutMs);
    child.stdout!.on('data', d => { stdout = (stdout + d).slice(-20000); });
    child.stderr!.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(argv[0]!)} exited with ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`));
    });
  });
}

/**
 * Takes the job for this process: a job no live process works on, in a state that can go on. Returns undefined when someone else has
 * it or there is nothing to do.
 */
function claim(project: ProjectConfig, id: string): ToolJob | undefined {
  let mine: ToolJob | undefined;
  updateStateJson<ToolJob[]>(project, JOBS, [], jobs => {
    const job = jobs.find(j => j.id.toLowerCase() === id.toLowerCase());
    if (job && ['queued', 'waiting-quote'].includes(job.status) && (!job.pid || job.pid === process.pid || !alive(job.pid))) { job.pid = process.pid; mine = { ...job }; }
    return jobs;
  });
  return mine;
}

export interface RunJobOptions { timeoutMs?: number }

/**
 * Takes a job as far as it can go now: prices a paid operation and makes the order's quote (approved by Alba when it is within
 * `plugins.auto_approve`, else waiting for a person), checks the quote with the same gate a worker uses, takes the tool's resources,
 * calls the operation, keeps its outputs in the job's folder, books the spend on the quote and records each step on the order.
 * Running it again later goes on from where it stopped (after a quote is approved, or a resource is free).
 */
export async function runToolJob(project: ProjectConfig, orders: Orders, id: string, options: RunJobOptions = {}): Promise<ToolJob> {
  const job = claim(project, id);
  if (!job) return toolJob(project, id);
  const tag = eventTag(job);
  const before = { status: job.status, waiting: job.waiting };
  const stop = (status: ToolJobStatus, fields: Partial<ToolJob>, event?: string): ToolJob => {
    Object.assign(job, { status, ...fields });
    delete job.pid;
    if (['done', 'failed', 'refused'].includes(status)) { job.ended = orders.now(); delete job.waiting; }
    saveJob(project, job);
    // Waiting again for the same thing is not news.
    if (event && !(status === before.status && job.waiting === before.waiting)) orders.record(tag, event, { job: job.id, tool: job.tool, operation: job.operation, ...(job.waiting ? { waiting: job.waiting } : {}), ...(job.error ? { error: job.error } : {}), ...(job.files ? { files: job.files } : {}), ...(job.quote?.id ? { quote: job.quote.id } : {}) });
    return job;
  };
  let found: { tool: LoadedTool; operation: ToolOperation };
  try { found = operationOf(project, job.tool, job.operation); } catch (e) { return stop('refused', { error: (e as Error).message }, 'tool-job-refused'); }
  const { tool, operation } = found;
  const timeoutMs = options.timeoutMs ?? operation.timeout_minutes * 60000;
  const server = 'mcp' in operation.run ? tool.manifest.agent.mcp[operation.run.mcp]! : undefined;
  const missing = (server?.env_from ?? []).filter(n => !process.env[n]);
  if (missing.length) return stop('failed', { error: `not set in Alba's environment: ${missing.join(', ')}` }, 'tool-job-failed');

  let session: McpStdio | undefined;
  const open = async () => (session ??= await McpStdio.open(server!, Math.min(timeoutMs, 60000), project.root));
  let held = false;
  // From the moment the call is sent it may cost: whatever happens next, its spend is booked once, and the job saved with it.
  let sent = false;
  let reported: unknown;
  const book = (failed: boolean, why: string) => { if (!sent) return; bookSpend(orders, job, { reported, failed, why }); saveJob(project, job); };
  try {
    // 1. A paid operation: its price, and the quote on the order.
    if (operation.quote && job.order) {
      const q = job.quote ??= { unit: operation.quote.unit };
      if (q.amount === undefined) {
        const priced: { amount: number; note?: string; unpriced?: boolean } = operation.quote.fixed !== undefined
          ? { amount: operation.quote.fixed, ...(operation.quote.fixed === 0 ? { unpriced: true } : {}) }
          : await priceOf(await open(), operation.quote.tool!, job.input, Math.min(timeoutMs, 120000));
        q.amount = priced.amount;
        if (priced.note) q.note = priced.note;
        if (priced.unpriced) q.unpriced = true;
      }
      // Every paid call gets a quote and is booked, a price of 0 too: such a quote waits for a person, who sets the cap.
      if (!q.id) {
        const made = orders.quote(job.order, {
          service: `tool ${job.tool}/${job.operation}`, unit: q.unit, cap_requested: q.amount, ...(q.unpriced ? { unpriced: true } : {}),
          note: [`tool job ${job.id}`, q.note ?? (q.unpriced ? 'the tool could not price it; approve a cap of your own' : undefined)].filter(Boolean).join(': '),
        }, job.by).quote;
        q.id = made.id;
        saveJob(project, job);
        const rule = project.plugins?.auto_approve?.[q.unit];
        if (rule) {
          const at = orders.now();
          const why = q.unpriced ? 'Alba never approves a quote the tool could not price' : reserveAuto(project, job.id, q.unit, q.amount, at);
          if (why) q.manual = why;
          else {
            Object.assign(q, { auto: true, autoAt: at });
            saveJob(project, job);
            orders.decideQuote(job.order, made.id, { approve: true, cap: q.amount, note: `approved by Alba: tool jobs up to ${rule.per_job} ${q.unit} each, ${rule.per_day} a day${rule.per_project !== undefined ? `, ${rule.per_project} in the project` : ''} (plugins.auto_approve)` });
          }
          saveJob(project, job);
        }
      }
      const stored = orders.get(job.order).quotes?.find(x => x.id === q.id);
      if (stored?.status === 'pending') return stop('waiting-quote', { waiting: `quote ${q.id} of ${job.order} (${q.unpriced ? `unpriced, asks ${q.amount}` : q.amount} ${q.unit}) waits for approval: alba credits approve ${job.order} ${q.id} --cap ${q.amount > 0 ? q.amount : '<amount>'}${q.manual ? ` (${q.manual})` : ''}` }, 'tool-job-waiting');
      // The amount is held for this job until its booking (same key) or its timeout: another job cannot spend it meanwhile.
      const g = gate(orders, job.order, q.id!, q.amount, { key: jobKey(job), minutes: Math.ceil(timeoutMs / 60000) + 30 });
      if (!g.ok) return stop('refused', { error: g.why }, 'tool-job-refused');
    }
    // 2. The tool's resources.
    const uses = Object.keys(tool.manifest.resources ?? {}).filter(n => project.resources?.[n]);
    const blocked = acquireToolLeases(project, orders, `tool:${job.id}`, uses);
    if (blocked) return stop('queued', { waiting: blocked }, 'tool-job-waiting');
    held = uses.length > 0;
    // 3. The call.
    mkdirSync(job.out, { recursive: true });
    Object.assign(job, { status: 'running', started: orders.now() }); delete job.waiting;
    saveJob(project, job);
    orders.record(tag, 'tool-job-started', { job: job.id, tool: job.tool, operation: job.operation, ...(job.quote?.amount ? { amount: job.quote.amount, unit: job.quote.unit } : {}) });
    let text: string;
    if ('mcp' in operation.run) {
      const args = { ...job.input, ...(operation.run.out_arg ? { [operation.run.out_arg]: job.out } : {}) };
      const mcp = await open();
      sent = true;
      const r = await mcp.callTool(operation.run.tool, args, timeoutMs);
      text = answerText(r);
      reported = (r.structuredContent as { spent?: unknown } | undefined)?.spent;
      if (r.isError) { book(true, 'the tool answered an error without saying what it spent'); throw new Error(`${operation.run.tool} answered an error: ${text.slice(0, 500) || '(no text)'}`); }
      // Booked before anything is written, so a write that fails does not lose the spend.
      book(false, 'the tool could not price it and did not say what it spent');
      saveBlocks(r, job.out);
      if (operation.output.text) writeFileSync(path.join(job.out, operation.output.text), text, 'utf8');
    } else {
      const inputFile = path.join(project.state_dir, 'tool-jobs', `${job.id}.input.json`);
      writeFileSync(inputFile, JSON.stringify(job.input, null, 2) + '\n', 'utf8');
      const argv = operation.run.cli.map((a, i) => (i === 0 ? a : a.split('{input}').join(slash(inputFile)).split('{out}').join(job.out)));
      sent = true;
      text = await runProgram(argv, project.root, timeoutMs);
      book(false, 'the tool could not price it');
    }
    const files = outputFiles(job.out, operation.output.files);
    return stop('done', { files, ...(text.trim() ? { text: text.trim().slice(0, TEXT_MAX) } : {}) }, 'tool-job-done');
  } catch (e) {
    const error = (e as Error).message.split('\n')[0]!.slice(0, 1000);
    // Sent, then a timeout, a lost connection, an exit or a failed write: the call may have cost, so the most it may have cost is booked.
    try { book(true, `the call may have gone through: ${error.slice(0, 300)}`); } catch (b) { job.warning = `the spend could not be booked: ${(b as Error).message.split('\n')[0]}`; }
    return stop('failed', { error }, 'tool-job-failed');
  } finally {
    (session as McpStdio | undefined)?.close();
    if (held) releaseToolLeases(project, orders, `tool:${job.id}`);
  }
}

/** Starts `alba tools resume <job>` as its own process, so the caller (the producer, the console) does not wait for the tool. */
export function startToolJob(project: ProjectConfig, job: ToolJob, spawnDetached: typeof spawnDetachedProgram = spawnDetachedProgram): number {
  const pid = spawnDetached(process.execPath, [slash(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/alba.mjs')), 'tools', 'resume', job.id, '--project', slash(path.resolve(project.file))], {
    cwd: project.root, env: { ALBA_LANG: 'en' }, envUnset: [], logFile: path.join(project.state_dir, 'tool-jobs', `${job.id}.log`),
  });
  updateStateJson<ToolJob[]>(project, JOBS, [], jobs => { const j = jobs.find(x => x.id === job.id); if (j && !alive(j.pid)) j.pid = pid; return jobs; });
  return pid;
}

/**
 * The tick's part: a job whose quote a person has decided, or that waited for a resource, is started again; a job whose process
 * is gone while it ran is marked failed, and when it is paid the most it may have cost is booked as unknown (the call may have been
 * made; the tool's own records say what it cost); a spend that could not be booked before is booked.
 */
export function continueToolJobs(project: ProjectConfig, orders: Orders, spawnDetached: typeof spawnDetachedProgram = spawnDetachedProgram): string[] {
  const out: string[] = [];
  for (const job of toolJobs(project)) {
    if (alive(job.pid)) continue;
    if (job.unbooked && job.order && job.quote?.id) {
      // Taken off the job under the lock first, so two ticks never book it twice.
      let take: ToolJob['unbooked'];
      updateStateJson<ToolJob[]>(project, JOBS, [], jobs => { const j = jobs.find(x => x.id === job.id); if (j?.unbooked && !alive(j.pid)) { take = j.unbooked; delete j.unbooked; } return jobs; });
      if (take) {
        const booked = take;
        try {
          orders.spend(job.order, job.quote.id, { amount: booked.amount, what: booked.what, key: jobKey(job), ...(booked.unknown ? { unknown: true } : {}) });
          updateStateJson<ToolJob[]>(project, JOBS, [], jobs => { const j = jobs.find(x => x.id === job.id); if (j) { j.spent = booked.amount; if (booked.unknown) j.spentUnknown = true; delete j.warning; } return jobs; });
          out.push(`tool job ${job.id}: booked ${booked.amount} ${job.quote.unit} on quote ${job.quote.id}`);
        } catch (e) {
          updateStateJson<ToolJob[]>(project, JOBS, [], jobs => { const j = jobs.find(x => x.id === job.id); if (j) j.unbooked = booked; return jobs; });
          out.push(`tool job ${job.id}: ${booked.amount} ${job.quote.unit} still not booked: ${(e as Error).message.split('\n')[0]}`);
        }
      }
    }
    if (job.status === 'running') {
      let mine: ToolJob | undefined;
      const error = job.quote?.id ? 'the process that ran it is gone; the call may have gone through, so the most it may have cost is booked as unknown (the tool\'s own records say what it cost)' : 'the process that ran it is gone (check the tool\'s own records)';
      updateStateJson<ToolJob[]>(project, JOBS, [], jobs => { const j = jobs.find(x => x.id === job.id); if (j && j.status === 'running' && !alive(j.pid)) { Object.assign(j, { status: 'failed', error, ended: orders.now() }); delete j.pid; mine = { ...j }; } return jobs; });
      if (!mine) continue;
      const failed = mine;
      try { bookSpend(orders, failed, { failed: true, why: 'its process was gone while it ran' }); }
      catch (e) { failed.warning = `the spend could not be booked: ${(e as Error).message.split('\n')[0]}`; }
      saveJob(project, failed);
      orders.record(eventTag(job), 'tool-job-failed', { job: job.id, tool: job.tool, operation: job.operation, error: 'the process that ran it is gone', ...(failed.spent !== undefined ? { spent: failed.spent, unknown: Boolean(failed.spentUnknown) } : {}) });
      out.push(`tool job ${job.id}: its process is gone; marked failed${failed.spentUnknown ? `, ${failed.spent} ${failed.quote!.unit} booked as the most it may have cost` : ''}`);
      continue;
    }
    const decided = job.status === 'waiting-quote' && job.order && job.quote?.id && (orders.resolveTag(job.order) ? orders.get(job.order).quotes?.find(q => q.id === job.quote!.id)?.status !== 'pending' : true);
    const retry = job.status === 'queued' && job.waiting && !job.pid;
    if (!decided && !retry) continue;
    try { startToolJob(project, job, spawnDetached); out.push(`tool job ${job.id}: started again (${decided ? 'its quote was decided' : 'it waited for a resource'})`); }
    catch (e) { out.push(`tool job ${job.id}: could not start: ${(e as Error).message}`); }
  }
  return out;
}
