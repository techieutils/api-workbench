import fs from 'node:fs/promises';
import {
  DEFAULT_MOCK_CORS,
  MOCK_METHODS,
  mockHttpsProblem,
  mockPortProblem,
  newMockRoute,
} from '@techieutils/api-workbench-common/mocks';
import { syncMockRoute } from '@techieutils/api-workbench-common/mock-sync';
import { completeRequest } from './source';
import type { MockServer } from '@techieutils/api-workbench-common/types';
import { SECRET_NAME } from '@techieutils/api-workbench-electron/team-files';
import { UsageError } from './args';
import { json, nameProblem, one, printable, type Output, type Parsed } from './command-kit';
import type { Target } from './target';

/**
 * A mock server's settings, as `mock show --json` gives them and `mock update --settings-file`
 * takes them: its name, port, CORS, default headers, HTTPS certificate files, the ports of its
 * gRPC and MQTT servers, and each route's switch, status, and delay. A header value whose name
 * looks secret is shown as `<hidden>`, and `<hidden>` given back keeps the value it had.
 */

const HIDDEN = '<hidden>';

export function mockSettings(mock: MockServer) {
  return {
    name: mock.name,
    port: mock.port,
    cors: mock.cors,
    corsOptions: { ...DEFAULT_MOCK_CORS, ...mock.corsOptions },
    defaultHeaders: (mock.defaultHeaders ?? []).map((row) => ({
      key: row.key,
      value: SECRET_NAME.test(row.key) && row.value ? HIDDEN : row.value,
      enabled: row.enabled,
    })),
    https: {
      enabled: Boolean(mock.https?.enabled),
      certFile: mock.https?.certFile ?? '',
      keyFile: mock.https?.keyFile ?? '',
    },
    ...(mock.grpc ? { grpcPort: mock.grpc.port } : {}),
    ...(mock.mqtt ? { mqttPort: mock.mqtt.port } : {}),
  };
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UsageError(`${what} is a JSON object.`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, what: string, max = 4096): string => {
  if (typeof value !== 'string' || value.length > max || /[\r\n]/.test(value))
    throw new UsageError(`${what} is one line of text.`);
  return value;
};
const port = (value: unknown, what: string): number => {
  const number = Number(value);
  const problem = mockPortProblem(number);
  if (problem) throw new UsageError(`${what}: ${problem}`);
  return number;
};

/** `mock update <mock> --settings-file <file>`: changes what the file names, and nothing else. */
export async function updateMock(
  found: MockServer,
  parsed: Parsed,
  target: Target,
  output: Output,
): Promise<number> {
  const file = one(parsed, '--settings-file');
  if (!file) throw new UsageError('Give the settings with --settings-file <file>, as JSON.');
  let given: Record<string, unknown>;
  try {
    given = record(JSON.parse(await fs.readFile(file, 'utf8')), 'The settings');
  } catch (error) {
    throw error instanceof UsageError
      ? error
      : new UsageError(`${file} could not be read as JSON: ${(error as Error).message}`);
  }
  const known = [
    'removeRoutes',
    'name',
    'port',
    'cors',
    'corsOptions',
    'defaultHeaders',
    'https',
    'grpcPort',
    'mqttPort',
    'routes',
    'addRoutes',
  ];
  for (const key of Object.keys(given))
    if (!known.includes(key)) throw new UsageError(`The settings have no “${printable(key)}”.`);
  const mocks = target.state.mocks ?? [];
  const mock = structuredClone(found);
  if (given.name !== undefined) {
    const name = text(given.name, 'name', 200).trim();
    nameProblem(name, 'mock server');
    if (
      mocks.some((other) => other.id !== mock.id && other.name.toLowerCase() === name.toLowerCase())
    )
      throw new UsageError(`There is already a mock server “${name}”.`);
    mock.name = name;
  }
  if (given.port !== undefined) mock.port = port(given.port, 'port');
  if (given.grpcPort !== undefined) {
    if (!mock.grpc) throw new UsageError('This mock server serves no gRPC.');
    mock.grpc.port = port(given.grpcPort, 'grpcPort');
  }
  if (given.mqttPort !== undefined) {
    if (!mock.mqtt) throw new UsageError('This mock server has no MQTT broker.');
    mock.mqtt.port = port(given.mqttPort, 'mqttPort');
  }
  // Two servers on one port would fail to start; say so now.
  const ports = [mock.port, mock.grpc?.port, mock.mqtt?.port].filter((item) => item !== undefined);
  if (new Set(ports).size !== ports.length)
    throw new UsageError('Its HTTP, gRPC, and MQTT ports must differ.');
  for (const other of mocks)
    if (other.id !== mock.id)
      for (const item of [other.port, other.grpc?.port, other.mqtt?.port])
        if (item !== undefined && ports.includes(item))
          throw new UsageError(`Port ${item} is used by the mock server “${other.name}”.`);
  if (given.cors !== undefined) {
    if (typeof given.cors !== 'boolean') throw new UsageError('cors is true or false.');
    mock.cors = given.cors;
  }
  if (given.corsOptions !== undefined) {
    const options = record(given.corsOptions, 'corsOptions');
    const next = { ...DEFAULT_MOCK_CORS, ...mock.corsOptions };
    for (const key of ['origins', 'methods', 'headers', 'exposeHeaders'] as const)
      if (options[key] !== undefined) next[key] = text(options[key], `corsOptions.${key}`);
    if (options.credentials !== undefined) {
      if (typeof options.credentials !== 'boolean')
        throw new UsageError('corsOptions.credentials is true or false.');
      next.credentials = options.credentials;
    }
    if (options.maxAge !== undefined) {
      const seconds = Number(options.maxAge);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400)
        throw new UsageError('corsOptions.maxAge is from 0 to 86400 seconds.');
      next.maxAge = seconds;
    }
    mock.corsOptions = next;
  }
  if (given.defaultHeaders !== undefined) {
    if (!Array.isArray(given.defaultHeaders) || given.defaultHeaders.length > 100)
      throw new UsageError('defaultHeaders is a list of {"key", "value", "enabled"}.');
    const before = mock.defaultHeaders ?? [];
    mock.defaultHeaders = given.defaultHeaders.map((item, index) => {
      const row = record(item, `defaultHeaders[${index}]`);
      const key = text(row.key, `defaultHeaders[${index}].key`, 200).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key))
        throw new UsageError(`“${printable(key)}” is not a header name.`);
      let value = text(row.value ?? '', `defaultHeaders[${index}].value`);
      if (value === HIDDEN) {
        const old = before.find((header) => header.key.toLowerCase() === key.toLowerCase());
        if (!old) throw new UsageError(`${key} has no value to keep.`);
        value = old.value;
      }
      return { key, value, enabled: row.enabled !== false };
    });
  }
  if (given.https !== undefined) {
    const https = record(given.https, 'https');
    const enabled = https.enabled === true;
    const certFile = https.certFile ? text(https.certFile, 'https.certFile').trim() : '';
    const keyFile = https.keyFile ? text(https.keyFile, 'https.keyFile').trim() : '';
    mock.https =
      enabled || certFile || keyFile
        ? { enabled, ...(certFile ? { certFile } : {}), ...(keyFile ? { keyFile } : {}) }
        : undefined;
    if (!mock.https) delete mock.https;
    const problem = mockHttpsProblem(mock.https);
    if (problem) throw new UsageError(problem);
  }
  if (given.routes !== undefined) {
    if (!Array.isArray(given.routes)) throw new UsageError('routes is a list of {"id", …}.');
    for (const [index, item] of given.routes.entries()) {
      const change = record(item, `routes[${index}]`);
      const route = mock.routes.find((each) => each.id === change.id);
      if (!route)
        throw new UsageError(`This mock server has no route “${printable(String(change.id))}”.`);
      if (change.enabled !== undefined) {
        if (typeof change.enabled !== 'boolean')
          throw new UsageError('A route’s enabled is true or false.');
        route.enabled = change.enabled;
      }
      if (change.status !== undefined) {
        const status = Number(change.status);
        if (!Number.isInteger(status) || status < 100 || status > 599)
          throw new UsageError('A route’s status is from 100 to 599.');
        route.status = status;
      }
      if (change.delayMs !== undefined) {
        const delay = Number(change.delayMs);
        if (!Number.isInteger(delay) || delay < 0 || delay > 60000)
          throw new UsageError('A route’s delay is from 0 to 60000 ms.');
        route.delayMs = delay;
      }
      const before = structuredClone(route);
      applyRouteFields(route, change, index);
      // The request it is in step with, in the collection the mock was made from, follows it.
      if (['method', 'path', 'name'].some((key) => change[key] !== undefined))
        syncMockRoute(
          target.state.requests,
          mock,
          route,
          (request) => completeRequest(request),
          before,
        );
    }
  }
  if (given.removeRoutes !== undefined) {
    if (!Array.isArray(given.removeRoutes))
      throw new UsageError('removeRoutes is a list of route ids.');
    for (const id of given.removeRoutes) {
      const at = mock.routes.findIndex((route) => route.id === id);
      if (at < 0) throw new UsageError(`This mock server has no route “${printable(String(id))}”.`);
      // Its request in the collection stays: nothing a person made is deleted for them.
      mock.routes.splice(at, 1);
    }
  }
  // New HTTP routes; a mock made from a collection gets a request for each there too.
  let added = 0;
  if (given.addRoutes !== undefined) {
    if (!Array.isArray(given.addRoutes) || given.addRoutes.length > 100)
      throw new UsageError('addRoutes is a list of {"method", "path", "status", "name"}.');
    for (const [index, item] of given.addRoutes.entries()) {
      const fields = record(item, `addRoutes[${index}]`);
      const method = text(fields.method ?? 'GET', `addRoutes[${index}].method`, 20).toUpperCase();
      if (!MOCK_METHODS.includes(method))
        throw new UsageError(`A route's method is ${MOCK_METHODS.join(', ')}.`);
      const path = text(fields.path, `addRoutes[${index}].path`, 2000).trim();
      if (!path.startsWith('/') || /\s/.test(path))
        throw new UsageError(
          `A route's path starts with / and has no spaces: “${printable(path)}”.`,
        );
      if (
        mock.routes.some(
          (route) =>
            (route.kind ?? 'http') === 'http' && route.method === method && route.path === path,
        )
      )
        throw new UsageError(`It already answers ${method} ${path}.`);
      const status = Number(fields.status ?? 200);
      if (!Number.isInteger(status) || status < 100 || status > 599)
        throw new UsageError('A route’s status is from 100 to 599.');
      const name =
        fields.name === undefined ? '' : text(fields.name, `addRoutes[${index}].name`, 200).trim();
      const route = newMockRoute({ method, path, status, ...(name ? { name } : {}) });
      applyRouteFields(
        route,
        { ...fields, method: undefined, path: undefined, name: undefined },
        index,
      );
      if (fields.delayMs !== undefined) {
        const delay = Number(fields.delayMs);
        if (!Number.isInteger(delay) || delay < 0 || delay > 60000)
          throw new UsageError('A route’s delay is from 0 to 60000 ms.');
        route.delayMs = delay;
      }
      if (fields.enabled === false) route.enabled = false;
      mock.routes.push(route);
      syncMockRoute(target.state.requests, mock, route, (request) => completeRequest(request));
      added++;
    }
  }
  const at = mocks.findIndex((item) => item.id === mock.id);
  mocks[at] = mock;
  await target.save();
  const collection = mock.source?.kind === 'collection' ? mock.source.name : undefined;
  if (parsed.flags.has('--json'))
    json(output, { id: mock.id, name: mock.name, port: mock.port, addedRoutes: added });
  else
    output.out(
      `Updated the mock server “${printable(mock.name)}”${
        added && collection
          ? `; its new routes are in the collection “${printable(collection)}” too`
          : ''
      }.`,
    );
  return 0;
}

/**
 * A route's method, path, name, response headers, and body from `mock update`. A header value
 * still `<hidden>` keeps its own, as `mock show` hides secret-looking ones.
 */
function applyRouteFields(
  route: MockServer['routes'][number],
  change: Record<string, unknown>,
  index: number,
): void {
  if (change.method !== undefined) {
    const method = text(change.method, `routes[${index}].method`, 20).toUpperCase();
    if (!MOCK_METHODS.includes(method))
      throw new UsageError(`A route's method is ${MOCK_METHODS.join(', ')}.`);
    route.method = method;
  }
  if (change.path !== undefined) {
    const path = text(change.path, `routes[${index}].path`, 2000).trim();
    if (!path || /\s/.test(path)) throw new UsageError('A route’s path has no spaces.');
    if ((route.kind ?? 'http') === 'http' && !path.startsWith('/'))
      throw new UsageError(`An HTTP route's path starts with /: “${printable(path)}”.`);
    route.path = path;
  }
  if (change.name !== undefined) {
    const name = text(change.name, `routes[${index}].name`, 200).trim();
    if (name) route.name = name;
    else delete route.name;
  }
  if (change.headers !== undefined) {
    if (!Array.isArray(change.headers) || change.headers.length > 100)
      throw new UsageError('A route’s headers are a list of {"key", "value", "enabled"}.');
    const before = route.headers;
    route.headers = change.headers.map((item, at) => {
      const row = record(item, `routes[${index}].headers[${at}]`);
      const key = text(row.key, 'A header name', 200).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key))
        throw new UsageError(`“${printable(key)}” is not a header name.`);
      let value = text(row.value ?? '', 'A header value');
      if (value === HIDDEN) {
        const old = before.find((header) => header.key.toLowerCase() === key.toLowerCase());
        if (!old) throw new UsageError(`${key} has no value to keep.`);
        value = old.value;
      }
      return { key, value, enabled: row.enabled !== false };
    });
  }
  if (change.body !== undefined) {
    if (typeof change.body !== 'string' || change.body.length > 5 * 1024 * 1024)
      throw new UsageError('A route’s body is text, up to 5 MB.');
    route.body = change.body;
  }
}
