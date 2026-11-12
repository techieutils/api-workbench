import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { parse } from 'protobufjs';
import { WorkspaceStore } from '@techieutils/api-workbench-electron/workspaces';
import type { ApiRequest, WorkspaceState } from '@techieutils/api-workbench-common/types';
import { main } from './cli';

/** request connect: live requests opened from the command line, against local servers. */

const proto = `syntax = "proto3"; package test;
service Echo {
 rpc Unary (Message) returns (Message);
 rpc Chat (stream Message) returns (stream Message);
}
message Message { string text = 1; }`;
let root: string;
let team: string;
// Reassigned by a test that connects to its own folder.
let http: Server;
let ws: WebSocketServer;
let rpc: grpc.Server;

const request = (id: string, extra: Partial<ApiRequest>): ApiRequest => ({
  id,
  name: id,
  method: 'GET',
  url: '',
  folder: 'Live',
  params: [],
  headers: [],
  body: '',
  auth: 'None',
  token: '',
  username: '',
  password: '',
  tests: '',
  response: null,
  ...extra,
});

before(async () => {
  http = createServer();
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = (http.address() as { port: number }).port;
  ws = new WebSocketServer({ server: http });
  ws.on('connection', (socket, incoming) => {
    socket.send(`hello ${incoming.headers['x-who'] ?? ''}`.trim());
    socket.on('message', (message) => socket.send(`echo ${message}`));
  });
  rpc = new grpc.Server();
  const definition = loader.fromJSON(parse(proto).root.toJSON(), { defaults: true });
  rpc.addService(definition['test.Echo'] as grpc.ServiceDefinition, {
    unary: (
      call: grpc.ServerUnaryCall<{ text: string }, object>,
      done: grpc.sendUnaryData<object>,
    ) => done(null, { text: `unary ${call.request.text}` }),
    chat: (call: grpc.ServerDuplexStream<{ text: string }, object>) => {
      call.on('data', (value) => call.write({ text: `chat ${value.text}` }));
      call.on('end', () => call.end());
    },
  });
  const grpcPort = await new Promise<number>((resolve, reject) =>
    rpc.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'api-workbench-connect-'));
  const state = {
    requests: [
      request('socket', {
        name: 'Socket',
        protocol: 'websocket',
        url: 'ws://127.0.0.1:{{port}}/live',
        headers: [{ enabled: true, key: 'X-Who', value: '{{who}}' }],
      }),
      request('unary', {
        name: 'Unary',
        protocol: 'grpc',
        url: `127.0.0.1:${grpcPort}`,
        body: '{"text":"{{who}}"}',
        grpc: { proto, method: '/test.Echo/Unary', tls: false },
      }),
      request('chat', {
        name: 'Chat',
        protocol: 'grpc',
        url: `127.0.0.1:${grpcPort}`,
        grpc: { proto, method: '/test.Echo/Chat', tls: false },
      }),
      request('plain', { name: 'Plain', url: 'http://127.0.0.1:9' }),
    ],
    tabs: [],
    active: 'socket',
    environments: [
      {
        name: 'Local',
        variables: [
          { enabled: true, key: 'port', value: String(port) },
          { enabled: true, key: 'who', value: 'ada' },
        ],
      },
    ],
    environment: 0,
    history: [],
  } as unknown as WorkspaceState;
  const store = new WorkspaceStore(path.join(root, 'data'));
  await store.list();
  team = path.join(root, 'team');
  await store.openFolder(team, state, 'Ada', 'share');
  store.close();
});
after(async () => {
  for (const client of ws.clients) client.terminate();
  await new Promise<void>((resolve) => ws.close(() => resolve()));
  http.close();
  rpc.forceShutdown();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * Runs request connect, giving it each input line once the output so far matches its pattern,
 * as a person typing after seeing the connection open would.
 */
async function connect(id: string, script: [RegExp, string][], extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const seen = (pattern: RegExp) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const check = () =>
        pattern.test(out.join('\n'))
          ? resolve()
          : Date.now() - started > 5000
            ? reject(new Error(`Never saw ${pattern}: ${out.join('\n')}`))
            : setTimeout(check, 10);
      check();
    });
  async function* lines() {
    for (const [pattern, line] of script) {
      await seen(pattern);
      yield line;
    }
  }
  const code = await main(
    ['request', 'connect', id, '--dir', team, '-e', 'Local', '--json', ...extra],
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    { API_WORKBENCH_DATA_DIR: path.join(root, 'data') },
    false,
    undefined,
    { lines: lines() },
  );
  return { code, events: out.map((line) => JSON.parse(line)), err: err.join('\n') };
}

test('a WebSocket opens with its variables and headers, sends each line, and stops', async () => {
  const { code, events } = await connect('socket', [
    [/hello ada/, JSON.stringify({ action: 'send', message: 'one' })],
    [/echo one/, JSON.stringify({ action: 'nonsense' })],
    [/Not sent/, JSON.stringify({ action: 'stop' })],
  ]);
  assert.equal(code, 0, 'a line that cannot be sent leaves the connection usable');
  const shown = events.map((event) => `${event.type} ${event.data}`);
  assert.ok(shown.includes('open Connected') || shown.some((line) => line.startsWith('open')));
  assert.ok(shown.includes('message hello ada'), shown.join('\n'));
  assert.ok(shown.includes('sent one'));
  assert.ok(shown.includes('message echo one'));
  assert.equal(events.at(-1).type, 'closed');
});

test('a unary gRPC call sends its body and closes with the reply', async () => {
  const { code, events } = await connect('unary', []);
  assert.equal(code, 0);
  assert.ok(
    events.some((event) => event.type === 'message' && /unary ada/.test(event.data)),
    JSON.stringify(events),
  );
});

test('a bidirectional gRPC stream sends each line, and finish ends it', async () => {
  const { code, events } = await connect('chat', [
    [/"type":"open"/, JSON.stringify({ action: 'send', message: '{"text":"hi"}' })],
    [/chat hi/, JSON.stringify({ action: 'finish' })],
  ]);
  assert.equal(code, 0);
  assert.ok(events.some((event) => event.type === 'message' && /chat hi/.test(event.data)));
  assert.equal(events.at(-1).type, 'closed');
});

test('--allow-host connects only to the hosts it names, after variables', async () => {
  let connections = 0;
  const count = () => connections++;
  ws.on('connection', count);
  try {
    // The WebSocket's port comes from the environment; its host is 127.0.0.1.
    const refused = await connect('socket', [], ['--allow-host', 'api.example.com']);
    assert.equal(refused.code, 2);
    assert.match(
      refused.err,
      /Not sent: it goes to 127\.0\.0\.1, which --allow-host does not list/,
    );
    assert.equal(connections, 0, 'nothing was opened');
    // A gRPC destination is host:port, without a scheme.
    const grpc = await connect('unary', [], ['--allow-host', '127.0.0.1']);
    assert.equal(grpc.code, 0, grpc.err);
    const away = await connect('unary', [], ['--allow-host', 'localhost']);
    assert.equal(away.code, 2);
  } finally {
    ws.off('connection', count);
  }
});

test('an HTTP request is not connected', async () => {
  const { code, err } = await connect('plain', []);
  assert.equal(code, 2);
  assert.match(err, /request send/);
});

test('Socket.IO and MQTT connect, send with their options, and stop', async (t) => {
  const { Server: SocketIOServer } = await import('socket.io');
  const { Aedes } = await import('aedes');
  const { createServer: createTCPServer } = await import('node:net');
  const web = createServer();
  const io = new SocketIOServer(web);
  io.on('connection', (socket) => {
    socket.emit('welcome', 'hi');
    socket.on('echo', (value: unknown) => socket.emit('echo', value));
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  const broker = await Aedes.createBroker();
  const tcp = createTCPServer((stream) => broker.handle(stream));
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  t.after(async () => {
    await io.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    tcp.close();
  });
  const store = new WorkspaceStore(path.join(root, 'pubsub-data'));
  await store.list();
  const folder = path.join(root, 'pubsub');
  await store.openFolder(
    folder,
    {
      requests: [
        request('io', {
          name: 'Chat',
          protocol: 'socketio',
          url: `http://127.0.0.1:${(web.address() as { port: number }).port}`,
          socketio: { path: '/socket.io', event: 'echo', ack: false },
        } as Partial<ApiRequest>),
        request('broker', {
          name: 'Sensors',
          protocol: 'mqtt',
          url: `mqtt://127.0.0.1:${(tcp.address() as { port: number }).port}`,
          mqtt: {
            clientId: '',
            version: 4,
            cleanStart: true,
            keepalive: 60,
            subscriptions: [{ topic: 'sensors/#', qos: 0, enabled: true }],
            topic: 'sensors/kitchen',
            qos: 0,
            retain: false,
          },
        } as Partial<ApiRequest>),
      ],
      tabs: [],
      active: 'io',
      environments: [{ name: 'Local', variables: [] }],
      environment: 0,
      history: [],
    } as unknown as WorkspaceState,
    'Ada',
    'share',
  );
  store.close();
  const previous = team;
  team = folder;
  t.after(() => {
    team = previous;
  });
  const io1 = await connect('io', [
    [/welcome/, JSON.stringify({ action: 'send', message: '{"n":1}', options: { event: 'echo' } })],
    [
      // Received echoes carry their event; the JSON keys come in any order.
      /^(?=.*"type":"message")(?=.*"event":"echo").*$/m,
      JSON.stringify({ action: 'send', message: 'x', options: { event: '' } }),
    ],
    [/Not sent/, JSON.stringify({ action: 'stop' })],
  ]);
  assert.equal(io1.code, 0);
  assert.ok(io1.events.some((event) => event.type === 'message' && event.event === 'echo'));
  const mqtt = await connect('broker', [
    [
      /"type":"open"/,
      JSON.stringify({ action: 'send', message: '21.5', options: { topic: 'sensors/kitchen' } }),
    ],
    [
      /^(?=.*"type":"message")(?=.*"data":"21\.5").*$/m,
      JSON.stringify({ action: 'send', message: 'x', options: { topic: 'sensors/#' } }),
    ],
    [/Not sent/, JSON.stringify({ action: 'stop' })],
  ]);
  assert.equal(mqtt.code, 0, mqtt.err);
  assert.ok(
    mqtt.events.some((event) => event.type === 'message' && event.data === '21.5'),
    JSON.stringify(mqtt.events),
  );
});

test('a live request’s settings are changed from a file, checked by protocol', async () => {
  const dir = ['--dir', team];
  const settings = path.join(root, 'settings.json');
  const run = async (id: string, value: unknown) => {
    await fs.writeFile(settings, JSON.stringify(value));
    return main(
      ['request', 'update', id, '--settings-file', settings, ...dir],
      { out: () => undefined, err: () => undefined },
      { API_WORKBENCH_DATA_DIR: path.join(root, 'data') },
      false,
    );
  };
  const show = async (id: string) => {
    const out: string[] = [];
    await main(
      ['request', 'show', id, '--json', ...dir],
      { out: (line) => out.push(line), err: () => undefined },
      { API_WORKBENCH_DATA_DIR: path.join(root, 'data') },
      false,
    );
    return JSON.parse(out.join('\n'));
  };
  assert.equal(await run('chat', { grpc: { method: '/test.Echo/Unary' } }), 0);
  const chat = await show('chat');
  assert.equal(chat.grpc.method, '/test.Echo/Unary');
  assert.equal(chat.grpc.proto, proto, 'the schema is kept when only the method changes');
  assert.deepEqual(
    chat.grpc.methods.map((method: { path: string }) => method.path),
    ['/test.Echo/Unary', '/test.Echo/Chat'],
  );
  await run('chat', { grpc: { method: '/test.Echo/Chat' } });
  assert.equal(
    await run('chat', { mqtt: { topic: 'x' } }),
    2,
    'a gRPC request has no MQTT settings',
  );
  assert.equal(await run('socket', { websocket: {} }), 2);
});

test('a live request with a saved credential connects with it, from a vault with a password', async (t) => {
  const { WorkbenchVault } = await import('@techieutils/api-workbench-electron/workbench-vault');
  const { WebSocketServer: Sockets } = await import('ws');
  const sockets = new Sockets({ port: 0, host: '127.0.0.1' });
  await once(sockets, 'listening');
  sockets.on('connection', (socket, incoming) =>
    socket.send(`auth ${incoming.headers.authorization ?? 'none'}`),
  );
  t.after(() => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
  });
  const port = (sockets.address() as { port: number }).port;
  const data = path.join(root, 'vault-data');
  const store = new WorkspaceStore(data);
  await store.list();
  await store.save(
    {
      requests: [
        request('feed', {
          name: 'Feed',
          protocol: 'websocket',
          url: `ws://127.0.0.1:${port}/feed`,
          auth: 'Saved credential',
        } as Partial<ApiRequest>),
      ],
      tabs: [],
      active: 'feed',
      environments: [{ name: 'Local', variables: [] }],
      environment: 0,
      history: [],
    } as unknown as WorkspaceState,
    'default',
  );
  store.close();
  const password = 'Correct horse 9 battery';
  const vault = new WorkbenchVault(path.join(data, 'vault-key.json'), {
    cost: { N: 1024, r: 8, p: 1 },
  });
  await vault.setup(password);
  vault.lock();
  const env = {
    API_WORKBENCH_DATA_DIR: data,
    API_WORKBENCH_VAULT_PASSWORD: password,
    TOKEN: 'live-123',
  };
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      args,
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      { ...env, ...extra },
      false,
      undefined,
      { lines: (async function* () {})() },
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  assert.equal(
    (
      await run([
        'secret',
        'set',
        'Feed token',
        '--type',
        'bearer',
        '--origin',
        `http://127.0.0.1:${port}`,
        '--from-env',
        'TOKEN',
      ])
    ).code,
    0,
  );
  const [credential] = JSON.parse((await run(['secret', 'list', '--json'])).out);
  assert.equal(
    (
      await run([
        'request',
        'update',
        'feed',
        '--auth',
        'credential',
        '--credential',
        credential.id,
      ])
    ).code,
    0,
  );
  // With the vault's password, the credential's token goes with the connection.
  const opened = await new Promise<string[]>((resolve) => {
    const out: string[] = [];
    void main(
      ['request', 'connect', 'feed', '--json'],
      { out: (line) => out.push(line), err: (line) => out.push(line) },
      env,
      false,
      undefined,
      {
        lines: (async function* () {
          while (!out.some((line) => line.includes('auth ')))
            await new Promise((r) => setTimeout(r, 10));
          yield JSON.stringify({ action: 'stop' });
        })(),
      },
    ).then(() => resolve(out));
  });
  assert.ok(
    opened.some((line) => line.includes('auth Bearer live-123')),
    opened.join('\n'),
  );
  // Without it, the vault stays locked and says how to open it.
  const locked = await run(['request', 'connect', 'feed', '--json'], {
    API_WORKBENCH_VAULT_PASSWORD: '',
  });
  assert.equal(locked.code, 2);
  assert.match(locked.err, /vault is locked/i);
});
