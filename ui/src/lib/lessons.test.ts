import { describe, expect, it } from 'vitest';
import type { Lesson } from '@api';
import { filterLessons, levelCounts, tagCounts } from './lessons.ts';

const l = (id: string, tags: string[], rule = 'r', over: Partial<Lesson> = {}): Lesson => ({ id, title: id, tags, rule, appliesToProject: true, orders: [], file: 'a.md', ...over });
const items = [l('L1', ['art', 'ui']), l('L2', ['art'], 'r', { appliesToProject: false, level: 'rule' }), l('L3', ['audio'], 'loop the track', { level: 'rule' })];

describe('lessons by tag', () => {
  it('counts the tags, most used first', () => {
    expect(tagCounts(items)).toEqual([{ tag: 'art', count: 2 }, { tag: 'audio', count: 1 }, { tag: 'ui', count: 1 }]);
  });

  it('needs all the chosen tags', () => {
    expect(filterLessons(items, ['art']).map(x => x.id)).toEqual(['L1', 'L2']);
    expect(filterLessons(items, ['art', 'ui']).map(x => x.id)).toEqual(['L1']);
    expect(filterLessons(items, []).length).toBe(3);
  });

  it('searches the rule text too', () => {
    expect(filterLessons(items, [], 'loop').map(x => x.id)).toEqual(['L3']);
  });

  it('can leave out the lessons of other projects', () => {
    expect(filterLessons(items, ['art'], '', true).map(x => x.id)).toEqual(['L1']);
    expect(filterLessons(items, [], '', true).map(x => x.id)).toEqual(['L1', 'L3']);
  });

  it('counts the levels that are given', () => {
    expect(levelCounts(items)).toEqual([{ level: 'rule', count: 2 }]);
  });
});
