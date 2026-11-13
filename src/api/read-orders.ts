import { Orders } from '../orders/service.ts';

/** One immutable collection per API read, avoiding repeated disk scans while composing view sections. Never use for writes. */
export function readOrders(source: Orders): Orders {
  let docs: ReturnType<Orders['all']> | undefined;
  const view = new Orders(source.store, () => source.now(), source.actor);
  view.all = () => docs ??= source.all();
  view.get = tag => docs?.find(doc => doc.order.tag.toLowerCase() === tag.toLowerCase()) ?? source.get(tag);
  return view;
}
