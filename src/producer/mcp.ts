import { draftingContext } from './drafting.ts';
import { toolJobs, toolOperations } from '../plugins/jobs.ts';
import { readDesign } from '../design/read.ts';
import { DESIGN_OFF } from '../design/model.ts';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadProject, type ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import { Orders } from '../orders/service.ts';
import { stateStore } from '../orders/backend.ts';
import { readStateFile } from '../orders/state-files.ts';
import { producerCases, type ProducerCase } from './producer.ts';
import { isGoalDraft } from './goals.ts';
import { producerAct, producerNotes, writeProducerNotes } from './session.ts';
import { listedProducerToolSchemas, validateProducerToolCall } from './tool-schemas.ts';
import { standingDirection, producerGoals, producerSnapshot, proposeDirection } from './conversation-state.ts';
import type { ProducerActionDetails } from './producer.ts';
import { readProducerOrder } from './order-read.ts';
import { collectionPage, newestFirst, readProducerFacts, selectedCases, selectedOrders, since } from './collection-read.ts';
import { readProducerStatus } from './status-read.ts';
import { readProducerWork, startProducerWork } from './work-sessions.ts';

export interface McpRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
export interface McpResponse { jsonrpc: '2.0'; id?: string | number | null; result?: unknown; error?: { code: number; message: string } }

const text = (v: unknown): string => typeof v === 'string' ? v : '';
const bounded = (v: string, n = 4000): string => v.length <= n ? v : `${v.slice(0, n - 1)}…`;
const json = (v: unknown): string => JSON.stringify(v, null, 2);

function inside(project: ProjectConfig, file: string): boolean {
  const p = path.resolve(file);
  return [project.root, project.state_dir, project.work_orders].some(root => {
    const rel = path.relative(path.resolve(root), p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * A goal case carries its system's whole rule and gap lists (several KB each). In a case list only their ids go
 * out; `producer_read kind design` reads the rules themselves when a draft needs them.
 */
export function trimmedCase(c: ProducerCase): ProducerCase {
  if (!isGoalDraft(c.trigger)) return c;
  const ids = (v: unknown) => Array.isArray(v) ? v.map(x => (x as { id?: string })?.id).filter(Boolean) : undefined;
  const system = c.facts.system as { code?: string; name?: string } | undefined;
  return { ...c, facts: { ...c.facts, ...(system ? { system: { code: system.code, name: system.name } } : {}), ...(c.facts.rules ? { rules: ids(c.facts.rules) } : {}), ...(c.facts.gaps ? { gaps: ids(c.facts.gaps) } : {}) } };
}

function readPage(project: ProjectConfig, orders: Orders, args: Record<string, unknown>) {
  const kind = text(args.kind) || 'cases';
  const docs = selectedOrders(orders, args, !['runs', 'reports', 'log-tails'].includes(kind));
  const visible = new Set(selectedOrders(orders, { ...args, since: undefined }).map(d => d.order.tag));
  const cases = selectedCases(project, orders, args);
  const actions = () => {
    const caseRows = producerCases(project);
    return newestFirst((JSON.parse(readStateFile(project, '_producer-actions.json') ?? '[]') as { at: string; caseId: string; target?: string }[]).filter(action => {
      const tag = action.target ?? caseRows.find(c => c.id === action.caseId)?.order;
      return since(args, action.at) && (tag ? visible.has(tag) : args.tag === undefined && args.stage === undefined);
    }), action => action.at);
  };
  const all: unknown[] = kind === 'cases' ? newestFirst(cases, c => c.updatedAt).map(trimmedCase)
    : kind === 'actions' ? actions()
      : kind === 'notes' ? [{ project: producerNotes(project), orders: args.tag === undefined ? [] : docs.map(d => ({ tag: d.order.tag, text: producerNotes(project, d.order.tag) })) }]
        : kind === 'orders' ? docs.map(d => ({ order: d.order, stage: orders.stage(d).stage }))
          : kind === 'runs' ? newestFirst(docs.flatMap(d => d.runs.filter(run => since(args, run.started)).map(run => ({ order: d.order.tag, run }))), row => row.run.started, row => row.run.seq)
            : kind === 'reports' ? newestFirst(docs.flatMap(d => d.reports.filter(report => since(args, report.at)).map(report => ({ order: d.order.tag, report }))), row => row.report.at, row => row.report.seq)
              : kind === 'verify' ? newestFirst(cases.filter(c => c.trigger === 'delivery'), c => c.updatedAt).map(c => ({ case: c.key, verify: c.facts.verify }))
                : kind === 'log-tails' ? newestFirst(docs.flatMap(d => d.runs.filter(r => since(args, r.started) && r.log && inside(project, r.log) && existsSync(r.log)).map(r => ({ order: d.order.tag, run: r.id, started: r.started, tail: bounded(readFileSync(r.log!, 'utf8').slice(-4000), 4000) }))), row => row.started)
                  : kind === 'decisions' ? [{ file: project.decisions?.file, text: project.decisions?.file && inside(project, project.decisions.file) && existsSync(project.decisions.file) ? readFileSync(project.decisions.file, 'utf8') : '' }]
                    : kind === 'diff-stats' ? docs.map(d => ({ order: d.order.tag, worktree: d.order.worktree, runs: d.runs.map(r => ({ id: r.id, cwd: r.cwd })) }))
                      : kind === 'shared-rules' ? [{ file: 'docs/producer/021-producer.md', text: existsSync(path.join(project.root, 'docs/producer/021-producer.md')) ? readFileSync(path.join(project.root, 'docs/producer/021-producer.md'), 'utf8') : '' }] : [];
  const source = json(all);
  return collectionPage(project, args, source);
}

export function callProducerTool(project: ProjectConfig, orders: Orders, name: string, args: Record<string, unknown>): unknown {
  if (process.env.ALBA_PRODUCER_READ_ONLY === '1' && (name !== 'producer_read' && (name !== 'producer_notes' || Object.keys(args).some(k => k !== 'tag')))) throw new Error('Work sessions have read-only producer tools.');
  validateProducerToolCall(name, args);
  if (name === 'producer_direction_propose') return proposeDirection(project, args as unknown as Parameters<typeof proposeDirection>[1]);
  if (name === 'producer_read' && args.kind === 'design') {
    const filters = args.filters as { system?: string; kind?: string } | undefined;
    return project.design?.enabled ? { available: true, value: readDesign(project, orders, { system: filters?.system ?? args.system as string | undefined, kind: filters?.kind ?? args.design_kind as string | undefined, query: args.query as string | undefined }) } : { available: false, message: DESIGN_OFF };
  }
  if (name === 'producer_read' && args.kind === 'status') return readProducerStatus(project, orders, args);
  if (name === 'producer_read' && args.kind === 'tools') return { tools: toolOperations(project), jobs: toolJobs(project).slice(-20).map(j => ({ id: j.id, tool: j.tool, operation: j.operation, order: j.order, status: j.status, quote: j.quote, files: j.files, waiting: j.waiting, error: j.error })) };
  if (name === 'producer_read' && args.kind === 'facts') return readProducerFacts(project, orders, args);
  if (name === 'producer_read' && ['direction', 'goals', 'constraint'].includes(String(args.kind))) {
    const value = args.kind === 'direction' ? standingDirection(project) : args.kind === 'goals' ? producerGoals(project) : producerSnapshot(project, args.kind as 'facts' | 'constraint');
    return { available: value !== null, value };
  }
  if (name === 'producer_read' && args.kind === 'work') return readProducerWork(project, text(args.id));
  if (name === 'producer_read' && args.kind === 'drafting') return draftingContext(project, orders, text(args.tag));
  if (name === 'producer_read' && args.kind === 'order') return readProducerOrder(project, orders, text(args.tag));
  if (name === 'producer_read') return readPage(project, orders, args);
  if (name === 'producer_act') {
    const actions = args.actions as Record<string, unknown>[];
    return actions.map(raw => {
      const a = raw as Record<string, unknown>;
      const evidence = (a.evidence ?? []) as string[];
      return producerAct(project, orders, text(a.case), text(a.kind), { worker: a.worker as string | undefined, work: a.work as string | undefined, note: text(a.note), reason: text(a.reason), evidence, target: a.target as string | undefined, order: a.order as ProducerActionDetails['order'], priority: a.priority as number | undefined, needs: a.needs as string[] | undefined, tool: a.tool as ProducerActionDetails['tool'] });
    });
  }
  if (name === 'producer_notes') {
    const tag = args.tag === undefined ? undefined : orders.get(text(args.tag)).order.tag;
    if (args.text !== undefined) return writeProducerNotes(project, text(args.text), args.replace === true, tag);
    return { text: producerNotes(project, tag) };
  }
  if (['producer_review', 'producer_draft', 'producer_work'].includes(name)) {
    if (!args.case) return { available: true, message: 'Supply an open case key to start a work session.' };
    const run = startProducerWork(project, orders, text(args.case), name === 'producer_draft' ? 'draft' : name === 'producer_review' ? 'review' : 'work', text(args.brief));
    return { id: run.id, status: run.status, summary: run.result?.summary ?? run.reason };
  }
  throw new Error(t('Unknown producer tool "{name}".', { name }));
}

/** A protocol answer (initialize, tools/list): the object itself, as MCP requires. */
function raw(id: string | number | null | undefined, value: unknown): McpResponse { return { jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), result: value }; }
/** A tools/call answer: the value as text content. */
function result(id: string | number | null | undefined, value: unknown): McpResponse { return { jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), result: { content: [{ type: 'text', text: typeof value === 'string' ? value : json(value) }] } }; }
function error(id: string | number | null | undefined, message: string): McpResponse { return { jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code: -32000, message } }; }

export async function runProducerMcp(projectFile: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const project = loadProject(projectFile);
  const orders = new Orders(stateStore(project), undefined, 'producer-session');
  let buffer = '';
  const write = (v: McpResponse) => output.write(`${JSON.stringify(v)}\n`);
  await new Promise<void>((resolve, reject) => {
    input.setEncoding?.('utf8');
    input.on('data', (chunk: string | Buffer) => {
      buffer += String(chunk);
      let end = buffer.indexOf('\n');
      while (end >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); end = buffer.indexOf('\n');
        if (!line) continue;
        let req: McpRequest;
        try { req = JSON.parse(line) as McpRequest; } catch { write(error(undefined, t('Invalid MCP JSON.'))); continue; }
        if (req.method === 'initialize') write(raw(req.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'alba-producer', version: '1' } }));
        else if (req.method === 'notifications/initialized') { /* notification */ }
        else if (req.method === 'tools/list') write(raw(req.id, { tools: listedProducerToolSchemas().filter(tool => process.env.ALBA_PRODUCER_READ_ONLY !== '1' || ['producer_read', 'producer_notes'].includes(tool.name)) }));
        else if (req.method === 'tools/call') {
          const p = req.params ?? {}; const name = text(p.name); const args = p.arguments && typeof p.arguments === 'object' ? p.arguments as Record<string, unknown> : {};
          try { write(result(req.id, callProducerTool(project, orders, name, args))); } catch (e) { write(error(req.id, (e as Error).message)); }
        } else if (req.id !== undefined) write(error(req.id, t('Unknown MCP method "{method}".', { method: text(req.method) })));
      }
    });
    input.on('end', resolve); input.on('error', reject);
  });
}
