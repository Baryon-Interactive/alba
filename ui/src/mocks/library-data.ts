// Made-up pick sets, reference board, setting cards, quote files and outside usage for the mock server (a neutral demo project).
import type { ArtRef, ArtSetting, ArtView, ExternalUsage, PickList, PickSet, SpendEntry, SpendQuote, SpendView } from '@api';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86_400_000;
const img = (path: string, exists = true) => ({ path, exists });

interface LibraryState { picks: PickSet[]; refs: ArtRef[]; settings: ArtSetting[]; quotes: SpendQuote[] }
const states = new Map<string, LibraryState>();

const fingerprint = (s: string) => s.padEnd(64, '0').slice(0, 64);

function seedPicks(): PickSet[] {
  return [
    {
      id: 'P3', title: 'Hero door style', question: 'Which door style should the first village use?', order: 'AR1', multi: false, state: 'pending', source: 'file', file: 'Docs/picks/P3.yaml', fingerprint: fingerprint('p3'), problems: [],
      options: [
        { key: 'a', label: 'Round door, wood', images: [img('art/picks/P3/a1.png'), img('art/picks/P3/a2.png')], note: 'warm, hand-made look' },
        { key: 'b', label: 'Square door, iron', images: [img('art/picks/P3/b1.png')], note: 'heavier, more guarded' },
        { key: 'c', label: 'Arched door, stone', images: [img('art/picks/P3/c1.png'), img('art/picks/P3/c2.png'), img('art/picks/P3/c3.png')] },
        { key: 'd', label: 'No door: a curtain', images: [img('art/picks/P3/d1.png', false)] },
      ],
    },
    {
      id: 'P4', title: 'Palette direction', question: 'Pick up to two palettes to try on the town square.', multi: true, state: 'pending', source: 'file', file: 'Docs/picks/P4.yaml', fingerprint: fingerprint('p4'), problems: ['"c": the picture art/picks/P4/c9.png is missing'],
      options: [
        { key: 'a', label: 'Dusk teal', images: [img('art/picks/P4/a.png')] },
        { key: 'b', label: 'Harvest orange', images: [img('art/picks/P4/b.png')] },
        { key: 'c', label: 'Washed linen', images: [img('art/picks/P4/c.png'), img('art/picks/P4/c9.png', false)] },
      ],
    },
    {
      id: 'P2', title: 'Logo lettering', question: 'Which lettering for the title screen?', order: 'UI2', multi: false, state: 'chosen', source: 'file', file: 'Docs/picks/P2.yaml', fingerprint: fingerprint('p2'), problems: [],
      options: [{ key: 'a', label: 'Brush', images: [img('art/picks/P2/a.png')] }, { key: 'b', label: 'Slab', images: [img('art/picks/P2/b.png')] }],
      choice: { choice: ['b'], note: 'reads better on small screens', at: ago(5 * 3_600_000), by: 'web', who: 'Alex', source: 'alba', stale: false },
      decisionDraft: 'Logo lettering: Slab (reads better on small screens). picks:P2',
    },
    {
      id: 'P1', title: 'Coin icon', question: 'Which coin?', multi: false, state: 'decided', source: 'file', file: 'Docs/picks/P1.yaml', fingerprint: fingerprint('p1'), problems: [], decision: 'DEC104',
      options: [{ key: 'a', label: 'Plain', images: [img('art/picks/P1/a.png')] }, { key: 'b', label: 'Starred', images: [img('art/picks/P1/b.png')] }],
      choice: { choice: ['a'], at: ago(9 * DAY), by: 'alba', source: 'alba', stale: false },
    },
  ];
}

function seedRefs(): ArtRef[] {
  const r = (id: string, title: string, work: string, tags: string[], learn: string, cached = true, extra: Partial<ArtRef> = {}): ArtRef => ({ id, image: `https://img.example.test/${id}.jpg`, page: `https://site.example.test/${id}`, title, work, tags, learn, added: ago(10 * DAY), cached, ...(cached ? { cacheFrom: 'alba' as const } : {}), problems: [], ...extra });
  return [
    r('ref-a1', 'Harbor at dusk', 'Demo Work', ['harbor', 'dusk', 'light'], 'Warm rim light against a cold sea.'),
    r('ref-a2', 'Market stalls', 'Demo Work', ['market', 'crowd'], 'How awnings break up a crowded row.'),
    r('ref-a3', 'Lantern alley', 'Other Game', ['dusk', 'alley', 'light'], 'Small light sources lead the eye.'),
    r('ref-a4', 'Cliff village', 'Other Game', ['village', 'cliff'], 'Stacked rooftops give depth.'),
    r('ref-a5', 'Stone bridge', 'Demo Work', ['bridge', 'stone'], 'Material wear at the edges.', true, { cacheFrom: 'alba' }),
    r('ref-a6', 'Fog morning', 'Third Title', ['fog', 'harbor'], 'Value steps in layers of fog.', false, { failure: 'HTTP 403 https://img.example.test/ref-a6.jpg: not a picture, or a human-check page' }),
    r('ref-a7', 'Tavern interior', 'Third Title', ['interior', 'light'], 'One warm window, everything else dark.', false),
  ];
}

const TEXT = (title: string, body: string) => `## ${title}\n\n${body}\n`;

function seedSettings(refs: ArtRef[]): ArtSetting[] {
  const cards = (ids: string[]) => refs.filter(r => ids.includes(r.id));
  return [
    {
      id: 'heroine', title: 'Heroine', kind: 'character', status: 'text-draft', standard: true, text: 'Docs/art/visual-setting.md#heroine', refs: ['ref-a1', 'ref-a3'], refCards: cards(['ref-a1', 'ref-a3']), images: [], confirmed: false, problems: [],
      body: TEXT('Heroine', 'Short silver hair, a green waxed-canvas coat with brass buttons.\nShe carries a lantern on a hooked pole; the lantern is the brightest thing in most frames.\n\n- silhouette: narrow shoulders, wide coat hem\n- palette: green, brass, one warm accent'), textSha256: fingerprint('heroine-text'),
    },
    {
      id: 'harbor', title: 'Harbor town', kind: 'place', status: 'text-approved', standard: true, text: 'Docs/art/visual-setting.md#harbor', refs: ['ref-a1', 'ref-a6'], refCards: cards(['ref-a1', 'ref-a6']), images: [], decision: 'DEC108', confirmed: true,
      confirmation: { at: ago(3 * DAY), by: 'web', who: 'Alex', note: 'the pier stays', source: 'alba', textSha256: fingerprint('harbor-text'), valid: true }, problems: [],
      body: TEXT('Harbor town', 'A fishing harbor built on stilts; walkways connect the houses.'), textSha256: fingerprint('harbor-text'),
    },
    {
      id: 'lighthouse', title: 'Lighthouse', kind: 'place', status: 'concept', standard: false, text: 'Docs/art/visual-setting.md#lighthouse', refs: ['ref-a5', 'art/settings/lighthouse/old.png'], refCards: cards(['ref-a5']), images: [img('art/settings/lighthouse/front.png'), img('art/settings/lighthouse/side.png', false)], confirmed: false,
      confirmation: { at: ago(12 * DAY), by: 'alba', source: 'alba', textSha256: fingerprint('old'), valid: false },
      problems: ['the status "concept" is not one of text-draft, text-approved, sheets, final', 'a setting whose text is a draft has pictures', '"refs" names a picture file (art/settings/lighthouse/old.png); it takes the ids of reference cards', 'the picture art/settings/lighthouse/side.png is missing', 'the text changed after it was confirmed'],
      body: TEXT('Lighthouse', 'A white tower with a red band, three storeys, a lamp room of brass and glass.'), textSha256: fingerprint('lighthouse-text'),
    },
  ];
}

function entries(base: number, rows: [string, string, number][]): SpendEntry[] {
  let wallet = base;
  return rows.map(([asset, op, credits], i) => { const before = wallet; wallet -= credits; return { at: ago((rows.length - i) * 3_600_000), asset, op, credits, before, after: wallet }; });
}

function seedQuotes(): SpendQuote[] {
  const e1 = entries(1000, [['pier', 'mesh', 50], ['pier', 'color', 15], ['lantern', 'mesh', 50], ['lantern', 'color', 15]]);
  const e2 = entries(500, [['coat', 'make', 70], ['hat', 'make', 70]]);
  e2[1] = { ...e2[1], before: 440 };      // a wallet that does not follow the line before
  return [
    { id: 'Q7', service: 'gen-a (plugin)', order: 'AR2', created: ago(2 * 3_600_000), status: 'estimate', statusKnown: true, items: 6, total: 390, estimate: { perItem: 65, total: 390, basis: 'actual billing of the last batch' }, capRequested: 400, notes: 'Standing approval for batches up to 400; stop below 150 in the wallet.', file: 'Docs/credits/Q7.yaml', fingerprint: fingerprint('q7'), state: 'pending', entries: [], spent: 0, balance: 1000, problems: [] },
    { id: 'Q6', service: 'gen-a (plugin)', order: 'AR1', created: ago(2 * DAY), status: 'exact', statusKnown: true, items: 4, total: 130, estimate: { perItem: 32.5, total: 130, basis: 'measured' }, capRequested: 150, file: 'Docs/credits/Q6.yaml', fingerprint: fingerprint('q6'), state: 'approved', approval: { cap: 150, note: 'ok', at: ago(2 * DAY), by: 'web', source: 'alba', stale: false }, entries: e1, spendFile: 'Docs/credits/Q6.spend.yaml', spent: 130, remaining: 20, balance: 870, problems: [] },
    { id: 'Q5', service: 'gen-b (cli)', order: 'AR0', created: ago(9 * DAY), status: 'unknown', statusKnown: true, items: 2, total: null, estimate: { perItem: 70, total: 140, basis: 'measured on the first batch' }, capRequested: 150, file: 'Docs/credits/Q5.yaml', fingerprint: fingerprint('q5'), state: 'approved', approval: { cap: 120, at: ago(9 * DAY), by: 'alba', source: 'alba', stale: false }, entries: e2, spendFile: 'Docs/credits/Q5.spend.yaml', spent: 140, remaining: -20, balance: 370, problems: ['Q5.spend.yaml: entries[1]: the wallet before (440) is not the one after the line before (430)', 'Q5.spend.yaml: 140 spent is over the approved cap of 120'] },
    { id: 'Q4', service: 'gen-b (cli)', order: 'AR0', created: ago(12 * DAY), status: 'unknown_pricing_contract_expired', statusKnown: true, items: 14, total: 980, estimate: { perItem: 70 }, capRequested: 980, file: 'Docs/credits/Q4.yaml', fingerprint: fingerprint('q4'), state: 'stale', approval: { cap: 980, at: ago(11 * DAY), by: 'alba', source: 'alba', stale: true }, entries: [], spent: 0, problems: [] },
  ];
}

export function libraryState(project: string): LibraryState {
  let s = states.get(project);
  if (!s) {
    const refs = seedRefs();
    s = { picks: seedPicks(), refs, settings: seedSettings(refs), quotes: seedQuotes() };
    states.set(project, s);
  }
  return s;
}

/** The mock has the library only for the first demo project. */
export const hasLibrary = (project: string): boolean => project === 'demo-platformer';

export function pickList(project: string): PickList {
  const sets = libraryState(project).picks;
  const counts = { pending: 0, chosen: 0, decided: 0, unreadable: 1 };
  for (const s of sets) counts[s.state]++;
  return { project, enabled: true, sets, unreadable: [{ file: 'Docs/picks/broken.yaml', reason: '"options" is missing or empty' }], recordProblems: [], counts };
}

export function pendingPicks(project: string) {
  return libraryState(project).picks.filter(s => s.state === 'pending').map(s => ({ id: s.id, title: s.title, ...(s.order ? { order: s.order } : {}), options: s.options.length }));
}

export function artView(project: string): ArtView {
  const s = libraryState(project);
  const counts = new Map<string, number>();
  for (const r of s.refs) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return {
    project, enabled: true, refs: s.refs, tags: [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)), settings: s.settings, compare: ['hero-v1.png', 'hero-v2.png', 'compare.yaml'],
    problems: ['settings/old.yaml: not valid YAML: Flow sequence in block collection must be sufficiently indented'],
    cache: { cached: s.refs.filter(r => r.cached).length, failures: s.refs.filter(r => r.failure).map(r => ({ id: r.id, image: r.image, reason: r.failure! })) },
  };
}

export function spendView(project: string): SpendView {
  const quotes = libraryState(project).quotes;
  return {
    project, enabled: true, quotes, unreadable: [{ file: 'Docs/credits/notes.yaml', reason: 'not a quote (no id, service, items, total or cap_requested)' }], recordProblems: [],
    counts: { quotes: quotes.length, withProblems: quotes.filter(q => q.problems.length).length, pending: quotes.filter(q => q.state === 'pending').length, approved: quotes.filter(q => q.state === 'approved').length, stale: quotes.filter(q => q.state === 'stale').length, unreadable: 1 },
  };
}

export function usageView(project: string, days: number): ExternalUsage {
  const byDay: ExternalUsage['byDay'] = [];
  const models = ['img-a-large', 'img-a-small'];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * DAY);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    models.forEach((model, j) => { const ok = ((i * 7 + j * 5) % 11) + (j === 0 ? 3 : 0); const failed = (i + j) % 4 === 0 ? 2 : 0; if (ok + failed) byDay.push({ day: key, model, ledger: 'gen', ok, failed }); });
  }
  const byModel = models.map(model => ({ model, ledger: 'gen', ok: byDay.filter(r => r.model === model).reduce((n, r) => n + r.ok, 0), failed: byDay.filter(r => r.model === model).reduce((n, r) => n + r.failed, 0) }));
  return {
    project, enabled: true, days, ledgers: [{ id: 'gen', file: 'workspace/tools/image-ledger.jsonl', ok: true, calls: 312, lines: 330, unreadable: 0, first: ago(40 * DAY), last: ago(3_600_000) }],
    byDay, byModel, total: { ok: byModel.reduce((n, m) => n + m.ok, 0), failed: byModel.reduce((n, m) => n + m.failed, 0) },
  };
}
