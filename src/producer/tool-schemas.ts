import { PRODUCER_ACTIONS, PRODUCER_TRIGGERS } from '../config.ts';
import { STAGES } from '../orders/model.ts';
import { t } from '../i18n.ts';

export const PRODUCER_READ_KINDS = ['status', 'cases', 'actions', 'notes', 'orders', 'order', 'runs', 'reports', 'verify', 'log-tails', 'decisions', 'diff-stats', 'shared-rules', 'facts', 'constraint', 'direction', 'goals', 'drafting', 'design', 'tools', 'work'] as const;
export const PRODUCER_ACTION_REQUIRED = ['case', 'kind'] as const;
export const PRODUCER_ACTION_LIMIT = 20;

interface Schema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  enum?: readonly string[];
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  pattern?: string;
  maxLength?: number;
  additionalProperties?: false;
  anyOf?: Schema[];
}

const actionProperties = {
  worker: { type: 'string', pattern: '\\S', description: 'For reroute: exact worker id from producer.escalate_to; target and note are required, note must explain the new approach in at most 2000 characters.' },
  work: { type: 'string', pattern: '\\S', description: 'Completed work id whose result you were shown (on its card or with producer_read kind work). The host supplies its full action payload after checking the case facts. For accept, accept-part or rework of a delivery: its finished review id.' },
  target: { type: 'string', pattern: '\\S', description: 'Target order tag for a chat action.' },
  priority: { type: 'integer', description: 'Higher priority dispatches first, within existing caps.' },
  needs: { type: 'array', items: { type: 'string', description: 'Dependency order tag.' }, description: 'Replacement dependency tags for reprioritize.' },
  order: { type: 'object', description: 'Complete draft order.', additionalProperties: false, required: ['tag', 'title', 'kind', 'needs', 'body'], properties: {
    worker: { type: 'string', description: 'Optional worker hint.' }, tag: { type: 'string', pattern: '\\S', description: 'New order tag.' }, title: { type: 'string', pattern: '\\S', description: 'Draft title.' }, kind: { type: 'string', pattern: '\\S', description: 'Order kind.' },
    needs: { type: 'array', description: 'Dependency tags.', items: { type: 'string', description: 'Dependency order tag.' } }, body: { type: 'string', pattern: '\\S', description: 'Full draft order including Acceptance section.' },
  } },
  tool: { type: 'object', description: 'For tool-call: an operation of an enabled tool (producer_read kind tools lists them) and its input. A paid operation needs target, the order whose quote it spends.', additionalProperties: false, required: ['id', 'operation', 'input'], properties: {
    id: { type: 'string', pattern: '\\S', description: 'Tool id.' }, operation: { type: 'string', pattern: '\\S', description: 'Operation name.' }, input: { type: 'object', description: 'The input, matching the operation input schema.' },
  } },
  case: { type: 'string', pattern: '\\S', description: t('Case id or key returned by producer_read kind cases.') },
  kind: { type: 'string', enum: PRODUCER_ACTIONS, description: t('Policy-gated action to propose for this case.') },
  note: { type: 'string', description: t('Action text: a message, answer, rework instruction, or new order tag for add-order.') },
  reason: { type: 'string', description: t('Why the action is justified; used as the title for add-order.') },
  evidence: { type: 'array', maxItems: PRODUCER_ACTION_LIMIT, items: { type: 'string', description: t('An evidence path supporting this proposal.') }, description: t('Up to twenty evidence paths supporting the proposal.') },
} satisfies Record<string, Schema>;
const rerouteFields: Schema[] = [{ required: ['order'], properties: { kind: { enum: ['add-order'] } } }, { properties: { kind: { enum: PRODUCER_ACTIONS.filter(k => k !== 'reroute' && k !== 'add-order' && k !== 'tool-call') } } }, { required: ['tool'], properties: { kind: { enum: ['tool-call'] } } },{ required: ['target', 'worker', 'note'], properties: { kind: { enum: ['reroute'] }, note: { type: 'string', pattern: '\\S', maxLength: 2000 } } }];
const actionSchema: Schema = { type: 'object', description: t('One producer proposal with its supporting facts.'), properties: actionProperties, required: PRODUCER_ACTION_REQUIRED, additionalProperties: false, anyOf: rerouteFields };

export const PRODUCER_TOOL_SCHEMAS: { name: string; description: string; inputSchema: Schema }[] = [
  { name: 'producer_direction_propose', description: 'Propose a complete standing direction edit for a director click.', inputSchema: {
    type: 'object', description: 'A complete proposed direction version.', additionalProperties: false, required: ['priorities', 'stop', 'constraints', 'notes'], properties: {
      priorities: { type: 'string', description: 'Current priorities.' }, stop: { type: 'string', description: 'Work to stop.' }, constraints: { type: 'string', description: 'Standing constraints.' }, notes: { type: 'string', description: 'Notes dated when accepted.' },
    },
  } },
  {
    name: 'producer_read', description: t('Call kind status first for open orders, stalled runs, capacity and cases. Use filtered collections or one order/fact for details.'),
    inputSchema: {
      type: 'object', description: t('Choose a fact collection or an order tag to read.'), additionalProperties: false, required: ['kind'],
      properties: {
        kind: { type: 'string', enum: PRODUCER_READ_KINDS, description: t('Fact collection to read; order returns one order with report, verification, and actions.') },
        system: { type: 'string', pattern: '\\S', description: 'With kind design, filter by system code.' },
        design_kind: { type: 'string', enum: ['system', 'rule', 'formula', 'param', 'target', 'gap', 'milestone', 'term', 'decision_link'], description: 'Entity kind filter for design (kind selects the producer collection).' },
        filters: { type: 'object', additionalProperties: false, properties: { system: { type: 'string', description: 'Design system code.' }, kind: { type: 'string', enum: ['system', 'rule', 'formula', 'param', 'target', 'gap', 'milestone', 'term', 'decision_link'], description: 'Design entity kind.' } }, description: 'Design entity filters.' },
        query: { type: 'string', enum: ['open-gaps-without-order', 'failing-targets', 'unmeasured-targets', 'milestone', 'stale-systems'], description: 'Named design query.' },
        page: { type: 'integer', minimum: 0, description: t('Zero-based collection page (12,000 characters by default); every page includes total pages. Ignored for status, order and a single fact.') },
        tag: { description: t('One order tag or a list, matched without regard to case. Kind order requires one tag.'), anyOf: [
          { type: 'string', pattern: '\\S', description: 'One order tag.' },
          { type: 'array', minItems: 1, items: { type: 'string', pattern: '\\S', description: 'An order tag.' }, description: 'Order tags to include.' },
        ] },
        stage: { type: 'string', enum: STAGES, description: 'Filter by current order stage (also applies to associated runs, reports and cases).' },
        since: { type: 'string', description: 'Include records updated at or after this ISO timestamp; runs use started, reports use at.' },
        trigger: { type: 'string', enum: PRODUCER_TRIGGERS, description: 'Filter cases by trigger.' },
        include_closed: { type: 'boolean', description: 'Include merged and cancelled orders and their associated records (default false).' },
        fact: { type: 'string', pattern: '\\S', description: 'With kind facts, return this fact id in full, including tags and evidence.' },
        id: { type: 'string', pattern: '\\S', description: 'With kind work, the work session id: returns its status and full result.' },
      },
      anyOf: [{ properties: { kind: { enum: PRODUCER_READ_KINDS.filter(kind => kind !== 'order' && kind !== 'drafting' && kind !== 'work') } } }, { required: ['tag'], properties: { kind: { enum: PRODUCER_READ_KINDS.filter(kind => kind !== 'work') } } }, { required: ['id'], properties: { kind: { enum: ['work'] } } }],
    },
  },
  {
    name: 'producer_act', description: t('Propose one to twenty policy-gated producer actions.'),
    inputSchema: {
      type: 'object', description: t('Supply one to twenty actions.'), additionalProperties: false, required: ['actions'],
      properties: {
        actions: { type: 'array', minItems: 1, maxItems: PRODUCER_ACTION_LIMIT, items: actionSchema, description: t('One to twenty proposals, each requiring case and kind.') },
      },
    },
  },
  {
    name: 'producer_notes', description: t('Read or update bounded producer notes.'),
    inputSchema: {
      type: 'object', description: t('Empty arguments read notes; text updates them.'), additionalProperties: false,
      properties: {
        tag: { type: 'string', pattern: '\\S', description: 'Optional order tag; omitted means project notes.' },
        text: { type: 'string', description: t('Text to append, or replace when replace is true; providing text writes notes.') },
        replace: { type: 'boolean', description: t('Replace all notes instead of appending when writing.') },
      },
    },
  },
  ...['producer_review', 'producer_draft', 'producer_work'].map(name => ({ name, description: t('Start or return one detached work session for an open case; never poll. Results arrive as cards.'), inputSchema: { type: 'object' as const, description: t('Detached work case and optional short brief.'), properties: { case: { type: 'string' as const, pattern: '\\S', description: t('Open case key or id.') }, brief: { type: 'string' as const, description: t('Short work brief, at most 2000 characters.') } }, additionalProperties: false as const } })),
];

/** Validate the same small JSON Schema vocabulary advertised by tools/list. */
function matches(schema: Schema, value: unknown): boolean {
  if (schema.enum && !schema.enum.includes(value as string)) return false;
  if (schema.type === 'string' && (typeof value !== 'string' || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value) || value < (schema.minimum ?? -Infinity))) return false;
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.items && value.some(item => !matches(schema.items!, item))) return false;
  }
  if (schema.type === 'object' || schema.properties || schema.required) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (schema.required?.some(key => record[key] === undefined)) return false;
    if (Object.entries(record).some(([key, item]) => schema.properties?.[key] ? !matches(schema.properties[key], item) : schema.additionalProperties === false)) return false;
  }
  return !schema.anyOf || schema.anyOf.some(option => matches(option, value));
}

/**
 * The schemas as listed to engines. Model APIs reject `anyOf`/`oneOf`/`allOf` at the top level of a tool's input schema,
 * and Claude Code then drops the tool without a word, so the listed copy leaves the top-level combinators out; calls are
 * still checked against the full schema by `validateProducerToolCall`.
 */
export function listedProducerToolSchemas(): typeof PRODUCER_TOOL_SCHEMAS {
  return PRODUCER_TOOL_SCHEMAS.map(tool => {
    const { anyOf: _anyOf, ...rest } = tool.inputSchema as Schema & { oneOf?: unknown; allOf?: unknown };
    delete (rest as { oneOf?: unknown }).oneOf; delete (rest as { allOf?: unknown }).allOf;
    return { ...tool, inputSchema: rest };
  }) as typeof PRODUCER_TOOL_SCHEMAS;
}

export function producerActionInputError(detail = ''): Error {
  return new Error((detail ? `${detail} ` : '') + t('Invalid producer_act call. Valid kinds: {kinds}. Required fields: actions (1–20 items), each with {fields} (non-empty strings). Optional note/reason must be strings; evidence must contain at most 20 strings.', { kinds: PRODUCER_ACTIONS.join(', '), fields: PRODUCER_ACTION_REQUIRED.join(', ') }));
}

/** Describe the first schema violation with its exact field path. */
function schemaError(schema: Schema, value: unknown, at = 'arguments'): string {
  if (matches(schema, value)) return '';
  if (schema.enum && !schema.enum.includes(value as string)) return `${at} must be one of: ${schema.enum.join(', ')}.`;
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (record[key] === undefined) return `${at}.${key} is required.`;
    for (const [key, item] of Object.entries(record)) {
      if (!schema.properties?.[key] && schema.additionalProperties === false) return `${at}.${key} is an unknown field.`;
      if (schema.properties?.[key] && !matches(schema.properties[key], item)) return schemaError(schema.properties[key], item, `${at}.${key}`);
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) for (const [i, item] of value.entries()) if (!matches(schema.items, item)) return schemaError(schema.items, item, `${at}[${i}]`);
  return `${at} does not match its schema (${schema.type ?? 'required fields'}).`;
}

export function validateProducerToolCall(name: string, args: unknown): void {
  const tool = PRODUCER_TOOL_SCHEMAS.find(tool => tool.name === name);
  if (!tool) throw new Error(t('Unknown producer tool "{name}".', { name }));
  const read = args as Record<string, unknown> | null;
  const validRead = name !== 'producer_read' || (read?.kind !== 'order' || typeof read.tag === 'string')
    && (read?.since === undefined || typeof read.since === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(read.since) && Number.isFinite(Date.parse(read.since)));
  const actions = name === 'producer_act' ? (Array.isArray(read?.actions) ? read.actions : [read]) as Record<string, unknown>[] : [];
  const validReroutes = actions.every(a => a?.kind !== 'reroute' || typeof a.target === 'string' && !!a.target.trim() && typeof a.worker === 'string' && !!a.worker.trim() && typeof a.note === 'string' && !!a.note.trim() && a.note.length <= 2000);
  if (matches(tool.inputSchema, args) && validRead && validReroutes) return;
  if (name === 'producer_act') {
    const actions = (args as { actions?: unknown } | null)?.actions;
    const detail = Array.isArray(actions) && (actions.length < 1 || actions.length > PRODUCER_ACTION_LIMIT) ? t('producer_act accepts between 1 and 20 actions.')
      : Array.isArray(actions) && actions.some(item => !item || typeof item !== 'object' || Array.isArray(item)) ? t('Each producer action must be an object.') : '';
    throw producerActionInputError(detail || schemaError(tool.inputSchema, args));
  }
  if (name === 'producer_read') throw new Error(t('Invalid producer_read call. Valid kinds: {kinds}. Required fields: kind; tag (non-empty string) when kind is order. Optional page must be a non-negative integer.', { kinds: PRODUCER_READ_KINDS.join(', ') }));
  throw new Error(t('Invalid {name} arguments; use tools/list for fields and required types.', { name }));
}
