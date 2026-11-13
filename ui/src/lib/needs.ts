import type { Overview, OrderSummary, Problem, Quote, Stage } from '@api';

export interface NeedsGroup {
  id: 'answer' | 'cardwait' | 'quotes' | 'picks' | 'review' | 'card' | 'blocked' | 'problems';
  /** Always the length of the list: the counts a page shows never come from the server's own `count` fields. */
  count: number;
  orders: OrderSummary[];
  cards: Overview['next']['moves'];
  problems: Problem[];
  quotes: Quote[];
  /** Pick sets waiting for a choice (). */
  picks?: NonNullable<Overview['pendingPicks']>['items'];
}

const byStage = (items: OrderSummary[], stages: Stage[]) => items.filter(o => stages.includes(o.stage));

/**
 * The blocks of the home page. Blocks without content are left out.
 * An order that waits for a click on a card has nothing to answer: it gets its own block (`cardwait`), without an answer box.
 * `waitingFor` comes from the server; an order without it is taken for a question, as before.
 */
export function groupNeedsYou(o: Overview): NeedsGroup[] {
  const waiting = byStage(o.needsYou.items, ['awaiting-user']);
  const answer = waiting.filter(x => x.waitingFor !== 'card');
  const cardwait = waiting.filter(x => x.waitingFor === 'card');
  const review = byStage(o.needsYou.items, ['awaiting-review']);
  // blocked, failed, dropped, and anything else the server lists: nothing in `needsYou` is lost.
  const stuck = o.needsYou.items.filter(x => x.stage !== 'awaiting-user' && x.stage !== 'awaiting-review');
  const cards = o.next.moves.filter(m => m.mode === 'card');
  const quotes = o.pendingQuotes?.items ?? [];
  const picks = o.pendingPicks?.items ?? [];
  const groups: NeedsGroup[] = [
    { id: 'answer', count: answer.length, orders: answer, cards: [], problems: [], quotes: [] },
    { id: 'cardwait', count: cardwait.length, orders: cardwait, cards: [], problems: [], quotes: [] },
    { id: 'quotes', count: quotes.length, orders: [], cards: [], problems: [], quotes },
    { id: 'picks', count: picks.length, orders: [], cards: [], problems: [], quotes: [], picks },
    { id: 'review', count: review.length, orders: review, cards: [], problems: [], quotes: [] },
    { id: 'card', count: cards.length, orders: [], cards, problems: [], quotes: [] },
    { id: 'blocked', count: stuck.length, orders: stuck, cards: [], problems: [], quotes: [] },
    { id: 'problems', count: o.problems.items.length, orders: [], cards: [], problems: o.problems.items, quotes: [] },
  ];
  return groups.filter(g => g.count > 0);
}

/** Total of what a person has to act on: the sum of the lists on the page (the badge in the navigation). */
export function needsTotal(groups: NeedsGroup[]): number {
  return groups.filter(g => g.id !== 'problems').reduce((n, g) => n + g.count, 0);
}
