import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import type { ProducerView, CleanPlan } from '../api/types.ts';
import { readStateJson } from '../orders/state-files.ts';
import { driveFacts } from '../clean/retention.ts';
import { producerNotes } from './notes.ts';

export function producerRoundView(project: ProjectConfig, orders: Orders): Pick<ProducerView, 'notes' | 'drives' | 'lastClean'> {
  return {
    notes: { project: producerNotes(project), orders: orders.all().map(d => ({ tag: d.order.tag, text: producerNotes(project, d.order.tag) })).filter(n => n.text) },
    drives: driveFacts(project),
    lastClean: readStateJson<CleanPlan | undefined>(project, '_producer-last-clean.json', undefined),
  };
}
