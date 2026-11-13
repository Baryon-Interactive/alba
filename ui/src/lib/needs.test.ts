import { describe, expect, it } from 'vitest';
import type { OrderSummary, Overview, Quote, Stage } from '@api';
import { groupNeedsYou, needsTotal } from './needs.ts';

const order = (tag: string, stage: Stage, waitingFor?: 'card' | 'answer'): OrderSummary => ({ project: 'p', tag, title: tag, kind: 'k', stage, why: '', waitingFor, needs: [], updated: '', actions: [] });

function overview(parts: Partial<Overview> = {}): Overview {
  return {
    project: 'p', name: 'P', at: '', stages: {},
    needsYou: { count: 0, items: [] }, problems: { count: 0, items: [] }, running: { count: 0, items: [] }, workers: { count: 0, items: [] }, pendingQuotes: { count: 0, items: [] },
    next: { moves: [], heldBack: [] }, ...parts,
  };
}

describe('the blocks of the needs-you page', () => {
  it('count what they list, whatever the server says in its own count fields', () => {
    const o = overview({
      // the counts are wrong on purpose
      needsYou: { count: 99, items: [order('A', 'awaiting-user'), order('B', 'awaiting-review'), order('C', 'awaiting-review'), order('D', 'failed'), order('E', 'dropped')] },
      problems: { count: 7, items: [{ kind: 'stalled', tag: 'X', text: 'X: stalled' }] },
      next: { moves: [{ tag: 'S', mode: 'card', worker: 'w' }, { tag: 'T', mode: 'dispatch', worker: 'w' }], heldBack: [] },
    });
    const groups = groupNeedsYou(o);
    for (const g of groups) expect(g.count).toBe(g.orders.length + g.cards.length + g.problems.length + g.quotes.length);
    expect(Object.fromEntries(groups.map(g => [g.id, g.count]))).toEqual({ answer: 1, review: 2, card: 1, blocked: 2, problems: 1 });
    // everything the server put in needsYou is on the page, once
    expect(groups.flatMap(g => g.orders).map(x => x.tag).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(needsTotal(groups)).toBe(6);
  });

  it('leave out a block with nothing in it, and say nothing when everything is empty', () => {
    expect(groupNeedsYou(overview())).toEqual([]);
    expect(groupNeedsYou(overview({ needsYou: { count: 1, items: [order('A', 'awaiting-user')] } })).map(g => g.id)).toEqual(['answer']);
  });

  it('keep an order in a stage it does not know in the stuck block instead of dropping it', () => {
    const groups = groupNeedsYou(overview({ needsYou: { count: 1, items: [order('Q', 'held')] } }));
    expect(groups.map(g => g.id)).toEqual(['blocked']);
  });

  it('puts an order that waits for a card click apart from the questions, with no answer to give', () => {
    const groups = groupNeedsYou(overview({
      needsYou: { count: 3, items: [order('Q', 'awaiting-user', 'answer'), order('K', 'awaiting-user', 'card'), order('O', 'awaiting-user')] },
    }));
    const by = Object.fromEntries(groups.map(g => [g.id, g.orders.map(x => x.tag)]));
    expect(by.cardwait).toEqual(['K']);
    // an order the server did not mark is still shown as a question: nothing is lost
    expect(by.answer).toEqual(['Q', 'O']);
  });

  it('lists the quotes that wait for approval and counts them in the badge', () => {
    const quote: Quote = { id: 'q1', project: 'p', tag: 'T', service: 'images', unit: 'credits', capRequested: 50, created: '', by: 'x', status: 'pending', spent: 0, ledger: [] };
    const groups = groupNeedsYou(overview({ pendingQuotes: { count: 9, items: [{ ...quote }, { ...quote, id: 'q2' }] } }));
    expect(groups.map(g => [g.id, g.count])).toEqual([['quotes', 2]]);
    expect(needsTotal(groups)).toBe(2);
  });

  it('lists the pick sets that wait for a choice, between the quotes and the reviews, and counts them in the badge', () => {
    const picks = [{ id: 'P1', title: 'Door', options: 3 }, { id: 'P2', title: 'Lettering', order: 'T1', options: 2 }];
    const groups = groupNeedsYou(overview({ pendingPicks: { count: 9, items: picks }, needsYou: { count: 1, items: [order('R', 'awaiting-review')] } }));
    expect(groups.map(g => [g.id, g.count])).toEqual([['picks', 2], ['review', 1]]);
    expect(groups[0].picks).toEqual(picks);
    expect(needsTotal(groups)).toBe(3);
    expect(groupNeedsYou(overview()).find(g => g.id === 'picks')).toBeUndefined();
  });
});
