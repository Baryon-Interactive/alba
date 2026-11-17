import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Orders } from '../src/orders/service.ts';
import { stateStore } from '../src/orders/backend.ts';
import { computeFirstPassStats, formatFirstPassStats } from '../src/review/first-pass-stats.ts';
import type { FirstPassVerdict } from '../src/review/first-pass.ts';
import { alba, projectDir } from './cli-helper.ts';
import { fixture as apiFixture } from './api-fixture.ts';
import { tempOrders } from './helpers.ts';
import { loadProject, validateProject } from './state-helper.ts';

const passVerdict: FirstPassVerdict = {
  verdict: 'pass',
  confident: true,
  items: [{ item: 'Scene renders', verdict: 'pass', evidence: 'day.png shows lit scene.' }],
  summary: 'All items pass.',
};

const sendBackVerdict: FirstPassVerdict = {
  verdict: 'send-back',
  confident: true,
  items: [{ item: 'Scene renders', verdict: 'fail', evidence: 'day.png is blank.' }],
  note: 'Initialize the camera before capturing day.png so the scene is visible.',
  summary: 'Capture is blank.',
};

const unsureVerdict: FirstPassVerdict = {
  verdict: 'unsure',
  confident: false,
  items: [{ item: 'Scene renders', verdict: 'doubt', evidence: 'No screenshot available.' }],
  summary: 'Inconclusive.',
};

test('computeFirstPassStats: counts, agreement rate, medians, under-10 "not enough cases", and excluded bounce action', t => {
  const { dir } = tempOrders();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = projectDir(dir);
  const project = validateProject({
    id: 'demo',
    name: 'Demo',
    root: dir,
    work_orders: path.join(dir, 'orders'),
    state_dir: path.join(dir, 'state'),
  }, file);

  const baseMs = Date.now() - 2 * 86_400_000;
  let currentMs = baseMs;
  const orders = new Orders(stateStore(project), () => new Date(currentMs).toISOString());

  const addReviewedCase = (
    index: number,
    opts: {
      family: string;
      kind: string;
      verdict: FirstPassVerdict;
      leadAction?: 'approve' | 'rework' | 'cancel';
      applied?: boolean;
      disputed?: boolean;
      reportToVerdictMin: number;
      verdictToDecisionMin?: number;
    },
  ) => {
    const tag = `T${index}`;
    writeFileSync(path.join(dir, 'orders', `${tag}.md`), `# ${tag}\n\n## Acceptance\n- Scene renders.\n`, 'utf8');
    orders.add({ tag, title: `Task ${index}`, kind: opts.kind });
    orders.act(tag, 'queue');
    orders.runStart(tag, { worker: 'gpt-worker' });
    orders.runEnd(tag);

    const reportMs = baseMs + index * 120_000;
    currentMs = reportMs;
    const { report } = orders.report(tag, { status: 'ready', summary: 'Ready', evidence: [], commits: ['abc1234'] });

    const startMs = reportMs + 60_000;
    const endMs = reportMs + opts.reportToVerdictMin * 60_000;
    currentMs = endMs;
    const fpId = `fp-${tag}`;
    let appliedSeq: number | undefined;
    if (opts.applied) {
      orders.act(tag, 'rework', { note: `First-pass review by rev (${opts.family}): ${sendBackVerdict.note}` });
      appliedSeq = orders.get(tag).actions.at(-1)!.seq;
    }
    orders.record(tag, 'first-pass', {
      id: fpId,
      tag,
      report: report.seq,
      fingerprint: `fp-${tag}`,
      commit: 'abc1234',
      worker: `${opts.family}-reviewer`,
      model_family: opts.family,
      delivering_worker: 'gpt-worker',
      delivering_family: 'gpt',
      status: 'done',
      started: new Date(startMs).toISOString(),
      ended: new Date(endMs).toISOString(),
      verdict: opts.verdict,
      ...(opts.applied ? { applied: true } : {}),
      reason: opts.verdict.summary,
    });
    if (opts.applied && appliedSeq !== undefined) {
      orders.record(tag, 'first-pass-applied', { id: fpId, report: report.seq, action: appliedSeq });
    }
    if (opts.disputed) {
      currentMs = endMs + 120_000;
      orders.record(tag, 'first-pass-disputed', { id: fpId, report: report.seq, note: 'This send-back was wrong because the skybox is dark by design.' });
    }
    if (opts.leadAction) {
      currentMs = endMs + (opts.verdictToDecisionMin ?? 10) * 60_000;
      if (opts.leadAction === 'approve') {
        orders.act(tag, 'approve', { note: 'Approved by lead after inspection.', ...(opts.applied ? { override: true } : {}) });
      } else if (opts.leadAction === 'rework') {
        orders.act(tag, 'rework', { note: 'Lead confirms rework needed.' });
      } else {
        orders.act(tag, 'cancel', { note: 'Cancelled by lead.' });
      }
    }
  };

  // Family `gemini`, kind `code`: only 4 decided cases (< 10) -> "not enough cases"
  for (let i = 1; i <= 4; i++) {
    addReviewedCase(i, {
      family: 'gemini',
      kind: 'code',
      verdict: passVerdict,
      leadAction: i <= 3 ? 'approve' : 'rework',
      reportToVerdictMin: 2,
      verdictToDecisionMin: 8,
    });
  }

  // Family `claude`, kind `visual`:
  // 8 pass -> approve (agree)
  // 2 send-back -> rework (agree)
  // 1 pass -> rework (disagree)
  // 1 send-back -> approve (disagree)
  // 1 unsure -> approve (counted apart in unsure)
  // 1 applied bounce with no lead action on that report (not counted as decided; disputed = 1)
  for (let i = 10; i < 18; i++) {
    addReviewedCase(i, { family: 'claude', kind: 'visual', verdict: passVerdict, leadAction: 'approve', reportToVerdictMin: 4, verdictToDecisionMin: 12 });
  }
  for (let i = 18; i < 20; i++) {
    addReviewedCase(i, { family: 'claude', kind: 'visual', verdict: sendBackVerdict, leadAction: 'rework', reportToVerdictMin: 6, verdictToDecisionMin: 20 });
  }
  addReviewedCase(20, { family: 'claude', kind: 'visual', verdict: passVerdict, leadAction: 'rework', reportToVerdictMin: 4, verdictToDecisionMin: 12 });
  addReviewedCase(21, { family: 'claude', kind: 'visual', verdict: sendBackVerdict, leadAction: 'approve', reportToVerdictMin: 6, verdictToDecisionMin: 20 });
  addReviewedCase(22, { family: 'claude', kind: 'visual', verdict: unsureVerdict, leadAction: 'approve', reportToVerdictMin: 5, verdictToDecisionMin: 15 });
  addReviewedCase(23, { family: 'claude', kind: 'visual', verdict: sendBackVerdict, applied: true, disputed: true, reportToVerdictMin: 5 });

  const now = new Date();
  const stats = computeFirstPassStats(project, orders, { days: 30, now });

  const geminiRow = stats.by_family_and_kind.find(r => r.model_family === 'gemini' && r.kind === 'code')!;
  assert.equal(geminiRow.verdicts, 4);
  assert.equal(geminiRow.decided, 4);
  assert.equal(geminiRow.agree, 3);
  assert.equal(geminiRow.disagree, 1);
  assert.equal(geminiRow.enough, false);
  assert.equal(geminiRow.rate, null);
  assert.equal(geminiRow.rate_label, 'not enough cases');

  const claudeRow = stats.by_family_and_kind.find(r => r.model_family === 'claude' && r.kind === 'visual')!;
  assert.equal(claudeRow.verdicts, 14);
  assert.equal(claudeRow.decided, 12);
  assert.equal(claudeRow.agree, 10);
  assert.equal(claudeRow.disagree, 2);
  assert.equal(claudeRow.unsure, 1);
  assert.equal(claudeRow.applied, 1);
  assert.equal(claudeRow.disputed, 1);
  assert.equal(claudeRow.enough, true);
  assert.ok(Math.abs((claudeRow.rate ?? 0) - 10 / 12) < 1e-9);
  assert.equal(claudeRow.median_report_to_verdict_minutes, 4);
  assert.equal(claudeRow.median_verdict_to_decision_minutes, 12);

  const rendered = formatFirstPassStats(stats);
  assert.match(rendered, /not enough cases/);
  assert.match(rendered, /83\.3%/);

  // Run `alba review stats` and `alba review <TAG> first-pass-wrong` as real CLI subprocesses
  const cliText = alba(file, ['review', 'stats', '--days', '30']);
  assert.equal(cliText.code, 0, cliText.err);
  assert.match(cliText.out, /not enough cases/);
  assert.match(cliText.out, /claude/);

  const cliJson = alba(file, ['review', 'stats', '--days', '30', '--json']);
  assert.equal(cliJson.code, 0, cliJson.err);
  const parsedCli = JSON.parse(cliJson.out);
  assert.equal(parsedCli.by_family_and_kind.length, 2);

  // Refused CLI dispute on order without an applied bounce
  const refusedCli = alba(file, ['review', 'T1', 'first-pass-wrong', '--note', 'No bounce happened on this order.']);
  assert.notEqual(refusedCli.code, 0);
  assert.match(refusedCli.err, /no applied first-pass bounce/);

  // Valid CLI dispute on an order with an applied bounce
  addReviewedCase(24, { family: 'claude', kind: 'visual', verdict: sendBackVerdict, applied: true, reportToVerdictMin: 3 });
  const shortNoteCli = alba(file, ['review', 'T24', 'first-pass-wrong', '--note', 'short']);
  assert.notEqual(shortNoteCli.code, 0);
  const okCli = alba(file, ['review', 'T24', 'first-pass-wrong', '--note', 'The menu layout matches the approved mockup.']);
  assert.equal(okCli.code, 0, okCli.err);
  const reloadedOrders = new Orders(stateStore(loadProject(file)));
  assert.equal(reloadedOrders.store.events({ tag: 'T24' }).some(e => e.type === 'first-pass-disputed'), true);
});

test('API routes: GET /api/review/stats and POST /api/orders/:tag/first-pass-wrong', async () => {
  const f = await apiFixture({ populate: true });

  // Refused without an applied bounce -> 409
  const noBounce = await f.write('/api/orders/R1/first-pass-wrong', { note: 'Should fail because nothing was bounced.' });
  assert.equal(noBounce.status, 409);

  // Record an applied bounce on R1
  const rep = f.orders.get('R1').reports.at(-1)!;
  f.orders.act('R1', 'rework', { note: `First-pass review by claude-rev (claude): ${sendBackVerdict.note}` });
  const actSeq = f.orders.get('R1').actions.at(-1)!.seq;
  f.orders.record('R1', 'first-pass', {
    id: 'fp-api-1',
    tag: 'R1',
    report: rep.seq,
    fingerprint: 'fp-api',
    commit: 'abc1234',
    worker: 'claude-rev',
    model_family: 'claude',
    delivering_worker: 'coder',
    delivering_family: 'gpt',
    status: 'done',
    started: new Date().toISOString(),
    ended: new Date().toISOString(),
    verdict: sendBackVerdict,
    applied: true,
    reason: sendBackVerdict.summary,
  });
  f.orders.record('R1', 'first-pass-applied', { id: 'fp-api-1', report: rep.seq, action: actSeq });

  // Short note (< 10 chars) -> 400
  const shortNote = await f.write('/api/orders/R1/first-pass-wrong', { note: 'too short' });
  assert.equal(shortNote.status, 400);

  // Valid dispute -> 200 and recorded in stats
  const disputed = await f.write('/api/orders/R1/first-pass-wrong', { note: 'False positive: day.png is intentionally dim at dusk.' });
  assert.equal(disputed.status, 200);
  assert.equal(disputed.body.ok, true);
  assert.equal(disputed.body.id, 'fp-api-1');

  // Duplicate dispute on the same applied bounce -> 409
  const duplicate = await f.write('/api/orders/R1/first-pass-wrong', { note: 'Attempting to dispute the same bounce twice.' });
  assert.equal(duplicate.status, 409);

  // GET /api/review/stats
  const badDays = await f.get('/api/review/stats?project=demo&days=0');
  assert.equal(badDays.status, 400);

  const statsRes = await f.get('/api/review/stats?project=demo&days=30');
  assert.equal(statsRes.status, 200);
  assert.equal(statsRes.body.project, 'demo');
  assert.equal(statsRes.body.overall.verdicts, 1);
  assert.equal(statsRes.body.overall.applied, 1);
  assert.equal(statsRes.body.overall.disputed, 1);
  assert.equal(statsRes.body.overall.rate_label, 'not enough cases');
});
