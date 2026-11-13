import { expect, it } from 'vitest';
import { machinesZh } from './machines';

it('machine translations contain Chinese text, preserve placeholders and have no encoding replacement runs', () => {
  const marks = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [key, translated] of Object.entries(machinesZh)) {
    expect(translated, key).not.toMatch(/\?{3,}|\uFFFD/);
    expect(marks(translated), key).toEqual(marks(key));
  }
  for (const key of ['Engine module', 'Use project selection', 'Engine scan failed.', 'Preparing the installation plan…', '{engine} {version} editor is installed.', 'Another job is using this installer lock. Wait for it to finish.']) {
    expect(machinesZh[key], key).toMatch(/\p{Script=Han}/u);
  }
});
