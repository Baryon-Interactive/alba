import { readFileSync } from 'node:fs';
import { acceptanceCard } from '../review/acceptance.ts';
import type { ProjectConfig } from '../config.ts';
import type { Orders } from '../orders/service.ts';
import { headings } from '../library/markdown.ts';
import { findOrderFile } from '../run/prompt.ts';
import { producerNotes } from './notes.ts';

const BODY_BYTES = 12 * 1024;
const OMITTED = '\n… [order body truncated]\n';

function prefix(text: string, bytes: number): string {
  // Streaming decode leaves a partial final UTF-8 character out of the result.
  return new TextDecoder().decode(Buffer.from(text).subarray(0, Math.max(0, bytes)), { stream: true });
}

/** Keep review-critical sections even when they occur beyond the ordinary body limit. */
function boundedBody(body: string): string {
  if (Buffer.byteLength(body) <= BODY_BYTES) return body;
  const all = headings(body);
  const sections = all.flatMap((heading, index) => /^(Acceptance|Evidence|Paths)$/i.test(heading.text) ? [{
    start: heading.start,
    end: all.slice(index + 1).find(next => next.level <= heading.level)?.start ?? body.length,
  }] : []);
  const ranges = sections.filter((section, index) => !sections.slice(0, index).some(parent => parent.start <= section.start && parent.end >= section.end));
  const critical = ranges.map(section => body.slice(section.start, section.end));
  let ordinary = '';
  let end = 0;
  for (const range of ranges) { ordinary += body.slice(end, range.start); end = range.end; }
  ordinary += body.slice(end);
  const budget = BODY_BYTES - Buffer.byteLength(OMITTED);
  const reserved = critical.join('');
  if (Buffer.byteLength(reserved) <= budget) return prefix(ordinary, budget - Buffer.byteLength(reserved)) + OMITTED + reserved;
  // Oversized critical sections share the limit; each heading and its opening text remain visible.
  const perSection = Math.floor((budget - Math.max(0, critical.length - 1)) / critical.length);
  return OMITTED + critical.map(section => prefix(section, perSection)).join('\n');
}

/** Read stored facts only: judging an order must not run verification or record actions. */
export function readProducerOrder(project: ProjectConfig, orders: Orders, tag: string) {
  const doc = orders.get(tag);
  const report = [...doc.reports].sort((a, b) => b.seq - a.seq)[0];
  const verified = orders.store.events({ tag: doc.order.tag }).filter(event => event.type === 'order-verified').at(-1);
  const results = (verified?.data?.results ?? []) as { name: string; status: string; reason: string }[];
  const body = readFileSync(findOrderFile(project.work_orders, doc.order.tag), 'utf8');
  return {
    tag: doc.order.tag,
    title: doc.order.title,
    stage: orders.stage(doc).stage,
    kind: doc.order.kind,
    needs: doc.order.needs,
    producerNotes: { project: producerNotes(project), order: producerNotes(project, doc.order.tag) },
    body: boundedBody(body),
    acceptance: acceptanceCard(project, orders, doc.order.tag),
    report: report ? { status: report.status, summary: report.summary, evidence: report.evidence, commits: report.commits } : null,
    verify: results.map(({ name, status, reason }) => ({ name, status, reason })),
    actions: [...doc.actions].sort((a, b) => b.seq - a.seq).slice(0, 5).map(({ kind, note, at }) => ({ kind, note: note ?? '', at })),
  };
}
