import { parsePhases, validatePhaseWorkers, type Phases } from './orders/phase-config.ts';
import { loadWorkers as loadPhaseWorkers } from './workers/config.ts';
import { validateDrafting, type DraftingConfig } from './producer/drafting-config.ts';
import { gatesConfig } from './gates/config.ts';
import { validateFoundations } from './foundations/config.ts';
import { roundConfig, monitorConfig, type RoundConfig, type MonitorConfig } from './producer/round-config.ts';
import { validateAccept, type AcceptConfig } from './review/accept-config.ts';
import { validateCapture, type CaptureConfig } from './capture/config.ts';
import { safePackageRoot } from './clean/safety.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Roles } from './roles/config.ts';
import { routingOf } from './workers/config.ts';
import path from 'node:path';
import { parse } from 'yaml';
import { STAGES, normalizeSparseDirs, type Stage } from './orders/model.ts';
import { fail } from './i18n.ts';
import { ENGINES, normalizeEngine, validateSourceList, type SkillSourceConfig } from './skills/sources.ts';
import { validateArt, validateCredits, validatePicks, validateUsageLedgers, type ArtConfig, type CreditsConfig, type PicksConfig, type UsageLedgerConfig } from './library/config.ts';
import { validatePlugins } from './plugins/registry.ts';
import { validateEditors } from './editors/config.ts';
import { validateRelease, type ReleaseConfig } from './release/config.ts';
import { validateSchedules, type ScheduleConfig } from './schedules/config.ts';
export type { ScheduleConfig };

export interface DispatchRules {
  caps: Record<string, number>;
  min_free_ram_gb?: number;
  stall_minutes?: number;
  worktree_parent?: string;
  base_ref?: string;
  sparse?: string[];                // cone-mode directories checked out in new worktrees (relative, no "..")
  checkout_workers: number;         // git checkout.workers concurrency for sparse worktrees (default 4)
  port_base?: number;               // optional base port for ALBA_PORT_BASE (= port_base + slot * port_block)
  port_block: number;               // port stride per run slot (default 10)
  long_command_minutes: number;     // a worker whose last command is still running is waiting, not stalled, for this long
  rework_reserve: number;           // extra slots per capped class that only reworked orders may use
  provision?: string[];             // command run in a new worktree (program and arguments, no shell)
  accept_command?: string[];        // mechanical acceptance run by `review approve`; may use {tag} and {cwd}
  merge: 'manual';                  // how work gets into the base branch: a person merges, approve only checks
  start_receipt_minutes: number;    // a run with no progress file and no commit after this long failed to start (default 15)
  on_loop: 'report' | 'stop';       // a run that repeats itself is reported (default), or its process is stopped as well
  on_stall: 'report' | 'continue';  // a run with no commit past stall_minutes is reported (default), or stopped and continued once on the same worker
  max_reworks?: number;             // send-backs of one order before another one is refused without --force (default: no limit)
  on_lingering: 'report' | 'stop';  // a run whose log already ends with the report block but whose process is still there: reported (default), or that process is stopped and the report read
  lingering_minutes: number;        // how long the log must be quiet after the report block (default 10)
  loop_idle_minutes: number;        // output grows but no commit and no new command for this long counts as idling (default 45)
  loop_repeat: number;              // the same command with the same error this many times counts as a loop (default 3)
  loop_alternate: number;           // two commands taking turns this many rounds counts as a loop (default 6)
  long_commands: string[];          // words of commands that legitimately run for a long time (a build, a package step); they never count as idling (default: empty)
  monitor_dirs: string[];           // folders (besides an order's worktree and the project root) where a monitor's check command may run
  monitor_timeout_seconds: number;  // one check command is stopped after this long (default 120)
  commit_nudge_minutes: number;     // a running order with changed files and no commit for this long gets one inbox reminder (default 45); 0 turns it off
  auto_merge_base: boolean;         // merge the base branch into a local order worktree before delivery lint when checks.base_merged is on (default true)
}

/** A shared thing orders compete for (a machine, a lane of builds): at most `slots` leases at a time. */
export interface ResourceConfig {
  slots: number;
  scope?: 'project' | 'machine';    // default 'project'; 'machine' shares slots and a queue across projects on this OS account
  note?: string;
  exclusive: boolean;               // while it is held no other order of the `blocks` kinds is started, and an order that uses it waits until none of those runs
  blocks: string[];                 // kinds an exclusive resource keeps out (default: empty)
  lease_minutes: number;            // a lease older than this is listed as a problem (default 480)
  match?: string;                   // regular expression: an order whose title, condition or work-order text matches uses this resource without saying so
}

export interface TableConfig {
  file: string;
  section?: string;                 // pick the first table after a heading containing this text
  status_column: number;            // 1-based
  order_column: number;
  worker_column?: number;
  needs_column?: number;
  status_map: Record<string, Stage>;
  card_words?: string[];            // status words (a subset of status_map's) that mean "a card waits for a click" rather than "a question waits for an answer"
  tag_pattern: string;              // regular expression source for a tag
  tag_exclude?: string;             // tags matching this are not tags (e.g. decision numbers)
  untagged: 'error' | 'synthetic';
  merged_list?: { prefix: string }; // a line "<prefix>A, B, C" naming orders that are already merged
  needs_markers?: string[];         // when set, only plain tag lists and tags written right before one of these words (or the merged marker) are needs
  base_pattern?: string;            // regular expression with one group: the branch an order starts from, found anywhere in its row
  merged_marker?: string;           // in the needs column, tags written right before this word ("A, B <marker>") are already merged
  default_kind?: string;
  write_back: boolean;              // a new order made through the board or `orders add --table` gets a row in this table (off unless the project asks for it)
  kind_rules: KindRule[];           // set kind (and heavy class) from the words of a table row
}

/** What `alba sync` may conclude from git alone. */
export interface SyncRules {
  git_signal: boolean;              // off unless the project asks for it
  git_subject: string;              // regular expression (case-insensitive) the last commit's subject must match
}

/** What `alba check` looks at before a person accepts an order. Every general item can be switched off. */
export interface ChecksConfig {
  report_required?: boolean;
  revision_is_head?: boolean;
  base_merged?: boolean | { max_behind: number };
  base_intact?: boolean;            // default: on when base_merged is on
  generated_paths?: string[];
  evidence_required?: boolean;
  report_must_match?: { pattern: string; message: string }[];
  report_must_not_match?: { pattern: string; message: string }[];
  clean_worktree: boolean;          // no uncommitted files
  ahead_of_base: boolean;           // the branch has commits the base does not have
  protected_paths: string[];        // globs, relative to the repository: none may differ from the base
  forbidden_tracked: string[];      // globs: none may be added or changed in the branch
  encoding_scan: boolean;           // no run of 4 or more "?" and no U+FFFD in the lines the branch added
  max_new_file_kb?: number;         // the largest file the branch may add
  references?: string;              // yaml of reference values: name -> {value, source, updated}
  result_parser?: string;           // regular expression with the named groups "name" and "value", applied to every match in a line
}

/** Deterministic acceptance-gate files that require a person's decision when changed. */
export interface ScreenshotVerifyConfig {
  duplicate_diff: number;
  blank_std: number;
  dark_mean: number;
  dark_fraction: number;
  luminance?: LuminanceGate[];
  motion?: MotionGate[];
}
export interface LuminanceGate { match: string; mean_min?: number; mean_max?: number; region?: [number, number, number, number] }
export interface MotionGate { a: string; b: string; min?: number; max?: number; region?: [number, number, number, number] }
export const DEFAULT_SCREENSHOT_THRESHOLDS: ScreenshotVerifyConfig = { duplicate_diff: 0.015, blank_std: 0.02, dark_mean: 0.12, dark_fraction: 0.85 };
export interface VerifyConfig { protected_gates: string[]; screenshots: ScreenshotVerifyConfig | 'off'; max_visual_rounds: number }

/** The decisions ledger: its own entries are kept in the state folder; a Markdown table of the project can be read in as well (never changed). */
export interface DecisionsConfig {
  stateProject?: Pick<ProjectConfig, 'state_dir' | 'state'>;
  file?: string;                    // a Markdown file with a table of decisions, read, never written
  section?: string;                 // pick the first table after a heading containing this text
  all_tables: boolean;              // read every table of the file whose rows hold decision numbers (`section: "*"` says the same); the section heading is the entry's topic
  id_column: number;                // 1-based; the cell holds the number (`D2031`, `2031`)
  date_column?: number;
  text_column: number;
  source_column?: number;           // the user's words, or the note that it is a default
  id_prefix: string;                // `D`
  reviewer_range?: [number, number]; // the numbers a reviewer hands out; workers keep to the range on their order
  store: string;                    // the ledger entries made with `alba decide` (default: <state_dir>/decisions.jsonl)
}

/** Where evidence images and videos are looked for, besides the files a report names. */
export interface EvidenceConfig {
  dirs: string[];                   // folders (`{tag}` is the order's tag); relative ones are read from the order's worktree, then the project
}

export interface LessonsConfig {
  dir: string;                      // the first folder of `dirs`
  dirs: string[];                   // folders of Markdown files (the project's own, the studio's, ...), then Alba's packs
  packs: string[];                  // Alba's built-in lesson packs the project uses (templates/lessons/<pack>)
  format: 'alba';
  max_rule_lines: number;           // a long rule is cut to this many lines in a prompt (default 6)
  max_bytes: number;                // UTF-8 byte budget for the rendered lessons section (default 6000; 0 = no limit)
  max_items: number;                // maximum mounted lessons in a prompt (default 15; 0 = no limit)
  level_order?: string[];           // level texts ordered highest first; absent = levels do not rank
  kind_tags: Record<string, string[]>;  // an order's kind also counts as these tags (`build: [build, engine]`); the kind itself always counts
}

/**
 * Markdown documents of the project, shown in the console. Without this section the documents page is off.
 * `files` are paths or globs relative to the project root. `research` is a folder whose files are a separate group.
 */
export interface DocsConfig {
  files: string[];
  research?: string;
}

/** Default worktree-relative globs treated as regenerable ignored paths by `alba clean`. */
export const DEFAULT_CLEAN_REGENERABLE = [
  'node_modules/',
  '**/Intermediate/',
  '**/Binaries/',
  '**/DerivedDataCache/',
  '**/__pycache__/',
  '**/*.log',
] as const;

/** What `alba clean` may remove. Without this section it only looks at merged, idle, clean worktrees. */
export interface CleanConfig {
  drives?: { path: string; min_free_gb: number }[];
  packages?: { dir: string; keep: number; links_from?: string[]; prefix?: string }[];   // prefix: only folders named <prefix><tag>... (a builds folder shared by projects)
  logs_days?: number;
  min_gain_gb?: number;
  auto_classes?: string[];
  auto_destructive?: boolean;
  snapshot_entries?: number;       // full artifact snapshot limit (default 100000)
  snapshot_seconds?: number;       // full artifact snapshot time limit (default 5)
  idle_hours: number;               // a merged worktree is removed when its last change is older than this
  caches: string[];                 // folders (relative to a worktree) that are deleted from worktrees whose work is not merged yet
  regenerable?: string[];           // worktree-relative globs for ignored paths safe to delete when removing a worktree
  builds: { dir: string; keep: number }[];   // folders of builds (relative to the project); only the newest `keep` subfolders stay
  busy_processes: string[];         // program names; while one of them runs nothing is deleted
}

export interface KindRule { match: string; kind?: string; heavy?: string; tags?: string[]; uses?: string[] }

/** A kind of order the project knows, with the words that give it away. Declared order is priority. */
export interface KindDef {
  id: string;
  description: string;
  match: string[];                  // regular expressions tried against the order's title and the start of its work-order text
  ignore_case: boolean;
  tag_only: boolean;                // never the main kind, only an extra tag (e.g. "visual" next to "build")
  title_only: boolean;              // look at the order's title only (a work-order text mentions many things in passing)
}

/** Which worker is asked to classify an order the rules cannot place. */
export interface ClassifierConfig {
  worker?: string;
  max_chars: number;                // how much of the work-order text it is shown
  timeout_seconds: number;
  max_per_pass: number;             // at most this many questions to the worker per import or pass
  parallel: number;                 // how many questions run at once (default 1)
}

/** The project layer of the skills an order gets: names that are always put in, and names by kind. */
export interface ProjectSkills {
  always: string[];
  by_kind: Record<string, string[]>;
  max_per_order: number;
  /** The project's own skill folders (next to the global ones of the workers file). */
  sources: SkillSourceConfig[];
  /** The engine of the project (`unreal`, `unity`, `godot`, `any`): global skills made for another engine are not used. Absent: no filter by engine. */
  engine?: string;
  /** Global skills to use whatever their engine, by name or tag. */
  include: string[];
  /** Global skills not to use in this project, by name or tag. Wins over `include`. */
  exclude: string[];
}

export interface OrderTemplateConfig {
  file?: string;
  acceptance?: string[];
  evidence?: string[];
  paths?: string[];
  rules?: string[];
}

export interface PreflightToolDir {
  dir: string;
  kinds?: string[];
}

export interface OrdersPreflightConfig {
  mode: 'hold' | 'warn' | 'off';
  run_checks: boolean;
  check_timeout_seconds: number;
  tool_dirs: Record<string, PreflightToolDir>;
}

export interface OrdersConfig {
  templates: Record<string, OrderTemplateConfig>;
  preflight: OrdersPreflightConfig;
}

export type FirstPassMode = 'off' | 'advise' | 'bounce';
export interface FirstPassConfig {
  mode: FirstPassMode;
  kinds?: string[];
  minutes: number;
}

export interface ProjectConfig {
  phases?: Phases;
  /** Per-kind order templates and preflight rules (`orders:` in alba.yaml). */
  orders?: OrdersConfig;
  /** Recurring schedules that create orders on a timetable (`schedules:` in alba.yaml). */
  schedules?: ScheduleConfig[];
  /** Selects a machine engine module; no engine is selected by default. */
  engine?: string;
  release?: ReleaseConfig;
  /** Who accepts an order that does not say (`review` of the order wins): `manual`, a person; `auto` (the default), the producer may too. */
  review?: 'manual' | 'auto';
  /** Cross-model first-pass review settings (`review.first_pass*` in alba.yaml). */
  first_pass?: FirstPassConfig;
  machines?: string;               // registry path; ALBA_MACHINES wins
  gates?: import('./gates/config.ts').GatesConfig;
  design?: DesignConfig;
  design_docs?: DesignDocsConfig;
  /** Documents a kind of work needs before its content orders start (`foundations:`); absent, nothing is checked. */
  foundations?: import('./foundations/config.ts').FoundationsConfig;
  intake?: IntakeConfig;
  accept?: AcceptConfig;
  capture?: CaptureConfig;
  roles?: Roles;
  /** `routing.groups` of the project file. */
  worker_groups?: import('./roles/config.ts').WorkerGroups;
  /** `routing.avoid` of the project file: workers no route chooses by itself. */
  routing_avoid?: string[];
  /** The project file writes `routing` (otherwise its routes, if any, are the earlier `roles`). */
  uses_routing?: true;
  drafting?: DraftingConfig;
  budget?: { tokens_per_day?: number; tokens_per_order?: number; cost_per_day?: number; currency?: string };
  usage_warnings?: import('./usage/types.ts').WasteRules;
  id: string;
  name: string;
  root: string;
  work_orders: string;
  state_dir: string;
  state: { backend: 'sqlite' | 'files' };
  dispatch_table?: TableConfig;
  decisions?: DecisionsConfig;
  evidence?: EvidenceConfig;
  lessons?: LessonsConfig;
  docs?: DocsConfig;
  clean?: CleanConfig;
  monitor?: MonitorConfig;
  kinds?: KindDef[];
  classifier?: ClassifierConfig;
  skills?: ProjectSkills;
  resources?: Record<string, ResourceConfig>;
  /** Tool plugins: which are enabled, where project plugins are, which kinds use which tools. */
  plugins?: import('./plugins/registry.ts').PluginsConfig;
  /** Editors a run can have for itself, by pool name (also a resource name). */
  editors?: Record<string, import('./editors/config.ts').EditorPool>;
  /** : project-level questions with pictures to pick from. */
  picks?: PicksConfig;
  /** : reference board, setting cards and their text confirmations. */
  art?: ArtConfig;
  /** : quote and spend files of paid generation, and the approvals of them. */
  credits?: CreditsConfig;
  /** : files in which other tools record their calls; the ones of the workers file count too. */
  usage_ledgers?: UsageLedgerConfig[];
  producer: ProducerConfig;
  dispatch: DispatchRules;
  workers?: string;                 // the workers file of this project (--workers and ALBA_WORKERS win)
  sync: SyncRules;
  checks: ChecksConfig;
  verify: VerifyConfig;
  file: string;                     // the alba.yaml this was read from
}

export type ProducerMode = 'off' | 'observe' | 'propose' | 'auto';
export const PRODUCER_ACTIONS = ['nudge', 'answer', 'queue', 'hold', 'rework', 'accept', 'accept-part', 'draft-order', 'add-order', 'broadcast', 'ask', 'note', 'close-case', 'reprioritize', 'lint-bounce', 'dispatch', 'clean', 'reroute', 'tool-call'] as const;
export type ProducerActionKind = (typeof PRODUCER_ACTIONS)[number];
export interface ProducerRule { id: string; instruction: string; action: ProducerActionKind; mode: ProducerMode }
export const PRODUCER_TRIGGERS = ['machine-down', 'delivery', 'failed', 'blocked', 'question', 'commit-reminder', 'no-report', 'loop', 'error-pattern', 'quota-unreadable', 'free-slot', 'ready-to-draft', 'stalled-run', 'monitor-stale', 'dispatch', 'repeated-failure', 'clean', 'target-failing', 'target-unmeasured', 'gap-unowned', 'idle-capacity', 'nightly-gate-failed', 'schedule-paused'] as const;
export const DEFAULT_SESSION_TRIGGERS = ['machine-down', 'delivery', 'failed', 'blocked', 'question', 'commit-reminder', 'no-report', 'loop', 'ready-to-draft', 'stalled-run', 'monitor-stale', 'dispatch', 'repeated-failure', 'clean', 'target-failing', 'target-unmeasured', 'gap-unowned', 'idle-capacity', 'nightly-gate-failed'];
export const DEFAULT_NOTICE_TRIGGERS = ['machine-down', 'gap-unowned', 'target-unmeasured', 'idle-capacity', 'commit-reminder'];
export interface ProducerEngineConfig {
  engine: 'claude' | 'codex';
  model?: string;
  cli?: string;
  profile?: string;
  config?: string[];
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
export interface ProducerSessionConfig extends ProducerEngineConfig {
  max_turns: number;
  page_chars?: number;
  notes_chars?: number;
  timeout_ms?: number;
  /** How long a detached draft, review or work session may run (minutes, default 10). `timeout_ms` is the chat deadline. */
  work_timeout_minutes?: number;
  /** How long one router turn may run before the session is stopped and started again (minutes, default 15). */
  turn_timeout_minutes?: number;
  /** Detached draft, review and work sessions running at once (default 3). */
  max_work_sessions?: number;
  error_retry_minutes?: number;
  rollover_tokens?: number;
  send_triggers?: string[];
  wake_triggers?: string[];
  notice_triggers?: string[];
  notice_max_minutes?: number;
  enabled: boolean;
}
export interface ConstraintThresholds {
  cause_shares?: Partial<Record<'environment' | 'tool' | 'capacity' | 'specification' | 'result' | 'unclassified', number>>;
  monitoring_cap_share?: number;
  acceptor_p90_hours?: number;
  first_pass_yield_min?: number;
}
export interface ProducerTrustConfig { window_days?: number; outcome_hours?: number; min_cases?: number; raise_rate?: number; lower_rate?: number }
export interface ProducerBriefConfig { every_minutes: number; daily_at?: string; language: string; command?: string[] }
export interface ProducerModelPrice { input: number; cache_read: number; cache_write: number; output: number }
export interface ProducerConfig { escalate_to?: string[]; enabled: boolean; /** Delivery reviews by detached work sessions; `false` turns them off (default on). */ reviews?: boolean; /** Skills whose text a delivery review session follows (e.g. Alba's `alba-review-bar`). */ review_skills?: string[]; rules: ProducerRule[]; budgets: { escalations_per_day?: number; turns_per_hour?: number; review_runs_per_day?: number; draft_runs_per_day?: number; usage_per_day?: number; cache_read_weight?: number; cost_per_day_usd?: number }; model_prices?: Record<string, ProducerModelPrice>; session: ProducerSessionConfig; work?: Partial<ProducerEngineConfig>; constraints?: ConstraintThresholds; quick_prompts?: string[]; trust?: ProducerTrustConfig; brief?: ProducerBriefConfig; round?: RoundConfig }

function producerEngineConfig(raw: Record<string, unknown>, at: string): Partial<ProducerEngineConfig> {
  if (raw.engine !== undefined && raw.engine !== 'claude' && raw.engine !== 'codex') throw new Error(`${at}.engine must be claude or codex.`);
  for (const key of ['model', 'cli', 'profile'] as const) if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].includes('\0'))) throw new Error(`${at}.${key} must be non-empty text without NUL.`);
  if (raw.config !== undefined && (!Array.isArray(raw.config) || raw.config.some(v => typeof v !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*=.+$/s.test(v) || v.includes('\0')))) throw new Error(`${at}.config must be a list of key=value overrides.`);
  if (raw.effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(raw.effort))) throw new Error(`${at}.effort must be none, minimal, low, medium, high, xhigh or max.`);
  return Object.fromEntries(['engine', 'model', 'cli', 'profile', 'config', 'effort'].filter(k => raw[k] !== undefined).map(k => [k, raw[k]])) as Partial<ProducerEngineConfig>;
}

/** Switching engines must not inherit another engine's executable/model/provider. */
export function producerWorkConfig(project: { producer: Pick<ProducerConfig, 'session' | 'work'> }): ProducerEngineConfig {
  const { session, work } = project.producer;
  return { ...(work?.engine && work.engine !== session.engine ? { engine: work.engine } : session), ...work };
}

export const DEFAULT_TAG_PATTERN = '[A-Za-z]+\\d+[A-Za-z]*';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateProducer(raw: unknown, file: string): ProducerConfig {
  if (raw === undefined) return { enabled: false, rules: [], budgets: {}, session: { engine: 'claude', max_turns: 40, enabled: false } };
  if (!isRecord(raw)) fail('{file}: "producer" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => !['enabled', 'rules', 'budgets', 'model_prices', 'session', 'work', 'constraints', 'quick_prompts', 'trust', 'brief', 'round', 'escalate_to', 'review_skills', 'reviews'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "producer": {keys}.', { file, keys: unknown.join(', ') });
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') fail('{file}: "producer.enabled" must be true or false.', { file });
  const rules: ProducerRule[] = [];
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) fail('{file}: "producer.rules" must be a list.', { file });
    for (const [i, value] of raw.rules.entries()) {
      const at = `${file}: "producer.rules[${i}]"`;
      if (!isRecord(value)) fail('{at} must be a mapping.', { at });
      const id = value.id, instruction = value.instruction, action = value.action, mode = value.mode ?? 'observe';
      if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) fail('{at}.id must be a short identifier.', { at });
      if (typeof instruction !== 'string' || !instruction.trim()) fail('{at}.instruction must be non-empty text.', { at });
      if (typeof action !== 'string' || !(PRODUCER_ACTIONS as readonly string[]).includes(action)) fail('{at}.action must be one of: {actions}.', { at, actions: PRODUCER_ACTIONS.join(', ') });
      if (!['off', 'observe', 'propose', 'auto'].includes(String(mode))) fail('{at}.mode must be off, observe, propose or auto.', { at });
      rules.push({ id, instruction: instruction.trim(), action: action as ProducerActionKind, mode: mode as ProducerMode });
    }
  }
  if (raw.reviews !== undefined && typeof raw.reviews !== 'boolean') fail('{file}: "producer.reviews" must be true or false.', { file });
  if (raw.review_skills !== undefined && (!Array.isArray(raw.review_skills) || raw.review_skills.some(s => typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)))) fail('{file}: "producer.review_skills" must be a list of skill names.', { file });
  if (raw.escalate_to !== undefined && (!Array.isArray(raw.escalate_to) || raw.escalate_to.some(w => typeof w !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(w)))) fail('{file}: producer.escalate_to must list worker ids.', { file });
  const budgets: ProducerConfig['budgets'] = {};
  if (raw.budgets !== undefined) {
    if (!isRecord(raw.budgets)) fail('{file}: "producer.budgets" must be a mapping.', { file });
    const keys = ['turns_per_hour', 'review_runs_per_day', 'draft_runs_per_day', 'usage_per_day', 'cache_read_weight', 'cost_per_day_usd', 'escalations_per_day'] as const;
    const bad = Object.keys(raw.budgets).filter(k => !keys.includes(k as never));
    if (bad.length) fail('{file}: unknown key(s) under "producer.budgets": {keys}.', { file, keys: bad.join(', ') });
    for (const key of keys) if (raw.budgets[key] !== undefined) {
      const value = raw.budgets[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('{file}: "producer.budgets.{key}" must be a number >= 0.', { file, key });
      budgets[key] = value;
      if (key === 'escalations_per_day' && !Number.isInteger(value)) fail('{file}: producer.budgets.escalations_per_day must be a whole number.', { file });
    }
  }
  const seen = new Set<string>();
  for (const rule of rules) if (seen.has(rule.id)) fail('{file}: duplicate producer rule id "{id}".', { file, id: rule.id }); else seen.add(rule.id);
  const sessionRaw = raw.session;
  const session: ProducerSessionConfig = { engine: 'claude', max_turns: 40, enabled: false };
  if (sessionRaw !== undefined) {
    if (!isRecord(sessionRaw)) fail('{file}: "producer.session" must be a mapping.', { file });
    const allowed = ['engine', 'model', 'cli', 'profile', 'config', 'effort', 'max_turns', 'page_chars', 'notes_chars', 'rollover_tokens', 'timeout_ms', 'work_timeout_minutes', 'turn_timeout_minutes', 'max_work_sessions', 'error_retry_minutes', 'enabled', 'send_triggers', 'wake_triggers', 'notice_triggers', 'notice_max_minutes'];
    const bad = Object.keys(sessionRaw).filter(k => !allowed.includes(k));
    if (bad.length) fail('{file}: unknown key(s) under "producer.session": {keys}.', { file, keys: bad.join(', ') });
    Object.assign(session, producerEngineConfig(sessionRaw, `${file}: producer.session`));
    for (const key of ['model', 'cli'] as const) if (sessionRaw[key] !== undefined && (typeof sessionRaw[key] !== 'string' || !sessionRaw[key].trim())) fail('{file}: "producer.session.{key}" must be non-empty text.', { file, key });
    for (const key of ['max_turns', 'page_chars', 'notes_chars', 'rollover_tokens', 'timeout_ms', 'work_timeout_minutes', 'turn_timeout_minutes', 'max_work_sessions', 'notice_max_minutes', 'error_retry_minutes'] as const) if (sessionRaw[key] !== undefined && (typeof sessionRaw[key] !== 'number' || !Number.isInteger(sessionRaw[key]) || sessionRaw[key] < 1)) fail('{file}: "producer.session.{key}" must be a whole number >= 1.', { file, key });
    if (sessionRaw.enabled !== undefined && typeof sessionRaw.enabled !== 'boolean') fail('{file}: "producer.session.enabled" must be true or false.', { file });
    for (const key of ['send_triggers', 'wake_triggers', 'notice_triggers'] as const) if (sessionRaw[key] !== undefined) {
      const values = sessionRaw[key];
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !(PRODUCER_TRIGGERS as readonly string[]).includes(value))) fail('{file}: "producer.session.{key}" must be a list of producer triggers.', { file, key });
      session[key] = [...new Set(values as string[])];
    }
    if (typeof sessionRaw.notice_max_minutes === 'number') session.notice_max_minutes = sessionRaw.notice_max_minutes;
    session.model = typeof sessionRaw.model === 'string' ? sessionRaw.model.trim() : undefined;
    session.cli = typeof sessionRaw.cli === 'string' ? sessionRaw.cli.trim() : undefined;
    if (typeof sessionRaw.max_turns === 'number') session.max_turns = sessionRaw.max_turns;
    if (typeof sessionRaw.page_chars === 'number') session.page_chars = sessionRaw.page_chars;
    if (typeof sessionRaw.notes_chars === 'number') session.notes_chars = sessionRaw.notes_chars;
    if (typeof sessionRaw.rollover_tokens === 'number') session.rollover_tokens = sessionRaw.rollover_tokens;
    if (typeof sessionRaw.timeout_ms === 'number') session.timeout_ms = sessionRaw.timeout_ms;
    if (typeof sessionRaw.work_timeout_minutes === 'number') session.work_timeout_minutes = sessionRaw.work_timeout_minutes;
    if (typeof sessionRaw.turn_timeout_minutes === 'number') session.turn_timeout_minutes = sessionRaw.turn_timeout_minutes;
    if (typeof sessionRaw.max_work_sessions === 'number') session.max_work_sessions = sessionRaw.max_work_sessions;
    if (typeof sessionRaw.error_retry_minutes === 'number') session.error_retry_minutes = sessionRaw.error_retry_minutes;
    session.enabled = sessionRaw.enabled === true;
  }
  let work: ProducerConfig['work'];
  if (raw.work !== undefined) {
    if (!isRecord(raw.work) || Object.keys(raw.work).some(k => !['engine', 'model', 'cli', 'profile', 'config', 'effort'].includes(k))) throw new Error(`${file}: producer.work must be an engine configuration mapping (engine, model, cli, profile, config, effort).`);
    work = producerEngineConfig(raw.work, `${file}: producer.work`);
  }
  for (const [name, value] of [['session', session], ['work', work ? producerWorkConfig({ producer: { session, work } }) : undefined]] as const) {
    if (value?.engine === 'claude' && (value.config?.length || value.profile)) console.warn(`${file}: producer.${name}.config/profile are ignored by the Claude engine.`);
    if (value?.engine === 'codex' && /\.(cmd|bat)$/i.test(value.cli ?? '')) console.warn(`${file}: producer.${name}.cli is a Windows batch shim; use the real Codex executable (.exe), because direct spawn cannot launch .cmd/.bat files.`);
  }
  const constraints: ConstraintThresholds = {};
  if (raw.constraints !== undefined) {
    if (!isRecord(raw.constraints)) fail('{file}: "producer.constraints" must be a mapping.', { file });
    const keys = ['cause_shares', 'monitoring_cap_share', 'acceptor_p90_hours', 'first_pass_yield_min'];
    if (Object.keys(raw.constraints).some(k => !keys.includes(k))) fail('{file}: unknown key under "producer.constraints".', { file });
    for (const key of ['monitoring_cap_share', 'acceptor_p90_hours', 'first_pass_yield_min'] as const) {
      const value = raw.constraints[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'acceptor_p90_hours' && value > 1)) fail('{file}: invalid threshold "producer.constraints.{key}" (nonnegative hours or ratio from 0 to 1 required).', { file, key });
      constraints[key] = value;
    }
    const causes = raw.constraints.cause_shares;
    if (causes !== undefined) {
      if (!isRecord(causes) || Object.entries(causes).some(([k, v]) => !['environment', 'tool', 'capacity', 'specification', 'result', 'unclassified'].includes(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) fail('{file}: "producer.constraints.cause_shares" must map known causes to ratios from 0 to 1.', { file });
      constraints.cause_shares = causes as ConstraintThresholds['cause_shares'];
    }
  }
  if (raw.quick_prompts !== undefined && (!Array.isArray(raw.quick_prompts) || raw.quick_prompts.length > 8 || raw.quick_prompts.some(v => typeof v !== 'string' || !v.trim() || v.length > 1000))) fail('{file}: "producer.quick_prompts" must contain at most eight non-empty strings of up to 1000 characters.', { file });
  let trust: ProducerTrustConfig | undefined;
  if (raw.trust !== undefined) {
    if (!isRecord(raw.trust)) fail('{file}: "producer.trust" must be a mapping.', { file });
    const keys = ['window_days', 'outcome_hours', 'min_cases', 'raise_rate', 'lower_rate'];
    if (Object.keys(raw.trust).some(k => !keys.includes(k))) fail('{file}: unknown key under "producer.trust".', { file });
    for (const [key, value] of Object.entries(raw.trust)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || (key.endsWith('_rate') ? value < 0 || value > 1 : value <= 0) || (key === 'min_cases' && !Number.isInteger(value))) fail('{file}: invalid producer trust threshold "{key}".', { file, key });
    }
    trust = raw.trust as ProducerTrustConfig;
    if ((trust.lower_rate ?? .6) >= (trust.raise_rate ?? .9)) fail('{file}: trust lower_rate must be below raise_rate.', { file });
  }
  let brief: ProducerBriefConfig | undefined;
  if (raw.brief !== undefined) {
    if (!isRecord(raw.brief) || Object.keys(raw.brief).some(k => !['every_minutes', 'daily_at', 'language', 'command'].includes(k))) fail('{file}: invalid "producer.brief" mapping.', { file });
    const b = raw.brief;
    if (typeof b.every_minutes !== 'number' || !Number.isFinite(b.every_minutes) || b.every_minutes <= 0) fail('{file}: brief every_minutes must be positive.', { file });
    if (typeof b.language !== 'string' || !b.language.trim()) fail('{file}: brief language must be non-empty text.', { file });
    if (b.daily_at !== undefined && (typeof b.daily_at !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(b.daily_at))) fail('{file}: brief daily_at must be HH:mm (UTC).', { file });
    if (b.command !== undefined && (!Array.isArray(b.command) || !b.command.length || b.command.some(v => typeof v !== 'string' || v.includes('\0')) || !b.command[0].trim())) fail('{file}: brief command must be an argv list.', { file });
    brief = b as unknown as ProducerBriefConfig;
  }
  let model_prices: ProducerConfig['model_prices'];
  if (raw.model_prices !== undefined) {
    if (!isRecord(raw.model_prices)) fail('{file}: producer.model_prices must be a mapping.', { file });
    model_prices = {};
    for (const [model, value] of Object.entries(raw.model_prices)) {
      if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'cache_read,cache_write,input,output' || Object.values(value).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) fail('{file}: producer.model_prices entries require nonnegative input, cache_read, cache_write and output USD per million tokens.', { file });
      model_prices[model] = value as unknown as ProducerModelPrice;
    }
  }
  return { enabled: raw.enabled !== false, rules, budgets, session, ...(raw.reviews === false ? { reviews: false } : {}), ...(raw.review_skills === undefined ? {} : { review_skills: raw.review_skills as string[] }), ...(raw.escalate_to === undefined ? {} : { escalate_to: raw.escalate_to as string[] }), ...(work ? { work } : {}), ...(model_prices ? { model_prices } : {}), ...(raw.round === undefined ? {} : { round: roundConfig(raw.round) }), ...(raw.constraints === undefined ? {} : { constraints }), ...(raw.quick_prompts === undefined ? {} : { quick_prompts: raw.quick_prompts as string[] }), ...(trust ? { trust } : {}), ...(brief ? { brief } : {}) };
}

export function loadProject(file: string): ProjectConfig {
  if (!existsSync(file)) fail('Project file not found: {file}', { file });
  let raw: unknown;
  try { raw = parse(readFileSync(file, 'utf8')); } catch (e) { fail('{file} is not valid YAML: {error}', { file, error: (e as Error).message }); }
  return validateProject(raw, file);
}

export function validateProject(raw: unknown, file: string): ProjectConfig {
  const base = path.dirname(path.resolve(file));
  if (!isRecord(raw)) fail('{file}: the top level must be a mapping with id, name, root, work_orders and state_dir.', { file });
  const where = (key: string) => `${file}: "${key}"`;
  const str = (key: string, source: Record<string, unknown> = raw, prefix = ''): string => {
    const v = source[key];
    if (typeof v !== 'string' || !v.trim()) fail('{where} must be a non-empty string.', { where: where(prefix + key) });
    return v.trim();
  };
  const dir = (key: string, mustExist: boolean): string => {
    const p = path.resolve(base, str(key));
    if (mustExist && !(existsSync(p) && statSync(p).isDirectory())) fail('{where} points to {path}, which is not an existing directory.', { where: where(key), path: p });
    return p;
  };
  const id = str('id');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('{where} must be lower-case letters, digits and "-".', { where: where('id') });
  const producerRaw = raw.producer;
  const cfg: ProjectConfig = {
    id, name: str('name'), root: dir('root', true), work_orders: dir('work_orders', true), state_dir: dir('state_dir', false),
    state: { backend: 'sqlite' },
    dispatch: validateDispatch(raw.dispatch, file), sync: validateSync(raw.sync, file), checks: validateChecks(raw.checks, file, base), verify: validateVerify(raw.verify, file), producer: validateProducer(producerRaw, file), file: path.resolve(file),
  };
  if (raw.engine !== undefined) {
    if (typeof raw.engine !== 'string' || !['unreal', 'unity', 'godot'].includes(raw.engine)) fail('{file}: engine must be unreal, unity or godot.', { file });
    cfg.engine = raw.engine;
  }
  if (raw.release !== undefined) cfg.release = validateRelease(raw.release, file);
  if (raw.state !== undefined) {
    if (!isRecord(raw.state)) fail('{file}: "state" must be a mapping.', { file });
    const unknownState = Object.keys(raw.state).filter(k => k !== 'backend');
    if (unknownState.length) fail('{file}: unknown key(s) under "state": {keys}.', { file, keys: unknownState.join(', ') });
    if (raw.state.backend !== 'sqlite' && raw.state.backend !== 'files') fail('{file}: "state.backend" must be "sqlite" or "files".', { file });
    cfg.state.backend = raw.state.backend;
  }
  for (const block of ['budget', 'usage_warnings'] as const) if (raw[block] !== undefined) {
    const value = raw[block];
    const keys = block === 'budget' ? ['tokens_per_day', 'tokens_per_order', 'cost_per_day', 'currency'] : ['tokens_without_commit', 'long_run_tokens', 'min_cached_share', 'command_output_bytes', 'repeated_file_reads', 'failed_repeats', 'reasoning_share', 'reasoning_by_kind'];
    if (!isRecord(value) || Object.keys(value).some(k => !keys.includes(k))) fail('Invalid usage configuration: {where}', { where: block });
    for (const [k, v] of Object.entries(value)) {
      if (k === 'currency') { if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) fail('Invalid usage configuration: {where}', { where: `${block}.${k}` }); }
      else if (k === 'reasoning_by_kind') { if (!isRecord(v) || Object.values(v).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) fail('Invalid usage configuration: {where}', { where: `${block}.${k}` }); }
      else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (['min_cached_share', 'reasoning_share'].includes(k) && v > 1) || (['failed_repeats', 'repeated_file_reads'].includes(k) && (!Number.isInteger(v) || v < 3))) fail('Invalid usage configuration: {where}', { where: `${block}.${k}` });
    }
    Object.assign(cfg, { [block]: value });
  }
  if (raw.drafting !== undefined) cfg.drafting = validateDrafting(raw.drafting, base);
  if (raw.accept !== undefined) cfg.accept = validateAccept(raw.accept, base);
  if (raw.capture !== undefined) cfg.capture = validateCapture(raw.capture, file);
  if (raw.workers !== undefined) cfg.workers = path.resolve(base, str('workers'));
  if (raw.machines !== undefined) cfg.machines = path.resolve(base, str('machines'));
  if (raw.dispatch_table !== undefined) cfg.dispatch_table = validateTable(raw.dispatch_table, file, base);
  if (raw.decisions !== undefined) cfg.decisions = validateDecisions(raw.decisions, file, base, cfg.state_dir);
  if (cfg.decisions) cfg.decisions.stateProject = { state_dir: cfg.state_dir, state: cfg.state };
  if (raw.evidence !== undefined) cfg.evidence = validateEvidence(raw.evidence, file);
  if (raw.lessons !== undefined) cfg.lessons = validateLessons(raw.lessons, file, base);
  if (raw.docs !== undefined) cfg.docs = validateDocs(raw.docs, file);
  if (raw.design !== undefined) cfg.design = validateDesign(raw.design, file, cfg.state_dir);
  if (raw.design_docs !== undefined) cfg.design_docs = validateDesignDocs(raw.design_docs, file, base, cfg.state_dir);
  if (!cfg.decisions && cfg.design_docs?.decisions) { cfg.decisions = cfg.design_docs.decisions; cfg.decisions.stateProject = { state_dir: cfg.state_dir, state: cfg.state }; }
  if (raw.foundations !== undefined) cfg.foundations = validateFoundations(raw.foundations, file);
  if (raw.intake !== undefined) cfg.intake = validateIntake(raw.intake, file);
  if (raw.clean !== undefined) cfg.clean = validateClean(raw.clean, file, cfg.root);
  if (raw.monitor !== undefined) cfg.monitor = monitorConfig(raw.monitor);
  if (raw.review !== undefined) {
    if (typeof raw.review === 'string') {
      if (raw.review !== 'manual' && raw.review !== 'auto') fail('{file}: "review" must be manual or auto.', { file });
      cfg.review = raw.review;
    } else if (isRecord(raw.review)) {
      const unknownReview = Object.keys(raw.review).filter(k => !['mode', 'first_pass', 'first_pass_kinds', 'first_pass_minutes'].includes(k));
      if (unknownReview.length) fail('{file}: unknown key(s) under "review": {keys}.', { file, keys: unknownReview.map(k => `review.${k}`).join(', ') });
      if (raw.review.mode !== undefined) {
        if (raw.review.mode !== 'manual' && raw.review.mode !== 'auto') fail('{file}: "review.mode" must be manual or auto.', { file });
        cfg.review = raw.review.mode;
      }
      if (raw.review.first_pass !== undefined && !['off', 'advise', 'bounce'].includes(raw.review.first_pass as string)) {
        fail('{file}: "review.first_pass" must be off, advise or bounce.', { file });
      }
      let kinds: string[] | undefined;
      if (raw.review.first_pass_kinds !== undefined) {
        if (!Array.isArray(raw.review.first_pass_kinds) || !raw.review.first_pass_kinds.length || raw.review.first_pass_kinds.some(x => typeof x !== 'string' || !x.trim())) {
          fail('{file}: "review.first_pass_kinds" must be a non-empty list of kinds.', { file });
        }
        kinds = [...new Set((raw.review.first_pass_kinds as string[]).map(x => x.trim()))];
      }
      let minutes = 30;
      if (raw.review.first_pass_minutes !== undefined) {
        if (typeof raw.review.first_pass_minutes !== 'number' || !Number.isFinite(raw.review.first_pass_minutes) || raw.review.first_pass_minutes <= 0) {
          fail('{file}: "review.first_pass_minutes" must be a positive number.', { file });
        }
        minutes = raw.review.first_pass_minutes;
      }
      cfg.first_pass = { mode: (raw.review.first_pass as FirstPassMode | undefined) ?? 'off', ...(kinds ? { kinds } : {}), minutes };
    } else {
      fail('{file}: "review" must be manual, auto or a mapping.', { file });
    }
  }
  if (raw.kinds !== undefined) cfg.kinds = validateKinds(raw.kinds, file);
  if (raw.classifier !== undefined) cfg.classifier = validateClassifier(raw.classifier, file);
  if (raw.skills !== undefined) cfg.skills = validateProjectSkills(raw.skills, file, base);
  Object.assign(cfg, routingOf(raw, file));
  if (raw.phases !== undefined) {
    cfg.phases = parsePhases(raw.phases);
    const workersFile = process.env.ALBA_WORKERS || cfg.workers;
    if (workersFile) validatePhaseWorkers(cfg, loadPhaseWorkers(workersFile));
  }
  if (raw.resources !== undefined) cfg.resources = validateResources(raw.resources, file);
  if (raw.plugins !== undefined) {
    cfg.plugins = validatePlugins(raw.plugins, file, base);
    // A tool's resources count like the project's own; a resource the project declares itself wins.
    for (const tool of Object.values(cfg.plugins.tools)) for (const [name, r] of Object.entries(tool.manifest.resources ?? {})) {
      if (cfg.resources?.[name]) continue;
      cfg.resources = { ...cfg.resources, [name]: { slots: r.slots, exclusive: false, blocks: [], lease_minutes: r.lease_minutes ?? 480, note: `tool ${tool.manifest.id}` } };
    }
  }
  if (raw.editors !== undefined) { const e = validateEditors(raw.editors, file, cfg.resources, cfg.dispatch.caps); cfg.editors = e.editors; cfg.resources = e.resources; }
  if (raw.gates !== undefined) cfg.gates = gatesConfig(raw.gates, cfg);
  if (raw.picks !== undefined) cfg.picks = validatePicks(raw.picks, file, base, cfg.root, id);
  if (raw.art !== undefined) cfg.art = validateArt(raw.art, file, base, cfg.root, id);
  if (raw.credits !== undefined) cfg.credits = validateCredits(raw.credits, file, base, cfg.root, id);
  if (raw.usage_ledgers !== undefined) cfg.usage_ledgers = validateUsageLedgers(raw.usage_ledgers, file, base);
  if (raw.orders !== undefined) cfg.orders = validateOrdersConfig(raw.orders, file, base);
  if (raw.schedules !== undefined) cfg.schedules = validateSchedules(raw.schedules, file, base);
  const unknown = Object.keys(raw).filter(k => !['engine', 'release', 'review', 'machines', 'gates', 'design', 'design_docs', 'foundations', 'intake', 'id', 'name', 'root', 'work_orders', 'state_dir', 'state', 'dispatch_table', 'decisions', 'evidence', 'lessons', 'docs', 'clean', 'monitor', 'kinds', 'classifier', 'skills', 'resources', 'picks', 'art', 'credits', 'usage_ledgers', 'producer', 'drafting', 'accept', 'capture', 'dispatch', 'workers', 'sync', 'checks', 'verify', 'budget', 'usage_warnings', 'roles', 'routing', 'plugins', 'editors', 'orders', 'schedules', 'phases'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s): {keys}.', { file, keys: unknown.join(', ') });
  return cfg;
}

const regexOk = (source: string, where: string, file: string): void => {
  try { new RegExp(source, 'u'); } catch (e) { fail('{file}: {where} is not a valid regular expression: {error}', { file, where, error: (e as Error).message }); }
};

function validateKinds(raw: unknown, file: string): KindDef[] {
  if (!isRecord(raw) || !Object.keys(raw).length) fail('{file}: "kinds" must map each kind to its description and rules.', { file });
  return Object.entries(raw).map(([id, v]) => {
    const at = `kinds.${id}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) fail('{file}: "{at}": a kind is letters, digits, "-" and "_".', { file, at });
    const def = typeof v === 'string' ? { description: v } : v;
    if (!isRecord(def)) fail('{file}: "{at}" must be a sentence or a mapping with "description" and optional "match".', { file, at });
    const unknown = Object.keys(def).filter(k => !['description', 'match', 'ignore_case', 'tag_only', 'title_only'].includes(k));
    if (unknown.length) fail('{file}: unknown key(s) under "{at}": {keys}.', { file, at, keys: unknown.join(', ') });
    if (typeof def.description !== 'string' || !def.description.trim()) fail('{file}: "{at}.description" must be one sentence.', { file, at });
    const m = def.match === undefined ? [] : Array.isArray(def.match) ? def.match : [def.match];
    if (m.some(x => typeof x !== 'string' || !x)) fail('{file}: "{at}.match" must be a regular expression or a list of them.', { file, at });
    for (const x of m as string[]) regexOk(x, `"${at}.match"`, file);
    for (const key of ['ignore_case', 'tag_only', 'title_only'] as const) if (def[key] !== undefined && typeof def[key] !== 'boolean') fail('{file}: "{at}.{key}" must be true or false.', { file, at, key });
    return { id, description: def.description.trim(), match: m as string[], ignore_case: def.ignore_case === true, tag_only: def.tag_only === true, title_only: def.title_only === true };
  });
}

function validateClassifier(raw: unknown, file: string): ClassifierConfig {
  if (!isRecord(raw)) fail('{file}: "classifier" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => !['worker', 'max_chars', 'timeout_seconds', 'max_per_pass', 'parallel'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "classifier": {keys}.', { file, keys: unknown.join(', ') });
  const out: ClassifierConfig = { max_chars: 4000, timeout_seconds: 180, max_per_pass: 10, parallel: 1 };
  if (raw.worker !== undefined) {
    if (typeof raw.worker !== 'string' || !raw.worker.trim()) fail('{file}: "classifier.worker" must be a worker id.', { file });
    out.worker = raw.worker.trim();
  }
  for (const key of ['max_chars', 'timeout_seconds', 'max_per_pass', 'parallel'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) fail('{file}: "classifier.{key}" must be a whole number >= 1.', { file, key });
    out[key] = v;
  }
  return out;
}

function validateProjectSkills(raw: unknown, file: string, base: string): ProjectSkills {
  if (!isRecord(raw)) fail('{file}: "skills" must be a mapping with "always" and/or "by_kind".', { file });
  const unknown = Object.keys(raw).filter(k => !['always', 'by_kind', 'max_per_order', 'sources', 'engine', 'include', 'exclude'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "skills": {keys}.', { file, keys: unknown.join(', ') });
  const names = (v: unknown, at: string): string[] => {
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) fail('{file}: "{at}" must be a list of skill names.', { file, at });
    return (v as string[]).map(x => x.trim());
  };
  const out: ProjectSkills = { always: raw.always === undefined ? [] : names(raw.always, 'skills.always'), by_kind: {}, max_per_order: 16, sources: [], include: raw.include === undefined ? [] : names(raw.include, 'skills.include'), exclude: raw.exclude === undefined ? [] : names(raw.exclude, 'skills.exclude') };
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources)) fail('{file}: "skills.sources" must be a list of folders.', { file });
    out.sources = validateSourceList(raw.sources, file, 'skills.sources', base, 'project');
  }
  if (raw.engine !== undefined) {
    const engine = typeof raw.engine === 'string' ? normalizeEngine(raw.engine) : '';
    // `other`: an engine alba has no skills for (a web game, a custom engine): skills made for unreal, unity or godot are left out.
    if (engine !== 'any' && engine !== 'other' && !(ENGINES as readonly string[]).includes(engine)) fail('{file}: "skills.engine" must be one of {list}.', { file, list: [...ENGINES, 'other', 'any'].join(', ') });
    out.engine = engine;
  }
  if (raw.by_kind !== undefined) {
    if (!isRecord(raw.by_kind)) fail('{file}: "skills.by_kind" must map a kind to a list of skill names.', { file });
    for (const [kind, list] of Object.entries(raw.by_kind)) out.by_kind[kind] = names(list, `skills.by_kind.${kind}`);
  }
  if (raw.max_per_order !== undefined) {
    if (typeof raw.max_per_order !== 'number' || !Number.isInteger(raw.max_per_order) || raw.max_per_order < 1) fail('{file}: "skills.max_per_order" must be a whole number >= 1.', { file });
    out.max_per_order = raw.max_per_order;
  }
  return out;
}

function validateDecisions(raw: unknown, file: string, base: string, stateDir: string): DecisionsConfig {
  if (!isRecord(raw)) fail('{file}: "decisions" must be a mapping.', { file });
  const at = (key: string) => `${file}: "decisions.${key}"`;
  const known = ['file', 'section', 'all_tables', 'id_column', 'date_column', 'text_column', 'source_column', 'id_prefix', 'reviewer_range', 'store'];
  const unknown = Object.keys(raw).filter(k => !known.includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "decisions": {keys}.', { file, keys: unknown.join(', ') });
  const column = (key: string, required: boolean): number | undefined => {
    const v = raw[key];
    if (v === undefined) { if (required) fail('{where} is required when a table is read (1 = first column).', { where: at(key) }); return undefined; }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) fail('{where} must be a whole number >= 1 (1 = first column).', { where: at(key) });
    return v;
  };
  const withFile = raw.file !== undefined;
  const out: DecisionsConfig = { id_column: column('id_column', withFile) ?? 1, text_column: column('text_column', withFile) ?? 2, all_tables: false, id_prefix: 'D', store: path.join(stateDir, 'decisions.jsonl') };
  if (withFile) {
    if (typeof raw.file !== 'string' || !raw.file.trim()) fail('{where} must be a path to a Markdown file.', { where: at('file') });
    out.file = path.resolve(base, raw.file.trim());
  }
  const date = column('date_column', false), source = column('source_column', false);
  if (date) out.date_column = date;
  if (source) out.source_column = source;
  if (raw.section !== undefined) { if (typeof raw.section !== 'string' || !raw.section.trim()) fail('{where} must be text.', { where: at('section') }); out.section = raw.section.trim(); }
  if (raw.all_tables !== undefined) { if (typeof raw.all_tables !== 'boolean') fail('{where} must be true or false.', { where: at('all_tables') }); out.all_tables = raw.all_tables; }
  if (out.section === '*') { out.all_tables = true; delete out.section; }
  if (raw.id_prefix !== undefined) {
    if (typeof raw.id_prefix !== 'string' || !/^[A-Za-z]{0,4}$/.test(raw.id_prefix)) fail('{where} must be up to 4 letters.', { where: at('id_prefix') });
    out.id_prefix = raw.id_prefix;
  }
  if (raw.reviewer_range !== undefined) {
    const r = raw.reviewer_range;
    if (!Array.isArray(r) || r.length !== 2 || r.some(n => typeof n !== 'number' || !Number.isInteger(n) || n < 0) || r[0] > r[1]) fail('{where} must be two whole numbers, the first not above the second.', { where: at('reviewer_range') });
    out.reviewer_range = [r[0], r[1]];
  }
  if (raw.store !== undefined) { if (typeof raw.store !== 'string' || !raw.store.trim()) fail('{where} must be a path.', { where: at('store') }); out.store = path.resolve(base, raw.store.trim()); }
  return out;
}

function validateEvidence(raw: unknown, file: string): EvidenceConfig {
  if (!isRecord(raw)) fail('{file}: "evidence" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => k !== 'dirs');
  if (unknown.length) fail('{file}: unknown key(s) under "evidence": {keys}.', { file, keys: unknown.join(', ') });
  if (!Array.isArray(raw.dirs) || raw.dirs.some(d => typeof d !== 'string' || !d.trim())) fail('{file}: "evidence.dirs" must be a list of folders ("{tag}" stands for the order\'s tag).', { file });
  return { dirs: (raw.dirs as string[]).map(d => d.trim()) };
}

/** Alba's built-in lesson packs: one folder of Markdown lessons each. */
export const LESSON_PACKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/lessons');
export const lessonPacks = (): string[] => existsSync(LESSON_PACKS) ? readdirSync(LESSON_PACKS).filter(d => statSync(path.join(LESSON_PACKS, d)).isDirectory()).sort() : [];

function validateLessons(raw: unknown, file: string, base: string): LessonsConfig {
  if (!isRecord(raw)) fail('{file}: "lessons" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => !['dir', 'packs', 'format', 'max_rule_lines', 'max_bytes', 'max_items', 'level_order', 'kind_tags'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "lessons": {keys}.', { file, keys: unknown.join(', ') });
  const known = lessonPacks();
  const packs = raw.packs === undefined ? [] : raw.packs;
  if (!Array.isArray(packs) || packs.some(p => typeof p !== 'string' || !known.includes(p))) fail('{file}: "lessons.packs" must be a list of Alba lesson packs ({list}).', { file, list: known.join(', ') });
  const list = raw.dir === undefined && packs.length ? [] : Array.isArray(raw.dir) ? raw.dir : [raw.dir];
  if ((!list.length && !packs.length) || list.some(d => typeof d !== 'string' || !d.trim())) fail('{file}: "lessons.dir" must be a folder of Markdown files, or a list of folders.', { file });
  const dirs = [...(list as string[]).map(d => path.resolve(base, d.trim())), ...(packs as string[]).map(p => path.join(LESSON_PACKS, p))];
  const format = raw.format === undefined ? 'alba' : raw.format;
  if (format !== 'alba') fail('{file}: "lessons.format" must be "alba".', { file });
  const lines = raw.max_rule_lines === undefined ? 6 : raw.max_rule_lines;
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1) fail('{file}: "lessons.max_rule_lines" must be a whole number >= 1.', { file });
  const maxBytes = raw.max_bytes === undefined ? 6000 : raw.max_bytes;
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('{file}: "lessons.max_bytes" must be a whole number >= 0.', { file });
  const maxItems = raw.max_items === undefined ? 15 : raw.max_items;
  if (typeof maxItems !== 'number' || !Number.isSafeInteger(maxItems) || maxItems < 0) fail('{file}: "lessons.max_items" must be a whole number >= 0.', { file });
  let levelOrder: string[] | undefined;
  if (raw.level_order !== undefined) {
    if (!Array.isArray(raw.level_order) || raw.level_order.some(x => typeof x !== 'string' || !x.trim())) fail('{file}: "lessons.level_order" must be a list of non-empty strings.', { file });
    levelOrder = (raw.level_order as string[]).map(x => x.trim());
  }
  const kindTags: Record<string, string[]> = {};
  if (raw.kind_tags !== undefined) {
    if (!isRecord(raw.kind_tags)) fail('{file}: "lessons.kind_tags" must map a kind to a list of tags.', { file });
    for (const [kind, tags] of Object.entries(raw.kind_tags)) {
      if (!Array.isArray(tags) || tags.some(x => typeof x !== 'string' || !x.trim())) fail('{file}: "lessons.kind_tags.{kind}" must be a list of tags.', { file, kind });
      kindTags[kind] = (tags as string[]).map(x => x.trim().toLowerCase());
    }
  }
  return { dir: dirs[0]!, dirs, packs: packs as string[], format, max_rule_lines: lines, max_bytes: maxBytes, max_items: maxItems, ...(levelOrder !== undefined ? { level_order: levelOrder } : {}), kind_tags: kindTags };
}

/** A path or glob the project file may name: relative to the project root, with no `..` segment. */
function projectRelative(raw: string, file: string, where: string): string {
  const s = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.split('/').includes('..')) fail('{file}: "{where}" must be a path inside the project, "{p}" is not.', { file, where, p: raw.trim() });
  return s.replace(/\/+$/, '');
}

export interface DesignDocEntry { id: string; path?: string; title?: string; order: number; status: 'approved' | 'draft' | 'retired' }
export interface DesignDocsConfig { files: DesignDocEntry[]; decisions?: DecisionsConfig }
export interface IntakeConfig { min_targets_per_system: number }
export interface DesignConfig { enabled: boolean; data_roots: string[]; min_targets_per_system: number; export_dir: string }
function validateDesign(raw: unknown, file: string, stateDir: string): DesignConfig {
  if (!isRecord(raw) || Object.keys(raw).some(k => !['enabled', 'data_roots', 'min_targets_per_system', 'export_dir'].includes(k))) fail('{file}: invalid design mapping.', { file });
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') fail('{file}: design.enabled must be boolean.', { file });
  const roots = raw.data_roots ?? [];
  if (!Array.isArray(roots) || roots.some(v => typeof v !== 'string' || !v.trim())) fail('{file}: design.data_roots must be a list of project-relative globs.', { file });
  const minimum = raw.min_targets_per_system ?? 3;
  if (typeof minimum !== 'number' || !Number.isSafeInteger(minimum) || minimum < 0) fail('{file}: design.min_targets_per_system must be a nonnegative integer.', { file });
  const out = raw.export_dir;
  if (out != null && (typeof out !== 'string' || !path.isAbsolute(out))) fail('{file}: design.export_dir must be an absolute folder or null.', { file });
  return { enabled: raw.enabled === true, data_roots: (roots as string[]).map(p => projectRelative(p, file, 'design.data_roots')), min_targets_per_system: minimum, export_dir: out as string ?? path.join(stateDir, 'design-export') };
}

function validateDesignDocs(raw: unknown, file: string, base: string, stateDir: string): DesignDocsConfig {
  const source = Array.isArray(raw) ? { files: raw } : raw;
  if (!isRecord(source)) fail('{file}: "design_docs" must be a list or mapping.', { file });
  const entries = source.files;
  if (!Array.isArray(entries)) fail('{file}: "design_docs.files" must be a list.', { file });
  const files: DesignDocEntry[] = entries.map((entry, index) => {
    const value = typeof entry === 'string' ? { path: entry } : entry;
    if (!isRecord(value) || typeof value.path !== 'string' || !value.path.trim()) fail('{file}: design_docs.files[{index}] needs a Markdown path.', { file, index });
    const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : path.basename(value.path.trim(), path.extname(value.path.trim())).replace(/[^A-Za-z0-9_.-]+/g, '-');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) fail('{file}: design_docs.files[{index}].id is invalid.', { file, index });
    const order = value.order === undefined ? index : value.order;
    if (typeof order !== 'number' || !Number.isSafeInteger(order)) fail('{file}: design_docs.files[{index}].order must be an integer.', { file, index });
    const status = value.status === undefined ? 'approved' : value.status;
    if (!['approved', 'draft', 'retired'].includes(String(status))) fail('{file}: design_docs.files[{index}].status must be approved, draft or retired.', { file, index });
    return { id, path: projectRelative(value.path, file, `design_docs.files[${index}].path`), ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}), order, status: status as DesignDocEntry['status'] };
  });
  if (new Set(files.map(d => d.id)).size !== files.length) fail('{file}: design_docs document ids must be unique.', { file });
  let decisions: DecisionsConfig | undefined;
  if (source.decisions !== undefined) decisions = validateDecisions(source.decisions, file, base, stateDir);
  return { files, ...(decisions ? { decisions } : {}) };
}

function validateIntake(raw: unknown, file: string): IntakeConfig {
  if (!isRecord(raw)) fail('{file}: "intake" must be a mapping.', { file });
  const value = raw.min_targets_per_system ?? 3;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('{file}: intake.min_targets_per_system must be a positive integer.', { file });
  return { min_targets_per_system: value };
}

function validateDocs(raw: unknown, file: string): DocsConfig {
  if (!isRecord(raw)) fail('{file}: "docs" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => !['files', 'research'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "docs": {keys}.', { file, keys: unknown.join(', ') });
  if (!Array.isArray(raw.files) || raw.files.some(x => typeof x !== 'string' || !x.trim())) fail('{file}: "docs.files" must be a list of paths or globs.', { file });
  const files = (raw.files as string[]).map(x => projectRelative(x, file, 'docs.files'));
  const out: DocsConfig = { files };
  if (raw.research !== undefined) {
    if (typeof raw.research !== 'string' || !raw.research.trim()) fail('{file}: "docs.research" must be a folder inside the project, "{p}" is not.', { file, p: String(raw.research) });
    out.research = projectRelative(raw.research, file, 'docs.research');
  }
  return out;
}

function validateClean(raw: unknown, file: string, root: string): CleanConfig {
  if (!isRecord(raw)) fail('{file}: "clean" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => !['idle_hours', 'caches', 'regenerable', 'builds', 'busy_processes', 'drives', 'packages', 'logs_days', 'min_gain_gb', 'auto_classes', 'auto_destructive', 'snapshot_entries', 'snapshot_seconds'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "clean": {keys}.', { file, keys: unknown.join(', ') });
  const out: CleanConfig = { idle_hours: 24, caches: [], builds: [], busy_processes: [] };
  if (raw.snapshot_entries !== undefined) {
    if (typeof raw.snapshot_entries !== 'number' || !Number.isSafeInteger(raw.snapshot_entries) || raw.snapshot_entries < 1) fail('{file}: clean.snapshot_entries must be a positive whole number.', { file });
    out.snapshot_entries = raw.snapshot_entries;
  }
  if (raw.snapshot_seconds !== undefined) {
    if (typeof raw.snapshot_seconds !== 'number' || !Number.isFinite(raw.snapshot_seconds) || raw.snapshot_seconds <= 0) fail('{file}: clean.snapshot_seconds must be a positive finite number.', { file });
    out.snapshot_seconds = raw.snapshot_seconds;
  }
  if (raw.idle_hours !== undefined) {
    if (typeof raw.idle_hours !== 'number' || !Number.isFinite(raw.idle_hours) || !(raw.idle_hours >= 0)) fail('{file}: "clean.idle_hours" must be a number of hours >= 0.', { file });
    out.idle_hours = raw.idle_hours;
  }
  const folders = (key: 'caches' | 'busy_processes'): string[] | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) fail('{file}: "clean.{key}" must be a list of text.', { file, key });
    return (v as string[]).map(x => x.trim());
  };
  out.caches = folders('caches') ?? [];
  out.busy_processes = folders('busy_processes') ?? [];
  for (const c of out.caches) if (path.isAbsolute(c) || c.split(/[\\/]/).includes('..')) fail('{file}: "clean.caches" entries are folders inside a worktree, "{c}" is not.', { file, c });
  if (raw.regenerable !== undefined) {
    if (!Array.isArray(raw.regenerable) || raw.regenerable.some(x => typeof x !== 'string' || !x.trim())) fail('{file}: "clean.regenerable" must be a list of glob patterns.', { file });
    out.regenerable = (raw.regenerable as string[]).map(x => x.trim());
    for (const p of out.regenerable) if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) fail('{file}: "clean.regenerable" entries must be relative to a worktree, "{p}" is not.', { file, p });
  }
  for (const key of ['builds', 'packages'] as const) if (raw[key] !== undefined) {
    if (!Array.isArray(raw[key])) fail('{file}: clean folder retention must be a list.', { file });
    out[key] = (raw[key] as unknown[]).map((b, i) => {
      if (!isRecord(b) || Object.keys(b).some(k => !['dir', 'keep', ...(key === 'packages' ? ['links_from', 'prefix'] : [])].includes(k)) || typeof b.dir !== 'string' || !b.dir.trim() || typeof b.keep !== 'number' || !Number.isInteger(b.keep) || b.keep < 0) fail('{file}: "clean.{key}[{i}]" needs "dir" and a whole number "keep" >= 0.', { file, key, i });
      if ((key === 'builds' && path.isAbsolute(b.dir)) || (!path.isAbsolute(b.dir) && b.dir.split(/[\\/]/).includes('..'))) fail('{file}: "clean.{key}[{i}].dir" is a folder inside the project.', { file, key, i });
      if (key === 'packages' && !safePackageRoot(path.resolve(root, b.dir.trim()), root)) fail('{file}: clean.packages dir must not be a drive root, the project root or its ancestor, or traverse a link.', { file });
      if (b.links_from !== undefined && (!Array.isArray(b.links_from) || b.links_from.some(p => typeof p !== 'string' || !p.trim() || (!path.isAbsolute(p) && p.split(/[\\/]/).includes('..'))))) fail('{file}: clean.packages links_from must be a list of folders.', { file });
      if (b.prefix !== undefined && (typeof b.prefix !== 'string' || !b.prefix.trim() || /[\\/]/.test(b.prefix))) fail('{file}: clean.packages prefix is the start of a folder name.', { file });
      return { dir: b.dir.trim(), keep: b.keep, ...(Array.isArray(b.links_from) ? { links_from: b.links_from.map(p => (p as string).trim()) } : {}), ...(typeof b.prefix === 'string' ? { prefix: b.prefix.trim() } : {}) };
    });
  }
  for (const key of ['logs_days', 'min_gain_gb'] as const) if (raw[key] !== undefined) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0) fail('{file}: clean retention and gain must be finite nonnegative numbers.', { file });
    out[key] = raw[key];
  }
  if (raw.auto_destructive !== undefined) {
    if (typeof raw.auto_destructive !== 'boolean') fail('{file}: clean.auto_destructive must be a boolean.', { file });
    out.auto_destructive = raw.auto_destructive;
  }
  if (raw.auto_classes !== undefined) {
    const allowed = ['caches', 'logs', 'builds', ...(out.auto_destructive ? ['packages', 'worktrees'] : [])];
    if (!Array.isArray(raw.auto_classes) || raw.auto_classes.some(c => !allowed.includes(c))) fail('{file}: clean.auto_classes allows caches, logs and builds; packages and worktrees additionally require clean.auto_destructive: true.', { file });
    out.auto_classes = raw.auto_classes as string[];
  }
  if (raw.drives !== undefined) {
    if (!Array.isArray(raw.drives)) fail('{file}: clean.drives must be a list.', { file });
    out.drives = raw.drives.map(d => {
      if (!isRecord(d) || Object.keys(d).some(k => !['path', 'min_free_gb'].includes(k)) || typeof d.path !== 'string' || !d.path.trim() || typeof d.min_free_gb !== 'number' || !Number.isFinite(d.min_free_gb) || d.min_free_gb < 0) fail('{file}: clean.drives needs path and nonnegative min_free_gb.', { file });
      return { path: d.path.trim(), min_free_gb: d.min_free_gb };
    });
  }
  return out;
}

export const DEFAULT_LONG_COMMANDS: string[] = [];

const dispatchDefaults = (): DispatchRules => ({
  caps: {}, long_command_minutes: 240, rework_reserve: 1, merge: 'manual', start_receipt_minutes: 15, on_loop: 'report', on_stall: 'report', on_lingering: 'report', lingering_minutes: 10, loop_idle_minutes: 45, loop_repeat: 3, loop_alternate: 6,
  long_commands: [...DEFAULT_LONG_COMMANDS], monitor_dirs: [], monitor_timeout_seconds: 120, commit_nudge_minutes: 45, auto_merge_base: true, checkout_workers: 4, port_block: 10,
});

function validateDispatch(raw: unknown, file: string): DispatchRules {
  if (raw === undefined) return dispatchDefaults();
  if (!isRecord(raw)) fail('{file}: "dispatch" must be a mapping.', { file });
  const out: DispatchRules = dispatchDefaults();
  const unknown = Object.keys(raw).filter(k => !['caps', 'min_free_ram_gb', 'stall_minutes', 'long_command_minutes', 'worktree_parent', 'base_ref', 'sparse', 'checkout_workers', 'port_base', 'port_block', 'rework_reserve', 'provision', 'accept_command', 'merge', 'start_receipt_minutes', 'on_loop', 'on_stall', 'max_reworks', 'on_lingering', 'lingering_minutes', 'loop_idle_minutes', 'loop_repeat', 'loop_alternate', 'long_commands', 'monitor_dirs', 'monitor_timeout_seconds', 'commit_nudge_minutes', 'auto_merge_base'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "dispatch": {keys}.', { file, keys: unknown.join(', ') });
  if (raw.caps !== undefined) {
    if (!isRecord(raw.caps)) fail('{file}: "dispatch.caps" must be a mapping of name to a whole number.', { file });
    for (const [k, v] of Object.entries(raw.caps)) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) fail('{file}: "dispatch.caps.{key}" must be a whole number >= 0.', { file, key: k });
      out.caps[k] = v;
    }
  }
  for (const key of ['min_free_ram_gb', 'stall_minutes', 'long_command_minutes'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail('{file}: "dispatch.{key}" must be a number >= 0.', { file, key });
    out[key] = v;
  }
  for (const key of ['provision', 'accept_command'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== 'string')) fail('{file}: "dispatch.{key}" must be a list: the program, then its arguments (no shell is used).', { file, key });
    out[key] = v as string[];
  }
  for (const key of ['start_receipt_minutes', 'lingering_minutes', 'loop_idle_minutes', 'loop_repeat', 'loop_alternate', 'monitor_timeout_seconds'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) fail('{file}: "dispatch.{key}" must be a number >= 1.', { file, key });
    out[key] = v;
  }
  if (raw.on_stall !== undefined) {
    if (raw.on_stall !== 'report' && raw.on_stall !== 'continue') fail('{file}: "dispatch.on_stall" must be "report" or "continue".', { file });
    out.on_stall = raw.on_stall;
  }
  if (raw.max_reworks !== undefined) {
    if (typeof raw.max_reworks !== 'number' || !Number.isInteger(raw.max_reworks) || raw.max_reworks < 1) fail('{file}: "dispatch.max_reworks" must be a whole number >= 1.', { file });
    out.max_reworks = raw.max_reworks;
  }
  if (raw.on_loop !== undefined) {
    if (raw.on_loop !== 'report' && raw.on_loop !== 'stop') fail('{file}: "dispatch.on_loop" must be "report" or "stop".', { file });
    out.on_loop = raw.on_loop;
  }
  if (raw.on_lingering !== undefined) {
    if (raw.on_lingering !== 'report' && raw.on_lingering !== 'stop') fail('{file}: "dispatch.on_lingering" must be "report" or "stop".', { file });
    out.on_lingering = raw.on_lingering;
  }
  for (const key of ['long_commands', 'monitor_dirs'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) fail('{file}: "dispatch.{key}" must be a list of words.', { file, key });
    out[key] = (v as string[]).map(x => x.trim());
  }
  if (raw.merge !== undefined && raw.merge !== 'manual') fail('{file}: "dispatch.merge" must be "manual" (the only mode in this version).', { file });
  if (raw.rework_reserve !== undefined) {
    if (typeof raw.rework_reserve !== 'number' || !Number.isInteger(raw.rework_reserve) || raw.rework_reserve < 0) fail('{file}: "dispatch.rework_reserve" must be a whole number >= 0.', { file });
    out.rework_reserve = raw.rework_reserve;
  }
  if (raw.commit_nudge_minutes !== undefined) {
    if (typeof raw.commit_nudge_minutes !== 'number' || !Number.isInteger(raw.commit_nudge_minutes) || raw.commit_nudge_minutes < 0) fail('{file}: "dispatch.commit_nudge_minutes" must be a whole number >= 0.', { file });
    out.commit_nudge_minutes = raw.commit_nudge_minutes;
  }
  if (raw.auto_merge_base !== undefined) {
    if (typeof raw.auto_merge_base !== 'boolean') fail('{file}: "dispatch.auto_merge_base" must be true or false.', { file });
    out.auto_merge_base = raw.auto_merge_base;
  }
  for (const key of ['worktree_parent', 'base_ref'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) fail('{file}: "dispatch.{key}" must be a non-empty string.', { file, key });
    out[key] = v.trim();
  }
  if (raw.sparse !== undefined) {
    const checked = normalizeSparseDirs(raw.sparse);
    if (!checked.ok) fail('{file}: "dispatch.sparse" {error}.', { file, error: checked.error });
    out.sparse = checked.dirs;
  }
  if (raw.checkout_workers !== undefined) {
    if (typeof raw.checkout_workers !== 'number' || !Number.isInteger(raw.checkout_workers) || raw.checkout_workers < 1) {
      fail('{file}: "dispatch.checkout_workers" must be a whole number >= 1.', { file });
    }
    out.checkout_workers = raw.checkout_workers;
  }
  if (raw.port_base !== undefined) {
    if (typeof raw.port_base !== 'number' || !Number.isInteger(raw.port_base) || raw.port_base < 1 || raw.port_base > 65535) {
      fail('{file}: "dispatch.port_base" must be a whole number between 1 and 65535.', { file });
    }
    out.port_base = raw.port_base;
  }
  if (raw.port_block !== undefined) {
    if (typeof raw.port_block !== 'number' || !Number.isInteger(raw.port_block) || raw.port_block < 1 || raw.port_block > 10000) {
      fail('{file}: "dispatch.port_block" must be a whole number between 1 and 10000.', { file });
    }
    out.port_block = raw.port_block;
  }
  return out;
}

function validateResources(raw: unknown, file: string): Record<string, ResourceConfig> {
  if (!isRecord(raw)) fail('{file}: "resources" must map a name to its slots.', { file });
  const out: Record<string, ResourceConfig> = {};
  for (const [name, v] of Object.entries(raw)) {
    const at = `resources.${name}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) fail('{file}: "{at}": a resource name is letters, digits, ".", "-" and "_".', { file, at });
    if (!isRecord(v)) fail('{file}: "{at}" must be a mapping with "slots".', { file, at });
    const unknown = Object.keys(v).filter(k => !['slots', 'scope', 'note', 'exclusive', 'blocks', 'lease_minutes', 'match'].includes(k));
    if (unknown.length) fail('{file}: unknown key(s) under "{at}": {keys}.', { file, at, keys: unknown.join(', ') });
    if (typeof v.slots !== 'number' || !Number.isInteger(v.slots) || v.slots < 1) fail('{file}: "{at}.slots" must be a whole number >= 1.', { file, at });
    if (v.scope !== undefined && v.scope !== 'project' && v.scope !== 'machine') fail('{file}: "{at}.scope" must be "project" or "machine".', { file, at });
    if (v.exclusive !== undefined && typeof v.exclusive !== 'boolean') fail('{file}: "{at}.exclusive" must be true or false.', { file, at });
    if (v.scope === 'machine' && v.exclusive === true) fail('{file}: "{at}": exclusive cannot be machine-scoped yet.', { file, at });
    if (v.note !== undefined && typeof v.note !== 'string') fail('{file}: "{at}.note" must be text.', { file, at });
    if (v.blocks !== undefined && (!Array.isArray(v.blocks) || v.blocks.some(x => typeof x !== 'string' || !x.trim()))) fail('{file}: "{at}.blocks" must be a list of kinds.', { file, at });
    if (v.lease_minutes !== undefined && (typeof v.lease_minutes !== 'number' || !(v.lease_minutes >= 1))) fail('{file}: "{at}.lease_minutes" must be a number >= 1.', { file, at });
    if (v.match !== undefined) { if (typeof v.match !== 'string' || !v.match) fail('{file}: "{at}.match" must be a regular expression.', { file, at }); regexOk(v.match, `"${at}.match"`, file); }
    out[name] = { slots: v.slots, ...(v.scope === 'machine' ? { scope: 'machine' as const } : v.scope === 'project' ? { scope: 'project' as const } : {}), exclusive: v.exclusive === true, blocks: Array.isArray(v.blocks) ? (v.blocks as string[]).map(x => x.trim()) : [], lease_minutes: typeof v.lease_minutes === 'number' ? v.lease_minutes : 480, ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note.trim() } : {}), ...(typeof v.match === 'string' ? { match: v.match } : {}) };
  }
  return out;
}

function validateChecks(raw: unknown, file: string, base: string): ChecksConfig {
  const out: ChecksConfig = { clean_worktree: true, ahead_of_base: true, protected_paths: [], forbidden_tracked: [], encoding_scan: true };
  if (raw === undefined) return out;
  if (!isRecord(raw)) fail('{file}: "checks" must be a mapping.', { file });
  const known = ['clean_worktree', 'ahead_of_base', 'protected_paths', 'forbidden_tracked', 'encoding_scan', 'max_new_file_kb', 'references', 'result_parser', 'report_required', 'revision_is_head', 'base_merged', 'base_intact', 'generated_paths', 'evidence_required', 'report_must_match', 'report_must_not_match'];
  const unknown = Object.keys(raw).filter(k => !known.includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "checks": {keys}.', { file, keys: unknown.join(', ') });
  for (const key of ['clean_worktree', 'ahead_of_base', 'encoding_scan', 'report_required', 'revision_is_head', 'base_intact', 'evidence_required'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') fail('{file}: "checks.{key}" must be true or false.', { file, key });
    out[key] = v;
  }
  for (const key of ['protected_paths', 'forbidden_tracked', 'generated_paths'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x)) fail('{file}: "checks.{key}" must be a list of globs.', { file, key });
    out[key] = v as string[];
  }
  if (raw.base_merged !== undefined) {
    const v = raw.base_merged;
    if (typeof v === 'boolean') out.base_merged = v;
    else if (isRecord(v) && Object.keys(v).every(k => k === 'max_behind') && typeof v.max_behind === 'number' && Number.isInteger(v.max_behind) && v.max_behind >= 0) out.base_merged = { max_behind: v.max_behind };
    else fail('{file}: "checks.base_merged" must be a boolean or { max_behind: nonnegative integer }.', { file });
  }
  for (const key of ['report_must_match', 'report_must_not_match'] as const) {
    if (raw[key] === undefined) continue;
    const rules = raw[key];
    if (!Array.isArray(rules)) fail('{file}: "checks.{key}" must be a list of { pattern, message }.', { file, key });
    out[key] = rules.map(rule => {
      if (!isRecord(rule) || Object.keys(rule).some(k => !['pattern', 'message'].includes(k)) || typeof rule.pattern !== 'string' || !rule.pattern || typeof rule.message !== 'string' || !rule.message.trim()) fail('{file}: "checks.{key}" needs pattern and message text.', { file, key });
      try { new RegExp(rule.pattern.replace(/\{tag(?:_lower)?\}/g, 'TAG'), 'm'); } catch { fail('{file}: "checks.{key}" has an invalid regular expression.', { file, key }); }
      return { pattern: rule.pattern, message: rule.message };
    });
  }
  if (raw.max_new_file_kb !== undefined) {
    if (typeof raw.max_new_file_kb !== 'number' || !(raw.max_new_file_kb > 0)) fail('{file}: "checks.max_new_file_kb" must be a number above 0.', { file });
    out.max_new_file_kb = raw.max_new_file_kb;
  }
  if (raw.references !== undefined) {
    if (typeof raw.references !== 'string' || !raw.references.trim()) fail('{file}: "checks.references" must be a path.', { file });
    out.references = path.resolve(base, raw.references.trim());
  }
  if (raw.result_parser !== undefined) {
    if (typeof raw.result_parser !== 'string' || !raw.result_parser) fail('{file}: "checks.result_parser" must be a regular expression string.', { file });
    let groups: Record<string, unknown> | undefined;
    try { groups = new RegExp(raw.result_parser + '|', 'u').exec('')?.groups; } catch (e) { fail('{file}: "checks.result_parser" is not a valid regular expression: {error}', { file, error: (e as Error).message }); }
    if (!groups || !('name' in groups) || !('value' in groups)) fail('{file}: "checks.result_parser" needs the named groups "name" and "value".', { file });
    out.result_parser = raw.result_parser;
  }
  return out;
}

function validateVerify(raw: unknown, file: string): VerifyConfig {
  if (raw === undefined) return { protected_gates: [], screenshots: { ...DEFAULT_SCREENSHOT_THRESHOLDS }, max_visual_rounds: 2 };
  if (!isRecord(raw)) fail('{file}: "verify" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => !['protected_gates', 'screenshots', 'max_visual_rounds'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "verify": {keys}.', { file, keys: unknown.join(', ') });
  const value = raw.protected_gates;
  const protectedGates = value === undefined ? [] : (() => {
    if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x.trim())) fail('{file}: "verify.protected_gates" must be a list of globs.', { file });
    return (value as string[]).map(x => x.trim());
  })();
  const maxVisualRounds = raw.max_visual_rounds === undefined ? 2 : (() => {
    if (typeof raw.max_visual_rounds !== 'number' || !Number.isInteger(raw.max_visual_rounds) || raw.max_visual_rounds < 0) fail('{file}: "verify.max_visual_rounds" must be a whole number >= 0.', { file });
    return raw.max_visual_rounds;
  })();
  const screenshots = raw.screenshots;
  if (screenshots === 'off') return { protected_gates: protectedGates, screenshots: 'off', max_visual_rounds: maxVisualRounds };
  if (screenshots !== undefined && !isRecord(screenshots)) fail('{file}: "verify.screenshots" must be a mapping or "off".', { file });
  const source = (screenshots ?? {}) as Record<string, unknown>;
  const unknownScreenshots = Object.keys(source).filter(k => !['duplicate_diff', 'blank_std', 'dark_mean', 'dark_fraction', 'luminance', 'motion'].includes(k));
  if (unknownScreenshots.length) fail('{file}: unknown key(s) under "verify.screenshots": {keys}.', { file, keys: unknownScreenshots.join(', ') });
  const thresholds = { ...DEFAULT_SCREENSHOT_THRESHOLDS };
  for (const key of Object.keys(thresholds) as (keyof ScreenshotVerifyConfig)[]) {
    if (key === 'luminance' || key === 'motion') continue;
    const v = source[key];
    if (v !== undefined) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) fail('{file}: "verify.screenshots.{key}" must be a number between 0 and 1.', { file, key });
      thresholds[key] = v;
    }
  }
  const parseRegion = (v: unknown, key: string): [number, number, number, number] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length !== 4 || v.some(n => typeof n !== 'number' || !Number.isInteger(n) || n < 0) || (v as number[])[2] <= 0 || (v as number[])[3] <= 0) fail('{file}: "verify.screenshots.{key}.region" must be [x, y, w, h] with positive whole dimensions.', { file, key });
    return v as [number, number, number, number];
  };
  const bound = (v: unknown, key: string, unit: boolean): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (unit && v > 1)) fail('{file}: "verify.screenshots.{key}" has an invalid bound.', { file, key });
    return v;
  };
  const luminance = source.luminance === undefined ? [] : (() => {
    if (!Array.isArray(source.luminance)) fail('{file}: "verify.screenshots.luminance" must be a list.', { file });
    return source.luminance.map((raw, i) => {
      if (!isRecord(raw) || typeof raw.match !== 'string' || !raw.match.trim()) fail('{file}: "verify.screenshots.luminance[{i}]" needs a match.', { file, i });
      const mean_min = bound(raw.mean_min, `luminance[${i}].mean_min`, true), mean_max = bound(raw.mean_max, `luminance[${i}].mean_max`, true);
      if (mean_min === undefined && mean_max === undefined) fail('{file}: "verify.screenshots.luminance[{i}]" needs mean_min or mean_max.', { file, i });
      if (mean_min !== undefined && mean_max !== undefined && mean_min > mean_max) fail('{file}: luminance rule {i} has mean_min above mean_max.', { file, i });
      const region = parseRegion(raw.region, `luminance[${i}]`);
      return { match: raw.match, ...(mean_min !== undefined ? { mean_min } : {}), ...(mean_max !== undefined ? { mean_max } : {}), ...(region ? { region } : {}) };
    });
  })();
  const motion = source.motion === undefined ? [] : (() => {
    if (!Array.isArray(source.motion)) fail('{file}: "verify.screenshots.motion" must be a list.', { file });
    return source.motion.map((raw, i) => {
      if (!isRecord(raw) || typeof raw.a !== 'string' || typeof raw.b !== 'string' || !raw.a.trim() || !raw.b.trim()) fail('{file}: "verify.screenshots.motion[{i}]" needs a and b.', { file, i });
      const min = bound(raw.min, `motion[${i}].min`, false), max = bound(raw.max, `motion[${i}].max`, false);
      if (min === undefined && max === undefined) fail('{file}: "verify.screenshots.motion[{i}]" needs min or max.', { file, i });
      if (min !== undefined && max !== undefined && min > max) fail('{file}: motion rule {i} has min above max.', { file, i });
      const region = parseRegion(raw.region, `motion[${i}]`);
      return { a: raw.a, b: raw.b, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(region ? { region } : {}) };
    });
  })();
  return { protected_gates: protectedGates, screenshots: { ...thresholds, ...(source.luminance !== undefined ? { luminance } : {}), ...(source.motion !== undefined ? { motion } : {}) }, max_visual_rounds: maxVisualRounds };
}

function validateSync(raw: unknown, file: string): SyncRules {
  const out: SyncRules = { git_signal: false, git_subject: String.raw`\breport\b` };
  if (raw === undefined) return out;
  if (!isRecord(raw)) fail('{file}: "sync" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => !['git_signal', 'git_subject'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "sync": {keys}.', { file, keys: unknown.join(', ') });
  if (raw.git_signal !== undefined) { if (typeof raw.git_signal !== 'boolean') fail('{file}: "sync.git_signal" must be true or false.', { file }); out.git_signal = raw.git_signal; }
  if (raw.git_subject !== undefined) {
    if (typeof raw.git_subject !== 'string' || !raw.git_subject) fail('{file}: "sync.git_subject" must be a regular expression string.', { file });
    try { new RegExp(raw.git_subject, 'i'); } catch (e) { fail('{file}: "sync.git_subject" is not a valid regular expression: {error}', { file, error: (e as Error).message }); }
    out.git_subject = raw.git_subject;
  }
  return out;
}

function validateTable(raw: unknown, file: string, base: string): TableConfig {
  if (!isRecord(raw)) fail('{file}: "dispatch_table" must be a mapping.', { file });
  const at = (key: string) => `${file}: "dispatch_table.${key}"`;
  if (typeof raw.file !== 'string' || !raw.file.trim()) fail('{where} must be a path to a Markdown file.', { where: at('file') });
  const column = (key: string, required: boolean): number | undefined => {
    const v = raw[key];
    if (v === undefined) { if (required) fail('{where} is required (1 = first column).', { where: at(key) }); return undefined; }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) fail('{where} must be a whole number >= 1 (1 = first column).', { where: at(key) });
    return v;
  };
  if (!isRecord(raw.status_map) || !Object.keys(raw.status_map).length) fail('{where} must map each status word in the table to a stage.', { where: at('status_map') });
  const status_map: Record<string, Stage> = {};
  for (const [word, stage] of Object.entries(raw.status_map)) {
    if (typeof stage !== 'string' || !(STAGES as readonly string[]).includes(stage)) {
      fail('{where} maps "{word}" to "{stage}", which is not a stage. Stages: {stages}.', { where: at('status_map'), word, stage: String(stage), stages: STAGES.join(', ') });
    }
    if (stage === 'waiting-needs' || stage === 'idle') fail('{where}: "{stage}" is inferred, a table word cannot set it.', { where: at('status_map'), stage });
    status_map[word] = stage as Stage;
  }
  const pattern = raw.tag_pattern === undefined ? DEFAULT_TAG_PATTERN : raw.tag_pattern;
  const regex = (key: string, value: unknown): string => {
    if (typeof value !== 'string' || !value) fail('{where} must be a regular expression string.', { where: at(key) });
    try { new RegExp(value); } catch (e) { fail('{where} is not a valid regular expression: {error}', { where: at(key), error: (e as Error).message }); }
    return value;
  };
  const untagged = raw.untagged === undefined ? 'error' : raw.untagged;
  if (untagged !== 'error' && untagged !== 'synthetic') fail('{where} must be "error" or "synthetic".', { where: at('untagged') });
  const known = ['file', 'section', 'status_column', 'order_column', 'worker_column', 'needs_column', 'status_map', 'card_words', 'tag_pattern', 'tag_exclude', 'untagged', 'merged_list', 'merged_marker', 'needs_markers', 'base_pattern', 'default_kind', 'kind_rules', 'write_back'];
  const unknown = Object.keys(raw).filter(k => !known.includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "dispatch_table": {keys}.', { file, keys: unknown.join(', ') });
  const table: TableConfig = {
    file: path.resolve(base, raw.file.trim()),
    status_column: column('status_column', true)!, order_column: column('order_column', true)!,
    status_map, tag_pattern: regex('tag_pattern', pattern), untagged, kind_rules: [], write_back: raw.write_back === true,
  };
  if (raw.card_words !== undefined) {
    if (!Array.isArray(raw.card_words) || raw.card_words.some(w => typeof w !== 'string' || !w)) fail('{where} must be a list of status words.', { where: at('card_words') });
    for (const w of raw.card_words as string[]) {
      if (status_map[w] !== 'awaiting-user') fail('{where}: "{word}" must be a status word that status_map maps to awaiting-user.', { where: at('card_words'), word: w });
    }
    table.card_words = raw.card_words as string[];
  }
  const worker = column('worker_column', false), needs = column('needs_column', false);
  if (worker) table.worker_column = worker;
  if (needs) table.needs_column = needs;
  if (new Set([table.status_column, table.order_column, worker, needs].filter(Boolean)).size !== [table.status_column, table.order_column, worker, needs].filter(Boolean).length) {
    fail('{where}: the status, order, worker and needs columns must all be different.', { where: `${file}: "dispatch_table"` });
  }
  if (raw.section !== undefined) { if (typeof raw.section !== 'string' || !raw.section.trim()) fail('{where} must be text.', { where: at('section') }); table.section = raw.section.trim(); }
  if (raw.tag_exclude !== undefined) table.tag_exclude = regex('tag_exclude', raw.tag_exclude);
  if (raw.default_kind !== undefined) { if (typeof raw.default_kind !== 'string') fail('{where} must be text.', { where: at('default_kind') }); table.default_kind = raw.default_kind; }
  if (raw.kind_rules !== undefined) {
    if (!Array.isArray(raw.kind_rules)) fail('{where} must be a list of rules.', { where: at('kind_rules') });
    table.kind_rules = raw.kind_rules.map((r, i) => {
      const here = at(`kind_rules[${i}]`);
      if (!isRecord(r) || typeof r.match !== 'string') fail('{where} needs a "match" regular expression.', { where: here });
      regex(`kind_rules[${i}].match`, r.match);
      if (typeof r.kind !== 'string' && typeof r.heavy !== 'string' && !Array.isArray(r.tags) && !Array.isArray(r.uses)) fail('{where} needs "kind", "heavy", "tags" and/or "uses".', { where: here });
      if (r.uses !== undefined && (!Array.isArray(r.uses) || r.uses.some(x => typeof x !== 'string' || !x))) fail('{where}: "uses" must be a list of resource names.', { where: here });
      if (r.tags !== undefined && (!Array.isArray(r.tags) || r.tags.some(x => typeof x !== 'string' || !x))) fail('{where}: "tags" must be a list of words.', { where: here });
      return { match: r.match, ...(typeof r.kind === 'string' ? { kind: r.kind } : {}), ...(typeof r.heavy === 'string' ? { heavy: r.heavy } : {}), ...(Array.isArray(r.tags) && r.tags.length ? { tags: r.tags as string[] } : {}), ...(Array.isArray(r.uses) && r.uses.length ? { uses: r.uses as string[] } : {}) };
    });
  }
  if (raw.needs_markers !== undefined) {
    if (!Array.isArray(raw.needs_markers) || raw.needs_markers.some(m => typeof m !== 'string' || !m)) fail('{where} must be a list of words.', { where: at('needs_markers') });
    table.needs_markers = raw.needs_markers as string[];
  }
  if (raw.base_pattern !== undefined) {
    const source = regex('base_pattern', raw.base_pattern);
    if (new RegExp(source + '|').exec('')!.length < 2) fail('{where} needs one group around the branch name.', { where: at('base_pattern') });
    table.base_pattern = source;
  }
  if (raw.merged_marker !== undefined) {
    if (typeof raw.merged_marker !== 'string' || !raw.merged_marker.trim()) fail('{where} must be text.', { where: at('merged_marker') });
    table.merged_marker = raw.merged_marker.trim();
  }
  if (raw.merged_list !== undefined) {
    if (!isRecord(raw.merged_list) || typeof raw.merged_list.prefix !== 'string' || !raw.merged_list.prefix) fail('{where} must be a mapping with a "prefix" string.', { where: at('merged_list') });
    table.merged_list = { prefix: raw.merged_list.prefix };
  }
  return table;
}

function validateOrdersConfig(raw: unknown, file: string, base: string): OrdersConfig {
  if (!isRecord(raw)) fail('{file}: "orders" must be a mapping.', { file });
  const unknown = Object.keys(raw).filter(k => !['templates', 'preflight'].includes(k));
  if (unknown.length) fail('{file}: unknown key(s) under "orders": {keys}.', { file, keys: unknown.join(', ') });
  const templates: Record<string, OrderTemplateConfig> = {};
  if (raw.templates !== undefined) {
    if (!isRecord(raw.templates)) fail('{file}: "orders.templates" must map each kind to its template.', { file });
    for (const [kind, value] of Object.entries(raw.templates)) {
      const at = `orders.templates.${kind}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(kind)) fail('{file}: "{at}": a kind is letters, digits, "-" and "_".', { file, at });
      if (!isRecord(value)) fail('{file}: "{at}" must be a mapping.', { file, at });
      const bad = Object.keys(value).filter(k => !['file', 'acceptance', 'evidence', 'paths', 'rules'].includes(k));
      if (bad.length) fail('{file}: unknown key(s) under "{at}": {keys}.', { file, at, keys: bad.join(', ') });
      const entry: OrderTemplateConfig = {};
      if (value.file !== undefined) {
        if (typeof value.file !== 'string' || !value.file.trim()) fail('{file}: "{at}.file" must be a path to a Markdown file.', { file, at });
        entry.file = path.resolve(base, value.file.trim());
      }
      for (const key of ['acceptance', 'evidence', 'paths', 'rules'] as const) {
        if (value[key] === undefined) continue;
        if (!Array.isArray(value[key]) || (value[key] as unknown[]).some(x => typeof x !== 'string' || !x.trim())) {
          fail('{file}: "{at}.{key}" must be a list of non-empty strings.', { file, at, key });
        }
        entry[key] = (value[key] as string[]).map(x => x.trim());
      }
      templates[kind] = entry;
    }
  }
  const preflight: OrdersPreflightConfig = { mode: 'hold', run_checks: false, check_timeout_seconds: 300, tool_dirs: {} };
  if (raw.preflight !== undefined) {
    if (!isRecord(raw.preflight)) fail('{file}: "orders.preflight" must be a mapping.', { file });
    const bad = Object.keys(raw.preflight).filter(k => !['mode', 'run_checks', 'check_timeout_seconds', 'tool_dirs'].includes(k));
    if (bad.length) fail('{file}: unknown key(s) under "orders.preflight": {keys}.', { file, keys: bad.join(', ') });
    if (raw.preflight.mode !== undefined) {
      if (raw.preflight.mode !== 'hold' && raw.preflight.mode !== 'warn' && raw.preflight.mode !== 'off') {
        fail('{file}: "orders.preflight.mode" must be hold, warn or off.', { file });
      }
      preflight.mode = raw.preflight.mode;
    }
    if (raw.preflight.run_checks !== undefined) {
      if (typeof raw.preflight.run_checks !== 'boolean') fail('{file}: "orders.preflight.run_checks" must be true or false.', { file });
      preflight.run_checks = raw.preflight.run_checks;
    }
    if (raw.preflight.check_timeout_seconds !== undefined) {
      const secs = raw.preflight.check_timeout_seconds;
      if (typeof secs !== 'number' || !Number.isInteger(secs) || secs < 1) fail('{file}: "orders.preflight.check_timeout_seconds" must be a whole number >= 1.', { file });
      preflight.check_timeout_seconds = secs;
    }
    if (raw.preflight.tool_dirs !== undefined) {
      if (!isRecord(raw.preflight.tool_dirs)) fail('{file}: "orders.preflight.tool_dirs" must map each tool to its folder.', { file });
      for (const [tool, value] of Object.entries(raw.preflight.tool_dirs)) {
        const at = `orders.preflight.tool_dirs.${tool}`;
        if (!tool.trim()) fail('{file}: "orders.preflight.tool_dirs" has an empty tool name.', { file });
        if (!isRecord(value)) fail('{file}: "{at}" must be a mapping with "dir" and optional "kinds".', { file, at });
        const badTool = Object.keys(value).filter(k => !['dir', 'kinds'].includes(k));
        if (badTool.length) fail('{file}: unknown key(s) under "{at}": {keys}.', { file, at, keys: badTool.join(', ') });
        if (typeof value.dir !== 'string' || !value.dir.trim()) fail('{file}: "{at}.dir" must be a non-empty folder path.', { file, at });
        if (value.kinds !== undefined) {
          if (!Array.isArray(value.kinds) || !value.kinds.length || (value.kinds as unknown[]).some(x => typeof x !== 'string' || !x.trim())) {
            fail('{file}: "{at}.kinds" must be a non-empty list of kinds.', { file, at });
          }
          preflight.tool_dirs[tool] = { dir: value.dir.trim(), kinds: (value.kinds as string[]).map(x => x.trim()) };
        } else {
          preflight.tool_dirs[tool] = { dir: value.dir.trim() };
        }
      }
    }
  }
  return { templates, preflight };
}
