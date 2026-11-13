import type { ProjectConfig } from '../config.ts';
import type { OrderDoc } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { producerSnapshot } from './conversation-state.ts';
import { producerCases, type ProducerCase } from './producer.ts';

export type ReadArgs = Record<string, unknown>;
export const newestFirst = <T>(rows: T[], time: (row: T) => string, sequence: (row: T) => number = () => 0): T[] => rows.sort((a, b) => Date.parse(time(b)) - Date.parse(time(a)) || sequence(b) - sequence(a));
export const since = (args: ReadArgs, at: string): boolean => args.since === undefined || Date.parse(at) >= Date.parse(String(args.since));
export function hasTag(args: ReadArgs, tag: string): boolean {
  return args.tag === undefined || (Array.isArray(args.tag) ? args.tag : [args.tag]).some(t => String(t).toLowerCase() === tag.toLowerCase());
}
export function selectedOrders(orders: Orders, args: ReadArgs, filterTime = true): OrderDoc[] {
  const docs = orders.all(), merged = orders.mergedSet(docs);
  return newestFirst(docs.filter(doc => {
    const stage = orders.stage(doc, merged).stage;
    return (args.include_closed === true || !['merged', 'cancelled'].includes(stage))
      && (args.stage === undefined || args.stage === stage) && hasTag(args, doc.order.tag)
      && (!filterTime || since(args, doc.order.updated));
  }), doc => doc.order.updated);
}
export function selectedCases(project: ProjectConfig, orders: Orders, args: ReadArgs): ProducerCase[] {
  const docs = orders.all(), byTag = new Map(docs.map(d => [d.order.tag.toLowerCase(), d]));
  const visible = new Set(selectedOrders(orders, { ...args, since: undefined }).map(d => d.order.tag.toLowerCase()));
  return newestFirst(producerCases(project).filter(c => {
    if (!since(args, c.updatedAt) || args.trigger !== undefined && c.trigger !== args.trigger) return false;
    if (args.include_closed !== true && c.status !== 'open') return false;
    if (!c.order) return args.tag === undefined && args.stage === undefined;
    const doc = byTag.get(c.order.toLowerCase());
    if (!hasTag(args, c.order) || doc && !visible.has(c.order.toLowerCase()) || !doc && args.stage !== undefined) return false;
    const latestRun = doc && [...doc.runs].sort((a, b) => b.seq - a.seq)[0];
    return args.include_closed === true || !c.facts.run || !latestRun || c.facts.run === latestRun.id;
  }), c => c.updatedAt);
}
export function collectionPage(project: ProjectConfig, args: ReadArgs, source: string) {
  const page = Number(args.page ?? 0), size = project.producer.session.page_chars ?? 12000;
  return { page, pages: Math.max(1, Math.ceil(source.length / size)), text: source.slice(page * size, (page + 1) * size) };
}

/** Read only the stored snapshot; never refresh facts on a model read. */
export function readProducerFacts(project: ProjectConfig, orders: Orders, args: ReadArgs) {
  const snapshot = producerSnapshot(project, 'facts') as { at?: string; facts?: Record<string, unknown>[] } | null;
  const facts = snapshot?.facts ?? [];
  if (args.fact !== undefined) {
    const value = facts.find(fact => fact.id === args.fact) ?? null;
    return { available: value !== null, value };
  }
  const filtered = args.tag !== undefined || args.stage !== undefined;
  const tags = new Set(filtered ? selectedOrders(orders, { ...args, since: undefined }).map(d => d.order.tag.toLowerCase()) : []);
  const selected = facts.filter(fact => (!filtered || (fact.tags as string[] | undefined)?.some(tag => tags.has(tag.toLowerCase())))
    && since(args, snapshot?.at ?? ''));
  const summary = selected.map(fact => `${fact.id}: ${String(fact.value)} ${fact.unit}`).join('\n');
  return { available: snapshot !== null && snapshot !== undefined, ...collectionPage(project, args, summary) };
}
