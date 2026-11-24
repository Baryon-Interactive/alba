import { createHash, randomUUID } from 'node:crypto';
import { admit, credentialOf, formToken, fromOtherSite, keyFile, newKey, safeNext, sameSecret, Sessions } from './auth.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, hostAllowed, originAllowed, resolveLogOf, type ApiContext } from '../api/handler.ts';
import { Hub } from '../api/hub.ts';
import type { Session } from '../api/types.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProjectConfig } from '../config.ts';
import { UserError, currentLang, t, withLang } from '../i18n.ts';
import type { ActionKind } from '../orders/model.ts';
import { actionProblem } from '../orders/stage.ts';
import { findFinishes } from '../run/finish.ts';
import { NOTE_REQUIRED, humanAction, isHumanAction } from '../service/actions.ts';
import { executeTick } from '../tick/execute.ts';
import { systemProbes, tick, type Probes } from '../tick/gather.ts';
import { formatReport } from '../tick/plan.ts';
import type { WorkersFile } from '../workers/config.ts';
import { producerPage, confirmPage, messagePage, orderPage, overviewPage, projectPage, workersPage } from './html.ts';
import { buildSnapshot, cachedProbes, snapshotFromTicks, type ProjectView, type Snapshot } from './snapshot.ts';
import { freePort } from './port.ts';
import { stateStore } from '../orders/backend.ts';
import { Orders } from '../orders/service.ts';
import { verifyOrder } from '../verify/verify.ts';
import { runProducerAction, setProducerPaused } from '../producer/producer.ts';
import { sendBody } from './response.ts';
import { watchLoopDelay } from '../serve/delay.ts';
import { WorkerChannel } from '../serve/channel.ts';
import { activityScanner } from './activity.ts';

export interface ServerOptions {
  projects: ProjectConfig[];
  workers?: WorkersFile;
  port: number;                 // 0 picks a free one
  probes: Probes;
  snapshotTtlMs?: number;
  /** The built front end (`ui/dist`); served when the folder exists. */
  uiDir?: string;
  /** Origins besides this server's own that may call the interface (a front end's dev server). */
  extraOrigins?: string[];
  version?: string;
  loop?: () => Session['loop'];
  hubCheckMs?: number;
  /** Module exporting `probes` for isolated fixtures. Function-valued test probes run in process. */
  probesModule?: string;
  background?: boolean;
  /** Internal renderer mode for the read worker: no listener or refresh timer. */
  listen?: boolean;
  writeToken?: string;
  instanceId?: string;
  /** Ask for the key (or a browser session from /login) on every /api and /legacy request. Off by default: the board answers only
   *  on 127.0.0.1 and refuses pages of other sites, which is enough on one person's machine. */
  signIn?: boolean;
  onReload?: (request: import('../api/types.ts').ServeReloadRequest) => Promise<import('../api/types.ts').ServeReloadResult>;
}

export interface Board {
  server: Server; hub: Hub; ctx: ApiContext; invalidate(): void;
  renderLegacy(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]): Promise<void>;
  onReload?: (request: import('../api/types.ts').ServeReloadRequest) => Promise<import('../api/types.ts').ServeReloadResult>;
}

const DEFAULT_UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

/**
 * The Content-Security-Policy of the console page: its own scripts (and the inline ones of index.html, by hash), its own interface,
 * pictures from itself, no frames, no plugins, no other site. Styles may be inline (components set them).
 */
export function consolePolicy(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].filter(m => m[1].trim())
    .map(m => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  return [
    "default-src 'self'", `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self' data:", "connect-src 'self'", "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}

/** A file of the built front end, or its index page for any path without an extension (the page does its own routing). */
function serveStatic(req: IncomingMessage, res: ServerResponse, uiDir: string, pathname: string): boolean {
  const root = path.resolve(uiDir);
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  let file = path.resolve(root, '.' + decoded);
  const inside = (p: string) => { const rel = path.relative(root, p); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  if (!inside(file)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (path.extname(pathname)) return false;
    file = path.join(root, 'index.html');
    if (!existsSync(file)) return false;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const body = readFileSync(file);
  // same-origin, not no-referrer: with no-referrer a browser sends "Origin: null" on the page's own writes.
  const headers: Record<string, string> = { 'content-type': type, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' };
  if (/[.-][A-Za-z0-9_-]{8,}\.[^.]+$/.test(path.basename(file)) && path.dirname(file) === path.join(root, 'assets')) headers['cache-control'] = 'public, max-age=31536000, immutable';
  // The page holds no secret: it signs in with a cookie (see auth.ts).
  if (path.extname(file).toLowerCase() === '.html') headers['content-security-policy'] = consolePolicy(body.toString('utf8'));
  sendBody(req, res, 200, body, headers);
  return true;
}

/** The only address the board listens on. There is no option to change it: it has no login. */
export const HOST = '127.0.0.1';

const MAX_BODY = 100_000;

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new UserError('Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/**
 * The board: server-rendered pages, no scripts. Reads go through a short-lived snapshot (the quota command and the
 * memory query are slow); actions go through the same service layer as the command line, with the actor "web".
 */
export function startServer(options: ServerOptions): Server {
  return createBoard(options).server;
}

/** GET reads answered by a reader thread: everything but streams and what needs this thread (SSH, sessions, the hub). */
const BUFFERED = /^\/api\/(projects|orders|runs|producer|decisions|overview|workers|usage|needs|roles|skills|lessons|credits|resources|events|clean|config|plugins|routing|design|design-docs|docs|picks|art|intake|p)(\/|$)/;
/** The reads among them that can take seconds: they have a reader of their own. */
const SLOW = /^\/api\/(clean|usage|skills|roles|lessons)(\/|$)/;

/** The same, with the parts `alba serve` needs: the event hub and the interface's context. */
export function createBoard(options: ServerOptions): Board {
  const delay = watchLoopDelay();
  const background = options.background ?? (options.probes === systemProbes || !!options.probesModule);
  // Two reader threads: reads that can take seconds (the clean plan's git checks, usage accounting, skills, routes with their
  // results) have a lane of their own, so they never hold up the lists and pages the console asks for every few seconds.
  const readerFile = new URL(import.meta.url.endsWith('.ts') ? './read-worker.ts' : './read-worker.js', import.meta.url);
  const lanes = background ? { fast: new WorkerChannel(readerFile, { probesModule: options.probesModule }), slow: new WorkerChannel(readerFile, { probesModule: options.probesModule }) } : undefined;
  const reader = lanes?.fast;
  /** The tick results each lane has: they are sent again only when a tick has added new ones. */
  const sentTicks = new Map<WorkerChannel, number>();
  // The key (auth.ts): never sent in an answer. Pages carry the form token derived from it, browsers a session cookie.
  const token = options.writeToken ?? newKey();
  const formKey = formToken(token);
  const signInRequired = options.signIn === true;
  let boardPort = 0;
  const sessions = new Sessions(() => boardPort);
  const slow = cachedProbes(options.probes, 60_000);
  // The quota commands can take seconds; read them now, in the background, instead of on the first page.
  const quotaCommands = Object.values(options.workers?.quota_sources ?? {}).flatMap(q => (q.type === 'command-json' ? [{ command: q.command, timeout: q.timeout_seconds }] : []));
  const seen = new Set<string>();
  void slow.prime(quotaCommands.filter(q => !seen.has(q.command.join('\0')) && seen.add(q.command.join('\0'))).map(q => q.command), Math.max(60, ...quotaCommands.map(q => q.timeout)));
  const ttl = options.snapshotTtlMs ?? 30_000;
  // The texts in a snapshot (problem lines) are in the language of the request that caused it, so each language has its own.
  const caches = new Map<string, { at: number; snap: Snapshot }>();
  const latest = new Map<string, Snapshot>();
  const snapshot = (): Snapshot => {
    const lang = currentLang();
    let hit = caches.get(lang);
    if (!hit || Date.now() - hit.at > ttl) {
      // With the serve's tick results for every project, the view is built from them (milliseconds) instead of a dry-run tick
      // of each project (seconds).
      const ticks = ctx.tickResults;
      const fromTicks = !!ticks && options.projects.length > 0 && options.projects.every(p => ticks[p.id]);
      hit = { at: Date.now(), snap: fromTicks ? snapshotFromTicks(options.projects, ctx.workers, ticks!, slow) : buildSnapshot(options.projects, ctx.workers, slow) };
      caches.set(lang, hit); latest.set(lang, hit.snap);
    }
    return hit.snap;
  };
  let revision = 0;
  const invalidate = () => { caches.clear(); revision++; };
  const view = (snap: Snapshot, id: string | undefined): ProjectView | undefined => snap.projects.find(p => p.config.id === id);

  const send = (res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", ...headers,
    });
    // The old board lives under /legacy: its absolute links and form targets are moved there.
    res.end(html.replace(/(href|action)="\//g, '$1="/legacy/'));
  };

  /** The server-rendered board: `parts` are the path segments after /legacy. */
  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]): Promise<void> => {

    if (req.method === 'GET') {
      const snap = snapshot();
      if (!parts.length) return send(res, 200, overviewPage(snap, formKey));
      if (parts[0] === 'producer' && parts.length === 1) {
        const v = view(snap, url.searchParams.get('project') ?? snap.projects[0]?.config.id);
        return v ? send(res, 200, producerPage(snap, v.config, formKey, url.searchParams.get('closed') === '1')) : send(res, 404, messagePage(snap, t('Not found'), t('No such project.'), 'bad'));
      }
      if (parts[0] === 'workers' && parts.length === 1) return send(res, 200, workersPage(snap));
      if (parts[0] === 'p' && parts.length === 2) {
        const v = view(snap, parts[1]);
        return v ? send(res, 200, projectPage(snap, v, url.searchParams.get('stage') ?? undefined)) : send(res, 404, messagePage(snap, t('Not found'), t('No such project.'), 'bad'));
      }
      if (parts[0] === 'o' && parts.length === 3) {
        const v = view(snap, parts[1]);
        if (!v) return send(res, 404, messagePage(snap, t('Not found'), t('No such project.'), 'bad'));
        let doc;
        try { doc = v.orders.get(parts[2]); } catch { return send(res, 404, messagePage(snap, t('Not found'), t('No such order.'), 'bad', `/p/${encodeURIComponent(v.config.id)}`)); }
        const merged = v.orders.mergedSet();
        const { stage, why } = v.orders.stage(doc, merged);
        return send(res, 200, orderPage({
          snap, project: v.config, doc, stage, why, merged,
          stageOf: tag => { try { return v.orders.stage(v.orders.get(tag), merged).stage; } catch { return undefined; } },
          events: v.orders.store.events({ tag: doc.order.tag }),
          logTail: run => (run.log ? options.probes.tail(run.log, 16_000).split('\n').filter((l, i, all) => i < all.length - 1 || l).slice(-40).join('\n') : ''),
          token: formKey,
        }));
      }
      if (parts[0] === 'confirm' && parts.length === 1) {
        const v = view(snap, url.searchParams.get('project') ?? undefined);
        const tag = url.searchParams.get('tag') ?? '';
        const action = url.searchParams.get('action') ?? '';
        if (!v || !isHumanAction(action)) return send(res, 400, messagePage(snap, t('Bad request'), t('Unknown project or action.'), 'bad'));
        let doc;
        try { doc = v.orders.get(tag); } catch { return send(res, 404, messagePage(snap, t('Not found'), t('No such order.'), 'bad')); }
        const stage = v.orders.stage(doc).stage;
        const override = url.searchParams.get('override') === '1';
        return send(res, 200, confirmPage(snap, { project: v.config.id, tag: doc.order.tag, action: action as ActionKind, token: formKey, title: doc.order.title, stage, problem: override || action.startsWith('review-') || action.startsWith('check-') ? undefined : actionProblem(stage, action as ActionKind), needsNote: NOTE_REQUIRED.includes(action), override }));
      }
      return send(res, 404, messagePage(snap, t('Not found'), t('No such page.'), 'bad'));
    }

    if (req.method === 'POST') {
      const form = await readForm(req);
      const snap = snapshot();
      if (!sameSecret(form.get('token') ?? undefined, formKey)) return send(res, 403, messagePage(snap, t('Forbidden'), t('The form is out of date. Open the board again and retry.'), 'bad'));
      if (parts.join('/') === 'do') {
        const v = view(snap, form.get('project') ?? undefined);
        const tag = form.get('tag') ?? '';
        const action = form.get('action') ?? '';
        if (!v || !isHumanAction(action)) return send(res, 400, messagePage(snap, t('Bad request'), t('Unknown project or action.'), 'bad'));
        const back = `/o/${encodeURIComponent(v.config.id)}/${encodeURIComponent(tag)}`;
        try {
          humanAction(v.config, v.orders, tag, action, form.get('note')?.trim() || undefined, undefined, form.get('override') === '1');
        } catch (e) {
          if (!(e instanceof UserError)) throw e;
          return send(res, 400, messagePage(snap, t('Not done'), e.message, 'bad', back));
        }
        invalidate();
        res.writeHead(303, { location: `/legacy${back}` });
        return void res.end();
      }
      if (parts[0] === 'producer' && (parts[1] === 'pause' || parts[1] === 'resume') && parts.length === 2) {
        const v = view(snap, form.get('project') ?? undefined);
        if (!v) return send(res, 400, messagePage(snap, t('Bad request'), t('Unknown project.'), 'bad'));
        setProducerPaused(v.config, parts[1] === 'pause', options.probes.now());
        invalidate();
        res.writeHead(303, { location: `/legacy/producer?project=${encodeURIComponent(v.config.id)}` });
        return void res.end();
      }
      if (parts.join('/') === 'producer/action') {
        const v = view(snap, form.get('project') ?? undefined);
        const id = form.get('actionId') ?? '';
        if (!v || !id) return send(res, 400, messagePage(snap, t('Bad request'), t('Unknown project or action.'), 'bad'));
        runProducerAction(v.config, v.orders, id);
        invalidate();
        res.writeHead(303, { location: `/legacy/producer?project=${encodeURIComponent(v.config.id)}` });
        return void res.end();
      }
      if (parts.join('/') === 'verify') {
        const v = view(snap, form.get('project') ?? undefined);
        const tag = form.get('tag') ?? '';
        if (!v) return send(res, 400, messagePage(snap, t('Bad request'), t('Unknown project or order.'), 'bad'));
        try { verifyOrder(v.config, v.orders, tag, { manual: true }); }
        catch (e) { return send(res, 400, messagePage(snap, t('Not done'), (e as Error).message, 'bad', `/o/${encodeURIComponent(v.config.id)}/${encodeURIComponent(tag)}`)); }
        invalidate();
        res.writeHead(303, { location: `/legacy/o/${encodeURIComponent(v.config.id)}/${encodeURIComponent(tag)}` });
        return void res.end();
      }
      if (parts.join('/') === 'tick') {
        if (!ctx.workers) return send(res, 400, messagePage(snap, t('Not done'), t('No workers file was given, so there is nothing to tick.'), 'bad'));
        const real = form.get('real') === '1';
        const sections: string[] = [];
        for (const v of snap.projects) {
          try {
            const runCtx = { project: v.config, orders: v.orders, workers: ctx.workers, probes: options.probes };
            if (ctx.runTick) {
              sections.push(`== ${v.config.name}\n${formatReport((await ctx.runTick(v.config, real, 1)).report, !real)}`);
            } else if (real) {
              sections.push(`== ${v.config.name}\n${formatReport(executeTick(runCtx, { maxDispatch: 1 }).report, false)}`);
            } else {
              const finishes = findFinishes(v.config, v.orders, options.probes).map(f => ({ tag: f.tag, run: f.run, outcome: f.outcome, why: f.why }));
              sections.push(`== ${v.config.name}\n${formatReport(tick(v.config, v.orders, runCtx.workers, options.probes, { record: false, finishes }).report, true)}`);
            }
          } catch (e) {
            sections.push(`== ${v.config.name}\n${(e as Error).message.split('\n')[0]}`);
          }
        }
        invalidate();
        return send(res, 200, messagePage(buildSnapshot(options.projects, ctx.workers, slow), real ? t('Tick (real)') : t('Tick (dry run)'), sections.join('\n\n')));
      }
    }
    return send(res, 405, messagePage(snapshot(), t('Not allowed'), t('Method not allowed.'), 'bad'));
  };

  const hub = new Hub(options.projects.map(p => ({ id: p.id, stateDir: p.state_dir, config: p })), {
    checkMs: options.hubCheckMs,
    resolveLog: (project, key) => resolveLogOf(options.projects, project, key),
  });
  const ctx: ApiContext = {
    instanceId: options.instanceId ?? randomUUID(),
    projects: options.projects, workers: options.workers, probes: options.probes, slow, token, extraOrigins: options.extraOrigins ?? [],
    get revision() { return revision; },
    snapshot, peek: () => caches.get(currentLang())?.snap, readings: () => latest.get(currentLang()), invalidate, hub, version: options.version ?? '0', loop: options.loop, eventLoopDelay: delay.read,
  };
  // Anything that is written to a state folder makes the cached snapshot stale.
  hub.onChange = invalidate;
  /** What a reader lane needs for one request; the tick results go only when the lane does not have the latest ones yet. */
  const readArgs = (lane: WorkerChannel, url: URL, headers: IncomingMessage['headers'], port: number) => {
    const ticks = ctx.tickRevision ?? 0;
    const send = sentTicks.get(lane) !== ticks;
    if (send) sentTicks.set(lane, ticks);
    return {
      url: url.href, headers, port, projects: ctx.projects, workers: ctx.workers, token, extraOrigins: ctx.extraOrigins,
      version: ctx.version, revision, loop: ctx.loop?.(), tickRevision: ticks, ...(send ? { tickResults: ctx.tickResults } : {}),
      problems: Object.fromEntries(ctx.projects.map(p => [p.id, ctx.extraProblems?.(p.id) ?? []])),
    };
  };
  const scanActivity = activityScanner(options.probes);
  let activityPending = false;
  hub.onScan = () => {
    if (!reader) { for (const event of scanActivity(options.projects)) hub.publish(event.project, 'run.activity', event); return; }
    if (activityPending) return;
    activityPending = true;
    void reader.call<import('../api/types.ts').StreamEvents['run.activity'][]>('activity', { projects: options.projects })
      .then(events => { for (const event of events) hub.publish(event.project, 'run.activity', event); })
      .catch(() => { /* the next scan retries; API reads surface worker failures */ })
      .finally(() => { activityPending = false; });
  };
  const uiDir = options.uiDir ?? DEFAULT_UI;

  const authHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
  const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const loginPage = (res: ServerResponse, status: number, next: string, problem?: string) => {
    res.writeHead(status, authHeaders);
    res.end(`<!doctype html><html lang="${currentLang() === 'zh' ? 'zh' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Alba</title>`
      + '<style>body{font:15px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#14183a}input{width:100%;font:inherit;padding:.4rem;box-sizing:border-box}button{margin-top:.6rem;font:inherit;padding:.4rem .9rem}.bad{color:#b42318}code{font-size:.9em}</style>'
      + `<h1>${esc(t('Sign in to Alba'))}</h1>${problem ? `<p class="bad">${esc(problem)}</p>` : ''}`
      + `<p>${esc(t('Open the sign-in link alba serve printed when it started, or paste the key from its key file:'))} <code>${esc(keyFile(boardPort))}</code></p>`
      + `<form method="post" action="/login"><input type="hidden" name="next" value="${esc(next)}"><input name="key" type="password" autocomplete="off" aria-label="key" autofocus><button>${esc(t('Sign in'))}</button></form></html>`);
  };
  const signIn = (res: ServerResponse, next: string) => {
    res.writeHead(303, { location: next, 'set-cookie': sessions.setCookie(sessions.create()), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
  };
  /** `/login`: the key (from the printed link, or pasted into the form) is traded for a session cookie. */
  const login = async (req: IncomingMessage, res: ServerResponse, url: URL, port: number): Promise<void> => {
    if (fromOtherSite(req)) return loginPage(res, 403, '/', t('Requests from another site are refused.'));
    // Without sign-in there is nothing to sign in to: an old link (or a page that still goes here) lands on the board.
    if (!signInRequired) return void (res.writeHead(303, { location: safeNext(url.searchParams.get('next')), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }), res.end());
    if (req.method === 'GET' || req.method === 'HEAD') {
      const next = safeNext(url.searchParams.get('next'));
      const key = url.searchParams.get('key');
      if (key === null) return sessions.idOf(req) ? void (res.writeHead(303, { location: next, 'cache-control': 'no-store' }), res.end()) : loginPage(res, 200, next);
      return sameSecret(key, token) ? signIn(res, next) : loginPage(res, 403, next, t('That is not the key of this board (it changes each time alba serve starts).'));
    }
    if (req.method === 'POST') {
      if (!originAllowed(req.headers.origin, port, ctx.extraOrigins)) return loginPage(res, 403, '/', t('This origin may not use the interface.'));
      const form = await readForm(req);
      const next = safeNext(form.get('next'));
      return sameSecret(form.get('key')?.trim(), token) ? signIn(res, next) : loginPage(res, 403, next, t('That is not the key of this board (it changes each time alba serve starts).'));
    }
    res.writeHead(405, { allow: 'GET, POST', 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  };
  /** `POST /logout`: ends this browser's session. */
  const logout = (req: IncomingMessage, res: ServerResponse, port: number): void => {
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' }); return void res.end('Method not allowed'); }
    if (fromOtherSite(req) || !req.headers.origin || !originAllowed(req.headers.origin, port, ctx.extraOrigins)) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('Forbidden'); }
    sessions.revoke(sessions.idOf(req));
    res.writeHead(303, { location: '/login', 'set-cookie': sessions.clearCookie(), 'cache-control': 'no-store' });
    res.end();
  };

  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    // The path alone, against a fixed base: a request path starting with "//" or a malformed Host header must not throw
    // here (an <img> on any web page could otherwise stop the server).
    const raw = req.url ?? '/';
    let url: URL;
    try {
      if (!raw.startsWith('/') || raw.startsWith('//')) throw new Error('bad path');
      url = new URL(raw, `http://${HOST}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('Bad request');
    }
    const parts = url.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
    const fail = (e: unknown) => send(res, 500, `<!doctype html><title>Error</title><pre>${String((e as Error).message).replace(/[<&]/g, '')}</pre>`);
    if (!hostAllowed(req.headers.host, port)) {
      if (parts[0] === 'api') {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        return void res.end(JSON.stringify({ error: { code: 'forbidden', message: 'This board answers only on 127.0.0.1.' } }));
      }
      return send(res, 403, messagePage(snapshot(), t('Forbidden'), t('This board answers only on 127.0.0.1.'), 'bad'));
    }
    boardPort = port;
    if (parts[0] === 'login' && parts.length === 1) return void login(req, res, url, port).catch(fail);
    if (parts[0] === 'logout' && parts.length === 1) return logout(req, res, port);
    if (parts[0] === 'api' || parts[0] === 'legacy') {
      const legacy = parts[0] === 'legacy';
      const refuse = (status: 401 | 403, code: 'unauthorized' | 'forbidden', message: string) => {
        if (!legacy) {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          return void res.end(JSON.stringify({ error: { code, message } }));
        }
        if (status === 401 && (req.method === 'GET' || req.method === 'HEAD')) {
          res.writeHead(303, { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'cache-control': 'no-store' });
          return void res.end();
        }
        // A plain page: a refused request must not cost a snapshot (probes, quota commands).
        res.writeHead(status, authHeaders);
        return void res.end(`<!doctype html><meta charset="utf-8"><title>${esc(t('Forbidden'))}</title><p>${esc(message)}</p>`);
      };
      const allowedOrigin = originAllowed(req.headers.origin, port, ctx.extraOrigins);
      // A page of another site (or another port of this host) gets nothing, not even a read: an <img> sends no Origin header.
      const extraOrigin = typeof req.headers.origin === 'string' && ctx.extraOrigins.includes(req.headers.origin);
      if (fromOtherSite(req) && !extraOrigin) return refuse(403, 'forbidden', t('Requests from another site are refused.'));
      // Without sign-in (the default) the board trusts this machine: it answers only on 127.0.0.1, and pages of other sites are
      // refused above. With `signIn` a request needs the key or a browser session.
      const credential = credentialOf(req, token, sessions) ?? (signInRequired ? undefined : 'open');
      if (!credential) return refuse(401, 'unauthorized', t('Sign in first: open the link alba serve printed, or send the key from the key file in the header x-alba-token.'));
      const reading = req.method === 'GET' || req.method === 'HEAD';
      // A browser's write must name a site that may write; a browser always sends Origin with one (and Sec-Fetch-Site). The key
      // alone is a program's proof; without sign-in a program that sends neither header is let in like before.
      const browser = credential === 'session' || typeof req.headers['sec-fetch-site'] === 'string';
      if (!allowedOrigin || (!reading && browser && credential !== 'key' && !req.headers.origin)) return refuse(403, 'forbidden', t('This origin may not use the interface.'));
      admit(req);
    }
    if (parts[0] === 'api' && parts[1] === 'serve' && parts[2] === 'reload' && parts.length === 3) {
      const jsonOut = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders });
        res.end(JSON.stringify(payload));
      };
      const remote = req.socket.remoteAddress;
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        return jsonOut(403, { error: { code: 'forbidden', message: t('This board answers only on 127.0.0.1.') } });
      }
      const realCred = credentialOf(req, token, sessions);
      if (!realCred) {
        return jsonOut(401, { error: { code: 'unauthorized', message: t('Sign in first: open the link alba serve printed, or send the key from the key file in the header x-alba-token.') } });
      }
      if (req.method !== 'POST') {
        return jsonOut(405, { error: { code: 'bad_request', message: t('Method not allowed.') } }, { allow: 'POST' });
      }
      const browserReq = realCred === 'session' || typeof req.headers['sec-fetch-site'] === 'string';
      if (!originAllowed(req.headers.origin, port, ctx.extraOrigins) || (browserReq && realCred !== 'key' && !req.headers.origin)) {
        return jsonOut(403, { error: { code: 'forbidden', message: t('This origin may not use the interface.') } });
      }
      const reloadHandler = boardOut.onReload ?? options.onReload;
      if (!reloadHandler) {
        return jsonOut(409, { error: { code: 'conflict', message: t('This server does not run alba serve.') } });
      }
      return void (async () => {
        let size = 0;
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large.'), { status: 413, code: 'too_large' })); req.destroy(); }
            else chunks.push(c);
          });
          req.on('end', () => resolve());
          req.on('error', reject);
        });
        const rawText = Buffer.concat(chunks).toString('utf8').trim();
        let parsed: Record<string, unknown> = {};
        if (rawText) {
          let v: unknown;
          try { v = JSON.parse(rawText); } catch { return jsonOut(400, { error: { code: 'bad_request', message: 'The body must be a JSON object.' } }); }
          if (typeof v !== 'object' || v === null || Array.isArray(v)) return jsonOut(400, { error: { code: 'bad_request', message: 'The body must be a JSON object.' } });
          parsed = v as Record<string, unknown>;
        }
        const unknownKeys = Object.keys(parsed).filter(k => k !== 'force');
        if (unknownKeys.length) return jsonOut(400, { error: { code: 'bad_request', message: `Unknown field(s): ${unknownKeys.join(', ')}.` } });
        if (parsed.force !== undefined && typeof parsed.force !== 'boolean') {
          return jsonOut(400, { error: { code: 'bad_request', message: '"force" must be true or false.' } });
        }
        try {
          const result = await reloadHandler(parsed.force !== undefined ? { force: parsed.force } : {});
          if (!res.destroyed) jsonOut(202, result);
        } catch (err) {
          if (res.destroyed) return;
          if (err instanceof UserError) return jsonOut(409, { error: { code: 'conflict', message: err.message } });
          jsonOut(500, { error: { code: 'internal', message: (err as Error).message } });
        }
      })().catch(err => {
        if (res.destroyed) return;
        const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
        const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'internal';
        jsonOut(status, { error: { code, message: (err as Error).message } });
      });
    }
    if (parts[0] === 'api') {
      // Buffered aggregate/detail reads have their own loop and connection; streams retain the main event hub. A slow read here
      // (routes with their results, the clean plan's git checks, skills) would otherwise stop every other request, pages included.
      const buffered = req.method === 'GET' && !url.pathname.endsWith('/stream') && BUFFERED.test(url.pathname);
      if (lanes && buffered) {
        const lane = SLOW.test(url.pathname) ? lanes.slow : lanes.fast;
        return void lane.call<{ status: number; headers: Record<string, string>; body?: Uint8Array }>('read', readArgs(lane, url, req.headers, port))
          .then(result => { if (!res.destroyed) { res.writeHead(result.status, result.headers); res.end(result.body ? Buffer.from(result.body) : undefined); } }).catch(fail);
      }
      return void handleApi(ctx, req, res, url, port).catch(fail);
    }
    if (parts[0] === 'legacy') {
      if (reader && req.method === 'GET') {
        return void reader.call<{ status: number; headers: Record<string, string>; body?: Uint8Array }>('legacy', readArgs(reader, url, req.headers, port)).then(result => { if (!res.destroyed) { res.writeHead(result.status, result.headers); res.end(result.body ? Buffer.from(result.body) : undefined); } }).catch(fail);
      }
      return void handle(req, res, url, parts.slice(1)).catch(fail);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (existsSync(uiDir) && serveStatic(req, res, uiDir, url.pathname)) return;
      if (!parts.length) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return void res.end('<!doctype html><meta charset="utf-8"><title>Alba</title><p>The new console is not built here (no ui/dist). The older board is at <a href="/legacy/">/legacy</a>; the interface is under <code>/api/</code> (see docs/console/010-api.md).</p>');
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
  // A request must arrive whole in 30 s (headers in 10 s): a slow or stuck client cannot hold the process. Answers that stream are not limited.
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  // Port 0 means "any free one": ask for one `fetch` may connect to (the system sometimes hands out a port it refuses).
  if (options.listen !== false) {
    if (options.port === 0) {
      // The port arrives later: a close() before then must win, or the server would start listening after it was stopped and keep
      // the process alive.
      let closed = false;
      const close = server.close.bind(server);
      server.close = ((callback?: (err?: Error) => void) => { closed = true; return close(callback); }) as typeof server.close;
      const listen = (p: number) => { if (!closed) server.listen(p, HOST); };
      void freePort(HOST).then(listen, () => listen(0));
    } else server.listen(options.port, HOST);
  }
  server.once('listening', () => {
    hub.start();
    hub.scan();
    // Read quota and memory once now, so the first page does not wait for the slow commands.
    if (!reader) for (const lang of ['en', 'zh'] as const) try { withLang(lang, snapshot); } catch { /* shown on the page */ }
  });
  // Refresh readings independently of dashboard requests. The aggregate endpoint never invokes probes.
  const refresh = options.listen !== false && !reader && ttl > 0 ? setInterval(() => {
    for (const lang of ['en', 'zh'] as const) try { withLang(lang, snapshot); } catch { /* retain the previous readings */ }
  }, Math.max(1000, ttl)).unref() : undefined;
  server.once('close', () => { void lanes?.fast.close(); void lanes?.slow.close(); delay.close(); if (refresh) clearInterval(refresh); hub.stop(); });
  const boardOut: Board = { server, hub, ctx, invalidate, renderLegacy: handle, ...(options.onReload ? { onReload: options.onReload } : {}) };
  return boardOut;
}
