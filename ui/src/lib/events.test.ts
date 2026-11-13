import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { StreamEventName } from '@api';
import { invalidationsFor } from './events.ts';
import { keys } from './keys.ts';
import { invalidationQueue } from './invalidation-queue.ts';

/** Marks the keys of every kind of query as fetched, applies the event, and returns which of them are stale now. */
function staleAfter(name: StreamEventName, data: unknown) {
  const client = new QueryClient();
  const all = {
    overview: keys.overview('p1'), orders: keys.orders('p1'), ordersByStage: keys.orders('p1', 'queued'),
    orderA: keys.order('p1', 'A1'), orderB: keys.order('p1', 'B2'), diffA: keys.diff('p1', 'A1'),
    workers: keys.workers('p1'), quota: keys.quota('p1', 'codex'), otherProject: keys.overview('p2'), otherOrder: keys.order('p2', 'A1'),
  };
  for (const k of Object.values(all)) client.setQueryData(k, {});
  for (const k of invalidationsFor(name, data, 'p1')) void client.invalidateQueries({ queryKey: k, refetchType: 'none' });
  return Object.entries(all).filter(([, k]) => client.getQueryState(k)?.isInvalidated).map(([n]) => n).sort();
}

describe('stream event to query invalidation', () => {
  it('an order action makes that order, the lists and the overview stale, and nothing else', () => {
    expect(staleAfter('order.action', { project: 'p1', tag: 'A1', type: 'action-rework' })).toEqual(['diffA', 'orderA', 'orders', 'ordersByStage', 'overview']);
  });

  it('a run ending also makes the workers stale (today count, spend)', () => {
    expect(staleAfter('run.end', { project: 'p1', tag: 'B2' })).toEqual(['orderB', 'orders', 'ordersByStage', 'overview', 'workers']);
  });

  it('a check changes the order and its list line, not the overview', () => {
    expect(staleAfter('check.done', { project: 'p1', tag: 'A1' })).toEqual(['diffA', 'orderA', 'orders', 'ordersByStage']);
  });

  it('a quota reading refreshes workers, quota history and the overview', () => {
    expect(staleAfter('quota', { project: 'p1', points: [] })).toEqual(['overview', 'quota', 'workers']);
  });

  it('events of another project stay in that project', () => {
    expect(staleAfter('order.updated', { project: 'p2', tag: 'A1' })).toEqual(['otherOrder']);
  });

  it('run.log lines are appended by the log viewer and invalidate nothing', () => {
    expect(staleAfter('run.log', { project: 'p1', key: 'A1:r1', lines: ['x'], offset: 1 })).toEqual([]);
  });

  it.each(['run.updated', 'run.activity'] as const)('%s only refreshes the run list and matching detail', name => {
    expect(invalidationsFor(name, { project: 'p1', tag: 'A1', data: { fields: ['usage', 'heartbeat'] } }, 'p1')).toEqual([keys.order('p1', 'A1'), ['runs', 'p1']]);
    expect(staleAfter(name, { project: 'p1', tag: 'A1' })).toEqual(['orderA']);
  });

  it('an order edit refreshes lists only for fields displayed in the list', () => {
    expect(staleAfter('order.updated', { tag: 'A1', data: { fields: ['mandate'] } })).toEqual(['diffA', 'orderA']);
    expect(staleAfter('order.updated', { tag: 'A1', data: { fields: ['title'] } })).toEqual(['diffA', 'orderA', 'orders', 'ordersByStage', 'overview']);
    expect(invalidationsFor('run.start', { tag: 'A1' }, 'p1')).toContainEqual(keys.overviewAll);
  });

  it('resync reads everything again', () => {
    expect(staleAfter('resync', { reason: 'old id' })).toEqual(['diffA', 'orderA', 'orderB', 'orders', 'ordersByStage', 'otherOrder', 'otherProject', 'overview', 'quota', 'workers']);
  });

  it('an order event also makes its route and skills stale, a config reload every skills registry', () => {
    const client = new QueryClient();
    const route = keys.route('p1', 'A1'), skills = keys.orderSkills('p1', 'A1'), registry = keys.skills('p1'), other = keys.route('p1', 'B2');
    for (const k of [route, skills, registry, other]) client.setQueryData(k, {});
    for (const k of invalidationsFor('order.updated', { project: 'p1', tag: 'A1' }, 'p1')) void client.invalidateQueries({ queryKey: k, refetchType: 'none' });
    expect([route, skills, registry, other].map(k => client.getQueryState(k)?.isInvalidated)).toEqual([true, true, false, false]);
    for (const k of invalidationsFor('serve.notice', { project: 'p1', kind: 'config-reloaded' }, 'p1')) void client.invalidateQueries({ queryKey: k, refetchType: 'none' });
    expect([registry, other].map(k => client.getQueryState(k)?.isInvalidated)).toEqual([true, true]);
  });
});

describe('coalesced invalidation', () => {
  afterEach(() => vi.useRealTimers());
  it('coalesces overlapping prefixes across a burst, throttles for 2 s and delivers the trailing change', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const a = keys.order('p1', 'A1'), b = keys.order('p2', 'A1');
    client.setQueryData(a, {}); client.setQueryData(b, {});
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const visibility = { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const queue = invalidationQueue(client, visibility);
    queue.add([a, ['order', 'p1'], a]);
    await vi.advanceTimersByTimeAsync(150);
    expect(invalidate).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) { queue.add([a]); await vi.advanceTimersByTimeAsync(150); }
    expect(invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(b)?.isInvalidated).toBe(false);
    queue.close(); client.clear();
  });

  it('does not refetch hidden tabs, flushes when visible, and cleans up when closed', async () => {
    vi.useFakeTimers();
    const client = new QueryClient(); client.setQueryData(keys.orders('p1'), {});
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    let onVisible: (() => void) | undefined;
    const visibility = { hidden: true, addEventListener: (_name: string, callback: unknown) => { onVisible = callback as () => void; }, removeEventListener: vi.fn() };
    const queue = invalidationQueue(client, visibility);
    queue.add([keys.orders('p1')]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(invalidate).not.toHaveBeenCalled();
    visibility.hidden = false; onVisible?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(invalidate).toHaveBeenCalledTimes(1);
    queue.add([keys.orders('p1')]); queue.close();
    await vi.advanceTimersByTimeAsync(3000);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(visibility.removeEventListener).toHaveBeenCalled(); client.clear();
  });

  it('preserves the two-second limit when the stream reconnects', async () => {
    vi.useFakeTimers();
    const client = new QueryClient(), key = keys.orders('p1'); client.setQueryData(key, {});
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const visibility = { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const first = invalidationQueue(client, visibility); first.add([key]);
    await vi.advanceTimersByTimeAsync(150); first.close();
    const second = invalidationQueue(client, visibility); second.add([key]);
    await vi.advanceTimersByTimeAsync(150); expect(invalidate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1850); expect(invalidate).toHaveBeenCalledTimes(2);
    second.close(); client.clear();
  });
});
