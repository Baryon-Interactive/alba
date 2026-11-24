import { attentionState } from './attention.ts';
import { attentionFor, saveAttentionMarks } from '../orders/attention-store.ts';
import { effectiveRoles, resolveRole } from '../roles/config.ts';
import { hasLegacyRoles, migrateRoles } from '../roles/migrate.ts';
import { editConfig, EDITABLE, readEditable, type ConfigEdit } from '../config-edit.ts';
import { describeFields, editOrderBody, editOrderFields, ORDER_FIELD_NAMES, type OrderFields } from '../orders/edit-fields.ts';
import { loadMachines, machinesFile } from '../machines/config.ts';
import { machineInstallPlan, machinesView, probeCandidate, probeMachines, startInstall } from '../machines/probe.ts';
import { cancelJob, machineJobs } from '../machines/jobs.ts';
import { InstallRefused } from '../machines/install.ts';
import { addMachine, appendSshHost, editMachine, hostPublicKeys, machineOpsFromSet, removeMachine, setMachineRoles, sshDir, sshHostBlock, testSsh, validateMachine } from '../machines/edit.ts';
import { editSshHost, readSshHost, type SshAddressChange } from '../machines/ssh-config.ts';
import { designGet } from './design.ts';
import { getDesignDoc, intakeReview, listDesignDocs, saveDesignDoc } from '../design/docs.ts';
import { reviewIntakeSystems } from '../design/intake-review.ts';
import { runMeasurements } from '../design/measure.ts';
import { cancelNightlyRuns } from '../gates/runner.ts';
import { scheduleSpend } from '../schedules/health.ts';
import { pauseSchedule, resumeSchedule, runScheduleNow, scheduleViews } from '../schedules/engine.ts';
import { applyChangeSet } from '../design/library.ts';
import { readChangeSet } from '../design/library.ts';
import { DESIGN_OFF, DesignError } from '../design/model.ts';
import { rolesView } from '../roles/view.ts';
import { roleResults } from '../roles/statistics.ts';
import { collectUsage, usageDashboard, budgetWarnings, sinceDate } from '../usage/accounting.ts';
import { scorecard } from '../usage/scorecard.ts';
import { usageRows } from '../usage/store.ts';
import { SqliteStore } from '../orders/sqlite-store.ts';
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { runCheck, summary } from '../check/check.ts';
import { loadProject, type ProjectConfig } from '../config.ts';
import { UserError, defaultLang, t, withLang, type Lang } from '../i18n.ts';
import { answerOrder } from '../run/answer.ts';
import { readInbox } from '../run/inbox.ts';
import { liveActivityTimes } from '../run/messages.ts';
import { sayToGroup, sayToOrder } from '../run/say.ts';
import { ownerOf } from '../usage/spend.ts';
import { sayDeliveryMode } from '../workers/config.ts';
import { startRun, type RunContext } from '../run/launch.ts';
import { approve } from '../run/review.ts';
import { planWorktree } from '../run/worktree.ts';
import { humanAction } from '../service/actions.ts';
import { createOrder } from '../service/new-order.ts';
import { executeTick } from '../tick/execute.ts';
import { findWorktree, readQuotaHistory, tick, type Probes } from '../tick/gather.ts';
import { Orders } from '../orders/service.ts';
import { closeOrder } from '../orders/close.ts';
import { actionProblem } from '../orders/stage.ts';
import { stateStore } from '../orders/backend.ts';
import { formatReport } from '../tick/plan.ts';
import { findFinishes } from '../run/finish.ts';
import type { ProjectView, Snapshot } from '../web/snapshot.ts';
import { loadWorkers, type WorkersFile } from '../workers/config.ts';
import { addWorker, editWorker, editWorkerYaml, opsFromSet, recordWorkerEdit, workerYaml, removeWorker } from '../workers/edit.ts';
import { EditRefused, type EditOutcome } from '../yamledit.ts';
import { normalizeOptions } from '../orders/report.ts';
import { planClean, systemClean } from '../clean/clean.ts';
import { quoteList, toQuote } from '../credits/credits.ts';
import { lessonsFor, lessonsForOrder, readLessons } from '../lessons/lessons.ts';
import { addDecision, decisionList } from '../ledger/decisions.ts';
import { FileRefused, checkOptionImages, listEvidence, resolveReadable } from '../evidence/evidence.ts';
import { DocsError, listDocuments, readDocument, searchDocuments } from '../docs/docs.ts';
import { classifyOrders } from '../routing/classify.ts';
import { routeFor } from '../routing/route.ts';
import { releaseLease, resourceViews } from '../resources/leases.ts';
import { readRegistry } from '../skills/registry.ts';
import { setSkillUse } from '../skills/use.ts';
import { orderSkillsView, skillsView } from '../skills/view.ts';
import { mergeReadiness, orderBaseRef, systemReadiness } from '../review/readiness.ts';
import { computeFirstPassStats, disputeFirstPass } from '../review/first-pass-stats.ts';
import { verifyOrder } from '../verify/verify.ts';
import { producerAct, producerPolicy, producerState, currentProducerActions, runProducerAction, rejectProducerAction, editDraftAction, setProducerPaused } from '../producer/producer.ts';
import { draftPreview } from '../producer/drafting.ts';
import { planOrder, editPlan } from '../orders/planned.ts';
import { directorMessages, directionProposals, standingDirection, postDirectorMessage, decideDirection } from '../producer/conversation-state.ts';
import { producerSessionView, producerSession } from '../producer/session.ts';
import { producerChatPage, producerWorkspace } from '../producer/workspace.ts';
import { readFacts } from '../producer/facts/snapshot.ts';
import { agreementRecords, ruleTrust } from '../producer/trust.ts';
import { producerBriefs } from '../producer/briefs.ts';
import { producerRoundView } from '../producer/round-view.ts';
import { editProducerConfig, readProducerConfig } from '../producer/config-edit.ts';
import { draftAgain, draftWorkView } from '../producer/work-sessions.ts';
import { producerLog } from '../producer/activity.ts';
import { orderDiff } from './diff.ts';
import { doctorProject, type DoctorResult } from '../plugins/doctor.ts';
import { pluginsView } from '../plugins/view.ts';
import { libraryGet, libraryPost } from './library.ts';
import { overviewAll, overviewProject } from './overview-all.ts';
import { sendBody, sendJson } from '../web/response.ts';
import { bodyHashOf, claimIdempotency, completeIdempotency, IDEMPOTENCY_KEY_RE, MUTATING_METHODS, releaseIdempotency } from './idempotency.ts';
import { readOrders } from './read-orders.ts';
import type { Hub } from './hub.ts';
import { transcriptRuns } from '../run/transcript.ts';
import { ORDER_ACTIONS, STAGES } from './types.ts';
import type * as A from './types.ts';
import { admitted } from '../web/auth.ts';
import { toQuestion, detail, numberedEvents, overview, projectInfo, quotaPoint, runList, summaries, summaryOf, workerViews, type View, type ViewEnv } from './views.ts';

/** Machine installs refuse with a reason a person can act on: a conflict, not a server error. */
async function refusals<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (e) {
    if (e instanceof InstallRefused || (e instanceof Error && /^Unknown machine/.test(e.message))) throw new ApiFailure(409, 'conflict', e.message);
    throw e;
  }
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: A.ApiError['error']['code'];
  readonly details?: { field?: string; message: string }[];
  constructor(status: number, code: A.ApiError['error']['code'], message: string, details?: { field?: string; message: string }[]) { super(message); this.status = status; this.code = code; this.details = details; }
}

export interface ApiContext {
  projects: ProjectConfig[];
  workers?: WorkersFile;
  probes: Probes;
  /** Probes whose slow answers (quota command, memory) are kept for a while. */
  slow: Probes;
  token: string;
  /** Origins besides the server's own that may call the interface (a front end's dev server). */
  extraOrigins: string[];
  snapshot(): Snapshot;
  /** The snapshot as it is (possibly a little old), or none yet; never builds one. */
  peek(): Snapshot | undefined;
  /** Latest cached readings, including the previous snapshot after invalidation; aggregate reads only. */
  readings?: () => Snapshot | undefined;
  /** Changes whenever the server invalidates state-derived caches, including external writes. */
  readonly revision: number;
  invalidate(): void;
  hub: Hub;
  version: string;
  loop?: () => A.Session['loop'];
  eventLoopDelay?: () => import('../serve/delay.ts').LoopDelay;
  runTick?: (project: ProjectConfig, real: boolean, maxDispatch: number) => Promise<import('../tick/gather.ts').TickResult>;
  sessionControl?: (project: ProjectConfig, action: 'start' | 'stop') => Promise<import('../producer/session.ts').ProducerSessionStatus>;
  /** Last completed coordinator readings, forwarded without rerunning probes on HTTP. */
  tickResults?: Record<string, import('../tick/gather.ts').TickResult>;
  /** Goes up each time a project's tick results arrive (the reader lanes are sent them again only then). */
  tickRevision?: number;
  onReadings?: (project: string, result: import('../tick/gather.ts').TickResult) => void;
  /** Problems the server itself knows (a refused configuration file), shown next to the tick's. */
  extraProblems?: (project: string) => A.Problem[];
  /** Called after a real tick or a write, so that the tick loop of `alba serve` can note it. */
  onTick?: (project: string, source: 'api') => void;
  /** Where the SSH config is and how a connection is tested (tests point these elsewhere). */
  ssh?: { dir?: string; test?: (alias: string) => Promise<import('../machines/edit.ts').ConnectionTest> };
}

/** The `ssh` part of a machine edit: a field left out stays; an empty port (or null) goes back to 22. */
function sshChange(raw: unknown): SshAddressChange | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiFailure(400, 'bad_request', '"ssh" has hostname, user and port.');
  const r = raw as Record<string, unknown>, change: SshAddressChange = {};
  const unknown = Object.keys(r).filter(k => !['hostname', 'user', 'port'].includes(k));
  if (unknown.length) throw new ApiFailure(400, 'bad_request', `"ssh" has hostname, user and port, not ${unknown.join(', ')}.`, unknown.map(field => ({ field: `ssh.${field}`, message: 'Unknown field.' })));
  for (const k of ['hostname', 'user'] as const) if (r[k] !== undefined) { if (typeof r[k] !== 'string') throw new ApiFailure(400, 'bad_request', `"ssh.${k}" is text.`); change[k] = (r[k] as string).trim(); }
  if (r.port !== undefined) change.port = r.port === null || r.port === '' ? null : typeof r.port === 'number' ? r.port : Number.NaN;
  return Object.keys(change).length ? change : undefined;
}

const MAX_BODY = 1_000_000;
const LOG_READ_BYTES = 1_000_000;

/** Doctor checks running now, by project and tool ids: the same check asked again joins the running one. */
const doctorRuns = new Map<string, Promise<DoctorResult[]>>();
const projectCaches = new WeakMap<ApiContext, { at: number; revision: number; projects: ProjectConfig[]; workers?: WorkersFile; value: A.ProjectInfo[] }>();

/** UserError messages are for people; the status comes from what they say. */
function classify(e: UserError): ApiFailure {
  if (/^Acceptance failed:/.test(e.english)) return new ApiFailure(409, 'conflict', e.message);
  const m = e.english;      // the status comes from the English text, whatever language the message is in
  if (/^No order "|has no run |No worktree found|^No worker "|^No skill "|^No schedule "|merge readiness cannot be read|^There is no (pick set|setting|quote file) /.test(m)) return new ApiFailure(404, 'not_found', e.message);
  if (/already exists|exists already| cannot start now: |^There is a worker ".*" already|cannot (queue|hold|release|cancel|approve|rework|answer|message) an order that is|only an order that is awaiting review|waits for a card to be clicked|is taken already|which is still open|was decided already|is decided already|was answered already|The (file|text) of .* changed; |has a quote .* already|would go above the approved cap|nothing can be spent|only a queued order can be started|already has an open run|has no open run|has no process this tool started|Refusing to stop|is not in .* yet\. Merge it|accept command/.test(m)) return new ApiFailure(409, 'conflict', e.message);
  return new ApiFailure(400, 'bad_request', e.message);
}

const withDetails = (f: ApiFailure, details: { field?: string; message: string }[]): ApiFailure => new ApiFailure(f.status, f.code, f.message, details);

const parsedBodies = new WeakMap<IncomingMessage, Record<string, unknown>>();
const capturedResponses = new WeakMap<ServerResponse, { status: number; body: string } | null>();

function json(res: ServerResponse, status: number, value: unknown): void {
  if (capturedResponses.has(res)) {
    capturedResponses.set(res, { status, body: JSON.stringify(value) });
  }
  sendJson(res, status, value);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const cached = parsedBodies.get(req);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiFailure(413, 'too_large', 'The request body is larger than 1 MB.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        const empty: Record<string, unknown> = {};
        parsedBodies.set(req, empty);
        return resolve(empty);
      }
      try {
        const v = JSON.parse(text) as unknown;
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
        const obj = v as Record<string, unknown>;
        parsedBodies.set(req, obj);
        resolve(obj);
      } catch { reject(new ApiFailure(400, 'bad_request', 'The body must be a JSON object.')); }
    });
    req.on('error', reject);
  });
}

const str = (body: Record<string, unknown>, key: string, required = false): string | undefined => {
  const v = body[key];
  if (v === undefined || v === null) { if (required) throw new ApiFailure(400, 'bad_request', `"${key}" is required.`); return undefined; }
  if (typeof v !== 'string') throw new ApiFailure(400, 'bad_request', `"${key}" must be a string.`);
  return v;
};
const numberOf = (body: Record<string, unknown>, key: string, required = false): number | undefined => {
  const v = body[key];
  if (v === undefined || v === null) { if (required) throw new ApiFailure(400, 'bad_request', `"${key}" is required.`); return undefined; }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiFailure(400, 'bad_request', `"${key}" must be a number.`);
  return v;
};
const strList = (body: Record<string, unknown>, key: string): string[] | undefined => {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new ApiFailure(400, 'bad_request', `"${key}" must be a list of strings.`);
  return v as string[];
};

export function originAllowed(origin: string | undefined, port: number, extra: readonly string[]): boolean {
  if (origin === undefined) return true;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra].includes(origin);
}

/** The host header must name this server on a loopback name: anything else (DNS rebinding) is refused. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** The language of a request: `?lang=`, then the header `x-alba-lang`, then `Accept-Language`, else the server's own default. */
export function langOf(req: IncomingMessage, url: URL): Lang {
  const pick = (v: string | undefined): Lang | undefined => (v === undefined ? undefined : /^zh/i.test(v.trim()) ? 'zh' : /^en/i.test(v.trim()) ? 'en' : undefined);
  const header = (name: string) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };
  return pick(url.searchParams.get('lang') ?? undefined) ?? pick(header('x-alba-lang')) ?? pick(header('accept-language')?.split(',')[0]) ?? defaultLang();
}

export async function handleApi(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, port: number): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  let claimed: { store: import('../orders/store.ts').OrderStore; key: string } | undefined;
  try {
    await withLang(langOf(req, url), async () => {
      const rawKey = req.headers['idempotency-key'];
      const headerKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      if (headerKey !== undefined && MUTATING_METHODS.has(method)) {
        if (!originAllowed(req.headers.origin, port, ctx.extraOrigins)) throw new ApiFailure(403, 'forbidden', 'This origin may not use the interface.');
        if (!admitted(req)) throw new ApiFailure(401, 'unauthorized', 'A write needs the console key in the header x-alba-token, or a signed-in browser session.');
        if (!IDEMPOTENCY_KEY_RE.test(headerKey)) {
          throw new ApiFailure(400, 'bad_request', t('Idempotency-Key must be 1 to 100 characters of letters, digits, "-" and "_".'));
        }
        const body = await readJson(req);
        const projectId = typeof body.project === 'string' && body.project ? body.project : (url.searchParams.get('project') ?? undefined);
        const project = (projectId ? ctx.projects.find(p => p.id === projectId) : undefined) ?? ctx.projects[0];
        if (project) {
          const store = stateStore(project);
          const claim = claimIdempotency(store, {
            key: headerKey,
            method,
            route: url.pathname,
            bodyHash: bodyHashOf(body),
            now: ctx.probes.now(),
          });
          if (claim.outcome === 'mismatch') {
            throw new ApiFailure(409, 'request_mismatch', t('Idempotency-Key "{key}" was already used with a different request.', { key: headerKey }));
          }
          if (claim.outcome === 'in_progress') {
            throw new ApiFailure(409, 'request_in_progress', t('A request with Idempotency-Key "{key}" is still in progress.', { key: headerKey }));
          }
          if (claim.outcome === 'replay') {
            sendBody(req, res, claim.statusCode, claim.responseBody, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
              vary: 'x-alba-lang, Accept-Language',
              'idempotent-replay': 'true',
            });
            return;
          }
          claimed = { store, key: headerKey };
          capturedResponses.set(res, null);
        }
      }
      await route(ctx, req, res, url, port);
    });
    if (claimed) {
      const captured = capturedResponses.get(res);
      if (captured && captured.status < 500) {
        completeIdempotency(claimed.store, claimed.key, captured.status, captured.body, ctx.probes.now());
      } else {
        releaseIdempotency(claimed.store, claimed.key);
      }
    }
  } catch (e) {
    const failure = e instanceof ApiFailure ? e : e instanceof DesignError ? new ApiFailure(e.status, e.status === 409 ? 'conflict' : e.status === 404 ? 'not_found' : 'bad_request', e.message) : e instanceof EditRefused ? withDetails(classify(e), e.details) : e instanceof UserError ? classify(e) : new ApiFailure(500, 'internal', (e as Error).message.split('\n')[0]);
    const payload = { error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } } satisfies A.ApiError;
    if (claimed) {
      if (failure.status < 500) {
        completeIdempotency(claimed.store, claimed.key, failure.status, JSON.stringify(payload), ctx.probes.now());
      } else {
        releaseIdempotency(claimed.store, claimed.key);
      }
    }
    if (res.headersSent) return void res.end();
    sendJson(res, failure.status, payload);
  }
}

async function route(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL, port: number): Promise<void> {
  if (!originAllowed(req.headers.origin, port, ctx.extraOrigins)) throw new ApiFailure(403, 'forbidden', 'This origin may not use the interface.');
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);   // after "api"
  const q = (name: string) => url.searchParams.get(name) ?? undefined;
  const method = req.method ?? 'GET';
  const env = (): ViewEnv => ({ probes: ctx.probes, workers: ctx.workers });

  const needsWrite = () => {
    // The server let the request in (auth.ts): the key in x-alba-token, or a browser session from an allowed origin.
    if (!admitted(req)) throw new ApiFailure(401, 'unauthorized', 'A write needs the console key in the header x-alba-token, or a signed-in browser session.');
    projectCaches.delete(ctx);
  };
  /** A project's orders without the tick's findings: cheap, and what almost every call needs. */
  const light = (id: string | undefined): View => {
    const config = id !== undefined ? ctx.projects.find(p => p.id === id) : ctx.projects.length === 1 ? ctx.projects[0] : undefined;
    if (!config) {
      if (id === undefined) throw new ApiFailure(400, 'bad_request', `"project" is required: ${ctx.projects.map(p => p.id).join(', ')}.`);
      throw new ApiFailure(404, 'not_found', `No project "${id}".`);
    }
    const source = new Orders(stateStore(config), () => ctx.probes.now().toISOString(), 'web');
    const orders = method === 'GET' ? readOrders(source) : source;
    return { config, orders, rows: ctx.peek()?.projects.find(p => p.config.id === config.id)?.rows ?? [] };
  };
  /** The choice of worker for one order, from the workers as the latest snapshot saw them. */
  const routeOf = (id: string | undefined, tag: string): A.Route => {
    if (!ctx.workers) throw new ApiFailure(400, 'bad_request', 'No workers file was given, so there is no choice of worker to show.');
    const view = light(id);
    const snap = ctx.peek() ?? ctx.snapshot();
    const states = viewOf(snap, view.config.id).workers;
    if (!states) throw new ApiFailure(400, 'bad_request', 'The workers could not be read just now.');
    return routeFor(view.config, view.orders.get(tag), states, ctx.probes.now().toISOString(), ctx.workers);
  };
  const viewOf = (snap: Snapshot, id: string | undefined): ProjectView => {
    const found = id !== undefined ? snap.projects.find(p => p.config.id === id) : snap.projects.length === 1 ? snap.projects[0] : undefined;
    if (found) return found;
    if (id === undefined) throw new ApiFailure(400, 'bad_request', `"project" is required: ${snap.projects.map(p => p.config.id).join(', ')}.`);
    throw new ApiFailure(404, 'not_found', `No project "${id}".`);
  };

  const workersFile = (): string => {
    if (!ctx.workers?.file) throw new ApiFailure(400, 'bad_request', 'No workers file was given, so there is nothing to edit.');
    return ctx.workers.file;
  };
  /** After a write to the workers file: the event, the file as the server now reads it, and the answer. */
  const workerWritten = (view: View, id: string, out: EditOutcome, file: string, status: number): void => {
    if (!out.dryRun && out.changed.length) {
      recordWorkerEdit(view.orders, id, out, file);
      ctx.workers = loadWorkers(file);
      ctx.invalidate();
    }
    const result: A.WorkerEditResult = { ok: true, id, changed: out.changed, file, ...(out.backup ? { backup: out.backup } : {}), dryRun: out.dryRun };
    if (!out.dryRun) {
      const snap = ctx.snapshot();
      const worker = workerViews(snap, env(), viewOf(snap, view.config.id)).find(w => w.id === id);
      if (worker) result.worker = worker;
    }
    json(res, status, result satisfies A.WorkerEditResult);
  };

  if (method === 'PUT') {
    needsWrite();
    const body = await readJson(req);
    const view = light(str(body, 'project'));
    if (parts[0] === 'workers' && parts.length === 2) {
      const file = workersFile();
      const set = body.set, yaml = str(body, 'yaml');
      if ((set === undefined) === (yaml === undefined)) throw new ApiFailure(400, 'bad_request', 'Give either "set" or "yaml".');
      if (set !== undefined && (typeof set !== 'object' || set === null || Array.isArray(set))) throw new ApiFailure(400, 'bad_request', '"set" must be an object.');
      const options = { dryRun: body.dryRun === true, now: ctx.probes.now() };
      const out = yaml !== undefined ? editWorkerYaml(file, parts[1], yaml, options) : editWorker(file, parts[1], opsFromSet(set as Record<string, unknown>), options);
      return workerWritten(view, parts[1], out, file, 200);
    }
    throw new ApiFailure(404, 'not_found', `No such call: PUT ${url.pathname}`);
  }

  if (method === 'GET') {
    if (parts[0] === 'review' && parts[1] === 'stats' && parts.length === 2) {
      const view = light(q('project'));
      const rawDays = q('days');
      const days = rawDays === undefined ? 30 : Number(rawDays);
      if (!Number.isFinite(days) || days <= 0) throw new ApiFailure(400, 'bad_request', '"days" must be a positive number.');
      return json(res, 200, computeFirstPassStats(view.config, view.orders, { days, now: ctx.probes.now() }) satisfies A.FirstPassStats);
    }
    if (parts[0] === 'producer' && parts[1] === 'log' && parts.length === 2) {
      if (q('since') && !Number.isFinite(Date.parse(q('since')!))) throw new ApiFailure(400, 'bad_request', '"since" must be an ISO time.');
      const view = light(q('project'));
      return json(res, 200, producerLog(view.config, view.orders, { since: q('since'), kind: q('kind'), order: q('order'), status: q('status'), autonomous: q('autonomous') === 'true', superseded: q('superseded') === 'true' }, ctx.probes.now()));
    }
    if (parts[0] === 'design') {
      const view = light(q('project'));
      return json(res, 200, view.config.design?.enabled ? designGet(view.config, view.orders, parts.slice(1), q) : { enabled: false, note: DESIGN_OFF });
    }
    if (parts[0] === 'design-docs' && parts.length === 1) {
      const view = light(q('project')); return json(res, 200, { project: view.config.id, docs: listDesignDocs(view.config) });
    }
    if (parts[0] === 'design-docs' && parts.length === 2) {
      const version = q('version'); if (version !== undefined && (!/^\d+$/.test(version) || Number(version) < 1)) throw new ApiFailure(400, 'bad_request', 'version must be a positive integer.');
      const view = light(q('project')); return json(res, 200, getDesignDoc(view.config, parts[1], version ? Number(version) : undefined));
    }
    if (parts[0] === 'intake' && parts[2] === 'review' && parts.length === 3) {
      const view = light(q('project')); return json(res, 200, intakeReview(view.config, view.orders, parts[1]));
    }
    if (parts[0] === 'producer' && parts[1] === 'config' && parts.length === 2) {
      const view = light(q('project'));
      return json(res, 200, readProducerConfig(view.config.file) satisfies A.ProducerConfigView);
    }
    if (parts[0] === 'producer' && parts[1] === 'workspace' && parts.length === 2) {
      const view = light(q('project'));
      return json(res, 200, producerWorkspace(view.config, view.orders));
    }
    if (parts[0] === 'producer' && parts[1] === 'analysis' && parts.length === 2) {
      const view = light(q('project'));
      return json(res, 200, { ...producerRoundView(view.config, view.orders), project: view.config.id, snapshot: readFacts(view.config) ?? null } satisfies A.ProducerFacts);
    }
    if (parts[0] === 'p' && parts[2] === 'producer' && parts[3] === 'insights' && parts.length === 4) {
      const project = ctx.projects.find(p => p.id === parts[1]);
      if (!project) throw new ApiFailure(404, 'not_found', `No project "${parts[1]}".`);
      return json(res, 200, { project: project.id, trust: ruleTrust(project.producer.rules, agreementRecords(project), project.producer.trust, ctx.probes.now().toISOString()), briefs: producerBriefs(project).slice(0, 50) } satisfies A.ProducerInsights);
    }
    if (parts[0] === 'p' && parts[2] === 'producer' && parts[3] === 'facts' && parts.length === 4) {
      const project = ctx.projects.find(p => p.id === parts[1]);
      if (!project) throw new ApiFailure(404, 'not_found', `No project "${parts[1]}".`);
      return json(res, 200, { project: project.id, snapshot: readFacts(project) ?? null });
    }
    if (parts[0] === 'producer' && parts[1] === 'chat' && parts[2] === 'stream') {
      const view = light(q('project'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      let previous = '';
      const send = () => {
        const value = JSON.stringify(producerChatPage(view.config, view.orders));
        if (value !== previous) { previous = value; res.write(`data: ${value}\n\n`); }
      };
      send();
      const timer = setInterval(() => { try { send(); } catch { res.end(); } }, 250);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (parts[0] === 'producer' && parts[1] === 'chat' && parts.length === 2) {
      const view = light(q('project'));
      return json(res, 200, producerChatPage(view.config, view.orders, q('before'), Number(q('limit')) || 30));
    }

    if (parts[0] === 'producer' && parts.length === 1) {
      const view = light(q('project'));
      // Reading only: serve's tick runs the intake pass (it parses run logs and may verify deliveries).
      const state = producerState(view.config), policy = producerPolicy(view.config);
      const cases = state.cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(c => c.status === 'open' ? c : { ...c, facts: {}, card: { trigger: c.trigger, summary: c.card.summary.replace(/\s+/g, ' ').slice(0, 160), pointers: [], untrusted: [] } });
      const actions = currentProducerActions(view.config, view.orders).sort((a, b) => b.at.localeCompare(a.at));
      const limit = Math.floor(Math.min(100, Math.max(1, Number(q('limit') ?? 100) || 100)));
      const cursor = Math.floor(Math.max(0, Number(q('cursor') ?? 0) || 0));
      // Open cases are always complete; closed history is bounded by count and bytes.
      const visible = cases.filter(c => c.status === 'open');
      const result: A.ProducerView = { ...producerRoundView(view.config, view.orders), project: view.config.id, enabled: policy.enabled, paused: state.paused, policy: { version: policy.version, hash: policy.hash, modes: [...new Set(policy.rules.map(r => r.mode))], rules: policy.rules, budgets: policy.budgets }, cases: visible, caseCount: cases.length, actions: actions.filter(a => a.status === 'proposed').concat(actions.filter(a => a.status !== 'proposed').slice(0, 20)), wouldDo: actions.filter(a => a.status === 'would-do').slice(0, 50), session: producerSessionView(view.config) };
      let bytes = Buffer.byteLength(JSON.stringify(result)), end = cursor, closed = 0;
      for (; end < Math.min(cases.length, cursor + limit); end++) {
        if (cases[end].status === 'open') continue;
        const size = Buffer.byteLength(JSON.stringify(cases[end])) + 1;
        if (closed && bytes + size > 58_000) break;
        visible.push(cases[end]); bytes += size; closed++;
      }
      if (end < cases.length) result.nextCursor = String(end);
      return json(res, 200, result);
    }
    if (parts[0] === 'p' && parts[2] === 'overview' && parts.length === 3) {
      const project = parts[1];
      if (!ctx.projects.some(p => p.id === project)) throw new ApiFailure(404, 'not_found', `No project "${project}".`);
      const now = new Date();
      const cached = ctx.readings?.() ?? ctx.peek();
      const snap: Snapshot = { ...(cached ?? { at: now.toISOString() }), projects: ctx.projects.map(config => ({ ...(cached?.projects.find(v => v.config.id === config.id) ?? { rows: [] }), config, orders: new Orders(stateStore(config)) })) };
      return json(res, 200, overviewProject(snap, project, ctx.workers, ctx.extraProblems, ctx.loop?.()?.lastTickAt, now));
    }
    if (parts[0] === 'overview' && parts[1] === 'all' && parts.length === 2) {
      const now = new Date();
      const cached = ctx.readings?.() ?? ctx.peek();
      const snap: Snapshot = { ...(cached ?? { at: now.toISOString() }), projects: ctx.projects.map(config => ({ ...(cached?.projects.find(v => v.config.id === config.id) ?? { rows: [] }), config, orders: new Orders(stateStore(config)) })) };
      return json(res, 200, overviewAll(snap, ctx.workers, ctx.extraProblems, ctx.loop?.()?.lastTickAt, now));
    }
    if (parts[0] === 'workers' && parts[2] === 'yaml' && parts.length === 3) {
      const file = workersFile();
      return json(res, 200, { id: parts[1], file, yaml: workerYaml(file, parts[1]) } satisfies A.WorkerYaml);
    }
    if (parts[0] === 'session' && parts.length === 1) {
      return json(res, 200, { lang: defaultLang(), version: ctx.version, at: ctx.probes.now().toISOString(), projects: ctx.projects.map(p => projectInfo(light(p.id), env())), ...(ctx.loop?.() ? { loop: ctx.loop() } : {}), eventLoopDelay: ctx.eventLoopDelay?.() } satisfies A.Session);
    }
    if (parts[0] === 'usage' && parts[1] === 'runs' && parts.length === 2) {
      const view = light(q('project'));
      const ledger = collectUsage(view.config, view.orders.all(), ctx.workers, ctx.probes);
      return json(res, 200, usageDashboard(ledger.rows, ledger.signals, budgetWarnings(view.config, ledger.rows, ctx.probes.now()), sinceDate(q('since') ?? '7d', ctx.probes.now()), ctx.probes.now(), roleResults(view.orders.all(), ledger.rows, sinceDate(q('since') ?? '7d', ctx.probes.now()), ctx.probes.now().toISOString())));
    }
    if (parts[0] === 'usage' && parts[1] === 'scorecard' && parts.length === 2) {
      const projectId = q('project') || undefined;
      const selected = projectId
        ? (() => {
            const p = ctx.projects.find(x => x.id === projectId);
            if (!p) throw new ApiFailure(404, 'not_found', `No project "${projectId}".`);
            return [p];
          })()
        : ctx.projects;
      const now = ctx.probes.now();
      const since = sinceDate(q('since') ?? '14d', now);
      const until = now.toISOString();
      const kind = q('kind') || undefined;
      const by = (q('by') ?? 'worker') as A.ScorecardBy;
      const docs = selected.flatMap(config => readOrders(new Orders(stateStore(config), () => until, 'web')).all().map(doc => ({ project: config.id, doc })));
      const rows = selected.flatMap(config => usageRows(config));
      return json(res, 200, scorecard({ docs, rows, workers: ctx.workers, since, until, kind, by }) satisfies A.Scorecard);
    }
    if (parts[0] === 'projects' && parts.length === 1) {
      const hit = projectCaches.get(ctx);
      if (hit && hit.revision === ctx.revision && Date.now() - hit.at < 2000 && hit.projects === ctx.projects && hit.workers === ctx.workers) return json(res, 200, hit.value);
      const value = ctx.projects.map(p => projectInfo(light(p.id), env()));
      projectCaches.set(ctx, { at: Date.now(), revision: ctx.revision, projects: ctx.projects, workers: ctx.workers, value });
      return json(res, 200, value);
    }
    if (parts[0] === 'overview' && parts.length === 1) {
      const snap = ctx.snapshot();
      return json(res, 200, overview(viewOf(snap, q('project')), snap, env(), ctx.extraProblems?.(viewOf(snap, q('project')).config.id)) satisfies A.Overview);
    }
    if (parts[0] === 'schedules' && parts.length === 1) {
      const view = light(q('project'));
      const now = ctx.probes.now();
      return json(res, 200, { project: view.config.id, at: now.toISOString(), schedules: scheduleViews(view.config, view.orders, now, (docs, at) => scheduleSpend(docs, at, ctx.workers?.workers, ctx.probes)) } satisfies A.ScheduleList);
    }
    if (parts[0] === 'orders' && parts.length === 1) {
      const view = light(q('project'));
      const stage = q('stage');
      if (stage !== undefined && !(STAGES as readonly string[]).includes(stage)) throw new ApiFailure(400, 'bad_request', `Unknown stage "${stage}". Stages: ${STAGES.join(', ')}.`);
      const items = summaries(view, env(), true).filter(i => !stage || i.stage === stage);
      return json(res, 200, { project: view.config.id, ...(stage ? { stage: stage as A.Stage } : {}), count: items.length, items } satisfies A.OrderList);
    }
    if (parts[0] === 'orders' && parts.length === 2) {
      const view = light(q('project'));
      const d = detail(view, parts[1], env());
      const openRun = d.runs.find(r => !r.ended);
      if (openRun) {
        const doc = view.orders.get(d.order.tag);
        const rawOpen = doc.runs.find(r => r.ended === undefined);
        const worker = ctx.workers ? ownerOf(ctx.workers.workers, openRun.worker) : undefined;
        d.sayDelivery = sayDeliveryMode(worker, rawOpen?.engine, !!rawOpen?.host);
        if (d.worktree) {
          d.messages = readInbox(d.worktree, { openedAt: openRun.live?.inbox_opened_at, activityAt: liveActivityTimes(openRun.live) });
        }
      }
      const closeProblem = openRun && d.stage !== 'running' && d.stage !== 'monitoring'
        ? t('Run {run} of {tag} is still open; stop the run first before closing.', { run: openRun.id, tag: d.order.tag })
        : actionProblem(d.stage, 'merged-elsewhere');
      if (closeProblem) d.unavailable.close = closeProblem;
      else if (!d.actions.includes('close')) d.actions.push('close');
      return json(res, 200, d satisfies A.OrderDetail);
    }
    if (parts[0] === 'orders' && parts[2] === 'draft' && parts.length === 3) {
      const view = light(q('project'));
      const tag = view.orders.get(parts[1]).order.tag;
      const action = producerState(view.config).actions.filter(a => a.kind === 'draft-order' && a.target === tag).at(-1);
      const states = viewOf(ctx.peek() ?? ctx.snapshot(), view.config.id).workers ?? [];
      return json(res, 200, { action, preview: action?.order ? draftPreview(view.config, view.orders, action.order, states, ctx.workers) : undefined, ...draftWorkView(view.config, tag) } satisfies A.DraftView);
    }
    if (parts[0] === 'orders' && parts[2] === 'diff' && parts.length === 3) {
      const view = light(q('project'));
      const doc = view.orders.get(parts[1]);
      const worktree = doc.order.worktree ?? findWorktree(doc.order.tag, ctx.probes.worktrees(view.config.root));
      if (!worktree || !existsSync(worktree)) throw new ApiFailure(404, 'not_found', `${doc.order.tag} has no worktree to read a diff from.`);
      return json(res, 200, orderDiff(view.config.id, doc.order.tag, worktree, planWorktree(view.config, doc.order).baseRef) satisfies A.OrderDiff);
    }
    if (parts[0] === 'orders' && parts[2] === 'readiness' && parts.length === 3) {
      const view = light(q('project'));
      const doc = view.orders.get(parts[1]);
      if (!doc.order.branch) throw new ApiFailure(404, 'not_found', t('{tag} has no branch, so merge readiness cannot be read.', { tag: doc.order.tag }));
      const docs = view.orders.all();
      const merged = view.orders.mergedSet(docs);
      const peers = docs.flatMap(d => {
        const branch = d.order.branch;
        if (d.order.tag === doc.order.tag || !branch) return [];
        const stage = view.orders.stage(d, merged).stage;
        if (stage !== 'running' && stage !== 'awaiting-review') return [];
        return [{ tag: d.order.tag, branch, baseRef: orderBaseRef(view.config, d.order) }];
      });
      const body = mergeReadiness({ repo: view.config.root, tag: doc.order.tag, branch: doc.order.branch, baseRef: orderBaseRef(view.config, doc.order), peers, now: ctx.probes.now().toISOString() }, systemReadiness);
      return json(res, 200, { project: view.config.id, ...body } satisfies A.MergeReadiness);
    }
    if (parts[0] === 'runs' && parts.length === 1) {
      const since = q('since');
      if (since !== undefined && Number.isNaN(Date.parse(since))) throw new ApiFailure(400, 'bad_request', '"since" must be an ISO time.');
      const limit = Math.min(500, Math.max(1, Number(q('limit') ?? 100) || 100));
      return json(res, 200, runList(light(q('project')), env(), { since: since ? new Date(since).toISOString() : undefined, worker: q('worker'), limit, cursor: q('cursor') }) satisfies A.RunList);
    }
    if (parts[0] === 'runs' && parts[2] === 'log' && parts.length === 3) {
      const view = light(q('project'));
      const found = findRun(view, parts[1]);
      if (!found?.run.log || !existsSync(found.run.log)) throw new ApiFailure(404, 'not_found', `Run ${parts[1]} has no log.`);
      const tail = Math.min(2000, Math.max(1, Number(q('tail') ?? 200) || 200));
      return json(res, 200, readLogTail(view.config.id, parts[1], found.run.log, tail) satisfies A.RunLog);
    }
    if (parts[0] === 'runs' && parts[2] === 'transcript' && parts.length === 3) {
      const view = light(q('project'));
      const found = findRun(view, parts[1]);
      const file = found?.run.events_file ?? found?.run.log;
      if (!file || !existsSync(file)) throw new ApiFailure(404, 'not_found', t('Run {key} has no transcript.', { key: parts[1] }));
      const rawAfter = q('after');
      let after: number | undefined;
      if (rawAfter !== undefined) {
        after = Number(rawAfter);
        if (!Number.isInteger(after) || after < 0) throw new ApiFailure(400, 'bad_request', t('"after" must be a whole number >= 0.'));
      }
      const rawLimit = q('limit');
      let limit = 200;
      if (rawLimit !== undefined) {
        const parsed = Number(rawLimit);
        if (!Number.isFinite(parsed) || parsed < 1) throw new ApiFailure(400, 'bad_request', t('"limit" must be a positive number.'));
        limit = Math.min(1000, Math.floor(parsed));
      }
      const ended = found!.run.ended !== undefined;
      const page = transcriptRuns.page(file, { after, limit, ended, now: ctx.probes.now() });
      return json(res, 200, { project: view.config.id, key: parts[1], ...page, ended } satisfies A.RunTranscript);
    }
    if (parts[0] === 'orders' && parts[2] === 'evidence' && parts.length === 3) {
      const view = light(q('project'));
      return json(res, 200, listEvidence(view.config, view.orders, ctx.probes, parts[1]) satisfies A.EvidenceList);
    }
    if (parts[0] === 'orders' && parts[2] === 'route' && parts.length === 3) {
      return json(res, 200, routeOf(q('project'), parts[1]) satisfies A.Route);
    }
    if (parts[0] === 'orders' && parts[2] === 'skills' && parts.length === 3) {
      const view = light(q('project'));
      return json(res, 200, orderSkillsView(view.config, ctx.workers, view.orders.get(parts[1])) satisfies A.OrderSkills);
    }
    if (parts[0] === 'plugins' && parts.length === 1) {
      const config = light(q('project')).config;
      return json(res, 200, pluginsView(config, ctx.probes.now().toISOString()) satisfies A.PluginsView);
    }
    if (parts[0] === 'config' && parts.length === 1) {
      const config = light(q('project')).config;
      const target = q('target') === 'workers' ? 'workers' : 'project';
      const file = target === 'workers' ? ctx.workers?.file : config.file;
      if (!file) throw new ApiFailure(404, 'not_found', 'No workers file was given.');
      return json(res, 200, { project: config.id, target, file, values: readEditable(file, target), editable: EDITABLE[target].map(p => p.join('.')) } satisfies A.ConfigView);
    }
    if (parts[0] === 'routing' && parts[1] === 'migrate' && parts.length === 2) {
      // The routing that would replace each file's legacy roles (nothing is written; the console sends it back as a config edit).
      const config = light(q('project')).config;
      const files: A.RoutingMigration['files'] = [];
      for (const [target, file, roles, uses] of [['project', config.file, config.roles, config.uses_routing], ['workers', ctx.workers?.file, ctx.workers?.roles, ctx.workers?.uses_routing]] as const) {
        if (!file || uses || !hasLegacyRoles(roles)) continue;
        const m = migrateRoles(roles);
        files.push({ target, file, routing: m.routing, yaml: m.yaml, notes: m.notes });
      }
      return json(res, 200, { project: config.id, files } satisfies A.RoutingMigration);
    }
    if (parts[0] === 'roles' && parts.length === 1) {
      const view = light(q('project'));
      const ledger = collectUsage(view.config, view.orders.all(), ctx.workers, ctx.probes);
      return json(res, 200, rolesView(view.config, ctx.workers, view.orders.all(), ledger.rows, viewOf(ctx.peek() ?? ctx.snapshot(), view.config.id).workers));
    }
    if (parts[0] === 'skills' && parts.length === 1) {
      const view = light(q('project'));
      return json(res, 200, skillsView(view.config, ctx.workers, view.orders) satisfies A.SkillsView);
    }
    if (parts[0] === 'files' && parts.length === 1) {
      const view = light(q('project'));
      try {
        const { file, type } = resolveReadable(view.config, view.orders, ctx.probes, q('path') ?? '', q('tag'));
        return serveFile(req, res, file, type);
      } catch (e) {
        if (e instanceof FileRefused) throw new ApiFailure(e.status, e.status === 403 ? 'forbidden' : e.status === 404 ? 'not_found' : 'bad_request', e.message);
        throw e;
      }
    }
    if (parts[0] === 'lessons' && parts.length === 1) {
      const view = light(q('project'));
      const all = readLessons(view.config.lessons, view.config);
      // which open orders would carry each lesson
      const carried = new Map<string, string[]>();
      for (const doc of view.orders.all()) {
        if (['merged', 'cancelled'].includes(view.orders.stage(doc).stage)) continue;
        for (const l of lessonsForOrder(view.config, doc, all)) (carried.get(l.id) ?? carried.set(l.id, []).get(l.id)!).push(doc.order.tag);
      }
      for (const l of all) l.orders = carried.get(l.id) ?? [];
      const tag = q('tag');
      const base = q('applies') === '1' ? all.filter(l => l.appliesToProject) : all;
      const items = tag ? lessonsFor(base, tag.split(',')) : base;
      return json(res, 200, { project: view.config.id, count: items.length, items } satisfies A.LessonList);
    }
    if (parts[0] === 'credits' && parts.length === 1) {
      const view = light(q('project'));
      const status = q('status');
      if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) throw new ApiFailure(400, 'bad_request', '"status" is pending, approved or rejected.');
      return json(res, 200, quoteList(view.config.id, view.orders, status) satisfies A.QuoteList);
    }
    if (parts[0] === 'resources' && parts.length === 1) {
      const view = light(q('project'));
      return json(res, 200, { project: view.config.id, resources: resourceViews(view.config, view.orders, ctx.probes.now()) } satisfies A.ResourceList);
    }
    if (parts[0] === 'machines' && parts[1] === 'guide' && parts.length === 2) {
      // Public keys only (*.pub), and where the registry and the SSH config live, for the add-machine guide.
      const view = light(q('project'));
      const where = machinesFile(view.config, ctx.workers?.file);
      return json(res, 200, { project: view.config.id, registry: where.file ?? null, sshConfig: path.join(ctx.ssh?.dir ?? sshDir(), 'config'), publicKeys: hostPublicKeys(ctx.ssh?.dir), platform: process.platform });
    }
    if (parts[0] === 'machines' && parts[1] === 'ssh-host' && parts.length === 2) {
      // The Host block an address change would rewrite. Only the SSH config is read, never a key file.
      light(q('project'));
      const alias = q('alias') ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias)) throw new ApiFailure(400, 'bad_request', '"alias" is an SSH alias: letters, digits, hyphens or underscores.');
      return json(res, 200, readSshHost(alias, { dir: ctx.ssh?.dir }));
    }
    if (parts[0] === 'machines' && parts[1] === 'install-plan' && parts.length === 2) {
      const view = light(q('project'));
      const plan = await refusals(() => machineInstallPlan(view.config, ctx.probes, loadMachines(view.config, ctx.workers?.file), q('id') ?? '', q('item') ?? ''));
      return json(res, 200, { plan: { ...plan, steps: plan.steps.map(s => s.label) } });
    }
    if (parts[0] === 'machines' && parts[1] === 'jobs' && parts.length === 2) {
      const view = light(q('project'));
      return json(res, 200, { project: view.config.id, jobs: machineJobs(view.config, q('id') || undefined) });
    }
    if (parts[0] === 'machines' && parts[1] === 'install-plan' && parts.length === 2) {
      const view = light(q('project'));
      const plan = await refusals(() => machineInstallPlan(view.config, ctx.probes, loadMachines(view.config, ctx.workers?.file), q('id') ?? '', q('item') ?? ''));
      return json(res, 200, { plan: { ...plan, steps: plan.steps.map(s => s.label) } });
    }
    if (parts[0] === 'machines' && parts[1] === 'jobs' && parts.length === 2) {
      const view = light(q('project'));
      return json(res, 200, { project: view.config.id, jobs: machineJobs(view.config, q('id') || undefined) });
    }
    if (parts[0] === 'machines' && parts.length === 1) {
      const view = light(q('project'));
      return json(res, 200, { project: view.config.id, machines: machinesView(view.config, loadMachines(view.config, ctx.workers?.file), ctx.probes.now()) });
    }
    if (parts[0] === 'clean' && parts.length === 1) {
      const view = light(q('project'));
      const includeIgnored = q('include_ignored') === '1' || q('include_ignored') === 'true' || q('includeIgnored') === 'true';
      return json(res, 200, planClean(view.config, view.orders, { ...systemClean(ctx.probes), sizeBudgetMs: 1500, ...(includeIgnored ? { includeIgnored: true } : {}) }) satisfies A.CleanPlan);
    }
    if (parts[0] === 'decisions' && parts.length === 1) {
      const view = light(q('project'));
      const list = decisionList(view.config, view.orders);
      const topic = q('topic');
      if (topic !== undefined) { list.items = list.items.filter(e => e.topic === topic); list.count = list.items.length; }
      const cursor = Math.floor(Math.max(0, Number(q('cursor') ?? 0) || 0));
      const limit = Math.floor(Math.min(100, Math.max(1, Number(q('limit') ?? 20) || 20)));
      const page: A.DecisionEntry[] = [];
      let bytes = Buffer.byteLength(JSON.stringify({ ...list, items: [] }));
      for (const entry of list.items.slice(cursor, cursor + limit)) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (page.length && bytes + size > 48_000) break;
        page.push(entry); bytes += size;
      }
      if (cursor + page.length < list.items.length) list.nextCursor = String(cursor + page.length);
      list.items = page;
      return json(res, 200, list satisfies A.DecisionList);
    }
    if (parts[0] === 'workers' && parts.length === 1) {
      const snap = ctx.snapshot();
      const only = q('project') ? viewOf(snap, q('project')) : undefined;
      const workers = workerViews(snap, env(), only);
      const readings = (only ? [only] : snap.projects).flatMap(v => v.quotas ?? []);
      const sources = [...new Set(readings.map(r => r.source))].map(source => ({ source, latest: quotaPoint(readings.find(r => r.source === source)!) }));
      return json(res, 200, { workers, sources } satisfies A.WorkerList);
    }
    if (parts[0] === 'quota' && parts[1] === 'history' && parts.length === 2) {
      const view = light(q('project'));
      const worker = q('worker');
      let source = q('source');
      if (worker) {
        const config = ctx.workers?.workers.find(w => w.id === worker);
        if (!config) throw new ApiFailure(404, 'not_found', `No worker "${worker}".`);
        source = config.quota;
        if (!source) return json(res, 200, { worker, points: [] } satisfies A.QuotaHistory);
      }
      const limit = Math.floor(Math.min(5000, Math.max(1, Number(q('limit') ?? 500) || 500)));
      const points = readQuotaHistory(view.config, { ...(source ? { source } : {}), limit }).map(quotaPoint);
      return json(res, 200, { ...(worker ? { worker } : {}), ...(source ? { source } : {}), points } satisfies A.QuotaHistory);
    }
    if (parts[0] === 'events' && parts.length === 1) {
      const view = light(q('project'));
      const tag = q('tag')?.toLowerCase();
      const after = Number(q('after') ?? 0) || 0;
      const limit = Math.min(1000, Math.max(1, Number(q('limit') ?? 200) || 200));
      const events = view.orders.store instanceof SqliteStore ? view.orders.store.eventRows({ tag, after, limit }) : numberedEvents(view.orders.store.events()).filter(e => e.id > after && (!tag || e.tag.toLowerCase() === tag)).slice(-limit);
      return json(res, 200, { events });
    }
    if (parts[0] === 'stream' && parts.length === 1) {
      const view = light(q('project'));
      const parseRunSubs = (raw: string | undefined) => (raw ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => { const [key, offset] = s.split('@'); return { key, ...(offset !== undefined && /^\d+$/.test(offset) ? { offset: Number(offset) } : {}) }; });
      const logs = parseRunSubs(q('logs'));
      const transcripts = parseRunSubs(q('transcripts'));
      const last = req.headers['last-event-id'];
      ctx.hub.connect(req, res, view.config.id, logs, (Array.isArray(last) ? last[0] : last) ?? q('lastEventId'), transcripts);
      return;
    }
    if (libraryGet({ view: () => light(q('project')), workers: ctx.workers, now: ctx.probes.now(), parts, q, reply: (status, body) => json(res, status, body), serve: (file, type) => serveFile(req, res, file, type) })) return;
    if (parts[0] === 'docs' && (parts.length === 1 || (parts.length === 2 && (parts[1] === 'file' || parts[1] === 'search')))) {
      const view = light(q('project'));
      try {
        if (parts.length === 1) return json(res, 200, listDocuments(view.config) satisfies A.DocList);
        if (parts[1] === 'file') return json(res, 200, readDocument(view.config, q('path') ?? '') satisfies A.DocFile);
        const limit = Math.min(100, Math.max(1, Number(q('limit') ?? 30) || 30));
        return json(res, 200, searchDocuments(view.config, q('q') ?? '', limit) satisfies A.DocSearch);
      } catch (e) {
        if (e instanceof DocsError) throw new ApiFailure(e.status, e.status === 403 ? 'forbidden' : e.status === 404 ? 'not_found' : 'bad_request', e.message);
        throw e;
      }
    }
    throw new ApiFailure(404, 'not_found', `No such call: GET ${url.pathname}`);
  }

  if (method === 'POST') {
    if (parts[0] === 'plugins' && parts[1] === 'doctor' && parts.length === 2) {
      // Starts the tools' MCP servers and lists their tools (never calls one). Everything it waits on is a child process, so this
      // thread keeps answering meanwhile; the same check asked again while one runs shares it instead of starting the servers twice.
      needsWrite();
      const body = await readJson(req), view = light(str(body, 'project') ?? q('project'));
      const ids = strList(body, 'ids');
      const key = `${view.config.id}\0${[...new Set(ids ?? [])].sort().join(',')}`;
      const running = doctorRuns.get(key) ?? doctorProject(view.config, ids).finally(() => doctorRuns.delete(key));
      doctorRuns.set(key, running);
      const results = await running;
      return json(res, 200, { project: view.config.id, at: ctx.probes.now().toISOString(), ok: results.every(r => r.ok), results } satisfies A.PluginDoctor);
    }
    if (parts[0] === 'design-docs' && parts.length === 1) {
      needsWrite(); const body = await readJson(req), view = light(str(body, 'project') ?? q('project'));
      const id = str(body, 'id', true)!, title = str(body, 'title'), markdown = str(body, 'body', true)!;
      const doc = saveDesignDoc(view.config, { id, title, body: markdown, author: 'web' }); ctx.invalidate(); return json(res, 201, doc);
    }
    if (parts[0] === 'intake' && parts[2] === 'review' && parts.length === 3) {
      needsWrite(); const body = await readJson(req), view = light(str(body, 'project') ?? q('project')), tag = view.orders.get(parts[1]).order.tag;
      const events = reviewIntakeSystems(view.config, view.orders, tag, { accept: strList(body, 'accept'), reject: strList(body, 'reject'), drop: strList(body, 'drop'), note: str(body, 'note') });
      ctx.invalidate(); return json(res, 200, { project: view.config.id, tag, events });
    }
    if (parts[0] === 'orders' && parts[2] === 'first-pass-wrong' && parts.length === 3) {
      needsWrite();
      const body = await readJson(req), view = light(str(body, 'project') ?? q('project'));
      const note = str(body, 'note');
      try {
        const result = disputeFirstPass(view.orders, parts[1], note);
        ctx.invalidate();
        return json(res, 200, { ok: true, ...result } satisfies A.FirstPassDisputeResult);
      } catch (e) {
        if (e instanceof UserError && /has no applied first-pass bounce|was already disputed/.test(e.english)) {
          throw new ApiFailure(409, 'conflict', e.message);
        }
        throw e;
      }
    }
    if (parts[0] === 'machines' && parts.length >= 2) {
      needsWrite();
      const body = await readJson(req), view = light(str(body, 'project') ?? q('project'));
      const registry = () => {
        const where = machinesFile(view.config, ctx.workers?.file);
        if (!where.file) throw new ApiFailure(409, 'conflict', 'No place for the machine registry: set ALBA_MACHINES, "machines:" in the project file, or a workers file.');
        return where.file;
      };
      if (parts[1] === 'ssh-block' && parts.length === 2) {
        const input = { alias: str(body, 'alias', true)!, hostname: str(body, 'hostname', true)!, user: str(body, 'user', true)!, identity_file: str(body, 'identity_file') || undefined, port: typeof body.port === 'number' ? body.port : undefined };
        if (body.write !== true) return json(res, 200, { block: sshHostBlock(input), written: false });
        const out = appendSshHost(input, { now: ctx.probes.now(), dir: ctx.ssh?.dir });
        view.orders.record('*', 'machines.ssh-config', { alias: input.alias, ...(out.backup ? { backup: out.backup } : {}) });
        return json(res, 200, { block: out.block, written: true, file: out.file, ...(out.backup ? { backup: out.backup } : {}) });
      }
      if (parts[1] === 'test' && parts.length === 2) {
        const candidate = validateMachine({ services: [], ...(typeof body.machine === 'object' && body.machine ? body.machine as Record<string, unknown> : {}), id: 'candidate', name: 'candidate' });
        const connection = 'ssh' in candidate.connect ? await (ctx.ssh?.test ?? testSsh)(candidate.connect.ssh) : { ok: true, category: 'ok' as const, seconds: 0 };
        const probed = connection.ok ? await probeCandidate({ ...candidate, ...(candidate.engine || view.config.engine ? { engine: candidate.engine ?? view.config.engine } : {}) }, ctx.probes) : undefined;
        return json(res, 200, { connection, ...(probed ?? {}) });
      }
      if (parts[1] === 'add' && parts.length === 2) {
        const file = registry();
        const out = addMachine(file, body.machine, { dryRun: body.dryRun === true, now: ctx.probes.now() });
        if (!out.dryRun) {
          view.orders.record('*', 'machines.added', { id: out.machine.id, ...(out.backup ? { backup: out.backup } : {}) });
          void probeMachines(view.config, ctx.probes, { force: true, id: out.machine.id, workersFile: ctx.workers?.file }).catch(() => undefined);
          ctx.invalidate();
        }
        return json(res, out.dryRun ? 200 : 201, { id: out.machine.id, file, dryRun: out.dryRun, ...(out.backup ? { backup: out.backup } : {}) });
      }
      if (parts[1] === 'edit' && parts.length === 2) {
        // Fields of the registry entry and, for an SSH machine, the address of its alias in the SSH config. Both are checked
        // (a dry run of each) before either is written; then the connection is tested and the machine probed.
        const id = str(body, 'id', true)!, file = registry(), dryRun = body.dryRun === true, now = ctx.probes.now();
        const ops = body.set === undefined ? [] : machineOpsFromSet(body.set);
        const ssh = body.ssh === undefined ? undefined : sshChange(body.ssh);
        if (!ops.length && !ssh) throw new ApiFailure(400, 'bad_request', 'Nothing to change: give "set" and/or "ssh".');
        const current = loadMachines(view.config, ctx.workers?.file).machines.find(m => m.id === id);
        if (!current) throw new ApiFailure(409, 'conflict', `No machine "${id}".`);
        const planned = ops.length ? editMachine(file, id, ops, { dryRun: true, now }) : undefined;
        const machine = planned?.machine ?? current;
        const alias = 'ssh' in machine.connect ? machine.connect.ssh : undefined;
        if (ssh && !alias) throw new ApiFailure(400, 'bad_request', `${id} is this computer (connect: local); it has no SSH address to change.`, [{ field: 'ssh', message: 'This machine is not reached over SSH.' }]);
        const sshPlan = ssh ? editSshHost(alias!, ssh, { dir: ctx.ssh?.dir, dryRun: true, now }) : undefined;
        if (dryRun) return json(res, 200, { id, file, dryRun: true, changed: planned?.changed ?? [], ...(sshPlan ? { ssh: sshPlan } : {}) });
        const written = ops.length ? editMachine(file, id, ops, { now }) : undefined;
        if (written?.changed.length) view.orders.record('*', 'machines.edited', { id, changed: written.changed, ...(written.backup ? { backup: written.backup } : {}) });
        const sshOut = ssh ? editSshHost(alias!, ssh, { dir: ctx.ssh?.dir, now }) : undefined;
        if (sshOut?.changed.length) view.orders.record('*', 'machines.ssh-config', { alias: alias!, changed: sshOut.changed, ...(sshOut.backup ? { backup: sshOut.backup } : {}) });
        ctx.invalidate();
        // A new address or a new way to connect is tested at once, like a new machine; anything else is probed in the background.
        const reconnect = !!sshOut?.changed.length || written?.changed.some(c => c === 'os' || c === 'connect' || c.startsWith('connect.'));
        let connection: import('../machines/edit.ts').ConnectionTest | undefined, views: import('../machines/probe.ts').MachineView[] | undefined;
        if (reconnect && body.test !== false) {
          connection = alias ? await (ctx.ssh?.test ?? testSsh)(alias) : { ok: true, category: 'ok', seconds: 0 };
          if (connection.ok) views = await probeMachines(view.config, ctx.probes, { force: true, id, workersFile: ctx.workers?.file }).catch(() => undefined);
          ctx.invalidate();
        } else if (written?.changed.length) void probeMachines(view.config, ctx.probes, { force: true, id, workersFile: ctx.workers?.file }).catch(() => undefined);
        return json(res, 200, { id, file, dryRun: false, changed: written?.changed ?? [], ...(written?.backup ? { backup: written.backup } : {}), ...(sshOut ? { ssh: sshOut } : {}),
          ...(connection ? { connection } : {}), ...(views ? { machine: views.find(v => v.id === id) } : {}) });
      }
      if (parts[1] === 'remove' && parts.length === 2) {
        const id = str(body, 'id', true)!, file = registry();
        const out = removeMachine(file, id, { now: ctx.probes.now() });
        view.orders.record('*', 'machines.removed', { id, ...(out.backup ? { backup: out.backup } : {}) });
        ctx.invalidate();
        return json(res, 200, { id, file, ...(out.backup ? { backup: out.backup } : {}) });
      }
      if (parts[1] === 'roles' && parts.length === 2) {
        const id = str(body, 'id', true)!, file = registry();
        const out = setMachineRoles(file, id, body.roles, { now: ctx.probes.now() });
        view.orders.record('*', 'machines.roles', { id, roles: body.roles as string[], ...(out.backup ? { backup: out.backup } : {}) });
        ctx.invalidate();
        return json(res, 200, { id, roles: body.roles });
      }
      if (parts[1] === 'install' && parts.length === 2) {
        const id = str(body, 'id', true)!, item = str(body, 'item', true)!;
        const job = await refusals(() => startInstall(view.config, ctx.probes, loadMachines(view.config, ctx.workers?.file), id, item));
        view.orders.record('*', 'machines.install', { id, item, job: job.id });
        ctx.invalidate();
        return json(res, 202, { job });
      }
      if (parts[1] === 'jobs' && parts[2] === 'cancel' && parts.length === 3) {
        const job = await refusals(async () => cancelJob(view.config, str(body, 'job', true)!, ctx.probes.now()));
        view.orders.record('*', 'machines.job-cancelled', { id: job.machine, job: job.id });
        ctx.invalidate();
        return json(res, 200, { job });
      }
      if (parts[1] === 'check' && parts.length === 2) {
        const id = str(body, 'id');
        const views = await probeMachines(view.config, ctx.probes, { force: true, ...(id ? { id } : {}), workersFile: ctx.workers?.file });
        ctx.invalidate();
        return json(res, 200, { project: view.config.id, machines: views });
      }
    }
    if (parts[0] === 'gates' && parts[1] === 'cancel' && parts.length === 2) {
      needsWrite();
      const body = await readJson(req), view = light(str(body, 'project') ?? q('project'));
      const result = cancelNightlyRuns(view.config, view.orders);
      ctx.invalidate();
      return json(res, result.reason ? 409 : 200, result);
    }
    if (parts[0] === 'design' && parts[1] === 'measure' && parts.length === 2) {
      needsWrite();
      const body = await readJson(req), view = light(str(body, 'project') ?? q('project'));
      if (!Array.isArray(body.targets) || !body.targets.length || body.targets.some(t => typeof t !== 'string')) throw new ApiFailure(400, 'bad_request', 'targets must be a nonempty string list.');
      const result = await runMeasurements(view.config, view.orders, { targets: body.targets as string[], freeRamGb: () => ctx.probes.freeRamGb(), ordersFirst: () => ctx.workers
        ? tick(view.config, view.orders, ctx.workers, { ...ctx.slow, freeRamGb: () => ctx.probes.freeRamGb() }, { record: false }).report.moves.some(m => m.mode !== 'card')
        : view.orders.all().some(d => view.orders.stage(d).stage === 'queued') });
      ctx.invalidate();
      return json(res, 200, result);
    }
    if (parts[0] === 'design' && parts[1] === 'changesets' && parts.length === 2) {
      needsWrite();
      const body = await readJson(req), view = light(str(body, 'project') ?? q('project'));
      if (!view.config.design?.enabled) return json(res, 200, { enabled: false, note: DESIGN_OFF });
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new ApiFailure(400, 'bad_request', 'dryRun must be boolean.');
      const { project: _project, dryRun: _dryRun, ...inline } = body;
      const result = applyChangeSet(view.config, view.orders, body.changeset ?? inline, { dryRun: body.dryRun === true, by: 'web' });
      if (result.applied) ctx.invalidate();
      return json(res, 200, result);
    }
    needsWrite();
    const body = await readJson(req);
    const view = light(str(body, 'project'));
    const runCtx = (): RunContext => {
      if (!ctx.workers) throw new ApiFailure(400, 'bad_request', 'No workers file was given, so nothing can be started.');
      return { project: view.config, orders: view.orders, workers: ctx.workers, probes: ctx.probes };
    };
    const done = <T>(status: number, value: T): void => { ctx.invalidate(); json(res, status, value); };
    if (parts[0] === 'seen' && parts.length === 1) {
      const tags = strList(body, 'tags');
      const docs = tags ? [...new Set(tags)].map(tag => view.orders.get(tag)) : view.orders.all();
      saveAttentionMarks(view.orders.store, docs.flatMap(doc => {
        const point = attentionState(doc).attention;
        return point ? [{ tag: doc.order.tag, seen_at: point.at }] : [];
      }));
      ctx.hub.publish(view.config.id, 'attention.changed', { project: view.config.id });
      return done(200, { ok: true });
    }
    if (parts[0] === 'orders' && parts.length === 3 && (parts[2] === 'seen' || parts[2] === 'mute')) {
      const tag = view.orders.get(parts[1]).order.tag;
      if (parts[2] === 'mute') {
        if (typeof body.muted !== 'boolean') throw new ApiFailure(400, 'bad_request', t('"muted" must be boolean.'));
        saveAttentionMarks(view.orders.store, [{ tag, muted: body.muted }]);
      } else {
        const at = str(body, 'at', true)!;
        if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(at) || !Number.isFinite(Date.parse(at))) throw new ApiFailure(400, 'bad_request', t('"at" must be a timestamp with a timezone.'));
        saveAttentionMarks(view.orders.store, [{ tag, seen_at: new Date(at).toISOString() }]);
      }
      ctx.hub.publish(view.config.id, 'attention.changed', { project: view.config.id, tag });
      return done(200, { ok: true });
    }
    const producerEnv = () => {
      const file = process.env.ALBA_WORKERS ?? view.config.workers;
      const workers = ctx.workers ?? (file ? loadWorkers(file) : undefined);
      return workers ? { probes: ctx.probes, workers } : undefined;
    };

    if (parts[0] === 'orders' && parts[2] === 'draft-again' && parts.length === 3) {
      const tag = view.orders.get(parts[1]).order.tag;
      const brief = body.brief === undefined ? '' : body.brief;
      if (typeof brief !== 'string') throw new ApiFailure(400, 'bad_request', '"brief" must be text.');
      let work;
      try { work = draftAgain(view.config, view.orders, tag, brief, ctx.probes); } catch (e) { throw new ApiFailure(409, 'conflict', (e as Error).message); }
      view.orders.store.appendEvent({ at: ctx.probes.now().toISOString(), tag, type: 'producer-draft-again', data: { work: work.id, status: work.status } });
      return done(200, { ...draftWorkView(view.config, tag), work: { id: work.id, status: work.status, reason: work.reason, started: work.started, ended: work.ended } } satisfies A.DraftAgainResult);
    }
    if (parts[0] === 'producer' && parts[1] === 'config' && parts.length === 2) {
      const yaml = body.yaml;
      if (typeof yaml !== 'string') throw new ApiFailure(400, 'bad_request', '"yaml" must be the text of the producer section.');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new ApiFailure(400, 'bad_request', '"dryRun" must be true or false.');
      const result = editProducerConfig(view.config.file, yaml, { dryRun: body.dryRun === true, now: ctx.probes.now() });
      if (result.changed && !result.dryRun) view.orders.store.appendEvent({ at: ctx.probes.now().toISOString(), tag: '_producer', type: 'producer-config-edited', data: { file: result.file, backup: result.backup, lines: result.diff.filter(d => d.op !== ' ').length } });
      return done(200, result satisfies A.ProducerConfigEdit);
    }
    if (parts[0] === 'producer' && parts[1] === 'session' && parts.length === 3 && (parts[2] === 'start' || parts[2] === 'stop')) {
      if (!ctx.sessionControl) throw new ApiFailure(409, 'conflict', 'Producer session control requires alba serve.');
      return done(200, await ctx.sessionControl(view.config, parts[2]));
    }

    if (parts[0] === 'producer' && parts[1] === 'chat' && parts.length === 2) {
      return done(202, postDirectorMessage(view.config, str(body, 'text', true)!));
    }
    if (parts[0] === 'producer' && parts[1] === 'chat' && parts[2] === 'stop') {
      await producerSession(view.config, view.orders).cancelChat();
      return done(200, { ok: true });
    }
    if (parts[0] === 'producer' && parts[1] === 'direction' && parts.length === 2) {
      const proposal = decideDirection(view.config, str(body, 'proposalId', true)!, body.accept === true, str(body, 'reason'));
      view.orders.store.appendEvent({ at: ctx.probes.now().toISOString(), tag: '_producer', type: 'producer-direction-decision', data: { messageId: proposal.messageId, proposalId: proposal.id, status: proposal.status } });
      return done(200, proposal);
    }
    if (parts[0] === 'producer' && parts[1] === 'actions' && parts.length === 2) {
      const existing = str(body, 'actionId');
      if (existing) {
        const edit = body.edit;
        if (edit !== undefined && (!edit || typeof edit !== 'object' || Array.isArray(edit) || typeof (edit as { note?: unknown }).note !== 'string' || Object.keys(edit).some(k => k !== 'note'))) throw new ApiFailure(400, 'bad_request', 'edit must contain only a string note.');
        const note = str(body, 'note');
        const editedNote = (edit as { note: string } | undefined) ?? (note === undefined ? undefined : { note });
        const action = body.reject === true ? rejectProducerAction(view.config, existing, str(body, 'reason')) : runProducerAction(view.config, view.orders, existing, editedNote, producerEnv());
        view.orders.store.appendEvent({ at: ctx.probes.now().toISOString(), tag: '_producer', type: 'producer-chat-action-decision', data: { messageId: action.messageId, actionId: action.id, status: action.status } });
        return done(200, action);
      }
      const caseId = str(body, 'case', true)!;
      const kind = str(body, 'kind', true)!;
      const evidence = Array.isArray(body.evidence) ? body.evidence.filter((v): v is string => typeof v === 'string').slice(0, 20) : undefined;
      const action = producerAct(view.config, view.orders, caseId, kind, { target: str(body, 'target'), worker: str(body, 'worker'), note: str(body, 'note'), reason: str(body, 'reason'), evidence, now: ctx.probes.now() }, producerEnv());
      return done(200, action);
    }
    if (parts[0] === 'producer' && (parts[1] === 'pause' || parts[1] === 'resume') && parts.length === 2) {
      const paused = parts[1] === 'pause';
      setProducerPaused(view.config, paused, ctx.probes.now());
      return done(200, { ok: true, paused });
    }

    if (parts[0] === 'orders' && parts[1] === 'plan' && parts.length === 2) {
      const doc = planOrder(view.config, view.orders, { tag: str(body, 'tag', true)!, title: str(body, 'title', true)!, kind: str(body, 'kind', true)!, needs: strList(body, 'needs') ?? [], intent: str(body, 'intent', true)!, role: str(body, 'role') });
      return done(201, doc);
    }
    if (parts[0] === 'orders' && parts[2] === 'fields' && parts.length === 3) {
      // Any field of an order after it is made (src/orders/edit-fields.ts); null clears one.
      const fields: Record<string, unknown> = {};
      for (const key of ORDER_FIELD_NAMES) if (body[key] !== undefined) fields[key] = body[key];
      if (!Object.keys(fields).length) throw new ApiFailure(400, 'bad_request', describeFields());
      for (const key of ['title', 'kind', 'role', 'intent'] as const) if (fields[key] !== undefined && typeof fields[key] !== 'string') throw new ApiFailure(400, 'bad_request', `"${key}" must be text.`);
      for (const key of ['worker', 'model', 'heavy', 'condition'] as const) if (fields[key] !== undefined && fields[key] !== null && typeof fields[key] !== 'string') throw new ApiFailure(400, 'bad_request', `"${key}" must be text or null.`);
      for (const key of ['needs', 'tags', 'skills', 'uses', 'tools'] as const) if (fields[key] !== undefined && !(Array.isArray(fields[key]) && (fields[key] as unknown[]).every(x => typeof x === 'string'))) throw new ApiFailure(400, 'bad_request', `"${key}" must be a list of text.`);
      if (fields.sparse !== undefined && fields.sparse !== null && !(Array.isArray(fields.sparse) && (fields.sparse as unknown[]).every(x => typeof x === 'string'))) throw new ApiFailure(400, 'bad_request', '"sparse" must be a list of relative directory paths or null.');
      if (fields.priority !== undefined && fields.priority !== null && !Number.isInteger(fields.priority)) throw new ApiFailure(400, 'bad_request', '"priority" must be a whole number or null.');
      if (fields.check !== undefined && fields.check !== 'independent' && fields.check !== 'none') throw new ApiFailure(400, 'bad_request', '"check" is independent or none.');
      if (fields.review !== undefined && fields.review !== 'manual' && fields.review !== 'auto') throw new ApiFailure(400, 'bad_request', '"review" is manual or auto.');
      const doc = editOrderFields(view.config, view.orders, ctx.workers, parts[1], fields as OrderFields);
      return done<A.OrderSummary>(200, summaryOf(view.config, doc, view.orders.stage(doc), env(), undefined, undefined, attentionFor(view.orders.store)(doc.order.tag)));
    }
    if (parts[0] === 'orders' && parts[2] === 'body' && parts.length === 3) {
      const text = str(body, 'text', true)!;
      const expected = body.expected === undefined ? undefined : str(body, 'expected', true)!;
      const file = editOrderBody(view.config, view.orders, parts[1], text, expected);
      return done(200, { ok: true, file });
    }
    if (parts[0] === 'orders' && parts[2] === 'plan' && parts.length === 3) {
      const patch: Parameters<typeof editPlan>[2] = {};
      for (const key of ['title', 'kind', 'intent', 'role'] as const) if (body[key] !== undefined) patch[key] = str(body, key, key !== 'role') ?? '';
      if (body.needs !== undefined) patch.needs = strList(body, 'needs')!;
      return done(200, editPlan(view.orders, parts[1], patch));
    }
    if (parts[0] === 'orders' && parts[2] === 'draft' && parts.length === 3) {
      const id = str(body, 'actionId', true)!;
      if (!['save', 'accept', 'reject'].includes(String(body.decision))) throw new ApiFailure(400, 'bad_request', 'decision must be save, accept or reject.');
      const action = producerState(view.config).actions.find(a => a.id === id);
      if (action?.kind !== 'draft-order' || action.target !== parts[1]) throw new ApiFailure(400, 'bad_request', 'The action does not belong to this planned order.');
      if (body.body !== undefined) editDraftAction(view.config, view.orders, id, str(body, 'body', true)!);
      return done(200, body.decision === 'reject' ? rejectProducerAction(view.config, id) : body.decision === 'accept' ? runProducerAction(view.config, view.orders, id) : producerState(view.config).actions.find(a => a.id === id));
    }
    if (parts[0] === 'orders' && parts.length === 1) {
      const tag = str(body, 'tag', true)!;
      const title = str(body, 'title', true)!;
      const mandate = body.mandate;
      if (mandate !== undefined && (typeof mandate !== 'object' || mandate === null || Array.isArray(mandate))) throw new ApiFailure(400, 'bad_request', '"mandate" must be an object.');
      const role = str(body, 'role');
      if (role) resolveRole(effectiveRoles(view.config, ctx.workers), { role, kind: str(body, 'kind') ?? '' });
      const sparse = body.sparse === undefined ? undefined : strList(body, 'sparse');
      const made = createOrder(view.config, view.orders, { tag, title, kind: str(body, 'kind'), role, needs: strList(body, 'needs'), worker: str(body, 'worker'), model: str(body, 'model'), heavy: str(body, 'heavy'), base_ref: str(body, 'base_ref'), ...(sparse !== undefined ? { sparse } : {}), tags: strList(body, 'tags'), skills: strList(body, 'skills'), mandate: mandate as never, body: str(body, 'body'), slug: str(body, 'slug'), queue: body.queue === true }, ctx.probes.now());
      const stage = view.orders.stage(made.doc);
      return done<A.NewOrderResult>(201, { order: summaryOf(view.config, made.doc, stage, env()), ...(made.file ? { file: made.file } : {}), tableRow: made.tableRow, ...(made.tableWarning ? { tableWarning: made.tableWarning } : {}), ...(made.foundationWarning ? { foundationWarning: made.foundationWarning } : {}) });
    }

    if (parts[0] === 'workers' && parts.length === 1) {
      const file = workersFile();
      const id = str(body, 'id', true)!;
      const set = body.set;
      if (set !== undefined && (typeof set !== 'object' || set === null || Array.isArray(set))) throw new ApiFailure(400, 'bad_request', '"set" must be an object.');
      const out = addWorker(file, { id, copyFrom: str(body, 'copyFrom'), set: set as Record<string, unknown> | undefined, yaml: str(body, 'yaml') }, { dryRun: body.dryRun === true, now: ctx.probes.now() });
      return workerWritten(view, id, out, file, out.dryRun ? 200 : 201);
    }

    if (parts[0] === 'workers' && parts[2] === 'remove' && parts.length === 3) {
      const file = workersFile();
      const id = parts[1];
      const busy: string[] = [];
      for (const project of ctx.projects) {
        const orders = light(project.id).orders;
        for (const doc of orders.all()) {
          if (doc.runs.some(r => r.ended === undefined && r.worker === id)) busy.push(`${project.id}/${doc.order.tag} runs on it`);
          else if ((doc.order.worker === id || doc.order.next_worker === id) && !['merged', 'cancelled'].includes(orders.stage(doc).stage)) busy.push(`${project.id}/${doc.order.tag} is pinned to it`);
        }
        for (const [route, role] of Object.entries(effectiveRoles(project, ctx.workers))) if (role.workers?.prefer?.includes(id) || role.workers?.only?.includes(id)) busy.push(`route ${project.id}/${route} names it`);
      }
      const out = removeWorker(file, id, [...new Set(busy)], { dryRun: body.dryRun === true, now: ctx.probes.now() });
      if (!out.dryRun && out.changed.length) { recordWorkerEdit(view.orders, id, out, file); ctx.workers = loadWorkers(file); }
      return done<A.WorkerEditResult>(200, { ok: true, id, changed: out.changed, file, ...(out.backup ? { backup: out.backup } : {}), dryRun: out.dryRun });
    }
    if (parts[0] === 'config' && parts.length === 1) {
      // Settings, routes and worker groups of the project file or the shared workers file (src/config-edit.ts).
      const target = body.target === 'workers' ? 'workers' : body.target === undefined || body.target === 'project' ? 'project' : undefined;
      if (!target) throw new ApiFailure(400, 'bad_request', '"target" is "project" or "workers".');
      if (!Array.isArray(body.edits)) throw new ApiFailure(400, 'bad_request', '"edits" must be a list of { path, value }.');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new ApiFailure(400, 'bad_request', '"dryRun" must be true or false.');
      const file = target === 'workers' ? workersFile() : view.config.file;
      const users = target === 'workers' ? ctx.projects : [];   // every project here shares the one workers file
      const out = editConfig(file, target, body.edits as ConfigEdit[], { workers: ctx.workers, projects: users }, { dryRun: body.dryRun === true, now: ctx.probes.now() });
      if (!out.dryRun && out.changed.length) {
        view.orders.record('*', 'config.edited', { target, file, fields: out.changed, ...(out.backup ? { backup: out.backup } : {}) });
        if (target === 'workers') ctx.workers = loadWorkers(file);
        else { const at = ctx.projects.indexOf(view.config); if (at >= 0) ctx.projects[at] = loadProject(file); }
      }
      return done<A.ConfigEditResult>(200, { ok: true, file, changed: out.changed, ...(out.backup ? { backup: out.backup } : {}), ...(out.dryRun ? { dryRun: true } : {}) });
    }
    if (parts[0] === 'skills' && parts[1] === 'use' && parts.length === 2) {
      const name = str(body, 'name', true)!;
      if (typeof body.use !== 'boolean') throw new ApiFailure(400, 'bad_request', '"use" must be true or false.');
      const skill = readRegistry(ctx.workers?.skills, view.config).skills.find(s => s.name === name);
      if (!skill) throw new ApiFailure(404, 'not_found', `No skill "${name}".`);
      const file = view.config.file;
      const out = setSkillUse(file, skill, body.use, view.config, { dryRun: body.dryRun === true, now: ctx.probes.now() });
      if (!out.dryRun && out.changed.length) {
        view.orders.record('*', 'skills.edited', { skill: name, use: body.use, fields: out.changed, file, ...(out.backup ? { backup: out.backup } : {}) });
        const at = ctx.projects.indexOf(view.config);
        if (at >= 0) ctx.projects[at] = loadProject(file);
      }
      return done<A.ConfigEditResult>(200, { ok: true, file, changed: out.changed, ...(out.backup ? { backup: out.backup } : {}) });
    }

    if (parts[0] === 'orders' && parts[2] === 'role' && parts.length === 3) {
      const doc = view.orders.get(parts[1]);
      const role = str(body, 'role') ?? '';
      if (role) resolveRole(effectiveRoles(view.config, ctx.workers), { role, kind: doc.order.kind });
      view.orders.update(doc.order.tag, { role });
      ctx.invalidate();
      return json(res, 200, routeOf(view.config.id, doc.order.tag) satisfies A.Route);
    }

    if (parts[0] === 'orders' && parts[2] === 'classify' && parts.length === 3) {
      const tag = view.orders.get(parts[1]).order.tag;
      await classifyOrders({ project: view.config, orders: view.orders, workers: ctx.workers ?? { workers: [], quota_sources: {}, file: '' }, probes: ctx.probes }, { tags: [tag], model: body.model === true });
      ctx.invalidate();
      return json(res, 200, routeOf(view.config.id, tag) satisfies A.Route);
    }

    if (parts[0] === 'orders' && parts[2] === 'verify' && parts.length === 3) {
      const tag = view.orders.get(parts[1]).order.tag;
      const report = verifyOrder(view.config, view.orders, tag, { manual: true });
      ctx.invalidate();
      return done<A.VerifyResult>(200, report);
    }

    if (parts[0] === 'orders' && parts[2] === 'actions' && parts.length === 3) {
      const action = str(body, 'action', true)!;
      if (!(ORDER_ACTIONS as readonly string[]).includes(action)) throw new ApiFailure(400, 'bad_request', `Unknown action "${action}". Actions: ${ORDER_ACTIONS.join(', ')}.`);
      const tag = view.orders.get(parts[1]).order.tag;
      const note = str(body, 'note')?.trim() || undefined;
      let message: string | undefined;
      let run: A.ActionResult['run'];
      switch (action as A.OrderAction) {
        case 'approve': {
          const now = view.orders.stage(view.orders.get(tag)).stage;
          const override = body.override === true;
          if (body.override !== undefined && typeof body.override !== 'boolean') throw new ApiFailure(400, 'bad_request', '"override" must be true or false.');
          if (now !== 'awaiting-review' && !(override && ['failed', 'blocked', 'idle'].includes(now))) throw new ApiFailure(409, 'conflict', t('only an order that is awaiting review can be approved here (this one is {stage}); failed, blocked or idle orders need --override and a note of at least 10 characters.', { stage: now }));
          const r = approve(view.config, view.orders, tag, note, str(body, 'branch')?.trim() || undefined, override);
          message = t('Merged. Wrote {file} (branch is in the base branch; accept: {accept})', { file: r.acceptFile, accept: r.accept });
          break;
        }
        case 'queue': case 'hold': case 'release': case 'cancel': case 'rework': case 'stop':
          humanAction(view.config, view.orders, tag, action as 'queue', note);
          break;
        case 'close': {
          const how = str(body, 'how', true)!;
          if (how !== 'merged-elsewhere' && how !== 'done-by-lead') throw new ApiFailure(400, 'bad_request', '"how" must be "merged-elsewhere" or "done-by-lead".');
          const commit = str(body, 'commit', how === 'merged-elsewhere')?.trim() || undefined;
          if (how === 'merged-elsewhere' && !commit) throw new ApiFailure(400, 'bad_request', '"commit" is required for merged-elsewhere.');
          try {
            closeOrder(view.config, view.orders, tag, { how, commit, note });
          } catch (e) {
            if (e instanceof UserError) throw new ApiFailure(409, 'conflict', e.message);
            throw e;
          }
          break;
        }
        case 'answer': {
          const text = str(body, 'text', body.choice === undefined);
          const choice = body.choice === undefined ? undefined : Number(body.choice);
          if (choice !== undefined && !Number.isInteger(choice)) throw new ApiFailure(400, 'bad_request', '"choice" must be a whole number (the option, from 1).');
          const r = answerOrder(runCtx(), tag, text, { worker: str(body, 'worker'), choice, who: str(body, 'who') });
          message = r.message;
          if (r.started?.run) run = { id: r.started.run, key: `${tag}:${r.started.run}`, worker: r.started.worker, ...(r.started.pid ? { pid: r.started.pid } : {}), resumed: !!r.started.resumed };
          break;
        }
        case 'run': {
          const c = runCtx();
          const explicitWorker = str(body, 'worker');
          const want = explicitWorker ?? c.orders.get(tag).order.next_worker ?? ctx.snapshot().projects.find(p => p.config.id === view.config.id)?.tick?.moves.find(m => m.tag === tag)?.worker;
          if (!want) throw new ApiFailure(400, 'bad_request', `No worker was named and the tick has none for ${tag}: pass "worker".`);
          const r = startRun(c, tag, want, { explicitWorker: explicitWorker !== undefined, overCap: body.over_cap === true });
          if (r.mode === 'card') message = r.text;
          else {
            message = t('Started run {run} on {worker}.', { run: r.run ?? '-', worker: r.worker });
            run = { id: r.run ?? '', key: `${tag}:${r.run}`, worker: r.worker, ...(r.pid ? { pid: r.pid } : {}), resumed: !!r.resumed };
          }
          break;
        }
      }
      const after = view.orders.stage(view.orders.get(tag));
      return done<A.ActionResult>(200, { ok: true, tag, stage: after.stage, why: after.why, ...(message ? { message } : {}), ...(run ? { run } : {}) });
    }

    if (parts[0] === 'say' && parts.length === 1) {
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new ApiFailure(400, 'bad_request', '"dryRun" must be true or false.');
      if (body.restart !== undefined) throw new ApiFailure(400, 'bad_request', 'Group messages do not support restart.');
      const group = str(body, 'group', true)!;
      const text = str(body, 'text', !body.dryRun) ?? '';
      const sayCtx = { project: view.config, orders: view.orders, workers: ctx.workers ?? { file: '', workers: [], quota_sources: {} }, probes: ctx.probes };
      return done<A.GroupSayResult>(200, sayToGroup(sayCtx, group, text, { dryRun: body.dryRun === true }));
    }

    if (parts[0] === 'orders' && parts[2] === 'say' && parts.length === 3) {
      const tag = view.orders.get(parts[1]).order.tag;
      const text = str(body, 'text', true)!;
      if (body.restart !== undefined && typeof body.restart !== 'boolean') throw new ApiFailure(400, 'bad_request', '"restart" must be true or false.');
      const sayCtx = body.restart === true ? runCtx() : { project: view.config, orders: view.orders, workers: ctx.workers ?? { file: '', workers: [], quota_sources: {} }, probes: ctx.probes };
      const r = sayToOrder(sayCtx, tag, text, { restart: body.restart === true, reply: str(body, 'reply') });
      const run = r.started?.run ? { id: r.started.run, key: `${tag}:${r.started.run}`, worker: r.started.worker, ...(r.started.pid ? { pid: r.started.pid } : {}), resumed: !!r.started.resumed } : undefined;
      return done<A.SayResult>(200, { ok: true, tag, stage: r.stage as A.Stage, message: r.message, restarted: r.restarted, ...(r.delivery ? { delivery: r.delivery } : {}), ...(run ? { run } : {}) });
    }

    if (parts[0] === 'decisions' && parts.length === 1) {
      if (typeof body.default !== 'undefined' && typeof body.default !== 'boolean') throw new ApiFailure(400, 'bad_request', '"default" must be true or false.');
      const entry = addDecision(view.config, view.orders, { text: str(body, 'text', true)!, source: str(body, 'source'), default: body.default === true, date: str(body, 'date'), id: str(body, 'id'), order: str(body, 'order') }, ctx.probes.now());
      return done<A.DecisionEntry>(201, entry);
    }

    if (parts[0] === 'orders' && parts[2] === 'quotes' && parts.length === 3) {
      const tag = view.orders.get(parts[1]).order.tag;
      const made = view.orders.quote(tag, { id: str(body, 'id'), service: str(body, 'service', true)!, unit: str(body, 'unit'), unit_price: numberOf(body, 'unitPrice'), quantity: numberOf(body, 'quantity'), cap_requested: numberOf(body, 'capRequested', true)!, note: str(body, 'note') });
      return done<A.Quote>(201, toQuote(view.config.id, tag, made.quote));
    }
    if (parts[0] === 'orders' && parts[2] === 'quotes' && parts.length === 5 && ['approve', 'reject', 'spend'].includes(parts[4])) {
      const tag = view.orders.get(parts[1]).order.tag;
      const made = parts[4] === 'approve' ? view.orders.decideQuote(tag, parts[3], { approve: true, cap: numberOf(body, 'cap', true)!, note: str(body, 'note') })
        : parts[4] === 'reject' ? view.orders.decideQuote(tag, parts[3], { approve: false, note: str(body, 'note') })
          : view.orders.spend(tag, parts[3], { amount: numberOf(body, 'amount', true)!, what: str(body, 'what', true)!, key: str(body, 'key') });
      return done<A.Quote>(200, toQuote(view.config.id, tag, made.quote));
    }

    if (parts[0] === 'orders' && parts[2] === 'questions' && parts.length === 3) {
      const tag = view.orders.get(parts[1]).order.tag;
      const options = checkOptionImages(view.config, view.orders, ctx.probes, tag, normalizeOptions(body.options));
      const made = view.orders.ask(tag, { text: str(body, 'text', true)!, options });
      return done<A.Question>(201, toQuestion(made.question));
    }

    if (parts[0] === 'orders' && parts[2] === 'questions' && parts[4] === 'answer' && parts.length === 5) {
      const tag = view.orders.get(parts[1]).order.tag;
      const choice = Number(body.choice);
      if (!Number.isInteger(choice)) throw new ApiFailure(400, 'bad_request', '"choice" is required: the option, from 1.');
      const note = str(body, 'note'), who = str(body, 'who');
      // With a workers file the worker is started again at once, like for any answer; without one the pick is only recorded.
      if (ctx.workers) answerOrder(runCtx(), tag, note, { choice, who, question: parts[3] });
      else view.orders.pick(tag, parts[3], { choice, note, who });
      return done<A.Question>(200, toQuestion(view.orders.get(tag).questions!.find(x => x.id.toLowerCase() === parts[3].toLowerCase())!));
    }

    if (parts[0] === 'schedules' && parts.length === 3 && (parts[2] === 'run' || parts[2] === 'pause' || parts[2] === 'resume')) {
      const id = parts[1];
      const now = ctx.probes.now();
      if (parts[2] === 'run') {
        const outcome = runScheduleNow(view.config, view.orders, id, now);
        const schedule = scheduleViews(view.config, view.orders, now, (docs, at) => scheduleSpend(docs, at, ctx.workers?.workers, ctx.probes)).find(s => s.id === id)!;
        return done<A.ScheduleRunResult>(200, {
          ok: true,
          id,
          status: outcome.status,
          ...(outcome.precheck ? { precheck: outcome.precheck } : {}),
          plannedAt: outcome.plannedAt,
          ...(outcome.orderTag ? { orderTag: outcome.orderTag } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          schedule,
        });
      }
      if (parts[2] === 'pause') {
        pauseSchedule(view.config, view.orders, id, { reason: str(body, 'reason'), now });
        const schedule = scheduleViews(view.config, view.orders, now, (docs, at) => scheduleSpend(docs, at, ctx.workers?.workers, ctx.probes)).find(s => s.id === id)!;
        return done<A.ScheduleStateResult>(200, { ok: true, id, schedule });
      }
      resumeSchedule(view.config, view.orders, id, now);
      const schedule = scheduleViews(view.config, view.orders, now, (docs, at) => scheduleSpend(docs, at, ctx.workers?.workers, ctx.probes)).find(s => s.id === id)!;
      return done<A.ScheduleStateResult>(200, { ok: true, id, schedule });
    }

    if (parts[0] === 'leases' && parts[1] === 'release' && parts.length === 2) {
      const resource = str(body, 'resource', true)!;
      const tag = str(body, 'tag', true)!;
      if (!view.config.resources?.[resource]) throw new ApiFailure(404, 'not_found', `No resource "${resource}".`);
      const released = releaseLease(view.config, view.orders, resource, tag, t('a person took it back (web)'), ctx.probes.now(), str(body, 'holderProject'));
      ctx.invalidate();
      return done<A.LeaseReleaseResult>(200, { ok: true, resource, tag, released });
    }

    if (parts[0] === 'tick' && parts.length === 1) {
      if (!ctx.workers) throw new ApiFailure(400, 'bad_request', 'No workers file was given, so there is nothing to tick.');
      const real = body.real === true;
      const max = body.maxDispatch === undefined ? 1 : Number(body.maxDispatch);
      if (!Number.isInteger(max) || max < 0) throw new ApiFailure(400, 'bad_request', '"maxDispatch" must be a whole number >= 0.');
      const c = runCtx();
      const result = ctx.runTick ? await ctx.runTick(view.config, real, max) : real
        ? executeTick({ ...c, probes: ctx.probes }, { maxDispatch: max })
        : tick(view.config, view.orders, ctx.workers, ctx.slow, { record: false, finishes: findFinishes(view.config, view.orders, ctx.probes, ctx.workers).map(f => ({ tag: f.tag, run: f.run, outcome: f.outcome, why: f.why })) });
      const r = result.report;
      if (real) ctx.hub.publish(view.config.id, 'tick.done', { project: view.config.id, at: r.at, source: 'api', real: true, exitCode: r.exitCode, done: r.done, problems: r.problems.length });
      return done<A.TickView>(200, {
        project: view.config.id, at: r.at, real, exitCode: r.exitCode, needsUser: r.needsUser, problems: r.problems.map(p => ({ kind: p.kind, ...(p.tag ? { tag: p.tag } : {}), ...(p.evidence?.length ? { evidence: p.evidence } : {}), text: p.text })),
        moves: r.moves, heldBack: r.heldBack, unavailable: r.unavailable, waiting: r.waiting, monitoring: r.monitoring, finishes: r.finishes, done: r.done, text: formatReport(r, !real),
      });
    }

    if (parts[0] === 'check' && parts.length === 2) {
      const doc = view.orders.get(parts[1]);
      const results = (strList(body, 'results') ?? []).map(f => safeResultPath(view.config, doc.order.worktree, f));
      const worktree = str(body, 'worktree');
      if (worktree && worktree !== doc.order.worktree && !ctx.probes.worktrees(view.config.root).some(w => samePath(w.path, worktree))) throw new ApiFailure(400, 'bad_request', 'That folder is not a worktree of the project.');
      const report = runCheck(view.config, view.orders, doc.order.tag, results, worktree);
      const refs = report.refs ? summary(report.refs.rows) : undefined;
      return done<A.CheckResult>(200, {
        tag: report.tag, at: ctx.probes.now().toISOString(), ok: report.exitCode === 0, base: report.base, worktree: report.worktree,
        ...(report.lint ? { lint: report.lint } : {}), general: report.general.map(g => ({ name: g.name, ok: g.ok, detail: g.detail })), ...(report.refs ? { results: report.refs.results } : {}), ...(refs ? { refs: { same: refs.same, other: refs.other as A.CheckRef[] } } : {}),
      });
    }
    if (libraryPost({ view: () => view, workers: ctx.workers, now: ctx.probes.now(), parts, q, reply: (status, out) => done(status, out), serve: (file, type) => serveFile(req, res, file, type) }, body)) return;
    throw new ApiFailure(404, 'not_found', `No such call: POST ${url.pathname}`);
  }
  throw new ApiFailure(404, 'not_found', `No such call: ${method} ${url.pathname}`);
}

/** Sends a file, or the part of it a `Range` header asks for. */
function serveFile(req: IncomingMessage, res: ServerResponse, file: string, type: string): void {
  const size = statSync(file).size;
  const headers: Record<string, string | number> = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline',
    // A picture or video opened on its own runs nothing on the console's origin.
    'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  let start = 0, end = size - 1, status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1; }
    else { start = Math.max(0, size - Number(range[2])); }          // "-N": the last N bytes
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}`, 'cache-control': 'no-store' });
      return void res.end();
    }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return void res.end();
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** A result file may be named relative to the work-order folder, or by a path inside the project's folders. Nothing else is read. */
function safeResultPath(project: ProjectConfig, worktree: string | undefined, file: string): string {
  const roots = [project.work_orders, project.state_dir, project.root, ...(worktree ? [worktree] : [])].map(r => path.resolve(r));
  const full = path.resolve(project.work_orders, file);
  if (!roots.some(r => { const rel = path.relative(r, full); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); })) throw new ApiFailure(400, 'bad_request', `The result file ${file} is outside the project's folders.`);
  if (!existsSync(full)) throw new ApiFailure(404, 'not_found', `The result file ${file} does not exist.`);
  return full;
}

function findRun(view: View, key: string): { tag: string; run: ReturnType<View['orders']['get']>['runs'][number] } | undefined {
  const i = key.lastIndexOf(':');
  if (i < 1) return undefined;
  try {
    const doc = view.orders.get(key.slice(0, i));
    const run = doc.runs.find(r => r.id === key.slice(i + 1));
    return run ? { tag: doc.order.tag, run } : undefined;
  } catch { return undefined; }
}

/** Where the log of the run `<TAG>:<id>` is, for the stream. */
export function resolveLogOf(projects: ProjectConfig[], project: string, key: string): string | undefined {
  const config = projects.find(p => p.id === project);
  return config ? findRun({ config, orders: new Orders(stateStore(config), () => new Date().toISOString(), 'web') }, key)?.run.log : undefined;
}

function readLogTail(project: string, key: string, file: string, tail: number): A.RunLog {
  const size = statSync(file).size;
  const length = Math.min(size, LOG_READ_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  let lines = buffer.toString('utf8').split(/\r?\n/);
  let cut = size > length;
  if (cut) lines = lines.slice(1);           // the first line starts before what was read
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > tail) { lines = lines.slice(-tail); cut = true; }
  return { project, key, lines, offset: size, size, cut };
}
