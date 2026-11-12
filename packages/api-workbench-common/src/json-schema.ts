// JSON Schema validation, for mock request bodies and response tests.
import { untrustedRegExp } from './regex-safety';

export type Schema = Record<string, unknown>;
export const isObject = (value: unknown): value is Schema =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const typeOf = (value: unknown): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : Number.isInteger(value)
        ? 'integer'
        : typeof value;
export const FORMATS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  uri: /^[a-z][a-z0-9+.-]*:\S+$/i,
  'uri-reference': /^\S*$/,
  ipv4: /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
  ipv6: /^(?=.*:)[0-9a-f:.]{2,45}$/i,
  hostname:
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i,
  time: /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  byte: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
};
/** A JSON path for a problem, such as `items[0].sku`; empty for the whole value. */
const join = (path: string, key: string | number) =>
  typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
const describe = (value: unknown) =>
  typeof value === 'string' ? `"${value}"` : JSON.stringify(value);

/**
 * What is wrong with `value` against a JSON Schema: the common keywords (type and OpenAPI's
 * nullable, enum, const, required, properties, additionalProperties, items, lengths, sizes,
 * ranges, pattern, format, allOf, anyOf, oneOf), each problem with the path it is at.
 */
export function validateJsonSchema(
  value: unknown,
  schema: unknown,
  path = '',
  depth = 0,
  root: unknown = schema,
): { path: string; message: string }[] {
  if (schema === false) return [{ path, message: 'is not allowed' }];
  if (!isObject(schema) || depth > 32) return [];
  const problems: { path: string; message: string }[] = [];
  const fail = (message: string, at = path) => problems.push({ path: at, message });
  const check = (item: unknown, part: unknown, at = path) =>
    validateJsonSchema(item, part, at, depth + 1, root);
  // A local reference, such as #/definitions/Item, #/$defs/Item, or #/components/schemas/Item.
  if (typeof schema.$ref === 'string') {
    const target = resolvePointer(root, schema.$ref);
    if (target === undefined) return problems;
    const { $ref: _ref, ...rest } = schema;
    void _ref;
    return [...check(value, target), ...(Object.keys(rest).length ? check(value, rest) : [])];
  }
  if (value === null && schema.nullable === true) return problems;
  const types = (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []).map(
    String,
  );
  const actual = typeOf(value);
  if (
    types.length &&
    !types.some((type) => type === actual || (type === 'number' && actual === 'integer'))
  ) {
    fail(`must be ${types.join(' or ')}, not ${actual}`);
    return problems;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    fail(`must be one of ${schema.enum.map(describe).join(', ')}`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value))
    fail(`must be ${describe(schema.const)}`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      fail(`must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      fail(`must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string') {
      try {
        if (!untrustedRegExp(schema.pattern, 'u').test(value))
          fail(`must match /${schema.pattern}/`);
      } catch {
        // A pattern this engine cannot read, or one that could take minutes to match
        // (`regex-safety.ts`), is not held against the request.
      }
    }
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format && !format.test(value)) fail(`must be a valid ${schema.format}`);
  }
  if (typeof value === 'number') {
    const below = (limit: unknown, exclusive: unknown) =>
      typeof limit === 'number' && (exclusive === true ? value <= limit : value < limit);
    const above = (limit: unknown, exclusive: unknown) =>
      typeof limit === 'number' && (exclusive === true ? value >= limit : value > limit);
    if (below(schema.minimum, schema.exclusiveMinimum))
      fail(
        `must be ${schema.exclusiveMinimum === true ? 'more than' : 'at least'} ${schema.minimum}`,
      );
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
      fail(`must be more than ${schema.exclusiveMinimum}`);
    if (above(schema.maximum, schema.exclusiveMaximum))
      fail(
        `must be ${schema.exclusiveMaximum === true ? 'less than' : 'at most'} ${schema.maximum}`,
      );
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum)
      fail(`must be less than ${schema.exclusiveMaximum}`);
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const ratio = value / schema.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9)
        fail(`must be a multiple of ${schema.multipleOf}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      fail(`must have at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      fail(`must have at most ${schema.maxItems} item${schema.maxItems === 1 ? '' : 's'}`);
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      fail('must not repeat items');
    // Tuples: prefixItems (2020-12) or an items array (draft 4–7), then the rest.
    const tuple = Array.isArray(schema.prefixItems)
      ? schema.prefixItems
      : Array.isArray(schema.items)
        ? schema.items
        : undefined;
    if (tuple) {
      tuple.forEach((part, index) => {
        if (index < value.length) problems.push(...check(value[index], part, join(path, index)));
      });
      const rest = Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems;
      value.slice(tuple.length).forEach((item, offset) => {
        const index = tuple.length + offset;
        if (rest === false) fail('is not allowed', join(path, index));
        else if (isObject(rest)) problems.push(...check(item, rest, join(path, index)));
      });
    }
    if (schema.contains !== undefined) {
      const count = value.filter((item) => !check(item, schema.contains).length).length;
      const min = typeof schema.minContains === 'number' ? schema.minContains : 1;
      if (count < min)
        fail(
          min === 1
            ? 'must contain a matching item'
            : `must contain at least ${min} matching items`,
        );
      if (typeof schema.maxContains === 'number' && count > schema.maxContains)
        fail(`must contain at most ${schema.maxContains} matching items`);
    }
    if (isObject(schema.items) && !tuple)
      value.forEach((item, index) =>
        problems.push(...check(item, schema.items, join(path, index))),
      );
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required.map(String) : [])
      if (!(name in value)) fail('is required', join(path, name));
    const patterns = isObject(schema.patternProperties)
      ? Object.entries(schema.patternProperties).flatMap(([source, part]) => {
          try {
            return [[untrustedRegExp(source, 'u'), part] as const];
          } catch {
            return [];
          }
        })
      : [];
    const dependent = isObject(schema.dependentRequired) ? schema.dependentRequired : {};
    for (const [name, needs] of Object.entries(dependent))
      if (name in value && Array.isArray(needs))
        for (const need of needs.map(String))
          if (!(need in value)) fail(`is required when ${name} is present`, join(path, need));
    for (const [name, item] of Object.entries(value)) {
      if (schema.propertyNames !== undefined)
        for (const problem of check(name, schema.propertyNames))
          fail(`name ${problem.message}`, join(path, name));
      const matching = patterns.filter(([pattern]) => pattern.test(name));
      for (const [, part] of matching) problems.push(...check(item, part, join(path, name)));
      if (name in properties) problems.push(...check(item, properties[name], join(path, name)));
      else if (matching.length) continue;
      else if (schema.additionalProperties === false) fail('is not allowed', join(path, name));
      else if (isObject(schema.additionalProperties))
        problems.push(...check(item, schema.additionalProperties, join(path, name)));
    }
    const count = Object.keys(value).length;
    if (typeof schema.minProperties === 'number' && count < schema.minProperties)
      fail(`must have at least ${schema.minProperties} properties`);
    if (typeof schema.maxProperties === 'number' && count > schema.maxProperties)
      fail(`must have at most ${schema.maxProperties} properties`);
  }
  if (Array.isArray(schema.allOf))
    for (const part of schema.allOf) problems.push(...check(value, part));
  const passing = (parts: unknown[]) => parts.filter((part) => !check(value, part).length).length;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length && !passing(schema.anyOf))
    fail('must match at least one of the allowed shapes');
  if (Array.isArray(schema.oneOf) && schema.oneOf.length && passing(schema.oneOf) !== 1)
    fail('must match exactly one of the allowed shapes');
  if (schema.not !== undefined && !check(value, schema.not).length)
    fail('must not match the excluded shape');
  if (schema.if !== undefined) {
    const branch = check(value, schema.if).length ? schema.else : schema.then;
    if (branch !== undefined) problems.push(...check(value, branch));
  }
  return problems;
}

/** The schema a local JSON pointer such as `#/$defs/Item` names, or undefined. */
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
