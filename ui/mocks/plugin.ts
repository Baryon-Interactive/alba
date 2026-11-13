// A Vite dev-server plugin that answers /api itself from made-up data (pnpm dev:mock). It speaks the same interface as `alba serve`
// (docs/console/010-api.md): the pages run the same fetch and EventSource code against it, so the screens can be built and checked without a server.
import type { Plugin } from 'vite';
import { parse as parseYaml } from 'yaml';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ActionRequest, CheckResult, NewOrderRequest, OrderDetail, OrderDiff, OrderEvent, OrderSummary, RunLog, Session, Stage, TickView, Worker,
} from '../../src/api/types.ts';
import { handleExtras } from './extras.ts';
import { handleLibrary } from './library.ts';
import { handleDesign } from './design.ts';
import { handleMachines } from './machines.ts';
import { mockNightlyGates } from '../src/mocks/nightly-data.ts';
import { actionsFor, createWorld, editsOf, iso, makeHistory, makeOverview, makeResources, makeWorkers, seedLog, summarize, whyFor, type MockOrder, type MockProject } from '../src/mocks/data.ts';


export function mockApi(): Plugin {
  const projects = createWorld();
  const byId = new Map(projects.map(p => [p.info.id, p]));
  const logs = new Map<string, string[]>();
  const boot = Date.now().toString(36);
  let seq = 0;
  const clients = new Set<{ res: ServerResponse; project: string; logs: Set<string> }>();
  let lastTick: { at: string; text: string } | undefined;
  const released = new Set<string>();      // leases a person took back in this session

  const logOf = (key: string) => {
    let l = logs.get(key);
    if (!l) { l = seedLog(key.split(':')[0]!); logs.set(key, l); }
    return l;
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });
  const emit = (project: string, name: string, data: unknown) => {
    const id = `${boot}.${++seq}`;
    for (const c of clients) if (c.project === project) c.res.write(`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const record = (p: MockProject, tag: string, type: string, by = 'web', data?: Record<string, unknown>) => {
    const e: OrderEvent = { id: p.events.length + 1, at: new Date().toISOString(), tag, type, by, data };
    p.events.push(e);
    const name = type.startsWith('action-') ? 'order.action' : type === 'order-added' ? 'order.added' : type === 'run-start' ? 'run.start' : type === 'run-end' ? 'run.end' : type === 'report' ? 'order.report' : type === 'check' ? 'check.done' : 'log.other';
    emit(p.info.id, name, { ...e, project: p.info.id });
  };

  // ---- editing the workers (the real server writes the workers file; here the edits are kept in memory)
  const refused = (res: ServerResponse, details: { field?: string; message: string }[]) => send(res, 400, { error: { code: 'bad_request', message: details[0]!.message, details } });
  const toYaml = (w: Worker): string => {
    const lines = [`id: ${w.id}`, `engine: ${w.engine}`];
    if (w.notes) lines.push(`notes: ${JSON.stringify(w.notes)}`);
    lines.push(`capabilities: ${JSON.stringify(w.capabilities)}`);
    if (w.model) lines.push(`model: ${JSON.stringify(w.model)}`);
    if (w.route) lines.push(`route: ${JSON.stringify(w.route)}`);
    if (w.maxTokensPerRun !== undefined) lines.push(`max_tokens_per_run: ${w.maxTokensPerRun}`);
    lines.push(`cost: ${w.cost}`, `concurrency: ${w.concurrency}`);
    if (w.dailyRuns !== undefined) lines.push(`daily_runs: ${w.dailyRuns}`);
    if (w.aliases.length) lines.push(`aliases: [${w.aliases.join(', ')}]`);
    if (w.quotaSource) lines.push(`quota: ${w.quotaSource}`);
    if (w.modelFamily) lines.push(`model_family: ${w.modelFamily}`);
    if (!w.enabled) lines.push('enabled: false');
    if (w.hasLaunch) lines.push('launch:', `  program: ${w.engine}`, '  args: ["exec", "{prompt_file}"]');
    return lines.join('\n') + '\n';
  };
  /** The changes of `set` (the names the workers file uses) as changes of the worker the console shows; or what is wrong. */
  const fromSet = (set: Record<string, unknown>): { patch: Partial<Worker>; problems: { field?: string; message: string }[] } => {
    const patch: Partial<Worker> = {};
    const problems: { field?: string; message: string }[] = [];
    const whole = (v: unknown, min: number) => typeof v === 'number' && Number.isInteger(v) && v >= min;
    for (const [key, v] of Object.entries(set)) {
      switch (key) {
        case 'notes': patch.notes = v === null ? undefined : String(v); break;
        case 'model': patch.model = v === null ? undefined : String(v); break;
        case 'route': patch.route = v === null ? undefined : String(v); break;
        case 'capabilities':
          if (v === null || (Array.isArray(v) && v.every(c => typeof c === 'string' && c.trim()))) patch.capabilities = (v ?? []) as string[];
          else problems.push({ field: key, message: '"capabilities" must be a list of non-empty strings.' });
          break;
        case 'max_tokens_per_run':
          if (v === null) patch.maxTokensPerRun = undefined;
          else if (whole(v, 1)) patch.maxTokensPerRun = v as number;
          else problems.push({ field: key, message: '"max_tokens_per_run" must be a whole number >= 1.' });
          break;
        case 'cost': if (v === 'included' || v === 'paid') patch.cost = v; else problems.push({ field: 'cost', message: '"cost" must be "included" or "paid".' }); break;
        case 'concurrency': if (whole(v, 1)) patch.concurrency = v as number; else problems.push({ field: 'concurrency', message: '"concurrency" must be a whole number >= 1.' }); break;
        case 'daily_runs': if (v === null) patch.dailyRuns = undefined; else if (whole(v, 1)) patch.dailyRuns = v as number; else problems.push({ field: 'daily_runs', message: '"daily_runs" must be a whole number >= 1.' }); break;
        case 'enabled': patch.enabled = v === true; break;
        case 'aliases': patch.aliases = Array.isArray(v) ? v.map(String) : []; break;
        case 'daily_cap_usd': patch.dailyCapUsd = v === null ? undefined : Number(v); break;
        case 'model_family': patch.modelFamily = v === null ? undefined : String(v); break;
        case 'disabled_when': patch.disabledWhen = ((v ?? []) as Record<string, number | string>[]).map(r => ('balance_drop' in r ? { balanceDrop: Number(r.balance_drop) } : { window: String(r.window_full), at: Number(r.at) })); break;
        default: problems.push({ field: key, message: `Not editable one by one: ${key} (use the YAML of the worker for those).` });
      }
    }
    return { patch, problems };
  };
  const secretIn = (yaml: string) => /^\s+([A-Z][A-Z0-9_]*):\s*["']?(sk-[A-Za-z0-9_-]{10,})/m.exec(yaml);
  const workerCall = (p: MockProject, method: string, path: string, body: any, res: ServerResponse): boolean => {
    const list = makeWorkers(p);
    const edits = editsOf(p);
    const yamlMatch = /^workers\/([^/]+)\/yaml$/.exec(path);
    if (yamlMatch && method === 'GET') {
      const w = list.find(x => x.id === decodeURIComponent(yamlMatch[1]!));
      if (!w) { fail(res, 404, 'not_found', 'No worker "' + yamlMatch[1] + '" in workers.yaml.'); return true; }
      send(res, 200, { id: w.id, file: '/studio/workers.yaml', yaml: toYaml(w) });
      return true;
    }
    const one = /^workers\/([^/]+)$/.exec(path);
    if (one && method === 'PUT') {
      const id = decodeURIComponent(one[1]!);
      const w = list.find(x => x.id === id);
      if (!w) { fail(res, 404, 'not_found', 'No worker "' + id + '" in workers.yaml.'); return true; }
      if ((body.set === undefined) === (body.yaml === undefined)) { fail(res, 400, 'bad_request', 'Give either "set" or "yaml".'); return true; }
      let patch: Partial<Worker>;
      if (body.yaml !== undefined) {
        const key = secretIn(String(body.yaml));
        if (key) { refused(res, [{ field: 'launch.env.' + key[1], message: 'launch.env.' + key[1] + ' looks like a key. Keys are not written in the workers file: use a command that reads the key from a file (for example the provider\'s auth.command).' }]); return true; }
        let doc: Record<string, unknown>;
        try { doc = (parseYaml(String(body.yaml)) ?? {}) as Record<string, unknown>; } catch (e) { refused(res, [{ message: 'The YAML is not valid: ' + (e as Error).message.split('\n')[0] }]); return true; }
        const { id: _id, engine: _engine, launch: _launch, ...rest } = doc;
        const r = fromSet({ notes: rest.notes ?? null, capabilities: rest.capabilities ?? [], model: rest.model ?? null, route: rest.route ?? null, max_tokens_per_run: rest.max_tokens_per_run ?? null, cost: rest.cost ?? 'included', concurrency: rest.concurrency ?? 1, daily_runs: rest.daily_runs ?? null, enabled: rest.enabled ?? true, aliases: rest.aliases ?? [], model_family: rest.model_family ?? null });
        if (r.problems.length) { refused(res, r.problems); return true; }
        patch = r.patch;
      } else {
        const r = fromSet(body.set as Record<string, unknown>);
        if (r.problems.length) { refused(res, r.problems); return true; }
        patch = r.patch;
      }
      const changed = Object.keys(patch).filter(k => JSON.stringify((patch as Record<string, unknown>)[k]) !== JSON.stringify((w as unknown as Record<string, unknown>)[k]));
      if (body.dryRun !== true && changed.length) {
        edits.patch.set(id, { ...edits.patch.get(id), ...patch });
        record(p, '*', 'workers.edited', 'web', { worker: id, fields: changed });
      }
      const now = makeWorkers(p).find(x => x.id === id);
      send(res, 200, { ok: true, id, changed, file: '/studio/workers.yaml', ...(body.dryRun !== true && changed.length ? { backup: '/studio/workers.yaml.bak-20260101-100000' } : {}), dryRun: body.dryRun === true, ...(body.dryRun !== true && now ? { worker: now } : {}) });
      return true;
    }
    if (path === 'workers' && method === 'POST') {
      const id = String(body.id ?? '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) { refused(res, [{ field: 'id', message: 'A worker id is letters, digits, "." "_" "-".' }]); return true; }
      if (list.some(x => x.id === id)) { send(res, 409, { error: { code: 'conflict', message: 'There is a worker "' + id + '" already.', details: [{ field: 'id', message: 'There is a worker "' + id + '" already.' }] } }); return true; }
      let base: Worker | undefined;
      if (body.copyFrom) {
        base = list.find(x => x.id === body.copyFrom);
        if (!base) { fail(res, 404, 'not_found', 'No worker "' + body.copyFrom + '" in workers.yaml.'); return true; }
      }
      const doc = (body.yaml ? parseYaml(String(body.yaml)) : {}) as Record<string, unknown>;
      const r = fromSet(body.copyFrom ? body.set ?? {} : { notes: doc.notes ?? null, capabilities: doc.capabilities ?? [], model: doc.model ?? null, route: doc.route ?? null, max_tokens_per_run: doc.max_tokens_per_run ?? null, cost: doc.cost ?? 'included', concurrency: doc.concurrency ?? 1 });
      if (r.problems.length) { refused(res, r.problems); return true; }
      const w: Worker = { ...(base ?? { ...list[0]!, engine: String(doc.engine ?? 'codex-cli'), quota: undefined, quotaSource: undefined, modelFamily: undefined, aliases: [] }), ...r.patch, id, running: 0, runsToday: 0, spendTodayUsd: 0 };
      if (body.dryRun !== true) {
        edits.added.push(w);
        record(p, '*', 'workers.edited', 'web', { worker: id, fields: ['*'] });
      }
      send(res, body.dryRun === true ? 200 : 201, { ok: true, id, changed: ['*'], file: '/studio/workers.yaml', ...(body.dryRun !== true ? { backup: '/studio/workers.yaml.bak-20260101-100000' } : {}), dryRun: body.dryRun === true, ...(body.dryRun !== true ? { worker: makeWorkers(p).find(x => x.id === id) } : {}) });
      return true;
    }
    return false;
  };
  const project = (url: URL) => {
    const id = url.searchParams.get('project');
    if (!id) return projects.length === 1 ? projects[0]! : undefined;
    return byId.get(id);
  };
  const detail = (p: MockProject, o: MockOrder): OrderDetail => {
    const unavailable: OrderDetail['unavailable'] = {};
    const allowedNow = actionsFor(o.stage, o.waitingFor ?? 'answer');
    for (const a of ['queue', 'hold', 'release', 'cancel', 'approve', 'rework', 'answer', 'run'] as const)
      if (!allowedNow.includes(a)) unavailable[a] = a === 'answer' && o.stage === 'awaiting-user' ? 'the order waits for a click on a card, not for an answer' : `not allowed while the order is ${o.stage}`;
    const events = p.events.filter(e => e.tag === o.def.tag);
    const cited = `${o.def.title} ${o.def.condition ?? ''} ${o.def.mandate?.decisions ?? ''} ${o.file ?? ''}`;
    const tags = o.def.tags ?? [];
    return {
      project: p.info.id, order: o.def, stage: o.stage, why: o.why,
      needsStatus: o.def.needs.map(tag => ({ tag, stage: p.orders.get(tag)?.stage })),
      waitingFor: o.stage === 'awaiting-user' ? o.waitingFor ?? 'answer' : undefined,
      referencedDecisions: p.decisions.filter(d => cited.includes(d.id)), questions: o.questions ?? [], quotes: o.quotes ?? [], lessons: p.lessons.filter(l => l.tags.some(x => tags.includes(x))),
      actions: allowedNow, unavailable, runs: o.runs, reports: o.reports, decisions: o.decisions, lastCheck: o.lastCheck, spend: o.spend, monitor: o.monitor, progress: o.progress,
      pendingNotes: [], messages: [],
      events: events.slice(-200), eventsTotal: events.length,
      file: o.file ? { path: `work-orders/${o.def.tag}-${o.def.title.toLowerCase().replace(/\W+/g, '-')}.md`, markdown: o.file, truncated: false } : undefined,
      worktree: o.def.worktree ?? (o.def.branch ? `../worktrees/${o.def.tag.toLowerCase()}` : undefined),
    };
  };
  const setStage = (o: MockOrder, stage: Stage) => { o.stage = stage; o.why = whyFor(stage); o.def.updated = new Date().toISOString(); o.quietMinutes = undefined; };

  function act(p: MockProject, o: MockOrder, body: ActionRequest) {
    const tag = o.def.tag;
    const allowed = actionsFor(o.stage, o.waitingFor ?? 'answer');
    if (!allowed.includes(body.action)) return { status: 409, message: `${body.action} is not allowed while the order is ${o.stage}` };
    if (body.action === 'rework' && !body.note?.trim()) return { status: 400, message: 'rework needs a note' };
    if (body.action === 'approve' && !o.def.branch && !body.branch?.trim()) return { status: 400, message: `${tag} has no branch recorded, so the merge cannot be checked. Name it: alba orders set ${tag} --branch <branch>, or approve with --branch.` };
    const options = [...o.reports].reverse().find(r => r.options)?.options;
    if (body.action === 'answer' && body.choice !== undefined && !options?.[body.choice - 1]) return { status: 400, message: `the waiting report has no option ${body.choice}` };
    if (body.action === 'answer' && body.choice === undefined && !body.text?.trim()) return { status: 400, message: 'answer needs text or a choice' };
    const at = new Date().toISOString();
    const seqNo = o.decisions.length + o.runs.length + o.reports.length + 1;
    let message: string | undefined;
    let runInfo: { id: string; key: string; worker: string; pid?: number; resumed: boolean } | undefined;
    const startRun = (note?: string, resumed = false) => {
      const n = o.runs.length + 1;
      const r = { id: `r${n}`, key: `${tag}:r${n}`, seq: seqNo, worker: o.def.worker ?? 'codex', started: at, imported: false, hasLog: true, pid: 40000 + n, alive: true, usage: { source: 'unknown' as const }, note };
      o.runs.push(r);
      logs.set(r.key, [`session id: mock-${tag}-${n}`, resumed ? `answer: ${note}` : `note: ${note ?? '(none)'}`]);
      setStage(o, 'running');
      runInfo = { id: r.id, key: r.key, worker: r.worker, pid: r.pid, resumed };
      record(p, tag, 'run-start', 'web', { run: r.id, worker: r.worker, resumed });
    };
    switch (body.action) {
      case 'queue': setStage(o, 'queued'); break;
      case 'hold': case 'stop': setStage(o, 'held'); break;
      case 'release': setStage(o, 'draft'); break;
      case 'cancel': setStage(o, 'cancelled'); break;
      case 'approve':
        if (body.branch?.trim() && o.def.branch !== body.branch.trim()) { record(p, tag, 'order-git-set', 'web', { fields: ['branch'], to: { branch: body.branch.trim() }, from: {} }); o.def.branch = body.branch.trim(); }
        setStage(o, 'merged'); message = 'The branch is merged; the accept command ran.'; break;
      case 'rework': o.decisions.push({ seq: seqNo, at, kind: 'rework', note: body.note }); setStage(o, 'queued'); break;
      case 'answer': {
        const picked = body.choice !== undefined ? options![body.choice - 1]!.label : undefined;
        o.decisions.push({ seq: seqNo, at, kind: 'answer', note: body.text, choice: body.choice });
        startRun(picked ? `option ${body.choice}: ${picked}${body.text ? ` (${body.text})` : ''}` : body.text, true);
        message = 'The original session was continued with your answer.';
        break;
      }
      case 'run': startRun(); break;
    }
    if (body.action !== 'answer' && body.action !== 'run') {
      const kind = body.action;
      if (kind !== 'rework') o.decisions.push({ seq: seqNo, at, kind: kind as 'queue', note: body.note });
      record(p, tag, `action-${kind}`, 'web', body.note ? { note: body.note } : undefined);
    }
    emit(p.info.id, 'order.updated', { id: p.events.length, at, tag, type: 'order-updated', by: 'web', project: p.info.id });
    return { status: 200, result: { ok: true as const, tag, stage: o.stage, why: o.why, message, run: runInfo } };
  }

  function tick(p: MockProject, real: boolean): TickView {
    const o = makeOverview(p);
    const moves = o.next.moves.map(m => ({ ...m, rework: false }));
    const done: string[] = [];
    if (real && moves[0]) {
      const ord = p.orders.get(moves[0].tag);
      if (ord && moves[0].mode === 'dispatch') { act(p, ord, { action: 'run' }); done.push(`started ${moves[0].tag} with ${moves[0].worker}`); }
    }
    const view: TickView = {
      project: p.info.id, at: new Date().toISOString(), real, exitCode: o.needsYou.count ? 1 : 0,
      needsUser: [{ stage: 'awaiting-review', tags: o.needsYou.items.filter(i => i.stage === 'awaiting-review').map(i => i.tag) }],
      problems: o.problems.items, moves, heldBack: o.next.heldBack, unavailable: [{ worker: 'grok', reasons: ['window "daily" at 96%'] }],
      waiting: [{ tag: 'LV4', text: 'LV4 waits for PH2, TR2' }], finishes: [], done,
      monitoring: [...p.orders.values()].filter(x => x.stage === 'monitoring' && x.monitor).map(x => ({ tag: x.def.tag, text: `${x.def.tag}: monitoring, ${x.monitor!.checks} checks, last ${x.monitor!.lastResult ?? 'waiting'}` })),
      text: `${real ? 'tick' : 'tick (dry run)'}\n${moves.map(m => `  ${m.mode} ${m.tag} with ${m.worker}`).join('\n') || '  nothing to start'}\n${o.next.heldBack.map(h => `  held back ${h.tag}: ${h.why}`).join('\n')}`,
    };
    if (real) { lastTick = { at: view.at, text: view.text }; emit(p.info.id, 'tick.done', { project: p.info.id, at: view.at, source: 'api', real, exitCode: view.exitCode, done, problems: view.problems.length }); }
    return view;
  }

  return {
    name: 'alba-mock-api',
    configureServer(server) {
      // Live run logs: the running orders print a line every 1.5 s to the connections that asked for them.
      const timer = setInterval(() => {
        for (const c of clients) {
          for (const key of c.logs) {
            const tag = key.split(':')[0]!;
            const o = projects.flatMap(p => [...p.orders.values()]).find(x => x.def.tag === tag);
            const run = o?.runs.find(r => r.key === key);
            if (!run || run.ended) continue;
            const l = logOf(key);
            const line = `${new Date().toISOString().slice(11, 19)} \u001b[32mexec\u001b[0m pnpm test --filter player (${l.length})`;
            l.push(line);
            c.res.write(`event: run.log\ndata: ${JSON.stringify({ project: c.project, key, lines: [line], offset: l.join('\n').length })}\n\n`);
          }
        }
      }, 1500);
      server.httpServer?.on('close', () => clearInterval(timer));

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();
        const path = url.pathname.slice(5);
        try {
          let body: any = {};
          if (req.method === 'POST' || req.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const ch of req) chunks.push(ch as Buffer);
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return fail(res, 400, 'bad_request', 'body is not JSON'); }
          }
          if (path === 'session') {
            const s: Session = { lang: 'en', version: '0.1.0-mock', at: new Date().toISOString(), projects: projects.map(pi), loop: { everyMinutes: 15, lastTickAt: lastTick?.at ?? iso(9 * 60_000), lastExitCode: 1 } };
            return send(res, 200, s);
          }
          if (path === 'projects') return send(res, 200, projects.map(pi));
          const overviewMatch = /^p\/([^/]+)\/overview$/.exec(path);
          if (overviewMatch) {
            const p = byId.get(decodeURIComponent(overviewMatch[1]));
            if (!p) return fail(res, 404, 'not_found', 'Unknown project');
            return send(res, 200, projectOverview(p));
          }
          if (path === 'overview/all') return send(res, 200, overviewAll());
          if (path === 'machines' || path.startsWith('machines/')) {
            const mp = project(url) ?? byId.get(body.project ?? '') ?? projects[0];
            if (handleMachines({ path, method: req.method ?? 'GET', url, body, project: mp.info.id, res, send, fail })) return;
          }
          if (path === 'design' || path.startsWith('design/')) {
            const dp = project(url) ?? byId.get(body.project ?? '');
            if (!dp?.info.design?.enabled) return fail(res, 404, 'not_found', 'Design library is off.');
            return handleDesign({ path, method: req.method ?? 'GET', url, body, project: dp.info.id, res, send, fail });
          }
          if (path === 'stream') {
            const p = project(url);
            if (!p) return fail(res, 400, 'bad_request', 'unknown project');
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            const client = { res, project: p.info.id, logs: new Set((url.searchParams.get('logs') ?? '').split(',').filter(Boolean).map(k => k.split('@')[0]!)) };
            clients.add(client);
            res.write(`id: ${boot}.${++seq}\nevent: hello\ndata: ${JSON.stringify({ boot, project: p.info.id, at: new Date().toISOString(), replayed: 0 })}\n\n`);
            const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
            req.on('close', () => { clients.delete(client); clearInterval(ping); });
            return;
          }
          if (/^(picks|art|spend|usage)(\/|$)/.test(path)) {
            const lp = project(url) ?? (req.method === 'POST' ? byId.get(body.project ?? '') ?? (projects.length === 1 ? projects[0] : undefined) : undefined);
            if (!lp) return fail(res, 400, 'bad_request', 'project is missing or unknown');
            if (handleLibrary({ path, method: req.method ?? 'GET', url, body, p: lp, res, send, fail, emit, record })) return;
          }
          if (path === 'roles' || path === 'files' || path === 'runs' || path === 'decisions' || path === 'lessons' || path === 'credits' || path === 'events' || path === 'clean' || path === 'skills' || path === 'skills/use' || path === 'docs' || path.startsWith('docs/') || /^orders\/[^/]+\/(route|role|skills|classify)$/.test(path) || /^orders\/[^/]+\/(evidence|questions|quotes)/.test(path)) {
            const px = project(url) ?? (req.method === 'POST' ? byId.get(body.project ?? '') ?? (projects.length === 1 ? projects[0] : undefined) : undefined);
            if (!px) return fail(res, 400, 'bad_request', 'project is missing or unknown');
            if (handleExtras({ path, method: req.method ?? 'GET', url, body, p: px, res, send, fail, emit, record })) return;
          }
          if (path === 'workers' || path.startsWith('workers/')) {
            const wp = project(url) ?? (req.method !== 'GET' ? byId.get(body.project ?? '') ?? (projects.length === 1 ? projects[0] : undefined) : undefined);
            if (!wp) return fail(res, 400, 'bad_request', 'project is missing or unknown');
            if (workerCall(wp, req.method ?? 'GET', path, body, res)) return;
          }
          if (path === 'workers' || path === 'overview' || path === 'resources' || path === 'leases/release' || path.startsWith('orders') || path.startsWith('quota') || path.startsWith('runs/') || path === 'tick' || path.startsWith('check/')) {
            const p = project(url) ?? (req.method === 'POST' ? byId.get(body.project ?? '') ?? (projects.length === 1 ? projects[0] : undefined) : undefined);
            if (!p) return fail(res, 400, 'bad_request', 'project is missing or unknown');
            if (path === 'overview') return send(res, 200, makeOverview(p));
            if (path === 'resources') {
              const resources = makeResources(p).map(r => { const leases = r.leases.filter(l => !released.has(`${l.resource}:${l.tag}`)); return { ...r, leases, used: leases.length }; });
              return send(res, 200, { project: p.info.id, resources });
            }
            if (path === 'leases/release' && req.method === 'POST') {
              const held = makeResources(p).flatMap(r => r.leases).find(l => l.resource === body.resource && l.tag === body.tag && !released.has(`${l.resource}:${l.tag}`));
              if (held) { released.add(`${body.resource}:${body.tag}`); record(p, String(body.tag), 'lease-released', 'web', { resource: body.resource }); }
              return send(res, 200, { ok: true, resource: body.resource, tag: body.tag, released: !!held });
            }
            if (path === 'workers') {
              const workers = makeWorkers(p);
              return send(res, 200, { workers, sources: workers.filter(w => w.quota).map(w => ({ source: w.quota!.source, latest: w.quota })) });
            }
            if (path === 'quota/history') {
              const worker = url.searchParams.get('worker');
              const w = makeWorkers(p).find(x => x.id === worker);
              const source = w?.quota?.source ?? worker ?? 'unknown';
              return send(res, 200, { worker: worker ?? undefined, source, points: makeHistory(source, source === 'gateway') });
            }
            if (path === 'tick') return send(res, 200, tick(p, body.real === true));
            if (path.startsWith('check/')) {
              const o = p.orders.get(decodeURIComponent(path.slice(6)));
              if (!o) return fail(res, 404, 'not_found', 'no such order');
              const r: CheckResult | undefined = o.lastCheck;
              if (!r) return fail(res, 409, 'conflict', 'this mock has no check result for the order');
              record(p, o.def.tag, 'check', 'web');
              return send(res, 200, { ...r, at: new Date().toISOString() });
            }
            if (path.startsWith('runs/')) {
              const m = /^runs\/(.+)\/log$/.exec(path);
              if (!m) return fail(res, 404, 'not_found', 'no such call');
              const key = decodeURIComponent(m[1]!);
              const tag = key.split(':')[0]!;
              const run = p.orders.get(tag)?.runs.find(r => r.key === key);
              if (!run?.hasLog) return fail(res, 404, 'not_found', 'this run has no log');
              const tail = Math.min(2000, Number(url.searchParams.get('tail') ?? 200));
              const all = logOf(key);
              const out: RunLog = { project: p.info.id, key, lines: all.slice(-tail), offset: all.join('\n').length, size: all.join('\n').length, cut: all.length > tail };
              return send(res, 200, out);
            }
            if (path === 'orders' && req.method === 'POST') {
              const b = body as NewOrderRequest;
              if (!b.tag || !b.title) return fail(res, 400, 'bad_request', 'tag and title are required');
              if (p.orders.has(b.tag)) return fail(res, 409, 'conflict', `order ${b.tag} exists already`);
              const o: MockOrder = { def: { tag: b.tag, title: b.title, kind: b.kind ?? '', role: b.role, heavy: b.heavy, needs: b.needs ?? [], worker: b.worker, mandate: b.mandate, created: new Date().toISOString(), updated: new Date().toISOString() }, stage: b.queue ? 'queued' : 'draft', why: whyFor(b.queue ? 'queued' : 'draft'), runs: [], reports: [], decisions: [], file: b.body };
              p.orders.set(b.tag, o);
              record(p, b.tag, 'order-added', 'web');
              const file = b.body ? `${p.info.workOrdersDir}/${b.tag}-${(b.slug ?? b.title).toLowerCase().replace(/\W+/g, '-')}.md` : undefined;
              return send(res, 201, { order: summarize(p, o) as OrderSummary, file, tableRow: p.info.tableWriteBack });
            }
            if (path === 'orders') {
              const stage = url.searchParams.get('stage');
              const items = [...p.orders.values()].filter(o => !stage || o.stage === stage).map(o => summarize(p, o) as OrderSummary).sort((a, b) => a.tag.localeCompare(b.tag));
              return send(res, 200, { project: p.info.id, stage: stage ?? undefined, count: items.length, items });
            }
            const m = /^orders\/([^/]+)(?:\/(diff|actions))?$/.exec(path);
            if (m) {
              const o = p.orders.get(decodeURIComponent(m[1]!));
              if (!o) return fail(res, 404, 'not_found', 'no such order');
              if (m[2] === 'actions' && req.method === 'POST') {
                const r = act(p, o, body as ActionRequest);
                return r.status === 200 ? send(res, 200, r.result) : fail(res, r.status, r.status === 409 ? 'conflict' : 'bad_request', r.message ?? '');
              }
              if (m[2] === 'diff') {
                if (!o.diff) return fail(res, 404, 'not_found', 'this order has no worktree to diff');
                const files = o.diff.files;
                const d: OrderDiff = { project: p.info.id, tag: o.def.tag, base: o.diff.base, head: o.diff.head, worktree: `../worktrees/${o.def.tag.toLowerCase()}`, commits: o.diff.commits, stat: { files: files.length, insertions: files.reduce((n, f) => n + f.insertions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) }, files, truncated: false };
                return send(res, 200, d);
              }
              return send(res, 200, detail(p, o));
            }
          }
          return fail(res, 404, 'not_found', `no such call: ${path}`);
        } catch (e) {
          return fail(res, 500, 'internal', e instanceof Error ? e.message : String(e));
        }
      });

      /** What `/api/p/<id>/overview` answers: the project's overview with fourteen days of made-up merges. */
      function projectOverview(p: MockProject) {
        const o = makeOverview(p);
        const merges = mergesPerDay(p);
        return { ...o, total: p.orders.size, needsCount: o.needsYou.count, capacity: {}, attention: [],
          live: { count: o.running.count, items: o.running.items.map(r => ({ ...r, leases: [] })) },
          nextUp: [], dependencies: [], throughput: { days: [], byKind: [] }, mergesPerDay: merges, recent: { decisions: [], approvals: [] }, recentDecisions: [], recentApprovals: [],
          producer: { openCases: 1, wouldDoToday: 0, paused: false }, nightlyGates: mockNightlyGates() };
      }
      function mergesPerDay(p: MockProject): number[] {
        let h = 0;
        for (const ch of p.info.id) h = (h * 31 + ch.charCodeAt(0)) % 997;
        return Array.from({ length: 14 }, (_, i) => Math.max(0, Math.round(2.4 + Math.sin(i / 2 + h) * 2 + (i > 9 ? 1.4 : 0) - (h % 2))));
      }
      /** The all-projects overview (`/api/overview/all`) put together from every mock project. */
      function overviewAll() {
        const now = Date.now(), DAY = 86400_000;
        const views = projects.map(projectOverview);
        const workers = makeWorkers(projects[0]!);
        const sources = [...new Set(workers.map(w => w.quota?.source).filter((s): s is string => !!s))];
        const days = Array.from({ length: 14 }, (_, i) => {
          const day = new Date(now - (13 - i) * DAY).toISOString().slice(0, 10);
          const merges = Object.fromEntries(views.map(v => [v.project, v.mergesPerDay[i] ?? 0]));
          const total = Object.values(merges).reduce((a, b) => a + b, 0);
          return { day, merges, reworks: i % 4 === 1 ? 1 : 0, endings: { completed: total + (i % 3), ...(i % 5 === 2 ? { capacity: 1 } : {}), ...(i % 6 === 4 ? { failed: 1 } : {}) } };
        });
        const merged = projects.flatMap(p => [...p.orders.values()].filter(o => o.stage === 'merged').map(o => ({ p, o })));
        const recent = merged.slice(0, 12).map(({ p, o }, i) => ({ project: p.info.id, tag: o.def.tag, title: o.def.title, at: new Date(now - (i * 3.3 + 0.6) * 3600_000).toISOString(), runs: 1 + (i % 3 === 0 ? 1 : 0), reworks: i % 4 === 0 ? 1 : 0, worker: o.def.worker, leadHours: 2.5 + (i % 5) * 1.7 }));
        const problems = views.flatMap(v => v.problems.items.map(item => ({ ...item, project: v.project })));
        const kinds = [...new Set(problems.map(item => item.kind))];
        const attention = [
          ...(views.some(v => v.needsCount) ? [{ kind: 'needs-you', problem: false, count: views.reduce((n, v) => n + v.needsCount, 0), items: views.flatMap(v => v.needsYou.items.map(i => ({ project: v.project, tag: i.tag, text: i.title }))) }] : []),
          ...kinds.map(kind => { const items = problems.filter(i => i.kind === kind); return { kind, problem: true, count: items.length, items: items.map(i => ({ project: i.project, tag: i.tag, text: i.text })) }; }),
        ];
        return {
          at: new Date(now).toISOString(), readingsAt: new Date(now - 40_000).toISOString(), projects: views, attention,
          live: { count: views.reduce((n, v) => n + v.live.count, 0), items: views.flatMap(v => v.live.items) },
          workers: { count: workers.length, items: workers.map((w, i) => ({ ...w, ...(w.quota?.balance ? { balanceChange24h: -3.2 - i } : {}) })) },
          quotas: sources.map(source => ({ source, workers: workers.filter(w => w.quota?.source === source).map(w => w.id), reading: workers.find(w => w.quota?.source === source)?.quota })),
          machine: { freeRamGb: 23.4, minFreeRamGb: 8 }, days,
          metrics: { merges7d: days.slice(-7).reduce((n, d) => n + Object.values(d.merges).reduce((a, b) => a + b, 0), 0), runSuccessRate: 0.87, reworksPerMerge: 0.21, medianLeadHours: 3.8, p95LeadHours: 11.2 },
          recentMerges: { count: merged.length, items: recent },
          resources: projects.flatMap(p => makeResources(p).map(r => ({ ...r, project: p.info.id }))),
          next: { moves: views.flatMap(v => v.next.moves.map(m => ({ ...m, project: v.project }))), heldBack: views.flatMap(v => v.next.heldBack.map(h => ({ ...h, project: v.project }))), lastTickAt: lastTick?.at ?? iso(9 * 60_000) },
        };
      }

      function pi(p: MockProject) {
        const stages: Partial<Record<Stage, number>> = {};
        for (const o of p.orders.values()) stages[o.stage] = (stages[o.stage] ?? 0) + 1;
        return { ...p.info, orderCount: p.orders.size, stages };
      }
    },
  };
}
