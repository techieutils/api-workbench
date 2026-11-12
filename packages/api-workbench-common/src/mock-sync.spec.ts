import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionBase,
  mockSyncStatus,
  renameMockCollections,
  requestShape,
  syncMockRoute,
  syncMockWithCollection,
  syncRequestToMocks,
  syncRequestsToMocks,
  type MakeRequest,
} from './mock-sync';
import { newMock, newMockRoute } from './mocks';
import type { ApiRequest, MockServer } from './types';

let ids = 0;
const make: MakeRequest = ({ name, method, url, folder }) =>
  ({
    id: `new-${++ids}`,
    name,
    method,
    url,
    folder,
    params: [],
    headers: [],
    body: '',
    auth: 'None',
    token: '',
    username: '',
    password: '',
    tests: '',
    response: null,
  }) as unknown as ApiRequest;

const request = (id: string, method: string, url: string, folder = 'Shop'): ApiRequest => ({
  ...make({ name: `${method} ${url}`, method, url, folder }),
  id,
});

const shopMock = (): MockServer => ({
  ...newMock('Shop mock', [], []),
  port: 4010,
  source: { kind: 'collection', name: 'Shop' },
});

test('a route added to a mock made from a collection is added to the collection', () => {
  const requests = [
    request('a', 'GET', '{{baseUrl}}/orders'),
    request('b', 'GET', 'https://other.example.com/x', 'Elsewhere'),
  ];
  const mock = shopMock();
  const route = newMockRoute({
    method: 'POST',
    path: '/orders/:id/refunds',
    name: 'Refund an order',
  });
  mock.routes.push(route);
  const added = syncMockRoute(requests, mock, route, make)!;
  assert.equal(added.folder, 'Shop');
  assert.equal(added.method, 'POST');
  assert.equal(
    added.url,
    '{{baseUrl}}/orders/{{id}}/refunds',
    'where the collection’s requests go',
  );
  assert.equal(added.name, 'Refund an order');
  assert.equal(route.requestId, added.id);
  assert.deepEqual(
    requests.map((item) => item.id),
    ['a', added.id, 'b'],
    'after the collection’s last request',
  );
});

test('changing the route changes its request, unless the request was changed on its own', () => {
  const requests = [request('a', 'GET', 'https://api.example.com/orders')];
  const mock = shopMock();
  const route = newMockRoute({ method: 'GET', path: '/new-route' });
  mock.routes.push(route);
  const added = syncMockRoute(requests, mock, route, make)!;
  assert.equal(added.url, 'https://api.example.com/new-route');
  assert.equal(added.name, 'GET /new-route');
  const before = structuredClone(route);
  Object.assign(route, { method: 'DELETE', path: '/orders/:id' });
  syncMockRoute(requests, mock, route, make, before);
  assert.equal(requests.length, 2, 'the same request, not another');
  assert.equal(added.method, 'DELETE');
  assert.equal(added.url, 'https://api.example.com/orders/{{id}}');
  assert.equal(added.name, 'DELETE /orders/:id', 'a name that only said the route follows it');
  // A request renamed and pointed elsewhere by hand is left as it is.
  added.name = 'Cancel order';
  added.url = 'https://api.example.com/v2/cancel';
  const again = structuredClone(route);
  route.path = '/orders/:id/cancel';
  syncMockRoute(requests, mock, route, make, again);
  assert.equal(added.name, 'Cancel order');
  assert.equal(added.url, 'https://api.example.com/v2/cancel');
});

test('a route whose request is already there is linked to it, and a copied route gets its own', () => {
  const requests = [request('a', 'GET', '{{baseUrl}}/orders')];
  const mock = shopMock();
  const route = newMockRoute({ method: 'GET', path: '/orders' });
  mock.routes.push(route);
  assert.equal(syncMockRoute(requests, mock, route, make)?.id, 'a');
  assert.equal(requests.length, 1);
  const copy = { ...structuredClone(route), id: 'copy', requestId: undefined };
  mock.routes.push(copy);
  const own = syncMockRoute(requests, mock, copy, make)!;
  assert.notEqual(own.id, 'a');
  assert.equal(requests.length, 2);
});

test('live routes become live requests; mocks not made from a collection change nothing', () => {
  const requests: ApiRequest[] = [];
  const mock = shopMock();
  mock.grpc = { proto: 'syntax = "proto3";', port: 50052 };
  mock.mqtt = { port: 1884 };
  const socket = newMockRoute({ kind: 'websocket', path: '/ws' });
  const grpc = newMockRoute({ kind: 'grpc', path: '/shop.Orders/Watch' });
  const mqtt = newMockRoute({ kind: 'mqtt', path: 'devices/:id/status' });
  mock.routes.push(socket, grpc, mqtt);
  assert.equal(syncMockRoute(requests, mock, socket, make)?.url, 'ws://localhost:4010/ws');
  const call = syncMockRoute(requests, mock, grpc, make)!;
  assert.deepEqual(
    [call.protocol, call.url, call.grpc?.method],
    ['grpc', 'localhost:50052', '/shop.Orders/Watch'],
  );
  const feed = syncMockRoute(requests, mock, mqtt, make)!;
  assert.deepEqual(
    [feed.url, feed.mqtt?.subscriptions[0].topic],
    ['mqtt://localhost:1884', 'devices/+/status'],
  );
  const plain = { ...shopMock(), source: { kind: 'spec' as const, name: 'Shop' } };
  assert.equal(syncMockRoute(requests, plain, newMockRoute({ path: '/x' }), make), undefined);
  assert.equal(collectionBase([], 'Shop', { port: 4011 }), 'http://localhost:4011');
});

test('a request added to the collection becomes a route on each mock made from it', () => {
  const mock = shopMock();
  const other = { ...shopMock(), source: { kind: 'collection' as const, name: 'Other' } };
  const added = request('n', 'POST', '{{baseUrl}}/orders/{{id}}/refunds');
  added.name = 'Refund an order';
  const changed = syncRequestToMocks([mock, other], added);
  assert.deepEqual(changed, [mock]);
  assert.equal(other.routes.length, 0);
  const route = mock.routes[0];
  assert.deepEqual(
    [route.method, route.path, route.name, route.requestId, route.status],
    ['POST', '/orders/:id/refunds', 'Refund an order', 'n', 200],
  );
  // A request elsewhere changes no mock.
  assert.deepEqual(syncRequestToMocks([mock], request('x', 'GET', '/x', 'Elsewhere')), []);
});

test('a changed request changes its route, unless the route was changed on its own', () => {
  const mock = shopMock();
  const item = request('n', 'GET', '{{baseUrl}}/orders');
  item.name = 'List orders';
  syncRequestToMocks([mock], item);
  const route = mock.routes[0];
  const before = structuredClone(item);
  Object.assign(item, {
    method: 'PUT',
    url: '{{baseUrl}}/orders/{{id}}',
    name: 'Replace an order',
  });
  assert.deepEqual(syncRequestToMocks([mock], item, before), [mock]);
  assert.deepEqual(
    [route.method, route.path, route.name],
    ['PUT', '/orders/:id', 'Replace an order'],
  );
  // The route given a path of its own keeps it.
  route.path = '/v2/orders/:id';
  const again = structuredClone(item);
  item.url = '{{baseUrl}}/orders/{{id}}/full';
  syncRequestToMocks([mock], item, again);
  assert.equal(route.path, '/v2/orders/:id');
});

test('a known request whose route was removed stays without one; old mocks link by method and path', () => {
  const mock = shopMock();
  const item = request('n', 'GET', '{{baseUrl}}/orders');
  // A route made before routes were linked, answering the request as it was.
  mock.routes.push(
    newMockRoute({ method: 'GET', path: '/orders', name: 'GET {{baseUrl}}/orders' }),
  );
  const before = structuredClone(item);
  item.url = '{{baseUrl}}/orders/recent';
  syncRequestToMocks([mock], item, before);
  assert.deepEqual([mock.routes[0].path, mock.routes[0].requestId], ['/orders/recent', 'n']);
  // Removed, then the request changes again: no route comes back.
  mock.routes = [];
  syncRequestToMocks([mock], { ...item, url: '{{baseUrl}}/orders/old' }, item);
  assert.equal(mock.routes.length, 0);
  // A request moved into the collection is new to it.
  const moved = request('m', 'DELETE', '{{baseUrl}}/orders/{{id}}');
  syncRequestToMocks([mock], moved, { ...moved, folder: 'Drafts' });
  assert.equal(mock.routes.length, 1);
  // One answering it already is linked, not repeated.
  const twin = request('t', 'DELETE', '{{baseUrl}}/orders/{{id}}');
  mock.routes[0].requestId = undefined;
  syncRequestToMocks([mock], twin);
  assert.deepEqual([mock.routes.length, mock.routes[0].requestId], [1, 't']);
});

test('sync now puts a mock and its collection fully in step, both ways', () => {
  const requests = [
    request('a', 'GET', '{{baseUrl}}/orders'),
    request('b', 'POST', '{{baseUrl}}/orders'),
    request('x', 'GET', '{{baseUrl}}/elsewhere', 'Other'),
  ];
  const mock = shopMock();
  // One route answers an existing request but is not linked; one has no request at all.
  mock.routes.push(
    newMockRoute({ method: 'GET', path: '/orders' }),
    newMockRoute({ method: 'DELETE', path: '/orders/:id', name: 'Delete an order' }),
  );
  assert.deepEqual(mockSyncStatus(requests, mock), {
    collection: 'Shop',
    missingRoutes: 1,
    missingRequests: 1,
  });
  const done = syncMockWithCollection(requests, mock, make);
  assert.deepEqual(done, { routesAdded: 1, requestsAdded: 1 });
  assert.equal(mock.routes[0].requestId, 'a', 'linked, not repeated');
  assert.ok(mock.routes.some((route) => route.method === 'POST' && route.requestId === 'b'));
  const made = requests.find((item) => item.name === 'Delete an order');
  assert.deepEqual(
    [made?.method, made?.url, made?.folder],
    ['DELETE', '{{baseUrl}}/orders/{{id}}', 'Shop'],
  );
  assert.deepEqual(mockSyncStatus(requests, mock), {
    collection: 'Shop',
    missingRoutes: 0,
    missingRequests: 0,
  });
  // Again changes nothing.
  assert.deepEqual(syncMockWithCollection(requests, mock, make), {
    routesAdded: 0,
    requestsAdded: 0,
  });
  assert.equal(mockSyncStatus(requests, { ...mock, source: undefined }), undefined);
});

test('requests changed since they were seen reach the mocks, whatever added them', () => {
  const requests = [request('a', 'GET', '{{baseUrl}}/orders')];
  const mock = shopMock();
  const seen = new Map(requests.map((item) => [item.id, requestShape(item)]));
  requests.push(request('n', 'PUT', '{{baseUrl}}/orders/{{id}}'));
  assert.deepEqual(syncRequestsToMocks([mock], requests, seen), [mock]);
  assert.deepEqual(
    mock.routes.map((route) => `${route.method} ${route.path}`),
    ['PUT /orders/:id'],
  );
  // Nothing changed since: nothing to do.
  const now = new Map(requests.map((item) => [item.id, requestShape(item)]));
  assert.deepEqual(syncRequestsToMocks([mock], requests, now), []);
});

test('a renamed collection is still the one its mocks were made from', () => {
  const mock = shopMock();
  assert.deepEqual(renameMockCollections([mock], 'Shop', 'Store'), [mock]);
  assert.equal(mock.source?.name, 'Store');
  assert.deepEqual(renameMockCollections([mock], 'Other', 'X'), []);
});
