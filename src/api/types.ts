export type { RolesView } from '../roles/view.ts';
export type { RoleWorkerResult } from '../roles/statistics.ts';
/**
 * The JSON interface of the board, as types. The server returns exactly these shapes and a front end can import them
 * (`import type { Overview } from '../../src/api/types.ts'`). This file has no imports and no runtime code except two constant lists,
 * so it can be read by a bundler as it is. The path, parameters and errors of every call are in docs/console/010-api.md.
 *
 * Conventions:
 *  - Times are ISO 8601 strings in UTC ("2026-11-03T13:25:17.231Z").
 *  - A field that is not known is left out; it is never `null`. A count that cannot be read is a `RunUsage` with `source: 'unknown'`.
 *  - Text meant for people ("why", "reasons", problem text) is already in the tool's language; every other string is a stable word.
 *  - `project` is the project id from the project file; every call that reads or writes orders names it (it can be left out when only one project is served).
 */

// ---------------------------------------------------------------------------------------------------------------- words

export const STAGES = [
  'cancelled', 'merged', 'held', 'awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped',
  'running', 'monitoring', 'idle', 'waiting-needs', 'planned', 'queued', 'draft',
] as const;
export type Stage = (typeof STAGES)[number];

/**
 * What a person can do to an order. `answer`, `run` and `stop` are not stored as plain actions: `answer` continues the worker's session,
 * `run` starts it now (a held order on the worker named), `stop` ends the open run's whole process tree and holds the order.
 */
export const ORDER_ACTIONS = ['queue', 'hold', 'release', 'cancel', 'approve', 'rework', 'answer', 'run', 'stop'] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

/** What an `awaiting-user` order is waiting for: a person to click a card in a session of their own, or an answer to a question. `answer` is only for the second. */
export type WaitingFor = 'card' | 'answer';

/** Cross-project read model. UTC calendar days include today; unknown latency/rates are omitted. */
export interface AttentionItem { project: string; tag?: string; text: string; target?: 'picks' | 'spend'; projects?: string[] }
export interface AttentionGroup { kind: string; problem: boolean; count: number; items: AttentionItem[] }
export interface OverviewDay { day: string; merges: Record<string, number>; reworks: number; endings: Partial<Record<RunOutcome, number>> }
export interface RecentMerge { project: string; tag: string; title: string; at: string; runs: number; reworks: number; worker?: string; leadHours?: number }
export type { UsageDashboard, UsageRow, UsageReport, UsageTotal, UsageSignal } from '../usage/types.ts';
export interface OverviewAll {
  usage?: import('../usage/types.ts').UsageDashboard;
  at: string;
  readingsAt?: string;
  projects: ProjectOverview[];
  attention: AttentionGroup[];
  live: { count: number; items: (OrderSummary & { commitMinutes?: number; receiptMinutes?: number; receiptAt?: string; leases: Lease[] })[] };
  workers: { count: number; items: (Worker & { balanceChange24h?: number })[] };
  quotas: { source: string; workers: string[]; reading?: QuotaPoint }[];
  machine?: Overview['machine'];
  days: OverviewDay[];
  metrics: { merges7d: number; runSuccessRate?: number; reworksPerMerge?: number; medianLeadHours?: number; p95LeadHours?: number };
  recentMerges: { count: number; items: RecentMerge[] };
  resources: (ResourceView & { project: string })[];
  next: { moves: (Overview['next']['moves'][number] & { project: string })[]; heldBack: { project: string; tag: string; why: string }[]; lastTickAt?: string };
}

/** Slots held against a configured dispatch cap; monitoring is included in used. */
export interface CapacityUsage { used: number; cap: number; monitoring: number }

/** Cached, project-scoped slice used by `/api/p/<project>/overview`. It is also present in `OverviewAll.projects`. */
export interface ProjectOverview extends Omit<Overview, 'workers'> {
  nightlyGates?: ReturnType<typeof import('../gates/state.ts').gatesStatus>;
  capacity: Record<string, CapacityUsage>;
  total: number;
  needsCount: number;
  mergesPerDay: number[];
  attention: AttentionGroup[];
  live: { count: number; items: (OrderSummary & { commitMinutes?: number; receiptMinutes?: number; receiptAt?: string; leases: Lease[] })[] };
  nextUp: { tag: string; title: string; stage: Stage; reason: string; worker?: string; mode?: 'dispatch' | 'resume' | 'card' }[];
  dependencies: { tag: string; title: string; count: number; items: { tag: string; title: string; stage: Stage }[] }[];
  throughput: { days: OverviewDay[]; byKind: { kind: string; merges: number; reworks: number; outcomes: Partial<Record<RunOutcome, number>>; medianLeadHours?: number; p90LeadHours?: number }[]; medianLeadHours?: number; p90LeadHours?: number };
  usage?: import('../usage/types.ts').UsageDashboard;
  workers: { count: number; items: (Worker & { balanceChange24h?: number })[] };
  recent: { decisions: DecisionEntry[]; approvals: RecentMerge[] };
  recentDecisions: DecisionEntry[];
  recentApprovals: RecentMerge[];
  /** Producer status used by the one-line project overview summary. */
  producer: { openCases: number; wouldDoToday: number; paused: boolean };
}

export type RunOutcome = 'completed' | 'failed' | 'stalled' | 'capacity' | 'cancelled';
export type ReportStatus = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped' | 'monitoring';

// ---------------------------------------------------------------------------------------------------------------- errors

/** Every error answer: HTTP status 400, 403, 404, 409, 413 or 500 with this body. */
export interface ApiError {
  error: {
    /** bad_request | forbidden | not_found | conflict | too_large | internal */
    code: 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'too_large' | 'internal';
    message: string;
    /** For a refused edit: what is wrong, by field (`launch.env.KEY`, `capabilities`, ...), so a form can show it next to the field. */
    details?: { field?: string; message: string }[];
  };
}

// ---------------------------------------------------------------------------------------------------------------- session and projects

/** `GET /api/session`: what a page needs first. It carries no key: a page is signed in by its session cookie (docs/console/010-api.md, "Access"). */
export interface Session {
  /** The language of the texts this server returns (see "Language" in docs/console/010-api.md). */
  lang: 'en' | 'zh';
  version: string;
  at: string;
  projects: ProjectInfo[];
  /** The tick loop of `alba serve`: absent when the board runs without one. */
  loop?: { everyMinutes: number; lastTickAt?: string; lastExitCode?: number };
  eventLoopDelay?: { p99Ms: number; maxMs: number };
}

/** `GET /api/p/<project>/producer/facts`; null until the first real tick. */
export interface ProducerFacts extends Pick<ProducerView, 'notes' | 'drives' | 'lastClean'> { project: string; snapshot: import('../producer/facts/engine.ts').FactsSnapshot | null }
export interface ProducerInsights { project: string; trust: import('../producer/trust.ts').RuleTrust[]; briefs: import('../producer/briefs.ts').ProducerBrief[] }
export type { ProducerLog, ProducerLogRow, ProducerNow } from '../producer/activity.ts';
/** `GET /api/producer?project=` */
export type ProducerCase = import('../producer/producer.ts').ProducerCase;
export type ProducerAction = import('../producer/producer.ts').ProducerAction;
export interface ProducerPolicyRule { id: string; instruction: string; action: string; mode: 'off' | 'observe' | 'propose' | 'auto' }
/** The producer's model session, as `GET /api/producer` reports it. */
export type ProducerSession = import('../producer/session.ts').ProducerSessionView;
export interface ProducerView {
  notes?: { project: string; orders: { tag: string; text: string }[] };
  drives?: CleanPlan['drives'];
  lastClean?: CleanPlan;
  caseCount?: number;
  nextCursor?: string;
  project: string;
  enabled: boolean;
  paused: boolean;
  policy: { version: string; hash: string; modes: string[]; rules: ProducerPolicyRule[]; budgets: Record<string, number> };
  cases: import('../producer/producer.ts').ProducerCase[];
  actions: import('../producer/producer.ts').ProducerAction[];
  wouldDo: import('../producer/producer.ts').ProducerAction[];
  session: ProducerSession;
}
/** `POST /api/producer/actions` */
export interface ProducerActionRequest { project?: string; case: string; kind: string; note?: string; reason?: string; evidence?: string[] }

/** `GET /api/projects` */
export interface ProjectInfo {
  /** Whether the project's design library is enabled. */
  design?: { enabled: boolean };
  id: string;
  name: string;
  orderCount: number;
  /** A workers file is loaded, so quota, workers and ticks work. */
  hasWorkers: boolean;
  /** `POST /api/orders` can write a work-order file into this folder. */
  workOrdersDir: string;
  /** The project has a dispatch table that new orders are added to ( write-back is on). */
  tableWriteBack: boolean;
  /** The project has `checks:` configured. */
  checks: boolean;
  /** . Which parts of the art library the project file turns on (`picks`, `art`, `credits`, `usage_ledgers`). */
  library?: { picks: boolean; art: boolean; credits: boolean; usage: boolean };
  stages: Partial<Record<Stage, number>>;
}

export type DesignDocBlock = import('../design/docs.ts').DesignDocBlock;
export type DesignDoc = import('../design/docs.ts').DesignDoc;

// ---------------------------------------------------------------------------------------------------------------- orders

export interface Mandate {
  quote?: string;
  decisions?: string;
  /** Ceiling for the money this order may spend, in US dollars (see `OrderSpend`). */
  spend_cap?: number;
  protected_paths?: string[];
}

/** Tokens and cost of one run (or the sum of several), read from the run's log. */
export interface RunUsage {
  /** Where the numbers came from; `unknown` when the log has none (nothing is guessed). */
  source: 'codex-log' | 'codex-json' | 'codex-rollout' | 'claude-json' | 'grok-end' | 'opencode-json' | 'unknown';
  cache_write_tokens?: number; reasoning_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  turns?: number;
  /** US dollars. */
  cost_usd?: number;
  /** true: the cost was calculated from the worker's price per million tokens; false or absent: the engine reported it. */
  cost_estimated?: boolean;
}

export interface OrderSpend {
  total_tokens: number;
  /** Left out when no run has a cost (the engine printed none and the worker has no price). */
  cost_usd?: number;
  /** Part of the cost is an estimate from a price table. */
  estimated: boolean;
  runs_with_usage: number;
  runs_unknown: number;
  cap_usd?: number;
  /** Approved quotes and what was spent against them, by unit (`credits`, `usd`, ...). Units are never added together. */
  credits?: Record<string, { approved: number; spent: number; pending: number }>;
  /** The cost has reached the cap: the tick does not start more runs of this order. */
  over_cap: boolean;
}

export interface Report {
  designChanges?: string[];
  seq: number;
  at: string;
  run?: string;
  status: ReportStatus;
  /** Changes a worker would like made to a shared skill: the path and a sentence why. Nothing is changed for it; a person decides. */
  skillSuggestions?: SkillSuggestion[];
  summary: string;
  question?: string;
  /** 2 to 4 choices for the question, the recommended one first. */
  options?: QuestionOption[];
  /** For a `waiting` report: a card to click, or an answer to give. */
  waitingFor?: WaitingFor;
  /** . `project`: the question is a set of candidates for the whole project (also listed in `GET /api/picks`). */
  scope?: 'order' | 'project';
  evidence: string[];
  commits: string[];
  from?: string;
  /** Not a report block: guessed from a free-text file, or read off the git state. */
  source?: 'inferred' | 'inferred-git';
  imported?: boolean;
  /** . For a `monitoring` report: what the worker handed over to be watched. */
  monitor?: MonitorSpec;
}

export interface Run {
  role?: string;
  role_source?: 'explicit' | 'kind' | 'default' | 'none';
  role_effort?: string;
  role_reasoning?: string;
  mcp_servers?: string[];
  role_warnings?: string[];
  live?: import('./live-types.ts').LiveState;
  liveSummary?: import('./live-types.ts').LiveSummary;
  id: string;
  /** `<TAG>:<id>`, the key used in `/api/runs/:key/log` and in the stream's `logs` parameter. */
  key: string;
  seq: number;
  worker: string;
  session?: string;
  started: string;
  ended?: string;
  outcome?: RunOutcome;
  /** The rework note or the answer this run was started with. */
  note?: string;
  imported: boolean;
  /** The tool started this process itself (and can read its log). */
  pid?: number;
  alive?: boolean;
  attempt?: number;
  hasLog: boolean;
  usage: RunUsage;
  /** Why this worker was chosen and why the others were not (runs the tool started on its own choice; absent when a person named the worker). */
  routing?: RunRouting;
  /** The skills that were put into the worktree for this run (names). */
  skills?: string[];
  /** . Started to continue after a monitor ended (not counted in the worker's runs of the day). */
  monitor?: boolean;
  /** The worker that had the order before it ran out of quota or capacity, and why (`on_limit: rotate`). `paid` is the target. `text` is the sentence shown on the order. */
  rotatedFrom?: { worker: string; reason: string; paid?: boolean; text?: string };
  /** . The continuation file the new worker was pointed at. */
  handoffFile?: string;
  /** The run ended at a limit: `capacity` (model service), `quota` (usage window used up), or `unreachable` (its endpoint accepted no connection). */
  limit?: 'capacity' | 'quota' | 'unreachable';
}

/** What a `run.start` event and a run carry about the choice of worker. */
export interface RunRouting {
  kind: string;
  /** In words: `codex-subscription: role build, included, role preference 1, 80% of 5 accepted`. */
  why: string;
  rejected: { worker: string; reason: string }[];
}

export interface Decision {
  seq: number;
  at: string;
  kind: 'queue' | 'cancel' | 'hold' | 'release' | 'approve' | 'rework' | 'answer' | 'monitor' | 'message';
  note?: string;
  /** For an `answer` that picked option N of the waiting report. */
  choice?: number;
  imported?: boolean;
  override?: boolean;
}

/** One entry of the event log. `id` is its position in the project's event log, counting from 1. */
export interface OrderEvent {
  id: number;
  at: string;
  tag: string;
  /** order-added, order-updated, action-<kind>, run-start, run-updated, run-end, report, check, refs-adopt, ... */
  type: string;
  /** cli, web, tick, sync, serve */
  by?: string;
  data?: Record<string, unknown>;
}

export interface CheckItem { name: string; ok: boolean; detail: string }
export interface CheckRef {
  name: string;
  status: 'same' | 'different' | 'missing' | 'new';
  reference?: string;
  got?: string;
  from?: string;
  why?: string;
}

/** The result of `alba check`, as recorded on the order (`lastCheck`) and as returned by `POST /api/check/:tag`. */
export interface CheckResult {
  lint?: CheckItem[];
  report?: number;
  delivery?: boolean;
  tag: string;
  at: string;
  ok: boolean;
  base: string;
  worktree: string;
  general: CheckItem[];
  results?: string[];
  refs?: { same: number; other: CheckRef[] };
}

/** The result of deterministic acceptance gates, as returned by `POST /api/orders/:tag/verify`. */
export interface VerifyItem { name: string; status: 'pass' | 'fail' | 'warn'; reason: string; file?: string; details?: Record<string, unknown> }
export interface VerifyResult { tag: string; at: string; run?: string; results: VerifyItem[]; ok: boolean; exitCode: 0 | 1 }

/** The line of an order in lists and on the overview. */
export interface OrderSummary {
  nextWorker?: string;
  review?: 'manual' | 'auto';
  lintBounced?: boolean;
  live?: import('./live-types.ts').LiveState;
  unanswered?: import('./live-types.ts').OutboxEntry[];
  project: string;
  tag: string;
  title: string;
  kind: string;
  heavy?: string;
  stage: Stage;
  /** The fact the stage was inferred from, in words. */
  why: string;
  /** Set for `awaiting-user` and `blocked`: what the order waits for. `answer` is only offered when it is `answer`. */
  waitingFor?: WaitingFor;
  worker?: string;
  tags?: string[];
  /** How the order was classified (kind and extra tags), when it has been. */
  routing?: Routing;
  needs: string[];
  updated: string;
  /** The report that is current for the stage (for the stages a person must act on). */
  report?: Report;
  /** Open run, when there is one. */
  run?: { id: string; key: string; worker: string; started: string; imported: boolean; alive?: boolean };
  /** Minutes without a commit or log growth, for a running order the tool can see. */
  quietMinutes?: number;
  /** A command the worker started that has not finished yet. */
  openCommand?: string;
  spend?: OrderSpend;
  /** The branch of the order's work; absent for an order that never had one (imported from a table): approving it then needs a branch named (`ActionRequest.branch`). */
  branch?: string;
  /** . The monitor of an order in stage `monitoring`. */
  monitor?: Omit<MonitorView, 'spec' | 'tail'>;
  /** . The worker's own step list (`<TAG>.progress.json`): step 3 of 7. */
  progress?: ProgressView;
  /** . Resources the order holds a lease on or is waiting for. */
  uses?: string[];
  /** What can be done now: the actions that the stage allows. */
  actions: OrderAction[];
}

export interface OrderDefinition {
  nextWorker?: string;
  review?: 'manual' | 'auto';
  planned?: boolean;
  intent?: string;
  role?: string;
  tag: string;
  title: string;
  kind: string;
  heavy?: string;
  needs: string[];
  condition?: string;
  worker?: string;
  /** . Resources (under `resources` in the project file) a run of this order holds a lease on. */
  uses?: string[];
  /** Words that pick lessons from the project's lesson library for this order's prompt, and skills (a skill with a tag in common is put into the worktree). */
  tags?: string[];
  /** Skills named on the order: always put into the worktree. */
  skills?: string[];
  /** The kind and extra tags the order was classified as (absent before the first classification). */
  routing?: Routing;
  mandate?: Mandate;
  branch?: string;
  base_ref?: string;
  worktree?: string;
  created: string;
  updated: string;
}

// ---------------------------------------------------------------------------------------------------------------- routing and skills ()

/**
 * What an order is: one main kind and any number of extra tags. `source`: `table` (a word of the dispatch table row said it),
 * `manual` (a person gave the kind), `rules` (the project's `kinds` rules matched the order's title and text),
 * `model` (the project's classifier worker answered), `none` (nothing decided: the order is unclassified).
 * The rules are read again every time (a change to the project's kinds takes effect at once); a model's answer is kept until the work-order text changes.
 */
export interface Routing { kind: string; tags: string[]; source: 'table' | 'manual' | 'rules' | 'model' | 'none'; why: string; at: string }

/** How often a worker's runs of one kind were accepted without being sent back. `rate` is only there with at least 3 samples. */
export interface WorkerKindHistory { kind: string; accepted: number; reworked: number; samples: number; rate?: number }

/** One worker looked at for one order. */
export interface RouteCandidate {
  preferred?: boolean;
  worker: string;
  /** Zero-based position in the role's ordered prefer list; unlisted supply sorts last. */
  preference?: number;
  warnings?: string[];
  cost: 'included' | 'paid';
  running: number;
  concurrency: number;
  history?: { samples: number; rate?: number };
  /** chosen; passed-over (qualified, another ranks higher); unavailable (qualified but at a limit or switched off); unfit (fails role restrictions). */
  verdict: 'chosen' | 'passed-over' | 'unavailable' | 'unfit';
  reason: string;
}

/** `GET /api/orders/:tag/route` and `POST /api/orders/:tag/classify`: the choice of worker for one order, calculated, nothing started. */
export interface Route {
  role?: import('../roles/config.ts').ResolvedRole;
  project: string;
  tag: string;
  routing: Routing;
  /** The order's worker text named workers by id or alias, overriding role restrictions with capability warnings. */
  named?: 'id' | 'alias';
  /** chosen; nobody-fits (no role or qualifying supply: a person must fix it); none-available (qualifying supply is at a limit: it waits). */
  outcome: 'chosen' | 'nobody-fits' | 'none-available';
  chosen?: string;
  /** The role's best qualifying worker before availability limits (the one the order waits for). */
  ideal?: string;
  /** One sentence for the whole decision. */
  why: string;
  /** Best first. */
  candidates: RouteCandidate[];
}

/** `POST /api/orders/:tag/classify`: classify again; `model` lets the classifier worker be asked when the rules decide nothing. */
export interface ClassifyRequest { project?: string; model?: boolean }

export interface SkillSuggestion { path: string; reason: string }

/** A skill folder of the registry: `<dir>/SKILL.md` with `name` and `description` in its front matter. */
export interface SkillInfo {
  name: string;
  description: string;
  /** Front matter tags, the source's tags and the registry's tags for this skill. */
  tags: string[];
  source: string;
  /** The folder in the shared source (never written to). */
  dir: string;
  files: number;
  bytes: number;
  /** . `global`: from a source of the workers file (this machine); `project`: from a source of the project's own. */
  scope: 'global' | 'project';
  /** The engines it is for (`unity`, `unreal`, `godot`, ...); empty: any. From its front matter `engines`, the source, or the folder name of a library (`unity/`, `godot/`). */
  engines: string[];
}

export type SkillLayer = 'core' | 'project' | 'order';

export interface SkillSourceInfo { id: string; dir: string; exists: boolean; count: number; tags: string[]; problem?: string; /**  */ scope: 'global' | 'project' }

/** Where an engine's skills are put in a worktree. */
export interface SkillMountInfo { worker: string; engine: string; mounts: string[] }

/** `POST /api/skills/use`: the project uses (`use: true`: put in `skills.include`, out of `skills.exclude`) or does not use (`use: false`: into `skills.exclude`, out of `include`) a skill. Edits the project file like a workers edit: validated, backed up, comments kept, `skills.edited` event. */
export interface SkillUseRequest { project?: string; name: string; use: boolean }

/** The answer of a write to a project file. */
export interface ConfigEditResult { ok: true; file: string; changed: string[]; backup?: string }

/** `GET /api/skills?project=` */
export interface SkillsView {
  project: string;
  sources: SkillSourceInfo[];
  skills: (SkillInfo & {
    /** Why it is attached anywhere: `core` always; `project` (`skills.always` / `skills.by_kind`); `order` (a tag shared with an order, or named on it). */
    layers: SkillLayer[];
    usedBy: { orders: string[]; workers: string[] };
    /** . Can this project use it: the project's own skills always; a global one only if the project's engine and its include/exclude let it through. */
    applicable: boolean;
    /** Why it is not applicable (`engine unity, project is unreal`, `excluded by name`, `excluded by tag ui`). */
    inapplicable?: string;
    /** The project's `skills.include` / `skills.exclude` name it (by name; a tag rule is not shown here). */
    included: boolean;
    excluded: boolean;
  })[];
  /** . The engine the project declared (`skills.engine`), if any. */
  engine?: string;
  include: string[];
  exclude: string[];
  always: string[];
  byKind: Record<string, string[]>;
  mounts: SkillMountInfo[];
  /** Registry problems in words (a source folder is missing, two skills share a name, a skill has no name). */
  problems: string[];
}

export interface OrderSkill {
  name: string;
  description: string;
  layer: SkillLayer;
  /** In words: `always`, `kind build`, `tag build`, `named on the order`. */
  why: string;
  /** SKILL.md as the worker sees it, relative to the worktree. */
  path: string;
}

/** `GET /api/orders/:tag/skills`: the skills this order gets at its next run, and what workers suggested to change. */
export interface OrderSkills {
  project: string;
  tag: string;
  skills: OrderSkill[];
  mountedAt: string[];
  suggestions: (SkillSuggestion & { run?: string; at: string })[];
}

/** `GET /api/orders/:tag` */
export interface OrderDetail {
  reroutes?: { id: string; at: string; from: string; to: string; note: string; brief: string }[];
  producerNotes?: { project: string; order: string };
  acceptance?: import('../review/acceptance.ts').AcceptanceCard;
  accounting?: { rows: import('../usage/types.ts').UsageRow[]; signals: import('../usage/types.ts').UsageSignal[]; total: import('../usage/types.ts').UsageTotal; reworkShare: number; resumeShare: number; warnings: { order?: string; text: string }[] };
  thread?: import('./live-types.ts').ThreadEntry[];
  project: string;
  order: OrderDefinition;
  stage: Stage;
  why: string;
  /** Each tag in `needs` with its stage. */
  needsStatus: { tag: string; stage?: Stage }[];
  actions: OrderAction[];
  /** Why an action is not available now, by action name (the stage's reason). */
  unavailable: Partial<Record<OrderAction, string>>;
  runs: Run[];
  reports: Report[];
  decisions: Decision[];
  waitingFor?: WaitingFor;
  /** Ledger entries named in the order's mandate, title, condition or work-order file (by id). */
  referencedDecisions: DecisionEntry[];
  /** Questions with options asked on this order (not the one inside a waiting report). */
  questions: Question[];
  /** Quotes for paid resources, with their ledger. */
  quotes: Quote[];
  /** The lessons that match the order's tags (what a prompt carries). */
  lessons: Lesson[];
  lastCheck?: CheckResult;
  deliveryLint?: CheckResult;
  verify?: VerifyResult;
  spend?: OrderSpend;
  /** . The monitor of an order in stage `monitoring`. */
  monitor?: MonitorView;
  /** . The step list of the open run (`<TAG>.progress.json`). */
  progress?: ProgressView;
  /** . Calls other tools recorded under this order's worktree (`usage_ledgers`), by ledger. */
  externalCalls?: OrderExternalCalls[];
  /** Notes (rework, answer, monitor, message) that no later run has really followed. Oldest first. */
  pendingNotes: { kind: 'rework' | 'answer' | 'monitor' | 'message'; text: string; at: string; question?: string }[];
  /** Messages left in the worktree inbox for the open run, oldest first. `seen` is set once the worker has read one. */
  messages: { at: string; author: string; text: string; seen?: string }[];
  /** The commit reminder for the open run, when one has been sent. */
  commitNudge?: { at: string; count: number; files: number; minutes: number };
  /** The newest events of this order, oldest first (at most 200); `eventsTotal` counts all. */
  events: OrderEvent[];
  eventsTotal: number;
  /** The work-order file, when there is one (text cut at 200 KB). */
  file?: { path: string; markdown: string; truncated: boolean };
  worktree?: string;
}

// ---------------------------------------------------------------------------------------------------------------- overview

export interface Problem {
  /** . For `looping`: the repeated command, its error and how many times (or minutes). */
  evidence?: string[];
  /** stalled | maybe-finished | no-report | quota | no-worker (qualifying supply cannot start now) | no-fit (missing role or qualifying supply) | launch | spend | config (a changed configuration file was refused and the old one is still in use) | looping (the run repeats itself) | start-failed (no start receipt) | lease-expired (a resource lease outlived its time) | monitor (a monitor could not be checked) | commit-nudge (changed files and no commit, reminded twice) */
  kind: string;
  tag?: string;
  text: string;
}

export interface QuotaWindow { name: string; usedPercent: number; resetsAt?: string }

/** One reading of a quota source. */
export interface QuotaPoint {
  source: string;
  at: string;
  ok: boolean;
  error?: string;
  windows: QuotaWindow[];
  balance?: { raw: string; amount?: number };
}

export interface Worker {
  id: string;
  engine: string;
  route?: string;
  paid: boolean;
  concurrency: number;
  dailyRuns?: number;
  capabilities: string[];
  extraCapabilities?: string[];
  notes?: string;
  model?: string;
  maxTokensPerRun?: number;
  /** `included` (inside a subscription window) or `paid`. */
  cost: 'included' | 'paid';
  /** Accepted vs sent back, per kind (only kinds with runs that have a verdict). */

  enabled: boolean;
  /** Only a person can start it (from a card in a session of its own). */
  cardOnly: boolean;
  /** The engine can continue its conversation, so `answer` resumes it. */
  canResume: boolean;
  available: boolean;
  /** Why it is not available (empty when it is). */
  reasons: string[];
  running: number;
  runsToday: number;
  quota?: QuotaPoint;
  /** US dollars per million tokens, from the private workers file; used for estimates. */
  price?: { input_per_mtok?: number; output_per_mtok?: number; per_mtok?: number };
  dailyCapUsd?: number;
  spendTodayUsd: number;
  /** The daily cap is reached: the tick does not start anything on this worker. */
  overCap: boolean;
  /** . Words in an order's worker text that mean this worker. */
  aliases: string[];
  /** The quota source it is measured against; workers with the same source share one subscription or balance. */
  quotaSource?: string;
  /** The other workers on the same quota source ("same subscription"). */
  sharesQuotaWith: string[];
  /** The model behind it (`grok-4.7`), for "same model, different shell"; free text from the workers file. */
  modelFamily?: string;
  /** The other workers with the same `modelFamily`. */
  sameModelAs: string[];
  /** The rules that switch it off (window used up to a percent, balance drop). */
  disabledWhen: { window?: string; at?: number; balanceDrop?: number }[];
  /** It has a `launch` template (alba can start it). */
  hasLaunch: boolean;
  /** What to do when it hits a capacity error or its quota window is used up: `wait` (resume on the same worker) or `rotate` (hand the order to the next worker). */
  onLimit: 'wait' | 'rotate';
  /** With `onLimit: rotate`, a capacity or quota ending may hand the order to a worker whose cost is paid. */
  rotatePaid: boolean;
  /** The registry machine it runs on (`host` in the workers file); absent for a worker on the machine running alba. */
  host?: string;
}

// ---------------------------------------------------------------------------------------------------------------- editing the workers file ()

/**
 * `PUT /api/workers/:id`: change one worker in the workers file. The file is edited in place with its comments and order kept;
 * the old file is first copied to `workers.yaml.bak-<time>` (the newest 20 are kept); the change is validated as the whole file
 * before anything is written, and an invalid change is refused with `details` and nothing is written. A write also records a
 * `workers.edited` event and the running `alba serve` reloads the file.
 * Fields in `set`: supply fields such as `notes`, `capabilities`, `model`, `cost`, `concurrency`, `daily_runs`, `enabled`, `aliases`, `disabled_when`
 * (`{window_full, at}` | `{balance_drop}`), `daily_cap_usd`, `model_family`, `on_limit`, `rotate_paid`, `max_resumes`,
 * `resume_backoff_minutes`, `route`, `quota`, `price`, `kinds`, `skills_mount`.
 * `null` removes a key. `yaml` replaces the whole worker with this YAML (the "advanced" editor, including `launch`); give
 * either `set` or `yaml`. A value in `launch.env` that looks like a key (`sk-...`, a long random string) is refused: use a
 * command that reads the key from a file. `dryRun: true` validates and answers without writing.
 */
export interface WorkerEditRequest { project?: string; set?: Record<string, unknown>; yaml?: string; dryRun?: boolean }

/** `POST /api/workers`: a new worker, as `yaml`, or a copy of `copyFrom` with `set` applied (`id` is the new id). */
export interface NewWorkerRequest { project?: string; id: string; copyFrom?: string; set?: Record<string, unknown>; yaml?: string; dryRun?: boolean }

export interface WorkerEditResult {
  ok: true;
  id: string;
  /** Dotted names of what changed: `capabilities`, `concurrency`, `launch.args`, or `*` for a new worker. */
  changed: string[];
  /** Absolute path of the workers file. */
  file: string;
  /** The backup made before writing (absent for a dry run or when nothing changed). */
  backup?: string;
  dryRun: boolean;
  /** The worker as it is now (after the reload); absent for a dry run. */
  worker?: Worker;
}

/** `GET /api/workers/:id/yaml`: the worker's own YAML, as written in the file (comments inside it kept). */
export interface WorkerYaml { id: string; file: string; yaml: string }

/** `GET /api/overview`. Every `count` equals the length of its `items`. */
export interface Overview {
  project: string;
  name: string;
  at: string;
  /** Orders only a person can move: awaiting-user, awaiting-review, blocked, failed, dropped. */
  needsYou: { count: number; items: OrderSummary[] };
  /** What is wrong: stalled runs, quota trouble, unlaunchable orders, spend over its cap. */
  problems: { count: number; items: Problem[] };
  running: { count: number; items: OrderSummary[] };
  /** Quotes for paid resources that wait for approval. */
  pendingQuotes: { count: number; items: Quote[] };
  /** . Pick sets nobody has chosen yet (absent when there are none). */
  pendingPicks?: { count: number; items: { id: string; title: string; order?: string; options: number }[] };
  workers: { count: number; items: Worker[] };
  /** Orders per stage. */
  stages: Partial<Record<Stage, number>>;
  /** What the tick would do now (moves) and what it holds back, in words. */
  next: { moves: { tag: string; mode: 'dispatch' | 'resume' | 'card'; worker: string }[]; heldBack: { tag: string; why: string }[] };
  /** Set when reading quota or the machine failed; the lists above are still valid. */
  error?: string;
  machine?: { freeRamGb?: number; minFreeRamGb?: number };
}

/** `GET /api/orders` */
export interface OrderList { project: string; stage?: Stage; count: number; items: OrderSummary[] }

// ---------------------------------------------------------------------------------------------------------------- diff and logs

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'other';
  insertions: number;
  deletions: number;
  binary: boolean;
  /** Unified diff of this file; absent for a binary file or when it was left out (see `note`). */
  patch?: string;
  truncated: boolean;
  note?: string;
}

/** `GET /api/orders/:tag/diff`: the branch against its base (`base...HEAD`). */
export interface OrderDiff {
  project: string;
  tag: string;
  base: string;
  head: string;
  worktree: string;
  commits: { hash: string; subject: string; at: string }[];
  stat: { files: number; insertions: number; deletions: number };
  files: DiffFile[];
  /** Set when files or patches were left out to keep the answer small. */
  truncated: boolean;
  note?: string;
}

/** One other order that changed some of the same files. `files` has at most 10 paths. */
export interface ReadinessOverlap {
  tag: string;
  files: string[];
}

/**
 * `GET /api/orders/:tag/readiness`: the order's branch against its base, without merging.
 * An order with no branch is 404, not this object.
 */
export interface MergeReadiness {
  project: string;
  tag: string;
  branch: string;
  /** The base ref, without a `refs/heads/` prefix. */
  base: string;
  /** Commits on the base that the branch does not have. */
  behind: number;
  /** Commits on the branch that the base does not have. */
  ahead: number;
  /** Merging the branch into the base would conflict. */
  conflicts: boolean;
  /** Files that would conflict. Empty when `conflicts` is false. */
  conflictFiles: string[];
  /** Files the branch changed since the merge base. */
  files: string[];
  /** Other orders in `running` or `awaiting-review` that changed some of the same files. */
  overlaps: ReadinessOverlap[];
  /** When this answer was made. */
  computedAt: string;
}

/** `GET /api/runs/:key/log` */
export interface RunLog {
  project: string;
  key: string;
  /** The last `tail` lines (at most 2000). */
  lines: string[];
  /** Byte offset of the end of the file now; the stream's `run.log` events continue from here. */
  offset: number;
  size: number;
  /** Lines before the first one returned were cut. */
  cut: boolean;
}

// ---------------------------------------------------------------------------------------------------------------- quota

/** `GET /api/quota/history?worker=` */
export interface QuotaHistory { worker?: string; source?: string; points: QuotaPoint[] }

/** `GET /api/workers` */
export interface WorkerList { workers: Worker[]; sources: { source: string; latest?: QuotaPoint }[] }

// ---------------------------------------------------------------------------------------------------------------- writes

/** `POST /api/orders` */
export interface NewOrderRequest {
  role?: string;
  project?: string;
  tag: string;
  title: string;
  kind?: string;
  needs?: string[];
  worker?: string;
  heavy?: string;
  /** The local branch the order starts from instead of the project's base. */
  base_ref?: string;
  tags?: string[];
  /** Skills (names from the registry) that this order always gets. */
  skills?: string[];
  mandate?: Mandate;
  /** Markdown text of the work order. When given, it is written to `<work_orders>/<TAG>-<slug>.md` (an existing file is never replaced). */
  body?: string;
  /** Part of the file name; made from the title when left out. */
  slug?: string;
  /** Queue the order right away. */
  queue?: boolean;
}
export interface NewOrderResult {
  order: OrderSummary;
  /** The file that was written, when `body` was given. */
  file?: string;
  /** A row was added to the project's dispatch table. */
  tableRow: boolean;
  /** The project asks for table rows but this one could not be added (the order and the file exist anyway). */
  tableWarning?: string;
}

/** `POST /api/orders/:tag/actions` */
export interface ActionRequest {
  project?: string;
  action: OrderAction;
  /** Required for `rework`; optional for approve, hold, cancel. */
  note?: string;
  /** Required for `answer` unless `choice` is given: the reply to the worker's question. */
  text?: string;
  /** For `answer`: option N (from 1) of the waiting report's options; `text` then becomes the note. */
  choice?: number;
  /** For `run`: which worker (defaults to the one the tick would choose). */
  worker?: string;
  /** For `approve` of an order with no branch recorded (one imported from a table): the branch is recorded, then checked to be merged as usual. */
  branch?: string;
}
export interface ActionResult {
  ok: true;
  tag: string;
  stage: Stage;
  why: string;
  /** A sentence about what happened (the merge check of approve, the run that was started, ...). */
  message?: string;
  /** `answer` and `run` start a process. */
  run?: { id: string; key: string; worker: string; pid?: number; resumed: boolean };
}

/** `POST /api/orders/:tag/say`: a message for a running order. Without `restart` it is left in the worktree inbox. With `restart` the run's own process is stopped and a new run carries the message. */
export interface SayRequest { project?: string; text: string; restart?: boolean; reply?: string }
export interface SayResult {
  ok: true;
  tag: string;
  stage: Stage;
  message: string;
  restarted: boolean;
  run?: { id: string; key: string; worker: string; pid?: number; resumed: boolean };
}

/** `POST /api/tick` */
export interface TickRequest { project?: string; /** false (default): a dry run, nothing is started or recorded. */ real?: boolean; maxDispatch?: number }
export interface TickView {
  project: string;
  at: string;
  real: boolean;
  exitCode: 0 | 1 | 2;
  needsUser: { stage: Stage; tags: string[] }[];
  problems: Problem[];
  /** `why` is the reason for the choice of worker (and `rejected` the others', one line each). */
  moves: { tag: string; mode: 'dispatch' | 'resume' | 'card'; worker: string; rework: boolean; /** . The order was handed over from this worker because of a limit. */ rotated?: { from: string; reason: string }; why?: string; rejected?: { worker: string; reason: string }[] }[];
  heldBack: { tag: string; why: string }[];
  unavailable: { worker: string; reasons: string[] }[];
  waiting: { tag: string; text: string }[];
  /** . Orders whose long job the monitor is watching. */
  monitoring: { tag: string; text: string }[];
  finishes: { tag: string; run: string; outcome: string; why: string }[];
  /** What a real tick did. */
  done: string[];
  /** The same text as `alba tick` prints. */
  text: string;
}

/** `POST /api/check/:tag` */
export interface CheckRequest { project?: string; results?: string[]; worktree?: string }

// ---------------------------------------------------------------------------------------------------------------- stream

/**
 * `GET /api/stream`: Server-Sent Events. Every message has an `id` (`<boot>.<n>`) and one of these names; `data` is JSON of the given type.
 * See docs/console/010-api.md for replay (`Last-Event-ID`) and the `logs` parameter.
 */
export interface StreamEvents {
  'run.activity': { project: string; tag: string; key: string; live: import('./live-types.ts').LiveState };
  /** First message of every connection. */
  hello: { boot: string; project: string; at: string; replayed: number };
  /** The client's `Last-Event-ID` is unknown or too old: read the lists again with the plain calls. */
  resync: { reason: string };
  /** Entries of the event log, named after the entry's type. */
  'order.added': OrderEvent & { project: string };
  'order.updated': OrderEvent & { project: string };
  'order.action': OrderEvent & { project: string };
  'order.report': OrderEvent & { project: string };
  'run.start': OrderEvent & { project: string };
  'run.updated': OrderEvent & { project: string };
  'run.end': OrderEvent & { project: string };
  'check.done': OrderEvent & { project: string };
  'refs.adopted': OrderEvent & { project: string };
  'decision.added': OrderEvent & { project: string };
  /** : a worker was edited, added or copied in the workers file. */
  'workers.edited': OrderEvent & { project: string };
  /** : the project's `skills.include` / `skills.exclude` changed. */
  'skills.edited': OrderEvent & { project: string };
  'question.asked': OrderEvent & { project: string };
  'question.answered': OrderEvent & { project: string };
  /** A quote was made, approved, rejected, or money was spent against it. */
  'credits.changed': OrderEvent & { project: string };
  'clean.done': OrderEvent & { project: string };
  /** `alba serve` changed something by itself: a configuration file was reloaded or refused, a changed dispatch table was imported or refused. */
  'serve.notice': { project: string; at: string; kind: 'config-reloaded' | 'config-invalid' | 'table-imported' | 'table-import-failed'; text: string };
  /** Any entry type not listed above. */
  'log.other': OrderEvent & { project: string };
  /** New lines at the end of a run's log, for the runs named in `logs`. Not replayed. */
  'run.log': { project: string; key: string; lines: string[]; offset: number };
  /** The quota readings changed (a tick read a new value). */
  quota: { project: string; points: QuotaPoint[] };
  /** A tick finished: `source` says what started it. */
  'tick.done': { project: string; at: string; source: 'schedule' | 'finish' | 'event' | 'api' | 'start'; real: boolean; exitCode: number; done: string[]; problems: number };
}
export type StreamEventName = keyof StreamEvents;

// ---------------------------------------------------------------------------------------------------------------- runs of all orders

/** A run with the order it belongs to. */
export interface RunRow extends Run { project: string; tag: string; title: string; stage: Stage }

/** `GET /api/runs?project=&since=&worker=&limit=&cursor=`: runs of every order, newest first. `since` is an ISO time (runs started at or after it). */
export interface RunList {
  project: string;
  count: number;
  items: RunRow[];
  /** Give it as `cursor` to read the next page; absent on the last page. */
  next?: string;
}

// ---------------------------------------------------------------------------------------------------------------- decisions

/** One decision of the project's ledger. */
export interface DecisionEntry {
  /** Original ledger spelling; id remains canonical for references. */
  displayId?: string;
  /** `D2031`: the project's prefix and a number. */
  id: string;
  number: number;
  /** YYYY-MM-DD */
  date: string;
  text: string;
  /** The user's own words, or the fixed phrase for a default. */
  source: string;
  sourceKind: 'quote' | 'default' | 'imported';
  /** Who recorded it (cli, web) and when; absent for entries imported from the project's table. */
  by?: string;
  at?: string;
  /** . The heading of the section of the file whose table it was read from. */
  topic?: string;
}

/** `GET /api/decisions?project=`: the ledger, oldest first. */
export interface DecisionList {
  /** Opaque offset for the next server-filtered page; `next` remains the next decision number. */
  nextCursor?: string;
  project: string;
  count: number;
  items: DecisionEntry[];
  /** The numbers the reviewer may hand out (from the project file), when configured. */
  reviewerRange?: [number, number];
  /** The id the next decision would get. */
  next: string;
  /** Numbers set aside on open orders (from their mandate); a new decision may not fall in them. */
  reserved: { tag: string; range: [number, number] }[];
  /** . The sections the entries were read from, in file order (with `section: "*"`). */
  topics: string[];
  /** . Numbers that appear in more than one place of the file: the later one is kept, the others are listed. */
  duplicates: { id: string; topics: string[] }[];
}

/** `POST /api/decisions`: `source` (the user's words) or `default: true` is required. `id` is optional and checked like a handed-out one. */
export interface NewDecisionRequest {
  project?: string;
  text: string;
  source?: string;
  default?: boolean;
  date?: string;
  id?: string;
  /** Records the decision on behalf of an order that has a number range reserved: the id comes from that range. */
  order?: string;
}

// ---------------------------------------------------------------------------------------------------------------- questions with options

export interface QuestionOption {
  /** `"1"`, `"2"`, ...: the position, from 1. */
  key: string;
  label: string;
  note?: string;
  /** Image files (paths for `GET /api/files`); the board shows thumbnails. */
  images: string[];
  /** The first option is the recommended one. */
  recommended: boolean;
}

export interface Question {
  id: string;
  text: string;
  options: QuestionOption[];
  askedBy: string;
  at: string;
  /** Who chose, when, and the note. */
  answered?: { choice: string[]; note?: string; by: string; who?: string; at: string };
}

/** `POST /api/orders/:tag/questions`: 2 to 4 options, the recommended one first. */
export interface NewQuestionRequest {
  project?: string;
  text: string;
  options: { label: string; note?: string; images?: string[] }[];
}

/** `POST /api/orders/:tag/questions/:id/answer` */
export interface QuestionAnswerRequest { project?: string; choice: number; note?: string; /** A name to record besides the channel (web, cli). */ who?: string }

// ---------------------------------------------------------------------------------------------------------------- evidence

export interface EvidenceFile {
  /** The file's path, forward slashes; give it to `GET /api/files`. */
  path: string;
  name: string;
  kind: 'image' | 'video' | 'other';
  size: number;
  modified: string;
  /** Read from the file header for png, jpeg and gif. */
  width?: number;
  height?: number;
  /** Where the listing found it: named in a report's `evidence`, in an evidence folder, or as an image of a question's option. */
  from: 'report' | 'folder' | 'question';
}

/** `GET /api/orders/:tag/evidence` */
export interface EvidenceList {
  project: string;
  tag: string;
  files: EvidenceFile[];
  /** The folders that were looked in. */
  folders: string[];
  note?: string;
}

// `GET /api/files?project=&path=&tag=`: the bytes of an image or video file (png, jpg, gif, webp, bmp, mp4, webm, mov), with `Range` support.
// The path must be inside the project's folder, its work-order or state folder, a worktree of the project or a configured evidence folder
// (links that lead out of them are refused). A relative path is read from the order's worktree (when `tag` is given), then from the project.

// ---------------------------------------------------------------------------------------------------------------- clean

export interface CleanItem {
  kind: 'worktree' | 'build' | 'main' | 'package' | 'log';
  pathClass?: 'worktrees' | 'caches' | 'builds' | 'packages' | 'logs';
  signature?: string;
  path: string;
  branch?: string;
  /** The order that owns the worktree, when there is one. */
  tag?: string;
  /** remove: the worktree and its merged branch; prune: only the listed folders; delete: a build folder; keep, skip: nothing. */
  action: 'remove' | 'prune' | 'delete' | 'keep' | 'skip';
  reason: string;
  /** Folders (relative to the path) that would be deleted. */
  targets: string[];
  /** Junctions and symbolic links found near the top of the tree; they are removed first. */
  links: number;
  bytes?: number;
  measuredBytes?: number; // Lower bound when size measurement was incomplete.
  /** After `alba clean --apply`: what happened. */
  result?: string;
}

/** `GET /api/clean?project=`: the plan only. Applying it is `alba clean --apply` on the command line. */
export interface CleanPlan {
  project: string;
  at: string;
  items: CleanItem[];
  /** Why parts of the plan are cautious (the process list could not be read, a git call failed). */
  errors: string[];
  drives?: { path: string; free_gb?: number; min_free_gb: number; low: boolean; error?: string }[];
}

// ---------------------------------------------------------------------------------------------------------------- credits

/** `unknown`: the real cost is not known; `amount` is the most it may have cost. `key` makes the booking idempotent. */
export interface LedgerEntry { at: string; amount: number; what: string; by: string; unknown?: true; key?: string }

/** A quote for a paid resource (generated images, model calls...) on an order. The executor may only spend within an approved cap. */
export interface Quote {
  id: string;
  project: string;
  tag: string;
  service: string;
  /** `credits`, `usd`, ... Quotes in different units are never added together. */
  unit: string;
  unitPrice?: number;
  quantity?: number;
  total?: number;
  /** What the executor asks to be allowed to spend. */
  capRequested: number;
  note?: string;
  created: string;
  by: string;
  status: 'pending' | 'approved' | 'rejected';
  approval?: { cap: number; note?: string; by: string; at: string };
  spent: number;
  /** Set aside by the gate for calls about to be made (holds that have not lapsed). */
  held?: number;
  /** Approved cap minus spent and held; absent until approved. */
  remaining?: number;
  ledger: LedgerEntry[];
}

/** `GET /api/credits?project=&status=`: quotes of all orders. */
export interface QuoteList { project: string; count: number; items: Quote[] }

/** `POST /api/orders/:tag/quotes` */
export interface NewQuoteRequest { project?: string; id?: string; service: string; unit?: string; unitPrice?: number; quantity?: number; capRequested: number; note?: string }
/** `POST /api/orders/:tag/quotes/:id/approve`: the cap is what the person allows, whatever was asked. */
export interface QuoteApproveRequest { project?: string; cap: number; note?: string }
export interface QuoteRejectRequest { project?: string; note?: string }
/** `POST /api/orders/:tag/quotes/:id/spend`: books money spent (refused above the approved cap). */
export interface QuoteSpendRequest { project?: string; amount: number; what: string }

// ---------------------------------------------------------------------------------------------------------------- lessons

export interface Lesson {
  id: string;
  title: string;
  tags: string[];
  rule: string;
  why?: string;
  /** The file it is in, relative to the library folder. */
  file: string;
  /** Optional classification label in the Alba lesson format. */
  level?: string;
  /** The projects it is for (ids or names); absent: every project. */
  projects?: string[];
  /** Whether the lesson applies to this project, by configured project IDs or names. */
  appliesToProject: boolean;
  /** The open orders whose prompt would carry it (their tags plus their kind, mapped by the project's `lessons.kind_tags`). */
  orders: string[];
}

/** `GET /api/lessons?project=&tag=&applies=1`: `applies=1` leaves out the lessons of other projects. */
export interface LessonList { project: string; count: number; items: Lesson[] }

// ---------------------------------------------------------------------------------------------------------------- monitors, leases, loops, rotation, receipts ()

/**
 * One condition of a monitor: exactly one key. `exit_code`: the check command exits with this code; `file_exists`: this file exists
 * (relative to the check's folder); `output_matches`: this regular expression matches the output of the check.
 */
export type MonitorCriterion = { exit_code: number } | { file_exists: string } | { output_matches: string };

/**
 * What a worker hands over by ending its round with `{"status":"monitoring","monitor":{...}}`: a long job (a build, a package step, a
 * remote run) that is already running on its own, and a cheap read-only command that tells whether it is over. The order's stage is
 * `monitoring`: it holds no worker slot and costs no quota window. Each tick runs `check` (with a timeout, in `cwd`, which must be the
 * order's worktree or a folder the project allows). When `done_when` or `fail_when` is met, or `deadline_minutes` have passed, the order
 * is queued again and the same worker continues the same session; its prompt says what the monitor found, the end of the output
 * and `note`. A continuation goes before new orders.
 */
export interface MonitorSpec {
  check: string[];
  cwd?: string;
  done_when: MonitorCriterion;
  fail_when?: MonitorCriterion;
  deadline_minutes: number;
  note?: string;
}

/** What the monitor of an order is doing now. */
export interface MonitorView {
  spec: MonitorSpec;
  started: string;
  /** When the order is continued whatever the check says. */
  deadline: string;
  checks: number;
  lastCheckAt?: string;
  /** `waiting` (neither condition met), or how it ended: `done`, `failed`, `deadline`, `refused` (the check could not be run: its folder is not allowed). */
  lastResult?: 'waiting' | 'done' | 'failed' | 'deadline' | 'refused';
  /** The end of the last check's output. */
  tail?: string;
}

/** The worker's own list of steps, `<TAG>.progress.json` in the work-order folder: `{"plan":[{"step":"...","status":"done|doing|todo"}],"note":"..."}`, replaced as a whole each time. */
export interface ProgressView {
  plan: { step: string; status: string }[];
  /** Steps with status `done`. */
  done: number;
  total: number;
  /** The step being worked on (the first `doing`, else the first not done). */
  current?: string;
  note?: string;
  /** When the file was written. */
  at: string;
}

/** A hold on part of a shared resource (`resources` in the project file) by one order. It is kept while the order runs or is monitored, and released when it ends. */
export interface Lease {
  resource: string;
  tag: string;
  run?: string;
  since: string;
  /** After this the lease is listed as a problem until it ends or is released by a person. */
  expires: string;
  expired: boolean;
  heldMinutes: number;
}

export interface ResourceView {
  name: string;
  slots: number;
  /** Leases held now. */
  used: number;
  note?: string;
  /** While it is held, no other order of the kinds in `blocks` is started, and an order that uses it waits until none of them runs. */
  exclusive: boolean;
  blocks: string[];
  leases: Lease[];
}

/** `GET /api/resources?project=` */
export interface ResourceList { project: string; resources: ResourceView[] }

/** `POST /api/leases/release`: a person takes back a lease (one that was not released, a run that is gone). Records a `lease-released` event. */
export interface LeaseReleaseRequest { project?: string; resource: string; tag: string }
export interface LeaseReleaseResult { ok: true; resource: string; tag: string; released: boolean }

// ---------------------------------------------------------------------------------------------------------------- art library, project-level picks, imported spend, outside usage ()

/** A picture a file names: a path relative to the project folder, and whether it is there. Bytes: `GET /api/files?project=&path=`. */
export interface LibraryImage { path: string; exists: boolean }

/** One choice of a pick set. */
export interface PickOption { key: string; label: string; images: LibraryImage[]; note?: string }

/** What was chosen, by whom, and whether it still counts. */
export interface PickChoice {
  choice: string[];
  note?: string;
  at: string;
  by: string;
  who?: string;
  /** `alba`: made here (kept in the state folder); `external`: read from an external records file (read only). */
  source: 'alba' | 'external';
  /** The file of the set changed after the choice was made: it is shown, but it does not count. */
  stale: boolean;
}

/**
 * A question that belongs to the project, not to one order: candidates to pick from. It comes from a file in the project's pick folder
 * (`picks: { dir, format }` in the project file) or from a worker's report that says `"scope": "project"`.
 * `pending`: nobody chose; `chosen`: chosen, and no decision written down yet (the console offers to record one); `decided`: the file has a
 * `decision` field, or the decisions ledger names `picks:<id>`.
 */
export interface PickSet {
  id: string;
  title: string;
  question: string;
  /** The order that raised it. */
  order?: string;
  multi: boolean;
  options: PickOption[];
  state: 'pending' | 'chosen' | 'decided';
  decision?: string;
  /** The pick file, relative to the project folder; absent for a question from a report. */
  file?: string;
  /** Fingerprint of the file (sha256). A choice made against another fingerprint is stale. */
  fingerprint?: string;
  source: 'file' | 'report';
  /** For a question from a report: the order it waits on; choosing answers that order too. */
  waitingOrder?: string;
  choice?: PickChoice;
  /** The newest choice that no longer counts because the file changed. */
  staleChoice?: PickChoice;
  /** What is wrong with the file (a missing picture, a key twice, ...). The set is still shown. */
  problems: string[];
  /** For `chosen`: the text to put in the decisions ledger (what was chosen, with `picks:<id>`). */
  decisionDraft?: string;
}

/** `GET /api/picks?project=` */
export interface PickList {
  project: string;
  /** `picks` is in the project file, or some question came from a report. */
  enabled: boolean;
  sets: PickSet[];
  /** Files that could not be read as a pick set, and why. */
  unreadable: { file: string; reason: string }[];
  /** Lines of the records file that could not be read. */
  recordProblems: string[];
  counts: { pending: number; chosen: number; decided: number; unreadable: number };
}

/** `POST /api/picks/:id/choose`: `fingerprint` (from the list) makes the call fail when the file changed since it was read. */
export interface PickChooseRequest { project?: string; choice: string[]; note?: string; who?: string; fingerprint?: string }
export interface PickChooseResult { set: PickSet; answeredOrder?: string }

/** One picture of the reference board. `cached`: a copy is kept in the state folder (or in an external cache the project reads). */
export interface ArtRef {
  id: string;
  /** The address of the picture (https). */
  image: string;
  page?: string;
  title: string;
  work?: string;
  tags: string[];
  /** What to learn from it. */
  learn?: string;
  added?: string;
  cached: boolean;
  /** Where the copy is: `alba` (state folder) or `external` (an external cache, read only). */
  cacheFrom?: 'alba' | 'external';
  /** Why the picture could not be fetched, from the last `alba refs fetch`. */
  failure?: string;
  problems: string[];
}

export type SettingStatus = 'text-draft' | 'text-approved' | 'sheets' | 'final';

/** The confirmation of a setting's text: a record of its sha256, who, when, and whether the text is still the same. */
export interface SettingConfirmation { at: string; by: string; who?: string; note?: string; source: 'alba' | 'external'; textSha256: string; valid: boolean }

export interface ArtSetting {
  id: string;
  title: string;
  kind?: string;
  /** As written in the file. `standard` is false for words other than the four statuses (`concept`, `draft`...). */
  status: string;
  standard: boolean;
  /** `path/to/file.md#anchor` */
  text: string;
  /** The section of the Markdown file the anchor points to; absent when the file or the anchor is gone. */
  body?: string;
  textSha256?: string;
  refs: string[];
  /** Reference cards among `refs`. */
  refCards: ArtRef[];
  images: LibraryImage[];
  decision?: string;
  confirmation?: SettingConfirmation;
  /** The text is confirmed and unchanged since. No picture is made before this, not even a test picture (document 015). */
  confirmed: boolean;
  /** What the file says wrong: dead anchor, pictures on a draft, no decision on a non-draft, picture paths in `refs`. */
  problems: string[];
}

/** `GET /api/art?project=` */
export interface ArtView {
  project: string;
  enabled: boolean;
  refs: ArtRef[];
  tags: { tag: string; count: number }[];
  settings: ArtSetting[];
  /** Names of the files in `compare/` (listed only). */
  compare: string[];
  problems: string[];
  cache: { dir?: string; cached: number; failures: { id: string; image: string; reason: string }[] };
}

/** `POST /api/art/settings/:id/approve`: confirm the text; `fingerprint` is the text's sha256 as read. */
export interface SettingApproveRequest { project?: string; note?: string; who?: string; fingerprint?: string }

/** A line of a spend file, whatever the file's shape. */
export interface SpendEntry { at?: string; asset?: string; op?: string; order?: string; task?: string; before?: number; after?: number; credits: number; status?: string; note?: string }

export interface SpendApproval { cap: number; note?: string; at: string; by: string; source: 'alba' | 'external'; stale: boolean }

/** A quote file of the project's credits folder, with what was spent against it. */
export interface SpendQuote {
  id: string;
  service?: string;
  order?: string;
  created?: string;
  /** `quote_status` as written: exact, estimate, unknown, unknown_pricing_contract_expired... `statusKnown` is false for any other word. */
  status?: string;
  statusKnown: boolean;
  /** Number of items, or the list's length. */
  items?: number;
  total?: number | null;
  estimate?: { perItem?: string | number; total?: number; basis?: string };
  capRequested?: number;
  notes?: string;
  file: string;
  fingerprint: string;
  state: 'pending' | 'approved' | 'stale';
  approval?: SpendApproval;
  entries: SpendEntry[];
  /** The spend file read for this quote, relative to the project folder. */
  spendFile?: string;
  spent: number;
  remaining?: number;
  /** The wallet after the last entry, when the file says. */
  balance?: number;
  /** What is wrong: a broken balance chain, spend over the approved cap, a shape that could not be read. The quote is still shown. */
  problems: string[];
}

/** `GET /api/spend?project=`: the project's quote files with their spend and approvals; the quotes of orders are `GET /api/credits`. */
export interface SpendView {
  project: string;
  enabled: boolean;
  quotes: SpendQuote[];
  unreadable: { file: string; reason: string }[];
  recordProblems: string[];
  counts: { quotes: number; withProblems: number; pending: number; approved: number; stale: number; unreadable: number };
}

/** `POST /api/spend/:id/approve` */
export interface SpendApproveRequest { project?: string; cap: number; note?: string; who?: string; fingerprint?: string }

/** Calls recorded by a tool outside alba (an image generator, for example) and attributed to the project by the folder they ran in. */
export interface UsageLedgerView {
  id: string;
  file: string;
  ok: boolean;
  problem?: string;
  /** Lines that belong to this project, and all lines read. */
  calls: number;
  lines: number;
  /** Lines that could not be read. */
  unreadable: number;
  first?: string;
  last?: string;
}

/** `GET /api/usage?project=&days=` (days: 7 by default). Times in a ledger without a zone are read as the machine's local time. */
export interface ExternalUsage {
  project: string;
  enabled: boolean;
  days: number;
  ledgers: UsageLedgerView[];
  /** Per local day and model: successful and failed calls, newest day first. */
  byDay: { day: string; model: string; ledger: string; ok: number; failed: number }[];
  byModel: { model: string; ledger: string; ok: number; failed: number }[];
  total: { ok: number; failed: number };
}

/** Calls an order made from its worktree, by ledger (in `OrderDetail.externalCalls`). */
export interface OrderExternalCalls { ledger: string; ok: number; failed: number }
// ---------------------------------------------------------------------------------------------------------------- documents

/** A heading of a project document (level 1–3). `slug` is the anchor. `line` is 1-based. */
export interface DocHeading {
  level: 1 | 2 | 3;
  text: string;
  slug: string;
  line: number;
}

/** One Markdown file from `docs` in the project file. A plain path that is not written yet has `exists: false` and no `modified`. */
export interface DocEntry {
  /** Relative to the project root, forward slashes. */
  path: string;
  /** The first `#` heading, otherwise the file name. */
  title: string;
  /** `research` when the file is under `docs.research`, otherwise `docs`. */
  group: 'docs' | 'research';
  exists: boolean;
  bytes: number;
  modified?: string;
  headings: DocHeading[];
}

/** `GET /api/docs?project=`. `enabled` is false when the project file has no `docs` section; `note` then says how to turn it on. */
export interface DocList {
  project: string;
  enabled: boolean;
  items: DocEntry[];
  note?: string;
}

/** `GET /api/docs/file?project=&path=`: the raw Markdown. The path is a listed document, or a `.md` file under the folder of one, and its real path stays inside the project root. */
export interface DocFile {
  project: string;
  path: string;
  title: string;
  group: 'docs' | 'research';
  headings: DocHeading[];
  markdown: string;
}

/** One full-text hit. The matched text in `snippet` is wrapped in U+0001 and U+0002. `heading` is the nearest heading above the match (its slug is empty when the match is above every heading). */
export interface DocSearchHit {
  path: string;
  title: string;
  heading: { text: string; slug: string };
  /** 1-based line of the match. */
  line: number;
  snippet: string;
}

/** `GET /api/docs/search?project=&q=&limit=`. `limit` defaults to 30 and is at most 100. A query of 200 characters or more is a 400. */
export interface DocSearch {
  project: string;
  q: string;
  count: number;
  items: DocSearchHit[];
}

/** Project-scoped director conversation, read independently of the producer facts page. */
export interface ProducerChatView {
  session?: import('../producer/session.ts').ProducerSessionStatus;
  facts?: NonNullable<ProducerFacts['snapshot']>['facts'];
  nextCursor?: string;
  messages: import('../producer/conversation-state.ts').DirectorMessage[];
  direction: import('../producer/conversation-state.ts').DirectionVersion;
  directionProposals: import('../producer/conversation-state.ts').DirectionProposal[];
  actions: ProducerAction[];
}

export interface ProducerWorkspace extends ProducerChatView {
  project: string; enabled: boolean; paused: boolean;
  session: import('../producer/session.ts').ProducerSessionStatus;
  daily: { turns: number; tokens: number }; budget?: number;
  rules: ProducerPolicyRule[]; quickPrompts?: string[]; tagPattern: string;
  constraint: NonNullable<NonNullable<ProducerFacts['snapshot']>['analysis']>['constraint'] | null;
  facts: NonNullable<ProducerFacts['snapshot']>['facts'];
  questions: { id: string; at: string; text: string; order: string }[];
}
export type DraftView = { action?: ProducerAction; preview?: ReturnType<typeof import('../producer/drafting.ts').draftPreview> } & ReturnType<typeof import('../producer/work-sessions.ts').draftWorkView>;
/** `POST /api/orders/:tag/draft-again {project, brief?}`: a new draft session of a planned order (409 with the reason when it cannot start now). */
export type DraftAgainResult = ReturnType<typeof import('../producer/work-sessions.ts').draftWorkView>;
export type PlanRequest = import('../orders/planned.ts').PlanInput & { project: string };

/** `GET /api/producer/config`: the text of the `producer:` section of the project file. */
export type { ProducerConfigView, ProducerConfigEdit, DiffLine } from '../producer/config-edit.ts';
