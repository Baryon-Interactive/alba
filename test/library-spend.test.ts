import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { sha256 } from '../src/library/files.ts';
import { approveQuote, checkSpend, spendEntries, spendView } from '../src/library/spend.ts';
import { libraryProject } from './library-helpers.ts';

const EXACT = `id: Q1
service: gen-a
order: T1
created: 2026-10-20T10:00:00+08:00
balance_at_quote: 500
quote_status: exact
items:
  - { asset: lance, ops: [make], credits: 70 }
  - { asset: blade, ops: [make], credits: 70 }
total: 140
estimate: { per_item: 70, total: 140, basis: measured }
cap_requested: 150
notes: standing approval
`;

const ESTIMATE = `id: Q2
service: gen-a (plugin)
order: T2
created: 2026-10-21T10:00:00Z
quote_status: estimate
items:
  - { asset: props, ops: [mesh 50, color 15], credits: 3120 }
total: 3120
estimate:
  per_item: 65 (rate of the earlier batch)
  basis: actual billing
cap_requested: 3000
`;

const SPEND_ENTRIES = `note: shared wallet
entries:
  - { at: 2026-10-20T16:03:37Z, asset: lance, op: make, task: t1, balance_before: 500, balance_after: 430, credits: 70 }
  - { at: 2026-10-20T16:03:40Z, asset: blade, op: make, task: t2, balance_before: 430, balance_after: 360, credits: 70, note: ok }
`;

const SPEND_JSON = JSON.stringify({
  order: 'T2', cap: 3000, initial_balance: 1000, total: 65,
  items: [
    { at: '2026-10-30T01:52:49+00:00', asset: 'p1', op: 'mesh', task: 'a', balance_before: 1000, balance_after: 950, credits: 50, status: 'succeeded', note: null },
    { at: '2026-10-30T01:55:41+00:00', asset: 'p1', op: 'color', task: 'b', balance_before: 950, balance_after: null, credits: 0, status: 'outcome_unknown', note: 'released' },
    { at: '2026-10-30T02:13:24+00:00', asset: 'p1', op: 'color_retry', task: 'c', balance_before: 940, balance_after: 935, credits: 15, status: 'succeeded' },
  ],
}, null, 2);

const SPEND_ASSETS = `order: FC1
cap: 1120
wallet_before: 1000
wallet_after: 90
spent: 140
assets:
  - { order: FC1, id: fg_a, credits: 70, note: "" }
  - { order: FC1, id: fg_b, credits: 0, note: "refused, not charged" }
  - { order: FC2, id: fg_c, credits: 70, note: "" }
`;

function setup(files: Record<string, string>) {
  return libraryProject(files, { credits: { dir: 'credits', records: 'studio-credits.jsonl' } });
}

test('both spend shapes are read: a list of entries, a JSON file with items, and a list of assets', () => {
  const a = spendEntries({ entries: [{ at: new Date('2026-10-20T16:03:37Z'), asset: 'x', credits: 5 }] });
  assert.equal(a.entries[0].at, '2026-10-20T16:03:37.000Z');
  const j = spendEntries(JSON.parse(SPEND_JSON));
  assert.equal(j.entries.length, 3);
  assert.deepEqual(j.entries[1], { at: '2026-10-30T01:55:41+00:00', asset: 'p1', op: 'color', task: 'b', before: 950, credits: 0, status: 'outcome_unknown', note: 'released' });
  const assets = spendEntries(parseYaml(SPEND_ASSETS));
  assert.deepEqual(assets.entries.map(e => [e.order, e.asset, e.credits]), [['FC1', 'fg_a', 70], ['FC1', 'fg_b', 0], ['FC2', 'fg_c', 70]]);
  assert.deepEqual(assets.declared, { spent: 140, cap: 1120 });
  assert.match(spendEntries({ nothing: 1 }).problems[0], /no list of spend lines/);
  assert.match(spendEntries({ entries: [{ asset: 'x' }, 'text'] }).problems.join(), /no amount.*not a mapping/);
});

test('the balance chain and the cap are checked and flagged, never thrown', () => {
  const ok = checkSpend(spendEntries(parseYaml(SPEND_ENTRIES)).entries, {}, 150);
  assert.deepEqual([ok.spent, ok.problems], [140, []]);
  const broken = checkSpend([
    { credits: 70, before: 500, after: 430 }, { credits: 70, before: 440, after: 370 }, { credits: 30, before: 370, after: 350 },
  ], { spent: 150 }, 100);
  assert.equal(broken.spent, 170);
  assert.equal(broken.problems.length, 4);
  assert.match(broken.problems.join('\n'), /entries\[1\]: the wallet before \(440\) is not the one after the line before \(430\)/);
  assert.match(broken.problems.join('\n'), /entries\[2\]: the wallet fell by 20, the line says 30/);
  assert.match(broken.problems.join('\n'), /file says 150 were spent; its lines add up to 170/);
  assert.match(broken.problems.join('\n'), /170 spent is over the approved cap of 100/);
});

test('shapes seen in real files: other names for the amount, a file that only has a total, a total rounded by the file, a wallet shared with other work', () => {
  assert.deepEqual(spendEntries({ items: [{ asset: 'a', credits_accounted: 150 }, { asset: 'b', credits_consumed: 20 }], total_accounted: 170 }).entries.map(e => e.credits), [150, 20]);
  const onlyTotal = spendEntries({ order: 'X', credits_consumed: 70 });
  assert.deepEqual([onlyTotal.entries.length, onlyTotal.problems, onlyTotal.declared.spent], [0, [], 70]);
  assert.equal(checkSpend(onlyTotal.entries, onlyTotal.declared).spent, 70);
  assert.equal(spendEntries({ order: 'X' }).problems.length, 1);
  const steps = spendEntries({ spend_credits: 125, steps: [{ stage: 'mesh', credits: 100 }, { stage: 'color', accounting_credits: 25 }] });
  assert.deepEqual([steps.entries.map(e => e.credits), steps.declared.spent, steps.problems], [[100, 25], 125, []]);
  const bare = spendEntries({ assets: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, status: 'rejected' })) });
  assert.deepEqual([bare.entries.length, bare.problems.length], [0, 4]);
  assert.match(bare.problems[3], /3 more lines without an amount/);
  // the file says 6.792 for lines that add up to 6.7925
  assert.deepEqual(checkSpend([{ credits: 6.1 }, { credits: 0.6925 }], { spent: 6.792 }).problems, []);
  // every line of a shared wallet differs: the first three of each kind are listed, the rest counted
  const lines = Array.from({ length: 10 }, (_, i) => ({ credits: 60, before: 1000 - i * 100, after: 940 - i * 100 - 20 }));
  const shared = checkSpend(lines, {}).problems;
  assert.equal(shared.length, 8);
  assert.match(shared[3], /7 more lines like the ones above/);
});

test('quote files: all four statuses and any other word are accepted; fingerprints; the estimate and item shapes', () => {
  const s = setup({
    'credits/Q1.yaml': EXACT, 'credits/Q1.spend.yaml': SPEND_ENTRIES,
    'credits/Q2.yaml': ESTIMATE, 'credits/Q2.spend.yaml': SPEND_JSON,
    'credits/Q3.yaml': 'id: Q3\nservice: s\norder: T3\ncreated: 2026-10-22T00:00:00Z\nquote_status: unknown\nitems:\n  - { asset: a, ops: [x], credits: null }\ntotal: null\nestimate: { per_item: 70, total: 210, basis: measured }\ncap_requested: 220\n',
    'credits/Q4.yaml': 'id: Q4\nservice: s\norder: T4\nquote_status: unknown_pricing_contract_expired\nitems: 14\nper_item: 70\ntotal: 980\ncap_requested: 980\n',
    'credits/Q5.yaml': 'id: Q5\nservice: s\norder: T5\nquote_status: guess\ntotal: 10\n',
    'credits/Q6.yaml': 'id: Q6\nservice: s\norder: T6\nquote_status: exact\nitems:\n  - { asset: a, ops: [x], credits: 10 }\ntotal: 11\n',
  });
  const view = spendView(s.project);
  const q = Object.fromEntries(view.quotes.map(x => [x.id, x]));
  assert.deepEqual(Object.keys(q).sort(), ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']);
  assert.deepEqual([q.Q1.status, q.Q1.statusKnown, q.Q1.items, q.Q1.total, q.Q1.estimate, q.Q1.capRequested], ['exact', true, 2, 140, { perItem: 70, total: 140, basis: 'measured' }, 150]);
  assert.equal(q.Q1.fingerprint, sha256(readFileSync(path.join(s.root, 'credits/Q1.yaml'))));
  assert.deepEqual([q.Q2.status, q.Q2.estimate?.perItem, q.Q2.capRequested], ['estimate', '65 (rate of the earlier batch)', 3000]);
  assert.deepEqual([q.Q3.status, q.Q3.total, q.Q3.entries.length], ['unknown', null, 0]);
  assert.deepEqual([q.Q4.status, q.Q4.statusKnown, q.Q4.items, q.Q4.estimate?.perItem], ['unknown_pricing_contract_expired', true, 14, 70]);
  assert.deepEqual([q.Q5.status, q.Q5.statusKnown], ['guess', false]);
  assert.match(q.Q5.problems[0], /"guess" is not one of/);
  assert.match(q.Q6.problems[0], /exact quote needs an amount/);
  // spend lines and totals
  assert.deepEqual([q.Q1.spent, q.Q1.balance, q.Q1.spendFile, q.Q1.problems], [140, 360, 'credits/Q1.spend.yaml', []]);
  assert.deepEqual([q.Q2.spent, q.Q2.entries.length, q.Q2.balance], [65, 3, 935]);
  assert.match(q.Q2.problems.join('\n'), /Q2.spend.yaml: entries\[2\]: the wallet fell by 5, the line says 15/);
  assert.equal(view.counts.quotes, 6);
  assert.equal(view.counts.withProblems, 3);
  assert.equal(view.counts.pending, 6);
});

test('approving records the quote\'s fingerprint and the cap; spending over the cap is flagged; a changed file needs a new approval', () => {
  const s = setup({ 'credits/Q1.yaml': EXACT, 'credits/Q1.spend.yaml': SPEND_ENTRIES });
  const fp = spendView(s.project).quotes[0].fingerprint;
  assert.throws(() => approveQuote(s.project, s.orders, 'Q1', { cap: 150, fingerprint: '0'.repeat(64) }), /changed/);
  assert.throws(() => approveQuote(s.project, s.orders, 'Q1', { cap: 0 }), /cap above 0/);
  const q = approveQuote(s.project, s.orders, 'Q1', { cap: 150, note: 'standing approval', who: 'Alex', fingerprint: fp });
  assert.deepEqual([q.state, q.approval?.cap, q.approval?.source, q.remaining], ['approved', 150, 'alba', 10]);
  assert.ok(s.orders.store.events().some(e => e.type === 'spend-approved'));
  const lower = approveQuote(s.project, s.orders, 'Q1', { cap: 100 });
  assert.match(lower.problems.join('\n'), /140 spent is over the approved cap of 100/);
  writeFileSync(path.join(s.root, 'credits/Q1.yaml'), EXACT + '# edited\n');
  const stale = spendView(s.project).quotes[0];
  assert.deepEqual([stale.state, stale.approval?.stale, stale.remaining], ['stale', true, undefined]);
});

test('the external tool\'s approvals are read only: a record of this project counts, one of another project does not', () => {
  const s = setup({ 'credits/Q1.yaml': EXACT });
  const fp = sha256(readFileSync(path.join(s.root, 'credits/Q1.yaml')));
  writeFileSync(path.join(s.dir, 'studio-credits.jsonl'), [
    JSON.stringify({ at: '2026-10-20T00:00:00Z', project: 'demo', quote: 'Q1', fingerprint: fp, cap: 140, note: 'ok', source: 'web' }),
    JSON.stringify({ at: '2026-10-21T00:00:00Z', project: 'other', quote: 'Q1', fingerprint: 'x', cap: 1 }),
    '{broken', '',
  ].join('\n'));
  const view = spendView(s.project);
  assert.deepEqual([view.quotes[0].state, view.quotes[0].approval?.source, view.quotes[0].approval?.cap], ['approved', 'external', 140]);
  assert.equal(view.recordProblems.length, 1);
});

test('files that are not quotes or cannot be read are listed with the reason; a missing folder is said; no section is off', () => {
  const s = setup({ 'credits/Q1.yaml': EXACT, 'credits/notes.yaml': 'hello: world\n', 'credits/bad.yaml': 'id: [x', 'credits/zdup.yaml': EXACT });
  const view = spendView(s.project);
  assert.equal(view.quotes.length, 1);
  assert.deepEqual(view.unreadable.map(u => u.file).sort(), ['credits/bad.yaml', 'credits/notes.yaml', 'credits/zdup.yaml']);
  assert.match(spendView(setup({}).project).unreadable[0].reason, /not there/);
  assert.equal(spendView(libraryProject({}).project).enabled, false);
});

test('an assets-shaped spend file next to a quote without an estimate block still reads', () => {
  const s = setup({ 'credits/FC1.yaml': 'id: FC1\nservice: gen-b\norder: FC1\ncreated: 2026-10-24T09:30:00+08:00\nbalance_at_quote: 1000\nitems: 14\nper_item: 70\ntotal: 980\ncap_requested: 980\n', 'credits/FC1.spend.yaml': SPEND_ASSETS });
  const q = spendView(s.project).quotes[0];
  assert.deepEqual([q.spent, q.entries.length, q.balance, q.estimate], [140, 3, 1000, { perItem: 70 }]);
  assert.deepEqual(q.problems, []);
});
