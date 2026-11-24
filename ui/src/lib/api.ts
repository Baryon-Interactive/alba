import type {
  ActionRequest, ActionResult, ApiError, OrderSkills, Route, SkillsView, CheckRequest, CheckResult, CleanPlan, DecisionEntry, DecisionList, EvidenceList, LessonList,
  MergeReadiness, NewDecisionRequest, NewOrderRequest, NewOrderResult, OrderDetail, OrderDiff, OrderEvent, OrderList, Overview, ProjectInfo, QuotaHistory, Quote,
  QuoteApproveRequest, QuoteList, QuoteRejectRequest, Question, QuestionAnswerRequest, RunList, RunLog, RunTranscript, SayRequest, SayResult, Session, TickRequest, TickView,
  ResourceList, LeaseReleaseRequest, LeaseReleaseResult, WorkerList, WorkerEditRequest, WorkerEditResult, NewWorkerRequest, WorkerYaml, SkillUseRequest, ConfigEditResult,
  DocList, DocFile, DocSearch, OverviewAll, ProjectOverview, VerifyResult, ProducerView, ProducerActionRequest, ProducerChatView,
  ConfigView, RoutingMigration, OrderSummary,
} from '@api';
import type { ProducerAction } from '@api';
import type { ArtSetting, ArtView, ExternalUsage, PickChooseRequest, PickChooseResult, PickList, SettingApproveRequest, SpendApproveRequest, SpendQuote, SpendView } from '@api';
import { getLang } from '@/i18n';

export type NewOrderBody = NewOrderRequest;

/** An answer with an error status: carries the server's code and message (text for a person). */
export class ApiFailure extends Error {
  constructor(public status: number, public code: ApiError['error']['code'] | 'network', message: string, /** What is wrong, by field, when the server can say (a refused edit of a configuration file). */ public details?: { field?: string; message: string }[]) {
    super(message);
  }
}

/**
 * The page holds no key: the browser is signed in by a session cookie (HttpOnly, SameSite=Strict) that /login gave it. Without one
 * (a new browser, or the server restarted) every call answers 401, and the page goes to the sign-in page, which comes back here.
 */
let signingIn = false;
function signIn(): void {
  if (signingIn || typeof location === 'undefined') return;
  signingIn = true;
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // The texts the server writes for people (reasons, check names) come back in the language of the page.
    res = await fetch(path, { ...init, headers: { 'x-alba-lang': getLang(), ...(init?.headers as Record<string, string> | undefined) } });
  } catch (e) {
    throw new ApiFailure(0, 'network', e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (!res.ok) {
    const err = (body as ApiError | undefined)?.error;
    if (res.status === 401) signIn();
    throw new ApiFailure(res.status, err?.code ?? 'internal', err?.message ?? `HTTP ${res.status}`, err?.details);
  }
  return body as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export interface WriteOptions {
  idempotencyKey?: string;
  retries?: number;
  retryDelayMs?: number;
}

let keyCounter = 0;
export function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `ui-${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
  }
  keyCounter += 1;
  return `ui-${Date.now().toString(36)}-${keyCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

let defaultRetryDelayMs = 250;
export function setWriteRetryDelayMs(ms: number): void {
  defaultRetryDelayMs = ms;
}

async function write<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body: unknown, opts: WriteOptions = {}): Promise<T> {
  const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
  const maxRetries = opts.retries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? defaultRetryDelayMs;
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    try {
      return await request<T>(path, {
        method,
        headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: payload,
      });
    } catch (e) {
      const retryable = e instanceof ApiFailure && (e.code === 'network' || e.status >= 500);
      if (!retryable || attempt >= maxRetries) throw e;
      if (retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
}

export interface MachineGuide { project: string; registry: string | null; sshConfig: string; publicKeys: { file: string; key: string }[]; platform: string }
export interface MachineTestResult {
  connection: { ok: boolean; category: 'ok' | 'unresolved' | 'refused' | 'timeout' | 'denied' | 'host-key' | 'no-ssh' | 'failed'; remoteName?: string; detectedOs?: 'windows' | 'linux' | 'macos'; seconds: number };
  reading?: import('../../../src/machines/probe').MachineReading;
  capabilities?: import('../../../src/machines/capabilities').Capabilities;
  suggestions?: import('../../../src/machines/capabilities').Suggestions;
}
export type MachineSshHost = import('../../../src/machines/ssh-config').SshHostView;
export interface MachineSshChange { file: string; alias: string; before: string; after: string; changed: string[]; dryRun: boolean; backup?: string }
export interface MachineEditResult {
  id: string; file: string; dryRun: boolean; changed: string[]; backup?: string; ssh?: MachineSshChange;
  connection?: MachineTestResult['connection']; machine?: import('../../../src/machines/probe').MachineView;
}
const post = <T>(path: string, body: unknown) => write<T>('POST', path, body);
const put = <T>(path: string, body: unknown) => write<T>('PUT', path, body);

const enc = encodeURIComponent;

export const api = {
  machines: (project: string) => request<{ project: string; machines: import('../../../src/machines/probe').MachineView[] }>(`/api/machines${qs({ project })}`),
  machineGuide: (project: string) => request<MachineGuide>(`/api/machines/guide${qs({ project })}`),
  machineSshBlock: (body: { project: string; alias: string; hostname: string; user: string; identity_file?: string; port?: number; write?: boolean }) => post<{ block: string; written: boolean; file?: string; backup?: string }>('/api/machines/ssh-block', body),
  machineTest: (project: string, machine: Record<string, unknown>) => post<MachineTestResult>('/api/machines/test', { project, machine }),
  machineAdd: (project: string, machine: Record<string, unknown>) => post<{ id: string; file: string; backup?: string }>('/api/machines/add', { project, machine }),
  machineSshHost: (project: string, alias: string) => request<MachineSshHost>(`/api/machines/ssh-host${qs({ project, alias })}`),
  machineEdit: (project: string, body: { id: string; set?: Record<string, unknown>; ssh?: { hostname?: string; user?: string; port?: number | null }; dryRun?: boolean }) => post<MachineEditResult>('/api/machines/edit', { project, ...body }),
  machineRemove: (project: string, id: string) => post<{ id: string }>('/api/machines/remove', { project, id }),
  machineRoles: (project: string, id: string, roles: string[]) => post<{ id: string; roles: string[] }>('/api/machines/roles', { project, id, roles }),
  machineInstallPlan: (project: string, id: string, item: string) => request<{ plan: Omit<import('../../../src/machines/install').InstallPlan, 'steps'> & { steps: string[] } }>(`/api/machines/install-plan${qs({ project, id, item })}`),
  machineInstall: (project: string, id: string, item: string) => post<{ job: import('../../../src/machines/jobs').MachineJob }>('/api/machines/install', { project, id, item }),
  machineJobCancel: (project: string, job: string) => post<{ job: import('../../../src/machines/jobs').MachineJob }>('/api/machines/jobs/cancel', { project, job }),
  machineCheck: (project: string, id?: string) => post<{ project: string; machines: import('../../../src/machines/probe').MachineView[] }>('/api/machines/check', { project, ...(id ? { id } : {}) }),
  design: (project: string) => request<import('./design').DesignBundle>(`/api/design/export${qs({ project })}`),
  designStale: (project: string) => request<import('./design').StaleSystem[]>(`/api/design${qs({ project, query: 'stale-systems' })}`),
  designApply: (project: string, changeset: import('./design').ChangeSet, dryRun: boolean) => post<import('./design').DesignResult>('/api/design/changesets', { project, changeset, dryRun }),
  designMeasure: (project: string, targets: string[]) => post<import('../../../src/design/measure').MeasureOutcome[]>('/api/design/measure', { project, targets }),
  designDocs: (project: string) => request<{ project: string; docs: import('../../../src/design/docs').DesignDoc[] }>(`/api/design-docs${qs({ project })}`),
  designDoc: (project: string, id: string, version?: number) => request<import('../../../src/design/docs').DesignDoc>(`/api/design-docs/${enc(id)}${qs({ project, version })}`),
  intakeReview: (project: string, tag: string, body: { accept?: string[]; reject?: string[]; note?: string }) => post<{ project: string; tag: string; events: unknown[] }>(`/api/intake/${enc(tag)}/review`, { project, ...body }),
  intakeReviewView: (project: string, tag: string) => request<ReturnType<typeof import('../../../src/design/docs').intakeReview>>(`/api/intake/${enc(tag)}/review${qs({ project })}`),
  session: () => request<Session>('/api/session'),
  projects: () => request<ProjectInfo[]>('/api/projects'),
  overviewAll: () => request<OverviewAll>('/api/overview/all'),
  overviewProject: (project: string) => request<ProjectOverview>(`/api/p/${enc(project)}/overview`),
  overview: (project: string) => request<Overview>(`/api/overview${qs({ project })}`),
  orders: (project: string, stage?: string) => request<OrderList>(`/api/orders${qs({ project, stage })}`),
  order: (project: string, tag: string) => request<OrderDetail>(`/api/orders/${enc(tag)}${qs({ project })}`),
  diff: (project: string, tag: string) => request<OrderDiff>(`/api/orders/${enc(tag)}/diff${qs({ project })}`),
  readiness: (project: string, tag: string) => request<MergeReadiness>(`/api/orders/${enc(tag)}/readiness${qs({ project })}`),
  runLog: (project: string, key: string, tail = 1000) => request<RunLog>(`/api/runs/${enc(key)}/log${qs({ project, tail })}`),
  runTranscript: (project: string, key: string, q: { after?: number; limit?: number } = {}) => request<RunTranscript>(`/api/runs/${enc(key)}/transcript${qs({ project, ...q })}`),
  workers: (project: string) => request<WorkerList>(`/api/workers${qs({ project })}`),
  workerYaml: (project: string, id: string) => request<WorkerYaml>(`/api/workers/${enc(id)}/yaml${qs({ project })}`),
  editWorker: (id: string, body: WorkerEditRequest) => put<WorkerEditResult>(`/api/workers/${enc(id)}`, body),
  newWorker: (body: NewWorkerRequest) => post<WorkerEditResult>('/api/workers', body),
  resources: (project: string) => request<ResourceList>(`/api/resources${qs({ project })}`),
  releaseLease: (body: LeaseReleaseRequest) => post<LeaseReleaseResult>('/api/leases/release', body),
  skillUse: (body: SkillUseRequest) => post<ConfigEditResult>('/api/skills/use', body),
  quotaHistory: (project: string, worker?: string, limit = 500) => request<QuotaHistory>(`/api/quota/history${qs({ project, worker, limit })}`),
  act: (tag: string, body: ActionRequest) => post<ActionResult>(`/api/orders/${enc(tag)}/actions`, body),
  say: (tag: string, body: SayRequest) => post<SayResult>(`/api/orders/${enc(tag)}/say`, body),
  planOrder: (body: import('@api').PlanRequest) => post('/api/orders/plan', body),
  editPlan: (project: string, tag: string, patch: Partial<import('@api').PlanRequest>) => post(`/api/orders/${enc(tag)}/plan`, { project, ...patch }),
  orderDraft: (project: string, tag: string) => request<import('@api').DraftView>(`/api/orders/${enc(tag)}/draft${qs({ project })}`),
  draftAgain: (project: string, tag: string, brief?: string) => post<import('@api').DraftAgainResult>(`/api/orders/${enc(tag)}/draft-again`, { project, ...(brief ? { brief } : {}) }),
  decideDraft: (project: string, tag: string, actionId: string, decision: 'save' | 'accept' | 'reject', body?: string) => post<ProducerAction>(`/api/orders/${enc(tag)}/draft`, { project, actionId, decision, body }),
  newOrder: (body: NewOrderBody) => post<NewOrderResult>('/api/orders', body),
  tick: (body: TickRequest) => post<TickView>('/api/tick', body),
  check: (tag: string, body: CheckRequest) => post<CheckResult>(`/api/check/${enc(tag)}`, body),
  verify: (project: string, tag: string) => post<VerifyResult>(`/api/orders/${enc(tag)}/verify`, { project }),
  producerFacts: (project: string) => request<import('@api').ProducerFacts>(`/api/p/${enc(project)}/producer/facts`),
  producerLog: (project: string) => request<import('@api').ProducerLog>(`/api/producer/log${qs({ project, superseded: 'true' })}`),
  producerConfig: (project: string) => request<import('@api').ProducerConfigView>(`/api/producer/config${qs({ project })}`),
  producerConfigEdit: (project: string, yaml: string, dryRun: boolean) => post<import('@api').ProducerConfigEdit>('/api/producer/config', { project, yaml, dryRun }),
  producerWorkspace: (project: string) => request<import('@api').ProducerWorkspace>(`/api/producer/workspace${qs({ project })}`),
  producerAnalysis: (project: string) => request<import('@api').ProducerFacts>(`/api/producer/analysis${qs({ project })}`),
  producerChat: (project: string, before?: string) => request<ProducerChatView>(`/api/producer/chat${qs({ project, before })}`),
  producerChatStop: (project: string) => post('/api/producer/chat/stop', { project }),
  producerInsights: (project: string) => request<import('@api').ProducerInsights>(`/api/p/${enc(project)}/producer/insights`),
  producerChatSend: (project: string, text: string) => post('/api/producer/chat', { project, text }),
  producerChatDecision: (project: string, actionId: string, reject: boolean, edit?: { note?: string; reason?: string }) => post('/api/producer/actions', { project, actionId, reject, ...(edit?.note === undefined ? {} : { edit: { note: edit.note } }), ...(edit?.reason === undefined ? {} : { reason: edit.reason }) }),
  producerDirectionDecision: (project: string, proposalId: string, accept: boolean, reason?: string) => post('/api/producer/direction', { project, proposalId, accept, reason }),
  producer: async (project: string) => {
    const first = await request<ProducerView>(`/api/producer${qs({ project })}`);
    let cursor = first.nextCursor;
    const cases = new Map(first.cases.map(c => [c.id, c]));
    while (cursor) {
      const page = await request<ProducerView>(`/api/producer${qs({ project, cursor })}`);
      for (const c of page.cases) cases.set(c.id, c);
      cursor = page.nextCursor;
    }
    return { ...first, cases: [...cases.values()], nextCursor: undefined };
  },
  producerAction: (body: (ProducerActionRequest & { actionId?: string }) | { project: string; actionId: string }) => post<ProducerAction>('/api/producer/actions', body),
  producerPause: (project: string, paused: boolean) => post<{ ok: true; paused: boolean }>(`/api/producer/${paused ? 'pause' : 'resume'}`, { project }),

  runs: (project: string, q: { since?: string; worker?: string; limit?: number; cursor?: string } = {}) => request<RunList>(`/api/runs${qs({ project, ...q })}`),
  decisions: (project: string, cursor?: string) => request<DecisionList>(`/api/decisions${qs({ project, cursor })}`),
  addDecision: (body: NewDecisionRequest) => post<DecisionEntry>('/api/decisions', body),
  evidence: (project: string, tag: string) => request<EvidenceList>(`/api/orders/${enc(tag)}/evidence${qs({ project })}`),
  events: (project: string, q: { tag?: string; after?: number; limit?: number } = {}) => request<{ events: OrderEvent[] }>(`/api/events${qs({ project, ...q })}`),
  clean: (project: string, includeIgnored = false) => request<CleanPlan>(`/api/clean${qs({ project, ...(includeIgnored ? { include_ignored: '1' } : {}) })}`),
  credits: (project: string, status?: string) => request<QuoteList>(`/api/credits${qs({ project, status })}`),
  lessons: (project: string, tag?: string) => request<LessonList>(`/api/lessons${qs({ project, tag })}`),
  route: (project: string, tag: string) => request<Route>(`/api/orders/${enc(tag)}/route${qs({ project })}`),
  roles: (project: string) => request<import('@api').RolesView>(`/api/roles${qs({ project })}`),
  setRole: (tag: string, body: { project: string; role: string }) => post<Route>(`/api/orders/${enc(tag)}/role`, body),
  classify: (tag: string, body: { project: string; model?: boolean }) => post<Route>(`/api/orders/${enc(tag)}/classify`, body),
  skills: (project: string) => request<SkillsView>(`/api/skills${qs({ project })}`),
  orderSkills: (project: string, tag: string) => request<OrderSkills>(`/api/orders/${enc(tag)}/skills${qs({ project })}`),
  answerQuestion: (tag: string, id: string, body: QuestionAnswerRequest) => post<Question>(`/api/orders/${enc(tag)}/questions/${enc(id)}/answer`, body),
  approveQuote: (tag: string, id: string, body: QuoteApproveRequest) => post<Quote>(`/api/orders/${enc(tag)}/quotes/${enc(id)}/approve`, body),
  rejectQuote: (tag: string, id: string, body: QuoteRejectRequest) => post<Quote>(`/api/orders/${enc(tag)}/quotes/${enc(id)}/reject`, body),
  // : the art library
  picks: (project: string) => request<PickList>(`/api/picks${qs({ project })}`),
  choosePick: (id: string, body: PickChooseRequest & { project: string }) => post<PickChooseResult>(`/api/picks/${enc(id)}/choose`, body),
  art: (project: string) => request<ArtView>(`/api/art${qs({ project })}`),
  approveSetting: (id: string, body: SettingApproveRequest & { project: string }) => post<ArtSetting>(`/api/art/settings/${enc(id)}/approve`, body),
  spend: (project: string) => request<SpendView>(`/api/spend${qs({ project })}`),
  approveSpend: (id: string, body: SpendApproveRequest & { project: string }) => post<SpendQuote>(`/api/spend/${enc(id)}/approve`, body),
  runUsage: (project: string, since = '7d') => request<import('@api').UsageDashboard>(`/api/usage/runs${qs({ project, since })}`),
  usageScorecard: (q: { project?: string; since?: string; kind?: string; by?: import('@api').ScorecardBy } = {}) => request<import('@api').Scorecard>(`/api/usage/scorecard${qs(q)}`),
  usage: (project: string, days = 7) => request<ExternalUsage>(`/api/usage${qs({ project, days })}`),
  docs: (project: string) => request<DocList>(`/api/docs${qs({ project })}`),
  doc: (project: string, path: string) => request<DocFile>(`/api/docs/file${qs({ project, path })}`),
  docSearch: (project: string, q: string, limit = 30) => request<DocSearch>(`/api/docs/search${qs({ project, q, limit })}`),
  // : editing the configuration files, orders and workers
  config: (project: string, target: ConfigTarget) => request<ConfigView>(`/api/config${qs({ project, target })}`),
  editConfig: (body: { project: string; target: ConfigTarget; edits: ConfigEdit[]; dryRun?: boolean }) => post<ConfigEditResult>('/api/config', body),
  routingMigration: (project: string) => request<RoutingMigration>(`/api/routing/migrate${qs({ project })}`),
  orderFields: (project: string, tag: string, fields: OrderFieldsEdit) => post<OrderSummary>(`/api/orders/${enc(tag)}/fields`, { project, ...fields }),
  orderBody: (project: string, tag: string, text: string, expected: string) => post<{ ok: true; file: string }>(`/api/orders/${enc(tag)}/body`, { project, text, expected }),
  removeWorker: (project: string, id: string) => post<WorkerEditResult>(`/api/workers/${enc(id)}/remove`, { project }),
  // : tool plugins
  plugins: (project: string) => request<import('@api').PluginsView>(`/api/plugins${qs({ project })}`),
  pluginDoctor: (project: string, ids?: string[]) => post<import('@api').PluginDoctor>('/api/plugins/doctor', { project, ...(ids?.length ? { ids } : {}) }),
  // : first-pass review
  reviewStats: (project: string, days = 30) => request<import('@api').FirstPassStats>(`/api/review/stats${qs({ project, days })}`),
  firstPassWrong: (project: string, tag: string, note: string) => post<import('@api').FirstPassDisputeResult>(`/api/orders/${enc(tag)}/first-pass-wrong`, { project, note }),
  // : schedules
  schedules: (project: string) => request<import('@api').ScheduleList>(`/api/schedules${qs({ project })}`),
  scheduleRun: (project: string, id: string) => post<import('@api').ScheduleRunResult>(`/api/schedules/${enc(id)}/run`, { project }),
  schedulePause: (project: string, id: string, reason?: string) => post<import('@api').ScheduleStateResult>(`/api/schedules/${enc(id)}/pause`, { project, ...(reason ? { reason } : {}) }),
  scheduleResume: (project: string, id: string) => post<import('@api').ScheduleStateResult>(`/api/schedules/${enc(id)}/resume`, { project }),
};

/** Which file a configuration edit goes to: the project's own file or the shared workers file. */
export type ConfigTarget = 'project' | 'workers';
/** One change of `POST /api/config`: the value at `path` becomes `value`; without `value` the key is removed. */
export interface ConfigEdit { path: (string | number)[]; value?: unknown }
/** The fields of an order that `POST /api/orders/:tag/fields` changes; `null` clears one. */
export interface OrderFieldsEdit {
  title?: string; kind?: string; priority?: number | null; worker?: string | null; role?: string; needs?: string[]; tags?: string[]; skills?: string[];
  uses?: string[]; tools?: string[]; heavy?: string | null; condition?: string | null; check?: 'independent' | 'none'; review?: 'manual' | 'auto'; intent?: string;
}

/** Where the bytes of an image or video file of the project are (`GET /api/files`); a relative path is looked up in the order's worktree first. */
export const fileUrl = (project: string, path: string, tag?: string) => `/api/files${qs({ project, path, tag })}`;
/** The picture of a reference card, once it is fetched (`GET /api/art/ref/:id`). */
export const refImageUrl = (project: string, id: string) => `/api/art/ref/${enc(id)}${qs({ project })}`;
