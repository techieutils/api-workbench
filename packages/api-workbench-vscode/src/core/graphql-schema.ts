/**
 * A GraphQL endpoint's schema, as `request schema --json` prints it, and suggestions for the
 * request editor's Query from it: fields of the type at the cursor, a field's arguments, enum
 * values, types, and variables. The query is only read, token by token; nothing in it is run.
 * A schema comes from a server, so it is checked before use and only ever shown as text.
 */

export interface SchemaField {
  name: string;
  type: string;
  description?: string;
  deprecated?: string;
  args?: SchemaValue[];
}
export interface SchemaValue {
  name: string;
  type: string;
  description?: string;
  defaultValue?: string;
}
export interface SchemaType {
  name: string;
  kind: string;
  description?: string;
  fields?: SchemaField[];
  inputFields?: SchemaValue[];
  enumValues?: { name: string; description?: string; deprecated?: boolean }[];
}
export interface GraphqlSchema {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  types: SchemaType[];
}

/** What the request editor knows of a request's schema. */
export interface SchemaState {
  status: 'loading' | 'ready' | 'error';
  schema?: GraphqlSchema;
  message?: string;
  /** When it was fetched, as the editor shows it. */
  fetchedAt?: string;
}

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const TYPE = /^[[\]!_0-9A-Za-z]+$/;
const short = (value: unknown, max = 1000) =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

/** A schema from the command line's JSON, keeping only well-formed names and types. */
export function schemaFrom(value: unknown): GraphqlSchema | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const given = value as Record<string, unknown>;
  if (!Array.isArray(given.types)) return undefined;
  const named = (item: unknown) =>
    typeof item === 'string' && NAME.test(item) && item.length <= 200 ? item : undefined;
  const values = (list: unknown): SchemaValue[] =>
    (Array.isArray(list) ? list : []).flatMap((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      const name = named(entry.name);
      const type = typeof entry.type === 'string' && TYPE.test(entry.type) ? entry.type : undefined;
      if (!name || !type) return [];
      return [
        {
          name,
          type,
          ...(short(entry.description) ? { description: short(entry.description) } : {}),
          ...(short(entry.defaultValue) ? { defaultValue: short(entry.defaultValue) } : {}),
        },
      ];
    });
  const types: SchemaType[] = [];
  for (const item of given.types.slice(0, 10_000)) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const name = named(entry.name);
    if (!name || typeof entry.kind !== 'string') continue;
    const fields = (Array.isArray(entry.fields) ? entry.fields : []).flatMap((raw) => {
      const field = (raw ?? {}) as Record<string, unknown>;
      const [value] = values([field]);
      if (!value) return [];
      const args = values(field.args);
      return [
        {
          name: value.name,
          type: value.type,
          ...(value.description ? { description: value.description } : {}),
          ...(short(field.deprecated) ? { deprecated: short(field.deprecated) } : {}),
          ...(args.length ? { args } : {}),
        },
      ];
    });
    const enumValues = (Array.isArray(entry.enumValues) ? entry.enumValues : []).flatMap((raw) => {
      const value = (raw ?? {}) as Record<string, unknown>;
      const valueName = named(value.name);
      return valueName
        ? [
            {
              name: valueName,
              ...(short(value.description) ? { description: short(value.description) } : {}),
              ...(value.deprecated === true ? { deprecated: true } : {}),
            },
          ]
        : [];
    });
    const inputFields = values(entry.inputFields);
    types.push({
      name,
      kind: entry.kind.slice(0, 20),
      ...(short(entry.description) ? { description: short(entry.description) } : {}),
      ...(fields.length ? { fields } : {}),
      ...(inputFields.length ? { inputFields } : {}),
      ...(enumValues.length ? { enumValues } : {}),
    });
  }
  return {
    ...(named(given.queryType) ? { queryType: named(given.queryType) } : {}),
    ...(named(given.mutationType) ? { mutationType: named(given.mutationType) } : {}),
    ...(named(given.subscriptionType) ? { subscriptionType: named(given.subscriptionType) } : {}),
    types,
  };
}

/** The named type of a reference: `Order` from `[Order!]!`. */
export const namedType = (type: string): string => type.replace(/[[\]!]/g, '');

export interface Completion {
  label: string;
  kind: 'field' | 'argument' | 'type' | 'value' | 'keyword' | 'variable';
  /** The type, shown beside it. */
  detail?: string;
  description?: string;
  deprecated?: string;
  /** What is typed in; the label when not given. */
  insert?: string;
}

/**
 * The query with its strings and comments blanked out, the same length, so positions still match
 * and nothing inside them is read as syntax.
 */
function blanked(query: string): string {
  return query
    .replace(/"""[\s\S]*?(?:"""|$)/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*(?:"|$)/gm, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/#[^\n]*/g, (match) => ' '.repeat(match.length));
}

/**
 * Suggestions at `offset` in `query`, and where the word they replace starts. Empty in a string
 * or a comment, and where nothing is known.
 */
export function graphqlCompletions(
  query: string,
  offset: number,
  schema: GraphqlSchema,
): { from: number; items: Completion[] } {
  const text = blanked(query.slice(0, offset));
  const none = { from: offset, items: [] };
  // Inside a string or a comment, the blanked text differs from the query just before the cursor.
  if (
    offset > 0 &&
    text[offset - 1] === ' ' &&
    query[offset - 1] !== ' ' &&
    !/\s/.test(query[offset - 1])
  )
    return none;
  const word = /[_A-Za-z][_0-9A-Za-z]*$/.exec(text)?.[0] ?? '';
  const from = offset - word.length;
  const tokens = [
    ...text.slice(0, from).matchAll(/\.\.\.|[_A-Za-z][_0-9A-Za-z]*|[{}():$@[\]!=,]/g),
  ].map((match) => match[0]);
  const types = new Map(schema.types.map((type) => [type.name, type]));
  const typeOf = (name?: string) => (name ? types.get(name) : undefined);

  // Walk the tokens: selection sets and the type each is on, parentheses and what they hold.
  const stack: (string | undefined)[] = [];
  let operation: 'query' | 'mutation' | 'subscription' = 'query';
  let field: string | undefined;
  let pendingType: string | undefined;
  let expectType = false;
  let afterSpread = false;
  let parens: { kind: 'args' | 'variables'; field?: SchemaField; argument?: string } | undefined;
  const variables = new Map<string, string>();
  let variable: string | undefined;
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at];
    const next = tokens[at + 1];
    if (parens) {
      if (token === ')') {
        parens = undefined;
        continue;
      }
      if (parens.kind === 'variables') {
        if (token === '$' && next && NAME.test(next)) {
          variable = next;
          at++;
        } else if (variable && NAME.test(token) && tokens[at - 1] === ':') {
          variables.set(variable, token);
          variable = undefined;
        }
      } else if (NAME.test(token) && next === ':') parens.argument = token;
      continue;
    }
    if (token === '(') {
      if (!stack.length) parens = { kind: 'variables' };
      else {
        const parent = typeOf(stack[stack.length - 1]);
        parens = { kind: 'args', field: parent?.fields?.find((item) => item.name === field) };
      }
      continue;
    }
    if (token === '{') {
      const parent = stack.length ? typeOf(stack[stack.length - 1]) : undefined;
      const type =
        pendingType ??
        (stack.length
          ? (() => {
              const found = parent?.fields?.find((item) => item.name === field);
              return found ? namedType(found.type) : undefined;
            })()
          : operation === 'mutation'
            ? schema.mutationType
            : operation === 'subscription'
              ? schema.subscriptionType
              : schema.queryType);
      stack.push(type);
      pendingType = undefined;
      field = undefined;
      continue;
    }
    if (token === '}') {
      stack.pop();
      field = undefined;
      if (!stack.length) operation = 'query';
      continue;
    }
    if (token === '...') {
      afterSpread = true;
      continue;
    }
    if (token === 'on' && (afterSpread || tokens[at - 2] === 'fragment')) {
      expectType = true;
      continue;
    }
    if (expectType && NAME.test(token)) {
      pendingType = token;
      expectType = false;
      afterSpread = false;
      continue;
    }
    if (!stack.length && (token === 'query' || token === 'mutation' || token === 'subscription')) {
      operation = token;
      continue;
    }
    if (NAME.test(token) && stack.length) {
      afterSpread = false;
      // `alias: field` — the field is the name after the colon.
      if (next === ':') continue;
      field = token;
    }
  }

  const matches = (label: string) => label.toLowerCase().startsWith(word.toLowerCase());
  const last = tokens[tokens.length - 1];
  const variableItems = (): Completion[] =>
    [...variables].map(([name, type]) => ({
      label: `$${name}`,
      insert: name,
      kind: 'variable',
      detail: type,
    }));

  if (last === '$' || text.slice(0, from).endsWith('$'))
    return { from, items: variableItems().filter((item) => matches(item.insert!)) };
  if (parens?.kind === 'variables') {
    if (last !== ':' && last !== '[') return none;
    const items = schema.types
      .filter((type) => ['SCALAR', 'ENUM', 'INPUT_OBJECT'].includes(type.kind))
      .map((type): Completion => ({
        label: type.name,
        kind: 'type',
        detail: type.kind.toLowerCase().replace('_', ' '),
        description: type.description,
      }));
    return { from, items: items.filter((item) => matches(item.label)) };
  }
  if (parens?.kind === 'args') {
    const args = parens.field?.args ?? [];
    if (last === ':') {
      const argument = args.find((item) => item.name === parens!.argument);
      const type = argument ? typeOf(namedType(argument.type)) : undefined;
      const items: Completion[] = [
        ...(type?.enumValues ?? []).map((value): Completion => ({
          label: value.name,
          kind: 'value',
          detail: type!.name,
          description: value.description,
          ...(value.deprecated ? { deprecated: 'Deprecated' } : {}),
        })),
        ...(argument?.type === 'Boolean' || argument?.type === 'Boolean!'
          ? (['true', 'false'] as const).map((value): Completion => ({
              label: value,
              kind: 'value',
              detail: 'Boolean',
            }))
          : []),
      ];
      return { from, items: items.filter((item) => matches(item.label)) };
    }
    return {
      from,
      items: args
        .map((item): Completion => ({
          label: item.name,
          kind: 'argument',
          detail: item.type,
          description: item.description,
          insert: `${item.name}: `,
        }))
        .filter((item) => matches(item.label)),
    };
  }
  if (!stack.length) {
    if (last === 'on' || tokens[tokens.length - 1] === 'on')
      return { from, items: objectTypes(schema).filter((item) => matches(item.label)) };
    return {
      from,
      items: (['query', 'mutation', 'subscription', 'fragment'] as const)
        .filter((keyword) => keyword !== 'mutation' || schema.mutationType)
        .filter((keyword) => keyword !== 'subscription' || schema.subscriptionType)
        .map((keyword): Completion => ({ label: keyword, kind: 'keyword' }))
        .filter((item) => matches(item.label)),
    };
  }
  if (last === 'on')
    return { from, items: objectTypes(schema).filter((item) => matches(item.label)) };
  // A field's name is being typed after an alias's colon, or anywhere in a selection set.
  const current = typeOf(stack[stack.length - 1]);
  if (!current) return none;
  const items: Completion[] = [
    ...(current.fields ?? []).map((item): Completion => ({
      label: item.name,
      kind: 'field',
      detail: item.args?.some((arg) => arg.type.endsWith('!'))
        ? `${item.type} · needs ${item.args
            .filter((arg) => arg.type.endsWith('!'))
            .map((arg) => arg.name)
            .join(', ')}`
        : item.type,
      description: item.description,
      ...(item.deprecated ? { deprecated: item.deprecated } : {}),
    })),
    {
      label: '__typename',
      kind: 'field',
      detail: 'String!',
      description: `The name of the object's type.`,
    },
  ];
  // What matches by its start first, deprecated fields after the others.
  return {
    from,
    items: items
      .filter((item) => matches(item.label))
      .sort((a, b) => Number(Boolean(a.deprecated)) - Number(Boolean(b.deprecated))),
  };
}

const objectTypes = (schema: GraphqlSchema): Completion[] =>
  schema.types
    .filter((type) => ['OBJECT', 'INTERFACE', 'UNION'].includes(type.kind))
    .map((type) => ({
      label: type.name,
      kind: 'type',
      detail: type.kind.toLowerCase(),
      description: type.description,
    }));

/** Root fields and types matching `search`, for the schema list: `Query.orders(first: Int): [Order]`. */
export function schemaEntries(
  schema: GraphqlSchema,
  search: string,
  limit = 100,
): { title: string; detail: string; description?: string; deprecated?: string }[] {
  const wanted = search.trim().toLowerCase();
  const entries: { title: string; detail: string; description?: string; deprecated?: string }[] =
    [];
  const roots = [schema.queryType, schema.mutationType, schema.subscriptionType].filter(Boolean);
  const ordered = [
    ...roots.map((name) => schema.types.find((type) => type.name === name)).filter(Boolean),
    ...schema.types.filter((type) => !roots.includes(type.name)),
  ] as SchemaType[];
  for (const type of ordered) {
    if (entries.length >= limit) break;
    if (!wanted || type.name.toLowerCase().includes(wanted))
      entries.push({
        title: type.name,
        detail: type.kind.toLowerCase().replace('_', ' '),
        description: type.description,
      });
    for (const field of type.fields ?? []) {
      if (entries.length >= limit) break;
      if (wanted && !`${type.name}.${field.name}`.toLowerCase().includes(wanted)) continue;
      if (!wanted && !roots.includes(type.name)) continue;
      const args = field.args?.length
        ? `(${field.args.map((arg) => `${arg.name}: ${arg.type}`).join(', ')})`
        : '';
      entries.push({
        title: `${type.name}.${field.name}${args}`,
        detail: field.type,
        description: field.description,
        ...(field.deprecated ? { deprecated: field.deprecated } : {}),
      });
    }
  }
  return entries;
}
