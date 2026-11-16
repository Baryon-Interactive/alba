import { ownerOf } from '../usage/spend.ts';
import { foundationBlock } from '../foundations/foundations.ts';
import { withFleetLock } from '../serve/fleet.ts';
import { parseStreamLog, textSessionId, workerAdapter, remoteTarget, writeRemoteSpec } from '../workers/adapters/index.ts';
import { chooseWorker, rolePolicy } from '../routing/choose.ts';
import { previousAttempts } from './previous-attempts.ts';
import { roleForOrder, workerPinProblem } from '../routing/route.ts';
import { mountRole, roleRules, withRoleRules } from '../roles/mount.ts';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeDesignSnapshot } from '../design/worker.ts';
import { writeIntakeBlocksSnapshot } from '../design/docs.ts';
import path from 'node:path';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { Run } from '../orders/model.ts';
import { heldStartPlan, type Orders } from '../orders/service.ts';
import type { Probes } from '../tick/gather.ts';
import type { WorkersFile } from '../workers/config.ts';
import { lessonsForOrder } from '../lessons/lessons.ts';
import { routingOf } from '../routing/classify.ts';
import { acquireLeases, activeLeases, capFull, capHolds, kindOfOrder, occupants, releaseLease, startBlocked, usesOf, type CapHold } from '../resources/leases.ts';
import { stateTransaction } from '../orders/state-files.ts';
import { excludeLocally, mountSkills } from '../skills/mount.ts';
import { ensureInbox, installLockHelper } from './inbox.ts';
import { planSkills, skillEnvValues } from '../skills/plan.ts';
import { checkToolEnvironment, orderTools, toolsPrompt, withToolServers } from '../plugins/tools.ts';
import { handoffLine, handoffPrompt, writeHandoff } from './handoff.ts';
import { answerPrompt, findOrderFile, launchArgs, messagePrompt, monitorPrompt, pendingNotes, promptFor } from './prompt.ts';
import { MAX_RESUMES } from './transient.ts';
import { baseRefOf, checkBaseRef, commonGitDir, ensureWorktree, mainCheckoutState, planWorktree, worktreeGitDir } from './worktree.ts';
import { installBaseGuard, RUN_ENV } from './ref-guard.ts';
import { bindEditor, dropEditor, editorPoolsOf, editorPortProblem, editorPrompt, editorSlots, runMachine, takeEditor } from '../editors/pool.ts';
import type { ResolvedRole } from '../roles/config.ts';

/** The role with the run's editor as an HTTP MCP server. */
function withEditor(role: ResolvedRole, name: string | undefined, url: string | undefined): ResolvedRole {
  if (!name || !url) return role;
  if (role.definition?.mcp?.[name]) fail('The editor MCP server name "{server}" is already used by role {role} or a tool.', { server: name, role: role.id ?? '-' });
  return { ...role, definition: { sources: {}, ...role.definition, mcp: { ...role.definition?.mcp, [name]: { url, command: '', args: [] } } } };
}

/** NO_PROXY with the loopback addresses added: a machine with HTTPS_PROXY set would send the editor's MCP calls to the proxy. */
export const withLoopback = (value: string | undefined): string => [...new Set([...(value ?? '').split(',').map(x => x.trim()).filter(Boolean), '127.0.0.1', 'localhost'])].join(',');

export interface RunContext {
  project: ProjectConfig; orders: Orders; workers: WorkersFile; probes: Probes;
  /** Open runs of the other projects that share the workers file, by worker id (src/serve/fleet.ts); read fresh on each call. */
  peers?: () => Map<string, number>;
}

/** Why the tool chose this worker (what a run records); absent when a person named it. */
export interface RouteNote { why: string; rejected: { worker: string; reason: string }[] }

export type StartResult =
  | { mode: 'card'; tag: string; worker: string; text: string }
  | { mode: 'start'; tag: string; worker: string; run?: string; cwd: string; branch: string; created: boolean; pid?: number; log?: string; /** The engine's earlier session was continued. */ resumed?: boolean; dryRun: boolean };

const slash = (p: string) => p.replace(/\\/g, '/');

/** The values of a launch environment with `{skill_names}` and `{skill_allow}` filled in. */
export function expandEnv(env: Record<string, string>, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/(\$?)\{(\w+)\}/g, (match, reference: string, name: string) => {
    if (!reference) return name in values ? values[name] : match;
    if (process.env[name] === undefined) fail('Launch environment variable {name} is not set.', { name });
    return process.env[name]!;
  })]));
}

/** How many transient failures in a row ended the order's most recent runs. */
/** Does the launch template hand the engine the id the tool chooses (`{session_id}` in `session.new` or the args)? Codex and Claude without it pick their own. */
export function takesSessionId(launch: NonNullable<WorkersFile['workers'][number]['launch']>): boolean {
  return [...(launch.session?.new ?? []), ...launch.args].some(a => a.includes('{session_id}'));
}

/** The session a run's engine reported at its start (Codex `thread.started`, Claude `session_id`), else the one on record. */
export function engineSession(run: Run, probes?: Probes): string | undefined {
  if (run.events_file && probes) {
    const head = probes.head?.(run.events_file, 65536) ?? probes.readText?.(run.events_file)?.slice(0, 65536);
    const found = head ? parseStreamLog(head).sessionId : undefined;
    if (found) return found;
  }
  if (run.log && probes) { const found = textSessionId(probes.head?.(run.log, 4096) ?? probes.readText?.(run.log)?.slice(0, 4096) ?? ''); if (found) return found; }
  return run.session;
}

export function trailingTransientFailures(runs: readonly Run[], workerId?: string): number {
  let n = 0;
  for (const r of runs.filter(x => x.ended !== undefined).sort((a, b) => b.seq - a.seq)) {
    if (workerId !== undefined && r.worker !== workerId) break;
    if (r.outcome !== 'capacity') break;
    n++;
  }
  return n;
}

/**
 * The files alba and the worker write next to the order files, `<TAG>.last.txt` and `<TAG>.progress.json`, are kept out of git
 * (the repository's `info/exclude`, shared by its worktrees) when the work-order folder is inside the repository: a worker that
 * commits everything no longer puts them on its branch, and an untracked copy in the main checkout no longer stops `git merge`
 * (git replaces ignored files).
 */
export function excludeRunFiles(project: ProjectConfig, worktree: string): void {
  const rel = path.relative(project.root, project.work_orders).replace(/\\/g, '/');
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return;
  const dir = rel ? `/${rel}/` : '/';
  excludeLocally(worktree, [`${dir}*.last.txt`, `${dir}*.progress.json`]);
}

/** Prepare the immutable design inputs that every worker run receives. */
export function prepareRunWorktree(project: ProjectConfig, orders: Orders, tag: string, worktree: string): void {
  writeDesignSnapshot(project, worktree);
  try { excludeRunFiles(project, worktree); } catch { /* git status only shows them */ }
  if (orders.get(tag).order.kind === 'intake') writeIntakeBlocksSnapshot(project, orders, tag, worktree);
}

/** Where the worker works: its worktree only (a worker once worked and committed in the main checkout). */
export const worktreePrompt = (worktree: string, branch: string, root?: string): string => [
  '', '## Where you work', '',
  `Your working folder is ${slash(worktree)} (branch ${branch}). Run every command, build and commit there and only there.${root && path.resolve(root) !== path.resolve(worktree) ? ` Never change, build in or commit to ${slash(root)} or another worktree: that checkout belongs to the lead, and a run that changes it is stopped at review.` : ''} Read files elsewhere when the order names them, but write only inside your folder.`, '',
].join('\n');

/** A remote run on Windows has no desktop: how the worker starts a program that needs a window (src/workers/adapters/desktop-run.ps1). */
export const remoteDesktopPrompt = (machine: string): string => [
  '', `## This run is on ${machine} over SSH`, '',
  'This session has no desktop. A program that opens a window or needs the GPU\'s swap chain (a game capture, the editor) fails here (DXGI_ERROR_NOT_CURRENTLY_AVAILABLE). Start such a program through the helper, which runs it in the desktop session of the user logged on to that machine, waits, prints its output and exits with its exit code:',
  '', '    powershell -NoProfile -ExecutionPolicy Bypass -File "$env:ALBA_DESKTOP_RUN" -TimeoutMinutes 30 -- <program> <arguments>', '',
  '(In cmd: `%ALBA_DESKTOP_RUN%`.) Pass a script file rather than a command line with nested quotes. If it says nobody is logged on, report that as a blocker.', '',
].join('\n');

/**
 * What the worker is told about the slots its run holds. A project's own rules often say "only build if you hold the slot";
 * without this the worker cannot know that it does.
 */
export function slotsPrompt(caps: readonly CapHold[], uses: readonly string[], overCap: boolean): string {
  if (!caps.length && !uses.length) return '';
  const lines = ['', '## Slots this run holds', ''];
  for (const c of caps) lines.push(`- This run holds a \`${c.key}\` slot (the project runs at most ${c.cap} \`${c.key}\` orders at once${c.others.length ? `; also running now: ${c.others.join(', ')}` : ''}). Work that the order or its skills allow only to whoever holds the \`${c.key}\` slot is yours to do in this run.${overCap && c.others.length >= c.cap ? ' A person started this run over the cap, so the machine is busier than usual.' : ''}`);
  for (const u of uses) lines.push(`- This run holds the resource \`${u}\`.`);
  return lines.join('\n') + '\n';
}

/**
 * Starts one order on one worker: worktree, prompt file, background process, run record.
 * Card-only workers are never started; the result says a person has to click a card.
 */
export function startRun(ctx: RunContext, tag: string, workerId: string | undefined, options: { dryRun?: boolean; /** A person explicitly supplied this worker, rather than accepting a routing decision. */ explicitWorker?: boolean; route?: RouteNote; /** The order is handed over from this worker, which ran out of quota or capacity: the new worker gets a continuation file. */ rotate?: { from: string; reason: string }; /** The tick or the producer's dispatch planned this start against the kind caps; checked again with `capReserve`, the rework reserve it allowed. */ capsChecked?: boolean; capReserve?: number; /** A person starts it although a kind cap is full. */ overCap?: boolean } = {}): StartResult {
  const { project, orders, workers } = ctx;
  const doc = orders.get(tag);
  const stage = orders.stage(doc).stage;
  // A held order (stopped with "alba stop") starts again when a person names the worker; the release goes in with the run.
  const fromHeld = stage === 'held' && !!options.explicitWorker && !!workerId;
  if (fromHeld) { const plan = heldStartPlan(orders, doc); if (plan.problem) fail('{tag}: {problem}', { tag: doc.order.tag, problem: plan.problem }); }
  else if (stage === 'held') fail('{tag} is held; start it on a worker you name with "alba run {tag} --worker <id>", or release it with "alba orders act {tag} release".', { tag: doc.order.tag });
  else if (stage !== 'queued') fail('{tag} is {stage}; only a queued order can be started (use "alba orders act {tag} queue" first).', { tag: doc.order.tag, stage });
  workerId ??= doc.order.next_worker;
  const pinProblem = workerPinProblem(project, doc, workers);
  if (doc.order.next_worker && workerId !== doc.order.next_worker && !options.explicitWorker && !pinProblem) fail('Worker cannot start: {why}', { why: t('Order is pinned to worker {worker}.', { worker: doc.order.next_worker }) });
  const worker = workerId ? workers.workers.find(w => w.id === workerId) : undefined;
  if (workerId && !worker) fail('Unknown worker "{id}". Known: {known}.', { id: workerId, known: workers.workers.map(w => w.id).join(', ') });
  if (!worker) fail('Choose a worker with --worker <id>.');
  const role = roleForOrder(project, doc, workers);
  if (!role.id) fail('no role for this order; configure a matching or default role.');
  const tools = orderTools(project, doc, routingOf(project, doc).kind || doc.order.kind);
  if (tools.problems.length) fail('{tag} cannot start now: {problem}', { tag: doc.order.tag, problem: tools.problems.join('; ') });
  checkToolEnvironment(tools.tools, worker.engine);
  const explicitChoice = chooseWorker({ pinnedWorker: doc.order.next_worker === worker.id ? worker.id : undefined, kind: doc.order.kind, tags: [], role: rolePolicy(role), workerText: worker.id }, [{ config: worker, available: worker.enabled, reasons: [], running: 0, runsToday: 0 }]);
  if (doc.order.next_worker === worker.id && explicitChoice.outcome !== 'chosen') fail('Worker cannot start: {why}', { why: explicitChoice.why });
  const capabilityWarnings = explicitChoice.candidates[0]?.warnings ?? [];
  if (worker.card_only) {
    return { mode: 'card', tag: doc.order.tag, worker: worker.id, text: t('Ask a person to start {tag} from a card in a {worker} session; the tool does not start it.', { tag: doc.order.tag, worker: worker.id }) };
  }
  if (!worker.launch) fail('Worker "{id}" has no launch template in the workers file.', { id: worker.id });
  // Claude supplies its session id in stream-json; resume works without a custom session template.
  // The order's model replaces the worker's on the worker the order names (or the one a person starts it on); a reroute elsewhere uses that worker's own.
  const orderModel = doc.order.model && (doc.order.worker === worker.id || options.explicitWorker) ? doc.order.model : undefined;
  const runWorker = orderModel ? { ...worker, model: orderModel } : worker;
  const adapter = workerAdapter(worker.engine);
  const canResume = adapter.nativeResume || !!worker.launch.session;
  const plan = planWorktree(project, doc.order);
  const remote = worker.host ? remoteTarget(project, worker, plan.path, workers.file) : undefined;
  const resumeFailures = trailingTransientFailures(doc.runs, worker.id);
  const base = { mode: 'start' as const, tag: doc.order.tag, worker: worker.id, cwd: plan.path, branch: plan.branch };
  // Foundations in block mode: no start of a matching order (tick, producer, a person's `alba run`) until its documents are approved.
  const foundationWhy = foundationBlock(project, doc);
  if (foundationWhy) fail('{tag} cannot start now: {why}.', { tag: doc.order.tag, why: foundationWhy });
  // Resources the order uses: a free slot, and the exclusive ones, are checked here too (a person's `alba run` and the web's run go through this).
  if (project.resources) {
    const why = startBlocked(project.resources, activeLeases(project, orders), occupants(project, orders), { tag: doc.order.tag, kind: kindOfOrder(project, doc), uses: usesOf(project, doc) });
    if (why) fail('{tag} cannot start now: {why}.', { tag: doc.order.tag, why });
  }
  // Kind caps: the tick and the producer's dispatch plan with them (a rework may use the reserve they leave); a person's start is
  // checked here. Both are checked again under the state lock when the run is recorded (`admit` below).
  const caps = capHolds(project, orders, doc);
  const capReserve = options.capsChecked ? options.capReserve ?? 0 : 0;
  const capRefusal = (why: string) => options.capsChecked ? fail('{tag} cannot start now: {why}.', { tag: doc.order.tag, why }) : fail('{tag} cannot start now: {why}. Wait for one of them to end, or start it anyway with --over-cap.', { tag: doc.order.tag, why });
  const overCap = options.capsChecked ? undefined : capFull(caps);
  if (!options.overCap) { const full = capFull(caps, capReserve); if (full) capRefusal(full); }
  // An editor of its own (editors: in alba.yaml): one pool, with a free port on the run's machine (the pool's resource counts the
  // ports of all its machines).
  const pools = editorPoolsOf(project, doc);
  if (pools.length > 1) fail('{tag} uses more than one editor pool ({list}); an order has one editor.', { tag: doc.order.tag, list: pools.map(p => p.name).join(', ') });
  const editorPool = pools[0];
  const editorMachine = editorPool ? runMachine(project, worker.host, workers.file) : undefined;
  if (editorPool && !editorPool.machines[editorMachine!]) fail('{tag} cannot start now: it uses {pool}, which has no editor on {machine} (machines with one: {list}).', { tag: doc.order.tag, pool: editorPool.name, machine: editorMachine!, list: Object.keys(editorPool.machines).join(', ') });
  const portProblem = editorPool ? editorPortProblem(editorSlots(project), doc.order.tag, editorPool, editorMachine!) : undefined;
  if (portProblem) fail('{tag} cannot start now: {why}.', { tag: doc.order.tag, why: portProblem });
  // What would stop the start later, checked before anything is made (and in a dry run, so "would start" holds): the order's
  // file for a first run (or a remote one, which copies it; an answer or resume continues without it), and the base branch a
  // new worktree starts from.
  if (!doc.runs.length || remote) findOrderFile(project.work_orders, doc.order.tag);
  if (!existsSync(plan.path)) checkBaseRef(project, plan.baseRef);
  if (options.dryRun) return { ...base, created: false, dryRun: true };

  const { created } = ensureWorktree(project, plan);
  // A local run in its own worktree: what the main checkout looks like now, to tell afterwards whether the worker worked there.
  const main = !remote && path.resolve(plan.path) !== path.resolve(project.root) ? mainCheckoutState(project) : undefined;
  // And git refuses to move the base branch from this run (a worker merged its branch into main in the main checkout).
  let guard: { installed: boolean; warning?: string } | undefined;
  if (main) { try { guard = installBaseGuard(project.root, baseRefOf(project)); } catch (e) { guard = { installed: false, warning: `the base-branch guard hook was not installed: ${(e as Error).message.split('\n')[0]}` }; } }
  if (created && project.dispatch.provision) {
    const [program, ...args] = project.dispatch.provision;
    try { execFileSync(program, args, { cwd: plan.path, stdio: 'ignore', timeout: 600000, windowsHide: true }); }
    catch (e) { fail('The provision command failed in {cwd}: {why}', { cwd: plan.path, why: (e as Error).message.split('\n')[0] }); }
  }
  const runId = `r${doc.runs.length + 1}`;
  prepareRunWorktree(project, orders, doc.order.tag, plan.path);
  const editor = editorPool ? takeEditor(project, orders, doc, editorPool, editorMachine!, { localWorktree: plan.path, worktree: remote ? remote.worktree : plan.path, ...(remote ? { ssh: remote.ssh } : {}) }, ctx.probes.now()) : undefined;
  const runsDir = path.join(project.state_dir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const promptFile = slash(path.join(runsDir, `${doc.order.tag}-${runId}.prompt.md`));
  const log = slash(path.join(runsDir, `${doc.order.tag}-${runId}.log`));
  const lastFile = slash(path.join(project.work_orders, `${doc.order.tag}.last.txt`));

  // An engine that can continue a conversation is resumed after a transient failure, and when a person answered its question
  // (the answer is all it is told then); every other start is a new session.
  const previous = [...doc.runs].filter(r => r.ended !== undefined).sort((a, b) => b.seq - a.seq)[0];
  const notes = pendingNotes(doc);
  const pending = notes[notes.length - 1];
  const reroute = doc.order.next_worker === worker.id ? doc.reroutes?.findLast(r => r.to === worker.id && !doc.runs.some(run => run.reroute === r.id)) : undefined;
  const attemptsBrief = reroute ? previousAttempts(doc, reroute.loops, plan.path) : undefined;
  const rotating = options.rotate;
  // An answer, a monitor result or a message continues the same conversation when the engine can. Several notes still all go in the prompt.
  // The session to continue is the one the engine reported in the previous run's events (a run stopped by a person is closed
  // before its end is read, so its record may not have it).
  const previousSession = previous ? engineSession(previous, ctx.probes) : undefined;
  // A person who queues the order again after the note (or names another worker) asks for a fresh start, not the same conversation.
  const requeued = !!pending && doc.actions.some(a => a.kind === 'queue' && !a.note && a.seq > pending.seq);
  const resumeForNote = !reroute && !rotating && !previous?.lost_session && pending && !requeued && canResume && previousSession && previous.worker === worker.id && (pending.kind === 'answer' || pending.kind === 'monitor' || pending.kind === 'message') ? previousSession : undefined;
  // An endpoint that accepted no connection is continued at once (the conversation is still there); other capacity
  // ends after the first one in a row.
  const continueCapacity = canResume && previous?.outcome === 'capacity' && previous.worker === worker.id && (resumeFailures > 0 || previous.limit === 'unreachable');
  const resumeSession = reroute || rotating || previous?.lost_session ? undefined : resumeForNote ?? (continueCapacity ? previousSession : undefined);
  // The skills of this order go into the worktree (copied, never linked) before the process starts; a problem there never stops the run.
  const skillPlan = planSkills(project, workers, doc, worker);
  const rules = roleRules(role);
  const roleMount = mountRole(plan.path, worker.engine, withEditor(withToolServers(role, tools.tools), editorPool?.mcp_name, editor?.slot.url));
  roleMount.warnings.push(...capabilityWarnings);
  let mountedSkills: string[] | undefined;
  try { mountedSkills = mountSkills(plan.path, skillPlan.mounts, skillPlan.selection.selected).mounted; } catch { /* the prompt still lists the skills with their source files below */ }
  try { ensureInbox(plan.path); } catch { /* a missing inbox only means the worker finds no messages */ }
  try { installLockHelper(plan.path); } catch { /* the rules say what to do without it */ }
  const fullPrompt = () => promptFor(project.work_orders, doc, lessonsForOrder(project, doc), skillPlan.listed, project.lessons?.max_rule_lines);
  const promptText = previous?.missing_report || notes.some(n => n.bounce) ? fullPrompt()
    : resumeForNote && pending?.kind === 'answer' && notes.length === 1 ? answerPrompt(pending)
    : resumeForNote && pending?.kind === 'monitor' && notes.length === 1 ? monitorPrompt(pending.text)
      : resumeForNote && pending?.kind === 'message' ? messagePrompt(notes)
        : fullPrompt();
  // A handed-over order: the prompt is only the path of the continuation file (what the branch holds, the last report, the questions, the end of the log, the usual instructions).
  const handoff = rotating ? writeHandoff({ project, doc, from: { worker: rotating.from, run: previous }, to: worker.id, why: rotating.reason, worktree: plan.path, runId, probes: ctx.probes, lessons: lessonsForOrder(project, doc), skills: skillPlan.listed }) : undefined;
  writeFileSync(promptFile, withRoleRules((handoff ? handoffPrompt(handoff) : promptText) + (adapter.finalMessagePrompt?.(worker, remote?.values.last_file ?? lastFile) ?? '') + (attemptsBrief ? `\n${attemptsBrief}\n` : '') + worktreePrompt(plan.path, plan.branch, remote ? undefined : project.root) + slotsPrompt(caps, project.resources ? usesOf(project, doc) : [], !!overCap) + toolsPrompt(tools.tools, worker.engine, roleMount.servers) + (editor ? editorPrompt(editor.slot, editorPool!) : '') + (remote?.machine.os === 'windows' ? remoteDesktopPrompt(remote.machine.id) : '') + (project.design?.enabled ? '\nRead .alba/design/README.md and snapshot.json for the design library. Propose change sets in .alba/design/changes/*.json and list them in the report field design_changes.\n' : ''), rules), 'utf8');
  const sessionId = resumeSession ?? randomUUID();
  const values = { cwd: plan.path, prompt_file: promptFile, last_file: lastFile, model: runWorker.model ?? worker.launch.model ?? '', log, git_dir: commonGitDir(plan.path), worktree_git_dir: worktreeGitDir(plan.path), session_id: sessionId, tunnel_port: '', ...remote?.values };
  const args = launchArgs(worker.launch, values, resumeSession !== undefined);
  const launchEnv = expandEnv(worker.launch.env, { ...skillEnvValues(skillPlan.selection), tunnel_port: values.tunnel_port });
  const environment = adapter.prepare(args, { remote: !!remote, worker: runWorker, stateDir: project.state_dir, skills: skillPlan.selection.selected, resume: resumeSession, env: launchEnv, envUnset: worker.launch.env_unset, promptFile: values.prompt_file, lastFile: values.last_file });
  args.unshift(...roleMount.args);
  Object.assign(environment.env, roleMount.env);
  environment.env[RUN_ENV] = `${doc.order.tag}/${runId}`;
  if (editor) { environment.env.NO_PROXY = withLoopback(environment.env.NO_PROXY ?? process.env.NO_PROXY); environment.env.no_proxy = withLoopback(environment.env.no_proxy ?? process.env.no_proxy); }
  // With an editor the worker is started by the editor helper, which starts the editor first and stops it when the worker ends.
  const command = editor ? { program: remote ? 'node' : process.execPath, args: [slash(path.join(plan.path, '.alba', 'bin', 'editor.mjs')), 'run', '--', worker.launch.program, ...args] } : { program: worker.launch.program, args };
  if (guard?.warning) roleMount.warnings.push(guard.warning);
  environment.envUnset = environment.envUnset.filter(n => !Object.hasOwn(roleMount.env, n));
  const eventsFile = adapter.structured ? slash(path.join(runsDir, `${doc.order.tag}-${runId}.events.jsonl`)) : undefined;
  // A resume counts as the next attempt; anything else starts over at 1.
  const maxResumes = worker.max_resumes ?? MAX_RESUMES;
  const attempt = rotating && previous?.attempt ? Math.min(previous.attempt + 1, maxResumes + 1) : doc.runs.length && resumeFailures ? Math.min(resumeFailures + 1, maxResumes + 1) : 1;
  const targetPaid = worker.cost === 'paid';
  const rotated = rotating && handoff ? { from: rotating.from, reason: rotating.reason, paid: targetPaid, text: handoffLine(rotating.from, worker.id, rotating.reason, targetPaid) } : undefined;
  const resumeReason = !rotating && resumeFailures && !resumeSession ? previous?.lost_session ? t('resumed as a new session: the service lost the conversation') : t('resumed as a new session: the engine cannot continue the old session') : undefined;
  // One step under the state lock: the cap and resource checks again (another start, the tick's or a person's, may have taken
  // the last slot since the checks above), the run record and the leases, before anything is spawned. Nothing is written when a
  // check fails.
  const launch = worker.launch;
  let run: Run;
  try {
    run = withFleetLock(() => stateTransaction(project, () => {
      const fresh = orders.get(doc.order.tag);
      // The worker's concurrency over every project that shares it: another project's thread may have started a run on it since
      // this tick counted. A start a person asked for on a named worker is theirs to make.
      if (ctx.peers && !options.explicitWorker) {
        const own = orders.all().reduce((n, d) => n + d.runs.filter(r => r.ended === undefined && ownerOf(workers.workers, r.worker)?.id === worker.id).length, 0);
        const elsewhere = ctx.peers().get(worker.id) ?? 0;
        if (own + elsewhere >= worker.concurrency) fail('{tag} cannot start now: {worker} already has {n} run(s) open ({m} in other projects), its concurrency is {cap}.', { tag: fresh.order.tag, worker: worker.id, n: own + elsewhere, m: elsewhere, cap: worker.concurrency });
      }
      if (project.resources) {
        const why = startBlocked(project.resources, activeLeases(project, orders), occupants(project, orders), { tag: fresh.order.tag, kind: kindOfOrder(project, fresh), uses: usesOf(project, fresh) });
        if (why) fail('{tag} cannot start now: {why}.', { tag: fresh.order.tag, why });
      }
      if (!options.overCap) { const full = capFull(capHolds(project, orders, fresh), capReserve); if (full) capRefusal(full); }
      if (doc.order.next_worker && doc.order.next_worker !== worker.id) {
        if (options.explicitWorker) orders.clearWorkerPin(doc.order.tag, t('Person started a run on a different worker.'), worker.id);
        else if (pinProblem) orders.clearWorkerPin(doc.order.tag, pinProblem);
      }
      // A person's choice of worker sticks: the order's worker becomes it, so a rework or answer the tick starts later goes to the
      // same worker (it went back to the order's old worker, past a rule such as "presentation only on Claude").
      if (options.explicitWorker && orders.get(doc.order.tag).order.worker !== worker.id) {
        const from = orders.get(doc.order.tag).order.worker;
        orders.update(doc.order.tag, { worker: worker.id });
        orders.record(doc.order.tag, 'worker-set', { from: from ?? null, to: worker.id, why: 'a person started a run on it' });
      }
      orders.update(doc.order.tag, { branch: plan.branch, worktree: plan.path });
      const opened = orders.runStart(doc.order.tag, { worker: worker.id, extra: { ...(remote ? { host: remote.machine.id, remote_worktree: remote.worktree } : {}), ...(role.id ? { role: role.id, role_source: role.source, role_effort: role.definition?.effort, role_reasoning: role.definition?.reasoning, mcp_servers: roleMount.servers, role_warnings: roleMount.warnings } : {}), ...(tools.tools.length ? { tools: tools.tools.map(x => `${x.manifest.id}@${x.manifest.version}`) } : {}), continuation: resumeSession !== undefined || !!resumeFailures || pending?.kind === 'answer' || pending?.kind === 'monitor', engine: worker.engine, model: runWorker.model ?? launch.model, template: launch.id, ...(launch.session && (resumeSession !== undefined || takesSessionId(launch)) ? { session: sessionId } : {}), log, last_file: lastFile, prompt_file: promptFile, cwd: plan.path, attempt, ...(resumeReason ? { resume_reason: resumeReason } : {}), ...(notes.some(n => n.kind === 'monitor') ? { monitor: true } : {}), ...(rotated ? { rotated, handoff_file: handoff } : {}), routing: { kind: routingOf(project, doc).kind || doc.order.kind, why: options.route?.why ?? `role ${role.id} (${role.source}); ${explicitChoice.why}`, rejected: options.route?.rejected ?? [] }, ...(mountedSkills ? { skills: mountedSkills } : {}), ...(editor ? { editor: { pool: editor.slot.pool, machine: editor.slot.machine, port: editor.slot.port, url: editor.slot.url, log: editor.slot.log } } : {}), ...(main?.head ? { main_head: main.head, root_dirty: main.dirty } : {}) } }, false, fromHeld ? { fromHeld: { note: t('started on {worker} by a person', { worker: worker.id }) } } : {}).run;
      if (project.resources) acquireLeases(project, orders, orders.get(doc.order.tag), opened.id, ctx.probes.now());
      return opened;
    }));
  } catch (e) {
    if (editor) dropEditor(project, doc.order.tag, editor.slot.pool);
    throw e;
  }
  let pid: number | undefined;
  let processStartedAt: string | undefined;
  try {
    if (editor) bindEditor(project, doc.order.tag, editor.slot.pool, run.id);
    if (attemptsBrief && reroute) orders.patchRun(doc.order.tag, run.id, { previous_attempts: attemptsBrief, reroute: reroute.id });
    if (role.id) orders.record(doc.order.tag, 'run-role', { run: run.id, role: role.id, source: role.source, effort: role.definition?.effort, reasoning: role.definition?.reasoning, servers: roleMount.servers, warnings: roleMount.warnings });
    if (eventsFile) orders.patchRun(doc.order.tag, run.id, { events_file: eventsFile });
    const started = remote ? writeRemoteSpec({ target: remote, worker, id: `${doc.order.tag}-${run.id}`.toLowerCase(), branch: plan.branch, localWorktree: plan.path, promptFile, lastFile,
      orderFiles: [findOrderFile(project.work_orders, doc.order.tag), ...(handoff ? [handoff] : [])], overlayRoots: ['.alba', ...skillPlan.mounts, '.opencode/opencode.json'],
      program: command.program, args: command.args, env: environment.env, envUnset: environment.envUnset, specFile: path.join(runsDir, `${doc.order.tag}-${run.id}.remote.json`) }) : command;
    pid = ctx.probes.spawnDetached(started.program, started.args, { cwd: plan.path, ...(remote ? { env: {}, envUnset: [] } : environment), logFile: log, ...(eventsFile ? { eventsFile } : {}) });
    processStartedAt = ctx.probes.processStartedAt?.(pid);
    orders.patchRun(doc.order.tag, run.id, { pid, ...(processStartedAt ? { process_started_at: processStartedAt } : {}) });
    if (rotating && rotated) orders.record(doc.order.tag, 'run-rotated', { run: run.id, from: rotating.from, to: worker.id, reason: rotating.reason, paid: rotated.paid, text: rotated.text, ...(handoff ? { handoff } : {}) });
    return { ...base, created, run: run.id, pid, log, resumed: resumeSession !== undefined, dryRun: false };
  } catch (e) {
    // A step after the run was recorded failed: what was started is stopped (its whole tree, identified by its creation time or
    // the run's launch window), the run ends as failed and its leases go back. Each part is tried on its own: a run this could
    // not end is ended by the tick once it has had no process for `LAUNCH_GRACE_MINUTES`.
    if (pid !== undefined) { try { ctx.probes.kill?.(pid, processStartedAt, run.started); } catch { /* the tick sees the process */ } }
    try { orders.runEnd(doc.order.tag, 'failed'); } catch { /* ended later by the tick */ }
    if (project.resources) { try { for (const name of usesOf(project, doc)) releaseLease(project, orders, name, doc.order.tag, t('the run did not start'), ctx.probes.now()); } catch { /* reconciled by the tick */ } }
    // A worker that was spawned may have started the editor: its slot stays bound to the ended run, so the tick stops that editor.
    if (editor && pid === undefined) { try { dropEditor(project, doc.order.tag, editor.slot.pool); } catch { /* reconciled by the tick */ } }
    throw e;
  }
}
