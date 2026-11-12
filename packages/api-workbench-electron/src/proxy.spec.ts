import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import { createSecureServer } from 'node:http2';
import { connect, type Server } from 'node:net';
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { parse } from 'protobufjs';
import type { HTTPSettings } from '@techieutils/api-workbench-common/http-settings';
import { resolve, overrides } from '@techieutils/api-workbench-common/http-settings';
import { proxyForURL } from '@techieutils/api-workbench-common/proxy';
import { sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';
import { startProtocol } from './protocols';
import {
  exportCollection,
  importFiles,
} from '@techieutils/api-workbench-common/collection-transfer';
import { collectionRequests } from '@techieutils/api-workbench-common/documentation';
import { createTLSFixture } from './testing/tls-fixture';
import type {
  ApiRequest,
  ProtocolEvent,
  ProtocolPayload,
  WorkspaceState,
} from '@techieutils/api-workbench-common/types';
let fixture: Awaited<ReturnType<typeof createTLSFixture>>;
const servers: Server[] = [],
  sockets = new Set<Duplex>();
const seen: { target: string; auth: string | undefined; tunnel: boolean }[] = [];
const originHeaders: IncomingMessage['headers'][] = [];
let origin: string, secureOrigin: string, h2Origin: string, proxy: string, secureProxy: string;
let ws: WebSocketServer, rpc: grpc.Server, rpcAddress: string;
const auth = 'Basic ' + Buffer.from('proxy-user:proxy-pass').toString('base64');
const proto =
  'syntax = "proto3"; package test; service Echo { rpc Unary (Message) returns (Message); } message Message { string text = 1; }';
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
function proxyServer(secure = false) {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    seen.push({ target: req.url!, auth: req.headers['proxy-authorization'], tunnel: false });
    if (req.headers['proxy-authorization'] !== auth) {
      res.writeHead(407);
      res.end('Proxy Authentication Required');
      return;
    }
    const url = new URL(req.url!);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const forwarded = httpRequest(url, { method: req.method, headers }, (upstream) => {
      res.writeHead(upstream.statusCode!, upstream.headers);
      upstream.pipe(res);
    });
    forwarded.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  };
  const server = secure
    ? createHTTPSServer({ key: fixture.key, cert: fixture.cert + fixture.ca }, handler)
    : createServer(handler);
  server.on('connect', (req, client, head) => {
    seen.push({ target: req.url!, auth: req.headers['proxy-authorization'], tunnel: true });
    if (req.headers['proxy-authorization'] !== auth) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const url = new URL('http://' + req.url!);
    const upstream = connect(Number(url.port), url.hostname.replace(/^\[|\]$/g, ''));
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  return server;
}
before(async () => {
  fixture = await createTLSFixture();
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    originHeaders.push(req.headers);
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: proxied\n\n');
      return;
    }
    if (req.url === '/ndjson') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end('{"proxied":true}\n');
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 500);
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  };
  const http = createServer(handler);
  origin = `http://127.0.0.1:${await listen(http)}`;
  ws = new WebSocketServer({ server: http });
  ws.on('connection', (socket, req) => {
    originHeaders.push(req.headers);
    socket.on('message', (data) => socket.send(data.toString()));
  });
  secureOrigin = `https://localhost:${await listen(createHTTPSServer({ key: fixture.key, cert: fixture.cert + fixture.ca }, handler))}`;
  h2Origin = `https://localhost:${await listen(createSecureServer({ key: fixture.key, cert: fixture.cert + fixture.ca, allowHTTP1: true }, (_req, res) => res.end('h2 through proxy')))}`;
  proxy = `http://127.0.0.1:${await listen(proxyServer())}`;
  secureProxy = `https://localhost:${await listen(proxyServer(true))}`;
  rpc = new grpc.Server();
  rpc.addService(
    loader.fromJSON(parse(proto).root.toJSON())['test.Echo'] as grpc.ServiceDefinition,
    {
      unary: (call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>) =>
        callback(null, call.request),
    },
  );
  const port = await new Promise<number>((done, fail) =>
    rpc.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? fail(error) : done(port),
    ),
  );
  rpcAddress = `127.0.0.1:${port}`;
});
after(async () => {
  rpc.forceShutdown();
  for (const client of ws.clients) client.terminate();
  await closeHTTPTransports();
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  await fixture.dispose();
});
const config = (url = proxy) => ({
  proxyMode: 'custom' as const,
  proxyUrl: url,
  proxyUsername: 'proxy-user',
  proxyPassword: 'proxy-pass',
  caCertificates: fixture.ca,
});
async function send(
  url: string,
  settings: Partial<HTTPSettings> = config(),
  signal = new AbortController(),
) {
  return sendHttpRequest(
    {
      id: crypto.randomUUID(),
      method: 'POST',
      url,
      headers: { Authorization: 'Bearer origin-only' },
      body: 'request body',
      httpSettings: settings,
    },
    signal,
  );
}
function live(input: Partial<ProtocolPayload>) {
  const events: ProtocolEvent[] = [];
  const handle = startProtocol(
    {
      sessionId: crypto.randomUUID(),
      protocol: 'sse',
      url: origin + '/sse',
      body: '{}',
      headers: {},
      timeoutMs: 2500,
      httpSettings: config(),
      ...input,
    },
    (event) => events.push(event),
  );
  const wait = async (type: ProtocolEvent['type']) => {
    const until = Date.now() + 4000;
    while (!events.some((e) => e.type === type)) {
      if (Date.now() > until) throw new Error(JSON.stringify(events));
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { handle, events, wait };
}
test('proxy inheritance permits explicit direct mode and validates configuration', () => {
  const workspace = resolve(config());
  assert.equal(
    resolve(workspace, { proxyUrl: secureProxy }, { proxyMode: 'direct' }).proxyMode,
    'direct',
  );
  assert.equal(resolve(workspace, {}, { proxyPassword: '' }).proxyPassword, '');
  for (const value of [
    'socks5://localhost:1080',
    'http://user:pass@localhost',
    'http://localhost/path',
    'http://localhost?query=1',
  ])
    assert.throws(() => overrides({ proxyUrl: value }));
  assert.throws(() => resolve({ proxyMode: 'custom' }), /proxy URL/);
  assert.throws(() => resolve({ proxyBypass: 'http://example.com' }), /bypass/);
  assert.throws(() => resolve({ proxyUsername: 'bad:name' }), /colon/);
});
test('bypass rules match domain boundaries, ports, IPv4 and IPv6 without mutating settings', () => {
  const settings = resolve(config(), {
    proxyBypass: 'localhost,.example.com,127.0.0.1:3000,[::1],*.internal.test',
  });
  for (const url of [
    'http://localhost',
    'https://api.example.com',
    'http://example.com',
    'http://127.0.0.1:3000',
    'http://[::1]:8080',
    'http://api.internal.test',
  ])
    assert.equal(proxyForURL(settings, url), undefined, url);
  for (const url of ['https://evil-example.com', 'http://127.0.0.1:3001', 'http://notexample.com'])
    assert.equal(proxyForURL(settings, url)?.href, proxy + '/', url);
  assert.equal(proxyForURL(resolve(settings, { proxyBypass: '*' }), origin), undefined);
});
test('HTTP forwarding uses proxy credentials without leaking them to the origin', async () => {
  const count = seen.length;
  const result = await send(origin + '/echo?q=1');
  assert.equal(result.status, 200, result.error || '');
  assert.deepEqual(JSON.parse(result.body!), {
    method: 'POST',
    url: '/echo?q=1',
    body: 'request body',
  });
  assert.equal(seen.length, count + 1);
  assert.equal(seen.at(-1)!.auth, auth);
  assert.equal(seen.at(-1)!.tunnel, false);
  assert.equal(originHeaders.at(-1)!['proxy-authorization'], undefined);
  assert.equal(originHeaders.at(-1)!.authorization, 'Bearer origin-only');
  assert.ok(result.timings!.requests[0].phases.some((p) => /Proxy/.test(p.label)));
});
test('HTTPS endpoints tunnel through authenticated HTTP and HTTPS proxies with origin certificate capture', async () => {
  for (const route of [proxy, secureProxy]) {
    const result = await send(secureOrigin + '/echo', config(route));
    assert.equal(result.status, 200, result.error || '');
    assert.equal(seen.at(-1)!.tunnel, true);
    assert.ok(result.tls?.authorized);
    assert.equal(result.tls?.host, 'localhost');
    assert.equal(originHeaders.at(-1)!['proxy-authorization'], undefined);
  }
});
test('HTTP/2 over a proxy preserves ALPN enforcement and rejects an HTTP/1-only origin', async () => {
  const settings = { ...config(), httpVersion: '2' as const };
  const result = await send(h2Origin, settings);
  assert.equal(result.status, 200, result.error || '');
  assert.equal(result.httpVersion, '2');
  const failed = await send(secureOrigin, settings);
  assert.match(failed.error!, /HTTP\/2/);
});
test('bypass and direct override skip the proxy while failed auth never falls back', async () => {
  let count = seen.length;
  assert.equal((await send(origin, { ...config(), proxyBypass: '127.0.0.1' })).status, 200);
  assert.equal((await send(origin, { ...config(), proxyMode: 'direct' })).status, 200);
  assert.equal(seen.length, count);
  count = originHeaders.length;
  const denied = await send(secureOrigin, { ...config(), proxyPassword: 'wrong' });
  assert.match(denied.error!, /407|authentication/i);
  assert.equal(originHeaders.length, count);
  const leaked = await sendHttpRequest(
    {
      id: 'proxy-header',
      url: origin,
      method: 'GET',
      body: '',
      headers: { 'Proxy-Authorization': 'NEVER-SEND' },
    },
    new AbortController(),
  );
  assert.match(leaked.error!, /Proxy settings/);
  assert.equal(originHeaders.length, count);
});
test('proxied requests support cancellation', async () => {
  const controller = new AbortController();
  const pending = send(origin + '/slow', config(), controller);
  setTimeout(() => controller.abort(), 30);
  assert.match((await pending).error!, /cancelled|timed out/);
});
test('SSE, NDJSON and WebSocket sessions route through the scoped proxy', async () => {
  for (const protocol of ['sse', 'ndjson'] as const) {
    const count = seen.length,
      run = live({ protocol, url: origin + '/' + protocol });
    await run.wait('closed');
    assert.equal(
      run.events.filter((e) => e.type === 'error').length,
      0,
      JSON.stringify(run.events),
    );
    assert.ok(run.events.some((e) => e.type === 'message'));
    assert.ok(seen.length > count);
  }
  const count = seen.length,
    run = live({ protocol: 'websocket', url: origin.replace('http:', 'ws:') });
  try {
    await run.wait('open');
    run.handle.send('proxied echo', false);
    await run.wait('message');
    assert.equal(run.events.find((e) => e.type === 'message')!.data, 'proxied echo');
    assert.ok(seen.length > count);
  } finally {
    run.handle.stop();
  }
});
test('gRPC uses an authenticated CONNECT tunnel with per-session routing', async () => {
  const count = seen.length,
    run = live({
      protocol: 'grpc',
      url: rpcAddress,
      body: '{"text":"proxied RPC"}',
      grpc: { proto, method: '/test.Echo/Unary', tls: false },
    });
  try {
    await run.wait('closed');
    assert.equal(
      run.events.filter((e) => e.type === 'error').length,
      0,
      JSON.stringify(run.events),
    );
    assert.equal(
      JSON.parse(run.events.find((e) => e.type === 'message')!.data).text,
      'proxied RPC',
    );
    assert.ok(seen.length > count);
    assert.equal(seen.at(-1)!.auth, auth);
  } finally {
    run.handle.stop();
  }
  const unsupported = live({
    protocol: 'grpc',
    url: rpcAddress,
    httpSettings: config(secureProxy),
    grpc: { proto, method: '/test.Echo/Unary', tls: false },
  });
  await unsupported.wait('closed');
  assert.ok(unsupported.events.some((e) => e.type === 'error' && /HTTP CONNECT/.test(e.data)));
});
test('workspace, collection, request and documentation exports redact proxy credentials', () => {
  const r: ApiRequest = {
    id: 'r',
    name: 'Proxy',
    folder: 'Group',
    method: 'GET',
    url: origin,
    body: '',
    params: [],
    headers: [],
    auth: 'None',
    token: '',
    password: '',
    username: '',
    tests: '',
    response: null,
    httpSettings: config(),
  };
  const state: WorkspaceState = {
    requests: [r],
    environments: [],
    tabs: ['r'],
    history: [],
    environment: 0,
    settings: { httpSettings: config() } as WorkspaceState['settings'],
    collectionHttpSettings: { Group: config() },
  };
  const output = exportCollection(state, 'workbench');
  const json = Buffer.from(output.data).toString();
  assert.doesNotMatch(json, /proxy-user|proxy-pass/);
  assert.doesNotMatch(JSON.stringify(collectionRequests([r])), /proxy-user|proxy-pass/);
  const restored = importFiles([{ name: output.name, data: output.data }]);
  assert.equal(restored.data.requests[0].httpSettings?.proxyUrl, proxy);
  assert.equal(state.requests[0].httpSettings!.proxyPassword, 'proxy-pass');
});
