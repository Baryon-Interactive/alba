import { loadMachines } from '../machines/config.ts';
import { foundationGaps, foundationStates, formatFoundations, orderTraits } from '../foundations/foundations.ts';
import { machineInstallPlan, machinesView, probeMachines, startInstall, type MachineView } from '../machines/probe.ts';
import { machineJobs, type MachineJob } from '../machines/jobs.ts';
import { runDesign } from './design.ts';
import { runMeasurements } from '../design/measure.ts';
import { cancelNightlyRuns, runNightlyGates } from '../gates/runner.ts';
import { gatesStatus } from '../gates/state.ts';
import { DesignError } from '../design/model.ts';
import { effectiveRoles, resolveRole } from '../roles/config.ts';
import { roleRules, withRoleRules } from '../roles/mount.ts';
import { planOrder, editPlan } from '../orders/planned.ts';
import { usageRows } from '../usage/store.ts';
import { collectUsage, usageReport, sinceDate } from '../usage/accounting.ts';
import { runUsageScorecard } from './scorecard.ts';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { mergeListFlags, parseReleaseArgs, releaseFlags } from './args.ts';
import { releaseHelp, runReleaseCli } from '../release/cli.ts';
import { loadProject, type ProjectConfig } from '../config.ts';
import { enabledTools, runPlugins } from './plugins.ts';
import { runTools } from './tools.ts';
import { editorSlots, editorStatus, type EditorSlot } from '../editors/pool.ts';
import { startEditor, stopEditors } from '../editors/editor-helper.mjs';

/** Editor slots as lines: order, machine, port, up or down. */
function editorLines(rows: (EditorSlot & { up?: boolean; pids?: number[]; project?: string })[], withProject: boolean): string {
  return ['Editors:', ...rows.map(r => `  ${withProject && r.project ? `${r.project} ` : ''}${r.tag.padEnd(8)} ${r.pool} ${r.machine}:${r.port}  ${r.up === undefined ? 'remote (not checked)' : r.up ? 'up' : r.pids?.length ? 'starting or not answering' : 'down'}${r.run ? `  run ${r.run}` : '  (starting)'}  ${r.url}`)].join('\n');
}
import { UserError, fail, t } from '../i18n.ts';
import { RUN_OUTCOMES, STAGES, type ActionKind, type OrderDoc, type RunOutcome, type Stage } from '../orders/model.ts';
import { parseReportFile, staleReport } from '../orders/report.ts';
import { reportInRunLog } from '../run/lingering.ts';
import { Orders, STAGE_PRIORITY } from '../orders/service.ts';
import { stateStore } from '../orders/backend.ts';
import { importTable } from '../table/import.ts';
import { renderTable } from '../table/render.ts';
import { loadWorkers } from '../workers/config.ts';
import { addWorker, editWorker, parseSetArgs, recordWorkerEdit, workerYaml } from '../workers/edit.ts';
import { formatReport } from '../tick/plan.ts';
import { prewarmEndpointProbes, systemProbes, tick } from '../tick/gather.ts';
import { executeTick } from '../tick/execute.ts';
import { engineSession, startRun } from '../run/launch.ts';
import { effectiveSparse, worktreeSparseDirs } from '../run/worktree.ts';
import { lessonRunFor, selectLessons } from '../lessons/select.ts';
import { promptFor } from '../run/prompt.ts';
import { syncOrders } from '../sync/sync.ts';
import { writeBack } from '../table/write.ts';
import { applyFinish, findFinishes } from '../run/finish.ts';
import { contactSheet, formatSheet } from '../review/sheet.ts';
import { approve, rework } from '../run/review.ts';
import { startServer } from '../web/server.ts';
import { keyFile, newKey, writeKeyFile } from '../web/auth.ts';
import { answerOrder } from '../run/answer.ts';
import { sayToGroup, sayToOrder } from '../run/say.ts';
import { readInbox } from '../run/inbox.ts';
import { requeueUndeliveredInbox } from '../run/messages.ts';
import { formatStatus, recentEndedStatusRows, statusRows, unreachableStatusLines, watchOrder } from './live.ts';
import { pendingNotes } from '../run/prompt.ts';
import { lockHolder, skipLine } from '../serve/lock.ts';
import { startServe } from '../serve/serve.ts';
import { DEFAULT_DRAIN_SECONDS, createServeLogger, runServeReloadCli, runTakeoverServe } from '../serve/reload.ts';
import { hasDeliveryChecks } from '../check/delivery.ts';
import { startIndependentCheck } from '../review/independent.ts';
import { computeFirstPassStats, disputeFirstPass, formatFirstPassStats } from '../review/first-pass-stats.ts';
import { lintDelivery } from '../producer/delivery-lint.ts';
import { runCheck, formatCheck } from '../check/check.ts';
import { adopt, loadRefs, parseResults, saveRefs } from '../check/refs.ts';
import { tickLoop } from '../tick/loop.ts';
import { waitFor } from '../wait/wait.ts';
import { createOrder } from '../service/new-order.ts';
import { HUMAN_ACTIONS, humanAction, isHumanAction, stopRun } from '../service/actions.ts';
import { runExtra } from './extra.ts';
import { runRouting } from './routing.ts';
import { planSkills } from '../skills/plan.ts';
import { routingOf, classifyOrders } from '../routing/classify.ts';
import { table } from './format.ts';
import { ordinal, releaseLease, releaseMachineLease, resourceViews } from '../resources/leases.ts';
import { loopsReport } from './loops.ts';
import { runLibrary } from './library.ts';
import { machinesEdit } from './machines.ts';
import { migrateState, exportState, checkState } from '../orders/state.ts';
import { verifyOrder, formatVerify } from '../verify/verify.ts';
import { reviewTarget, formatReviewTarget } from '../verify/target-step.ts';
import { dryRunCapture, formatCaptureDryRun, formatCaptureRun, runCapture } from '../capture/run.ts';
import { producerAct, producerActions, producerCases, producerPolicy, producerState, producerWouldDo, intakeProducer, setProducerPaused } from '../producer/producer.ts';
import { producerLog } from '../producer/activity.ts';
import { producerUsage } from '../producer/session-usage.ts';
import { activityLine } from '../producer/activity-format.ts';
import { producerSessionStatus, startProducerSession, startProducerSessionDetached, stopProducerSession } from '../producer/session.ts';
import { runProducerMcp } from '../producer/mcp.ts';
import { createIntake, runDesignDocs, runIntake } from './intake.ts';
import { listNamedLocks, runNamedLock, usage as lockUsage } from '../run/named-lock.mjs';
import { decodePng, meanAbsoluteLuminanceDifference, meanLuminance, regionError, type PixelRegion } from '../verify/png.ts';
import { runNotifyCli } from './notify.ts';
import { runSchedulesCli } from './schedules.ts';

/** What a person needs to open the console: the sign-in link (it carries this start's key) and the file programs read the key from. */
const signInLines = (port: number, key: string): string => t('Sign in: {url}\nKey file (for programs of this account): {file}', { url: `http://127.0.0.1:${port}/login?key=${key}`, file: keyFile(port) });

const options = {
  ...releaseFlags,
  now: { type: 'boolean' }, gate: { type: 'string' },
  project: { type: 'string', multiple: true }, port: { type: 'string' }, stage: { type: 'string' }, json: { type: 'boolean' }, all: { type: 'boolean' }, out: { type: 'string' },
  worker: { type: 'string' }, target: { type: 'string' }, session: { type: 'string' }, outcome: { type: 'string' }, note: { type: 'string' }, file: { type: 'string' },
  title: { type: 'string' }, kind: { type: 'string' }, role: { type: 'string' }, review: { type: 'string' }, needs: { type: 'string' }, heavy: { type: 'string' }, 'run-model': { type: 'string' }, branch: { type: 'string' }, 'base-ref': { type: 'string' }, worktree: { type: 'string' }, sparse: { type: 'string' }, uses: { type: 'string' }, tools: { type: 'string' },
  quote: { type: 'string' }, decisions: { type: 'string' }, 'spend-cap': { type: 'string' }, protect: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  workers: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'over-cap': { type: 'boolean' }, write: { type: 'boolean' }, 'no-record': { type: 'boolean' }, 'max-dispatch': { type: 'string' },
  'allow-origin': { type: 'string', multiple: true }, 'sign-in': { type: 'boolean' }, applicable: { type: 'boolean' }, text: { type: 'string' }, restart: { type: 'boolean' }, reply: { type: 'string' }, choice: { type: 'string' }, tags: { type: 'string' }, who: { type: 'string' },
  id: { type: 'string' }, order: { type: 'string' }, input: { type: 'string' }, arg: { type: 'string', multiple: true }, date: { type: 'string' }, default: { type: 'boolean' }, option: { type: 'string', multiple: true }, apply: { type: 'boolean' },
  status: { type: 'string' }, service: { type: 'string' }, unit: { type: 'string' }, 'unit-price': { type: 'string' }, quantity: { type: 'string' }, cap: { type: 'string' }, amount: { type: 'string' }, what: { type: 'string' }, need: { type: 'string' }, key: { type: 'string' },
  docs: { type: 'string' }, dir: { type: 'string' }, accept: { type: 'string' }, reject: { type: 'string' }, drop: { type: 'string' }, version: { type: 'string' },
  intent: { type: 'string' }, 'body-file': { type: 'string' }, slug: { type: 'string' }, queue: { type: 'boolean' }, override: { type: 'boolean' }, model: { type: 'boolean' }, skills: { type: 'string' }, check: { type: 'boolean' }, topic: { type: 'string' },
  results: { type: 'string', multiple: true }, tag: { type: 'string' }, from: { type: 'string' }, names: { type: 'string' }, source: { type: 'string' }, every: { type: 'string' },
  'stall-minutes': { type: 'string' }, 'timeout-minutes': { type: 'string' }, 'poll-minutes': { type: 'string' }, 'wait-minutes': { type: 'string' },
  since: { type: 'string' }, by: { type: 'string' }, top: { type: 'string' }, reason: { type: 'string' },
  page: { type: 'string' }, image: { type: 'string' }, columns: { type: 'string' }, cell: { type: 'string' }, learn: { type: 'string' }, work: { type: 'string' }, days: { type: 'string' }, region: { type: 'string' }, recipe: { type: 'string' }, channel: { type: 'string' },
  'merged-elsewhere': { type: 'string' }, 'done-by-lead': { type: 'boolean' }, commit: { type: 'string' },
  force: { type: 'boolean' }, wait: { type: 'string' }, 'watch-code': { type: 'boolean' }, log: { type: 'string' }, takeover: { type: 'string' }, 'drain-seconds': { type: 'string' }, 'include-ignored': { type: 'boolean' },
} as const;

const HELP = `Alba - local work orders and worker orchestration

Usage: alba [--project <alba.yaml>] <command>      (or set ALBA_PROJECT)

  design systems | show <id> | search <text> | history [id] | export [--out dir] | import-template
  design apply <file> [--dry-run] | check [--json] | measure [<target>...] [--dry-run]
  design-docs list | show <id> [--version n] | import <md> [--id x] | export <id> --out <file> | set <id> --order n --status approved|draft|retired
  foundations [--json]                       the documents each kind of work needs before its content orders (foundations: in alba.yaml), their state, and the orders held back or warned about; exit 1 when one is not ready
  intake [--docs id,id] [--tag T] | intake check [<TAG>] [--dir .alba] [--json] | intake review <TAG> [--accept SYS,..] [--reject SYS --note text] [--drop SYS --note text]
  gates run [--now] [--gate name] | status | cancel   run, inspect or cancel waiting nightly gates
  schedules [list] [--json] | run <id> | pause <id> [--note text] | resume <id>   inspect, run, pause or resume recurring order schedules

  orders list [--stage s] [--all] [--json]   orders, people-first; merged/cancelled hidden unless --all or --stage
  orders show <TAG>                          definition, runs, latest report, notes still waiting, why it is in this stage, recent events
  status [--json]                            open runs across the selected projects, activity and unanswered questions
  watch <TAG>                                follow a run's activity until it ends
  loops [TAG] [--all]                        read the logs of open runs (--all: every run) for loops: the same failing command, two commands taking turns, a long stretch with no new command
  resources [--json]                         the project's shared resources: slots, who holds them and for how long
  leases release <resource> <TAG>            take a lease back (the run is gone and nothing released it)
  orders plan <TAG> --title t --kind k --needs A,B --intent text [--role role]
  orders edit-plan <TAG> [--title t] [--kind k] [--needs A,B] [--intent text] [--role role]
  orders cancel <TAG>
  orders close <TAG> (--merged-elsewhere <commit-or-ref> | --done-by-lead) [--commit <sha>] [--note text]
  orders add <TAG> [--body-file f] [--slug s] [--queue] --title t --kind k [--needs A,B] [--worker w] [--run-model m] [--heavy h] [--branch b] [--base-ref local-branch] [--sparse dir,dir] [--tags a,b] [--skills a,b] [--role id] [--review manual|auto] [--check independent|none] [--worktree p] [--uses res,res]
  orders check <TAG>   start a separate read-only verifier (or show the active check)
                    [--quote text] [--decisions text] [--spend-cap n] [--protect a,b]
  orders act <TAG> <${HUMAN_ACTIONS.join('|')}> [--note text] [--branch b] [--override]   --override approves a failed, awaiting-user (with report), blocked or idle delivery with a note of at least 10 characters
  orders set <TAG> [--branch b] [--worktree p] [--base-ref local-branch] [--sparse dir,dir] [--uses res,res] [--role id] [--worker id]   records where an order's work is (an order from a table has no branch); logged as an event
  orders run-start <TAG> --worker w [--session s]
  orders run-end <TAG> [--outcome ${RUN_OUTCOMES.join('|')}]   ends the record of the open run (the process is not touched; use "stop" for that); --outcome cancelled also holds the order so that no tick starts it again
  orders report <TAG> --file <report.json | TAG.last.txt>
  orders ready [--json]                      queued orders whose needs are all merged
  orders preflight <TAG> [--json]            check an order before dispatch (sections, paths, needs, optional check commands); exit 1 when held (override: orders act <TAG> queue --override --note "<why>")
  table import [<md file>]                   read the configured dispatch table into state (the file is not changed)
  table render [--out <file>]                write all orders as a Markdown table
  table render --write [--file <copy>]       put the status words back into the one table of the dispatch file (or of a copy): a backup goes to <state_dir>/backups/ first, text outside the table is not touched
  sync [--dry-run] [--json]                  record what the work-order folder already shows: <TAG>.last.txt (delivered, with its report block or an inferred report) and <TAG>.accept.md (accepted)
  state migrate [--dry-run]                  import file state into state.sqlite, verify counts, and keep a timestamped backup
  state export [--out dir]                   write SQLite state back to plain files
  state check                                run SQLite integrity and count checks
  prompt <TAG> [--out <file>]                the prompt file the tool would give a worker for this order, for a person who dispatches by hand
  tick --dry-run [--json] [--no-record]      decide what could be started and what needs attention; changes nothing but quota-history.jsonl
  tick --every <minutes> [--max-dispatch n]  a real tick every n minutes in the foreground: one line when nothing changed, the whole report when something did, a loud mark on exit 2 or 3 (and it goes on); Ctrl+C ends it
  tick [--max-dispatch n]                    for real: record ended runs, resume after transient errors, start up to n new orders (default 1)
                                             exit 0 nothing to say, 1 something can be done, 2 problems, 3 bad configuration
  wait <TAG> [--stall-minutes n] [--timeout-minutes n] [--poll-minutes 2]
                                             blocks until the order's run ends (recorded like a tick does, exit 0), stalls (exit 2) or the time runs out (exit 3)
  check <TAG> [--results file]... [--worktree dir] [--json]   before accepting: worktree checks from the project's "checks:", and the result files against the reference values (later files replace earlier ones); exit 0 all fine, 1 differs/missing/failed, 2 bad configuration
  verify <TAG> [--json]                      run deterministic acceptance gates and record the verification result
  capture <TAG> [--recipe name] [--dry-run] [--json]   build and capture the order's worktree under the capture lock, run screenshot gates and write a contact sheet
  refs adopt --from <file> (--names a,b | --all) --source <text> [--tag T]
                                             take values from a result file into the reference values, after a person decided the change is expected
  run <TAG> --worker id [--dry-run] [--over-cap]  start a queued order: worktree, prompt, background process, run record; a held order (for example after "stop") starts on the worker named; a full kind cap refuses unless --over-cap
  stop <TAG> [--note text]                   stop the open run: its process and every process under it (identity checked), close the run as cancelled and hold the order; then "run <TAG> --worker id" moves it to another worker
  review stats [--days 30] [--json]          agreement, dispute and timing statistics for first-pass reviews by model family and kind
  review <TAG> first-pass-wrong --note text  record first-pass-disputed for the latest applied first-pass bounce (note of at least 10 characters)
  review <TAG> approve|rework [--note text] [--branch b] [--override]  approve checks the branch is merged and writes <TAG>.accept.md; rework sends it back
  review <TAG> sheet [--out file.png] [--columns 4] [--cell 320] [--json]  a contact sheet of the order's evidence pictures (default <state_dir>/review/<TAG>-sheet.png) and each one's size, mean luminance, spread, dark and highlight share, p5/p95, saturation, and the subject against its surround when <name>.mask.png exists
  review <TAG> target [--json]               the latest visual target table, round history and side-by-side sheet paths; exit 0 passed, 1 missed, 2 unmeasured
  serve [--port 4777] [--every 15] [--max-dispatch 1] [--log file] [--watch-code] [--allow-origin url]... [--sign-in] --project f.yaml...
                                             board + JSON interface (docs/console/010-api.md) + a real tick every n minutes (0: none) + an immediate record and tick when a run ends; one serve per state folder; --log appends output to a file; --watch-code reloads after src/ stays quiet 10 s; --sign-in asks for the printed key or link
  serve reload [--port N] [--force] [--wait 90] --project f.yaml...
                                             hand a running alba serve over to new code on the same port without stopping open runs (exit 0 on done, 1 on refusal or timeout)
  answer <TAG> (--text <answer> | --choice N [--text note]) [--worker id]
                                             answer the question an order waits on (--choice picks option N of its options): the worker's own session continues when its engine can, else a new run carries the answer
  say <group> [--text <message>] [--dry-run]    message @running, @monitoring, @waiting, @worker:<id> or @all
  say <TAG> --text <message> [--reply id] [--restart]    leave a message or answer for a running order. --restart stops its process and starts again
  web [--port 4790] [--allow-origin url]... [--sign-in] --project f.yaml...
                                             the board: a server-rendered page on 127.0.0.1 (several --project allowed)
  workers [--json]                           the workers, whether each is available, and why not
  workers set <id> <key>=<value> ... [--dry-run]
                                             change a worker in the workers file with its comments kept (capabilities="[shell, edit, git]" concurrency=4 enabled=false aliases="[a, b]"; null removes a key); checked first, the old file is copied to <file>.bak-<time>
  workers copy <id> <new-id> [<key>=<value> ...] [--dry-run]   a new worker as a copy of one
  workers yaml <id>                          the worker's own YAML as written in the file
  decide "<text>" (--source "<the user's words>" | --default) [--id D2031] [--order TAG] [--date YYYY-MM-DD]
                                             record a decision in the project's ledger (a number in the reviewer's range, or in the range reserved on --order)
  decisions [--json] [--topic t] [--check]   the ledger (with the whole file when decisions.section is "*"), the next number, and the ranges reserved on open orders; --check lists numbers that appear in more than one place
  ask <TAG> --text "<question>" --option "label | note | image;image" ...   2 to 4 options, the recommended one first; the order waits for the answer
  lessons [--tag a,b] [--order TAG] [--all] [--json] | lessons stats [--since 30d] [--kind k] [--json]   the lessons library, an order's matches, or per-lesson first-pass acceptance stats
  credits list [--status s] | quote <TAG> --service s --cap N [--unit u] [--unit-price p --quantity n] [--note t] | approve <TAG> <C1> --cap N [--note t]
          | reject <TAG> <C1> [--note t] | spend <TAG> <C1> --amount N --what t [--key k] | gate <TAG> <C1> --need N [--key k]
                                             quotes for paid resources: the worker asks, a person approves with a cap, "gate" exits 1 unless the approved quote has N left
                                             and holds N under a key; "spend --key" books that hold once (the same key again books nothing)
  resources [--json]                         the shared resources of the project (resources: in the project file): slots, who holds them, for how long; an expired lease is marked
  leases [list] | leases release <resource> <TAG>   the leases held now; a person takes one back (a run that is gone, a lease that ran out)
  loops [TAG] [--all]                        read the logs of open runs (every run with --all) and say which repeated a failing command, took turns between two commands, or sat idle with the log growing; nothing is changed
  route [TAG...] [--all] [--json]            who would take each order and why (role, kind, capabilities, preferences, yield, cost and load); nothing is started. Without tags: the queued orders and those waiting for a need
  routing [list] [--json]                   worker groups and the routes that send each kind of work to them, and who qualifies now
  routing migrate                           print the routing (routes and worker groups) that replaces each file's roles; nothing is written
  roles list | roles show ID [--json]       effective routes (earlier: roles), per-key source files and per-worker results
  plugins [list] | show <id> | doctor [<id>...] [--json]   tool plugins: built in, the project's own, which are enabled, and whether they work on this machine
  editors [list] [--json] | restart <TAG> | stop <TAG>
                                             the editors runs have for themselves (editors: in alba.yaml): order, machine, port, whether the MCP server answers; restart or stop a local one
  tools [list] | run <tool> <operation> [--order TAG] [--input f.json] [--arg k=v]... [--quote C1] | resume <job> | jobs [--order TAG] | show <job> [--json]
                                             run a tool's operation without a worker: a paid one is quoted on the order (approved by a person, or by Alba within plugins.auto_approve), then called; outputs go to the job folder
  classify [TAG...] [--model] [--json]      store each order's kind and tags from the project's "kinds" rules; --model asks the classifier worker for those the rules cannot place
  skills [--order TAG] [--applicable] [--json]
                                             the skill registry (sources, tags, what attaches each): the skills this project can use (its own, and the global ones its engine and include/exclude let through), then those it cannot with the reason (--applicable: only the first); with --order, the skills that order gets and where they are put
  clean [--apply] [--include-ignored] [--json]   what could be removed: merged, idle, clean worktrees (with their merged branch), cache folders of unmerged ones, old builds; skips worktrees with non-regenerable ignored files unless --include-ignored; only a plan unless --apply
  pick <TAG> <Q1> --choice N [--note text] [--who name]   answer a question that was asked with options
  picks [list] [--json] | picks choose <id> --choice key[,key] [--note t] [--who n]
                                             the project's pick sets (files in "picks: dir", and reports with scope "project"): pending, chosen, decided; a choice is kept in the state folder and a decision text is offered
  art [--json]                               the reference board and the setting cards of "art: dir": status, text confirmed or changed since, what is wrong with each file
  refs list [--tag t] | refs add --page url [--image url] --title t --work w --tags a,b --learn text | refs fetch
                                             the reference board: add a card (the picture is the page's og:image or twitter:image), fetch the pictures once into the state folder (https, one request per host every 1.5 s, images up to 15 MB; exit 1 when some failed)
  settings [list] | settings approve <id> [--note t] [--who n]   confirm the text of a setting (its section of the Markdown file, by sha256); no picture is made before that
  spend [list] [--json] | spend approve <quote id> --cap N [--note t] [--who n]   the quote and spend files of "credits: dir" with balance chain and cap checks; approve a quote file up to a cap
  usage [--since 24h|7d|30d|date] [--by day|worker|project|order|kind] [--top N] [--json] | usage scorecard [--kind k] [--since 14d] [--by worker|model|family] [--json]   run tokens and estimates, or cost and time per accepted order; --days N selects external tool ledgers
  lock <name> [--wait-minutes 60] -- <program> [args...] | lock list   run one command under a machine-wide named lock
  image lum <png> [--region x,y,w,h] [--json] | image motion <a.png> <b.png> [--region x,y,w,h] [--json]   measure screenshot brightness or frame motion
  producer [status|cases|actions|would-do|log [--since <time>]|usage [--days N]|pause|resume|act <CASE> <ACTION>|session status|start|stop|mcp] [--json]   observe cases and policy-gated actions

  machines [--json] | machines check [id]     machine health, services and last probe; check probes now
  machines install <id> <item> [--apply]      show how alba would install a missing item (git, cmake, msvc, windows-sdk, compiler, unreal); --apply runs it
  machines jobs [id] [--json]                 jobs run on machines (installs), newest first
  machines edit <id> [field=value ...] [ssh.hostname=H ssh.user=U ssh.port=P] [--dry-run]
                                             without changes: the entry and the Host block of its SSH alias; with them: change the registry entry (name, os, connect, hardware.ram_gb, roles, slots, min_free_mem_gb, timing_allowed, notes, workspace, repos, services; null removes) and the alias's address in the SSH config, then test the connection and probe
  notify test [--channel id] [--workers file] | notify status [--json] [--workers file]
                                             send a test notification or show channels, open conditions, quiet hours and next digest

Options: --workers <workers.yaml> (or ALBA_WORKERS, or "workers:" in alba.yaml) for tick, run, workers and notify.
`;

let exitCode = 0;

function need0(value: string | undefined, usage: string): void { if (!value) fail('Usage: {usage}', { usage }); }

function workersOf(file: string | undefined, project?: ProjectConfig) {
  const path = file ?? process.env.ALBA_WORKERS ?? project?.workers;
  if (!path) fail('No workers file. Pass --workers <workers.yaml>, set ALBA_WORKERS or write "workers:" in the project file.');
  return loadWorkers(path);
}

/** Project files from --project (repeatable) or ALBA_PROJECT (separated like PATH). */
function projectFiles(project: string[] | undefined): string[] {
  const files = project?.length ? project : (process.env.ALBA_PROJECT ?? '').split(path.delimiter).filter(Boolean);
  if (!files.length) fail('No project file. Pass --project <alba.yaml> or set ALBA_PROJECT.');
  return files;
}

function projectOf(project: string[] | undefined): { cfg: ProjectConfig; orders: Orders } {
  const files = projectFiles(project);
  if (files.length > 1) fail('This command works on one project; got {n}.', { n: files.length });
  const cfg = loadProject(files[0]);
  return { cfg, orders: new Orders(stateStore(cfg)) };
}

function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * Who has the order now: the worker of the open run, else the one pinned for the next run, else the newest run's (it moved there:
 * a person named another worker, the tick rotated it), else the one the order was written for.
 */
export const currentWorker = (d: OrderDoc): string => {
  const runs = [...d.runs].sort((a, b) => b.seq - a.seq);
  return runs.find(r => r.ended === undefined)?.worker ?? d.order.next_worker ?? runs[0]?.worker ?? d.order.worker ?? '';
};

function list(orders: Orders, values: { stage?: string; all?: boolean; json?: boolean }, cfg?: ProjectConfig): string {
  if (values.stage && !(STAGES as readonly string[]).includes(values.stage)) fail('Unknown stage "{stage}". Stages: {stages}.', { stage: values.stage, stages: STAGES.join(', ') });
  const docs = orders.all();
  const merged = orders.mergedSet(docs);
  const rows = docs.map(d => ({ d, stage: orders.stage(d, merged).stage }));
  const shown = rows.filter(r => values.stage ? r.stage === values.stage : values.all || !['merged', 'cancelled'].includes(r.stage))
    .sort((a, b) => STAGE_PRIORITY.indexOf(a.stage) - STAGE_PRIORITY.indexOf(b.stage)
      || (a.d.order.source?.row ?? Infinity) - (b.d.order.source?.row ?? Infinity) || b.d.order.updated.localeCompare(a.d.order.updated));
  if (values.json) return JSON.stringify(shown.map(r => ({ tag: r.d.order.tag, stage: r.stage, worker: r.d.order.worker ?? null, current_worker: currentWorker(r.d) || null, kind: r.d.order.kind, review: r.d.order.review ?? cfg?.review ?? 'auto', needs: r.d.order.needs, updated: r.d.order.updated })), null, 2);
  const body = table(['TAG', 'STAGE', 'WORKER', 'KIND', 'REVIEW', 'NEEDS', 'UPDATED'], shown.map(r => [r.d.order.tag, r.stage, currentWorker(r.d), r.d.order.kind, r.d.order.review ?? cfg?.review ?? 'auto', r.d.order.needs.join(','), ago(r.d.order.updated)]));
  const hidden = rows.length - shown.length;
  return `${body}\n${t('{shown} shown{hidden}', { shown: shown.length, hidden: hidden ? t(', {n} merged/cancelled hidden (use --all)', { n: hidden }) : '' })}`;
}

function show(orders: Orders, tag: string, project?: ProjectConfig): string {
  const doc = orders.get(tag);
  const o = doc.order;
  const { stage, why } = orders.stage(doc);
  const out: string[] = [`${o.tag}  ${o.title}`, `${t('stage')}: ${stage}  (${why})`];
  const field = (label: string, value: string | undefined) => { if (value) out.push(`${label}: ${value}`); };
  const sparseDirs = o.worktree && existsSync(o.worktree) ? worktreeSparseDirs(o.worktree) : (project ? effectiveSparse(project, o) : (o.sparse?.length ? o.sparse : undefined));
  field(t('kind'), o.kind); field(t('heavy'), o.heavy); field(t('worker'), o.worker); field(t('model'), o.model); field(t('needs'), o.needs.join(', ')); field(t('condition'), o.condition);
  field(t('source'), o.scheduled?.source); field(t('planned'), o.scheduled?.planned_at);
  field(t('branch'), o.branch); field(t('starts from'), o.base_ref); field(t('worktree'), o.worktree);
  if (sparseDirs?.length) field(t('sparse worktree'), sparseDirs.join(', '));
  field(t('uses'), o.uses?.join(', ')); field(t('tools'), o.tools?.join(', '));
  if (o.mandate) {
    out.push(t('mandate:'));
    field('  ' + t('quote'), o.mandate.quote); field('  ' + t('decisions'), o.mandate.decisions);
    field('  ' + t('spend cap'), o.mandate.spend_cap?.toString()); field('  ' + t('protected paths'), o.mandate.protected_paths?.join(', '));
  }
  out.push('', t('Runs:'));
  out.push(doc.runs.length ? table(['ID', 'WORKER', 'STARTED', 'ENDED', 'OUTCOME', 'NOTE'], doc.runs.map(r => [r.id, r.worker, r.started, r.ended ?? '', r.limit === 'unreachable' ? t('endpoint unreachable') : (r.outcome ?? (r.ended ? '' : 'open')), r.note ?? ''])) : '  ' + t('(none)'));
  for (const r of doc.runs) {
    if (!r.prompt_bytes) continue;
    const kb = (n: number) => n === 0 ? '0' : (n / 1024).toFixed(1);
    const pb = r.prompt_bytes;
    const counts = r.lessons ? ` (${r.lessons.mounted.length} in, ${r.lessons.listed.length} listed)` : '';
    out.push(`  ${r.id}  prompt ${kb(pb.total)} KB: lessons ${kb(pb.lessons)}${counts} | rules ${kb(pb.rules)} | skills ${kb(pb.skills)} | notes ${kb(pb.notes)} | order ${kb(pb.order)} | alba ${kb(pb.alba)}`);
  }
  const endedWithDetail = doc.runs.filter(r => r.end);
  if (endedWithDetail.length) {
    for (const r of endedWithDetail) {
      const e = r.end!;
      const codePart = e.signal ? `signal ${e.signal}` : e.exit_code !== undefined ? `exit ${e.exit_code}` : 'no exit code';
      const lastPart = e.last_event ? `last ${e.last_event.type} (${ago(e.last_event.at)} ago)` : 'last -';
      const wipPart = e.wip_ref ? ` | wip ${e.wip_ref}${e.wip_files !== undefined ? ` (${e.wip_files} file(s))` : ''}${e.wip_skipped ? ' [skipped large files]' : ''}` : e.wip_error ? ` | wip error: ${e.wip_error}` : '';
      out.push(`  ${r.id}  ${e.kind} | ${codePart} | ${lastPart}${wipPart} | ${e.detail}`);
    }
    const wipRefs = [...new Set(endedWithDetail.map(r => r.end?.wip_ref).filter((x): x is string => !!x))];
    for (const ref of wipRefs) {
      out.push(`  ${t('WIP snapshot')}: git show --stat ${ref}  |  ${t('restore')}: git checkout ${ref} -- <path>`);
    }
  }
  const latest = doc.reports[doc.reports.length - 1];
  out.push('', t('Latest report:'));
  if (latest) {
    out.push(`  ${latest.at}  ${latest.status}  ${latest.summary}`);
    if (latest.question) out.push(`  ${t('question')}: ${latest.question}`);
    if (latest.evidence.length) out.push(`  ${t('evidence')}: ${latest.evidence.join(', ')}`);
    if (latest.commits.length) out.push(`  ${t('commits')}: ${latest.commits.join(', ')}`);
  } else out.push('  ' + t('(none)'));
  const waiting = pendingNotes(doc);
  if (waiting.length) out.push('', t('Notes still waiting:'), ...waiting.map(n => `  ${n.at}  ${n.kind}  ${n.text}`));
  const inbox = o.worktree ? readInbox(o.worktree) : [];
  if (inbox.length) {
    const outbox = doc.outbox ?? [];
    out.push('', t('Messages:'), ...inbox.map(m => {
      const state = outbox.some(e => e.reply === m.id) ? 'answered' : (m.delivery ?? 'sent');
      const detail = state === 'requeued'
        ? `${state}${m.requeued_at ? ` ${m.requeued_at}` : ''}${m.action_seq !== undefined ? ` -> action #${m.action_seq}` : ''}`
        : state === 'dropped'
          ? `${state}${m.dropped_at ? ` ${m.dropped_at}` : ''}${m.drop_reason ? ` (${m.drop_reason})` : ''}`
          : state === 'delivered'
            ? `${state}${m.via ? ` via ${m.via}` : ''}${m.delivered_at ? ` ${m.delivered_at}` : ''}`
            : state === 'read' || state === 'answered'
              ? `${state}${m.seen ? ` ${m.seen}` : ''}`
              : state;
      return `  ${m.at}  ${m.author}  [${detail}]  ${m.text.replace(/\s+/g, ' ')}`;
    }));
  }
  const actions = doc.actions;
  if (actions.length) out.push('', t('Actions:'), ...actions.map(a => `  ${a.at}  ${a.kind}${a.note ? '  ' + a.note : ''}`));
  const artifacts = orders.store.events({ tag: o.tag }).filter(e => e.type === 'accept-trial' && Array.isArray(e.data?.artifacts)).at(-1)?.data?.artifacts as { path?: string; sha256?: string; size?: number }[] | undefined;
  if (artifacts?.length) out.push('', 'Artifacts:', ...artifacts.map(a => `  ${a.path ?? '-'}  ${a.sha256 ?? '-'}  ${a.size ?? 0} bytes`));
  out.push('', t('Last events:'));
  const events = orders.store.events({ tag: o.tag, limit: 10 });
  out.push(...(events.length ? events.map(e => `  ${e.at}  ${e.type}${e.by ? ` (${e.by})` : ''}${e.data && Object.values(e.data).some(v => v !== undefined) ? '  ' + JSON.stringify(e.data) : ''}`) : ['  ' + t('(none)')]));
  return out.join('\n');
}

function resolveFile(file: string, cfg: ProjectConfig): string {
  if (existsSync(file)) return file;
  const inWorkOrders = path.join(cfg.work_orders, file);
  if (existsSync(inWorkOrders)) return inWorkOrders;
  return fail('File not found: {file} (also looked in {dir}).', { file, dir: cfg.work_orders });
}

async function run(rawArgv: string[]): Promise<string> {
  const argv = mergeListFlags(rawArgv);
  const orderAdd = argv.includes('orders') && argv.includes('add');
  const { values, positionals } = parseArgs({ args: argv, options: { ...options, check: { type: orderAdd ? 'string' : 'boolean' } }, allowPositionals: true, strict: true });
  let [group, command, ...rest] = positionals;
  if (values.help || !group) return `${HELP}\n${releaseHelp()}`;
  if (group === 'release') {
    const parsed = parseReleaseArgs(argv);
    const files = parsed.values.project?.length || process.env.ALBA_PROJECT ? projectFiles(parsed.values.project) : [];
    if (files.length > 1) fail('This command works on one project; got {n}.', { n: files.length });
    const result = await runReleaseCli(command, rest, parsed.values, files[0]);
    exitCode = result.code;
    return result.output;
  }
  const need = (n: number, usage: string) => { if (rest.length < n) fail('Usage: {usage}', { usage }); };
  if (group === 'state') {
    const files = projectFiles(values.project);
    if (files.length > 1) fail('This command works on one project; got {n}.', { n: files.length });
    const cfg = loadProject(files[0]);
    if (command === 'migrate') {
      const result = migrateState(cfg.state_dir, { dryRun: values['dry-run'] === true });
      return JSON.stringify(result, null, 2);
    }
    if (command === 'export') {
      const out = values.out ? path.resolve(values.out) : path.join(cfg.state_dir, 'export');
      return JSON.stringify({ out, ...exportState(cfg.state_dir, out) }, null, 2);
    }
    if (command === 'check') { const result = checkState(cfg.state_dir); if (!result.ok) exitCode = 1; return JSON.stringify(result, null, 2); }
    return fail('Usage: alba state migrate [--dry-run] | state export [--out dir] | state check');
  }


  if (group === 'web') {
    const port = values.port === undefined ? 4790 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be a port number.');
    const projects = projectFiles(values.project).map(file => loadProject(file));
    const workersPath = values.workers ?? process.env.ALBA_WORKERS ?? projects.find(p => p.workers)?.workers;
    const key = newKey();
    const server = startServer({ projects, workers: workersPath ? loadWorkers(workersPath) : undefined, port, probes: systemProbes, extraOrigins: values['allow-origin'], writeToken: key, signIn: values['sign-in'] === true });
    return new Promise<string>((resolve, reject) => {
      server.once('listening', () => {
        const actual = (server.address() as { port: number }).port;
        try { process.once('exit', writeKeyFile(actual, key)); } catch (e) { console.log(`console key file not written: ${(e as Error).message}`); }
        // Ctrl+C ends through process.exit, so the key file is removed.
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(0));
        console.log(t('Board on http://127.0.0.1:{port}/ (only this machine can reach it). Stop with Ctrl+C.', { port: String(actual) }));
        if (values['sign-in']) console.log(signInLines(actual, key));
      });
      server.once('error', reject);
    });
  }
  if (group === 'serve') {
    if (command === 'reload') {
      if (rest.length) fail('Usage: alba serve reload [--project f.yaml...] [--port N] [--force] [--wait 90]');
      const out = await runServeReloadCli({
        projectFiles: projectFiles(values.project),
        portOption: values.port,
        force: values.force === true,
        waitOption: values.wait,
      });
      if (!out.ok) throw new UserError(out.message);
      return out.message;
    }
    if (command !== undefined) {
      fail('Usage: alba serve [--port 4777] [--every 15] [--max-dispatch 1] [--log file] [--watch-code] [--sign-in] --project f.yaml... | alba serve reload [--port N] [--force] [--wait 90] --project f.yaml...');
    }
    const registerServeSignals = (active: { stop(): void | Promise<void> }) => {
      let stopping = false;
      const onStopSignal = () => {
        if (stopping) return;
        stopping = true;
        const forceExit = setTimeout(() => process.exit(0), 35_000);
        forceExit.unref();
        Promise.resolve(active.stop()).finally(() => {
          clearTimeout(forceExit);
          process.exit(0);
        });
      };
      process.once('SIGINT', onStopSignal);
      process.once('SIGTERM', onStopSignal);
      if (process.platform === 'win32') process.once('SIGBREAK', onStopSignal);
    };
    const logger = createServeLogger(values.log);
    const printListening = (actual: number, everyNum: number, token: string) => {
      logger.print(t('alba serve on http://127.0.0.1:{port}/ (only this machine can reach it); ticks every {every} min (0 = none). Stop with Ctrl+C.', { port: String(actual), every: String(everyNum) }));
      if (values['sign-in']) logger.print(signInLines(actual, token));
    };
    if (values.takeover !== undefined) {
      return runTakeoverServe({
        takeover: values.takeover,
        projectFiles: () => projectFiles(values.project),
        workersOption: values.workers,
        portOption: values.port,
        everyOption: values.every,
        maxDispatchOption: values['max-dispatch'],
        drainSecondsOption: values['drain-seconds'],
        allowOrigin: values['allow-origin'],
        signIn: values['sign-in'] === true,
        watchCode: values['watch-code'] === true,
        logOption: values.log,
        rawArgv,
        startServeFn: startServe,
        registerSignals: registerServeSignals,
        onListeningBanner: printListening,
      });
    }
    const port = values.port === undefined ? 4777 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be a port number.');
    const every = values.every === undefined ? 15 : Number(values.every);
    if (!Number.isFinite(every) || every < 0) fail('--every must be a number of minutes (0 turns the tick loop off).');
    const max = values['max-dispatch'] === undefined ? 1 : Number(values['max-dispatch']);
    if (!Number.isInteger(max) || max < 0) fail('--max-dispatch must be a whole number >= 0.');
    const drainSeconds = values['drain-seconds'] === undefined ? DEFAULT_DRAIN_SECONDS : Number(values['drain-seconds']);
    if (!Number.isFinite(drainSeconds) || drainSeconds < 0) fail('--drain-seconds must be a number of seconds >= 0.');
    const projects = projectFiles(values.project).map(file => loadProject(file));
    const workersPath = values.workers ?? process.env.ALBA_WORKERS ?? projects.find(p => p.workers)?.workers;
    if (!workersPath) fail('alba serve needs a workers file: --workers, ALBA_WORKERS or "workers:" in the project file.');
    const serve = startServe({
      projects,
      workers: loadWorkers(workersPath),
      port,
      probes: systemProbes,
      everyMinutes: every,
      maxDispatch: max,
      print: logger.print,
      extraOrigins: values['allow-origin'],
      signIn: values['sign-in'] === true,
      version: '0.1.0',
      reload: {
        entry: process.argv[1],
        argv: rawArgv,
        execPath: process.execPath,
        execArgv: process.execArgv,
        cwd: process.cwd(),
        logFile: logger.logFile,
        watchCode: values['watch-code'] === true,
        drainSeconds,
        exitOnRelease: true,
      },
    });
    registerServeSignals(serve);
    return new Promise<string>((_resolve, reject) => {
      serve.server.once('listening', () => {
        const actual = (serve.server.address() as { port: number }).port;
        printListening(actual, every, serve.board.ctx.token);
      });
      serve.server.once('error', e => { void Promise.resolve(serve.stop()).finally(() => reject(e)); });
    });
  }
  if (group === 'usage' && command === 'scorecard') {
    return runUsageScorecard(projectFiles(values.project), values, rest);
  }
  if (group === 'usage' && values.days === undefined) {
    const now = new Date(), all = projectFiles(values.project).flatMap(file => {
      const project = loadProject(file), docs = new Orders(stateStore(project)).all();
      const workersPath = values.workers ?? process.env.ALBA_WORKERS ?? project.workers;
      const stored = usageRows(project), indexed = new Map(stored.map(r => [`${r.order}/${r.run}`, r]));
      const refresh = docs.some(doc => doc.runs.some(run => {
        if (run.imported) return false;
        const row = indexed.get(`${doc.order.tag}/${run.id}`);
        return !run.ended || !row || row.source === 'unknown' || row.open || row.merged !== doc.actions.some(a => a.kind === 'approve' && a.seq > run.seq);
      }));
      return refresh ? collectUsage(project, docs, workersPath ? loadWorkers(workersPath) : undefined, systemProbes).rows : stored;
    });
    const report = usageReport(all, values.by ?? 'day', sinceDate(values.since ?? '7d', now), values.top === undefined ? undefined : Number(values.top));
    if (values.json) return JSON.stringify(report, null, 2);
    return table([t('Group'), t('Tokens'), t('Cached'), t('Reasoning'), t('Unknown'), t('Estimate')], [...report.rows.map(r => [r.key, r.known ? String(r.tokens) : t('unknown'), r.cache_unknown ? t('unknown') : String(r.cached), r.reasoning_unknown ? t('unknown') : String(r.reasoning), String(r.unknown), Object.entries(r.estimates).map(([c,n]) => `${n.toFixed(6)} ${c}`).join(', ')]), [t('Total'), report.total.known || !report.total.unknown ? String(report.total.tokens) : t('unknown'), report.total.cache_unknown ? t('unknown') : String(report.total.cached), report.total.reasoning_unknown ? t('unknown') : String(report.total.reasoning), String(report.total.unknown), Object.entries(report.total.estimates).map(([c,n]) => `${n.toFixed(6)} ${c}`).join(', ')]]);
  }
  if (group === 'status') {
    const projects = projectFiles(values.project).map(file => { const project = loadProject(file); return { project, orders: new Orders(stateStore(project)) }; });
    return statusRows(projects, systemProbes).then(async rows => {
      const body = values.json ? JSON.stringify([...rows, ...recentEndedStatusRows(projects, systemProbes)], null, 2) : [formatStatus(rows), ...unreachableStatusLines(projects)].join('\n');
      if (values.json) return body;
      // Editor slots in use (editors: in alba.yaml), with whether each editor answers.
      const editors = (await Promise.all(projects.filter(p => p.project.editors).map(async p => (await editorStatus(p.project)).map(s => ({ ...s, project: p.project.id }))))).flat();
      return editors.length ? `${body}

${editorLines(editors, projects.length > 1)}` : body;
    });
  }
  if (group === 'lock') {
    type LockWithQueue = ReturnType<typeof listNamedLocks>[number] & { run?: string; queue?: { position: number; pid?: number; run?: string; cwd?: string; command?: string; since: string; waitMinutes?: number }[] };
    if (command === 'list') {
      if (rest.length) fail(lockUsage());
      const locks = listNamedLocks() as LockWithQueue[];
      return values.json ? JSON.stringify(locks, null, 2) : (locks.length ? locks.flatMap(l => [
        `${l.name}  ${l.stale ? 'STALE ' : ''}pid ${l.holder ?? '?'}${l.run ? ` (${l.run})` : ''}  held ${l.heldMinutes} min  ${l.cwd ?? '-'}  ${l.command ?? '-'}`,
        ...(l.queue ?? []).map(q => `  queue #${q.position} (${ordinal(q.position)})  pid ${q.pid ?? '?'}${q.run ? ` (${q.run})` : ''}  waiting ${q.waitMinutes ?? 0} min  ${q.cwd ?? '-'}  ${q.command ?? '-'}`),
      ]).join('\n') : '(no named locks)');
    }
    if (!command) fail(lockUsage());
    const args = [command, ...(values['wait-minutes'] !== undefined ? ['--wait-minutes', values['wait-minutes']] : []), '--', ...rest];
    const code = await runNamedLock(args); exitCode = code; return '';
  }
  if (group === 'resources' || group === 'leases') {
    type LockWithQueue = ReturnType<typeof listNamedLocks>[number] & { run?: string; queue?: { position: number; pid?: number; run?: string; cwd?: string; command?: string; since: string; waitMinutes?: number }[] };
    const now = new Date();
    if (group === 'leases' && command === 'release') {
      need(2, 'alba leases release <resource> <TAG> [--project id]');
      const given = values.project ?? [];
      let configFiles: string[] | undefined = values.project;
      let targetProject: string | undefined;
      if (given.length >= 2) {
        configFiles = [given[0]];
        targetProject = given.at(-1);
      } else if (given.length === 1 && !existsSync(given[0])) {
        targetProject = given[0];
        configFiles = undefined;
      }
      const hasEnvProject = Boolean((process.env.ALBA_PROJECT ?? '').split(path.delimiter).filter(Boolean).length);
      const ok = !configFiles && targetProject && !hasEnvProject
        ? releaseMachineLease(rest[0], rest[1], targetProject, t('a person took it back (cli)'), now)
        : (() => { const { cfg, orders } = projectOf(configFiles); return releaseLease(cfg, orders, rest[0], rest[1], t('a person took it back (cli)'), now, targetProject); })();
      return ok ? t('{tag}: released {resource}.', { tag: rest[1], resource: rest[0] }) : t('{tag} holds no lease on {resource}.', { tag: rest[1], resource: rest[0] });
    }
    if (group === 'leases' && command !== undefined && command !== 'list') fail('Usage: alba resources | alba leases [list] | alba leases release <resource> <TAG> [--project id]');
    const { cfg, orders } = projectOf(values.project);
    const views = resourceViews(cfg, orders, now);
    const locks = listNamedLocks(now.getTime()) as LockWithQueue[];
    if (values.json) return JSON.stringify({ resources: views, locks }, null, 2);
    const resourceText = views.map(r => [
      `${r.name}  ${r.used}/${r.slots}${r.exclusive ? ' ' + t('exclusive (keeps out {kinds})', { kinds: r.blocks.join('/') }) : ''}${r.note ? '  ' + r.note : ''}  [${r.scope ?? 'project'}]`,
      ...(r.slotMismatch ? [`  ${r.slotMismatch}`] : []),
      ...r.leases.map(l => `  ${l.project ? `${l.project}:${l.tag}` : l.tag}${l.run ? ` (${l.run})` : ''}  since ${l.since}  ${t('held {min} min', { min: l.heldMinutes })}${l.expired ? '  ' + t('LEASE EXPIRED') : ''}`),
      ...(r.queue ?? []).map(q => `  queue #${q.position} (${ordinal(q.position)})  ${q.project}:${q.tag}  [${q.priority}]  ${q.etaMinutes !== undefined ? t('about {min} min', { min: q.etaMinutes }) : t('unknown')}  since ${q.enqueuedAt}`),
    ].join('\n'));
    const lockText = locks.length ? ['Named locks:', ...locks.flatMap(l => [
      `  ${l.name}  ${l.stale ? 'STALE ' : ''}pid ${l.holder ?? '?'}${l.run ? ` (${l.run})` : ''}  ${t('held {min} min', { min: l.heldMinutes })}  ${l.cwd ?? '-'}  ${l.command ?? '-'}`,
      ...(l.queue ?? []).map(q => `    queue #${q.position} (${ordinal(q.position)})  pid ${q.pid ?? '?'}${q.run ? ` (${q.run})` : ''}  waiting ${q.waitMinutes ?? 0} min  ${q.cwd ?? '-'}  ${q.command ?? '-'}`),
    ])] : [];
    if (!views.length && !locks.length) return t('This project declares no resources (resources: in the project file).');
    return [...resourceText, ...lockText].join('\n');
  }
  if (group === 'image') {
    const bad = (message: string) => { exitCode = 2; return `alba: ${message}`; };
    const parseRegion = (): PixelRegion | undefined => {
      if (values.region === undefined) return undefined;
      const parts = values.region.split(',').map(Number);
      if (parts.length !== 4 || parts.some(n => !Number.isInteger(n)) || parts[2] <= 0 || parts[3] <= 0) return undefined;
      return parts as PixelRegion;
    };
    const region = parseRegion();
    if (values.region !== undefined && !region) return bad('--region must be x,y,w,h with positive whole dimensions.');
    if (command !== 'lum' && command !== 'motion') return bad('Usage: alba image lum <png> [--region x,y,w,h] [--json] | image motion <a.png> <b.png> [--region x,y,w,h] [--json]');
    const need = command === 'lum' ? 1 : 2;
    if (rest.length !== need) return bad('The image command has the wrong number of files.');
    const read = (file: string) => { try { return decodePng(readFileSync(path.resolve(file))); } catch (e) { return { status: 'unsupported' as const, reason: (e as Error).message }; } };
    const first = read(rest[0]!);
    if (first.status !== 'ok') { exitCode = 3; return `alba: ${rest[0]}: ${first.reason}`; }
    const firstRegionProblem = regionError(first.image, region);
    if (firstRegionProblem) return bad(`${rest[0]}: ${firstRegionProblem}`);
    if (command === 'lum') { const value = meanLuminance(first.image, region); return values.json ? JSON.stringify({ file: path.resolve(rest[0]!), width: first.image.width, height: first.image.height, mean_luminance: value, ...(region ? { region } : {}) }) : value.toFixed(6); }
    const second = read(rest[1]!);
    if (second.status !== 'ok') { exitCode = 3; return `alba: ${rest[1]}: ${second.reason}`; }
    const secondRegionProblem = regionError(second.image, region);
    if (secondRegionProblem) return bad(`${rest[1]}: ${secondRegionProblem}`);
    try { const value = meanAbsoluteLuminanceDifference(first.image, second.image, region); return values.json ? JSON.stringify({ a: path.resolve(rest[0]!), b: path.resolve(rest[1]!), width: first.image.width, height: first.image.height, mean_difference: value, ...(region ? { region } : {}) }) : value.toFixed(6); }
    catch (e) { exitCode = 3; return `alba: ${(e as Error).message}`; }
  }
  if (group === 'notify') {
    const res = await runNotifyCli(command, rest, { channel: values.channel, workers: values.workers, project: values.project, json: values.json });
    exitCode = res.code;
    return res.output;
  }
  const { cfg, orders } = projectOf(values.project);
  if (group === 'design-docs') return runDesignDocs(cfg, command, rest, { json: values.json, out: values.out, id: values.id, order: values.version ?? values.order, status: values.status });
  if (group === 'foundations') {
    if (command !== undefined) fail('Usage: alba foundations [--json]');
    const states = foundationStates(cfg);
    const affected: Record<string, { tag: string; stage: string }[]> = {};
    if (states.some(st => !st.ready)) for (const doc of orders.all()) {
      const stage = orders.stage(doc).stage;
      if (!['draft', 'planned', 'queued', 'waiting-needs', 'held', 'running'].includes(stage)) continue;
      for (const gap of foundationGaps(states, orderTraits(cfg, doc))) (affected[gap.name] ??= []).push({ tag: doc.order.tag, stage });
    }
    if (states.some(st => !st.ready)) exitCode = 1;
    return values.json ? JSON.stringify({ configured: !!cfg.foundations, sets: states, orders: affected }, null, 2) : formatFoundations(cfg, states, affected);
  }
  if (group === 'intake') return runIntake(cfg, orders, command, rest, { json: values.json, docs: values.docs, tag: values.tag, dir: values.dir, accept: values.accept, reject: values.reject, drop: values.drop, note: values.note }, code => { exitCode = code; });
  if (group === 'machines') {
    const usage = 'Usage: alba machines [--json] | machines check [id] | machines install <id> <item> [--apply] | machines jobs [id] [--json] | machines edit <id> [field=value ...] [--dry-run]';
    const config = loadMachines(cfg, values.workers);
    if (command === 'edit') return machinesEdit(cfg, orders, config, rest, { dryRun: values['dry-run'] === true, workers: values.workers, json: values.json });
    if (command === 'install') {
      if (rest.length !== 2) return fail(usage);
      const [id, item] = rest;
      return (async () => {
      const plan = await machineInstallPlan(cfg, systemProbes, config, id, item);
      const text = [`${plan.title} on ${id} (${plan.estimate})`, ...plan.notes.map(n => `  - ${n}`), 'Commands:', ...plan.display.map(d => `  ${d}`)].join('\n');
      if (!values.apply) return `${text}\n\nNothing ran. Add --apply to install.`;
      console.log(text);
      const job = await new Promise<MachineJob>((resolve, reject) => { startInstall(cfg, systemProbes, config, id, item, resolve).catch(reject); });
      return `${job.output.trimEnd()}\n\n${job.status === 'ok' ? 'Installed' : `Job ${job.status}`} (exit ${job.exit_code}). The machine was scanned again.`;
      })().catch(e => fail((e as Error).message));
    }
    if (command === 'jobs') {
      if (rest.length > 1) return fail(usage);
      const jobs = machineJobs(cfg, rest[0]);
      if (values.json) return JSON.stringify({ project: cfg.id, jobs }, null, 2);
      return table(['MACHINE', 'ITEM', 'STATUS', 'STARTED', 'STEP', 'EXIT'], jobs.map(j => [j.machine, j.item, j.status, ago(j.started), j.step ?? '', j.exit_code === undefined ? '' : String(j.exit_code)]));
    }
    if (command !== undefined && command !== 'check' || rest.length > 1) return fail(usage);
    const render = (views: MachineView[]) => {
    const shown = rest[0] ? views.filter(m => m.id === rest[0]) : views;
    if (values.json) return JSON.stringify({ project: cfg.id, machines: shown }, null, 2);
    return table(['ID', 'REACHABLE', 'FREE MEM', 'DISK', 'LOAD', 'SERVICES', 'AGE'], shown.map(m => {
      const r = m.latest;
      return [m.id, r ? String(r.reachable) : '?', r?.free_mem_gb === undefined ? '?' : `${r.free_mem_gb.toFixed(1)} GB`, r?.disks.map(d => `${d.mount} ${(d.free_gb / d.total_gb * 100).toFixed(0)}%`).join(', ') || '?', r?.load?.toFixed(2) ?? '?', r ? `${r.services.filter(s => s.up).length}/${m.services.length}` : `?/${m.services.length}`, r ? ago(r.at) : '?'];
    }));
    };
    return command === 'check' ? probeMachines(cfg, systemProbes, { config, force: true, id: rest[0] }).then(render) : render(machinesView(cfg, config));
  }
  if (group === 'gates') {
    if (command === 'status') return JSON.stringify(gatesStatus(cfg) ?? { enabled: false }, null, 2);
    if (command === 'cancel' && !rest.length) {
      const result = cancelNightlyRuns(cfg, orders);
      if (result.reason) exitCode = 1;
      return JSON.stringify(result, null, 2);
    }
    if (command !== 'run' || rest.length) fail('Usage: alba gates run [--now] [--gate name] | status | cancel');
    return runNightlyGates(cfg, orders, { force: values.now, gate: values.gate }).then(result => { if (['failed', 'error'].includes(result.status)) exitCode = 1; return JSON.stringify(result, null, 2); });
  }
  if (group === 'schedules') return runSchedulesCli(cfg, orders, command, rest, { json: values.json, note: values.note, workers: values.workers });
  if (group === 'design' && command === 'measure') {
    const workersPath = values.workers ?? process.env.ALBA_WORKERS ?? cfg.workers;
    const workers = workersPath ? loadWorkers(workersPath) : undefined;
    return runMeasurements(cfg, orders, { targets: rest, dryRun: values['dry-run'], ordersFirst: () => workers
      ? tick(cfg, orders, workers, systemProbes, { record: false }).report.moves.some(m => m.mode !== 'card')
      : orders.all().some(d => orders.stage(d).stage === 'queued') }).then(results => { if (results.some(r => r.status === 'failed')) exitCode = 1; return JSON.stringify(results, null, 2); });
  }
  if (group === 'design') return runDesign(cfg, orders, command, rest, values, code => { exitCode = code; });
  if (group === 'watch') { need0(command, 'alba watch <TAG>'); return watchOrder(cfg, orders, command!, systemProbes); }
  const tagLine = (doc: OrderDoc) => `${doc.order.tag}: ${orders.stage(doc).stage}`;

  if (group === 'producer') {
    const now = systemProbes.now();
    if (command === 'mcp') return runProducerMcp(cfg.file).then(() => '');
    if (command === 'session') {
      const action = rest[0] ?? 'status';
      if (action === 'start') return startProducerSessionDetached(cfg).then(s => JSON.stringify(s, null, 2));
      if (action === 'stop') return stopProducerSession(cfg, orders).then(s => JSON.stringify(s, null, 2));
      if (action === 'status') return JSON.stringify(producerSessionStatus(cfg), null, 2);
      if (action === 'worker') return startProducerSession(cfg, orders).then(async status => { if (status.state !== 'running') return JSON.stringify(status); await new Promise<void>(() => { /* the detached worker remains alive until stop kills it */ }); return ''; });
      fail(t('Usage: alba producer session status|start|stop'));
    }
    if (command === 'pause' || command === 'resume') {
      const paused = setProducerPaused(cfg, command === 'pause', now);
      return values.json ? JSON.stringify({ paused }, null, 2) : (paused ? t('producer paused') : t('producer resumed'));
    }
    if (command === 'act') {
      need(2, 'alba producer act <CASE> <ACTION> [--note text] [--reason text]');
      const action = producerAct(cfg, orders, rest[0], rest[1], { target: values.target, worker: values.worker, note: values.note, reason: values.reason, now }, rest[1] === 'reroute' ? { workers: workersOf(values.workers, cfg), probes: systemProbes } : undefined);
      return values.json ? JSON.stringify(action, null, 2) : `${action.status}: ${action.kind} (${action.caseId})`;
    }
    if (command === 'usage') {
      const rows = producerUsage(cfg, values.days === undefined ? 7 : Number(values.days), now);
      return values.json ? JSON.stringify(rows, null, 2) : table(['UTC day', 'Engine', 'Model', 'Requests', 'Uncached input', 'Cache read', 'Cache write', 'Output', 'Cache hit rate', 'USD', 'Unpriced tokens'], rows.map(r => [r.day, r.engine, r.model, String(r.requests), String(r.uncachedInput), String(r.cacheRead), String(r.cacheWrite), String(r.output), `${(r.cacheHitRate * 100).toFixed(1)}%`, r.unpricedTokens ? 'unpriced' : r.costUsd.toFixed(6), String(r.unpricedTokens)]));
    }
    if (command === 'log') {
      if (values.since && !Number.isFinite(Date.parse(values.since))) fail('"since" must be an ISO time.');
      const log = producerLog(cfg, orders, { since: values.since }, now);
      return values.json ? JSON.stringify(log, null, 2) : log.rows.map(row => activityLine(row, t)).join('\n');
    }
    intakeProducer(cfg, orders, { now });
    const policy = producerPolicy(cfg), state = producerState(cfg);
    if (command === 'cases') return JSON.stringify(producerCases(cfg), null, 2);
    if (command === 'actions') return JSON.stringify(producerActions(cfg), null, 2);
    if (command === 'would-do') return JSON.stringify(producerWouldDo(cfg), null, 2);
    if (command && command !== 'status') fail(t('Usage: alba producer [status|cases|actions|would-do|pause|resume|act <CASE> <ACTION>] [--json]'));
    return JSON.stringify({ project: cfg.id, enabled: policy.enabled, paused: state.paused, policy: { version: policy.version, hash: policy.hash, rules: policy.rules, budgets: policy.budgets }, cases: producerCases(cfg, true), actions: producerActions(cfg), wouldDo: producerWouldDo(cfg), session: producerSessionStatus(cfg) }, null, 2);
  }

  const extra = runExtra(group, command, rest, { ...values, check: values.check === true }, cfg, orders, code => { exitCode = code; });
  if (extra !== undefined) return extra;
  if (group === 'editors') return (async () => {
    const rows = await editorStatus(cfg);
    if (command === undefined || command === 'list') return values.json ? JSON.stringify(rows, null, 2) : rows.length ? editorLines(rows, false) : t('No editor slot is in use.');
    if (command === 'restart' || command === 'stop') {
      need(1, 'alba editors restart|stop <TAG>');
      const slot = editorSlots(cfg).find(s => s.tag.toLowerCase() === rest[0]!.toLowerCase());
      if (!slot) fail('{tag} has no editor slot.', { tag: rest[0]! });
      if (!slot!.spec) fail('The editor of {tag} runs on {machine}; restart it from the run (node .alba/bin/editor.mjs restart).', { tag: slot!.tag, machine: slot!.machine });
      await stopEditors(slot!.spec!);
      if (command === 'restart') await startEditor(slot!.spec!);
      orders.record(slot!.tag, command === 'restart' ? 'editor-restarted' : 'editor-stopped', { port: slot!.port, by: 'cli' });
      return command === 'restart' ? t('The editor of {tag} answers again on {url}.', { tag: slot!.tag, url: slot!.url }) : t('Stopped the editor of {tag}; the slot stays with its run.', { tag: slot!.tag });
    }
    return fail('Usage: {usage}', { usage: 'alba editors [list] [--json] | restart <TAG> | stop <TAG>' });
  })();
  if (group === 'tools') return runTools(cfg, orders, command, rest, { json: values.json === true, order: values.order, input: values.input, arg: values.arg, quote: values.quote }, code => { exitCode = code; });
  if (group === 'plugins') return runPlugins(cfg, command, rest, values.json === true, code => { exitCode = code; });
  if (group === 'route' || group === 'classify' || group === 'skills' || group === 'roles' || group === 'routing') return runRouting(group, command === undefined ? rest : [command, ...rest], values, cfg, orders, () => workersOf(values.workers, cfg)).then(text => text ?? '');

  const library = runLibrary(group, command, rest, values, cfg, orders, () => { const file = values.workers ?? process.env.ALBA_WORKERS ?? cfg.workers; return file ? loadWorkers(file) : undefined; }, code => { exitCode = code; });
  if (library !== undefined) return library;

  if (group === 'loops') return loopsReport(cfg, orders, { tag: command, all: values.all === true });

  if (group === 'orders') {
    switch (command) {
      case 'plan': {
        need(1, 'alba orders plan <TAG> --title t --kind k --needs A,B --intent text');
        return tagLine(planOrder(cfg, orders, { tag: rest[0], title: values.title ?? '', kind: values.kind ?? '', needs: values.needs?.split(',') ?? [], intent: values.intent ?? '', role: values.role }));
      }
      case 'edit-plan': {
        need(1, 'alba orders edit-plan <TAG>');
        return tagLine(editPlan(orders, rest[0], { ...(values.title !== undefined ? { title: values.title } : {}), ...(values.kind !== undefined ? { kind: values.kind } : {}), ...(values.intent !== undefined ? { intent: values.intent } : {}), ...(values.role !== undefined ? { role: values.role } : {}), ...(values.needs !== undefined ? { needs: values.needs.split(',').filter(Boolean) } : {}) }));
      }
      case 'cancel': need(1, 'alba orders cancel <TAG>'); return tagLine(orders.act(rest[0], 'cancel'));
      case 'close': {
        const usage = 'alba orders close <TAG> (--merged-elsewhere <commit-or-ref> | --done-by-lead) [--commit <sha>] [--note text]';
        need(1, usage);
        const elsewhere = values['merged-elsewhere'];
        const byLead = values['done-by-lead'] === true;
        if ((elsewhere !== undefined) === byLead || (elsewhere !== undefined && values.commit !== undefined)) fail('Usage: {usage}', { usage });
        const { closeOrder } = await import('../orders/close.ts');
        const closed = closeOrder(cfg, orders, rest[0], { how: byLead ? 'done-by-lead' : 'merged-elsewhere', commit: byLead ? values.commit : elsewhere, note: values.note });
        return `${tagLine(closed)}\n${orders.stage(closed).why}`;
      }
      case 'list': return list(orders, values, cfg);
      case 'show': need(1, 'alba orders show <TAG>'); return show(orders, rest[0], cfg);
      case 'check': {
        need(1, 'alba orders check <TAG>');
        const check = startIndependentCheck({ project: cfg, orders, workers: workersOf(values.workers, cfg), probes: systemProbes }, rest[0], true);
        return values.json ? JSON.stringify(check, null, 2) : `Independent check ${check.id}: ${check.status} (${check.worker})${check.reason ? `: ${check.reason}` : ''}`;
      }
      case 'add': {
        need(1, 'alba orders add <TAG> --title <text> --kind <kind>');
        if (!values.title) fail('orders add needs --title (and usually --kind; without it the project\'s kinds rules decide).');
        if (values.review !== undefined && !['manual', 'auto'].includes(values.review)) fail('--review must be manual or auto.');
        if (values.check !== undefined && !['independent', 'none'].includes(String(values.check))) fail('--check must be independent or none.');
        const spend = values['spend-cap'];
        if (spend !== undefined && (!Number.isFinite(Number(spend)) || Number(spend) < 0)) fail('--spend-cap must be a number >= 0.');
        const mandate = {
          ...(values.quote ? { quote: values.quote } : {}), ...(values.decisions ? { decisions: values.decisions } : {}),
          ...(spend !== undefined ? { spend_cap: Number(spend) } : {}), ...(values.protect ? { protected_paths: values.protect.split(',').map(s => s.trim()).filter(Boolean) } : {}),
        };
        const body = values['body-file'] ? readFileSync(resolveFile(values['body-file'], cfg), 'utf8') : undefined;
        if (values.role) resolveRole(effectiveRoles(cfg, values.workers || process.env.ALBA_WORKERS || cfg.workers ? workersOf(values.workers, cfg) : undefined), { role: values.role, kind: values.kind ?? '' });
        const sparse = values.sparse === undefined ? undefined : values.sparse.trim() === '' ? [] : values.sparse.split(',').map(s => s.trim()).filter(Boolean);
        const made = createOrder(cfg, orders, { check: values.check as 'independent' | 'none' | undefined, review: values.review as 'manual' | 'auto' | undefined, tag: rest[0], title: values.title, kind: values.kind, role: values.role, needs: values.needs?.split(',') ?? [], worker: values.worker, model: values['run-model'], heavy: values.heavy, branch: values.branch, base_ref: values['base-ref'], ...(sparse !== undefined ? { sparse } : {}), tags: values.tags?.split(','), skills: values.skills?.split(',').map(s => s.trim()).filter(Boolean), uses: values.uses?.split(',').map(s => s.trim()).filter(Boolean), tools: values.tools !== undefined ? enabledTools(cfg, values.tools) : undefined, worktree: values.worktree, mandate, body, slug: values.slug, queue: values.queue === true });
        return [tagLine(made.doc), made.file ? t('wrote {file}', { file: made.file }) : '', made.tableRow ? t('added a row to the dispatch table') : '', made.tableWarning ?? '', made.foundationWarning ?? ''].filter(Boolean).join('\n');
      }
      case 'act': {
        need(2, `alba orders act <TAG> <${HUMAN_ACTIONS.join('|')}> [--note text] [--branch b]`);
        if (!isHumanAction(rest[1])) fail('Unknown action "{kind}". Allowed: {allowed}.', { kind: rest[1], allowed: HUMAN_ACTIONS.join(', ') });
        humanAction(cfg, orders, rest[0], rest[1], values.note, values.branch, values.override === true);
        return tagLine(orders.get(rest[0]));
      }
      case 'preflight': {
        need(1, 'alba orders preflight <TAG> [--json]');
        const { formatPreflight, preflight } = await import('../orders/preflight.ts');
        const result = preflight(cfg, orders, rest[0], { record: true, forceChecks: true });
        exitCode = result.ok ? 0 : 1;
        return values.json ? JSON.stringify(result, null, 2) : formatPreflight(result);
      }
      case 'set': {
        need(1, 'alba orders set <TAG> [--branch b] [--worktree p] [--base-ref local-branch] [--sparse dir,dir] [--uses res,res] [--tools id,id] [--worker id] [--run-model m]');
        if (values.branch === undefined && values.worktree === undefined && values['base-ref'] === undefined && values.sparse === undefined && values.uses === undefined && values.tools === undefined && values.role === undefined && values.worker === undefined && values['run-model'] === undefined) fail('orders set needs --branch, --worktree, --base-ref, --sparse, --uses, --tools, --role, --worker or --run-model.');
        const before = orders.get(rest[0]).order;
        if (values.worker !== undefined) {
          const known = workersOf(values.workers, cfg).workers;
          if (!known.some(w => w.id === values.worker)) fail('Unknown worker "{id}". Known: {known}.', { id: values.worker, known: known.map(w => w.id).join(', ') });
          orders.update(rest[0], { worker: values.worker });
          orders.record(before.tag, 'worker-set', { from: before.worker ?? null, to: values.worker, why: 'orders set --worker' });
        }
        if (values.role !== undefined) {
          if (values.role) resolveRole(effectiveRoles(cfg, values.workers || process.env.ALBA_WORKERS || cfg.workers ? workersOf(values.workers, cfg) : undefined), { role: values.role, kind: before.kind });
          orders.update(rest[0], { role: values.role });
        }
        if (values.uses !== undefined) {
          const names = values.uses.split(',').map(s => s.trim()).filter(Boolean);
          const unknown = names.filter(n => !(cfg.resources && n in cfg.resources));
          if (unknown.length) fail('The project does not declare the resource(s): {names}. Declared: {known}.', { names: unknown.join(', '), known: Object.keys(cfg.resources ?? {}).join(', ') || '-' });
          orders.update(rest[0], { uses: names });
        }
        if (values.tools !== undefined) orders.update(rest[0], { tools: enabledTools(cfg, values.tools) });
        if (values['run-model'] !== undefined) orders.update(rest[0], { model: values['run-model'].trim() || undefined });
        if (values.sparse !== undefined) {
          const dirs = values.sparse.trim() === '' ? [] : values.sparse.split(',').map(s => s.trim()).filter(Boolean);
          orders.update(rest[0], { sparse: dirs });
        }
        const doc = values.branch === undefined && values.worktree === undefined && values['base-ref'] === undefined ? orders.get(rest[0]) : orders.setGit(rest[0], { branch: values.branch, worktree: values.worktree, base_ref: values['base-ref'] });
        const o = doc.order;
        const fields = (['branch', 'worktree', 'base_ref'] as const).filter(k => o[k] !== before[k]);
        const usesLine = [
          ...(values.uses !== undefined && JSON.stringify(o.uses ?? []) !== JSON.stringify(before.uses ?? []) ? [`  uses: ${(before.uses ?? []).join(',') || '-'} -> ${(o.uses ?? []).join(',') || '-'}`] : []),
          ...(values.tools !== undefined && JSON.stringify(o.tools ?? []) !== JSON.stringify(before.tools ?? []) ? [`  tools: ${(before.tools ?? []).join(',') || '-'} -> ${(o.tools ?? []).join(',') || '-'}`] : []),
          ...(values['run-model'] !== undefined ? [`  model: ${before.model || '-'} -> ${o.model || '- (the worker\'s)'}`] : []),
          ...(values.sparse !== undefined && JSON.stringify(o.sparse) !== JSON.stringify(before.sparse) ? [`  sparse: ${before.sparse === undefined ? '- (project default)' : before.sparse.length ? before.sparse.join(',') : 'full'} -> ${o.sparse?.length ? o.sparse.join(',') : 'full'}`] : []),
        ];
        return [tagLine(doc), ...fields.map(k => `  ${k}: ${before[k] ?? '-'} -> ${o[k]}`), ...usesLine, ...(values.role !== undefined ? [`  role: ${before.role || '-'} -> ${o.role || '- (from kind)'}`] : []), ...(values.worker !== undefined ? [`  worker: ${before.worker || '-'} -> ${o.worker}`] : []), fields.length || usesLine.length || values.role !== undefined || values.worker !== undefined ? '' : t('nothing changed')].filter(Boolean).join('\n');
      }
      case 'run-start': {
        need(1, 'alba orders run-start <TAG> --worker <worker>');
        if (!values.worker) fail('run-start needs --worker.');
        const { doc, run: r } = orders.runStart(rest[0], { worker: values.worker, session: values.session });
        return `${tagLine(doc)} (${r.id}${r.note ? t(', with rework note: {note}', { note: r.note }) : ''})`;
      }
      case 'run-end': {
        need(1, 'alba orders run-end <TAG> [--outcome o]');
        const outcome = (values.outcome ?? 'completed') as RunOutcome;
        const { doc: ended, run: closed } = orders.runEnd(rest[0], outcome);
        // A run a person ends as completed whose log already ends with its report (a worker whose process stayed after its last
        // message): that report is recorded, as the end of the process would have done.
        const found = outcome === 'completed' && !ended.reports.some(r => r.run === closed.id) ? reportInRunLog(systemProbes, closed) : undefined;
        const stale = found && staleReport(ended, closed, found.report, found.file);
        if (stale) orders.record(rest[0], 'stale-report', stale);
        if (found && !stale) {
          orders.report(rest[0], { ...found.report, ...(hasDeliveryChecks(cfg.checks) ? { delivery_text: found.text } : {}) }, path.basename(found.file));
          requeueUndeliveredInbox(orders, rest[0], closed);
          if (found.report.status === 'ready') {
            const { mergeBaseBeforeReview } = await import('../check/base-merge.ts');
            mergeBaseBeforeReview(cfg, orders, rest[0], closed);
          }
          lintDelivery(cfg, orders, rest[0]);
          return `${tagLine(orders.get(rest[0]))}\n${t('Recorded the report at the end of its log ({status}: {summary}).', { status: found.report.status, summary: found.report.summary.slice(0, 120) })}`;
        }
        requeueUndeliveredInbox(orders, rest[0], closed);
        // A person who ends a run as cancelled does not want the next tick to start it again at once (on whatever worker routing picks).
        if (outcome !== 'cancelled' || orders.stage(ended).stage !== 'queued' && orders.stage(ended).stage !== 'waiting-needs') return tagLine(ended);
        orders.act(rest[0], 'hold', { note: t('run ended as cancelled by a person') });
        return `${tagLine(orders.get(rest[0]))}
${t('Held so that no tick starts it again. Start it on a worker with "alba run {tag} --worker <id>", or release it with "alba orders act {tag} release".', { tag: ended.order.tag })}`;
      }
      case 'report': {
        need(1, 'alba orders report <TAG> --file <report.json | last.txt>');
        if (!values.file) fail('report needs --file.');
        const file = resolveFile(values.file, cfg);
        const parsed = parseReportFile(file, readFileSync(file, 'utf8'));
        const doc = orders.get(rest[0]);
        const current = doc.runs.at(-1) ?? { id: '', started: orders.now() };
        const stale = (doc.runs.length || parsed.run) && staleReport(doc, current, parsed, file, statSync(file).mtime.toISOString(), prior => engineSession(prior, systemProbes));
        if (stale) {
          orders.record(rest[0], 'stale-report', stale);
          return t('stale report');
        }
        orders.report(rest[0], { ...parsed, ...(hasDeliveryChecks(cfg.checks) ? { delivery_text: readFileSync(file, 'utf8') } : {}) }, path.basename(file));
        lintDelivery(cfg, orders, rest[0]);
        return tagLine(orders.get(rest[0]));
      }
      case 'ready': {
        const ready = orders.ready();
        if (values.json) return JSON.stringify(ready.map(d => ({ tag: d.order.tag, worker: d.order.worker ?? null, kind: d.order.kind, heavy: d.order.heavy ?? null })), null, 2);
        return ready.length ? table(['TAG', 'WORKER', 'KIND', 'HEAVY'], ready.map(d => [d.order.tag, d.order.worker ?? '', d.order.kind, d.order.heavy ?? ''])) : t('No order is ready.');
      }
      default: return fail('Unknown command "orders {command}". Run alba --help.', { command: command ?? '' });
    }
  }

  if (group === 'wait') {
    need0(command, 'alba wait <TAG> [--stall-minutes n] [--timeout-minutes n]');
    const num = (v: string | undefined, name: string, fallback: number | undefined) => {
      if (v === undefined) return fallback;
      if (!Number.isFinite(Number(v)) || Number(v) <= 0) fail('--{name} must be a number above 0.', { name });
      return Number(v);
    };
    const options = { stallMinutes: num(values['stall-minutes'], 'stall-minutes', cfg.dispatch.stall_minutes ?? 60)!, timeoutMinutes: num(values['timeout-minutes'], 'timeout-minutes', undefined), pollMinutes: num(values['poll-minutes'], 'poll-minutes', 2)! };
    const ctx = { project: cfg, orders, workers: { workers: [], quota_sources: {}, file: '' }, probes: systemProbes };
    return waitFor(ctx, command!, options, { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), print: line => console.log(line) }).then(r => { exitCode = r.exitCode; return r.line; });
  }

  if (group === 'check') {
    need0(command, 'alba check <TAG> [--results file]...');
    const report = runCheck(cfg, orders, command!, values.results ?? [], values.worktree);
    exitCode = report.exitCode;
    return values.json ? JSON.stringify(report, null, 2) : formatCheck(report);
  }

  if (group === 'verify') {
    need0(command, 'alba verify <TAG> [--json]');
    const report = verifyOrder(cfg, orders, command!, { manual: true });
    exitCode = report.exitCode;
    return values.json ? JSON.stringify(report, null, 2) : formatVerify(report);
  }

  if (group === 'capture') {
    need0(command, 'alba capture <TAG> [--recipe name] [--dry-run] [--json]');
    const doc = orders.get(command!);
    if (values['dry-run']) {
      const plan = dryRunCapture(cfg, orders, doc.order.tag, { recipe: values.recipe });
      return values.json ? JSON.stringify(plan, null, 2) : formatCaptureDryRun(plan);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(cfg.state_dir, 'capture', `${doc.order.tag}-${stamp}`);
    const result = runCapture(cfg, orders, doc.order.tag, { recipe: values.recipe, outDir });
    orders.record(doc.order.tag, 'capture-run', { report: doc.reports.at(-1)?.seq ?? null, summary: result.summary });
    exitCode = result.summary.status === 'passed' ? 0 : 1;
    return values.json ? JSON.stringify(result.summary, null, 2) : formatCaptureRun(doc.order.tag, result);
  }

  if (group === 'refs') {
    if (command !== 'adopt') return fail('Usage: alba refs adopt --from <file> (--names a,b | --all) --source <text>');
    if (!cfg.checks.references || !cfg.checks.result_parser) fail('{file}: "checks.references" and "checks.result_parser" are needed.', { file: cfg.file });
    if (!values.from || !values.source || (!values.names && !values.all)) fail('Usage: alba refs adopt --from <file> (--names a,b | --all) --source <text>');
    const file = resolveFile(values.from, cfg);
    const names = values.all ? 'all' as const : values.names!.split(',').map(s => s.trim()).filter(Boolean);
    const result = adopt(loadRefs(cfg.checks.references), parseResults(cfg.checks.result_parser, readFileSync(file, 'utf8')), names, values.source, new Date().toISOString());
    if (result.notFound.length) fail('Not in {file}: {names}. Nothing was changed.', { file: path.basename(file), names: result.notFound.join(', ') });
    saveRefs(cfg.checks.references, result.refs);
    orders.record(values.tag ?? '*', 'refs-adopt', { from: path.basename(file), source: values.source, names: result.adopted });
    return t('Adopted {n} value(s) from {file} into {refs}: {names}', { n: result.adopted.length, file: path.basename(file), refs: path.basename(cfg.checks.references), names: result.adopted.join(', ') });
  }

  if (group === 'sync') {
    const r = syncOrders(cfg, orders, { dryRun: values['dry-run'] });
    if (values.json) return JSON.stringify(r, null, 2);
    const out = [values['dry-run'] ? t('Would record {n} fact(s):', { n: r.changes.length }) : t('Recorded {n} fact(s):', { n: r.changes.length }), ...r.changes.map(c => `  ${c.tag}: ${c.what}`)];
    if (r.skipped.length) out.push(t('Left alone ({n}):', { n: r.skipped.length }), ...r.skipped.map(x => `  ${x.tag} ${x.file}: ${x.why}`));
    if (r.unknown.length) out.push(t('No order for {n} file tag(s): {tags}', { n: r.unknown.length, tags: r.unknown.join(', ') }));
    return out.join('\n');
  }

  if (group === 'prompt') {
    need0(command, 'alba prompt <TAG> [--out <file>]');
    const doc = orders.get(command!);
    let promptWorkers: ReturnType<typeof workersOf> | undefined;
    try { promptWorkers = workersOf(values.workers, cfg); } catch { promptWorkers = undefined; }
    const role = resolveRole(effectiveRoles(cfg, promptWorkers), { ...doc.order, kind: routingOf(cfg, doc).kind || doc.order.kind });
    const text = withRoleRules(promptFor(cfg.work_orders, doc, selectLessons(cfg, doc, lessonRunFor(cfg, promptWorkers, values.worker ?? (currentWorker(doc) || undefined))), planSkills(cfg, promptWorkers, doc).listed, cfg.lessons?.max_rule_lines), roleRules(role));
    if (values.out) { writeFileSync(values.out, text, 'utf8'); return t('Wrote {file}', { file: values.out }); }
    return text.trimEnd();
  }

  if (group === 'workers' && command && ['set', 'copy', 'yaml'].includes(command)) {
    // alba workers set <id> key=value ... | copy <id> <new-id> [key=value ...] | yaml <id>: the same write as the console's (comments kept, validated, backed up, an event)
    const file = workersOf(values.workers, cfg).file;
    const dryRun = values['dry-run'] === true;
    const usage = 'alba workers set <id> <key>=<value> ... | copy <id> <new-id> [<key>=<value> ...] | yaml <id>   (add --dry-run to only check)';
    const id = rest[0];
    if (!id) fail('Usage: {usage}', { usage });
    if (command === 'yaml') return workerYaml(file, id).trimEnd();
    const out = command === 'set'
      ? editWorker(file, id, parseSetArgs(rest.slice(1)), { dryRun })
      : addWorker(file, { id: rest[1] ?? fail('Usage: {usage}', { usage }), copyFrom: id, set: Object.fromEntries(parseSetArgs(rest.slice(2)).map(op => [op.path.join('.'), op.value])) }, { dryRun });
    recordWorkerEdit(orders, command === 'set' ? id : rest[1], out, file);
    const name = command === 'set' ? id : rest[1];
    if (!out.changed.length) return t('{id}: nothing changed.', { id: name });
    return [out.dryRun ? t('{id}: would change {fields} (dry run, nothing written).', { id: name, fields: out.changed.join(', ') }) : t('{id}: changed {fields}. The old file is {backup}.', { id: name, fields: out.changed.join(', '), backup: out.backup ?? '-' })].join('\n');
  }

  if (group === 'tick' || group === 'workers') {
    const workersFile = values.every !== undefined ? { workers: [], quota_sources: {}, file: '' } : workersOf(values.workers, cfg);
    const ctx = { project: cfg, orders, workers: workersFile, probes: systemProbes };
    if (group === 'tick' && values.every !== undefined) {
      const minutes = Number(values.every);
      if (!Number.isFinite(minutes) || minutes <= 0) fail('--every must be a number of minutes above 0.');
      const max = values['max-dispatch'] === undefined ? 1 : Number(values['max-dispatch']);
      if (!Number.isInteger(max) || max < 0) fail('--max-dispatch must be a whole number >= 0.');
      return tickLoop(() => {
        const holder = lockHolder(cfg.state_dir);
        if (holder) { orders.record('*', 'tick-skipped', { reason: 'serve', pid: holder.pid }); return { text: skipLine(holder), signature: 'skipped', exitCode: 0 }; }
        const real = executeTick({ ...ctx, workers: workersOf(values.workers, cfg) }, { maxDispatch: max });
        return { text: formatReport(real.report, false), signature: JSON.stringify({ ...real.report, at: undefined }), exitCode: real.report.exitCode };
      }, minutes, { print: line => console.log(line), sleep: ms => new Promise(r => setTimeout(r, ms)), clock: () => new Date().toTimeString().slice(0, 5) }).then(() => '');
    }
    if (group === 'tick' && !values['dry-run'] && lockHolder(cfg.state_dir)) {
      const holder = lockHolder(cfg.state_dir)!;
      orders.record('*', 'tick-skipped', { reason: 'serve', pid: holder.pid });
      return skipLine(holder);
    }
    ctx.probes = await prewarmEndpointProbes(orders, workersFile, systemProbes);
    if (group === 'tick' && !values['dry-run']) {
      const max = values['max-dispatch'] === undefined ? 1 : Number(values['max-dispatch']);
      if (!Number.isInteger(max) || max < 0) fail('--max-dispatch must be a whole number >= 0.');
      const real = executeTick(ctx, { maxDispatch: max });
      exitCode = real.report.exitCode;
      return values.json ? JSON.stringify(real.report, null, 2) : formatReport(real.report, false);
    }
    const result = tick(cfg, orders, workersFile, ctx.probes, { record: group === 'tick' && !values['no-record'], finishes: group === 'tick' ? findFinishes(cfg, orders, ctx.probes, workersFile).map(f => ({ tag: f.tag, run: f.run, outcome: f.outcome, why: f.why })) : undefined });
    if (group === 'workers') {
      const view = result.workers.map(w => ({ id: w.config.id, engine: w.config.engine, paid: w.config.paid, available: w.available, why_not: w.reasons, running: w.running, concurrency: w.config.concurrency, runs_today: w.runsToday, card_only: w.config.card_only }));
      if (values.json) return JSON.stringify({ workers: view, quotas: result.quotas }, null, 2);
      return table(['WORKER', 'ENGINE', 'PAID', 'AVAILABLE', 'RUNNING', 'TODAY', 'WHY NOT'], view.map(w => [w.id, w.engine, w.paid ? 'yes' : 'no', w.available ? 'yes' : 'no', `${w.running}/${w.concurrency}`, String(w.runs_today), w.why_not.join('; ')]), 90);
    }
    exitCode = result.report.exitCode;
    return values.json ? JSON.stringify(result.report, null, 2) : formatReport(result.report, true);
  }

  if (group === 'say') {
    need0(command, 'alba say <TAG | group> --text <message> [--restart | --dry-run]');
    const isGroup = command!.startsWith('@');
    if (!isGroup && values['dry-run']) fail('--dry-run needs a message group.');
    if (!isGroup && !values.text?.trim()) fail('A message needs its text (--text).');
    let workers = { file: '', workers: [] as ReturnType<typeof workersOf>['workers'], quota_sources: {} };
    if (values.restart && !isGroup) workers = workersOf(values.workers, cfg);
    else { try { workers = workersOf(values.workers, cfg); } catch { /* projects without a workers file fall back to run.engine */ } }
    const ctx = { project: cfg, orders, workers, probes: systemProbes };
    if (isGroup) {
      const result = sayToGroup(ctx, command!, values.text ?? '', { dryRun: values['dry-run'], restart: values.restart, reply: values.reply });
      if (result.results.some(row => row.error)) exitCode = 1;
      if (values.json) return JSON.stringify(result, null, 2);
      return result.results.map(r => [r.tag, r.delivery ?? r.error].filter(Boolean).join('  ')).join('\n') || t('No matching orders.');
    }
    return sayToOrder(ctx, command!, values.text, { restart: values.restart, reply: values.reply }).message;
  }

  if (group === 'answer') {
    need0(command, 'alba answer <TAG> (--text <answer> | --choice N) [--worker id]');
    if (!values.text && values.choice === undefined) fail('alba answer needs --text <answer> or --choice <option number>.');
    const choice = values.choice === undefined ? undefined : Number(values.choice);
    if (choice !== undefined && !Number.isInteger(choice)) fail('--choice must be an option number (1, 2, ...).');
    return answerOrder({ project: cfg, orders, workers: workersOf(values.workers, cfg), probes: systemProbes }, command!, values.text, { worker: values.worker, choice, who: values.who }).message;
  }

  if (group === 'stop') {
    need0(command, 'alba stop <TAG> [--note text]');
    const warning = stopRun(orders, command!, values.note);
    const doc = orders.get(command!);
    return `${tagLine(doc)}
${t('Stopped run {run}. The order is held: start it on a worker with "alba run {tag} --worker <id>", or release it with "alba orders act {tag} release".', { run: [...doc.runs].reverse().find(r => r.outcome === 'cancelled')?.id ?? '-', tag: doc.order.tag })}${warning ? '\n' + warning : ''}`;
  }
  if (group === 'run') {
    need0(command, 'alba run <TAG> --worker <id> [--dry-run] [--over-cap]');
    const r = startRun({ project: cfg, orders, workers: workersOf(values.workers, cfg), probes: systemProbes }, command!, values.worker, { dryRun: values['dry-run'], explicitWorker: values.worker !== undefined, overCap: values['over-cap'] === true });
    if (r.mode === 'card') return r.text;
    return r.dryRun
      ? t('Would start {tag} with {worker} in {cwd} on branch {branch}.', { tag: r.tag, worker: r.worker, cwd: r.cwd, branch: r.branch })
      : t('Started {tag} with {worker}: run {run}, pid {pid}, worktree {cwd} (branch {branch}), log {log}', { tag: r.tag, worker: r.worker, run: r.run ?? '-', pid: r.pid ?? '-', cwd: r.cwd, branch: r.branch, log: r.log ?? '-' });
  }

  if (group === 'review') {
    if (command === 'stats') {
      const days = values.days === undefined ? 30 : Number(values.days);
      if (!Number.isFinite(days) || days <= 0) fail('--days must be a positive number.');
      const stats = computeFirstPassStats(cfg, orders, { days, now: systemProbes.now() });
      return values.json ? JSON.stringify(stats, null, 2) : formatFirstPassStats(stats);
    }
    if (command && rest[0] === 'first-pass-wrong') {
      const disputed = disputeFirstPass(orders, command, values.note);
      return t('{tag}: recorded first-pass dispute for {id}.', { tag: disputed.tag, id: disputed.id });
    }
    need0(command, 'alba review <TAG> approve|rework [--note text] [--branch b]');
    const action = rest[0];
    if (action === 'approve') {
      const r = approve(cfg, orders, command!, values.note, values.branch, values.override === true); // same step as humanAction(..., 'approve')
      return t('{tag}: merged. Wrote {file} (branch {branch} is in the base branch; accept: {accept})', { tag: command!, file: r.acceptFile, branch: r.merge, accept: r.accept });
    }
    if (action === 'rework') { rework(orders, command!, values.note, { max: cfg.dispatch.max_reworks, override: values.override === true }); return tagLine(orders.get(command!)); }
    if (action === 'sheet') {
      const tag = orders.get(command!).order.tag;
      const out = values.out ? path.resolve(values.out) : path.join(cfg.state_dir, 'review', `${tag}-sheet.png`);
      const sheet = contactSheet(cfg, orders, systemProbes, tag, { out, ...(values.columns ? { columns: Number(values.columns) } : {}), ...(values.cell ? { cell: Number(values.cell) } : {}) });
      return values.json ? JSON.stringify(sheet, null, 2) : formatSheet(sheet);
    }
    if (action === 'target') {
      const view = reviewTarget(cfg, orders, command!);
      exitCode = view.exitCode;
      return values.json ? JSON.stringify(view, null, 2) : formatReviewTarget(view);
    }
    fail('Usage: alba review <TAG> approve|rework|sheet|target [--note text] [--branch b] [--out file.png] [--json]');
  }

  if (group === 'table') {
    const cfgTable = cfg.dispatch_table;
    if (!cfgTable) fail('{file} has no dispatch_table section.', { file: cfg.file });
    if (command === 'import') {
      const file = rest[0] ? path.resolve(rest[0]) : cfgTable.file;
      if (!existsSync(file)) fail('File not found: {file}', { file });
      const r = importTable(orders, { ...cfgTable, file }, readFileSync(file, 'utf8'));
      const lines = [t('Table rows: {n}. Created {c}, updated {u}, unchanged {k}; {m} merged orders taken from the merged list.', { n: r.rows, c: r.created.length, u: r.updated.length, k: r.unchanged.length, m: r.mergedFromList.length })];
      for (const w of r.warnings) lines.push(`warning: ${w}`);
      // What each order is: from the rules at once; orders they cannot place are given to the classifier worker, when there is one.
      const touched = new Set([...r.created, ...r.updated]);
      const tags = orders.all().filter(d => !d.order.routing || touched.has(d.order.tag)).map(d => d.order.tag);
      let wf: ReturnType<typeof workersOf> | undefined;
      if (cfg.classifier?.worker) { try { wf = workersOf(values.workers, cfg); } catch { wf = undefined; } }
      return classifyOrders({ project: cfg, orders, workers: wf ?? { workers: [], quota_sources: {}, file: '' }, probes: systemProbes }, { tags, model: !!wf }).then(done => {
        const by: Record<string, number> = {};
        for (const o of done) by[o.routing.source] = (by[o.routing.source] ?? 0) + 1;
        if (done.length) lines.push(t('Classified {n} order(s): {by}.', { n: done.length, by: Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ') }));
        for (const o of done) if (o.problem) lines.push(`warning: ${o.tag}: ${o.problem}`);
        return lines.join('\n');
      });
    }
    if (command === 'render' && values.write) {
      const target = values.file ? path.resolve(values.file) : cfgTable.file;
      if (!existsSync(target)) fail('File not found: {file}', { file: target });
      const r = writeBack(orders, { ...cfgTable, file: target }, target, cfg.state_dir, new Date());
      return [t('Wrote {file}: {c} row(s) changed, {a} added, {k} left as written. Backup: {backup}', { file: target, c: r.changed.length, a: r.added.length, k: r.kept.length, backup: r.backup }), ...r.warnings.map(w => `warning: ${w}`)].join('\n');
    }
    if (command === 'render') {
      const r = renderTable(orders, cfgTable);
      for (const w of r.warnings) console.error(`warning: ${w}`);
      if (values.out) { writeFileSync(values.out, r.markdown, 'utf8'); return t('Wrote {file}', { file: values.out }); }
      return r.markdown.trimEnd();
    }
    return fail('Unknown command "table {command}". Run alba --help.', { command: command ?? '' });
  }
  return fail('Unknown command "{group}". Run alba --help.', { group });
}

try {
  const out = await run(process.argv.slice(2));
  if (out) console.log(out);
  process.exitCode = exitCode;
} catch (e) {
  if (e instanceof UserError || e instanceof DesignError) console.error(`alba: ${e.message}`);
  else if ((e as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || (e as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') console.error(`alba: ${(e as Error).message}`);
  else console.error(e);
  // For tick, anything that stops it before it can decide is a configuration problem (exit 3).
  const argv = process.argv.slice(2);
  process.exitCode = argv.includes('tick') ? 3 : argv.includes('check') || argv.includes('capture') || (argv.includes('refs') && argv.includes('adopt')) ? 2 : 1;
}

export type { Stage };
