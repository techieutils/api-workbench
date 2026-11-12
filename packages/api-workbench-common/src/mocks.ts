import { untrustedRegExp } from './regex-safety';
import { isCalendarDate } from './assertions';
import { ownValue } from './own';
import { openAPIHelpers } from './collection-formats/openapi';
import { SPEC_METHODS } from './api-specs';
import {
  jsonPathValue,
  renderMockTemplate,
  type MockTemplateOptions,
  type MockTemplateRequest,
} from './mock-templates';
import type {
  ApiRequest,
  HttpResponse,
  KeyValue,
  MockCorsOptions,
  MockResponse,
  MockRoute,
  MockRouteKind,
  MockRule,
  MockRuleOperator,
  MockServer,
  MockPathParam,
  MockPathParamType,
  MockStream,
  MockValidation,
} from './types';

type ObjectValue = Record<string, unknown>;
export const MOCK_METHODS = [
  'ANY',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
];
export const DEFAULT_MOCK_PORT = 4010;
const newId = () => globalThis.crypto.randomUUID();

export const MOCK_ROUTE_KINDS: readonly MockRouteKind[] = [
  'http',
  'sse',
  'ndjson',
  'websocket',
  'grpc',
  'socketio',
  'mqtt',
];
export const DEFAULT_MOCK_GRPC_PORT = 50051;
export const DEFAULT_MOCK_MQTT_PORT = 1883;
/** Where a mock serves Socket.IO on its HTTP port: the Engine.IO path clients use by default. */
export const MOCK_SOCKETIO_PATH = '/socket.io';
/** Where a mock serves MQTT over WebSocket on its HTTP port. */
export const MOCK_MQTT_WEBSOCKET_PATH = '/mqtt';
export const mockRouteKind = (route: Pick<MockRoute, 'kind'>): MockRouteKind =>
  route.kind && MOCK_ROUTE_KINDS.includes(route.kind) ? route.kind : 'http';
/** Whether a route streams messages instead of answering once. */
export const isStreamRoute = (route: Pick<MockRoute, 'kind'>) => mockRouteKind(route) !== 'http';
/** The messages a new streaming route starts with, for its protocol. */
export function newMockStream(kind: MockRouteKind): MockStream {
  const message = (data: string, event?: string) => ({
    id: newId(),
    data,
    ...(event ? { event } : {}),
  });
  if (kind === 'sse')
    return {
      messages: [
        message('{"price": {{$randomInt 1 100}}}', 'price'),
        message('{"price": {{$randomInt 1 100}}}', 'price'),
      ],
      intervalMs: 1000,
      repeat: true,
    };
  if (kind === 'ndjson')
    return {
      messages: [
        message('{"id": 1, "status": "queued"}'),
        message('{"id": 1, "status": "running"}'),
        message('{"id": 1, "status": "done"}'),
      ],
      intervalMs: 500,
    };
  if (kind === 'websocket')
    return {
      messages: [message('{"type": "welcome", "at": "{{$isoTimestamp}}"}')],
      intervalMs: 1000,
      reply: '{"echo": {{body}}}',
    };
  if (kind === 'socketio')
    return {
      messages: [message('{"at": "{{$isoTimestamp}}"}', 'welcome')],
      intervalMs: 1000,
      reply: '{"echo": {{body}}}',
    };
  if (kind === 'mqtt')
    return {
      messages: [message('{"temperature": {{$randomInt 18 26}}, "at": "{{$isoTimestamp}}"}')],
      intervalMs: 1000,
      repeat: true,
      reply: '',
    };
  return { messages: [message('{}')], intervalMs: 500, reply: '' };
}
/**
 * What a client receives for a streamed message: an SSE event (each line of the data its own
 * `data:` line), or an NDJSON line (JSON compacted onto one line). Other protocols send it as is.
 */
export function mockStreamFrame(
  kind: MockRouteKind,
  data: string,
  options: { event?: string; id?: number } = {},
): string {
  if (kind === 'sse')
    return `${options.event ? `event: ${options.event.replace(/[\r\n]+/g, ' ')}\n` : ''}${
      options.id !== undefined ? `id: ${options.id}\n` : ''
    }${data
      .split(/\r?\n/)
      .map((line) => `data: ${line}`)
      .join('\n')}\n\n`;
  if (kind === 'ndjson') {
    try {
      return `${JSON.stringify(JSON.parse(data))}\n`;
    } catch {
      return `${data.replace(/\r?\n/g, ' ')}\n`;
    }
  }
  return data;
}
/**
 * Which routes a request can reach: HTTP requests (and the SSE and NDJSON streams they open),
 * WebSocket upgrades, gRPC calls, Socket.IO connections, or MQTT subscriptions and messages.
 */
export type MockTransport = 'http' | 'websocket' | 'grpc' | 'socketio' | 'mqtt';
const servesTransport = (route: MockRoute, transport: MockTransport) => {
  const kind = mockRouteKind(route);
  return transport === 'http'
    ? !['websocket', 'grpc', 'socketio', 'mqtt'].includes(kind)
    : kind === transport;
};
/**
 * The parameters an MQTT route's topic takes from a concrete topic, or undefined when it does not
 * match. `+` or `:name` matches one level (only `:name` is kept), `#` or `*` the rest.
 */
export function matchMqttTopic(pattern: string, topic: string): Record<string, string> | undefined {
  const want = pattern.replace(/^\//, '').split('/');
  const have = topic.replace(/^\//, '').split('/');
  const params: Record<string, string> = {};
  for (let index = 0; index < want.length; index++) {
    const part = want[index];
    if (part === '#' || part === '*') {
      params['*'] = have.slice(index).join('/');
      return params;
    }
    if (index >= have.length) return undefined;
    if (part === '+') continue;
    if (part.startsWith(':') && part.length > 1) params[part.slice(1)] = have[index];
    else if (part !== have[index]) return undefined;
  }
  return want.length === have.length ? params : undefined;
}
/** Whether an MQTT topic filter a client subscribed to (with `+` and `#`) takes a concrete topic. */
export function mqttFilterMatches(filter: string, topic: string): boolean {
  const want = filter.split('/');
  const have = topic.split('/');
  for (let index = 0; index < want.length; index++) {
    if (want[index] === '#') return true;
    if (index >= have.length) return false;
    if (want[index] !== '+' && want[index] !== have[index]) return false;
  }
  return want.length === have.length;
}
/** Whether an MQTT route's topic is one fixed topic, without wildcards or parameters. */
export const isFixedMqttTopic = (pattern: string) =>
  !pattern.split('/').some((part) => ['+', '#', '*'].includes(part) || part.startsWith(':'));
/** How a route's path is matched for a transport: MQTT topics by level, the rest as URL paths. */
const pathMatcher = (transport: MockTransport) =>
  transport === 'mqtt' ? matchMqttTopic : matchMockPath;
/** A route that answers GET / with an empty JSON object. */
export function newMockRoute(overrides: Partial<MockRoute> = {}): MockRoute {
  return {
    id: newId(),
    enabled: true,
    method: 'GET',
    path: '/',
    status: 200,
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    body: '{}',
    delayMs: 0,
    ...overrides,
  };
}
/** The first port from 4010 that no other mock server uses. */
export function freeMockPort(mocks: readonly MockServer[]): number {
  const used = new Set(mocks.map((mock) => mock.port));
  let port = DEFAULT_MOCK_PORT;
  while (used.has(port)) port++;
  return port;
}
/** The first port from 50051 that no mock server listens on, for HTTP or gRPC. */
export function freeMockGrpcPort(mocks: readonly MockServer[], ...taken: number[]): number {
  return freeFrom(DEFAULT_MOCK_GRPC_PORT, mocks, taken);
}
/** The first port from 1883 that no mock server listens on, for its MQTT broker. */
export function freeMockMqttPort(mocks: readonly MockServer[], ...taken: number[]): number {
  return freeFrom(DEFAULT_MOCK_MQTT_PORT, mocks, taken);
}
function freeFrom(start: number, mocks: readonly MockServer[], taken: number[]): number {
  const used = new Set([
    ...taken,
    ...mocks.flatMap((mock) => [mock.port, mock.grpc?.port ?? 0, mock.mqtt?.port ?? 0]),
  ]);
  let port = start;
  while (used.has(port)) port++;
  return port;
}
/**
 * Security headers a mock sends by default, as a careful API would. Strict-Transport-Security is
 * left out, since mocks serve plain HTTP, and Cross-Origin-Resource-Policy too, since it would
 * keep other origins' pages from loading what the mock answers.
 */
export const MOCK_SECURITY_HEADERS: readonly KeyValue[] = [
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
    enabled: true,
    description: 'Do not guess the media type',
  },
  { key: 'X-Frame-Options', value: 'DENY', enabled: true, description: 'Never shown in a frame' },
  { key: 'Referrer-Policy', value: 'no-referrer', enabled: true, description: 'Send no referrer' },
  {
    key: 'Content-Security-Policy',
    value: "default-src 'none'; frame-ancestors 'none'",
    enabled: true,
    description: 'Load nothing when opened as a page',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
    enabled: true,
    description: 'No device access',
  },
  {
    key: 'Cross-Origin-Opener-Policy',
    value: 'same-origin',
    enabled: true,
    description: 'Its own browsing context group',
  },
  { key: 'Cache-Control', value: 'no-store', enabled: true, description: 'Never cached' },
];
/** The security headers a mock lacks, by name, ready to add. */
export function missingSecurityHeaders(headers: readonly KeyValue[] = []): KeyValue[] {
  const present = new Set(headers.map((row) => row.key.trim().toLowerCase()));
  return MOCK_SECURITY_HEADERS.filter((row) => !present.has(row.key.toLowerCase())).map((row) => ({
    ...row,
  }));
}
/**
 * Response headers from layers, later ones winning by name, ignoring case: the defaults, then a
 * route's own. Disabled rows and rows without a name are skipped.
 */
export function mergeMockHeaders(
  ...layers: readonly (readonly KeyValue[] | undefined)[]
): KeyValue[] {
  const merged = new Map<string, KeyValue>();
  for (const layer of layers)
    for (const row of layer ?? [])
      if (row.enabled && row.key.trim()) merged.set(row.key.trim().toLowerCase(), row);
  return [...merged.values()];
}
export function newMock(
  name: string,
  mocks: readonly MockServer[],
  routes?: MockRoute[],
): MockServer {
  return {
    id: newId(),
    name,
    port: freeMockPort(mocks),
    cors: true,
    defaultHeaders: missingSecurityHeaders(),
    routes: routes ?? [newMockRoute({ path: '/health', body: '{\n  "status": "ok"\n}' })],
  };
}
/** The address a mock serves at: https when it serves HTTPS. */
export const mockOrigin = (mock: Pick<MockServer, 'port' | 'https'>) =>
  `${mock.https?.enabled ? 'https' : 'http'}://localhost:${mock.port}`;
/** Why a mock's HTTPS settings cannot work, if they cannot: both files, or neither. */
export function mockHttpsProblem(https: MockServer['https']): string | undefined {
  if (!https?.enabled) return undefined;
  if (Boolean(https.certFile) !== Boolean(https.keyFile))
    return 'Choose both a certificate and its key, or neither to use the API Workbench CA.';
}
/** Why a port cannot be used, if it cannot. */
export function mockPortProblem(port: number): string | undefined {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    return 'Choose a port from 1024 to 65535.';
}

const jsonHeader = (type = 'application/json'): KeyValue[] => [
  { key: 'Content-Type', value: type, enabled: true },
];
const pretty = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/**
 * Routes for every operation in an OpenAPI 3 or Swagger 2 document. Each answers with its first
 * success response (or the first one listed) and that response's example, or one built from its
 * schema. Paths keep the first server's base path, so a collection made from the same document
 * can point at the mock by changing only its host.
 */
export function mockRoutesFromSpec(document: ObjectValue): MockRoute[] {
  const { object, list, text, dereference, schemaExample } = openAPIHelpers(document);
  const swagger = document.swagger === '2.0';
  let base: string;
  if (swagger) base = text(document.basePath);
  else {
    const url = text(object(list(document.servers)[0]).url);
    try {
      base = url.startsWith('/') ? url : new URL(url).pathname;
    } catch {
      base = '';
    }
  }
  base = base.replace(/\{[^{}]*\}/g, '').replace(/\/+$/, '');
  const routes: MockRoute[] = [];
  for (const [path, rawItem] of Object.entries(object(document.paths))) {
    if (!path.startsWith('/')) continue;
    const item = dereference(rawItem);
    for (const method of SPEC_METHODS) {
      if (!item[method]) continue;
      const operation = dereference(item[method]);
      const responses = object(operation.responses);
      const codes = Object.keys(responses);
      const code =
        codes.filter((key) => /^2\d\d$/.test(key)).sort()[0] ??
        (codes.includes('default') ? 'default' : codes.find((key) => /^\d{3}$/.test(key)));
      const response = dereference(code ? responses[code] : undefined);
      let headers: KeyValue[] = [];
      let body = '';
      if (swagger) {
        const examples = object(response.examples);
        const type =
          Object.keys(examples)[0] ||
          text(list(operation.produces || document.produces)[0]) ||
          'application/json';
        const value =
          examples[type] ?? (response.schema ? schemaExample(response.schema) : undefined);
        if (value !== undefined) {
          headers = jsonHeader(type);
          body = pretty(value);
        }
      } else {
        const content = object(response.content);
        const type =
          Object.keys(content).find((key) => key === 'application/json') || Object.keys(content)[0];
        if (type) {
          const media = object(content[type]);
          const named = dereference(Object.values(object(media.examples))[0]);
          const value = media.example ?? named.value ?? schemaExample(media.schema);
          headers = jsonHeader(type);
          body = pretty(value);
        }
      }
      const pathParams = specPathParams(document, item, operation);
      // Typed path parameters are checked by validation, so a route with them validates.
      const validation =
        specValidation(document, item, operation, swagger) ??
        (pathParams.some((param) => param.type)
          ? { enabled: true, checks: [], status: 422 }
          : undefined);
      routes.push(
        newMockRoute({
          method: method.toUpperCase(),
          path: (base + path).replace(/\{([^{}]+)\}/g, ':$1') || '/',
          status: code && /^\d{3}$/.test(code) ? Number(code) : 200,
          headers,
          body,
          name: text(operation.summary || operation.operationId) || undefined,
          ...(validation ? { validation } : {}),
          ...(pathParams.length ? { pathParams } : {}),
        }),
      );
    }
  }
  return routes;
}

/**
 * An operation's path parameters as mock path parameters: their type (integer, number, boolean,
 * a uuid or date string), allowed values, or pattern, with an example and description.
 */
function specPathParams(
  document: ObjectValue,
  item: ObjectValue,
  operation: ObjectValue,
): MockPathParam[] {
  const { list, dereference } = openAPIHelpers(document);
  const params: MockPathParam[] = [];
  for (const raw of [...list(operation.parameters), ...list(item.parameters)]) {
    const parameter = dereference(raw);
    const name = typeof parameter.name === 'string' ? parameter.name : '';
    if (parameter.in !== 'path' || !name || params.some((param) => param.name === name)) continue;
    // Swagger 2 keeps the type on the parameter; OpenAPI 3 in its schema.
    const schema = parameter.schema ? dereference(parameter.schema) : parameter;
    const values = Array.isArray(schema.enum) ? schema.enum.map(String) : [];
    const type: MockPathParamType | undefined = values.length
      ? 'enum'
      : typeof schema.pattern === 'string'
        ? 'pattern'
        : schema.type === 'integer' || schema.type === 'number' || schema.type === 'boolean'
          ? schema.type
          : schema.format === 'uuid' || schema.format === 'date'
            ? schema.format
            : undefined;
    const example = parameter.example ?? schema.example;
    params.push({
      name,
      ...(type ? { type } : {}),
      ...(type === 'enum' ? { values: values.join(', ') } : {}),
      ...(type === 'pattern' ? { values: String(schema.pattern) } : {}),
      ...(example !== undefined ? { example: String(example) } : {}),
      ...(typeof parameter.description === 'string' && parameter.description
        ? { description: parameter.description }
        : {}),
    });
  }
  return params;
}
/** A schema with every `$ref` replaced by what it points to, stopping at cycles. */
function inlineSchema(
  dereference: (value: unknown) => ObjectValue,
  schema: unknown,
  seen: Set<string> = new Set(),
  depth = 0,
): unknown {
  if (Array.isArray(schema))
    return schema.map((item) => inlineSchema(dereference, item, seen, depth + 1));
  if (!schema || typeof schema !== 'object' || depth > 24) return schema;
  const ref = (schema as ObjectValue).$ref;
  if (typeof ref === 'string') {
    if (seen.has(ref)) return {};
    return inlineSchema(dereference, dereference(schema), new Set([...seen, ref]), depth + 1);
  }
  return Object.fromEntries(
    Object.entries(schema as ObjectValue)
      .filter(([key]) => !['example', 'examples', 'xml', 'externalDocs'].includes(key))
      .map(([key, value]) => [key, inlineSchema(dereference, value, seen, depth + 1)]),
  );
}
/**
 * Validation for an operation from its specification: its required query, header, and path
 * parameters must be present, and a JSON body must satisfy its schema. Undefined when the
 * operation requires nothing.
 */
function specValidation(
  document: ObjectValue,
  item: ObjectValue,
  operation: ObjectValue,
  swagger: boolean,
): MockValidation | undefined {
  const { object, list, dereference } = openAPIHelpers(document);
  const checks: MockRule[] = [];
  let schema: unknown;
  for (const raw of [...list(item.parameters), ...list(operation.parameters)]) {
    const parameter = dereference(raw);
    const name = typeof parameter.name === 'string' ? parameter.name : '';
    const where = parameter.in;
    if (where === 'body' && swagger) {
      if (parameter.schema) schema = parameter.schema;
      continue;
    }
    if (!name || !['query', 'header', 'path'].includes(where as string)) continue;
    if (where !== 'path' && parameter.required !== true) continue;
    // Path parameters always have a value when the route matches; their types are checked as path parameters.
    if (where === 'path') continue;
    if (checks.some((check) => check.target === where && check.name === name)) continue;
    checks.push({
      enabled: true,
      target: where as 'query' | 'header',
      name,
      operator: 'exists',
      value: '',
    });
  }
  if (!swagger) {
    const requestBody = dereference(operation.requestBody);
    const media = object(object(requestBody.content)['application/json']);
    if (media.schema && requestBody.required !== false) schema = media.schema;
  }
  const inlined = schema ? inlineSchema(dereference, schema) : undefined;
  if (!checks.length && !inlined) return undefined;
  return {
    enabled: true,
    checks,
    status: 422,
    ...(inlined ? { schema: JSON.stringify(inlined, null, 2) } : {}),
  };
}
/** A request URL's path, with `{{name}}` and `{name}` segments as `:name` parameters. */
export function mockPathOf(url: string): string {
  let path = url.split('#')[0].split('?')[0].trim();
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^\{\{[^}]+\}\}/, '');
  if (!path.startsWith('/')) path = '/' + path.replace(/^[^/]*\/?/, '');
  return (
    path
      .replace(/\{\{\s*([^}\s]+)\s*\}\}/g, ':$1')
      .replace(/\{([^{}]+)\}/g, ':$1')
      .replace(/\/{2,}/g, '/') || '/'
  );
}

/** The topic an MQTT request is about: its first subscription, or where it publishes. */
function mqttTopicOf(request: ApiRequest): string {
  const subscribed = request.mqtt?.subscriptions.find((item) => item.enabled && item.topic.trim());
  return (subscribed?.topic ?? request.mqtt?.topic ?? '').trim() || 'devices/+/status';
}
/**
 * Routes for a collection's HTTP requests, answering with each request's last response when it
 * has one. Only the first request for a method and path becomes a route.
 */
export function mockRoutesFromRequests(requests: readonly ApiRequest[]): MockRoute[] {
  const routes: MockRoute[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (request.protocol && request.protocol !== 'http') {
      // Live requests become streaming routes, with sample messages to edit.
      const kind = request.protocol;
      const path =
        kind === 'grpc'
          ? `/${(request.grpc?.method ?? '').replace(/^\//, '')}`
          : kind === 'mqtt'
            ? mqttTopicOf(request)
            : mockPathOf(request.url);
      const key = `${kind} ${path}`;
      if ((kind === 'grpc' && path === '/') || seen.has(key)) continue;
      seen.add(key);
      const stream = newMockStream(kind);
      // A saved outgoing WebSocket message is a fair guess at what the server says back.
      if (kind === 'websocket' && request.body?.trim()) stream.messages[0].data = request.body;
      // A Socket.IO request's event is the one its server most likely sends back.
      if (kind === 'socketio' && request.socketio?.event)
        stream.messages[0].event = request.socketio.event;
      routes.push(
        newMockRoute({
          kind,
          method: 'GET',
          path,
          headers: [],
          body: '',
          name: request.name,
          stream,
        }),
      );
      continue;
    }
    const path = mockPathOf(request.url);
    const key = `${request.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const response =
      request.response && !request.response.error ? (request.response as HttpResponse) : undefined;
    const type = response
      ? Object.entries(response.headers).find(
          ([name]) => name.toLowerCase() === 'content-type',
        )?.[1]
      : undefined;
    routes.push(
      newMockRoute({
        method: request.method,
        path,
        status: response?.status ?? 200,
        headers: type ? jsonHeader(type) : response ? [] : jsonHeader(),
        body: response ? response.body : '{}',
        name: request.name,
      }),
    );
  }
  return routes;
}

/** The names of a path pattern's parameters, in order: `id` and `sku` in `/users/:id/items/:sku`. */
export function mockPathParamNames(path: string): string[] {
  return [
    ...new Set(
      segments(path)
        .filter((part) => part.startsWith(':') && part.length > 1)
        .map((part) => part.slice(1)),
    ),
  ];
}
/** Whether a name can be a path parameter: a letter or underscore, then letters, digits, or underscores. */
export const validPathParamName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
/** The path with `/:name` added at its end, before any trailing `*`. */
export function addPathParam(path: string, name: string): string {
  const base = path.replace(/\/+$/, '');
  if (base.endsWith('/*')) return `${base.slice(0, -2)}/:${name}/*`;
  return `${base}/:${name}`;
}
/** The path with every `:from` segment renamed to `:to`. */
export function renamePathParam(path: string, from: string, to: string): string {
  return path
    .split('/')
    .map((part) => (part === `:${from}` ? `:${to}` : part))
    .join('/');
}
/** The path without its `:name` segments; an emptied path is `/`. */
export function removePathParam(path: string, name: string): string {
  return (
    path
      .split('/')
      .filter((part) => part !== `:${name}`)
      .join('/') || '/'
  );
}
/** A route's path parameters in path order, each with its saved details or none. */
export function mockPathParams(route: Pick<MockRoute, 'path' | 'pathParams'>): MockPathParam[] {
  return mockPathParamNames(route.path).map(
    (name) => route.pathParams?.find((param) => param.name === name) ?? { name },
  );
}
const PATH_PARAM_TYPES: readonly MockPathParamType[] = [
  'integer',
  'number',
  'boolean',
  'uuid',
  'date',
  'enum',
  'pattern',
];
/** A route's path with each parameter replaced by its example, for trying it. */
export function mockExamplePath(route: Pick<MockRoute, 'path' | 'pathParams'>): string {
  const params = mockPathParams(route);
  return route.path
    .replace(/:([^/]+)/g, (whole, name: string) => {
      const example = params.find((param) => param.name === name)?.example?.trim();
      return example ? encodeURIComponent(example) : name;
    })
    .replace(/\*$/, '');
}
/** A path pattern's segments, without empty ones, so a trailing slash does not matter. */
const segments = (path: string) => path.split('/').filter(Boolean);
/** Path parameters if `path` matches `pattern`, otherwise undefined. */
export function matchMockPath(pattern: string, path: string): Record<string, string> | undefined {
  const want = segments(pattern);
  const have = segments(path);
  const params: Record<string, string> = {};
  for (let index = 0; index < want.length; index++) {
    const part = want[index];
    if (part === '*') {
      params['*'] = have.slice(index).map(decode).join('/');
      return params;
    }
    if (index >= have.length) return undefined;
    if (part.startsWith(':')) params[part.slice(1)] = decode(have[index]);
    else if (part !== have[index] && part !== decode(have[index])) return undefined;
  }
  return want.length === have.length ? params : undefined;
}
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
/** What a mock rule can look at in a request. */
export interface MockRequestDetails {
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** The body as text (empty when there is none). */
  body: string;
}
export const MOCK_RULE_TARGETS = ['query', 'header', 'cookie', 'param', 'body'] as const;
export const MOCK_RULE_OPERATORS: readonly MockRuleOperator[] = [
  'equals',
  'not-equals',
  'equals-ignore-case',
  'not-equals-ignore-case',
  'contains',
  'not-contains',
  'contains-ignore-case',
  'not-contains-ignore-case',
  'starts-with',
  'not-starts-with',
  'ends-with',
  'not-ends-with',
  'matches',
  'not-matches',
  'one-of',
  'not-one-of',
  'contains-all',
  'contains-any',
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'not-between',
  'length-equals',
  'min-length',
  'max-length',
  'before',
  'after',
  'is-integer',
  'is-number',
  'is-boolean',
  'is-uuid',
  'is-email',
  'is-date',
  'is-url',
  'is-ip',
  'is-json',
  'is-array',
  'is-object',
  'is-alphanumeric',
  'is-base64',
  'is-hex',
  'is-jwt',
  'is-uppercase',
  'is-lowercase',
  'empty',
  'not-empty',
  'exists',
  'missing',
];
/** Operators that compare against nothing: the kind of value, or whether it is there. */
export const VALUELESS_RULE_OPERATORS: readonly MockRuleOperator[] = [
  'is-integer',
  'is-number',
  'is-boolean',
  'is-uuid',
  'is-email',
  'is-date',
  'is-url',
  'is-ip',
  'is-json',
  'is-array',
  'is-object',
  'is-alphanumeric',
  'is-base64',
  'is-hex',
  'is-jwt',
  'is-uppercase',
  'is-lowercase',
  'empty',
  'not-empty',
  'exists',
  'missing',
];
/** A rule's list of values, for `one-of` and `not-one-of`. */
const ruleList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
/** A number written in a rule or a request, or undefined when it is not one. */
const ruleNumber = (value: string): number | undefined => {
  if (!value.trim()) return undefined;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : undefined;
};
/** The two ends of `between`, written as `1..10` or `1,10`. */
const ruleRange = (value: string): [number, number] | undefined => {
  const [low, high] = value.split(/\.\.|,/).map((part) => ruleNumber(part));
  return low !== undefined && high !== undefined
    ? [Math.min(low, high), Math.max(low, high)]
    : undefined;
};
/**
 * A rule's regular expression: `/pattern/flags`, such as `/^ab+c$/i`, or a bare pattern. Throws
 * when it does not compile.
 */
export function ruleRegExp(value: string): RegExp {
  const literal = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(value.trim());
  // A global or sticky pattern would remember where it last matched between values.
  return literal
    ? untrustedRegExp(literal[1], literal[2].replace(/[gy]/g, ''))
    : untrustedRegExp(value);
}
/** A moment written in a rule: a date or date-time, or `now`. */
const ruleTime = (value: string): number | undefined => {
  const text = value.trim();
  if (text.toLowerCase() === 'now') return Date.now();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return undefined;
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : time;
};
/** A JSON value's kind, or undefined when the text is not JSON. */
const jsonKind = (value: string): string | undefined => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
  } catch {
    return undefined;
  }
};
/** The length a length rule compares: a JSON array's items, otherwise the characters. */
const ruleLength = (value: string) => {
  if (value.trimStart().startsWith('['))
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.length;
    } catch {
      // Text that starts with a bracket is still text.
    }
  return [...value].length;
};
const isURL = (value: string) => {
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};
const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const isIP = (value: string) => {
  if (IPV4.test(value)) return true;
  if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
};
const KIND_TESTS: Partial<Record<MockRuleOperator, (value: string) => boolean>> = {
  'is-url': isURL,
  'is-ip': isIP,
  'is-json': (value) => jsonKind(value) !== undefined,
  'is-array': (value) => jsonKind(value) === 'array',
  'is-object': (value) => jsonKind(value) === 'object',
  'is-date': isCalendarDate,
  // Padded Base64, or unpadded URL-safe Base64, whose length never leaves one character over.
  'is-base64': (value) =>
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/.test(
      value,
    ) ||
    (/^[A-Za-z0-9_-]+$/.test(value) && value.length % 4 !== 1),
  // Text with letters in it, all of one case: "ABC-1" is uppercase, "123" is neither.
  'is-uppercase': (value) => /\p{L}/u.test(value) && value === value.toUpperCase(),
  'is-lowercase': (value) => /\p{L}/u.test(value) && value === value.toLowerCase(),
};
const KIND_PATTERNS: Partial<Record<MockRuleOperator, RegExp>> = {
  'is-integer': /^-?\d+$/,
  'is-number': /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/,
  'is-boolean': /^(true|false)$/,
  'is-uuid': /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'is-email': /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  'is-alphanumeric': /^[\p{L}\p{N}]+$/u,
  'is-hex': /^(0x)?[0-9a-f]+$/i,
  'is-jwt': /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/,
};
const isEmptyValue = (value: string) => ['', '[]', '{}', '""', 'null'].includes(value.trim());
export { jsonPathValue };
/** The request's values a rule compares: none when the value is absent. */
function ruleValues(
  rule: MockRule,
  request: MockRequestDetails,
  params: Record<string, string>,
): string[] {
  const name = rule.name.trim();
  if (rule.target === 'query') return request.query.getAll(name);
  if (rule.target === 'cookie') {
    const header = ownValue(request.headers, 'cookie');
    const values: string[] = [];
    for (const part of (Array.isArray(header) ? header.join('; ') : (header ?? '')).split(';')) {
      const separator = part.indexOf('=');
      if (separator > 0 && part.slice(0, separator).trim() === name)
        values.push(part.slice(separator + 1).trim());
    }
    return values;
  }
  if (rule.target === 'param') {
    const value = ownValue(params, name);
    return value === undefined ? [] : [value];
  }
  if (rule.target === 'header') {
    const value = ownValue(request.headers, name.toLowerCase());
    return value === undefined ? [] : [Array.isArray(value) ? value.join(', ') : value];
  }
  if (!name) return request.body ? [request.body] : [];
  let document: unknown;
  try {
    document = JSON.parse(request.body);
  } catch {
    return [];
  }
  const value = jsonPathValue(document, name);
  if (value === undefined) return [];
  return [typeof value === 'string' ? value : JSON.stringify(value)];
}
/** Whether one rule passes for a request. An invalid regular expression never matches. */
export function mockRulePasses(
  rule: MockRule,
  request: MockRequestDetails,
  params: Record<string, string> = {},
): boolean {
  const values = ruleValues(rule, request, params);
  const some = (test: (value: string) => boolean) => values.some(test);
  const numeric = (test: (value: number) => boolean) =>
    some((value) => {
      const number = ruleNumber(value);
      return number !== undefined && test(number);
    });
  const target = ruleNumber(rule.value);
  switch (rule.operator) {
    case 'exists':
      return values.length > 0;
    case 'missing':
      return values.length === 0;
    case 'equals':
      return some((value) => value === rule.value);
    case 'not-equals':
      return values.every((value) => value !== rule.value);
    case 'equals-ignore-case':
      return some((value) => value.toLowerCase() === rule.value.toLowerCase());
    case 'not-equals-ignore-case':
      return values.every((value) => value.toLowerCase() !== rule.value.toLowerCase());
    case 'contains-ignore-case':
      return some((value) => value.toLowerCase().includes(rule.value.toLowerCase()));
    case 'not-contains-ignore-case':
      return values.every((value) => !value.toLowerCase().includes(rule.value.toLowerCase()));
    case 'contains-all':
    case 'contains-any': {
      const list = ruleList(rule.value);
      // A JSON array's items, or else the text, must hold the listed values.
      const holds = (value: string, item: string) => {
        if (value.trimStart().startsWith('['))
          try {
            const parsed = JSON.parse(value) as unknown;
            if (Array.isArray(parsed)) return parsed.some((entry) => String(entry) === item);
          } catch {
            // Text that starts with a bracket is still text.
          }
        return value.includes(item);
      };
      return (
        list.length > 0 &&
        some((value) =>
          rule.operator === 'contains-all'
            ? list.every((item) => holds(value, item))
            : list.some((item) => holds(value, item)),
        )
      );
    }
    case 'eq':
      return target !== undefined && numeric((value) => value === target);
    case 'ne':
      return target !== undefined && numeric((value) => value !== target);
    case 'contains':
      return some((value) => value.includes(rule.value));
    case 'not-contains':
      return values.every((value) => !value.includes(rule.value));
    case 'starts-with':
      return some((value) => value.startsWith(rule.value));
    case 'not-starts-with':
      return values.every((value) => !value.startsWith(rule.value));
    case 'ends-with':
      return some((value) => value.endsWith(rule.value));
    case 'not-ends-with':
      return values.every((value) => !value.endsWith(rule.value));
    case 'matches':
    case 'not-matches': {
      let pattern: RegExp;
      try {
        pattern = ruleRegExp(rule.value);
      } catch {
        return false;
      }
      return rule.operator === 'matches'
        ? some((value) => pattern.test(value))
        : values.every((value) => !pattern.test(value));
    }
    case 'one-of': {
      const list = ruleList(rule.value);
      return some((value) => list.includes(value));
    }
    case 'not-one-of': {
      const list = ruleList(rule.value);
      return values.every((value) => !list.includes(value));
    }
    case 'gt':
      return target !== undefined && numeric((value) => value > target);
    case 'gte':
      return target !== undefined && numeric((value) => value >= target);
    case 'lt':
      return target !== undefined && numeric((value) => value < target);
    case 'lte':
      return target !== undefined && numeric((value) => value <= target);
    case 'between': {
      const range = ruleRange(rule.value);
      return range !== undefined && numeric((value) => value >= range[0] && value <= range[1]);
    }
    case 'not-between': {
      const range = ruleRange(rule.value);
      return range !== undefined && numeric((value) => value < range[0] || value > range[1]);
    }
    case 'length-equals':
      return target !== undefined && some((value) => ruleLength(value) === target);
    case 'min-length':
      return target !== undefined && some((value) => ruleLength(value) >= target);
    case 'max-length':
      return target !== undefined && some((value) => ruleLength(value) <= target);
    case 'before':
    case 'after': {
      const limit = ruleTime(rule.value);
      return (
        limit !== undefined &&
        some((value) => {
          const time = ruleTime(value);
          return time !== undefined && (rule.operator === 'before' ? time < limit : time > limit);
        })
      );
    }
    case 'empty':
      return some(isEmptyValue);
    case 'not-empty':
      return some((value) => !isEmptyValue(value));
    default: {
      const test = KIND_TESTS[rule.operator];
      if (test) return some(test);
      const pattern = KIND_PATTERNS[rule.operator];
      return Boolean(pattern) && some((value) => pattern!.test(value));
    }
  }
}
/** A rule's problem, such as a regular expression that does not compile. */
export function mockRuleProblem(rule: MockRule): string | undefined {
  if (rule.target !== 'body' && !rule.name.trim())
    return 'Name what to check; the rule is ignored until then.';
  if (rule.operator === 'matches' || rule.operator === 'not-matches') {
    if (!rule.value.trim()) return 'Enter a regular expression, such as ^[A-Z]{3}$ or /^abc$/i.';
    try {
      ruleRegExp(rule.value);
    } catch (error) {
      return `Invalid regular expression: ${(error as Error).message}`;
    }
  }
  if (['before', 'after'].includes(rule.operator) && ruleTime(rule.value) === undefined)
    return 'Enter a date such as 2026-01-31, a date-time, or now.';
  if (
    ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(rule.operator) &&
    ruleNumber(rule.value) === undefined
  )
    return 'Enter a number to compare with.';
  if (['between', 'not-between'].includes(rule.operator) && !ruleRange(rule.value))
    return 'Enter the range as min..max, such as 1..10.';
  if (
    ['length-equals', 'min-length', 'max-length'].includes(rule.operator) &&
    !/^\d+$/.test(rule.value.trim())
  )
    return 'Enter a length as a whole number.';
  if (
    ['one-of', 'not-one-of', 'contains-all', 'contains-any'].includes(rule.operator) &&
    !ruleList(rule.value).length
  )
    return 'List the values, separated by commas.';
  return undefined;
}
/** Something with rules: a route, or one of its other responses. */
type WithRules = { rules?: MockRule[]; ruleMode?: 'all' | 'any' };
/** The rules in effect: enabled, and (except for the whole body) naming what they check. */
const activeRules = (item: WithRules) =>
  (item.rules ?? []).filter((rule) => rule.enabled && (rule.target === 'body' || rule.name.trim()));
/** Whether rules let a route answer: all of them, or any one with `ruleMode: 'any'`. */
export function mockRulesPass(
  item: WithRules,
  request: MockRequestDetails,
  params: Record<string, string>,
): boolean {
  const rules = activeRules(item);
  if (!rules.length) return true;
  return item.ruleMode === 'any'
    ? rules.some((rule) => mockRulePasses(rule, request, params))
    : rules.every((rule) => mockRulePasses(rule, request, params));
}
/** What a route answers with: a response whose rules pass, or the route's own. */
export interface MockAnswer {
  status: number;
  headers: KeyValue[];
  body: string;
  delayMs: number;
  /** The response that answered, when it was not the route's own. */
  responseId?: string;
}
/**
 * The answer a route gives a request: its first other response that has rules and whose rules
 * pass, otherwise its own. A response without rules in effect is never chosen.
 */
export function mockAnswer(
  route: MockRoute,
  request: MockRequestDetails,
  params: Record<string, string>,
): MockAnswer {
  const response = (route.responses ?? []).find(
    (item) => activeRules(item).length && mockRulesPass(item, request, params),
  );
  return response
    ? {
        status: response.status,
        headers: response.headers,
        body: response.body,
        delayMs: response.delayMs,
        responseId: response.id,
      }
    : { status: route.status, headers: route.headers, body: route.body, delayMs: route.delayMs };
}
/** A response for a route, starting from the route's own headers and body. */
export function newMockResponse(
  route: MockRoute,
  overrides: Partial<MockResponse> = {},
): MockResponse {
  return {
    id: newId(),
    rules: [],
    status: route.status,
    headers: structuredClone(route.headers),
    body: route.body,
    delayMs: 0,
    ...overrides,
  };
}
const TARGET_LABELS: Record<MockRule['target'], string> = {
  query: 'query parameter',
  header: 'header',
  cookie: 'cookie',
  param: 'path parameter',
  body: 'body',
};
/** A rule in words, such as `header X-Plan equals "premium"`. */
export function describeMockRule(rule: MockRule, mode: 'is' | 'must' = 'is'): string {
  const subject =
    rule.target === 'body'
      ? rule.name.trim()
        ? `body ${rule.name.trim()}`
        : 'body'
      : `${TARGET_LABELS[rule.target]} ${rule.name.trim()}`;
  const value = rule.value.trim();
  const list = ruleList(rule.value).join(', ');
  const range = ruleRange(rule.value);
  const pattern = /^\/[\s\S]*\/[a-z]*$/.test(value) ? value : `/${rule.value}/`;
  // Each comparison as a fact ("equals 2") and as a requirement ("must equal 2").
  const phrases: Record<MockRuleOperator, [string, string]> = {
    equals: [`equals "${rule.value}"`, `must equal "${rule.value}"`],
    'not-equals': [`does not equal "${rule.value}"`, `must not equal "${rule.value}"`],
    contains: [`contains "${rule.value}"`, `must contain "${rule.value}"`],
    'not-contains': [`does not contain "${rule.value}"`, `must not contain "${rule.value}"`],
    'starts-with': [`starts with "${rule.value}"`, `must start with "${rule.value}"`],
    'ends-with': [`ends with "${rule.value}"`, `must end with "${rule.value}"`],
    'equals-ignore-case': [
      `equals "${rule.value}" ignoring case`,
      `must equal "${rule.value}" ignoring case`,
    ],
    'not-equals-ignore-case': [
      `does not equal "${rule.value}" in any case`,
      `must not equal "${rule.value}" in any case`,
    ],
    'contains-ignore-case': [
      `contains "${rule.value}" ignoring case`,
      `must contain "${rule.value}" ignoring case`,
    ],
    'not-contains-ignore-case': [
      `does not contain "${rule.value}" in any case`,
      `must not contain "${rule.value}" in any case`,
    ],
    'contains-all': [`contains all of ${list}`, `must contain all of ${list}`],
    'contains-any': [`contains any of ${list}`, `must contain one of ${list}`],
    eq: [`equals the number ${value}`, `must equal the number ${value}`],
    ne: [`is not the number ${value}`, `must not be the number ${value}`],
    'is-base64': ['is Base64', 'must be Base64'],
    'is-hex': ['is hexadecimal', 'must be hexadecimal'],
    'is-jwt': ['is a JWT', 'must be a JWT'],
    'is-uppercase': ['is uppercase', 'must be uppercase'],
    'is-lowercase': ['is lowercase', 'must be lowercase'],
    'not-starts-with': [
      `does not start with "${rule.value}"`,
      `must not start with "${rule.value}"`,
    ],
    'not-ends-with': [`does not end with "${rule.value}"`, `must not end with "${rule.value}"`],
    matches: [`matches ${pattern}`, `must match ${pattern}`],
    'not-matches': [`does not match ${pattern}`, `must not match ${pattern}`],
    'one-of': [`is one of ${list}`, `must be one of ${list}`],
    'not-one-of': [`is not one of ${list}`, `must not be one of ${list}`],
    gt: [`is greater than ${value}`, `must be greater than ${value}`],
    gte: [`is at least ${value}`, `must be at least ${value}`],
    lt: [`is less than ${value}`, `must be less than ${value}`],
    lte: [`is at most ${value}`, `must be at most ${value}`],
    between: range
      ? [`is between ${range[0]} and ${range[1]}`, `must be between ${range[0]} and ${range[1]}`]
      : [`is between ${value}`, `must be between ${value}`],
    'not-between': range
      ? [
          `is not between ${range[0]} and ${range[1]}`,
          `must not be between ${range[0]} and ${range[1]}`,
        ]
      : [`is not between ${value}`, `must not be between ${value}`],
    'length-equals': [`has a length of ${value}`, `must have a length of ${value}`],
    before: [`is before ${value}`, `must be before ${value}`],
    after: [`is after ${value}`, `must be after ${value}`],
    'is-url': ['is a URL', 'must be a URL'],
    'is-ip': ['is an IP address', 'must be an IP address'],
    'is-json': ['is valid JSON', 'must be valid JSON'],
    'is-array': ['is a JSON array', 'must be a JSON array'],
    'is-object': ['is a JSON object', 'must be a JSON object'],
    'is-alphanumeric': ['is letters and digits only', 'must be letters and digits only'],
    'min-length': [`has at least ${value} characters`, `must have at least ${value} characters`],
    'max-length': [`has at most ${value} characters`, `must have at most ${value} characters`],
    'is-integer': ['is an integer', 'must be an integer'],
    'is-number': ['is a number', 'must be a number'],
    'is-boolean': ['is true or false', 'must be true or false'],
    'is-uuid': ['is a UUID', 'must be a UUID'],
    'is-email': ['is an email address', 'must be an email address'],
    'is-date': ['is a date', 'must be a date'],
    empty: ['is empty', 'must be empty'],
    'not-empty': ['is not empty', 'must not be empty'],
    exists: ['is present', 'must be present'],
    missing: ['is missing', 'must be absent'],
  };
  return `${subject} ${phrases[rule.operator][mode === 'is' ? 0 : 1]}`;
}
const ROUTE_KIND_LABELS: Record<MockRouteKind, string> = {
  http: 'HTTP',
  sse: 'SSE',
  ndjson: 'NDJSON',
  websocket: 'WebSocket',
  grpc: 'gRPC',
  socketio: 'Socket.IO',
  mqtt: 'MQTT',
};
const routeLabel = (route: MockRoute) =>
  `${isStreamRoute(route) ? ROUTE_KIND_LABELS[mockRouteKind(route)] : route.method} ${route.path}${route.name ? ` (${route.name})` : ''}`;
/** The rules that did not pass, in words. */
function failedRules(item: WithRules, request: MockRequestDetails, params: Record<string, string>) {
  return activeRules(item)
    .filter((rule) => !mockRulePasses(rule, request, params))
    .map((rule) => describeMockRule(rule));
}
/**
 * Why a request got the answer it did: the route and response chosen and why, or, when nothing
 * matched, the nearest routes and what kept each from answering.
 */
export function explainMockMatch(
  allRoutes: readonly MockRoute[],
  method: string,
  path: string,
  request: MockRequestDetails,
  transport: MockTransport = 'http',
): string[] {
  const routes = allRoutes.filter((route) => servesTransport(route, transport));
  const match = matchMockRoute(routes, method, path, request, transport);
  const notes: string[] = [];
  if (match) {
    const { route, params } = match;
    notes.push(`Route ${routeLabel(route)} answered.`);
    const rules = activeRules(route);
    if (rules.length)
      notes.push(
        `Its rules passed${route.ruleMode === 'any' ? ' (any one is enough)' : ''}: ${rules
          .filter((rule) => mockRulePasses(rule, request, params))
          .map((rule) => describeMockRule(rule))
          .join('; ')}.`,
      );
    const responses = route.responses ?? [];
    const chosen = responses.findIndex(
      (item) => activeRules(item).length && mockRulesPass(item, request, params),
    );
    responses.forEach((item, index) => {
      const label = `Response "${item.name || `Response ${index + 2}`}"`;
      if (index === chosen) notes.push(`${label} answered: its rules passed.`);
      else if (chosen < 0 || index < chosen)
        notes.push(
          activeRules(item).length
            ? `${label} did not answer: ${failedRules(item, request, params).join('; ')} did not pass.`
            : `${label} has no rules, so it is never used.`,
        );
    });
    if (responses.length && chosen < 0) notes.push('So the default response answered.');
    return notes;
  }
  const matchPath = pathMatcher(transport);
  const samePath = routes.filter((route) => matchPath(route.path, path));
  if (!samePath.length)
    return [
      transport === 'mqtt' ? `No route has the topic ${path}.` : `No route has the path ${path}.`,
    ];
  for (const route of samePath) {
    const params = matchPath(route.path, path)!;
    const routeMethod = transport === 'http' ? route.method.toUpperCase() : 'ANY';
    const wanted = method.toUpperCase();
    if (!route.enabled) notes.push(`Route ${routeLabel(route)} matches, but it is switched off.`);
    else if (
      routeMethod !== 'ANY' &&
      routeMethod !== wanted &&
      !(wanted === 'HEAD' && routeMethod === 'GET')
    )
      notes.push(
        `Route ${routeLabel(route)} has this path, but answers ${routeMethod}, not ${wanted}.`,
      );
    else
      notes.push(
        `Route ${routeLabel(route)} matches, but its rules did not pass: ${failedRules(route, request, params).join('; ')}.`,
      );
  }
  return notes;
}
const NO_DETAILS: MockRequestDetails = { query: new URLSearchParams(), headers: {}, body: '' };
/**
 * The route that answers a request: of the enabled routes whose method and path match and whose
 * rules pass, the one with the most fixed segments (so `/users/me` wins over `/users/:id`), then
 * the one with the most rules (so a conditional answer wins over the default), then the first
 * listed. HEAD requests also match GET routes.
 */
export function matchMockRoute(
  routes: readonly MockRoute[],
  method: string,
  path: string,
  request: MockRequestDetails = NO_DETAILS,
  transport: MockTransport = 'http',
): { route: MockRoute; params: Record<string, string> } | undefined {
  let best: { route: MockRoute; params: Record<string, string>; score: number } | undefined;
  const wanted = method.toUpperCase();
  for (const route of routes) {
    if (!route.enabled || !servesTransport(route, transport)) continue;
    // WebSocket upgrades and gRPC calls are matched by path alone.
    const routeMethod = transport === 'http' ? route.method.toUpperCase() : 'ANY';
    if (
      routeMethod !== 'ANY' &&
      routeMethod !== wanted &&
      !(wanted === 'HEAD' && routeMethod === 'GET')
    )
      continue;
    const params = pathMatcher(transport)(route.path, path);
    if (!params || !mockRulesPass(route, request, params)) continue;
    const parts = segments(route.path).map((part) =>
      transport === 'mqtt' && (part === '+' || part === '#') ? (part === '#' ? '*' : ':') : part,
    );
    const score =
      (parts.filter((part) => part !== '*' && !part.startsWith(':')).length * 2 +
        (routeMethod === 'ANY' ? 0 : 1) -
        (parts.includes('*') ? 1 : 0)) *
        100 +
      Math.min(activeRules(route).length, 99);
    if (!best || score > best.score) best = { route, params, score };
  }
  return best && { route: best.route, params: best.params };
}
/**
 * A response body with its templates filled in: request values, fake data, and repeated blocks.
 * See mock-templates.ts.
 */
export function renderMockBody(
  body: string,
  request: MockTemplateRequest,
  options?: MockTemplateOptions,
): string {
  return renderMockTemplate(body, request, options);
}
/** Rules read from a file, with unknown targets and comparisons made safe. */
function normalizeRules(rules: unknown[]): MockRule[] {
  return (rules as Partial<MockRule>[])
    .filter((rule) => rule && typeof rule === 'object')
    .map((rule) => ({
      enabled: rule.enabled !== false,
      target: (MOCK_RULE_TARGETS as readonly string[]).includes(rule.target as string)
        ? rule.target!
        : 'query',
      name: typeof rule.name === 'string' ? rule.name : '',
      operator: (MOCK_RULE_OPERATORS as readonly string[]).includes(rule.operator as string)
        ? rule.operator!
        : 'equals',
      value: typeof rule.value === 'string' ? rule.value : String(rule.value ?? ''),
    }));
}
export const DEFAULT_MOCK_CORS: MockCorsOptions = {
  origins: '*',
  methods: 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  headers: '*',
  exposeHeaders: '*',
  credentials: false,
  maxAge: 0,
};
const corsList = (value: string) =>
  value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
/**
 * The CORS headers for a request from `origin` (none when there is no Origin header or it is
 * not allowed). A preflight also gets the allowed methods, headers, and max age.
 */
export function mockCorsHeaders(
  options: MockCorsOptions = DEFAULT_MOCK_CORS,
  request: { origin?: string; requestHeaders?: string; preflight: boolean },
): Record<string, string> {
  const origins = corsList(options.origins);
  const anyOrigin = !origins.length || origins.includes('*');
  const origin = request.origin;
  if (!anyOrigin && !(origin && origins.some((item) => item.replace(/\/$/, '') === origin)))
    return {};
  const headers: Record<string, string> = {};
  // A listed origin, or any with credentials (where browsers refuse `*`), is echoed back.
  const echo = !anyOrigin || options.credentials;
  headers['Access-Control-Allow-Origin'] = echo && origin ? origin : '*';
  if (echo) headers.Vary = 'Origin';
  if (options.credentials) headers['Access-Control-Allow-Credentials'] = 'true';
  const expose = corsList(options.exposeHeaders);
  if (expose.length && !(options.credentials && expose.includes('*')))
    headers['Access-Control-Expose-Headers'] = expose.join(', ');
  if (request.preflight) {
    const methods = corsList(options.methods);
    if (methods.length) headers['Access-Control-Allow-Methods'] = methods.join(', ');
    const allowed = corsList(options.headers);
    if (allowed.includes('*')) {
      // With credentials `*` is taken literally, so the headers the browser asks for are allowed.
      if (!options.credentials) headers['Access-Control-Allow-Headers'] = '*';
      else if (request.requestHeaders)
        headers['Access-Control-Allow-Headers'] = request.requestHeaders;
    } else if (allowed.length) headers['Access-Control-Allow-Headers'] = allowed.join(', ');
    if (options.maxAge > 0) headers['Access-Control-Max-Age'] = String(Math.floor(options.maxAge));
  }
  return headers;
}
/** CORS settings read from a file, with anything missing taken from the defaults. */
function normalizeCors(value: unknown): MockCorsOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<MockCorsOptions>;
  const text = (field: keyof MockCorsOptions) =>
    typeof raw[field] === 'string' ? (raw[field] as string) : (DEFAULT_MOCK_CORS[field] as string);
  return {
    origins: text('origins'),
    methods: text('methods'),
    headers: text('headers'),
    exposeHeaders: text('exposeHeaders'),
    credentials: raw.credentials === true,
    maxAge: Number.isFinite(raw.maxAge) ? Math.max(0, Number(raw.maxAge)) : 0,
  };
}
function normalizeStream(value: unknown, kind: MockRouteKind): MockStream {
  if (!value || typeof value !== 'object') return newMockStream(kind);
  const raw = value as Partial<MockStream>;
  return {
    messages: (Array.isArray(raw.messages) ? raw.messages : [])
      .filter((message) => message && typeof message.data === 'string')
      .map((message) => ({
        id: typeof message.id === 'string' && message.id ? message.id : newId(),
        data: message.data,
        ...(typeof message.event === 'string' && message.event ? { event: message.event } : {}),
      })),
    intervalMs: Number.isFinite(raw.intervalMs) ? Math.max(0, Number(raw.intervalMs)) : 1000,
    ...(raw.repeat === true ? { repeat: true } : {}),
    ...(typeof raw.reply === 'string' ? { reply: raw.reply } : {}),
  };
}
/** Checks a mock server read from a file, filling in what is missing. */
export function normalizeMock(value: unknown, fallbackName: string): MockServer | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<MockServer>;
  const routes = Array.isArray(raw.routes) ? raw.routes : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallbackName,
    port: Number.isInteger(raw.port) ? (raw.port as number) : DEFAULT_MOCK_PORT,
    cors: raw.cors !== false,
    ...(raw.https && typeof raw.https === 'object'
      ? {
          https: {
            enabled: raw.https.enabled === true,
            ...(typeof raw.https.certFile === 'string' && raw.https.certFile
              ? { certFile: raw.https.certFile }
              : {}),
            ...(typeof raw.https.keyFile === 'string' && raw.https.keyFile
              ? { keyFile: raw.https.keyFile }
              : {}),
          },
        }
      : {}),
    ...(Array.isArray(raw.defaultHeaders)
      ? {
          defaultHeaders: raw.defaultHeaders.filter(
            (row) => row && typeof row.key === 'string' && typeof row.value === 'string',
          ),
        }
      : {}),
    ...(normalizeCors(raw.corsOptions) ? { corsOptions: normalizeCors(raw.corsOptions) } : {}),
    ...(raw.mqtt && typeof raw.mqtt === 'object'
      ? {
          mqtt: {
            port: Number.isInteger(raw.mqtt.port) ? raw.mqtt.port : DEFAULT_MOCK_MQTT_PORT,
          },
        }
      : {}),
    ...(raw.grpc && typeof raw.grpc === 'object' && typeof raw.grpc.proto === 'string'
      ? {
          grpc: {
            proto: raw.grpc.proto,
            port: Number.isInteger(raw.grpc.port) ? raw.grpc.port : DEFAULT_MOCK_GRPC_PORT,
          },
        }
      : {}),
    routes: routes
      .filter((route) => route && typeof route === 'object')
      .map((route) =>
        newMockRoute({
          ...(typeof route.id === 'string' && route.id ? { id: route.id } : {}),
          enabled: route.enabled !== false,
          method: typeof route.method === 'string' ? route.method.toUpperCase() : 'GET',
          path: typeof route.path === 'string' && route.path ? route.path : '/',
          status: Number.isInteger(route.status) ? route.status : 200,
          headers: Array.isArray(route.headers)
            ? route.headers.filter((row) => row && typeof row.key === 'string')
            : [],
          body: typeof route.body === 'string' ? route.body : '',
          delayMs: Number.isFinite(route.delayMs) ? Math.max(0, Number(route.delayMs)) : 0,
          ...(typeof route.name === 'string' && route.name ? { name: route.name } : {}),
          ...(Array.isArray(route.rules) && route.rules.length
            ? { rules: normalizeRules(route.rules) }
            : {}),
          ...(route.ruleMode === 'any' ? { ruleMode: 'any' as const } : {}),
          ...(Array.isArray(route.pathParams) && route.pathParams.length
            ? {
                pathParams: route.pathParams
                  .filter((param) => param && typeof param.name === 'string' && param.name)
                  .map((param) => ({
                    name: param.name,
                    ...(PATH_PARAM_TYPES.includes(param.type as MockPathParamType)
                      ? { type: param.type }
                      : {}),
                    ...(typeof param.values === 'string' && param.values
                      ? { values: param.values }
                      : {}),
                    ...(typeof param.example === 'string' && param.example
                      ? { example: param.example }
                      : {}),
                    ...(typeof param.description === 'string' && param.description
                      ? { description: param.description }
                      : {}),
                  })),
              }
            : {}),
          ...(route.validation && typeof route.validation === 'object'
            ? {
                validation: {
                  enabled: route.validation.enabled !== false,
                  checks: Array.isArray(route.validation.checks)
                    ? normalizeRules(route.validation.checks)
                    : [],
                  status: Number.isInteger(route.validation.status) ? route.validation.status : 422,
                  ...(typeof route.validation.schema === 'string' && route.validation.schema.trim()
                    ? { schema: route.validation.schema }
                    : {}),
                  ...(typeof route.validation.body === 'string' && route.validation.body
                    ? { body: route.validation.body }
                    : {}),
                  ...(typeof route.validation.contentTypes === 'string' &&
                  route.validation.contentTypes.trim()
                    ? { contentTypes: route.validation.contentTypes }
                    : {}),
                  ...(Number.isInteger(route.validation.maxBodyBytes) &&
                  route.validation.maxBodyBytes! >= 0
                    ? { maxBodyBytes: route.validation.maxBodyBytes }
                    : {}),
                  ...(route.validation.strictQuery === true ? { strictQuery: true } : {}),
                },
              }
            : {}),
          ...(route.kind && route.kind !== 'http' && MOCK_ROUTE_KINDS.includes(route.kind)
            ? { kind: route.kind, stream: normalizeStream(route.stream, route.kind) }
            : {}),
          ...(Array.isArray(route.responses) && route.responses.length
            ? {
                responses: route.responses
                  .filter((response) => response && typeof response === 'object')
                  .map((response) => ({
                    id: typeof response.id === 'string' && response.id ? response.id : newId(),
                    ...(typeof response.name === 'string' && response.name
                      ? { name: response.name }
                      : {}),
                    rules: Array.isArray(response.rules) ? normalizeRules(response.rules) : [],
                    ...(response.ruleMode === 'any' ? { ruleMode: 'any' as const } : {}),
                    status: Number.isInteger(response.status) ? response.status : 200,
                    headers: Array.isArray(response.headers)
                      ? response.headers.filter((row) => row && typeof row.key === 'string')
                      : [],
                    body: typeof response.body === 'string' ? response.body : '',
                    delayMs: Number.isFinite(response.delayMs)
                      ? Math.max(0, Number(response.delayMs))
                      : 0,
                  })),
              }
            : {}),
        }),
      ),
    ...(raw.source &&
    (raw.source.kind === 'collection' || raw.source.kind === 'spec') &&
    typeof raw.source.name === 'string'
      ? { source: { kind: raw.source.kind, name: raw.source.name } }
      : {}),
  };
}
