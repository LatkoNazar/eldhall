/** Deliberately small, bounded JSON Schema subset for configured read-tool inputs. */
export interface InputSchema extends Record<string, unknown> {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, InputSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: InputSchema;
  enum?: (string | number | boolean | null)[];
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

export const safeKey = (key: string) => /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key) && !['__proto__', 'constructor', 'prototype', 'eldhall'].includes(key);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function validateInputSchema(value: unknown, depth = 0): asserts value is InputSchema {
  if (!object(value) || depth > 5 || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(value.type))) throw new Error('Unsupported inputSchema type or nesting');
  const keys = ['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'maxLength', 'maxItems', 'minimum', 'maximum'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unsupported inputSchema keyword');
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 500)) throw new Error('Invalid schema description');
  if (value.type === 'object') {
    if (!object(value.properties) || Object.keys(value.properties).length > 30 || value.additionalProperties !== false) throw new Error('Object schemas require properties and additionalProperties:false');
    for (const [key, schema] of Object.entries(value.properties)) {
      if (!safeKey(key)) throw new Error('Invalid schema property');
      validateInputSchema(schema, depth + 1);
    }
    if (value.required !== undefined && (!Array.isArray(value.required) || new Set(value.required).size !== value.required.length || value.required.some(key => typeof key !== 'string' || !Object.hasOwn(value.properties!, key)))) throw new Error('Invalid required properties');
  } else if (value.properties !== undefined || value.required !== undefined || value.additionalProperties !== undefined) throw new Error('Object schema keywords require object type');
  if (value.type === 'array') validateInputSchema(value.items, depth + 1);
  else if (value.items !== undefined) throw new Error('items requires array type');
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 50 || value.enum.some(x => x !== null && (!['string', 'number', 'boolean'].includes(typeof x) || (typeof x === 'number' && !Number.isFinite(x)))))) throw new Error('Invalid schema enum');
  for (const [key, max] of [['maxLength', 4000], ['maxItems', 50]] as const) {
    const limit = value[key];
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > max)) throw new Error('Invalid schema limit');
  }
  for (const key of ['minimum', 'maximum']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw new Error('Invalid numeric schema bound');
}

export function validateToolInput(schema: InputSchema, value: unknown): void {
  if (schema.type === 'object') {
    if (!object(value)) throw new Error('Expected object input');
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties!, key))) throw new Error('Unexpected input property');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error('Missing input property');
    for (const [key, item] of Object.entries(value)) validateToolInput(schema.properties![key]!, item);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 50)) throw new Error('Invalid array input');
    for (const item of value) validateToolInput(schema.items!, item);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? 4000)) throw new Error('Invalid string input');
  } else if (schema.type === 'null') {
    if (value !== null) throw new Error('Expected null input');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('Invalid boolean input');
  } else if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error('Invalid numeric input');
  if (schema.enum && !schema.enum.includes(value as string | number | boolean | null)) throw new Error('Input is not an allowed enum value');
}
