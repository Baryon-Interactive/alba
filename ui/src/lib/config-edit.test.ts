import { describe, expect, it } from 'vitest';
import { addMember, cleanRoute, groupUsers, hasLegacyRoles, moveMember, numberField, parseSection, renameGroup, routingEdits, routingOf, sectionEdit, withAnyone } from './config-edit.ts';

const values = { routing: { groups: { main: ['codex', 'sonnet', '*'], cheap: ['grok'] }, routes: { ui: { kinds: ['ui'], group: 'main' }, art: { kinds: ['art'], group: 'cheap', avoid: ['opus'] } }, default: 'main' } };

describe('routing edits', () => {
  it('reads a file without routing as an empty routing, and legacy roles as such', () => {
    expect(routingOf({})).toEqual({ groups: {}, routes: {} });
    expect(hasLegacyRoles({ roles: { ui: { kinds: ['ui'] } } })).toBe(true);
    expect(hasLegacyRoles({ routing: {} })).toBe(false);
  });

  it('sends nothing for an unchanged routing, and only the group or route that changed otherwise', () => {
    const before = routingOf(values);
    expect(routingEdits(before, routingOf(values))).toEqual([]);
    const after = { ...before, groups: { ...before.groups, main: moveMember(before.groups.main, 1, -1) } };
    expect(routingEdits(before, after)).toEqual([{ path: ['routing', 'groups', 'main'], value: ['sonnet', 'codex', '*'] }]);
  });

  it('renames a group in one request: the old key removed, the new one added, and the routes and the default pointed at it', () => {
    const before = routingOf(values);
    const after = renameGroup(before, 'main', 'core');
    expect(Object.keys(after.groups)).toEqual(['core', 'cheap']);
    expect(routingEdits(before, after)).toEqual([
      { path: ['routing', 'groups', 'main'] },
      { path: ['routing', 'groups', 'core'], value: ['codex', 'sonnet', '*'] },
      { path: ['routing', 'routes', 'ui'], value: { kinds: ['ui'], group: 'core' } },
      { path: ['routing', 'default'], value: 'core' },
    ]);
  });

  it('knows which routes use a group, and writes a route without empty fields', () => {
    const r = routingOf(values);
    expect(groupUsers(r, 'main')).toEqual(['ui', 'routing.default']);
    expect(groupUsers(r, 'cheap')).toEqual(['art']);
    expect(cleanRoute({ description: '', kinds: [], requires: ['vision'], default: false, group: 'main' })).toEqual({ requires: ['vision'], group: 'main' });
    const deleted = { ...r, routes: { ui: r.routes.ui }, groups: { main: r.groups.main } };
    expect(routingEdits(r, deleted)).toEqual([{ path: ['routing', 'groups', 'cheap'] }, { path: ['routing', 'routes', 'art'] }]);
  });

  it('keeps "anyone else" last when members move or are added', () => {
    expect(moveMember(['a', 'b', '*'], 1, 1)).toEqual(['a', 'b', '*']);
    expect(addMember(['a', '*'], 'b')).toEqual(['a', 'b', '*']);
    expect(addMember(['a'], 'a')).toEqual(['a']);
    expect(withAnyone(['a'], true)).toEqual(['a', '*']);
    expect(withAnyone(['a', '*'], false)).toEqual(['a']);
  });
});

describe('section edits', () => {
  it('writes a changed section, removes an emptied one and leaves an unchanged one alone', () => {
    expect(sectionEdit(['dispatch', 'caps'], { sim: 2 }, { sim: 2 })).toEqual([]);
    expect(sectionEdit(['dispatch', 'caps'], { sim: 2 }, { sim: 3 })).toEqual([{ path: ['dispatch', 'caps'], value: { sim: 3 } }]);
    expect(sectionEdit(['dispatch', 'caps'], { sim: 2 }, {})).toEqual([{ path: ['dispatch', 'caps'] }]);
    expect(sectionEdit(['dispatch', 'stall_minutes'], undefined, undefined)).toEqual([]);
  });
  it('reads numbers and JSON typed by a person', () => {
    expect(numberField(' 12 ')).toEqual({ ok: true, value: 12 });
    expect(numberField('')).toEqual({ ok: true, value: undefined });
    expect(numberField('ten').ok).toBe(false);
    expect(parseSection('{"currency": "USD"}')).toEqual({ ok: true, value: { currency: 'USD' } });
    expect(parseSection('  ')).toEqual({ ok: true, value: undefined });
    expect(parseSection('{').ok).toBe(false);
  });
});
