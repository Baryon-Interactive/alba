import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReportBlock, parseReportFile, parseReportJson } from '../src/orders/report.ts';

const block = (json: string) => `Work done.\nSome notes.\n\n--- alba-report ---\n${json}\n--- end ---\n`;

test('report: parses the fixed block at the end of a text file', () => {
  const r = parseReportFile('X1.last.txt', block('{"status":"waiting","summary":"Need a call","question":"Use A or B?","evidence":["docs/x.md"],"commits":["abc1234"]}'));
  assert.deepEqual(r, { status: 'waiting', summary: 'Need a call', question: 'Use A or B?', evidence: ['docs/x.md'], commits: ['abc1234'] });
});

test('report: last block wins, CRLF is fine, defaults are empty lists', () => {
  const text = (block('{"status":"progress","summary":"first"}') + block('{"status":"ready","summary":"second"}')).replace(/\n/g, '\r\n');
  assert.deepEqual(parseReportBlock(text), { status: 'ready', summary: 'second', evidence: [], commits: [] });
});

test('report: plain json files', () => {
  assert.equal(parseReportFile('r.json', '{"status":"ready","summary":"ok"}').status, 'ready');
});

test('report: rejects bad input with a clear message', () => {
  assert.throws(() => parseReportBlock('just text'), /No report block found/);
  assert.throws(() => parseReportBlock('--- end ---'), /without a matching/);
  assert.throws(() => parseReportJson('{nope'), /not valid JSON/);
  assert.throws(() => parseReportJson('{"status":"done","summary":"x"}'), /"status" must be one of/);
  assert.throws(() => parseReportJson('{"status":"ready"}'), /"summary"/);
  assert.throws(() => parseReportJson('{"status":"ready","summary":"x","extra":1}'), /Unknown report field/);
  assert.throws(() => parseReportJson('{"status":"ready","summary":"x","question":"why?"}'), /only makes sense/);
  assert.throws(() => parseReportJson('{"status":"waiting","summary":"x","evidence":"a"}'), /"evidence" must be a list/);
});

test('report: obsolete markers and field aliases are rejected', () => {
  const oldBegin = ['AL' + 'BA', 'REPORT', 'BEGIN'].join('-'), oldEnd = ['AL' + 'BA', 'REPORT', 'END'].join('-');
  assert.throws(() => parseReportBlock(oldBegin + '\n{"status":"ready","summary":"old"}\n' + oldEnd), /No report block found/);
  for (const fields of [{ artifacts: ['docs/a.md'] }, { commit: 'abc1234' }]) assert.throws(() => parseReportJson(JSON.stringify({ status: 'ready', summary: 'ok', ...fields })), /Unknown report field/);
});
