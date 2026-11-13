import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './api-fixture.ts';
import { agreementRecords, TRUST_STATE } from '../src/producer/trust.ts';
import { BRIEFS_STATE } from '../src/producer/briefs.ts';
import { writeStateFile } from '../src/orders/state-files.ts';
import { createChatCase, producerAct } from '../src/producer/producer.ts';
import { fixtureBrief, trustSuggestionFixture } from './fixtures/producer-trust-briefs.ts';

function fixtureOptions() {
  const base = path.resolve('.alba/producer-trust-briefs-tests'); mkdirSync(base, { recursive: true });
  const state = mkdtempSync(path.join(base, 'api-'));
  return { populate: false, project: () => ({ state_dir: state, producer: { enabled: true, rules: [{ id: 'review', action: 'accept', instruction: 'Review', mode: 'propose' }, { id: 'small', action: 'answer', instruction: 'Answer', mode: 'observe' }, { id: 'notes', action: 'note', instruction: 'Notes', mode: 'propose' }] } }) };
}

test('insights reads only stored metadata, exposes thresholds, and lists briefs newest first', async () => {
  const f = await fixture(fixtureOptions()), p = f.board.ctx.projects[0], trust = trustSuggestionFixture();
  const groups = Object.fromEntries(trust.map(r => [r.ruleId, Array.from({ length: r.decided }, (_, i) => ({ actionId: `proposal-${i}`, ruleId: r.ruleId, caseId: `case-${i}`, caseRevision: 1, proposed: 'accept', at: new Date().toISOString(), expiresAt: new Date().toISOString(), baselineSeq: 0, outcome: i === 11 ? 'rejected' : 'accepted' }))]));
  writeStateFile(p, TRUST_STATE, JSON.stringify(groups));
  const old = fixtureBrief(), latest = { ...old, id: 'newer', at: '2026-01-04T00:00:00Z' };
  writeStateFile(p, BRIEFS_STATE, JSON.stringify([old, latest]));
  f.board.hub.stop();
  const store = f.orders.store, all = store.all, events = store.events;
  store.all = () => { throw new Error('Order scan on HTTP'); }; store.events = () => { throw new Error('Event scan on HTTP'); };
  try {
    const response = await f.get(`/api/p/${p.id}/producer/insights`);
    assert.equal(response.status, 200); assert.equal(response.body.trust[0].suggestion.to, 'auto'); assert.equal(response.body.trust[1].enough, false);
    assert.equal(response.body.briefs[0].id, 'newer');
  } finally { store.all = all; store.events = events; }
  assert.equal((await f.get('/api/p/missing/producer/insights')).status, 404);
});

test('edited acceptance and rejection immediately update trust through the API', async () => {
  const f = await fixture(fixtureOptions()), p = f.board.ctx.projects[0], c = createChatCase(p, 'sample');
  const a = producerAct(p, f.orders, c.id, 'note', { note: 'original' });
  const invalid = await f.write('/api/producer/actions', { project: p.id, actionId: a.id, edit: { note: 42 } });
  assert.equal(invalid.status, 400);
  const accepted = await f.write('/api/producer/actions', { project: p.id, actionId: a.id, edit: { note: 'revised' } });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.note, 'revised'); assert.equal(agreementRecords(p).notes[0].outcome, 'edited');
  await f.write('/api/producer/actions', { project: p.id, actionId: a.id, edit: { note: 'again' } });
  assert.equal(agreementRecords(p).notes[0].outcome, 'edited');
  const b = producerAct(p, f.orders, c.id, 'note', { note: 'another' });
  await f.write('/api/producer/actions', { project: p.id, actionId: b.id, reject: true });
  assert.equal(agreementRecords(p).notes[1].outcome, 'rejected');
});
