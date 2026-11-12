import type { ApiRequest, HttpResponse } from '@techieutils/api-workbench-common/types';
import { UsageError } from './args';
import {
  findRequest,
  one,
  positionals,
  printable,
  protocolOf,
  variableAssignment,
  type CommandContext,
  type Parsed,
} from './command-kit';
import { runSource, type RunResult } from './run';
import { sourceFromTarget } from './source';
import type { RequestTarget } from './target';
import { terminalPassword, vaultAccess } from './vault';

/**
 * `request schema`: asks a GraphQL request's endpoint for its schema with an introspection query,
 * sent as the request is sent — its URL, headers, auth, and environment — and prints the schema
 * compactly, for editor suggestions. Nothing is saved, and no script runs: the query is ours.
 */

/** The standard introspection query, deep enough for `[[Type!]!]!`. */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind name description
      fields(includeDeprecated: true) {
        name description isDeprecated deprecationReason
        args { name description type { ...TypeRef } defaultValue }
        type { ...TypeRef }
      }
      inputFields { name description type { ...TypeRef } defaultValue }
      enumValues(includeDeprecated: true) { name description isDeprecated }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
}`;

export interface CompactField {
  name: string;
  /** As GraphQL writes it: `[Order!]!`. */
  type: string;
  description?: string;
  deprecated?: string;
  args?: { name: string; type: string; description?: string; defaultValue?: string }[];
}
export interface CompactType {
  name: string;
  kind: string;
  description?: string;
  fields?: CompactField[];
  inputFields?: { name: string; type: string; description?: string; defaultValue?: string }[];
  enumValues?: { name: string; description?: string; deprecated?: boolean }[];
}
export interface CompactSchema {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  types: CompactType[];
}

const MAX_TYPES = 10_000;
const MAX_TEXT = 1000;
const NAME = /^[_A-Za-z][_0-9A-Za-z]{0,199}$/;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined;
const name = (value: unknown) =>
  typeof value === 'string' && NAME.test(value) ? value : undefined;

/** A type reference as GraphQL writes it, from introspection's nested `ofType`. */
function typeRef(value: unknown, depth = 0): string | undefined {
  const ref = record(value);
  if (depth > 10) return undefined;
  if (ref.kind === 'NON_NULL') {
    const inner = typeRef(ref.ofType, depth + 1);
    return inner && `${inner}!`;
  }
  if (ref.kind === 'LIST') {
    const inner = typeRef(ref.ofType, depth + 1);
    return inner && `[${inner}]`;
  }
  return name(ref.name);
}

/** An introspection result made compact; what is malformed is left out, never trusted. */
export function compactSchema(data: unknown): CompactSchema | undefined {
  const schema = record(record(data).__schema);
  const types = list(schema.types);
  if (!types.length) return undefined;
  const values = (input: unknown) =>
    list(input).flatMap((item) => {
      const value = record(item);
      const valueName = name(value.name);
      const type = typeRef(value.type);
      if (!valueName || !type) return [];
      return [
        {
          name: valueName,
          type,
          ...(text(value.description) ? { description: text(value.description) } : {}),
          ...(typeof value.defaultValue === 'string'
            ? { defaultValue: value.defaultValue.slice(0, MAX_TEXT) }
            : {}),
        },
      ];
    });
  const compact: CompactSchema = {
    ...(name(record(schema.queryType).name)
      ? { queryType: name(record(schema.queryType).name) }
      : {}),
    ...(name(record(schema.mutationType).name)
      ? { mutationType: name(record(schema.mutationType).name) }
      : {}),
    ...(name(record(schema.subscriptionType).name)
      ? { subscriptionType: name(record(schema.subscriptionType).name) }
      : {}),
    types: [],
  };
  for (const item of types.slice(0, MAX_TYPES)) {
    const type = record(item);
    const typeName = name(type.name);
    // Introspection's own types (__Schema, __Type, …) are left out; __typename is offered anyway.
    if (!typeName || typeName.startsWith('__') || typeof type.kind !== 'string') continue;
    const fields = list(type.fields).flatMap((entry) => {
      const field = record(entry);
      const fieldName = name(field.name);
      const fieldType = typeRef(field.type);
      if (!fieldName || !fieldType) return [];
      const args = values(field.args);
      return [
        {
          name: fieldName,
          type: fieldType,
          ...(text(field.description) ? { description: text(field.description) } : {}),
          ...(field.isDeprecated === true
            ? { deprecated: text(field.deprecationReason) ?? 'Deprecated' }
            : {}),
          ...(args.length ? { args } : {}),
        },
      ];
    });
    const inputFields = values(type.inputFields);
    const enumValues = list(type.enumValues).flatMap((entry) => {
      const value = record(entry);
      const valueName = name(value.name);
      return valueName
        ? [
            {
              name: valueName,
              ...(text(value.description) ? { description: text(value.description) } : {}),
              ...(value.isDeprecated === true ? { deprecated: true } : {}),
            },
          ]
        : [];
    });
    compact.types.push({
      name: typeName,
      kind: type.kind.slice(0, 20),
      ...(text(type.description) ? { description: text(type.description) } : {}),
      ...(fields.length ? { fields } : {}),
      ...(inputFields.length ? { inputFields } : {}),
      ...(enumValues.length ? { enumValues } : {}),
    });
  }
  return compact;
}

export async function requestSchema(
  parsed: Parsed,
  target: RequestTarget,
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const [wanted] = positionals(parsed, ['request']);
  const request = findRequest(target.state, wanted);
  if (protocolOf(request) !== 'http')
    throw new UsageError(`${printable(request.name)} is not an HTTP request.`);
  const timeout = one(parsed, '--timeout');
  if (
    timeout !== undefined &&
    !(Number.isInteger(Number(timeout)) && Number(timeout) >= 100 && Number(timeout) <= 300000)
  )
    throw new UsageError('--timeout must be a whole number of milliseconds from 100 to 300000.');
  // The request as it is sent, asking for the schema instead: same URL, headers, and auth.
  const probe: ApiRequest = {
    ...structuredClone(request),
    method: 'POST',
    bodyType: 'raw',
    rawContentType: 'application/json',
    body: JSON.stringify({ query: INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' }),
    headers: [
      ...request.headers.filter((header) => header.key.trim().toLowerCase() !== 'content-type'),
      { enabled: true, key: 'Content-Type', value: 'application/json' },
    ],
    tests: '',
    captures: [],
  };
  delete probe.scripts;
  const source = sourceFromTarget(target);
  const vault = vaultAccess(
    target as RequestTarget & { dataDir?: string },
    context.password ?? terminalPassword(context.env),
  );
  let response: HttpResponse | { error: string } | undefined;
  let result: RunResult | undefined;
  await runSource(
    {
      ...source,
      workspace: {
        ...source.workspace,
        requests: source.workspace.requests.map((item) => (item.id === request.id ? probe : item)),
      },
      credentials: vault.credentials,
    },
    {
      command: 'run',
      source: '',
      collections: [],
      requests: [request.id],
      environment:
        one(parsed, '--environment') ?? target.state.environments[target.state.environment]?.name,
      variables: (parsed.values.get('--var') ?? []).map((item) =>
        variableAssignment(item, context.env),
      ),
      bail: false,
      insecure: parsed.flags.has('--insecure'),
      // Its own scripts would change a query that is not theirs; none run.
      scripts: 'skip',
      ...(timeout !== undefined ? { timeoutMs: Number(timeout) } : {}),
      reporters: new Set(),
      color: false,
      quiet: false,
      json: false,
    },
    undefined,
    context.interrupt,
    (sent, received) => {
      result = sent;
      response = received as HttpResponse | { error: string };
    },
  ).finally(() => vault.close());
  if (!result || !response) {
    output.err('Stopped before a response came.');
    return 130;
  }
  if ('error' in response && response.error !== undefined)
    throw new UsageError(`No response: ${printable(result.error ?? String(response.error))}`);
  const http = response as HttpResponse;
  let body: Record<string, unknown> = {};
  try {
    body = record(JSON.parse(http.body));
  } catch {
    /* Said below, with the status. */
  }
  const messages = list(body.errors)
    .map((error) => text(record(error).message))
    .filter(Boolean);
  const schema = compactSchema(body.data);
  if (!schema)
    throw new UsageError(
      messages.length
        ? `The server refused the introspection query: ${printable(messages[0]!)}`
        : http.status >= 400
          ? `The server answered ${http.status} ${printable(http.statusText)}. Check the request's URL and auth.`
          : 'The response has no schema: the server may have introspection turned off, or not be a GraphQL endpoint.',
    );
  if (parsed.flags.has('--json')) output.out(JSON.stringify(schema));
  else {
    const fieldsOf = (typeName?: string) =>
      schema.types.find((type) => type.name === typeName)?.fields?.length ?? 0;
    output.out(
      `${schema.types.length} types. Query: ${fieldsOf(schema.queryType)} fields${
        schema.mutationType ? `, Mutation: ${fieldsOf(schema.mutationType)}` : ''
      }${schema.subscriptionType ? `, Subscription: ${fieldsOf(schema.subscriptionType)}` : ''}.`,
    );
  }
  return 0;
}
