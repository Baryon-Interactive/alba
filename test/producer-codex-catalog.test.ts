import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { catalogEntryFor, writeAtomic } from '../src/producer/engines/codex.ts';

test('an unknown model id takes the metadata of the closest bundled model', () => {
  const models = [{ slug: 'alpha-1' }, { slug: 'model-x' }, { slug: 'model-x-mini' }, { slug: 'other-2' }];
  assert.equal(catalogEntryFor(models, 'model-x-sub').slug, 'model-x', 'a provider alias keeps its base model');
  assert.equal(catalogEntryFor(models, 'model-x-mini-fast').slug, 'model-x-mini', 'the longest prefix wins');
  assert.equal(catalogEntryFor(models, 'model-y').slug, 'model-x', 'else the longest shared leading run');
  assert.equal(catalogEntryFor(models, 'zzz').slug, 'alpha-1', 'no overlap falls back to the first entry');
});

test('shared catalog and instruction files are replaced atomically', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alba-codex-catalog-'));
  const file = path.join(dir, 'catalog.json');
  writeAtomic(file, 'first');
  writeAtomic(file, 'second');
  assert.equal(readFileSync(file, 'utf8'), 'second');
  assert.deepEqual(readdirSync(dir), ['catalog.json'], 'no temporary file is left behind');
});
