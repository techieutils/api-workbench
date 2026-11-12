/**
 * A mock server's settings as the mock page edits them, from `mock show --json`, and what saving
 * them sends to `mock update --settings-file`: only what changed. What a webview posts is checked
 * here before the extension uses it; the command line checks the rest (ports, names, files).
 */

export interface MockSettings {
  name: string;
  port: number;
  cors: boolean;
  corsOptions: {
    origins: string;
    methods: string;
    headers: string;
    exposeHeaders: string;
    credentials: boolean;
    maxAge: number;
  };
  /** A value whose name looks secret is `<hidden>`, and kept unless replaced. */
  defaultHeaders: { key: string; value: string; enabled: boolean }[];
  https: { enabled: boolean; certFile: string; keyFile: string };
  grpcPort?: number;
  mqttPort?: number;
}

export interface MockRouteDraft {
  /** The route's id, or `new:1`, `new:2`, … for one added on the page and not saved yet. */
  id: string;
  /** `http`, or a live protocol's, which the page does not change. */
  kind: string;
  enabled: boolean;
  method: string;
  path: string;
  name: string;
  status: number;
  delayMs: number;
  /** A value whose name looks secret is `<hidden>`, and kept unless replaced. */
  headers: { key: string; value: string; enabled: boolean }[];
  body: string;
}

export interface MockDraft {
  settings: MockSettings;
  routes: MockRouteDraft[];
}

/** The methods an HTTP route answers, as the app offers them. */
export const ROUTE_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'ANY',
  'TRACE',
  'CONNECT',
];

/** A new route as the app starts one: `GET /new-route`, answering `200 {}` as JSON. */
export function newRouteDraft(routes: readonly MockRouteDraft[]): MockRouteDraft {
  let n = 1;
  while (routes.some((route) => route.id === `new:${n}`)) n++;
  let path = '/new-route';
  for (let at = 2; routes.some((route) => route.path === path); at++) path = `/new-route-${at}`;
  return {
    id: `new:${n}`,
    kind: 'http',
    enabled: true,
    method: 'GET',
    path,
    name: '',
    status: 200,
    delayMs: 0,
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    body: '{}',
  };
}

const line = (value: unknown, max = 4096) =>
  typeof value === 'string' && value.length <= max && !/[\r\n]/.test(value) ? value : undefined;
const whole = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;

/** A draft posted by the mock page, checked against the mock as saved; or why it cannot be. */
export function mockDraftFrom(value: unknown, saved: MockDraft): MockDraft | string {
  if (!value || typeof value !== 'object') return 'The settings could not be read.';
  const given = value as { settings?: Record<string, unknown>; routes?: unknown };
  const settings = (given.settings ?? {}) as Record<string, unknown>;
  const name = line(settings.name, 200)?.trim();
  if (!name) return 'Give the mock server a name.';
  const port = whole(settings.port, 1024, 65535);
  if (port === undefined) return 'Its port is a number from 1024 to 65535.';
  const optionalPort = (key: 'grpcPort' | 'mqttPort', label: string) => {
    if (saved.settings[key] === undefined) return { ok: true as const };
    const found = whole(settings[key], 1024, 65535);
    return found === undefined
      ? { ok: false as const, error: `Its ${label} port is a number from 1024 to 65535.` }
      : { ok: true as const, value: found };
  };
  const grpc = optionalPort('grpcPort', 'gRPC');
  if (!grpc.ok) return grpc.error;
  const mqtt = optionalPort('mqttPort', 'MQTT');
  if (!mqtt.ok) return mqtt.error;
  if (typeof settings.cors !== 'boolean') return 'The settings could not be read.';
  const cors = (settings.corsOptions ?? {}) as Record<string, unknown>;
  const corsText = (key: string) => line(cors[key]);
  const origins = corsText('origins');
  const methods = corsText('methods');
  const headers = corsText('headers');
  const exposeHeaders = corsText('exposeHeaders');
  if ([origins, methods, headers, exposeHeaders].some((item) => item === undefined))
    return 'CORS lists are one line each.';
  const maxAge = whole(cors.maxAge, 0, 86400);
  if (maxAge === undefined) return 'CORS max age is from 0 to 86400 seconds.';
  if (typeof cors.credentials !== 'boolean') return 'The settings could not be read.';
  if (!Array.isArray(settings.defaultHeaders) || settings.defaultHeaders.length > 100)
    return 'The default headers could not be read.';
  const defaultHeaders: MockSettings['defaultHeaders'] = [];
  for (const row of settings.defaultHeaders as unknown[]) {
    const { key, value: headerValue, enabled } = (row ?? {}) as Record<string, unknown>;
    const headerName = line(key, 200)?.trim();
    const text = line(headerValue);
    if (headerName === undefined || text === undefined) return 'A default header is one line.';
    if (!headerName && !text) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName))
      return `“${headerName}” is not a header name.`;
    defaultHeaders.push({ key: headerName, value: text, enabled: enabled !== false });
  }
  const https = (settings.https ?? {}) as Record<string, unknown>;
  const certFile = line(https.certFile)?.trim();
  const keyFile = line(https.keyFile)?.trim();
  if (certFile === undefined || keyFile === undefined || typeof https.enabled !== 'boolean')
    return 'The HTTPS settings could not be read.';
  if (https.enabled && Boolean(certFile) !== Boolean(keyFile))
    return 'Give both a certificate file and its key, or neither.';
  if (!Array.isArray(given.routes) || given.routes.length > 1000)
    return 'The routes could not be read.';
  const routes: MockRouteDraft[] = [];
  for (const item of given.routes as unknown[]) {
    const route = (item ?? {}) as Record<string, unknown>;
    const id = line(route.id, 200);
    const old = saved.routes.find((each) => each.id === id);
    if (!id || (!old && !/^new:\d+$/.test(id))) return 'A route is not this mock’s.';
    const kind = old?.kind ?? 'http';
    const method = line(route.method, 20)?.toUpperCase();
    if (kind === 'http' && (!method || !ROUTE_METHODS.includes(method)))
      return 'Choose a route’s method.';
    const path = line(route.path, 2000)?.trim();
    if (!path || /\s/.test(path) || (kind === 'http' && !path.startsWith('/')))
      return `A route’s path starts with / and has no spaces, such as /orders/:id.`;
    const routeName = line(route.name, 200);
    if (routeName === undefined) return 'A route’s name is one line.';
    const status = whole(route.status, 100, 599);
    if (status === undefined) return 'A status is from 100 to 599.';
    const delayMs = whole(route.delayMs, 0, 60000);
    if (delayMs === undefined) return 'A delay is from 0 to 60000 ms.';
    if (!Array.isArray(route.headers) || route.headers.length > 100)
      return 'A route’s headers could not be read.';
    const headers: MockRouteDraft['headers'] = [];
    for (const row of route.headers as unknown[]) {
      const { key, value: headerValue, enabled } = (row ?? {}) as Record<string, unknown>;
      const headerName = line(key, 200)?.trim();
      const text = line(headerValue);
      if (headerName === undefined || text === undefined) return 'A response header is one line.';
      if (!headerName && !text) continue;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName))
        return `“${headerName}” is not a header name.`;
      headers.push({ key: headerName, value: text, enabled: enabled !== false });
    }
    if (typeof route.body !== 'string' || route.body.length > 5 * 1024 * 1024)
      return 'A route’s body is text, up to 5 MB.';
    const duplicate = routes.find(
      (other) => other.kind === kind && other.method === method && other.path === path,
    );
    if (duplicate && kind === 'http') return `Two routes answer ${method} ${path}.`;
    routes.push({
      id,
      kind,
      enabled: route.enabled !== false,
      method: kind === 'http' ? (method ?? 'GET') : (old?.method ?? 'GET'),
      path,
      name: routeName.trim(),
      status,
      delayMs,
      headers,
      body: route.body,
    });
  }
  return {
    settings: {
      name,
      port,
      cors: settings.cors,
      corsOptions: {
        origins: origins!,
        methods: methods!,
        headers: headers!,
        exposeHeaders: exposeHeaders!,
        credentials: cors.credentials,
        maxAge,
      },
      defaultHeaders,
      https: { enabled: https.enabled, certFile, keyFile },
      ...(grpc.value !== undefined ? { grpcPort: grpc.value } : {}),
      ...(mqtt.value !== undefined ? { mqttPort: mqtt.value } : {}),
    },
    routes,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The `mock update` settings that turn `saved` into `draft`, or nothing: settings and route fields
 * that changed, routes added on the page (`addRoutes`), and routes taken away (`removeRoutes`).
 */
export function mockUpdate(
  saved: MockDraft,
  draft: MockDraft,
): Record<string, unknown> | undefined {
  const change: Record<string, unknown> = {};
  for (const key of Object.keys(draft.settings) as (keyof MockSettings)[])
    if (!same(draft.settings[key], saved.settings[key])) change[key] = draft.settings[key];
  const routes: Record<string, unknown>[] = [];
  const addRoutes: Record<string, unknown>[] = [];
  for (const route of draft.routes) {
    const old = saved.routes.find((each) => each.id === route.id);
    if (!old) {
      const { id: _id, kind: _kind, ...fields } = route;
      addRoutes.push(fields);
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const key of [
      'enabled',
      'method',
      'path',
      'name',
      'status',
      'delayMs',
      'headers',
      'body',
    ] as const)
      if (!same(route[key], old[key])) fields[key] = route[key];
    if (Object.keys(fields).length) routes.push({ id: route.id, ...fields });
  }
  const removeRoutes = saved.routes
    .filter((route) => !draft.routes.some((each) => each.id === route.id))
    .map((route) => route.id);
  if (routes.length) change.routes = routes;
  if (addRoutes.length) change.addRoutes = addRoutes;
  if (removeRoutes.length) change.removeRoutes = removeRoutes;
  return Object.keys(change).length ? change : undefined;
}
