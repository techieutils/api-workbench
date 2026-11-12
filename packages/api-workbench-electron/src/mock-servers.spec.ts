import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { createAuthority, issueCertificate } from './interceptor-ca';
import { MockServers } from './mock-servers';
import WebSocket from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { parse } from 'protobufjs';
import { newMock, newMockResponse, newMockRoute } from '@techieutils/api-workbench-common/mocks';
import type { MockLogEntry } from '@techieutils/api-workbench-common/types';

/** A port nothing is listening on right now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

test('a mock answers with its routes, path values, CORS, and a 404 for anything else', async (t) => {
  const log: MockLogEntry[] = [];
  const servers = new MockServers((entry) => log.push(entry));
  t.after(() => servers.stopAll());
  const port = await freePort();
  const mock = {
    ...newMock('Shop', []),
    port,
    routes: [
      newMockRoute({
        id: 'item',
        path: '/items/:id',
        status: 201,
        headers: [
          { key: 'Content-Type', value: 'application/json', enabled: true },
          { key: 'X-Off', value: 'no', enabled: false },
        ],
        body: '{"id":"{{params.id}}","q":"{{query.q}}"}',
      }),
    ],
  };
  assert.deepEqual(await servers.start(mock), { running: [{ id: mock.id, port }] });
  const response = await fetch(`http://127.0.0.1:${port}/items/7?q=x`);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('x-off'), null);
  assert.deepEqual(await response.json(), { id: '7', q: 'x' });
  const missing = await fetch(`http://127.0.0.1:${port}/nothing`, { method: 'POST' });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No mock route matches/);
  const preflight = await fetch(`http://127.0.0.1:${port}/anything`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.deepEqual(
    log.map((entry) => `${entry.method} ${entry.path} ${entry.status} ${entry.routeId ?? '-'}`),
    ['GET /items/7?q=x 201 item', 'POST /nothing 404 -', 'OPTIONS /anything 204 -'],
  );
  const [answered, missed] = log;
  assert.deepEqual(answered.params, { id: '7' });
  assert.equal(answered.response!.body, '{"id":"7","q":"x"}');
  assert.equal(answered.response!.headers['Content-Type'], 'application/json');
  assert.ok(answered.request!.headers['user-agent'] || answered.request!.headers.host);
  assert.equal(answered.notes![0], 'Route GET /items/:id answered.');
  assert.match(missed.response!.body, /No mock route matches/);
  assert.deepEqual(missed.notes, ['No route has the path /nothing.']);
  assert.notEqual(answered.id, missed.id);
});

test('starting a running mock applies its changes; a new port moves it', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const port = await freePort();
  const mock = { ...newMock('Live', []), port, cors: false };
  await servers.start(mock);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  await servers.start({
    ...mock,
    routes: [newMockRoute({ path: '/health', status: 503, delayMs: 30 })],
  });
  const started = Date.now();
  const slow = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(slow.status, 503);
  assert.ok(Date.now() - started >= 25, 'the delay applies');
  assert.equal(slow.headers.get('access-control-allow-origin'), null);
  const moved = await freePort();
  assert.deepEqual(await servers.start({ ...mock, port: moved }), {
    running: [{ id: mock.id, port: moved }],
  });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  assert.equal((await fetch(`http://127.0.0.1:${moved}/health`)).status, 200);
  assert.deepEqual(await servers.stop(mock.id), { running: [] });
  await assert.rejects(fetch(`http://127.0.0.1:${moved}/health`));
});

test('ports in use and invalid input are refused', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const port = await freePort();
  const blocker = net.createServer().listen(port, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  await new Promise((resolve) => blocker.once('listening', resolve));
  await assert.rejects(servers.start({ ...newMock('Busy', []), port }), /already in use/);
  await assert.rejects(servers.start({ ...newMock('Low', []), port: 80 }), /1024 to 65535/);
  await assert.rejects(servers.start('nope'), /Invalid mock server/);
  const first = { ...newMock('First', []), port: await freePort() };
  await servers.start(first);
  await assert.rejects(
    servers.start({ ...newMock('Second', []), port: first.port }),
    /used by First/,
  );
  assert.deepEqual(
    servers.status().running.map((item) => item.id),
    [first.id],
  );
});

test('rules pick the route by query, header, and JSON body', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const port = await freePort();
  await servers.start({
    ...newMock('Rules', []),
    port,
    routes: [
      newMockRoute({ method: 'POST', path: '/login', status: 401, body: 'denied' }),
      newMockRoute({
        method: 'POST',
        path: '/login',
        status: 200,
        body: 'welcome',
        rules: [
          { enabled: true, target: 'body', name: 'user', operator: 'equals', value: 'ada' },
          { enabled: true, target: 'header', name: 'X-Client', operator: 'exists', value: '' },
        ],
      }),
    ],
  });
  const login = (user: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ user }),
    }).then(async (response) => `${response.status} ${await response.text()}`);
  assert.equal(await login('ada', { 'X-Client': 'web' }), '200 welcome');
  assert.equal(await login('ada'), '401 denied');
  assert.equal(await login('bob', { 'X-Client': 'web' }), '401 denied');
});

test('a route answers with its first other response whose rules pass', async (t) => {
  const log: MockLogEntry[] = [];
  const servers = new MockServers((entry) => log.push(entry));
  t.after(() => servers.stopAll());
  const port = await freePort();
  const route = newMockRoute({
    id: 'stock',
    path: '/stock/:sku',
    body: '{"sku":"{{params.sku}}"}',
  });
  route.responses = [
    newMockResponse(route, {
      id: 'gone',
      status: 410,
      headers: [{ key: 'X-Reason', value: 'discontinued', enabled: true }],
      body: 'gone',
      rules: [{ enabled: true, target: 'param', name: 'sku', operator: 'equals', value: 'old' }],
    }),
  ];
  await servers.start({ ...newMock('Stock', []), port, routes: [route] });
  const get = (sku: string) =>
    fetch(`http://127.0.0.1:${port}/stock/${sku}`).then(async (response) => [
      response.status,
      response.headers.get('x-reason'),
      await response.text(),
    ]);
  assert.deepEqual(await get('old'), [410, 'discontinued', 'gone']);
  assert.deepEqual(await get('new'), [200, null, '{"sku":"new"}']);
  assert.deepEqual(
    log.map((entry) => `${entry.status} ${entry.routeId} ${entry.responseId ?? '-'}`),
    ['410 stock gone', '200 stock -'],
  );
});

test('bodies use fake data, request values, and repeated blocks', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const port = await freePort();
  await servers.start({
    ...newMock('Faker', []),
    port,
    routes: [
      newMockRoute({
        method: 'POST',
        path: '/users',
        headers: [
          { key: 'Location', value: '/teams/{{body.team}}/{{$randomInt 1 9}}', enabled: true },
        ],
        body: '{"for":"{{body.team}}","users":[{{#repeat 3}}{"n":{{@index}},"id":"{{$uuid}}","name":"{{$randomFullName}}","age":{{$randomInt 18 65}}}{{/repeat}}]}',
      }),
      newMockRoute({
        path: '/huge',
        body: '{{#repeat 1000}}{{#repeat 1000}}0123456789{{/repeat}}{{/repeat}}',
      }),
    ],
  });
  const created = await fetch(`http://127.0.0.1:${port}/users`, {
    method: 'POST',
    body: JSON.stringify({ team: 'core' }),
  });
  assert.match(created.headers.get('location')!, /^\/teams\/core\/[1-9]$/);
  const result = await created.json();
  assert.equal(result.for, 'core');
  assert.deepEqual(
    result.users.map((user: { n: number }) => user.n),
    [0, 1, 2],
  );
  for (const user of result.users) {
    assert.match(user.id, /^[0-9a-f-]{36}$/);
    assert.match(user.name, /^\S+ \S+$/);
    assert.ok(user.age >= 18 && user.age <= 65);
  }
  const huge = await fetch(`http://127.0.0.1:${port}/huge`);
  assert.equal(huge.status, 500);
  assert.match(await huge.text(), /larger than 5 MB/);
});

test('CORS follows the mock server’s settings', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const port = await freePort();
  await servers.start({
    ...newMock('Cors', []),
    port,
    corsOptions: {
      origins: 'http://app.test',
      methods: 'GET, POST',
      headers: '*',
      exposeHeaders: 'X-Total-Count',
      credentials: true,
      maxAge: 300,
    },
  });
  const preflight = await fetch(`http://127.0.0.1:${port}/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://app.test',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://app.test');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization');
  assert.equal(preflight.headers.get('access-control-max-age'), '300');
  const allowed = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Origin: 'http://app.test' },
  });
  assert.equal(allowed.headers.get('access-control-expose-headers'), 'X-Total-Count');
  assert.equal(allowed.headers.get('access-control-allow-methods'), null);
  const other = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Origin: 'http://evil.test' },
  });
  assert.equal(other.status, 200);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('default headers go on every answer, and a route’s own header wins', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const port = await freePort();
  await servers.start({
    ...newMock('Secure', []),
    port,
    routes: [
      newMockRoute({
        path: '/cached',
        headers: [{ key: 'cache-control', value: 'max-age=60', enabled: true }],
      }),
    ],
  });
  const cached = await fetch(`http://127.0.0.1:${port}/cached`);
  assert.equal(cached.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(cached.headers.get('x-frame-options'), 'DENY');
  assert.equal(cached.headers.get('cache-control'), 'max-age=60');
  const missing = await fetch(`http://127.0.0.1:${port}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(
    missing.headers.get('content-security-policy'),
    "default-src 'none'; frame-ancestors 'none'",
  );
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal(missing.headers.get('content-type'), 'application/json');
  const preflight = await fetch(`http://127.0.0.1:${port}/missing`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://app.test', 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});

test('HTTPS mocks serve with the certificate they are given', async (t) => {
  const authority = createAuthority();
  const issued = issueCertificate(authority, ['localhost', '127.0.0.1', '::1']);
  assert.match(
    new X509Certificate(issued.cert).subjectAltName ?? '',
    /DNS:localhost.*IP Address:127\.0\.0\.1/,
    'the certificate names localhost and 127.0.0.1',
  );
  const servers = new MockServers(
    () => {},
    async () => issued,
  );
  t.after(() => servers.stopAll());
  const port = await freePort();
  const mock = { ...newMock('Secure', []), port, https: { enabled: true } };
  await servers.start(mock);
  const get = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpsRequest(
        { host: '127.0.0.1', port, path, servername: 'localhost', ca: authority.certPem },
        (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode!, body }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  assert.deepEqual(await get('/health'), { status: 200, body: '{\n  "status": "ok"\n}' });
  await servers.start({ ...mock, https: { enabled: false } });
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/health`)).status,
    200,
    'turning HTTPS off restarts the mock over HTTP',
  );
  await assert.rejects(
    servers.start({
      ...mock,
      port: await freePort(),
      https: { enabled: true, certFile: '/x.pem' },
    }),
    /both a certificate and its key/,
  );
  await assert.rejects(
    new MockServers(() => {}).start({ ...mock, id: 'other', port: await freePort() }),
    /HTTPS is not available/,
  );
  await assert.rejects(
    new MockServers(
      () => {},
      async () => ({ cert: issued.cert, key: 'not a key' }),
    ).start({
      ...mock,
      id: 'broken',
      port: await freePort(),
    }),
    /cannot be used/,
  );
});

const message = (data: string, event?: string) => ({ id: data, data, ...(event ? { event } : {}) });

test('SSE and NDJSON routes stream their messages, then end', async (t) => {
  const log: MockLogEntry[] = [];
  const servers = new MockServers((entry) => log.push(entry));
  t.after(() => servers.stopAll());
  const port = await freePort();
  await servers.start({
    ...newMock('Streams', []),
    port,
    routes: [
      newMockRoute({
        id: 'events',
        kind: 'sse',
        path: '/events/:room',
        headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
        stream: {
          messages: [message('{"room":"{{params.room}}"}', 'hello'), message('line one\nline two')],
          intervalMs: 5,
        },
      }),
      newMockRoute({
        id: 'jobs',
        kind: 'ndjson',
        method: 'POST',
        path: '/jobs',
        headers: [],
        stream: { messages: [message('{\n "n": 1\n}'), message('{"n": 2}')], intervalMs: 5 },
      }),
    ],
  });
  const sse = await fetch(`http://127.0.0.1:${port}/events/blue`);
  assert.equal(sse.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(
    await sse.text(),
    'event: hello\nid: 1\ndata: {"room":"blue"}\n\nid: 2\ndata: line one\ndata: line two\n\n',
  );
  const ndjson = await fetch(`http://127.0.0.1:${port}/jobs`, { method: 'POST' });
  assert.equal(ndjson.headers.get('content-type'), 'application/x-ndjson');
  assert.equal(await ndjson.text(), '{"n":1}\n{"n":2}\n');
  assert.deepEqual(
    log.map((entry) => [entry.protocol, entry.status, entry.routeId]),
    [
      ['sse', 200, 'events'],
      ['ndjson', 200, 'jobs'],
    ],
  );
  // An HTTP request does not reach a WebSocket route, and a repeating stream runs until closed.
});

test('WebSocket routes send their messages, reply to each message, and refuse other paths', async (t) => {
  const log: MockLogEntry[] = [];
  const servers = new MockServers((entry) => log.push(entry));
  t.after(() => servers.stopAll());
  const port = await freePort();
  await servers.start({
    ...newMock('Sockets', []),
    port,
    routes: [
      newMockRoute({
        id: 'ticker',
        kind: 'websocket',
        path: '/ticker',
        headers: [],
        stream: {
          messages: [message('welcome {{query.name}}')],
          intervalMs: 5,
          reply: 'echo: {{body}}',
        },
      }),
    ],
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}/ticker?name=ada`);
  const received: string[] = [];
  await new Promise<void>((resolve, reject) => {
    client.on('error', reject);
    client.on('message', (data) => {
      received.push(data.toString());
      if (received.length === 1) client.send('ping');
      if (received.length === 2) resolve();
    });
  });
  client.close();
  assert.deepEqual(received, ['welcome ada', 'echo: ping']);
  assert.equal(log[0].status, 101);
  assert.equal(log[0].protocol, 'websocket');
  const refused = new WebSocket(`ws://127.0.0.1:${port}/nowhere`);
  const status = await new Promise<number>((resolve) =>
    refused.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)),
  );
  assert.equal(status, 404);
  const http = await fetch(`http://127.0.0.1:${port}/ticker`);
  assert.equal(http.status, 404, 'plain HTTP requests do not reach WebSocket routes');
});

const PROTO = `syntax = "proto3";
package shop;
service Orders {
  rpc Get (OrderRequest) returns (Order);
  rpc Watch (OrderRequest) returns (stream Order);
  rpc Upload (stream Order) returns (Order);
  rpc Chat (stream Order) returns (stream Order);
}
message OrderRequest { string id = 1; }
message Order { string id = 1; string status = 2; }`;

test('gRPC routes serve unary, streaming, and failing calls from the schema', async (t) => {
  const log: MockLogEntry[] = [];
  const servers = new MockServers((entry) => log.push(entry));
  t.after(() => servers.stopAll());
  const port = await freePort();
  const grpcPort = await freePort();
  const route = (id: string, path: string, data: string[], extra = {}) =>
    newMockRoute({
      id,
      kind: 'grpc',
      path,
      status: 0,
      headers: [],
      body: '',
      stream: {
        messages: data.map((item) => message(item)),
        intervalMs: 5,
        reply: '{"id":"{{body.id}}","status":"echo"}',
      },
      ...extra,
    });
  const status = await servers.start({
    ...newMock('Orders', []),
    port,
    grpc: { proto: PROTO, port: grpcPort },
    routes: [
      route('get', '/shop.Orders/Get', ['{"id":"{{body.id}}","status":"paid"}']),
      route('watch', '/shop.Orders/Watch', ['{"status":"packed"}', '{"status":"shipped"}']),
      route('upload', '/shop.Orders/Upload', ['{"id":"{{body.id}}","status":"received"}']),
      route('chat', '/shop.Orders/Chat', ['{"status":"hello"}']),
    ],
  });
  assert.equal(status.running[0].grpcPort, grpcPort);
  const definition = loader.fromJSON(parse(PROTO, { keepCase: true }).root.toJSON(), {
    keepCase: true,
  });
  const Orders = grpc.loadPackageDefinition(definition).shop as unknown as {
    Orders: new (
      address: string,
      credentials: grpc.ChannelCredentials,
    ) => grpc.Client & Record<string, (...args: unknown[]) => unknown>;
  };
  const client = new Orders.Orders(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure());
  t.after(() => client.close());
  const unary = await new Promise<{ id: string; status: string }>((resolve, reject) =>
    client.Get({ id: 'A1' }, (error: Error | null, value: { id: string; status: string }) =>
      error ? reject(error) : resolve(value),
    ),
  );
  assert.deepEqual(unary, { id: 'A1', status: 'paid' });
  const watched: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const call = client.Watch({ id: 'A1' }) as grpc.ClientReadableStream<{ status: string }>;
    call.on('data', (order) => watched.push(order.status));
    call.on('end', resolve);
    call.on('error', reject);
  });
  assert.deepEqual(watched, ['packed', 'shipped']);
  const uploaded = await new Promise<{ id: string; status: string }>((resolve, reject) => {
    const call = client.Upload((error: Error | null, value: { id: string; status: string }) =>
      error ? reject(error) : resolve(value),
    ) as grpc.ClientWritableStream<object>;
    call.write({ id: 'B1' });
    call.write({ id: 'B2' });
    call.end();
  });
  assert.deepEqual(uploaded, { id: 'B2', status: 'received' });
  const chat: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const call = client.Chat() as grpc.ClientDuplexStream<object, { id: string; status: string }>;
    call.on('data', (order) => {
      chat.push(`${order.id ?? ''}:${order.status}`);
      if (chat.length === 1) call.write({ id: 'C1' });
      if (chat.length === 2) call.end();
    });
    call.on('end', resolve);
    call.on('error', reject);
  });
  assert.deepEqual(chat, [':hello', 'C1:echo']);
  // A non-zero status fails the call with the route's body as the message.
  await servers.start({
    ...newMock('Orders', []),
    id: (await servers.status()).running[0].id,
    port,
    grpc: { proto: PROTO, port: grpcPort },
    routes: [
      route('get', '/shop.Orders/Get', [], { status: 5, body: 'Order {{body.id}} not found' }),
    ],
  });
  const failure = await new Promise<grpc.ServiceError>((resolve) =>
    client.Get({ id: 'Z9' }, (error: grpc.ServiceError) => resolve(error)),
  );
  assert.equal(failure.code, grpc.status.NOT_FOUND);
  assert.equal(failure.details, 'Order Z9 not found');
  const missing = await new Promise<grpc.ServiceError>((resolve) =>
    (client.Watch({ id: 'A1' }) as grpc.ClientReadableStream<object>).on('error', resolve),
  );
  assert.equal(missing.code, grpc.status.UNIMPLEMENTED);
  assert.deepEqual(
    log.map((entry) => [entry.protocol, entry.path, entry.status]),
    [
      ['grpc', '/shop.Orders/Get', 0],
      ['grpc', '/shop.Orders/Watch', 0],
      ['grpc', '/shop.Orders/Upload', 0],
      ['grpc', '/shop.Orders/Chat', 0],
      ['grpc', '/shop.Orders/Get', 5],
      ['grpc', '/shop.Orders/Watch', 12],
    ],
  );
});

test('a broken gRPC schema or a clashing gRPC port is refused', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const port = await freePort();
  const routes = [newMockRoute({ kind: 'grpc', path: '/shop.Orders/Get' })];
  await assert.rejects(
    servers.start({
      ...newMock('Bad', []),
      port,
      grpc: { proto: 'service {', port: port + 1 },
      routes,
    }),
    /gRPC schema cannot be used/,
  );
  await assert.rejects(
    servers.start({ ...newMock('Clash', []), port, grpc: { proto: PROTO, port }, routes }),
    /other than the mock/,
  );
  assert.deepEqual(servers.status(), { running: [] });
});

test('a route answers requests that fail validation with the problems', async (t) => {
  const log: MockLogEntry[] = [];
  const servers = new MockServers((entry) => log.push(entry));
  t.after(() => servers.stopAll());
  const port = await freePort();
  const validation = {
    enabled: true,
    status: 422,
    checks: [
      {
        enabled: true,
        target: 'header' as const,
        name: 'X-Api-Key',
        operator: 'exists' as const,
        value: '',
      },
    ],
    schema: JSON.stringify({
      type: 'object',
      required: ['sku'],
      properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
    }),
  };
  await servers.start({
    ...newMock('Validated', []),
    port,
    routes: [
      newMockRoute({
        id: 'orders',
        method: 'POST',
        path: '/orders',
        status: 201,
        body: '{"ok":true}',
        validation,
      }),
      newMockRoute({
        id: 'socket',
        kind: 'websocket',
        path: '/live',
        validation: { ...validation, schema: undefined, status: 401 },
      }),
    ],
  });
  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/orders`, { method: 'POST', body, headers });
  const ok = await post('{"sku":"A-1","quantity":2}', { 'X-Api-Key': 'k' });
  assert.equal(ok.status, 201);
  const failed = await post('{"quantity":0}');
  assert.equal(failed.status, 422);
  assert.equal(failed.headers.get('content-type'), 'application/json');
  assert.deepEqual(await failed.json(), {
    error: 'Request validation failed',
    problems: [
      { in: 'header', name: 'X-Api-Key', message: 'header X-Api-Key must be present' },
      { in: 'body', name: 'sku', message: 'body sku is required' },
      { in: 'body', name: 'quantity', message: 'body quantity must be at least 1' },
    ],
  });
  assert.match(
    log[1].notes!.at(-1)!,
    /^Validation failed, so it got 422: header X-Api-Key must be present;/,
  );
  const socket = new WebSocket(`ws://127.0.0.1:${port}/live`);
  const status = await new Promise<number>((resolve) =>
    socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)),
  );
  assert.equal(status, 401, 'a WebSocket handshake that fails validation is refused');
});

test('a gRPC call that fails validation ends with INVALID_ARGUMENT', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const [port, grpcPort] = [await freePort(), await freePort()];
  await servers.start({
    ...newMock('Orders', []),
    port,
    grpc: { proto: PROTO, port: grpcPort },
    routes: [
      newMockRoute({
        kind: 'grpc',
        path: '/shop.Orders/Get',
        status: 0,
        stream: { messages: [message('{"id":"{{body.id}}"}')], intervalMs: 5 },
        validation: {
          enabled: true,
          status: 422,
          checks: [],
          schema: JSON.stringify({
            type: 'object',
            properties: { id: { type: 'string', minLength: 2 } },
          }),
        },
      }),
    ],
  });
  const definition = loader.fromJSON(parse(PROTO, { keepCase: true }).root.toJSON(), {
    keepCase: true,
  });
  const shop = grpc.loadPackageDefinition(definition).shop as unknown as {
    Orders: new (
      address: string,
      credentials: grpc.ChannelCredentials,
    ) => grpc.Client & Record<string, (...args: unknown[]) => unknown>;
  };
  const client = new shop.Orders(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure());
  t.after(() => client.close());
  const call = (id: string) =>
    new Promise<[grpc.ServiceError | null, { id?: string } | undefined]>((resolve) =>
      client.Get({ id }, (error: grpc.ServiceError | null, value: { id?: string }) =>
        resolve([error, value]),
      ),
    );
  assert.deepEqual((await call('A1'))[1], { id: 'A1' });
  const [error] = await call('A');
  assert.equal(error?.code, grpc.status.INVALID_ARGUMENT);
  assert.equal(error?.details, 'Request validation failed: body id must be at least 2 characters');
});

test('a path parameter that does not fit its type fails validation', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const port = await freePort();
  await servers.start({
    ...newMock('Users', []),
    port,
    routes: [
      newMockRoute({
        path: '/users/:id/:size',
        body: '{"id":{{params.id}},"size":"{{params.size}}"}',
        pathParams: [
          { name: 'id', type: 'integer' },
          { name: 'size', type: 'enum', values: 'S, M, L' },
        ],
        validation: { enabled: true, status: 400, checks: [] },
      }),
    ],
  });
  const ok = await fetch(`http://127.0.0.1:${port}/users/7/M`);
  assert.deepEqual([ok.status, await ok.json()], [200, { id: 7, size: 'M' }]);
  const bad = await fetch(`http://127.0.0.1:${port}/users/abc/XL`);
  assert.equal(bad.status, 400);
  assert.deepEqual((await bad.json()).problems, [
    { in: 'param', name: 'id', message: 'path parameter id must be an integer' },
    { in: 'param', name: 'size', message: 'path parameter size must be one of S, M, L' },
  ]);
});
