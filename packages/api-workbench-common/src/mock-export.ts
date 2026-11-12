import { openAPIHelpers } from './collection-formats/openapi';
import { allowedContentTypes } from './mock-validation';
import {
  DEFAULT_MOCK_MQTT_PORT,
  isFixedMqttTopic,
  mockOrigin,
  mockPathParams,
  mockRouteKind,
} from './mocks';
import { defaultMQTT, defaultSocketIO } from './protocol-config';
import type { ApiRequest, HttpResponse, KeyValue, MockRoute, MockRule, MockServer } from './types';

// A mock server as a collection: a request for each route, ready to send to the running mock,
// with the route's answer saved as the request's response.

const row = (key: string, value: string, description?: string): KeyValue => ({
  key,
  value,
  enabled: true,
  ...(description ? { description } : {}),
});

/** A value that passes a rule, as a starting point for the request. */
function sampleValue(rule: MockRule): string {
  const list = rule.value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  switch (rule.operator) {
    case 'equals':
    case 'equals-ignore-case':
    case 'contains':
    case 'starts-with':
    case 'ends-with':
      return rule.value;
    case 'one-of':
      return list[0] ?? '';
    case 'gt':
      return String(Number(rule.value) + 1);
    case 'gte':
    case 'lte':
      return rule.value;
    case 'lt':
      return String(Number(rule.value) - 1);
    case 'between':
      return rule.value.split(/\.\.|,/)[0]?.trim() ?? '';
    case 'is-integer':
    case 'is-number':
      return '1';
    case 'is-boolean':
      return 'true';
    case 'is-uuid':
      return '00000000-0000-4000-8000-000000000000';
    case 'is-email':
      return 'user@example.com';
    case 'is-date':
      return new Date().toISOString().slice(0, 10);
    case 'is-url':
      return 'https://example.com';
    case 'is-ip':
      return '127.0.0.1';
    default:
      return '';
  }
}

/** Query parameters and headers a route needs: its validation checks, then its rules. */
function requiredRows(route: MockRoute, target: 'query' | 'header'): KeyValue[] {
  const rows: KeyValue[] = [];
  const rules = [
    ...(route.validation?.enabled ? route.validation.checks : []),
    ...(route.rules ?? []),
  ];
  for (const rule of rules) {
    const name = rule.name.trim();
    if (!rule.enabled || rule.target !== target || !name || rule.operator === 'missing') continue;
    if (rows.some((item) => item.key.toLowerCase() === name.toLowerCase())) continue;
    rows.push(row(name, sampleValue(rule)));
  }
  return rows;
}

/** A body for the request: an example of the route's body schema, when it has one. */
function sampleBody(route: MockRoute): string {
  const schema = route.validation?.enabled ? route.validation.schema?.trim() : '';
  if (!schema) return '';
  try {
    const document = JSON.parse(schema) as Record<string, unknown>;
    const example = openAPIHelpers(document).schemaExample(document);
    return example === undefined ? '' : JSON.stringify(example, null, 2);
  } catch {
    return '';
  }
}

/** The route's own answer as a saved response, so the collection keeps the examples. */
function savedResponse(route: MockRoute, url: string): HttpResponse {
  const headers = Object.fromEntries(
    route.headers
      .filter((item) => item.enabled && item.key.trim())
      .map((item) => [item.key, item.value]),
  );
  return {
    status: route.status || 200,
    statusText: '',
    headers,
    body: route.body,
    time: route.delayMs,
    size: new TextEncoder().encode(route.body).length,
    url,
  };
}

/** The route's path with each parameter's example, or `{{name}}` to fill in. */
function requestPath(route: MockRoute): string {
  const params = mockPathParams(route);
  return route.path
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_whole, name: string) => {
      const example = params.find((param) => param.name === name)?.example?.trim();
      return example ? encodeURIComponent(example) : `{{${name}}}`;
    })
    .replace(/\/\*$/, '/');
}

/**
 * A request for each of a mock's routes, in a collection named `collection`. HTTP routes keep
 * their answer as the saved response; live routes become WebSocket, SSE, NDJSON, gRPC, Socket.IO,
 * or MQTT requests.
 */
export function mockCollectionRequests(
  mock: MockServer,
  collection: string,
): (Partial<ApiRequest> & Pick<ApiRequest, 'name' | 'method' | 'url' | 'folder'>)[] {
  const origin = mockOrigin(mock);
  return mock.routes.map((route) => {
    const kind = mockRouteKind(route);
    const name = route.name?.trim() || `${route.method} ${route.path}`;
    if (kind === 'grpc')
      return {
        name: route.name?.trim() || route.path.split('/').pop() || route.path,
        method: 'POST',
        url: `localhost:${mock.grpc?.port ?? 50051}`,
        folder: collection,
        protocol: 'grpc',
        grpc: { proto: mock.grpc?.proto ?? '', method: route.path.replace(/^\//, ''), tls: false },
        headers: requiredRows(route, 'header'),
        params: [],
        body: '{}',
      };
    if (kind === 'socketio')
      return {
        name: route.name?.trim() || `Socket.IO ${route.path}`,
        method: 'GET',
        url: `${origin}${requestPath(route) === '/' ? '' : requestPath(route)}`,
        folder: collection,
        protocol: 'socketio',
        socketio: { ...defaultSocketIO(), event: route.stream?.messages[0]?.event || 'message' },
        headers: requiredRows(route, 'header'),
        params: requiredRows(route, 'query'),
        body: '{}',
      };
    if (kind === 'mqtt') {
      // A topic with parameters is subscribed to with their examples, or + where one has none.
      const examples = mockPathParams(route);
      const levels = route.path
        .replace(/^\//, '')
        .split('/')
        .map((level) =>
          level.startsWith(':')
            ? examples.find((param) => param.name === level.slice(1))?.example?.trim() || '+'
            : level === '*'
              ? '#'
              : level,
        );
      const topic = levels.join('/');
      return {
        name: route.name?.trim() || `MQTT ${route.path}`,
        method: 'GET',
        url: `mqtt://localhost:${mock.mqtt?.port ?? DEFAULT_MOCK_MQTT_PORT}`,
        folder: collection,
        protocol: 'mqtt',
        mqtt: {
          ...defaultMQTT(),
          version: 4,
          subscriptions: [{ topic, qos: 0, enabled: true }],
          // Messages go to a concrete topic: wildcard levels become "example".
          topic: isFixedMqttTopic(route.path)
            ? topic
            : levels.map((level) => (level === '+' || level === '#' ? 'example' : level)).join('/'),
        },
        headers: [],
        params: [],
        body: '{}',
      };
    }
    const url = `${kind === 'websocket' ? origin.replace(/^http/, 'ws') : origin}${requestPath(route)}`;
    const params = requiredRows(route, 'query');
    const headers = requiredRows(route, 'header');
    const method = route.method === 'ANY' || kind === 'websocket' ? 'GET' : route.method;
    const body = ['GET', 'HEAD'].includes(method) ? '' : sampleBody(route);
    const type = route.validation?.enabled ? allowedContentTypes(route.validation)[0] : undefined;
    if (body && !headers.some((item) => item.key.toLowerCase() === 'content-type'))
      headers.push(row('Content-Type', type && !type.includes('*') ? type : 'application/json'));
    const query = params.length
      ? `?${params.map((item) => `${encodeURIComponent(item.key)}=${encodeURIComponent(item.value)}`).join('&')}`
      : '';
    return {
      name,
      method,
      url: url + query,
      folder: collection,
      ...(kind !== 'http' ? { protocol: kind } : {}),
      params,
      headers,
      body,
      ...(body
        ? { bodyType: 'raw' as const, rawContentType: 'application/json', editorLanguage: 'json' }
        : {}),
      ...(kind === 'http' ? { response: savedResponse(route, url + query) } : {}),
    };
  });
}
