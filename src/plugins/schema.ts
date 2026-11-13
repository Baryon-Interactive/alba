import type { JsonSchema } from './manifest.ts';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks a value against the part of JSON schema an operation's input uses: type, properties, required, additionalProperties: false,
 * enum, items, minimum / maximum, minLength / maxLength, minItems / maxItems. Returns the first problem with where it is, or undefined.
 * Other keywords are left to the tool, which checks its own input again.
 */
export function schemaProblem(schema: JsonSchema, value: unknown, at = 'input'): string | undefined {
  const type = schema.type;
  const types = Array.isArray(type) ? type as string[] : typeof type === 'string' ? [type] : [];
  if (types.length && !types.some(t => isType(t, value))) return `${at} must be ${types.join(' or ')}`;
  if (Array.isArray(schema.enum) && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) return `${at} must be one of ${schema.enum.map(e => JSON.stringify(e)).join(', ')}`;
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${at} must be at most ${schema.maximum}`;
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${at} must have at least ${schema.minLength} characters`;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `${at} must have at most ${schema.maxLength} characters`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${at} must have at least ${schema.minItems} items`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${at} must have at most ${schema.maxItems} items`;
    if (record(schema.items)) for (const [i, item] of value.entries()) { const p = schemaProblem(schema.items, item, `${at}[${i}]`); if (p) return p; }
  }
  if (record(value)) {
    const props = record(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required as string[] : []) if (value[key] === undefined) return `${at}.${key} is required`;
    for (const [key, v] of Object.entries(value)) {
      const sub = props[key];
      if (record(sub)) { const p = schemaProblem(sub, v, `${at}.${key}`); if (p) return p; }
      else if (schema.additionalProperties === false) return `${at}.${key} is not an input of this operation (known: ${Object.keys(props).join(', ') || 'none'})`;
    }
  }
  return undefined;
}

function isType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return record(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}
