import type { ProjectConfig } from '../config.ts';
import { DEFAULT_TAG_PATTERN } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { directorMessages, directionProposals, standingDirection } from './conversation-state.ts';
import { currentProducerActions, producerPolicy, producerState } from './producer.ts';
import { budgetState, producerSessionStatus } from './session.ts';
import { readFacts } from './facts/snapshot.ts';
import type { ProducerChatView, ProducerWorkspace } from '../api/types.ts';

/** Stable message-id cursor: new messages cannot shift an older page. */
export function producerChatPage(project: ProjectConfig, orders: Orders, before?: string, size = 30): ProducerChatView {
  const rows = directorMessages(project);
  const end = before ? rows.findIndex(m => m.id === before) : rows.length;
  if (end < 0) throw new Error('Unknown conversation cursor.');
  const start = Math.max(0, end - Math.min(30, Math.max(1, size)));
  const messages = rows.slice(start, end).map(({ factIds: _ids, ...message }) => message);
  const visible = new Set(messages.map(m => m.id));
  const referenced = new Set(messages.flatMap(m => m.answer.match(/F:[\w%./:-]+/g) ?? []).map(id => id.replace(/[.:]+$/, '')));
  return {
    session: producerSessionStatus(project),
    facts: readFacts(project)?.facts.filter(f => referenced.has(f.id)) ?? [],
    messages, ...(start ? { nextCursor: messages[0].id } : {}),
    direction: standingDirection(project),
    directionProposals: directionProposals(project).filter(p => p.status === 'proposed' || visible.has(p.messageId)),
    actions: currentProducerActions(project, orders).filter(a => ['proposed', 'would-do', 'superseded'].includes(a.status) || !!a.messageId && visible.has(a.messageId)),
  };
}

export function producerWorkspace(project: ProjectConfig, orders: Orders): ProducerWorkspace {
  const state = producerState(project), policy = producerPolicy(project), daily = budgetState(project);
  const chat = producerChatPage(project, orders), snapshot = readFacts(project);
  return {
    ...chat, project: project.id, enabled: policy.enabled, paused: state.paused,
    session: producerSessionStatus(project), daily: { turns: daily.dayTurns, tokens: daily.dayUsage },
    rules: policy.rules, budget: policy.budgets.usage_per_day,
    quickPrompts: project.producer.quick_prompts,
    tagPattern: project.dispatch_table?.tag_pattern ?? DEFAULT_TAG_PATTERN,
    constraint: snapshot?.analysis?.constraint ?? null,
    facts: chat.facts ?? [],
    questions: state.cases.filter(c => c.status === 'open' && c.trigger === 'question' && c.order).map(c => ({ id: c.id, at: c.updatedAt, text: c.card.summary, order: c.order! })),
  };
}
