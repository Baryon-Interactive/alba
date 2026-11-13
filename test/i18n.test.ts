import { zh as translated } from '../src/i18n-zh.ts';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { UserError, defaultLang, fail, t, withLang } from '../src/i18n.ts';
import { zh } from '../src/i18n-zh.ts';
import { fixture } from './api-fixture.ts';

const SRC = path.resolve(import.meta.dirname, '../src');

/** Every text given to t() or fail() as a plain literal. */
function literals(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const re = /\b(?:t|fail|word)\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;
        for (const m of readFileSync(p, 'utf8').matchAll(re)) {
          const lit = m[1];
          if (lit.startsWith('`') && lit.includes('${')) continue;
          found.add(lit.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
        }
      }
    }
  };
  walk(SRC);
  const brief = readFileSync(path.join(SRC, 'producer/briefs.ts'), 'utf8');
  for (const match of brief.matchAll(/\['([^']+)', events\./g)) found.add(match[1]);
  return found;
}

const marks = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

test('the Chinese catalog: every key is a text the code asks for, and every text keeps its {marks}', () => {
  const asked = literals();
  const stale = Object.keys(zh).filter(k => !asked.has(k));
  assert.deepEqual(stale, [], 'keys that no t() or fail() call uses (typos or removed texts)');
  const broken = Object.entries(zh).filter(([k, v]) => marks(k) !== marks(v)).map(([k]) => k);
  assert.deepEqual(broken, [], 'the Chinese text must carry the same {marks} as the English one');
  assert.ok(Object.entries(zh).every(([k, v]) => /\p{Script=Han}/u.test(v) || k === '{tag}: {problem}'), 'every entry has Chinese in it');
});

test('t(): the language of the request wins over ALBA_LANG; an unknown text stays English; a UserError keeps its English text', () => {
  assert.equal(t('No order "{tag}". Known orders: {known}', { tag: 'A1', known: 'B1' }), 'No order "A1". Known orders: B1');
  withLang('zh', () => {
    assert.equal(t('cancelled by a person'), translated["cancelled by a person"]);
    assert.equal(t('a text that has no entry'), 'a text that has no entry');
    assert.equal(t('{tag} has no open run.', { tag: 'A1' }), translated['{tag} has no open run.'].replace('{tag}', 'A1'));
    try { fail('{tag} has no open run.', { tag: 'A1' }); } catch (e) {
      assert.ok(e instanceof UserError);
      assert.equal(e.message, translated['{tag} has no open run.'].replace('{tag}', 'A1'));
      assert.equal(e.english, 'A1 has no open run.');
    }
  });
  assert.equal(t('cancelled by a person'), 'cancelled by a person');
  const before = process.env.ALBA_LANG;
  try {
    process.env.ALBA_LANG = 'zh-CN';
    assert.equal(defaultLang(), 'zh');
    assert.equal(t('cancelled by a person'), translated["cancelled by a person"]);
    withLang('en', () => assert.equal(t('cancelled by a person'), 'cancelled by a person'));
  } finally { if (before === undefined) delete process.env.ALBA_LANG; else process.env.ALBA_LANG = before; }
});

test('api: texts come back in the language the request asks for (?lang=, x-alba-lang, Accept-Language), and statuses do not depend on it', async () => {
  const f = await fixture();
  const why = async (p: string, headers: Record<string, string> = {}) => ((await f.get(p, headers)).body as { why: string }).why;
  const en = await why('/api/orders/Q1');
  assert.match(en, /^the latest report waits for an answer: Which tileset first\?$/);
  assert.equal(await why('/api/orders/Q1?lang=zh'), translated['the latest report waits for an answer: {q}'].replace('{q}', 'Which tileset first?'));
  assert.equal(await why('/api/orders/Q1', { 'x-alba-lang': 'zh' }), translated['the latest report waits for an answer: {q}'].replace('{q}', 'Which tileset first?'));
  assert.equal(await why('/api/orders/Q1', { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }), translated['the latest report waits for an answer: {q}'].replace('{q}', 'Which tileset first?'));
  assert.equal(await why('/api/orders/Q1?lang=en', { 'x-alba-lang': 'zh' }), en, '?lang= wins over the header');
  assert.equal(await why('/api/orders/Q1?lang=fr'), en, 'an unknown language is ignored');
  assert.equal(await why('/api/orders/Q1', { 'accept-language': 'en-US,en;q=0.9,zh;q=0.5' }), en);
  // the list, the actions that are not offered, and the overview follow too
  const list = (await f.get('/api/orders?lang=zh')).body;
  assert.equal(list.items.find((i: { tag: string }) => i.tag === 'W1').why, (await f.get('/api/orders/W1?lang=zh')).body.why);
  const detail = (await f.get('/api/orders/W1?lang=zh')).body;
  assert.match(detail.unavailable.approve, new RegExp(translated['only an order that is awaiting review can be approved here (this one is {stage})'].split('(')[0].split('{stage}')[0].slice(0, 8)));
  assert.match((await f.get('/api/orders/W1')).body.unavailable.approve, /^only an order that is awaiting review/);
  // errors: the status is the same, the message is in the language
  const missing = await f.get('/api/orders/NOPE?lang=zh');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error.message, new RegExp(translated['No order "{tag}". Known orders: {known}'].replace('{tag}', 'NOPE').split('{known}')[0]));
  const refused = await f.write('/api/orders/W1/actions?lang=zh', { action: 'approve' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, new RegExp(translated['only an order that is awaiting review can be approved here (this one is {stage})'].slice(0, 8)));
  assert.equal((await f.write('/api/orders/D1/actions?lang=zh', { action: 'release' })).status, 409);
  // the snapshot is kept per language: the overview does not hand one language's text to the other
  const overviewZh = (await f.get('/api/overview?lang=zh')).body;
  const overviewEn = (await f.get('/api/overview')).body;
  assert.equal(overviewZh.needsYou.items[0].why, translated['the latest report waits for an answer: {q}'].replace('{q}', 'Which tileset first?'));
  assert.equal(overviewEn.needsYou.items[0].why, en);
  // check names
  const check = (await f.write('/api/check/R1?lang=zh', {})).body;
  assert.ok(check.general.some((g: { name: string }) => /\p{Script=Han}/u.test(g.name)), JSON.stringify(check.general));
  const checkEn = (await f.write('/api/check/R1', {})).body;
  assert.ok(checkEn.general.every((g: { name: string }) => !/\p{Script=Han}/u.test(g.name)));
});

test('api: Session.lang is what a call without a preference gets', async () => {
  const before = process.env.ALBA_LANG;
  try {
    delete process.env.ALBA_LANG;
    assert.equal(((await (await fixture()).get('/api/session')).body).lang, 'en');
    process.env.ALBA_LANG = 'zh';
    const f = await fixture();
    assert.equal((await f.get('/api/session')).body.lang, 'zh');
    assert.match((await f.get('/api/orders/Q1')).body.why, new RegExp(translated['the latest report waits for an answer: {q}'].split('{q}')[0]));
    assert.match((await f.get('/api/orders/Q1?lang=en')).body.why, /^the latest report/);
  } finally { if (before === undefined) delete process.env.ALBA_LANG; else process.env.ALBA_LANG = before; }
});
