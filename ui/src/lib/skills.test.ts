import { describe, expect, it } from 'vitest';
import type { SkillsView } from '@api';
import { skillColumns, skillMatches, useAction } from './skills.ts';

const s = (name: string, over: Partial<SkillsView['skills'][number]> = {}): SkillsView['skills'][number] => ({
  name, description: `${name} rules`, tags: [], source: 'lib', dir: `lib/${name}`, files: 1, bytes: 10, scope: 'global', engines: [], layers: [], usedBy: { orders: [], workers: [] },
  applicable: true, included: false, excluded: false, ...over,
});

describe('skills of the project and of the machine', () => {
  const list = [s('alba-worker-rules', { source: 'alba', layers: ['core'] }), s('ue-build', { engines: ['unreal'] }), s('unity-ui', { engines: ['unity'], applicable: false, inapplicable: 'for unity, the project is unreal' }), s('house-style', { scope: 'project', source: 'own' })];

  it('sorts them into the three columns', () => {
    const c = skillColumns(list);
    expect(c.available.map(x => x.name)).toEqual(['alba-worker-rules', 'ue-build']);
    expect(c.unused.map(x => x.name)).toEqual(['unity-ui']);
    expect(c.own.map(x => x.name)).toEqual(['house-style']);
  });

  it('offers to stop using a skill that is available, to use one that is not, and nothing for the tool\'s own and the project\'s own', () => {
    expect(list.map(x => useAction(x))).toEqual([undefined, 'stop', 'use', undefined]);
  });

  it('filters by words of the name, description, source, tags and engines', () => {
    expect(skillMatches(list[1]!, 'unreal build')).toBe(true);
    expect(skillMatches(list[1]!, 'unity')).toBe(false);
    expect(skillMatches(list[2]!, 'UNITY')).toBe(true);
    expect(skillMatches(list[0]!, '')).toBe(true);
  });
});
