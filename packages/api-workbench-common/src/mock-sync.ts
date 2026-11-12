import { defaultMQTT, defaultSocketIO } from './protocol-config';
import type { ApiRequest, MockRoute, MockServer, RequestProtocol } from './types';
import { mockPathOf, mockRouteKind, mockRoutesFromRequests } from './mocks';

/**
 * A mock server made from a collection stays in step with it: each route added to the mock is a
 * request in that collection too, and changing the route's method, path, or name changes the
 * request it made. The route keeps the request's id (`requestId`); a route whose request already
 * exists by method and path is linked to it instead of adding another. Removing a route keeps its
 * request, as nothing a person made is deleted for them.
 */

/** How a new request is made: the app's and the command line's own way, with their defaults. */
export type MakeRequest = (fields: {
  name: string;
  method: string;
  url: string;
  folder: string;
}) => ApiRequest;

const inCollection = (request: ApiRequest, collection: string) =>
  request.folder === collection || request.folder.startsWith(`${collection}/`);

/**
 * What the collection's requests put before their paths — a `{{baseUrl}}` variable or an origin
 * such as `https://api.example.com` — so a new request points where the others do; the mock's own
 * address when the collection has no HTTP request to learn from.
 */
export function collectionBase(
  requests: readonly ApiRequest[],
  collection: string,
  mock: Pick<MockServer, 'port' | 'https'>,
): string {
  for (const request of requests) {
    if (!inCollection(request, collection) || (request.protocol && request.protocol !== 'http'))
      continue;
    const url = request.url.trim();
    const variable = /^\{\{[^}]+\}\}/.exec(url)?.[0];
    if (variable) return variable;
    const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url)?.[0];
    if (origin) return origin;
  }
  return `${mock.https?.enabled ? 'https' : 'http'}://localhost:${mock.port}`;
}

/** A route's path as a request URL's: `/users/:id` is `/users/{{id}}`, as the mock read it. */
const urlPath = (path: string) => path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{{$1}}');

const nameOf = (route: Pick<MockRoute, 'name' | 'method' | 'path' | 'kind'>) =>
  route.name?.trim() ||
  (mockRouteKind(route) === 'http'
    ? `${route.method} ${route.path}`
    : `${mockRouteKind(route)} ${route.path}`);

/** The method, URL, and protocol settings a route's request has. */
function requestFields(
  route: MockRoute,
  mock: MockServer,
  base: string,
): Pick<ApiRequest, 'method' | 'url'> & Partial<ApiRequest> {
  const kind = mockRouteKind(route);
  if (kind === 'grpc')
    return {
      method: 'GET',
      url: `localhost:${mock.grpc?.port ?? 50051}`,
      protocol: 'grpc',
      grpc: { proto: mock.grpc?.proto ?? '', method: route.path, tls: false },
    };
  if (kind === 'mqtt')
    return {
      method: 'GET',
      url: `mqtt://localhost:${mock.mqtt?.port ?? 1883}`,
      protocol: 'mqtt',
      mqtt: {
        ...defaultMQTT(),
        subscriptions: [
          { topic: route.path.replace(/:([A-Za-z_]\w*)/g, '+'), qos: 0, enabled: true },
        ],
        topic: route.path.replace(/:([A-Za-z_]\w*)/g, '1'),
      },
    };
  const url = `${base}${urlPath(route.path)}`;
  if (kind === 'http') return { method: route.method === 'ANY' ? 'GET' : route.method, url };
  const websocketUrl = kind === 'websocket' ? url.replace(/^http(s?):/i, 'ws$1:') : url;
  return {
    method: 'GET',
    url: websocketUrl,
    protocol: kind as RequestProtocol,
    ...(kind === 'socketio' ? { socketio: defaultSocketIO() } : {}),
  };
}

const sameRoute = (request: ApiRequest, route: MockRoute) => {
  const kind = mockRouteKind(route);
  const protocol = request.protocol || 'http';
  if (protocol !== kind) return false;
  if (kind === 'grpc') return request.grpc?.method === route.path;
  if (kind === 'mqtt') return request.mqtt?.topic === route.path;
  return (
    mockPathOf(request.url) === route.path && (kind !== 'http' || request.method === route.method)
  );
};

/**
 * Brings the collection in step with one route of a mock made from it: links the route to its
 * request, adding one when there is none, and changes that request when the route's method, path,
 * or name changed (`before` is the route as it was). Returns the request changed or added, or
 * nothing for a mock not made from a collection.
 */
export function syncMockRoute(
  requests: ApiRequest[],
  mock: MockServer,
  route: MockRoute,
  make: MakeRequest,
  before?: MockRoute,
): ApiRequest | undefined {
  if (mock.source?.kind !== 'collection') return undefined;
  const collection = mock.source.name;
  const base = collectionBase(requests, collection, mock);
  const linked = route.requestId
    ? requests.find((request) => request.id === route.requestId)
    : undefined;
  if (linked) {
    if (before && sameRoute(linked, before))
      Object.assign(
        linked,
        requestFields(
          route,
          mock,
          collectionBase(
            requests.filter((item) => item !== linked),
            collection,
            mock,
          ),
        ),
      );
    // A name of its own stays; one that only said the route's method and path follows it.
    if (!before || linked.name === nameOf(before)) linked.name = nameOf(route);
    return linked;
  }
  // A request another route already has stays that route's, as a copied route gets its own.
  const taken = new Set(
    mock.routes.filter((item) => item !== route && item.requestId).map((item) => item.requestId),
  );
  const existing = requests.find(
    (request) =>
      inCollection(request, collection) && !taken.has(request.id) && sameRoute(request, route),
  );
  if (existing) {
    route.requestId = existing.id;
    return existing;
  }
  const fields = requestFields(route, mock, base);
  const request = Object.assign(
    make({ name: nameOf(route), method: fields.method, url: fields.url, folder: collection }),
    fields,
  );
  // After the collection's last request, as the app adds requests to a collection.
  let at = -1;
  for (let index = requests.length - 1; index >= 0; index--)
    if (inCollection(requests[index], collection)) {
      at = index;
      break;
    }
  requests.splice(at < 0 ? requests.length : at + 1, 0, request);
  route.requestId = request.id;
  return request;
}

/** The route a request makes, as New from a collection makes it. */
const routeFor = (request: ApiRequest): MockRoute | undefined =>
  mockRoutesFromRequests([request])[0];

/**
 * The other way: brings the mock servers made from a request's collection in step with it. A
 * request new to the collection (`before` missing, or outside it) becomes a route on each, as New
 * from a collection makes routes, unless one already answers the same; a request that changed
 * changes its route's method, path, and name — the route linked to it, or for a mock made before
 * routes were linked, the one that answered it as it was — unless that route was changed on its
 * own. Returns the mocks it changed. A request that already had no route stays without one, as a
 * removed route stays removed.
 */
export function syncRequestToMocks(
  mocks: MockServer[],
  request: ApiRequest,
  before?: ApiRequest,
): MockServer[] {
  const changed: MockServer[] = [];
  for (const mock of mocks) {
    if (mock.source?.kind !== 'collection') continue;
    const collection = mock.source.name;
    if (!inCollection(request, collection)) continue;
    const isNew = !before || !inCollection(before, collection);
    let route = mock.routes.find((item) => item.requestId === request.id);
    if (!route && before && !isNew) {
      route = mock.routes.find((item) => !item.requestId && sameRoute(before, item));
      if (route) route.requestId = request.id;
    }
    if (route) {
      if (!before) continue;
      const made = routeFor(request);
      const fresh = JSON.stringify(route);
      // The route follows the request only while it still answers the request as it was.
      if (made && sameRoute(before, route))
        Object.assign(route, { kind: made.kind, method: made.method, path: made.path });
      // A name of its own stays; the request's old name follows it.
      if (route.name === before.name) route.name = request.name;
      if (JSON.stringify(route) !== fresh) changed.push(mock);
      continue;
    }
    if (!isNew) continue;
    const made = routeFor(request);
    if (!made) continue;
    const existing = mock.routes.find(
      (item) =>
        !item.requestId &&
        mockRouteKind(item) === mockRouteKind(made) &&
        item.method === made.method &&
        item.path === made.path,
    );
    if (existing) existing.requestId = request.id;
    else mock.routes.push({ ...made, requestId: request.id });
    changed.push(mock);
  }
  return changed;
}

/** What of a request a mock follows: enough to tell new and changed requests apart. */
export function requestShape(request: ApiRequest): ApiRequest {
  return {
    id: request.id,
    name: request.name,
    method: request.method,
    url: request.url,
    folder: request.folder,
    protocol: request.protocol,
    ...(request.grpc ? { grpc: { method: request.grpc.method } } : {}),
    ...(request.mqtt
      ? {
          mqtt: {
            topic: request.mqtt.topic,
            subscriptions: request.mqtt.subscriptions.map((item) => ({ ...item })),
          },
        }
      : {}),
  } as ApiRequest;
}

/**
 * Brings mock servers made from collections in step with what changed in the requests since
 * `seen` (each request's shape, by id, from when it was last looked at): new ones become routes,
 * changed ones change their routes. Returns the mocks changed. The app runs it on each save, and
 * the command line before it writes, so every way of adding a request — import, a specification,
 * cURL, a copy — reaches the mock.
 */
export function syncRequestsToMocks(
  mocks: MockServer[],
  requests: readonly ApiRequest[],
  seen: ReadonlyMap<string, ApiRequest>,
): MockServer[] {
  const changed = new Set<MockServer>();
  if (!mocks.some((mock) => mock.source?.kind === 'collection')) return [];
  for (const request of requests) {
    const before = seen.get(request.id);
    if (before && JSON.stringify(before) === JSON.stringify(requestShape(request))) continue;
    for (const mock of syncRequestToMocks(mocks, request, before)) changed.add(mock);
  }
  return [...changed];
}

/** A collection renamed (or moved) is still the one its mocks were made from. */
export function renameMockCollections(
  mocks: MockServer[] | undefined,
  from: string,
  to: string,
): MockServer[] {
  const changed: MockServer[] = [];
  for (const mock of mocks ?? [])
    if (mock.source?.kind === 'collection' && mock.source.name === from) {
      mock.source = { ...mock.source, name: to };
      changed.push(mock);
    }
  return changed;
}

/** Whether a route already has its request, linked or answering the same. */
const hasRequest = (requests: readonly ApiRequest[], route: MockRoute, collection: string) =>
  requests.some(
    (request) =>
      inCollection(request, collection) &&
      (request.id === route.requestId || sameRoute(request, route)),
  );
const hasRoute = (mock: MockServer, request: ApiRequest) =>
  mock.routes.some((route) => route.requestId === request.id || sameRoute(request, route));

/**
 * How far a mock made from a collection is from it: requests there that no route answers, and
 * routes with no request there. Nothing for another mock.
 */
export function mockSyncStatus(
  requests: readonly ApiRequest[],
  mock: MockServer,
): { collection: string; missingRoutes: number; missingRequests: number } | undefined {
  if (mock.source?.kind !== 'collection') return undefined;
  const collection = mock.source.name;
  return {
    collection,
    missingRoutes: requests.filter(
      (request) => inCollection(request, collection) && !hasRoute(mock, request),
    ).length,
    missingRequests: mock.routes.filter((route) => !hasRequest(requests, route, collection)).length,
  };
}

/**
 * Sync now: puts a mock and the collection it was made from fully in step, both ways — each
 * request no route answers becomes a route, each route without a request becomes one, and routes
 * and requests that answer the same are linked. Unlike the sync as things change, it brings back
 * what was removed on one side, as the person asked for everything.
 */
export function syncMockWithCollection(
  requests: ApiRequest[],
  mock: MockServer,
  make: MakeRequest,
): { routesAdded: number; requestsAdded: number } {
  if (mock.source?.kind !== 'collection') return { routesAdded: 0, requestsAdded: 0 };
  const collection = mock.source.name;
  let routesAdded = 0;
  let requestsAdded = 0;
  // Routes first, so a request made for one is not then made into a second route.
  for (const route of [...mock.routes]) {
    if (hasRequest(requests, route, collection)) {
      if (!route.requestId) {
        const match = requests.find(
          (request) => inCollection(request, collection) && sameRoute(request, route),
        );
        if (match) route.requestId = match.id;
      }
      continue;
    }
    delete route.requestId;
    if (syncMockRoute(requests, mock, route, make)) requestsAdded++;
  }
  for (const request of [...requests]) {
    if (!inCollection(request, collection) || hasRoute(mock, request)) continue;
    const made = routeFor(request);
    if (!made) continue;
    mock.routes.push({ ...made, requestId: request.id });
    routesAdded++;
  }
  return { routesAdded, requestsAdded };
}
