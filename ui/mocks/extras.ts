// The calls added by  (decisions, runs list, evidence and files, clean plan, credits, lessons, questions), answered from made-up data.
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { CleanPlan, OrderSkills, Route, SkillsView, DecisionEntry, EvidenceFile, EvidenceList, Quote, Question, RunRow } from '../../src/api/types.ts';
import { chooseWorker, rolePolicy, type Choosable } from '../../src/routing/choose.ts';
import { resolveRole, type Roles } from '../../src/roles/config.ts';
import { iso, makeWorkers, type MockOrder, type MockProject } from '../src/mocks/data.ts';

export interface Ctx {
  path: string;
  method: string;
  url: URL;
  body: any;
  p: MockProject;
  res: ServerResponse;
  send: (res: ServerResponse, status: number, body: unknown) => void;
  fail: (res: ServerResponse, status: number, code: string, message: string) => void;
  emit: (project: string, name: string, data: unknown) => void;
  record: (p: MockProject, tag: string, type: string, by?: string, data?: Record<string, unknown>) => void;
}

const demoVideo = () => readFileSync(new URL('./assets/demo.mp4', import.meta.url));

/** A picture drawn on the spot, so that any path the mock lists can be shown: the colour follows the name, the size follows the kind. */
function svgFor(path: string): string {
  let h = 0;
  for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const name = path.split('/').pop() ?? path;
  const [w, hgt] = /target|look/.test(name) ? [640, 400] : [640, 400];
  const shift = /shot|level/.test(name) ? 12 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">
<rect width="${w}" height="${hgt}" fill="hsl(${h},45%,${/dark/.test(name) ? 25 : 62}%)"/>
<g fill="hsl(${(h + 40) % 360},50%,38%)"><rect x="0" y="300" width="${w}" height="100"/><rect x="${80 + shift}" y="230" width="90" height="70" rx="6"/><rect x="${300 + shift}" y="200" width="120" height="100" rx="6"/></g>
<g fill="hsl(${(h + 180) % 360},60%,80%)"><circle cx="${520 - shift}" cy="90" r="38"/></g>
<text x="24" y="44" font-family="sans-serif" font-size="26" fill="#fff" stroke="#000" stroke-width="0.6">${name}</text></svg>`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

function evidenceOf(o: MockOrder): EvidenceFile[] {
  const out: EvidenceFile[] = [];
  const add = (path: string, from: EvidenceFile['from'], w?: number, h?: number) => {
    if (out.some(f => f.path === path)) return;
    const kind = VIDEO_EXT.test(path) ? 'video' : IMAGE_EXT.test(path) ? 'image' : 'other';
    if (kind === 'other') return;
    out.push({ path, name: path.split('/').pop()!, kind, size: kind === 'video' ? 8054 : 41_000 + path.length * 913, modified: iso((out.length + 2) * 3_600_000), from, width: kind === 'image' ? w ?? 1280 : undefined, height: kind === 'image' ? h ?? 800 : undefined });
  };
  for (const r of o.reports) for (const e of r.evidence) add(e, 'report');
  for (const f of o.def.tag === 'TR2' ? ['artifacts/evidence/TR2/target-frame.png', 'artifacts/evidence/TR2/level2-shot.png', 'artifacts/evidence/TR2/level1-shot.png', 'artifacts/evidence/TR2/walkthrough.mp4'] : []) add(f, 'folder');
  for (const q of o.questions ?? []) for (const op of q.options) for (const im of op.images) add(im, 'question');
  for (const r of o.reports) for (const op of r.options ?? []) for (const im of op.images) add(im, 'question');
  return out;
}

const MARK = '\u0001';
const MARK_END = '\u0002';

const DOCUMENTS: { path: string; title: string; group: 'docs' | 'research'; exists: boolean; bytes: number; modified?: string; headings: { level: 1 | 2 | 3; text: string; slug: string; line: number }[]; markdown?: string }[] = [
  {
    path: 'docs/gdd.md', title: 'Game design', group: 'docs', exists: true, bytes: 420, modified: iso(2 * 3600_000),
    headings: [{ level: 1, text: 'Game design', slug: 'game-design', line: 1 }, { level: 2, text: 'Movement', slug: 'movement', line: 5 }],
    markdown: '# Game design\n\nThe player walks between screens.\n\n## Movement\n\nSee [research notes](research/notes.md).\n\n![map](map.png)\n\n| Key | Does |\n| --- | --- |\n| A | left |\n\n- [x] coyote time\n',
  },
  { path: 'docs/missing.md', title: 'missing.md', group: 'docs', exists: false, bytes: 0, headings: [] },
  {
    path: 'docs/research/notes.md', title: 'Field notes', group: 'research', exists: true, bytes: 90, modified: iso(26 * 3600_000),
    headings: [{ level: 1, text: 'Field notes', slug: 'field-notes', line: 1 }],
    markdown: '# Field notes\n\nPlayers expect the jump to forgive a late press.\n',
  },
];

function documents(c: Ctx): boolean {
  const { path, url, res, send, fail, p } = c;
  if (path === 'docs') {
    const items = DOCUMENTS.map(doc => ({ path: doc.path, title: doc.title, group: doc.group, exists: doc.exists, bytes: doc.bytes, modified: doc.modified, headings: doc.headings }));
    return send(res, 200, { project: p.info.id, enabled: true, items }), true;
  }
  const file = url.searchParams.get('path') ?? '';
  if (path === 'docs/file') {
    if (!file) return fail(res, 400, 'bad_request', '"path" is required'), true;
    const doc = DOCUMENTS.find(d => d.path === file);
    if (!doc) return fail(res, 403, 'forbidden', `${file} is not a document this project lists, so it is not read.`), true;
    if (!doc.exists || !doc.markdown) return fail(res, 404, 'not_found', `No document ${file}.`), true;
    return send(res, 200, { project: p.info.id, path: doc.path, title: doc.title, group: doc.group, headings: doc.headings, markdown: doc.markdown }), true;
  }
  if (path !== 'docs/search') return false;
  const q = url.searchParams.get('q') ?? '';
  if (q.length >= 200) return fail(res, 400, 'bad_request', 'A search of 200 characters or more is refused.'), true;
  const needle = q.trim().toLowerCase();
  const items: { path: string; title: string; heading: { text: string; slug: string }; line: number; snippet: string }[] = [];
  if (needle) {
    for (const doc of DOCUMENTS) {
      if (!doc.markdown) continue;
      const lines = doc.markdown.split('\n');
      for (let i = 0; i < lines.length && items.length < 30; i++) {
        const line = lines[i] ?? '';
        const at = line.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const heading = [...doc.headings].reverse().find(h => h.line <= i + 1);
        const start = Math.max(0, at - 60);
        const end = Math.min(line.length, at + needle.length + 60);
        const snippet = `${start > 0 ? '…' : ''}${line.slice(start, at)}${MARK}${line.slice(at, at + needle.length)}${MARK_END}${line.slice(at + needle.length, end)}${end < line.length ? '…' : ''}`;
        items.push({ path: doc.path, title: doc.title, heading: heading ? { text: heading.text, slug: heading.slug } : { text: doc.title, slug: '' }, line: i + 1, snippet });
      }
    }
  }
  return send(res, 200, { project: p.info.id, q, count: items.length, items }), true;
}

/** The mock's routing: two worker groups and three routes, resolved as `effectiveRoles` would (a group gives prefer and only). */
const GROUPS = { main: ['codex', 'codex-gpu', 'opencode-build'], art: ['claude-card', '*'] };
const ROLES: Roles = {
  builder: { description: 'Build, edit and verify the project', kinds: ['gameplay', 'systems', 'tools', 'ui', 'build'], requires: ['shell', 'edit', 'git'], group: 'main', workers: { prefer: GROUPS.main, only: GROUPS.main, avoid: ['grok'] }, sources: {} },
  visual: { description: 'Review and prepare artwork', kinds: ['art'], requires: ['vision'], group: 'art', workers: { prefer: ['claude-card'], avoid: ['grok'] }, sources: {} },
  default: { description: 'General project work', requires: ['shell'], group: 'main', workers: { prefer: GROUPS.main, only: GROUPS.main, avoid: ['grok'] }, sources: {} },
};
function supplyOf(p: MockProject): Choosable[] {
  return makeWorkers(p).map(w => ({
    config: { id: w.id, engine: w.engine, paid: w.paid, cost: w.cost, capabilities: w.capabilities, aliases: w.aliases, model_family: w.modelFamily, concurrency: w.concurrency, daily_runs: w.dailyRuns, enabled: w.enabled, card_only: w.cardOnly, disabled_when: [] },
    available: w.available, reasons: w.reasons, running: w.running, runsToday: w.runsToday, startable: w.hasLaunch || w.cardOnly, overCap: w.overCap,
  }));
}

/** Use the same role eligibility and ranking as the real server. */
function routeOf(p: MockProject, o: MockOrder): Route {
  const kind = o.def.kind;
  const role = resolveRole(ROLES, o.def);
  const choice = chooseWorker({ kind, tags: o.def.tags ?? [], workerText: o.def.worker, role: rolePolicy(role) }, supplyOf(p));
  const byModel = o.def.tag === 'CH1';
  return {
    project: p.info.id, tag: o.def.tag,
    routing: { kind, tags: o.def.tags ?? [], source: byModel ? 'model' : 'rules', why: byModel ? 'the classifier worker read the order text' : `matched ${kind}`, at: iso(3_600_000) },
    ...choice, role, why: `role ${role.id ?? 'none'} (${role.source}); ${choice.why}`,
  };
}

/** The skills of the mock: the tool's own, some of the machine (two made for other engines) and one of the project's own. */
const SKILLS = [
  { name: 'alba-worker-rules', description: 'How a worker started by alba must work and report.', tags: ['alba', 'core'], source: 'core', dir: 'templates/skills/alba-worker-rules', files: 1, bytes: 2100, layers: ['core' as const], scope: 'global' as const, engines: [] as string[], core: true },
  { name: 'ui-style', description: 'Layout and wording rules of the game UI.', tags: ['ui'], source: 'shared', dir: '~/skills/ui-style', files: 2, bytes: 2800, layers: ['order' as const], scope: 'global' as const, engines: [] as string[], core: false },
  { name: 'commit-style', description: 'Small commits with a clear subject.', tags: ['git'], source: 'shared', dir: '~/skills/commit-style', files: 3, bytes: 3500, layers: ['project' as const], scope: 'global' as const, engines: [] as string[], core: false },
  { name: 'unreal-build', description: 'Build and package an Unreal project from the command line.', tags: ['build'], source: 'gamedev', dir: '~/gamedev-skills/unreal/unreal-build', files: 4, bytes: 5200, layers: [] as never[], scope: 'global' as const, engines: ['unreal'], core: false },
  { name: 'unity-ui-toolkit', description: 'UI Toolkit layouts and USS for Unity.', tags: ['ui'], source: 'gamedev', dir: '~/gamedev-skills/unity/unity-ui-toolkit', files: 6, bytes: 9100, layers: [] as never[], scope: 'global' as const, engines: ['unity'], core: false },
  { name: 'godot-scenes', description: 'Scene and node conventions for Godot 4.', tags: ['scenes'], source: 'gamedev', dir: '~/gamedev-skills/godot/godot-scenes', files: 3, bytes: 4000, layers: [] as never[], scope: 'global' as const, engines: ['godot'], core: false },
  { name: 'house-style', description: "The project's own naming and folder rules.", tags: ['style'], source: 'own', dir: 'game/skills/house-style', files: 1, bytes: 1200, layers: [] as never[], scope: 'project' as const, engines: [] as string[], core: false },
];
const skillStates = new Map<string, { engine: string; include: Set<string>; exclude: Set<string> }>();
const skillState = (project: string) => skillStates.get(project) ?? skillStates.set(project, { engine: 'unreal', include: new Set(), exclude: new Set() }).get(project)!;

export function handleExtras(c: Ctx): boolean {
  const { path, method, url, body, p, res, send, fail, emit, record } = c;

  if (path === 'roles' && method === 'GET') {
    const supply = supplyOf(p);
    return send(res, 200, { roles: Object.entries(ROLES).map(([id, role]) => {
      const candidates = chooseWorker({ kind: '', tags: [], role: { id, requires: role.requires, ...role.workers, group: role.group } }, supply).candidates;
      return { id, ...role, candidates, qualifying: candidates.filter(c => c.verdict === 'chosen' || c.verdict === 'passed-over').map(c => c.worker), results: [] };
    }), groups: Object.entries(GROUPS).map(([name, members]) => ({ name, list: members, members, routes: Object.entries(ROLES).filter(([, r]) => r.group === name).map(([id]) => id), source: 'workers' as const })) }), true;
  }
  const roleEdit = /^orders\/([^/]+)\/role$/.exec(path);
  if (roleEdit && method === 'POST') {
    const o = p.orders.get(decodeURIComponent(roleEdit[1]!));
    if (!o) return fail(res, 404, 'not_found', 'no such order'), true;
    if (body.role && !Object.hasOwn(ROLES, body.role)) return fail(res, 400, 'bad_request', 'Unknown role'), true;
    o.def.role = body.role || undefined;
    record(p, o.def.tag, 'order-updated', 'web', { role: o.def.role });
    return send(res, 200, routeOf(p, o)), true;
  }

  if (path === 'files') {
    const file = url.searchParams.get('path') ?? '';
    if (file.includes('..')) return fail(res, 403, 'forbidden', 'the path leaves the project'), true;
    if (VIDEO_EXT.test(file)) {
      const data = demoVideo();
      res.statusCode = 200;
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-length', data.length);
      res.end(data);
      return true;
    }
    if (!IMAGE_EXT.test(file)) return fail(res, 403, 'forbidden', 'only image and video files are served'), true;
    res.statusCode = 200;
    res.setHeader('content-type', 'image/svg+xml');
    res.end(svgFor(file));
    return true;
  }

  if (path === 'runs' && method === 'GET') {
    const worker = url.searchParams.get('worker');
    const since = url.searchParams.get('since');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
    const all: RunRow[] = [...p.orders.values()].flatMap(o => o.runs.map(r => ({ ...r, project: p.info.id, tag: o.def.tag, title: o.def.title, stage: o.stage })))
      .filter(r => (!worker || r.worker === worker) && (!since || r.started >= since))
      .sort((a, b) => b.started.localeCompare(a.started) || a.key.localeCompare(b.key));
    const start = Number(url.searchParams.get('cursor') ?? 0) || 0;
    const items = all.slice(start, start + limit);
    return send(res, 200, { project: p.info.id, count: items.length, items, next: start + limit < all.length ? String(start + limit) : undefined }), true;
  }

  if (path === 'decisions') {
    if (method === 'POST') {
      const text = String(body.text ?? '').trim();
      if (!text) return fail(res, 400, 'bad_request', 'text is required'), true;
      if (!body.default && !String(body.source ?? '').trim()) return fail(res, 400, 'bad_request', 'a decision needs its source: the user\'s words, or default: true'), true;
      const number = body.id ? Number(String(body.id).replace(/\D/g, '')) : (p.decisions.at(-1)?.number ?? 100) + 1;
      if (p.decisions.some(d => d.number === number)) return fail(res, 409, 'conflict', `DEC${number} exists already`), true;
      if (number >= 140 && number <= 149) return fail(res, 409, 'conflict', `DEC${number} falls in the range DEC140-DEC149 reserved on AU2`), true;
      const d: DecisionEntry = { id: `DEC${number}`, number, date: body.date ?? new Date().toISOString().slice(0, 10), text, source: body.default ? 'default' : String(body.source).trim(), sourceKind: body.default ? 'default' : 'quote', by: 'web', at: new Date().toISOString() };
      p.decisions.push(d);
      record(p, '', 'decision', 'web', { id: d.id });
      emit(p.info.id, 'decision.added', { id: p.events.length, at: d.at, tag: '', type: 'decision', by: 'web', project: p.info.id, data: { id: d.id } });
      return send(res, 201, d), true;
    }
    const reserved = [{ tag: 'AU2', range: [140, 149] as [number, number] }];
    const topics = [...new Set(p.decisions.map(d => d.topic).filter((x): x is string => !!x))];
    const duplicates = topics.includes('Menus') ? [{ id: 'DEC103', topics: ['Controls', 'Menus'] }] : [];
    return send(res, 200, { project: p.info.id, count: p.decisions.length, items: p.decisions, topics, duplicates, reviewerRange: [150, 199], next: `DEC${(p.decisions.at(-1)?.number ?? 100) + 1}`, reserved }), true;
  }

  const routed = /^orders\/([^/]+)\/(route|classify)$/.exec(path);
  if (routed) {
    const o = p.orders.get(decodeURIComponent(routed[1]));
    if (!o) return fail(res, 404, 'not-found', `no order ${routed[1]}`), true;
    return send(res, 200, routeOf(p, o)), true;
  }
  const skilled = /^orders\/([^/]+)\/skills$/.exec(path);
  if (skilled) {
    const o = p.orders.get(decodeURIComponent(skilled[1]));
    if (!o) return fail(res, 404, 'not-found', `no order ${skilled[1]}`), true;
    const tags = o.def.tags ?? [];
    const skills: OrderSkills['skills'] = [{ name: 'alba-worker-rules', description: 'How a worker started by alba must work and report.', layer: 'core', why: 'always', path: '.agents/skills/alba-worker-rules/SKILL.md' }];
    if (tags.includes('ui')) skills.push({ name: 'ui-style', description: 'Layout and wording rules of the game UI.', layer: 'order', why: 'tag ui', path: '.agents/skills/ui-style/SKILL.md' });
    skills.push({ name: 'commit-style', description: 'Small commits with a clear subject.', layer: 'project', why: `kind ${o.def.kind}`, path: '.agents/skills/commit-style/SKILL.md' });
    const body: OrderSkills = {
      project: p.info.id, tag: o.def.tag, skills, mountedAt: ['.agents/skills'],
      suggestions: o.def.tag === 'TR2' ? [{ path: 'ui-style/SKILL.md', reason: 'The grid size changed to 32 px; the skill still says 16.', run: 'r1', at: iso(3_600_000) }] : [],
    };
    return send(res, 200, body), true;
  }
  if (path === 'skills/use' && method === 'POST') {
    const name = String(body.name ?? '');
    const skill = SKILLS.find(s => s.name === name);
    if (!skill) return fail(res, 404, 'not_found', `No skill "${name}".`), true;
    if (typeof body.use !== 'boolean') return fail(res, 400, 'bad_request', '"use" must be true or false.'), true;
    const st = skillState(p.info.id);
    if (skill.scope === 'project' || skill.core) return fail(res, 400, 'bad_request', `${name} is the tool's own or one of the project's own skills: it is not filtered.`), true;
    const before = JSON.stringify([[...st.include], [...st.exclude]]);
    if (body.use) { st.exclude.delete(name); if (skill.engines.length && !skill.engines.includes(st.engine)) st.include.add(name); } else { st.exclude.add(name); st.include.delete(name); }
    const changed = before === JSON.stringify([[...st.include], [...st.exclude]]) ? [] : ['skills.include', 'skills.exclude'];
    record(p, '*', 'skills.edited', 'web', { skill: name, use: body.use });
    return send(res, 200, { ok: true, file: '/projects/demo/alba.yaml', changed, backup: '/projects/demo/alba.yaml.bak-20260101-100000' }), true;
  }
  if (path === 'skills') {
    const st = skillState(p.info.id);
    const views = SKILLS.map(s => {
      const excluded = st.exclude.has(s.name), included = st.include.has(s.name);
      const wrongEngine = s.scope === 'global' && !s.core && s.engines.length > 0 && !s.engines.includes(st.engine) && !included;
      const applicable = s.scope === 'project' || s.core || (!excluded && !wrongEngine);
      const inapplicable = applicable ? undefined : excluded ? 'excluded by name' : `for ${s.engines.join('/')}, the project is ${st.engine}`;
      const { core: _core, ...rest } = s;
      return { ...rest, applicable, ...(inapplicable ? { inapplicable } : {}), included, excluded, usedBy: { orders: s.name === 'ui-style' ? [...p.orders.values()].filter(o => o.def.tags?.includes('ui')).map(o => o.def.tag) : [], workers: s.name === 'commit-style' ? ['codex', 'opencode'] : [] } };
    });
    const body: SkillsView = {
      project: p.info.id, engine: st.engine, skills: views, include: [...st.include], exclude: [...st.exclude],
      sources: [
        { id: 'core', dir: 'templates/skills', exists: true, count: 1, tags: ['core'], scope: 'global' },
        { id: 'shared', dir: '~/skills', exists: true, count: 2, tags: [], scope: 'global' },
        { id: 'gamedev', dir: '~/gamedev-skills', exists: true, count: 3, tags: [], scope: 'global' },
        { id: 'own', dir: 'game/skills', exists: true, count: 1, tags: [], scope: 'project' },
        { id: 'old', dir: '~/skills-old', exists: false, count: 0, tags: [], problem: 'the folder does not exist', scope: 'global' },
      ],
      always: ['commit-style'], byKind: { ui: ['ui-style'] },
      mounts: [{ worker: 'codex', engine: 'codex', mounts: ['.agents/skills'] }, { worker: 'opencode', engine: 'opencode', mounts: ['.opencode/skills'] }, { worker: 'claude-card', engine: 'claude', mounts: [] }],
      problems: ['skill source old: ~/skills-old does not exist.'],
    };
    return send(res, 200, body), true;
  }
  if (path === 'skills-old') {
    const names = ['alba-worker-rules', 'ui-style', 'commit-style'];
    const descriptions = ['How a worker started by alba must work and report.', 'Layout and wording rules of the game UI.', 'Small commits with a clear subject.'];
    const body: SkillsView = {
      project: p.info.id,
      sources: [
        { id: 'core', dir: 'templates/skills', exists: true, count: 1, tags: ['core'], scope: 'global' },
        { id: 'shared', dir: '~/skills', exists: true, count: 2, tags: [], scope: 'global' },
        { id: 'old', dir: '~/skills-old', exists: false, count: 0, tags: [], problem: 'the folder does not exist', scope: 'global' },
      ],
      skills: names.map((n, i) => ({
        name: n, description: descriptions[i], tags: i === 0 ? ['alba', 'core'] : i === 1 ? ['ui'] : ['git'],
        source: i === 0 ? 'core' : 'shared', dir: `${i === 0 ? 'templates/skills' : '~/skills'}/${n}`, files: 1 + i, bytes: 2100 + i * 700,
        layers: i === 0 ? ['core' as const] : i === 1 ? ['order' as const] : ['project' as const],
        scope: 'global' as const, engines: [] as string[], applicable: true, included: false, excluded: false,
        usedBy: { orders: i === 1 ? [...p.orders.values()].filter(o => o.def.tags?.includes('ui')).map(o => o.def.tag) : [], workers: i === 2 ? ['codex', 'opencode'] : [] },
      })),
      always: ['commit-style'], byKind: { ui: ['ui-style'] }, include: [], exclude: [],
      mounts: [{ worker: 'codex', engine: 'codex', mounts: ['.agents/skills'] }, { worker: 'opencode', engine: 'opencode', mounts: ['.opencode/skills'] }, { worker: 'claude-card', engine: 'claude', mounts: [] }],
      problems: ['skill source old: ~/skills-old does not exist.'],
    };
    return send(res, 200, body), true;
  }

  if (path === 'lessons') {
    const tag = url.searchParams.get('tag');
    const open = [...p.orders.values()].filter(o => o.stage !== 'merged' && o.stage !== 'cancelled');
    const all = p.lessons.map(l => ({ ...l, orders: l.appliesToProject ? open.filter(o => (o.def.tags ?? []).some(x => l.tags.includes(x))).map(o => o.def.tag) : [] }));
    const base = url.searchParams.get('applies') === '1' ? all.filter(l => l.appliesToProject) : all;
    const items = tag ? base.filter(l => l.tags.includes(tag)) : base;
    return send(res, 200, { project: p.info.id, count: items.length, items }), true;
  }

  if (path === 'credits') {
    const status = url.searchParams.get('status');
    const items = [...p.orders.values()].flatMap(o => o.quotes ?? []).filter(q => !status || q.status === status);
    return send(res, 200, { project: p.info.id, count: items.length, items }), true;
  }

  if (path === 'events') {
    const tag = url.searchParams.get('tag');
    const events = p.events.filter(e => !tag || e.tag === tag).slice(-Number(url.searchParams.get('limit') ?? 200));
    return send(res, 200, { events }), true;
  }

  if (path === 'clean') {
    const plan: CleanPlan = {
      project: p.info.id, at: new Date().toISOString(), errors: p.info.id === 'demo-platformer' ? ['the process list could not be read; worktrees are only removed when no run is recorded as alive'] : [],
      items: [
        { kind: 'worktree', path: '../worktrees/mv3', branch: 'order/mv3', tag: 'MV3', action: 'remove', reason: 'merged 5 days ago, worktree clean, idle for 120 h', targets: [], links: 1, bytes: 1_840_000_000 },
        { kind: 'worktree', path: '../worktrees/sc1', branch: 'order/sc1', tag: 'SC1', action: 'remove', reason: 'merged 8 days ago, worktree clean, idle for 190 h', targets: [], links: 0, bytes: 412_000_000 },
        { kind: 'worktree', path: '../worktrees/tr2', branch: 'order/tr2', tag: 'TR2', action: 'prune', reason: 'not merged: only the listed caches are deleted', targets: ['Library/ShaderCache', 'Saved/Logs'], links: 0, bytes: 96_000_000 },
        { kind: 'build', path: 'builds/win64-0.3.1', action: 'delete', reason: 'older than the newest 2 builds', targets: [], links: 0, bytes: 2_310_000_000 },
        { kind: 'build', path: 'builds/win64-0.3.4', action: 'keep', reason: 'one of the newest 2 builds', targets: [], links: 0 },
        { kind: 'worktree', path: '../worktrees/mv4', branch: 'order/mv4', tag: 'MV4', action: 'skip', reason: 'a run is alive (pid 18232)', targets: [], links: 0 },
        { kind: 'worktree', path: '../worktrees/au1', branch: 'order/au1', tag: 'AU1', action: 'keep', reason: 'not merged: waiting for review', targets: [], links: 0 },
        { kind: 'worktree', path: '../worktrees/ui3', branch: 'order/ui3', tag: 'UI3', action: 'skip', reason: 'the worktree has uncommitted files', targets: [], links: 0 },
      ],
    };
    return send(res, 200, plan), true;
  }

  const m = /^orders\/([^/]+)\/(evidence|questions\/([^/]+)\/answer|quotes\/([^/]+)\/(approve|reject))$/.exec(path);
  if (m) {
    const o = p.orders.get(decodeURIComponent(m[1]!));
    if (!o) return fail(res, 404, 'not_found', 'no such order'), true;
    if (m[2] === 'evidence') {
      const list: EvidenceList = { project: p.info.id, tag: o.def.tag, files: evidenceOf(o), folders: [`artifacts/evidence/${o.def.tag}`] };
      return send(res, 200, list), true;
    }
    if (m[3]) {
      const q: Question | undefined = o.questions?.find(x => x.id === decodeURIComponent(m[3]!));
      if (!q) return fail(res, 404, 'not_found', 'no such question'), true;
      if (q.answered) return fail(res, 409, 'conflict', 'the question is answered already'), true;
      const choice = Number(body.choice);
      if (!q.options[choice - 1]) return fail(res, 400, 'bad_request', `the question has no option ${choice}`), true;
      q.answered = { choice: [String(choice)], note: body.note, by: 'web', who: body.who, at: new Date().toISOString() };
      record(p, o.def.tag, 'question-answered', 'web', { id: q.id, choice });
      emit(p.info.id, 'question.answered', { id: p.events.length, at: q.answered.at, tag: o.def.tag, type: 'question-answered', by: 'web', project: p.info.id });
      return send(res, 200, q), true;
    }
    const quote: Quote | undefined = o.quotes?.find(x => x.id === decodeURIComponent(m[4]!));
    if (!quote) return fail(res, 404, 'not_found', 'no such quote'), true;
    if (quote.status !== 'pending') return fail(res, 409, 'conflict', `the quote is ${quote.status} already`), true;
    if (m[5] === 'approve') {
      const cap = Number(body.cap);
      if (!(cap > 0)) return fail(res, 400, 'bad_request', 'cap must be a positive number'), true;
      quote.status = 'approved';
      quote.approval = { cap, note: body.note, by: 'web', at: new Date().toISOString() };
      quote.remaining = cap - quote.spent;
    } else {
      quote.status = 'rejected';
      quote.approval = body.note ? { cap: 0, note: body.note, by: 'web', at: new Date().toISOString() } : undefined;
    }
    record(p, o.def.tag, `quote-${m[5]}`, 'web', { id: quote.id });
    emit(p.info.id, 'credits.changed', { id: p.events.length, at: new Date().toISOString(), tag: o.def.tag, type: `quote-${m[5]}`, by: 'web', project: p.info.id });
    return send(res, 200, quote), true;
  }

  if (path === 'docs' || path === 'docs/file' || path === 'docs/search') return documents(c);
  return false;
}
