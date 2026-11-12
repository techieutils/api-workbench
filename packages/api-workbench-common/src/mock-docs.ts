import { stringify } from 'yaml';
import { swaggerDocument } from './documentation';
import { allowedContentTypes } from './mock-validation';
import { isStreamRoute, mockOrigin, mockPathParams, mockRouteKind } from './mocks';
import type { KeyValue, MockPathParam, MockRule, MockServer } from './types';

type ObjectValue = Record<string, unknown>;

/** The formats a mock server's API documentation can be shown in. */
export const MOCK_DOC_FORMATS = [
  'Reference',
  'OpenAPI JSON',
  'OpenAPI YAML',
  'Swagger JSON',
  'Swagger YAML',
  'Markdown',
] as const;
export type MockDocFormat = (typeof MOCK_DOC_FORMATS)[number];

/** Methods an `ANY` route is documented under. */
const ANY_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const STREAM_TYPES = { sse: 'text/event-stream', ndjson: 'application/x-ndjson' } as const;

/** One documented operation of a mock: what the Reference view lists. */
export interface MockDocOperation {
  routeId: string;
  method: string;
  /** The path in OpenAPI form, such as `/users/{id}`. */
  path: string;
  summary: string;
  kind: ReturnType<typeof mockRouteKind>;
  parameters: {
    name: string;
    in: string;
    required: boolean;
    schema: ObjectValue;
    description?: string;
  }[];
  requestSchema?: unknown;
  /** The content types the request body may have; JSON when the route names none. */
  requestTypes: string[];
  responses: { status: string; description: string; contentType?: string; example?: string }[];
}

/** `/users/:id/*` as OpenAPI writes it: `/users/{id}/{wildcard}`. */
export function openAPIPath(path: string): string {
  return (
    path
      .split('/')
      .map((part) =>
        part === '*' ? '{wildcard}' : part.startsWith(':') ? `{${part.slice(1)}}` : part,
      )
      .join('/') || '/'
  );
}

function paramSchema(param: MockPathParam): ObjectValue {
  const values = (param.values ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const schema: ObjectValue =
    param.type === 'integer' || param.type === 'number' || param.type === 'boolean'
      ? { type: param.type }
      : param.type === 'uuid'
        ? { type: 'string', format: 'uuid' }
        : param.type === 'date'
          ? { type: 'string', format: 'date' }
          : param.type === 'enum' && values.length
            ? { type: 'string', enum: values }
            : param.type === 'pattern' && param.values
              ? { type: 'string', pattern: param.values }
              : { type: 'string' };
  if (param.example) schema.example = param.example;
  return schema;
}

/** A query or header a route's validation requires, as an OpenAPI parameter. */
function checkParameter(check: MockRule): MockDocOperation['parameters'][number] | undefined {
  if (
    !check.enabled ||
    !check.name.trim() ||
    (check.target !== 'query' && check.target !== 'header')
  )
    return undefined;
  const values = check.value
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const schema: ObjectValue =
    check.operator === 'is-integer'
      ? { type: 'integer' }
      : check.operator === 'is-number'
        ? { type: 'number' }
        : check.operator === 'is-boolean'
          ? { type: 'boolean' }
          : check.operator === 'is-uuid'
            ? { type: 'string', format: 'uuid' }
            : check.operator === 'is-email'
              ? { type: 'string', format: 'email' }
              : check.operator === 'is-date'
                ? { type: 'string', format: 'date' }
                : check.operator === 'is-url'
                  ? { type: 'string', format: 'uri' }
                  : check.operator === 'is-ip'
                    ? { type: 'string', format: 'ipv4' }
                    : check.operator === 'one-of' && values.length
                      ? { type: 'string', enum: values }
                      : check.operator === 'matches' && check.value
                        ? {
                            type: 'string',
                            pattern: check.value.replace(/^\/([\s\S]*)\/[a-z]*$/, '$1'),
                          }
                        : check.operator === 'equals' && check.value
                          ? { type: 'string', enum: [check.value] }
                          : { type: 'string' };
  return {
    name: check.name.trim(),
    in: check.target,
    required: check.operator !== 'missing',
    schema,
  };
}

const headerValue = (headers: KeyValue[], name: string) =>
  headers.find((row) => row.enabled && row.key.trim().toLowerCase() === name)?.value.trim();

/** A body as an example: parsed JSON when it is JSON, otherwise its text. */
function example(body: string, contentType = ''): unknown {
  if (!body) return undefined;
  if (/json/i.test(contentType) || /^\s*[[{]/.test(body))
    try {
      return JSON.parse(body);
    } catch {
      // A templated body such as {"id": {{params.id}}} is not JSON yet; show it as written.
    }
  return body;
}

const statusText = (status: number) =>
  status >= 500
    ? 'Server error'
    : status >= 400
      ? 'Client error'
      : status >= 300
        ? 'Redirect'
        : status === 204
          ? 'No content'
          : 'Success';

/** The operations a mock documents: its enabled HTTP, SSE, and NDJSON routes. */
export function mockDocOperations(mock: MockServer): MockDocOperation[] {
  const operations: MockDocOperation[] = [];
  for (const route of mock.routes) {
    const kind = mockRouteKind(route);
    // OpenAPI describes HTTP answers only, so live protocols with their own transports are left out.
    if (!route.enabled || ['websocket', 'grpc', 'socketio', 'mqtt'].includes(kind)) continue;
    const path = openAPIPath(route.path);
    const parameters: MockDocOperation['parameters'] = mockPathParams(route).map((param) => ({
      name: param.name,
      in: 'path',
      required: true,
      schema: paramSchema(param),
      ...(param.description ? { description: param.description } : {}),
    }));
    if (route.path.split('/').includes('*'))
      parameters.push({
        name: 'wildcard',
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'The rest of the path.',
      });
    const validation = route.validation?.enabled ? route.validation : undefined;
    for (const check of validation?.checks ?? []) {
      const parameter = checkParameter(check);
      if (parameter && !parameters.some((p) => p.name === parameter.name && p.in === parameter.in))
        parameters.push(parameter);
    }
    let requestSchema: unknown;
    if (validation?.schema?.trim())
      try {
        requestSchema = JSON.parse(validation.schema);
      } catch {
        requestSchema = undefined;
      }
    const responses: MockDocOperation['responses'] = [];
    const add = (status: number, description: string, headers: KeyValue[], body: string) => {
      const key = String(status);
      if (responses.some((response) => response.status === key)) return;
      const contentType = isStreamRoute(route)
        ? STREAM_TYPES[kind as keyof typeof STREAM_TYPES]
        : headerValue(headers, 'content-type') || (body ? 'text/plain' : undefined);
      responses.push({
        status: key,
        description,
        ...(contentType ? { contentType } : {}),
        ...(isStreamRoute(route)
          ? {
              example: (route.stream?.messages ?? []).map((message) => message.data).join('\n'),
            }
          : body
            ? { example: body }
            : {}),
      });
    };
    add(
      route.status || 200,
      route.name || statusText(route.status || 200),
      route.headers,
      route.body,
    );
    for (const response of route.responses ?? [])
      add(
        response.status,
        response.name || statusText(response.status),
        response.headers,
        response.body,
      );
    if (validation) add(validation.status ?? 422, 'Request validation failed', [], '');
    const methods = route.method === 'ANY' ? ANY_METHODS : [route.method.toLowerCase()];
    for (const method of methods)
      operations.push({
        routeId: route.id,
        method: method.toUpperCase(),
        path,
        summary: route.name || `${route.method} ${route.path}`,
        kind,
        parameters,
        ...(requestSchema !== undefined ? { requestSchema } : {}),
        requestTypes: (validation ? allowedContentTypes(validation) : []).filter(
          (type) => !type.includes('*'),
        ),
        responses,
      });
  }
  return operations;
}

/** An OpenAPI 3.0 document of what the mock answers, with its address as the server. */
export function mockOpenAPIDocument(mock: MockServer): ObjectValue {
  const paths: Record<string, ObjectValue> = {};
  for (const operation of mockDocOperations(mock)) {
    const item = (paths[operation.path] ??= {});
    const method = operation.method.toLowerCase();
    if (item[method]) continue;
    item[method] = {
      summary: operation.summary,
      operationId: `${method}${operation.path
        .replace(/[{}]/g, '')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('')}`,
      ...(operation.kind !== 'http' ? { 'x-workbench-stream': operation.kind } : {}),
      parameters: operation.parameters.map(({ schema, ...rest }) => ({ ...rest, schema })),
      ...(operation.requestSchema !== undefined && !['get', 'head'].includes(method)
        ? {
            requestBody: {
              required: true,
              content: Object.fromEntries(
                (operation.requestTypes.length ? operation.requestTypes : ['application/json']).map(
                  (type) => [type, { schema: operation.requestSchema }],
                ),
              ),
            },
          }
        : {}),
      responses: Object.fromEntries(
        operation.responses.map((response) => [
          response.status,
          {
            description: response.description,
            ...(response.contentType
              ? {
                  content: {
                    [response.contentType.split(';')[0].trim()]: {
                      ...(response.example !== undefined
                        ? { example: example(response.example, response.contentType) }
                        : {}),
                    },
                  },
                }
              : {}),
          },
        ]),
      ),
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: mock.name,
      version: '1.0.0',
      description: `Served by the API Workbench mock server “${mock.name}”.`,
    },
    servers: [{ url: mockOrigin(mock), description: 'Local mock server' }],
    paths,
  };
}

/** The mock's API reference as Markdown, for a README or a wiki. */
export function mockMarkdown(mock: MockServer): string {
  const lines = [`# ${mock.name}`, '', `Base URL: \`${mockOrigin(mock)}\``, ''];
  const fence = (text: string) => {
    const ticks = text.includes('```') ? '````' : '```';
    return [ticks, text, ticks];
  };
  for (const operation of mockDocOperations(mock)) {
    lines.push(`## ${operation.method} ${operation.path}`, '');
    if (operation.summary !== `${operation.method} ${operation.path}`)
      lines.push(operation.summary, '');
    if (operation.parameters.length) {
      lines.push('| Name | In | Required | Type |', '| --- | --- | --- | --- |');
      for (const parameter of operation.parameters)
        lines.push(
          `| \`${parameter.name}\` | ${parameter.in} | ${parameter.required ? 'yes' : 'no'} | ${schemaLabel(parameter.schema)} |`,
        );
      lines.push('');
    }
    if (operation.requestSchema !== undefined)
      lines.push(
        'Request body schema:',
        '',
        ...fence(JSON.stringify(operation.requestSchema, null, 2)),
        '',
      );
    for (const response of operation.responses) {
      lines.push(
        `**${response.status}** ${response.description}${response.contentType ? ` · \`${response.contentType}\`` : ''}`,
        '',
      );
      if (response.example) lines.push(...fence(response.example), '');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** A parameter's schema in a few words, such as `string (uuid)` or `one of a, b`. */
export function schemaLabel(schema: ObjectValue): string {
  if (Array.isArray(schema.enum)) return `one of ${(schema.enum as string[]).join(', ')}`;
  const type = String(schema.type ?? 'string');
  if (schema.format) return `${type} (${String(schema.format)})`;
  if (schema.pattern) return `${type} matching \`${String(schema.pattern)}\``;
  return type;
}

/** Swagger 2.0 lists response media types in `produces` and examples by type, not `content`. */
function swaggerResponses(document: ObjectValue): ObjectValue {
  const paths = document.paths as Record<string, Record<string, ObjectValue>>;
  for (const item of Object.values(paths))
    for (const operation of Object.values(item)) {
      const produces = new Set<string>();
      const responses = operation.responses as Record<string, ObjectValue>;
      for (const [status, response] of Object.entries(responses)) {
        const content = response.content as Record<string, { example?: unknown }> | undefined;
        if (!content) continue;
        const examples: ObjectValue = {};
        for (const [type, media] of Object.entries(content)) {
          produces.add(type);
          if (media.example !== undefined) examples[type] = media.example;
        }
        const { content: _content, ...rest } = response;
        void _content;
        responses[status] = { ...rest, ...(Object.keys(examples).length ? { examples } : {}) };
      }
      if (produces.size) operation.produces = [...produces];
    }
  return document;
}

/** The mock's documentation in a format, with the file extension and type it saves as. */
export function mockDocumentation(
  mock: MockServer,
  format: Exclude<MockDocFormat, 'Reference'>,
): { text: string; extension: string; mime: string; kind: string } {
  if (format === 'Markdown')
    return { text: mockMarkdown(mock), extension: 'md', mime: 'text/markdown', kind: 'api' };
  const openapi = mockOpenAPIDocument(mock);
  const swagger = format.startsWith('Swagger');
  const value = swagger ? swaggerResponses(swaggerDocument(openapi)) : openapi;
  const yaml = format.endsWith('YAML');
  return {
    text: yaml ? stringify(value, { lineWidth: 0 }) : JSON.stringify(value, null, 2),
    extension: yaml ? 'yaml' : 'json',
    mime: yaml ? 'application/yaml' : 'application/json',
    kind: swagger ? 'swagger' : 'openapi',
  };
}
