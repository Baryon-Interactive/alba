import { readStateFile } from '../src/orders/state-files.ts';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { choosePick, listPicks, sameFingerprint } from '../src/library/picks.ts';
import { sha256 } from '../src/library/files.ts';
import { validateReport } from '../src/orders/report.ts';
import { libraryProject, PNG } from './library-helpers.ts';

const SET = `id: P1
title: Door style
question: Which door?
multi: false
options:
  - { key: a, label: Round door, images: [picks/P1/a.png] }
  - { key: b, label: Square door, images: [picks/P1/b.png, picks/P1/missing.png], note: heavier }
`;

function setup(extra: Record<string, string> = {}) {
  const s = libraryProject({ 'picks/P1.yaml': SET, ...extra }, { picks: { dir: 'picks', records: 'external-picks.jsonl' } });
  s.write('picks/P1/a.png', PNG.toString('latin1'));      // option b names two pictures that are not there, on purpose
  return s;
}

test('a set in the folder is pending, with its pictures checked and a fingerprint of the file', () => {
  const s = setup();
  const list = listPicks(s.project, s.orders);
  assert.equal(list.enabled, true);
  assert.equal(list.sets.length, 1);
  const set = list.sets[0];
  assert.deepEqual([set.id, set.state, set.multi, set.source], ['P1', 'pending', false, 'file']);
  assert.equal(set.fingerprint, sha256(readFileSync(path.join(s.root, 'picks/P1.yaml'))));
  assert.deepEqual(set.options.map(o => [o.key, o.images.map(i => i.exists)]), [['a', [true]], ['b', [false, false]]]);
  assert.equal(set.problems.length, 2);
  assert.deepEqual(list.counts, { pending: 1, chosen: 0, decided: 0, unreadable: 0 });
});

test('choosing records it in the state folder with an event; the set is chosen and a decision text is offered; a file change makes the choice stale', () => {
  const s = setup();
  const fp = listPicks(s.project, s.orders).sets[0].fingerprint;
  const r = choosePick(s.project, s.orders, 'P1', { choice: ['b'], note: 'heavier is better', who: 'Alex', fingerprint: fp });
  assert.equal(r.set.state, 'chosen');
  assert.deepEqual(r.set.choice, { choice: ['b'], note: 'heavier is better', at: r.set.choice!.at, by: 'test', who: 'Alex', source: 'alba', stale: false });
  assert.equal(r.set.decisionDraft, 'Door style: Square door (heavier is better). picks:P1');
  assert.ok(s.orders.store.events().some(e => e.type === 'pick-chosen' && e.tag === '*'));
  assert.match(readStateFile(s.project, '_picks.jsonl')!, /"set":"P1".*"choice":\["b"\]/);
  // the file changes after the choice: the choice is shown, but it does not count
  appendFileSync(path.join(s.root, 'picks/P1.yaml'), '# a new option was added\n');
  const after = listPicks(s.project, s.orders).sets[0];
  assert.equal(after.state, 'pending');
  assert.equal(after.staleChoice?.stale, true);
  assert.equal(after.choice, undefined);
  // a call that read the old file is refused
  assert.throws(() => choosePick(s.project, s.orders, 'P1', { choice: ['a'], fingerprint: fp }), /changed/);
  // a decision line written into the file after the choice (what a studio does) leaves the choice as history, not as a warning
  writeFileSync(path.join(s.root, 'picks/P1.yaml'), SET.replace('multi: false\n', 'multi: false\ndecision: D7\n'));
  const decided = listPicks(s.project, s.orders).sets[0];
  assert.equal(decided.state, 'decided');
  assert.equal(decided.staleChoice, undefined);
  assert.deepEqual(decided.choice?.choice, ['b']);
});

test('single choice, known keys and a short note are enforced; multi sets take several', () => {
  const s = libraryProject({ 'picks/M.yaml': 'id: M\ntitle: Colors\nquestion: Which?\nmulti: true\noptions:\n  - { key: r, label: Red, images: [] }\n  - { key: g, label: Green, images: [] }\n' }, { picks: { dir: 'picks' } });
  assert.throws(() => choosePick(s.project, s.orders, 'M', { choice: [] }), /list of option keys/);
  assert.throws(() => choosePick(s.project, s.orders, 'M', { choice: ['x'] }), /does not have/);
  assert.throws(() => choosePick(s.project, s.orders, 'M', { choice: ['r'], note: 'x'.repeat(4001) }), /at most 4000/);
  assert.deepEqual(choosePick(s.project, s.orders, 'M', { choice: ['r', 'g'] }).set.choice?.choice, ['r', 'g']);
  const single = setup();
  assert.throws(() => choosePick(single.project, single.orders, 'P1', { choice: ['a', 'b'] }), /takes one choice/);
});

test('the external tool\'s records are read: a matching fingerprint is a choice, a different one is stale; line endings of a checkout do not matter', () => {
  const s = setup();
  const raw = readFileSync(path.join(s.root, 'picks/P1.yaml'), 'utf8');
  const rec = (sha: string, at: string) => JSON.stringify({ at, project: 'demo', set: 'P1', fingerprint: sha, choice: ['a'], note: 'from the external tool', source: 'web' });
  writeFileSync(path.join(s.dir, 'external-picks.jsonl'), [rec('0'.repeat(64), '2026-10-01T00:00:00Z'), rec(sha256(raw.replace(/\n/g, '\r\n')), '2026-10-02T00:00:00Z'), JSON.stringify({ at: '2026-10-03T00:00:00Z', project: 'other', set: 'P1', fingerprint: 'x', choice: ['b'] }), 'not json', ''].join('\n'));
  const list = listPicks(s.project, s.orders);
  assert.equal(list.sets[0].state, 'chosen');
  assert.deepEqual([list.sets[0].choice?.source, list.sets[0].choice?.choice], ['external', ['a']]);
  assert.equal(list.recordProblems.length, 1);
  assert.ok(sameFingerprint(sha256(raw.replace(/\n/g, '\r\n')), raw));
  assert.ok(!sameFingerprint('1'.repeat(64), raw));
});

test('decided: a decision field in the file, or the decisions ledger naming picks:<id>', () => {
  const s = libraryProject({ 'picks/D1.yaml': 'id: D1\ntitle: t\nquestion: q\nmulti: false\ndecision: D12\noptions:\n  - { key: a, label: A, images: [] }\n', 'picks/D2.yaml': 'id: D2\ntitle: t\nquestion: q\nmulti: false\noptions:\n  - { key: a, label: A, images: [] }\n', 'decisions.md': '| D40 | 2026-11-01 | Use door a (picks:D2) | user |\n| D41 | 2026-11-01 | Something else about picks:D22 | user |\n' },
    { picks: { dir: 'picks' }, decisions: { file: 'game/decisions.md', id_column: 1, text_column: 3, date_column: 2, source_column: 4 } });
  const states = Object.fromEntries(listPicks(s.project, s.orders).sets.map(x => [x.id, x.state]));
  assert.deepEqual(states, { D1: 'decided', D2: 'decided' });
  assert.throws(() => choosePick(s.project, s.orders, 'D2', { choice: ['a'] }), /decided already/);
});

test('files that cannot be read are listed with the reason, and the other sets still show; a missing folder is said', () => {
  const s = libraryProject({ 'picks/ok.yaml': SET, 'picks/bad.yaml': 'id: [unclosed', 'picks/noid.yaml': 'title: x\noptions: []\n', 'picks/zdup.yaml': SET, 'picks/P1.spend.yaml': 'entries: []\n' }, { picks: { dir: 'picks' } });
  const list = listPicks(s.project, s.orders);
  assert.deepEqual(list.sets.map(x => x.id), ['P1']);
  assert.equal(list.unreadable.length, 3);
  assert.deepEqual(list.unreadable.map(u => u.file).sort(), ['picks/bad.yaml', 'picks/noid.yaml', 'picks/zdup.yaml']);
  assert.equal(list.counts.unreadable, 3);
  const none = libraryProject({}, { picks: { dir: 'nowhere' } });
  assert.match(listPicks(none.project, none.orders).unreadable[0].reason, /not there/);
  const off = libraryProject({});
  assert.equal(listPicks(off.project, off.orders).enabled, false);
});

test('a worker\'s report with scope "project" is a set; choosing it answers the waiting order', () => {
  const s = libraryProject({}, {});
  const report = validateReport({ status: 'waiting', summary: 'Which stage backdrop?', question: 'Pick the backdrop', options: [{ label: 'Harbor', images: ['art/harbor.png'] }, { label: 'Market' }], scope: 'project', evidence: [], commits: [] });
  assert.equal(report.scope, 'project');
  assert.throws(() => validateReport({ status: 'waiting', summary: 's', scope: 'project' }), /needs a "question" and "options"/);
  assert.throws(() => validateReport({ status: 'waiting', summary: 's', question: 'q', options: [{ label: 'a' }, { label: 'b' }], scope: 'world' }), /"order" or "project"/);
  s.orders.add({ tag: 'T1', title: 'Backdrops', kind: 'sim' });
  s.orders.act('T1', 'queue');
  s.orders.runStart('T1', { worker: 'coder' });
  s.orders.report('T1', report);
  s.orders.runEnd('T1');
  const list = listPicks(s.project, s.orders);
  assert.equal(list.enabled, true);
  const set = list.sets[0];
  assert.match(set.id, /^T1-r\d+$/);
  assert.deepEqual([set.source, set.waitingOrder, set.state, set.options.map(o => o.key)], ['report', 'T1', 'pending', ['1', '2']]);
  const r = choosePick(s.project, s.orders, set.id, { choice: ['1'], note: 'dusk light' });
  assert.equal(r.answeredOrder, 'T1');
  assert.equal(r.set.state, 'chosen');
  const doc = s.orders.get('T1');
  assert.equal(s.orders.stage(doc).stage, 'queued');
  assert.match(doc.actions.at(-1)!.note!, /Chosen: option 1, Harbor/);
});
