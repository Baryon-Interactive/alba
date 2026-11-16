import type { RunUsage } from '../api/types.ts';
import type { LiveSummary } from '../run/live.ts';
import type { OutboxEntry } from '../run/messages.ts';

export const RUN_OUTCOMES = ['completed', 'failed', 'stalled', 'capacity', 'cancelled'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const REPORT_STATUSES = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'monitoring'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** `monitor` is written by the tick, never by a person: a monitor ended and the order is queued to continue (its note is the monitor's result). `message` is a note sent to a running order (`alba say --restart`). */
export const ACTION_KINDS = ['queue', 'cancel', 'hold', 'release', 'approve', 'rework', 'answer', 'monitor', 'message'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const STAGES = [
  'cancelled', 'merged', 'held', 'awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped',
  'running', 'monitoring', 'idle', 'waiting-needs', 'planned', 'queued', 'draft',
] as const;
export type Stage = (typeof STAGES)[number];

/** What an order is allowed to do and on whose word. Stored and shown only. */
export interface Mandate {
  quote?: string;            // the user's words that started this order
  decisions?: string;        // decision-number range, free text
  spend_cap?: number;        // ceiling for paid calls
  protected_paths?: string[];
}

/** Where an order came from when it was imported from a Markdown dispatch table. */
export interface ImportSource {
  status_word?: string;      // the word in the status column at the last import
  worker_cell?: string;      // worker cell last imported or written, including an empty cell
  row?: number;              // 0-based row among the table's data rows
  tagged?: boolean;          // false when the tag was made up because the row had none
  joiner?: string;           // what stood between the tag and the title in the cell ('' or ' ')
  from_merged_list?: boolean;
}

/** What a report says it is waiting for: a card to click (a person opens a session of their own) or an answer. */
export type WaitingFor = 'card' | 'answer';

/** A choice offered with a question. The first one of a list is the recommended one. */
export interface OptionInput { label: string; note?: string; images?: string[] }

/** What an order was classified as: one main kind and extra tags. A model's answer is kept until the work-order text changes (`text_hash`); the rules are cheap and read again every time. */
export interface StoredRouting {
  kind: string;
  tags: string[];
  source: 'table' | 'manual' | 'rules' | 'model' | 'none';
  why: string;
  at: string;
  text_hash?: string;       // hash of the title and the work-order text the rules or the model looked at
}

export interface Order {
  /** Producer-selected worker; cleared when a person changes worker. */
  next_worker?: string;
  check?: 'independent' | 'none';
  review?: 'manual' | 'auto';
  planned?: boolean;
  intent?: string;
  role?: string;
  priority?: number;
  tag: string;
  title: string;
  kind: string;
  heavy?: string;            // shared-resource class that is capped separately (e.g. a core module)
  needs: string[];           // tags that must be merged first
  condition?: string;        // free text from the table's needs column, shown as-is
  worker?: string;           // preferred worker, free text until the worker registry exists
  model?: string;            // the model this order runs with on the worker it names (`worker`, or the one a person starts it on); any other worker uses its own
  mandate?: Mandate;
  tags?: string[];           // words that pick lessons from the project's library for this order's prompt, and skills
  skills?: string[];         // skills (names from the registry) the order always gets
  routing?: StoredRouting;
  uses?: string[];           // resources (names under `resources` in the project file) a run of this order holds a lease on
  tools?: string[];          // tool plugins (enabled under `plugins` in the project file) a run of this order gets
  branch?: string;
  base_ref?: string;         // local branch this order starts from instead of the project base (a person wrote "start from <branch>")
  worktree?: string;
  source?: ImportSource;
  created: string;
  updated: string;
}

export interface Run {
  host?: string;
  remote_worktree?: string;
  previous_attempts?: string;
  reroute?: string;
  role?: string;
  role_source?: 'explicit' | 'kind' | 'default' | 'none';
  role_effort?: string;
  role_reasoning?: string;
  mcp_servers?: string[];
  tools?: string[];          // the tool plugins of the run, as id@version
  role_warnings?: string[];
  engine?: string; model?: string; continuation?: boolean;
  events_file?: string;
  exit_file?: string;
  live_summary?: LiveSummary;
  id: string;
  seq: number;
  worker: string;
  session?: string;
  started: string;
  ended?: string;
  outcome?: RunOutcome;
  note?: string;            // the rework note this run was started with
  imported?: boolean;
  // Set when the tool started the process itself (the full command line is never stored):
  pid?: number;
  process_started_at?: string; // actual OS creation time, recorded after launch to guard against pid reuse
  template?: string;        // id of the launch template used
  log?: string;
  last_file?: string;       // where the worker was told to write its final message
  prompt_file?: string;
  cwd?: string;
  attempt?: number;         // 1 for a fresh start, 2.. for automatic resumes after transient errors
  routing?: { kind: string; why: string; rejected: { worker: string; reason: string }[] };   // why this worker was chosen
  skills?: string[];        // names of the skills put into the worktree for this run
  usage?: RunUsage;   // tokens and cost read from the log when the run ended
  monitor?: boolean;        // started to continue after a monitor ended: not counted in the worker's runs of the day
  rotated?: { from: string; reason: string; paid?: boolean; text?: string };   // the worker that was running this order before it ran out of quota or capacity (`on_limit: rotate`); `paid` is the target, `text` is the sentence shown on the order
  handoff_file?: string;    // the continuation file the new worker was pointed at
  limit?: 'capacity' | 'quota' | 'unreachable';   // why the run ended when it hit a limit: the model service was at capacity, the usage window was used up, or its endpoint accepted no connection
  lost_session?: boolean;   // the service cannot continue this run's conversation
  missing_report?: boolean; // the process ended without a valid worker report; newer work gets a reminder instead of repair-only instructions
  /** The main checkout when the run started (a local run in its own worktree): the base branch's head and what was changed there. */
  main_head?: string;
  root_dirty?: string[];
  report_from?: 'earlier-message' | 'written-file'; // the report block was not in the last message (see the report-from-earlier event)
  resume_reason?: string;   // why an automatic resume started a new session
}

/** One condition of a monitor: exactly one of these keys. */
export type MonitorCriterion = { exit_code: number } | { file_exists: string } | { output_matches: string };

/** What a worker hands over when it ends its round with status `monitoring`: a cheap, read-only command the tick runs every pass, and when it counts as done or failed. */
export interface MonitorSpec {
  pid?: number;
  check: string[];                  // program and arguments, no shell
  cwd?: string;                     // the order's worktree unless it says otherwise; must stay inside the worktree or the folders the project allows
  done_when: MonitorCriterion;
  fail_when?: MonitorCriterion;
  deadline_minutes: number;         // after this long the order is continued anyway
  note?: string;                    // given back to the worker when it is continued
}

export type MonitorResult = 'waiting' | 'done' | 'failed' | 'deadline' | 'refused';

/** What the tick keeps about the monitor of an order (the report holds the spec). */
export interface MonitorState {
  pid?: number;
  process_started_at?: string;
  observation?: string;
  changed_at?: string;
  report_seq: number;
  started: string;
  deadline: string;
  checks: number;
  last_at?: string;
  last_result?: MonitorResult;
  last_signature?: string;          // result and the end of the output: a check that says the same again is not logged again
  tail?: string;                    // the end of the last check's output
  resolved?: { at: string; result: Exclude<MonitorResult, 'waiting'>; tail: string };
}

export interface Report {
  design_changes?: string[];
  revision?: string;
  delivery_text?: string;
  seq: number;
  at: string;
  run?: string;
  status: ReportStatus;
  summary: string;
  question?: string;
  options?: OptionInput[];  // 2 to 4 choices for the question, recommended first
  waiting_for?: WaitingFor; // for a waiting report; a question with no word here is waiting for an answer
  scope?: 'order' | 'project';   // `project`: a set of candidates for the whole project, listed with the pick sets
  question_id?: string;     // the stored question this report carries (made by `ask`)
  evidence: string[];
  commits: string[];
  skill_suggestions?: { path: string; reason: string }[];   // changes the worker would like made to a shared skill
  monitor?: MonitorSpec;    // for a `monitoring` report
  from?: string;            // where it was read from
  source?: 'inferred' | 'inferred-git';   // not a report block: guessed from a free-text file, or read off the git state of the worktree
  imported?: boolean;
}

export interface Action {
  queued?: boolean; // A message for the next run; does not reset the current stage.
  lint?: boolean;
  seq: number;
  at: string;
  kind: ActionKind;
  note?: string;
  choice?: number;           // an answer that picked option N of the waiting report
  imported?: boolean;
  override?: boolean;
  /** Internal report-repair note; this restart must use the same worker and does not count as a resume. */
  bounce?: boolean;
}

/** A question with options asked on an order (by `alba ask` or the board), answered by picking one. */
export interface StoredQuestion {
  id: string;
  text: string;
  options: OptionInput[];
  by: string;
  at: string;
  answered?: { choice: number[]; note?: string; by: string; who?: string; at: string };
}

/**
 * One booking. `unknown`: the real cost is not known (a paid call that may have gone through); `amount` is the most it may have
 * cost. `key` makes it idempotent: a second booking with the same key is the same booking, not a new one.
 */
export interface LedgerEntry { at: string; amount: number; what: string; by: string; unknown?: true; key?: string }

/** Money set aside by the gate for a call about to be made; booked (or let go) by the spend with the same key, or lapsed at `until`. */
export interface QuoteHold { key: string; amount: number; at: string; until: string; by: string }

/** A quote for a paid resource: what the executor asks to be allowed to spend, and what a person allowed. */
export interface StoredQuote {
  id: string;
  service: string;
  unit: string;
  unit_price?: number;
  quantity?: number;
  total?: number;
  cap_requested: number;
  note?: string;
  created: string;
  by: string;
  status: 'pending' | 'approved' | 'rejected';
  approval?: { cap: number; note?: string; by: string; at: string };
  ledger: LedgerEntry[];
  holds?: QuoteHold[];
}

/** Everything stored for one order: its definition plus the facts the stage is inferred from. */
export interface OrderDoc {
  reroutes?: WorkerReroute[];
  outbox?: OutboxEntry[];
  version: 1;
  order: Order;
  runs: Run[];
  reports: Report[];
  actions: Action[];
  questions?: StoredQuestion[];
  quotes?: StoredQuote[];
  monitor?: MonitorState;
}

export interface WorkerReroute {
  id: string;
  at: string;
  from: string;
  to: string;
  note: string;
  by: string;
  seq: number;
  brief: string;
  loops?: string[];
}

export interface OrderEvent {
  at: string;
  tag: string;
  type: string;
  by?: string;               // who did it: cli, web, tick
  data?: Record<string, unknown>;
}

export function nextSeq(doc: OrderDoc): number {
  let max = 0;
  for (const item of [...doc.runs, ...doc.reports, ...doc.actions]) max = Math.max(max, item.seq);
  return max + 1;
}
