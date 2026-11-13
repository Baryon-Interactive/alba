// The calls added by  (picks, art, spend, usage), answered from made-up data. State lives in src/mocks/library-data.ts.
import type { ArtSetting, PickChooseResult, SpendQuote } from '../../src/api/types.ts';
import { artView, hasLibrary, libraryState, pickList, spendView, usageView } from '../src/mocks/library-data.ts';
import type { Ctx } from './extras.ts';

const svg = (label: string, hue: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="hsl(${hue},45%,62%)"/><g fill="hsl(${(hue + 40) % 360},50%,38%)"><rect y="340" width="640" height="140"/><rect x="90" y="250" width="120" height="90" rx="8"/><rect x="330" y="210" width="150" height="130" rx="8"/></g><circle cx="540" cy="90" r="42" fill="hsl(${(hue + 180) % 360},60%,82%)"/><text x="24" y="48" font-family="sans-serif" font-size="28" fill="#fff" stroke="#000" stroke-width="0.6">${label}</text></svg>`;

export function handleLibrary(c: Ctx): boolean {
  const { path, method, body, p, res, send, fail, emit, record } = c;
  const project = p.info.id;
  if (!hasLibrary(project)) {
    if (method === 'GET' && ['picks', 'art', 'spend', 'usage'].includes(path)) return send(res, 200, { project, enabled: false, sets: [], unreadable: [], recordProblems: [], counts: { pending: 0, chosen: 0, decided: 0, unreadable: 0 }, quotes: [], refs: [], tags: [], settings: [], compare: [], problems: [], cache: { cached: 0, failures: [] }, days: 7, ledgers: [], byDay: [], byModel: [], total: { ok: 0, failed: 0 } }), true;
    return false;
  }
  const state = libraryState(project);

  if (method === 'GET' && path === 'picks') return send(res, 200, pickList(project)), true;
  if (method === 'GET' && path === 'art') return send(res, 200, artView(project)), true;
  if (method === 'GET' && path === 'spend') return send(res, 200, spendView(project)), true;
  if (method === 'GET' && path === 'usage') return send(res, 200, usageView(project, Math.min(90, Math.max(1, Number(c.url.searchParams.get('days') ?? 7) || 7)))), true;
  const ref = /^art\/ref\/([^/]+)$/.exec(path);
  if (method === 'GET' && ref) {
    const r = state.refs.find(x => x.id === decodeURIComponent(ref[1]));
    if (!r?.cached) return fail(res, 404, 'not_found', 'The picture is not fetched yet.'), true;
    res.statusCode = 200;
    res.setHeader('content-type', 'image/svg+xml');
    res.end(svg(r.title, [...r.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0)));
    return true;
  }

  const choose = /^picks\/([^/]+)\/choose$/.exec(path);
  if (method === 'POST' && choose) {
    const set = state.picks.find(s => s.id === decodeURIComponent(choose[1]));
    if (!set) return fail(res, 404, 'not_found', `There is no pick set "${choose[1]}".`), true;
    if (set.state === 'decided') return fail(res, 409, 'conflict', `"${set.id}" is decided already; it can only be looked at.`), true;
    const keys: string[] = Array.isArray(body.choice) ? body.choice : [];
    if (!keys.length || keys.some(k => !set.options.some(o => o.key === k))) return fail(res, 400, 'bad_request', '"choice" names an option that the set does not have.'), true;
    if (!set.multi && keys.length !== 1) return fail(res, 400, 'bad_request', `"${set.id}" takes one choice; ${keys.length} were given.`), true;
    set.choice = { choice: keys, ...(body.note ? { note: String(body.note) } : {}), at: new Date().toISOString(), by: 'web', ...(body.who ? { who: String(body.who) } : {}), source: 'alba', stale: false };
    delete set.staleChoice;
    set.state = 'chosen';
    set.decisionDraft = `${set.title}: ${keys.map(k => set.options.find(o => o.key === k)!.label).join(', ')}${body.note ? ` (${String(body.note)})` : ''}. picks:${set.id}`;
    record(p, '*', 'pick-chosen', 'web', { set: set.id, choice: keys });
    emit(project, 'picks.changed', { project });
    return send(res, 200, { set } satisfies PickChooseResult), true;
  }

  const setting = /^art\/settings\/([^/]+)\/approve$/.exec(path);
  if (method === 'POST' && setting) {
    const s = state.settings.find(x => x.id === decodeURIComponent(setting[1]));
    if (!s) return fail(res, 404, 'not_found', `There is no setting "${setting[1]}".`), true;
    if (body.fingerprint !== undefined && body.fingerprint !== s.textSha256) return fail(res, 409, 'conflict', `The text of "${s.id}" changed; read it again before confirming.`), true;
    s.confirmed = true;
    s.confirmation = { at: new Date().toISOString(), by: 'web', ...(body.who ? { who: String(body.who) } : {}), ...(body.note ? { note: String(body.note) } : {}), source: 'alba', textSha256: s.textSha256!, valid: true };
    s.problems = s.problems.filter(x => !/changed after it was confirmed/.test(x));
    record(p, '*', 'setting-approved', 'web', { setting: s.id });
    return send(res, 200, s satisfies ArtSetting), true;
  }

  const quote = /^spend\/([^/]+)\/approve$/.exec(path);
  if (method === 'POST' && quote) {
    const q = state.quotes.find(x => x.id === decodeURIComponent(quote[1]));
    if (!q) return fail(res, 404, 'not_found', `There is no quote file "${quote[1]}".`), true;
    if (body.fingerprint !== undefined && body.fingerprint !== q.fingerprint) return fail(res, 409, 'conflict', `The file of quote "${q.id}" changed; read it again before approving.`), true;
    const cap = Number(body.cap);
    if (!Number.isFinite(cap) || cap <= 0) return fail(res, 400, 'bad_request', 'A cap above 0 is needed.'), true;
    q.state = 'approved';
    q.approval = { cap, ...(body.note ? { note: String(body.note) } : {}), at: new Date().toISOString(), by: 'web', source: 'alba', stale: false };
    q.remaining = cap - q.spent;
    record(p, '*', 'spend-approved', 'web', { quote: q.id, cap });
    return send(res, 200, q satisfies SpendQuote), true;
  }
  return false;
}
