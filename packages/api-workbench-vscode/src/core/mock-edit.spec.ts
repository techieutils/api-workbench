import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mockDraftFrom,
  mockUpdate,
  newRouteDraft,
  type MockDraft,
  type MockRouteDraft,
} from './mock-edit';
import { mockDetailsView } from './views';

const route = (id: string, extra: Partial<MockRouteDraft> = {}): MockRouteDraft => ({
  id,
  kind: 'http',
  enabled: true,
  method: 'GET',
  path: '/orders',
  name: '',
  status: 200,
  delayMs: 0,
  headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
  body: '{}',
  ...extra,
});

const saved: MockDraft = {
  settings: {
    name: 'Shop mock',
    port: 4010,
    cors: true,
    corsOptions: {
      origins: '*',
      methods: 'GET, POST',
      headers: '*',
      exposeHeaders: '',
      credentials: false,
      maxAge: 600,
    },
    defaultHeaders: [
      { key: 'X-Content-Type-Options', value: 'nosniff', enabled: true },
      { key: 'X-Api-Key', value: '<hidden>', enabled: true },
    ],
    https: { enabled: false, certFile: '', keyFile: '' },
    grpcPort: 50051,
  },
  routes: [
    route('r1'),
    route('r2', { method: 'POST', status: 201, delayMs: 250 }),
    route('r3', { kind: 'websocket', path: '/ws', method: 'GET', status: 101 }),
  ],
};

test('only what changed is sent: settings, route fields, added routes, and removed ones', () => {
  const draft = structuredClone(saved);
  assert.equal(mockUpdate(saved, draft), undefined);
  draft.settings.port = 4020;
  draft.routes[0].body = '{"items": []}';
  draft.routes[0].headers.push({ key: 'X-Total', value: '0', enabled: true });
  draft.routes[1].enabled = false;
  draft.routes.splice(2, 1);
  const added = newRouteDraft(draft.routes);
  assert.deepEqual(
    [added.id, added.path, added.method, added.status],
    ['new:1', '/new-route', 'GET', 200],
  );
  draft.routes.push({ ...added, path: '/refunds/:id', method: 'POST', name: 'Refund' });
  assert.deepEqual(mockUpdate(saved, draft), {
    port: 4020,
    routes: [
      {
        id: 'r1',
        headers: [...saved.routes[0].headers, { key: 'X-Total', value: '0', enabled: true }],
        body: '{"items": []}',
      },
      { id: 'r2', enabled: false },
    ],
    addRoutes: [
      {
        enabled: true,
        method: 'POST',
        path: '/refunds/:id',
        name: 'Refund',
        status: 200,
        delayMs: 0,
        headers: added.headers,
        body: '{}',
      },
    ],
    removeRoutes: ['r3'],
  });
  // A second new route takes the next id and a free path.
  const next = newRouteDraft([...draft.routes, { ...added, path: '/new-route' }]);
  assert.deepEqual([next.id, next.path], ['new:2', '/new-route-2']);
});

test('what the mock page posts is checked before it is used', () => {
  const posted = (change: (draft: MockDraft) => void) => {
    const draft = structuredClone(saved) as MockDraft;
    change(draft);
    return mockDraftFrom(JSON.parse(JSON.stringify(draft)), saved);
  };
  assert.deepEqual(
    posted(() => undefined),
    saved,
  );
  for (const [change, reason] of [
    [(d: MockDraft) => (d.settings.name = ' '), /name/],
    [(d: MockDraft) => (d.settings.port = 80), /1024 to 65535/],
    [(d: MockDraft) => (d.settings.grpcPort = 70000), /gRPC port/],
    [(d: MockDraft) => (d.settings.corsOptions.maxAge = -1), /max age/],
    [(d: MockDraft) => (d.settings.defaultHeaders[0].key = 'Bad Name'), /not a header name/],
    [
      (d: MockDraft) => (d.settings.https = { enabled: true, certFile: 'a.pem', keyFile: '' }),
      /both/,
    ],
    [(d: MockDraft) => (d.routes[0].id = 'other'), /not this mock/],
    [(d: MockDraft) => (d.routes[0].method = 'BREW'), /method/],
    [(d: MockDraft) => (d.routes[0].path = 'orders'), /starts with \//],
    [(d: MockDraft) => (d.routes[0].path = '/a b'), /no spaces/],
    [(d: MockDraft) => (d.routes[0].status = 99), /100 to 599/],
    [(d: MockDraft) => (d.routes[0].delayMs = 60001), /60000/],
    [(d: MockDraft) => (d.routes[0].headers[0].key = 'Bad Name'), /not a header name/],
    [(d: MockDraft) => (d.routes[1].method = 'GET'), /Two routes answer GET \/orders/],
  ] as const)
    assert.match(String(posted(change)), reason);
  assert.match(String(mockDraftFrom(null, saved)), /could not be read/);
  // A live route keeps its kind and method whatever is posted.
  const live = posted((d) => (d.routes[2].method = 'BREW')) as MockDraft;
  assert.deepEqual([live.routes[2].kind, live.routes[2].method], ['websocket', 'GET']);
  // A new route's id is accepted; an empty header row is dropped.
  const added = posted((d) => {
    d.routes.push({ ...newRouteDraft(d.routes), path: '/x' });
    d.routes[0].headers.push({ key: '', value: '', enabled: true });
  }) as MockDraft;
  assert.equal(added.routes.at(-1)?.id, 'new:1');
  assert.equal(added.routes[0].headers.length, 1);
});

test('mock show gives the page its settings and routes to edit', () => {
  const view = mockDetailsView({
    id: 'm',
    name: 'Shop mock',
    port: 4010,
    https: false,
    cors: true,
    corsOrigins: '*',
    defaultHeaders: 2,
    settings: saved.settings,
    routes: [
      {
        id: 'r1',
        enabled: true,
        kind: 'http',
        method: 'GET',
        path: '/orders',
        status: 200,
        name: '',
        delayMs: 0,
        rules: 1,
        responses: 0,
        validates: false,
        headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
        body: '{}',
      },
      {
        id: 'r2',
        enabled: false,
        kind: 'http',
        method: 'POST',
        path: '/orders',
        status: 201,
        name: 'Create',
        delayMs: 250,
        rules: 0,
        responses: 0,
        validates: false,
      },
    ],
  });
  assert.deepEqual(view.saved?.routes[0], route('r1'));
  assert.deepEqual(
    [
      view.saved?.routes[1].name,
      view.saved?.routes[1].enabled,
      view.saved?.routes[1].headers,
      view.saved?.routes[1].body,
    ],
    ['Create', false, [], ''],
  );
  assert.equal(view.routeList?.[0].details, '1 rule');
});
