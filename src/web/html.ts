import type { ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import { STAGES, type ActionKind, type OrderDoc, type OrderEvent, type Run, type Stage } from '../orders/model.ts';
import { actionProblem } from '../orders/stage.ts';
import { local } from '../time.ts';
import type { QuotaReading } from '../workers/quota.ts';
import { NEEDS_YOU, WAITING_FOR, type OrderRow, type ProjectView, type Snapshot } from './snapshot.ts';
import { producerActions, producerCases, producerPolicy, producerState, producerWouldDo, type ProducerCase } from '../producer/producer.ts';

export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
:root { color-scheme: light dark; --bg: #fafaf8; --fg: #1d1d1b; --muted: #6b6b66; --line: #dcdcd4; --card: #fff; --accent: #2457a6; --warn: #b3541e; --bad: #b3261e; --ok: #2f7d4f; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1c1e; --fg: #e8e8e4; --muted: #9a9a94; --line: #3a3b3e; --card: #232427; --accent: #7fa8e8; --warn: #e0905a; --bad: #ef7b72; --ok: #6fc28f; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
header { display: flex; gap: 18px; align-items: baseline; padding: 10px 20px; border-bottom: 1px solid var(--line); background: var(--card); flex-wrap: wrap; }
header b { font-size: 15px; } header a { color: var(--accent); text-decoration: none; } header .at { margin-left: auto; color: var(--muted); font-size: 12px; }
main { max-width: 1080px; margin: 0 auto; padding: 14px 20px 60px; }
h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 26px 0 8px; }
h2 .n { color: var(--fg); }
h3 { font-size: 14px; margin: 18px 0 6px; }
a { color: var(--accent); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 9px 12px; margin: 6px 0; }
.card.need { border-left: 4px solid var(--accent); } .card.problem { border-left: 4px solid var(--warn); } .card.bad { border-left: 4px solid var(--bad); }
.row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.tag { font-weight: 600; } .proj { color: var(--muted); font-size: 12px; } .muted { color: var(--muted); } .q { margin: 4px 0 6px; padding-left: 8px; border-left: 2px solid var(--line); white-space: pre-wrap; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--line); color: var(--muted); }
.badge.need { color: var(--accent); border-color: var(--accent); } .badge.bad { color: var(--bad); border-color: var(--bad); } .badge.ok { color: var(--ok); border-color: var(--ok); }
form.inline { display: inline; margin: 0; }
button, .btn { font: inherit; font-size: 13px; padding: 3px 11px; border-radius: 5px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); } button.danger { color: var(--bad); border-color: var(--bad); }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; } th { font-weight: 500; color: var(--muted); font-size: 12px; }
.bar { display: inline-block; width: 90px; height: 7px; background: var(--line); border-radius: 4px; overflow: hidden; vertical-align: middle; } .bar i { display: block; height: 100%; background: var(--ok); } .bar.warn i { background: var(--warn); } .bar.full i { background: var(--bad); }
pre { margin: 4px 0; padding: 8px; background: var(--card); border: 1px solid var(--line); border-radius: 5px; overflow-x: auto; font: 12px/1.4 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
textarea { width: 100%; min-height: 70px; font: inherit; padding: 6px; background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 5px; }
.rows td.on, .rows tr.on td { background: color-mix(in srgb, var(--accent) 14%, transparent); font-weight: 600; }
.stages a { display: inline-block; margin: 0 14px 4px 0; }
`;

export function page(title: string, body: string, options: { refresh?: number; projects?: ProjectConfig[]; at?: string } = {}): string {
  const nav = [`<a href="/">${esc(t('Board'))}</a>`, `<a href="/workers">${esc(t('Workers'))}</a>`, ...(options.projects ?? []).map(p => `<a href="/p/${encodeURIComponent(p.id)}">${esc(p.name)}</a>`)].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + (options.refresh ? `<meta http-equiv="refresh" content="${options.refresh}">` : '')
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body><header><b>Alba</b>${nav}${options.at ? `<span class="at">${esc(t('read {when}', { when: local(options.at) }))}</span>` : ''}</header><main>${body}</main></body></html>`;
}

/** A button that opens the confirmation page for an action. Nothing happens until the second step. */
export function actionButton(project: string, tag: string, action: ActionKind, label: string, kind = '', override = false): string {
  return `<form class="inline" method="get" action="/confirm"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="tag" value="${esc(tag)}"><input type="hidden" name="action" value="${esc(action)}">${override ? '<input type="hidden" name="override" value="1">' : ''}<button class="${kind}">${esc(label)}</button></form>`;
}

const LABEL: Record<string, [ActionKind, string, string][]> = {
  'awaiting-user': [['rework', 'Answer / send back', 'primary'], ['cancel', 'Cancel order', 'danger']],
  'awaiting-review': [['approve', 'Approve', 'primary'], ['rework', 'Send back', ''], ['cancel', 'Cancel order', 'danger']],
  blocked: [['rework', 'Send back with a note', 'primary'], ['queue', 'Queue again', ''], ['cancel', 'Cancel order', 'danger']],
  failed: [['rework', 'Send back with a note', 'primary'], ['queue', 'Queue again', ''], ['cancel', 'Cancel order', 'danger']],
  dropped: [['rework', 'Send back with a note', 'primary'], ['queue', 'Queue again', ''], ['cancel', 'Cancel order', 'danger']],
};

const orderLink = (project: string, tag: string) => `/o/${encodeURIComponent(project)}/${encodeURIComponent(tag)}`;

function needCard(row: OrderRow, several: boolean): string {
  const buttons = (LABEL[row.stage] ?? []).map(([a, label, kind]) => actionButton(row.project, row.tag, a, t(label), kind)).join(' ');
  const text = row.report?.question ?? row.report?.summary;
  const evidence = row.report && row.stage === 'awaiting-review' && row.report.commits.length ? `<div class="muted">${esc(t('commits'))}: ${esc(row.report.commits.join(', '))}</div>` : '';
  return `<div class="card need"><div class="row"><a class="tag" href="${orderLink(row.project, row.tag)}">${esc(row.tag)}</a><span>${esc(row.title)}</span>`
    + `<span class="badge need">${esc(t(WAITING_FOR[row.stage]))}</span>${several ? `<span class="proj">${esc(row.project)}</span>` : ''}</div>`
    + (text ? `<div class="q">${esc(text)}</div>` : '') + evidence + `<div class="row">${buttons}</div></div>`;
}

const ago = (iso: string, now: string): string => {
  const m = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60000));
  return m < 90 ? `${m} min` : m < 60 * 36 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

function runningLine(row: OrderRow, now: string): string {
  const a = row.activity;
  const bits: string[] = [];
  if (a?.lastCommitAt) bits.push(t('last commit {ago} ago', { ago: ago(a.lastCommitAt, now) }));
  else if (a && !a.worktree) bits.push(t('no worktree found to check'));
  if (a?.logAt) bits.push(t('log written {ago} ago', { ago: ago(a.logAt, now) }));
  if (a?.dirtyFiles) bits.push(t('{n} uncommitted', { n: a.dirtyFiles }));
  return bits.join(' · ');
}

/** Free memory, one line, in red only when it blocks starts. */
function machineLine(snap: Snapshot): string {
  if (snap.freeRamGb === undefined) return '';
  const low = snap.minFreeRamGb !== undefined && snap.freeRamGb < snap.minFreeRamGb;
  return `<div class="${low ? 'card problem' : 'muted'}">${esc(t('Free memory: {gb} GB', { gb: snap.freeRamGb.toFixed(1) }))}${low ? esc(t(' (below the {min} GB needed to start work)', { min: snap.minFreeRamGb! })) : ''}</div>`;
}

export function balanceChange(history: readonly QuotaReading[], current: QuotaReading | undefined, nowIso: string): { delta: number; hours: number } | undefined {
  if (!current || current.balance?.amount === undefined) return undefined;
  const series = [...history.filter(h => h.source === current.source && h.ok && h.balance?.amount !== undefined && h.at < current.at), current];
  if (series.length < 2) return undefined;
  const dayAgo = Date.parse(nowIso) - 24 * 3600 * 1000;
  const from = series.find(h => Date.parse(h.at) >= dayAgo) ?? series[0];
  if (from === current) return undefined;
  return { delta: current.balance!.amount! - from.balance!.amount!, hours: (Date.parse(current.at) - Date.parse(from.at)) / 3600000 };
}

function windowBars(reading: QuotaReading | undefined, nowMs: number): string {
  if (!reading || !reading.ok) return `<span class="badge bad">${esc(t('quota unreadable'))}</span>`;
  return reading.windows.map(w => {
    const resets = w.resetsAt && Date.parse(w.resetsAt) > nowMs ? ` ${esc(t('resets {when}', { when: local(w.resetsAt) }))}` : '';
    const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
    return `<div><span class="bar ${pct >= 100 ? 'full' : pct >= 85 ? 'warn' : ''}"><i style="width:${pct}%"></i></span> ${esc(w.name)} ${pct}%<span class="muted">${resets}</span></div>`;
  }).join('');
}

function workerTable(snap: Snapshot): string {
  const merged = new Map<string, { w: NonNullable<ProjectView['workers']>[number]; running: number; today: number }>();
  for (const p of snap.projects) for (const w of p.workers ?? []) {
    const have = merged.get(w.config.id);
    merged.set(w.config.id, { w, running: (have?.running ?? 0) + w.running, today: (have?.today ?? 0) + w.runsToday });
  }
  if (!merged.size) return '';
  const quotas = snap.projects.flatMap(p => p.quotas ?? []);
  const history = snap.projects.flatMap(p => p.history ?? []);
  const nowMs = Date.parse(snap.at);
  const rows = [...merged.values()].map(({ w, running, today }) => {
    const reading = w.config.quota ? quotas.find(q => q.source === w.config.quota) : undefined;
    const change = balanceChange(history, reading, snap.at);
    const balance = reading?.balance ? `${esc(reading.balance.raw)}${change ? ` <span class="${change.delta < 0 ? 'muted' : ''}">(${change.delta > 0 ? '+' : ''}${change.delta.toFixed(2)} ${esc(t('in {h} h', { h: change.hours < 10 ? change.hours.toFixed(1) : Math.round(change.hours) }))})</span>` : ''}` : '';
    const state = w.available ? `<span class="badge ok">${esc(t('available'))}</span>` : `<span class="badge bad" title="${esc(w.reasons.join('; '))}">${esc(t('not available'))}</span>`;
    return `<tr><td><a href="/workers#${esc(w.config.id)}">${esc(w.config.id)}</a><div class="muted">${esc(w.config.engine)}${w.config.paid ? ' · ' + esc(t('paid')) : ''}</div></td><td>${state}${w.available ? '' : `<div class="muted">${esc(w.reasons.join('; '))}</div>`}</td>`
      + `<td>${w.config.card_only ? esc(t('cards only')) : `${running}/${w.config.concurrency}`}</td><td>${windowBars(reading, nowMs)}${balance ? `<div>${balance}</div>` : ''}</td></tr>`;
  }).join('');
  return `<table><tr><th>${esc(t('Worker'))}</th><th>${esc(t('State'))}</th><th>${esc(t('Running'))}</th><th>${esc(t('Quota'))}</th></tr>${rows}</table>`;
}

/** The overview: what needs you, what is wrong, what is running, what the workers can still do. Blocks with nothing in them are left out. */
export function overviewPage(snap: Snapshot, token: string, notice?: string): string {
  const several = snap.projects.length > 1;
  const rows = snap.projects.flatMap(p => p.rows);
  const need = NEEDS_YOU.flatMap(stage => rows.filter(r => r.stage === stage));
  const problems = snap.projects.flatMap(p => [
    ...(p.error ? [{ project: p.config.id, tag: undefined as string | undefined, text: p.error, kind: 'error' }] : []),
    ...(p.tick?.problems ?? []).map(x => ({ project: p.config.id, tag: x.tag, text: x.text, kind: x.kind })),
  ]).filter((p, i, all) => p.kind !== 'quota' || all.findIndex(q => q.kind === 'quota' && q.text === p.text) === i);   // the same worker problem is seen by every project
  const running = rows.filter(r => r.stage === 'running');
  const next = snap.projects.flatMap(p => [
    ...(p.tick?.finishes ?? []).map(f => ({ project: p.config.id, text: t('record the end of run {run} of {tag}: {outcome}', f) })),
    ...(p.tick?.moves ?? []).map(m => ({ project: p.config.id, text: `${m.mode === 'card' ? t('offer a card to start') : m.mode === 'resume' ? t('resume') : t('start')} ${m.tag} ${m.mode === 'card' ? t('in') : t('with')} ${m.worker}` })),
  ]);
  const out: string[] = [];
  if (notice) out.push(`<div class="card need">${esc(notice)}</div>`);
  if (need.length) out.push(`<h2>${esc(t('Needs you'))} <span class="n">${need.length}</span></h2>${need.map(r => needCard(r, several)).join('')}`);
  if (problems.length) out.push(`<h2>${esc(t('Problems'))} <span class="n">${problems.length}</span></h2>${problems.map(p => `<div class="card problem">${p.tag ? `<a class="tag" href="${orderLink(p.project, p.tag)}">${esc(p.tag)}</a> ` : ''}${esc(p.text.replace(new RegExp(`^${p.tag ?? ''}: `), ''))}${several ? ` <span class="proj">${esc(p.project)}</span>` : ''}</div>`).join('')}`);
  if (running.length) out.push(`<h2>${esc(t('Running'))} <span class="n">${running.length}</span></h2><table>${running.map(r => `<tr><td><a class="tag" href="${orderLink(r.project, r.tag)}">${esc(r.tag)}</a>${several ? ` <span class="proj">${esc(r.project)}</span>` : ''}</td><td>${esc(r.runWorker ?? r.worker ?? '')}</td><td class="muted">${esc(runningLine(r, snap.at))}</td></tr>`).join('')}</table>`);
  if (next.length) out.push(`<h2>${esc(t('The next tick would'))} <span class="n">${next.length}</span></h2>${next.map(n => `<div class="card">${esc(n.text)}${several ? ` <span class="proj">${esc(n.project)}</span>` : ''}</div>`).join('')}`);
  const workers = workerTable(snap);
  if (workers) out.push(`<h2>${esc(t('Workers'))}</h2>${workers}${machineLine(snap)}`);
  if (snap.workersFile) {
    out.push(`<h2>${esc(t('Tick'))}</h2><form method="post" action="/tick"><input type="hidden" name="token" value="${esc(token)}"><label><input type="checkbox" name="real" value="1"> ${esc(t('really run it (start and resume workers); unchecked it only shows what it would do'))}</label> <button>${esc(t('Tick once now'))}</button></form>`);
  }
  if (!need.length && !problems.length) out.unshift(`<div class="card"><span class="badge ok">${esc(t('Nothing needs you'))}</span></div>`);
  out.push(`<h2>${esc(t('Projects'))}</h2>` + snap.projects.map(p => `<div><a href="/p/${encodeURIComponent(p.config.id)}">${esc(p.config.name)}</a> <span class="muted">${esc(t('{n} orders', { n: p.rows.length }))}</span></div>`).join(''));
  return page(t('Board'), out.join(''), { refresh: 60, projects: snap.projects.map(p => p.config), at: snap.at });
}

export function projectPage(snap: Snapshot, view: ProjectView, stage: string | undefined): string {
  const byStage = new Map<Stage, OrderRow[]>();
  for (const r of view.rows) byStage.set(r.stage, [...(byStage.get(r.stage) ?? []), r]);
  const shown = stage ? view.rows.filter(r => r.stage === stage) : [];
  const summary = STAGES.filter(s => byStage.has(s)).map(s => `<a href="/p/${encodeURIComponent(view.config.id)}?stage=${s}">${esc(s)} ${byStage.get(s)!.length}</a>`).join('');
  const list = stage
    ? `<h2>${esc(stage)} <span class="n">${shown.length}</span></h2><table>${shown.map(r => `<tr><td><a class="tag" href="${orderLink(r.project, r.tag)}">${esc(r.tag)}</a></td><td>${esc(r.title)}</td><td class="muted">${esc(r.worker ?? '')}</td><td class="muted">${esc(r.kind)}</td></tr>`).join('')}</table>`
    : '';
  return page(view.config.name, `<h2>${esc(view.config.name)} <span class="n">${view.rows.length}</span></h2><div class="stages">${summary || esc(t('No orders yet.'))}</div>${list}`, { projects: snap.projects.map(p => p.config), at: snap.at });
}

export function producerPage(snap: Snapshot, project: ProjectConfig, token?: string, showClosed = false): string {
  const policy = producerPolicy(project);
  const state = producerState(project);
  const allCases = producerCases(project);
  const cases = showClosed ? allCases : allCases.filter(c => c.status === 'open');
  const actions = producerActions(project);
  const wouldDo = producerWouldDo(project);
  const caseRows = cases.map((c: ProducerCase) => `<tr><td><b>${esc(c.trigger)}</b><div class="muted">${esc(c.id)}</div></td><td>${esc(c.status)}</td><td>${esc(c.card.stage ?? '')}</td><td>${esc(c.card.summary)}</td></tr>`).join('');
  const actionRows = actions.slice(0, 40).map(a => `<tr><td>${esc(a.kind)}</td><td>${esc(a.status)}</td><td>${esc(a.caseId)}</td><td class="muted">${esc(a.note ?? a.reason ?? '')}</td><td>${token && a.status === 'proposed' ? `<form class="inline" method="post" action="/producer/action"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="project" value="${esc(project.id)}"><input type="hidden" name="actionId" value="${esc(a.id)}"><button class="primary">${esc(t('Run'))}</button></form>` : ''}</td></tr>`).join('');
  const pause = token ? `<form method="post" action="/producer/${state.paused ? 'resume' : 'pause'}"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="project" value="${esc(project.id)}"><button class="${state.paused ? 'primary' : 'danger'}">${esc(state.paused ? t('Resume producer') : t('Pause producer'))}</button></form>` : '';
  const body = `<h2>${esc(t('Producer'))} <span class="badge${policy.enabled ? ' ok' : ''}">${esc(policy.enabled ? t('enabled') : t('disabled'))}</span> <span class="badge${state.paused ? ' bad' : ''}">${esc(state.paused ? t('paused') : t('running'))}</span> ${pause}</h2>`
    + `<div class="card"><div>${esc(t('Policy'))}: <code>${esc(policy.version)}</code></div><div class="muted">${esc(t('{n} open cases; {m} would-do actions', { n: cases.filter(c => c.status === 'open').length, m: wouldDo.length }))}</div></div>`
    + `<h2>${esc(t('Cases'))} <span class="n">${cases.length}</span></h2>${allCases.some(c => c.status === 'closed') ? `<p class="muted"><a href="/legacy/producer?project=${encodeURIComponent(project.id)}${showClosed ? '' : '&closed=1'}">${esc(showClosed ? t('Hide closed cases') : t('Show closed cases'))}</a></p>` : ''}${caseRows ? `<table><tr><th>${esc(t('Trigger'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Stage'))}</th><th>${esc(t('Summary'))}</th></tr>${caseRows}</table>` : `<div class="muted">${esc(t('No cases.'))}</div>`}`
    + `<h2>${esc(t('Actions'))} <span class="n">${actions.length}</span></h2>${actionRows ? `<table><tr><th>${esc(t('Action'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Case'))}</th><th>${esc(t('Note'))}</th><th></th></tr>${actionRows}</table>` : `<div class="muted">${esc(t('No actions.'))}</div>`}`;
  return page(`${project.name} ${t('Producer')}`, body, { projects: snap.projects.map(p => p.config), at: snap.at });
}

const eventLine = (e: OrderEvent): string => {
  const data = e.data && Object.values(e.data).some(v => v !== undefined) ? JSON.stringify(e.data) : '';
  return `<tr><td class="muted">${esc(local(e.at))}</td><td>${esc(e.type)}</td><td class="muted">${esc(e.by ?? '')}</td><td class="muted">${esc(data)}</td></tr>`;
};

export interface OrderPageInput {
  snap: Snapshot;
  project: ProjectConfig;
  doc: OrderDoc;
  stage: Stage;
  why: string;
  merged: ReadonlySet<string>;
  stageOf: (tag: string) => Stage | undefined;
  events: OrderEvent[];
  logTail: (run: Run) => string;
  token?: string;
}

interface CheckData {
  ok?: boolean; base?: string; results?: string[];
  general?: { name: string; ok: boolean; detail: string }[];
  refs?: { same: number; other: { name: string; status: string; reference?: string; got?: string; from?: string; why?: string }[] };
}

/** The last `alba check` of an order, from its events. */
function lastCheck(events: OrderEvent[]): string {
  const e = [...events].reverse().find(x => x.type === 'check');
  if (!e) return '';
  const d = (e.data ?? {}) as CheckData;
  const items = (d.general ?? []).map(g => `<tr><td><span class="badge${g.ok ? ' ok' : ' bad'}">${esc(g.ok ? 'PASS' : 'FAIL')}</span></td><td>${esc(g.name)}</td><td class="muted">${esc(g.detail)}</td></tr>`).join('');
  const refs = d.refs ? `<div class="muted">${esc(t('Reference values: {same} same; results in order: {files}', { same: d.refs.same, files: (d.results ?? []).join(', ') }))}</div>${d.refs.other.length ? `<table>${d.refs.other.map(r => `<tr><td>${esc(r.name)}</td><td><span class="badge${r.status === 'new' ? '' : ' bad'}">${esc(r.status)}</span></td><td class="muted">${esc(r.reference ?? '')} → ${esc(r.got ?? '')}</td><td class="muted">${esc(r.from ?? '')}${r.why ? ' · ' + esc(r.why) : ''}</td></tr>`).join('')}</table>` : ''}` : '';
  return `<h2>${esc(t('Last check'))}</h2><div class="card"><div class="row"><span class="badge${d.ok ? ' ok' : ' bad'}">${esc(d.ok ? t('all passed') : t('differs or failed'))}</span><span class="muted">${esc(local(e.at))}${e.by ? ' · ' + esc(e.by) : ''}</span></div><table>${items}</table>${refs}</div>`;
}

function lastVerify(events: OrderEvent[], project: string, tag: string, token?: string): string {
  const e = [...events].reverse().find(x => x.type === 'order-verified');
  const d = (e?.data ?? {}) as { ok?: boolean; results?: { name?: string; status?: string; reason?: string }[] };
  const rows = (d.results ?? []).map(r => `<tr><td><span class="badge${r.status === 'fail' ? ' bad' : r.status === 'pass' ? ' ok' : ''}">${esc(r.status ?? '')}</span></td><td>${esc(r.name ?? '')}</td><td class="muted">${esc(r.reason ?? '')}</td></tr>`).join('');
  const run = token ? `<form class="inline" method="post" action="/verify"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="project" value="${esc(project)}"><input type="hidden" name="tag" value="${esc(tag)}"><button>${esc(t('Run verification'))}</button></form>` : '';
  return `<h2>${esc(t('Acceptance gates'))}</h2><div class="card"><div class="row"><span class="badge${e && d.ok ? ' ok' : e ? ' bad' : ''}">${esc(e ? d.ok ? t('all passed') : t('differs or failed') : t('not run'))}</span>${e ? `<span class="muted">${esc(local(e.at))}</span>` : ''}${run}</div>${rows ? `<table>${rows}</table>` : ''}</div>`;
}

export function orderPage(i: OrderPageInput): string {
  const { doc, project } = i;
  const o = doc.order;
  const row = STAGES.indexOf(i.stage) + 1;
  const allowed = (['queue', 'hold', 'release', 'cancel', 'approve', 'rework'] as ActionKind[]).filter(a => actionProblem(i.stage, a) === undefined && !(a === 'approve' && ['failed', 'blocked', 'idle'].includes(i.stage)));
  const buttons = allowed.map(a => actionButton(project.id, o.tag, a, t(({ queue: 'Queue', hold: 'Hold', release: 'Release', cancel: 'Cancel order', approve: 'Approve', rework: 'Send back' } as Record<string, string>)[a]), a === 'approve' ? 'primary' : a === 'cancel' ? 'danger' : '')).join(' ')
    + (['failed', 'blocked', 'idle'].includes(i.stage) ? ` ${actionButton(project.id, o.tag, 'approve', t('Approve with override'), 'primary', true)}` : '');
  const field = (k: string, v: string | undefined) => (v ? `<tr><th>${esc(t(k))}</th><td>${esc(v)}</td></tr>` : '');
  const needs = o.needs.map(n => { const s = i.stageOf(n); return s ? `<a href="${orderLink(project.id, n)}">${esc(n)}</a> <span class="badge${s === 'merged' ? ' ok' : ''}">${esc(s)}</span>` : `${esc(n)} <span class="badge bad">${esc(t('unknown'))}</span>`; }).join(', ');
  const m = o.mandate;
  const runs = [...doc.runs].reverse().map((r, idx) => `<details${idx === 0 ? ' open' : ''}><summary><b>${esc(r.id)}</b> ${esc(r.worker)} · ${esc(local(r.started))} → ${esc(r.ended ? local(r.ended) : t('open'))} · ${esc(r.limit === 'unreachable' ? t('endpoint unreachable') : (r.outcome ?? (r.ended ? '' : t('running'))))}${r.attempt && r.attempt > 1 ? ' · ' + esc(t('attempt {n}', { n: r.attempt })) : ''}${r.imported ? ' · ' + esc(t('imported')) : ''}</summary>`
    + (r.note ? `<div class="q">${esc(t('Rework note:'))} ${esc(r.note)}</div>` : '')
    + (r.log ? `<pre>${esc(i.logTail(r) || t('(log is empty or missing)'))}</pre>` : `<div class="muted">${esc(t('No log: this run was not started by the tool.'))}</div>`) + '</details>').join('');
  const reports = [...doc.reports].reverse().map(r => `<div class="card"><div class="row"><span class="badge">${esc(r.status)}</span><span class="muted">${esc(local(r.at))}${r.run ? ' · ' + esc(r.run) : ''}${r.from ? ' · ' + esc(r.from) : ''}</span></div><div>${esc(r.summary)}</div>${r.question ? `<div class="q">${esc(r.question)}</div>` : ''}${r.commits.length ? `<div class="muted">${esc(t('commits'))}: ${esc(r.commits.join(', '))}</div>` : ''}${r.evidence.length ? `<div class="muted">${esc(t('evidence'))}: ${esc(r.evidence.join(', '))}</div>` : ''}</div>`).join('');
  const tableOfRows = STAGES.map((s, idx) => `<tr class="${s === i.stage ? 'on' : ''}"><td>${idx + 1}</td><td>${esc(s)}</td></tr>`).join('');
  const body = `<div class="row"><h2 style="margin:0">${esc(o.tag)}</h2><span>${esc(o.title)}</span><span class="badge need">${esc(i.stage)}</span><span class="proj">${esc(project.name)}</span></div>`
    + lastVerify(i.events, project.id, o.tag, i.token)
    + (buttons ? `<div class="row" style="margin-top:8px">${buttons}</div>` : '')
    + `<h2>${esc(t('Why this stage'))}</h2><div class="card">${esc(t('Row {row} of {n}: {stage}', { row, n: STAGES.length, stage: i.stage }))} — ${esc(i.why)}</div><details><summary class="muted">${esc(t('The stage table'))}</summary><table class="rows" style="width:auto">${tableOfRows}</table></details>`
    + `<h2>${esc(t('Definition'))}</h2><table style="width:auto">${field('kind', o.kind)}${field('heavy class', o.heavy)}${o.needs.length ? `<tr><th>${esc(t('needs'))}</th><td>${needs}</td></tr>` : ''}${field('condition', o.condition)}${field('worker', o.worker)}${field('branch', o.branch)}${field('worktree', o.worktree)}${field('created', local(o.created))}${field('updated', local(o.updated))}</table>`
    + (m ? `<h3>${esc(t('Mandate'))}</h3><table style="width:auto">${field('quote', m.quote)}${field('decisions', m.decisions)}${field('spend cap', m.spend_cap?.toString())}${field('protected paths', m.protected_paths?.join(', '))}</table>` : '')
    + lastCheck(i.events)
    + `<h2>${esc(t('Runs'))} <span class="n">${doc.runs.length}</span></h2>${runs || `<div class="muted">${esc(t('No runs yet.'))}</div>`}`
    + `<h2>${esc(t('Reports'))} <span class="n">${doc.reports.length}</span></h2>${reports || `<div class="muted">${esc(t('No reports yet.'))}</div>`}`
    + `<h2>${esc(t('Timeline'))} <span class="n">${i.events.length}</span></h2><table>${[...i.events].reverse().map(eventLine).join('')}</table>`;
  return page(`${o.tag} ${o.title}`, body, { projects: i.snap.projects.map(p => p.config), at: i.snap.at });
}

export function workersPage(snap: Snapshot): string {
  const file = snap.workersFile;
  if (!file) return page(t('Workers'), `<h2>${esc(t('Workers'))}</h2><div class="muted">${esc(t('No workers file was given (--workers or ALBA_WORKERS).'))}</div>`, { projects: snap.projects.map(p => p.config), at: snap.at });
  const state = new Map<string, { running: number; today: number; available: boolean; reasons: string[] }>();
  for (const p of snap.projects) for (const w of p.workers ?? []) {
    const have = state.get(w.config.id);
    state.set(w.config.id, { running: (have?.running ?? 0) + w.running, today: (have?.today ?? 0) + w.runsToday, available: w.available, reasons: w.reasons });
  }
  const rules = (rs: typeof file.workers[number]['disabled_when']) => rs.map(r => ('window_full' in r ? t('window "{name}" at {at}%', { name: r.window_full, at: r.at }) : t('balance falls by more than {n}', { n: r.balance_drop }))).join('; ');
  const registry = `<table><tr><th>${esc(t('Worker'))}</th><th>${esc(t('Engine'))}</th><th>${esc(t('State'))}</th><th>${esc(t('Today'))}</th><th>${esc(t('Limits'))}</th><th>${esc(t('Switched off when'))}</th></tr>`
    + file.workers.map(w => {
      const s = state.get(w.id);
      return `<tr id="${esc(w.id)}"><td><b>${esc(w.id)}</b><div class="muted">${esc(w.route ?? '')}</div></td><td>${esc(w.engine)}${w.paid ? ' · ' + esc(t('paid')) : ''}${w.card_only ? ' · ' + esc(t('cards only')) : ''}</td>`
        + `<td>${!w.enabled ? `<span class="badge">${esc(t('turned off'))}</span>` : s?.available === false ? `<span class="badge bad">${esc(t('not available'))}</span><div class="muted">${esc(s.reasons.join('; '))}</div>` : `<span class="badge ok">${esc(t('available'))}</span>`}</td>`
        + `<td>${s?.today ?? 0}${w.daily_runs !== undefined ? ` / ${w.daily_runs}` : ''}</td><td>${esc(t('{n} at a time', { n: w.concurrency }))}${w.capabilities.length ? '<div class="muted">' + esc(w.capabilities.join(', ')) + '</div>' : ''}</td><td class="muted">${esc(rules(w.disabled_when))}</td></tr>`;
    }).join('') + '</table>';
  const history = snap.projects.flatMap(p => p.history ?? []);
  const current = snap.projects.flatMap(p => p.quotas ?? []);
  const sources = [...new Set([...history, ...current].map(q => q.source))].filter(s => file.quota_sources[s]?.type !== 'static');
  const histories = sources.map(source => {
    const readings = [...history.filter(h => h.source === source), ...current.filter(c => c.source === source).slice(0, 1)]
      .filter((x, idx, all) => all.findIndex(y => y.at === x.at) === idx).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 24);
    return `<h3>${esc(source)}</h3><table><tr><th>${esc(t('Read'))}</th><th>${esc(t('Balance'))}</th><th>${esc(t('Windows used'))}</th></tr>${readings.map(r => `<tr><td class="muted">${esc(local(r.at))}</td><td>${esc(r.ok ? (r.balance?.raw ?? '') : r.error ?? '')}</td><td>${esc(r.windows.map(w => `${w.name} ${Math.round(w.usedPercent)}%`).join(' · '))}</td></tr>`).join('')}</table>`;
  }).join('');
  return page(t('Workers'), `<h2>${esc(t('Workers'))} <span class="n">${file.workers.length}</span></h2>${registry}<h2>${esc(t('Quota history'))}</h2>${histories || `<div class="muted">${esc(t('Nothing recorded yet. Each tick that records adds one reading.'))}</div>`}`, { projects: snap.projects.map(p => p.config), at: snap.at });
}

export function confirmPage(snap: Snapshot, input: { project: string; tag: string; action: ActionKind; token: string; title: string; stage: Stage; problem?: string; needsNote: boolean; override?: boolean }): string {
  const verbs: Record<string, string> = { queue: 'Queue', cancel: 'Cancel', hold: 'Hold', release: 'Release', approve: 'Approve', rework: 'Send back' };
  const verb = t(verbs[input.action]);
  const body = `<h2>${esc(verb)} ${esc(input.tag)}?</h2><div class="card">${esc(input.title)} <span class="badge need">${esc(input.stage)}</span></div>`
    + (input.problem ? `<div class="card bad">${esc(input.problem)}</div><a class="btn" href="${orderLink(input.project, input.tag)}">${esc(t('Back'))}</a>`
      : `<form method="post" action="/do"><input type="hidden" name="token" value="${esc(input.token)}"><input type="hidden" name="project" value="${esc(input.project)}"><input type="hidden" name="tag" value="${esc(input.tag)}"><input type="hidden" name="action" value="${esc(input.action)}">`
      + (input.action === 'approve' ? `<p class="muted">${esc(t('The branch must already be merged. The accept command runs and the accept file is written.'))}</p>` : '')
      + `<p><label>${esc(input.override ? t('Override note (required, at least 10 characters)') : input.needsNote ? t('Note for the next run (required)') : t('Note (optional)'))}<textarea name="note"${input.needsNote || input.override ? ' required' : ''}></textarea></label></p>`
      + (input.override ? '<input type="hidden" name="override" value="1">' : '')
      + `<button class="primary">${esc(t('Confirm: {verb}', { verb }))}</button> <a class="btn" href="${orderLink(input.project, input.tag)}">${esc(t('Back'))}</a></form>`);
  return page(verb, body, { projects: snap.projects.map(p => p.config), at: snap.at });
}

export function messagePage(snap: Snapshot, title: string, text: string, kind: 'ok' | 'bad' = 'ok', backHref = '/'): string {
  return page(title, `<h2>${esc(title)}</h2><${kind === 'bad' ? 'div class="card bad"' : 'pre'}>${esc(text)}</${kind === 'bad' ? 'div' : 'pre'}><p><a class="btn" href="${esc(backHref)}">${esc(t('Back'))}</a></p>`, { projects: snap.projects.map(p => p.config), at: snap.at });
}
