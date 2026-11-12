import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { io as socketIO } from 'socket.io-client';
import mqtt from 'mqtt';
import { MockServers } from './mock-servers';
import { sendHttpRequest } from './http';
import { closeHTTPTransports } from './http-transport';
import {
  isFixedMqttTopic,
  matchMqttTopic,
  mqttFilterMatches,
  newMock,
  newMockRoute,
  newMockStream,
} from '@techieutils/api-workbench-common/mocks';
import type { MockLogEntry, MockRoute } from '@techieutils/api-workbench-common/types';

/** TRACE and CONNECT routes, and Socket.IO and MQTT routes, against real clients. */

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
/** The first time a Socket.IO client gets an event, with its arguments. */
const once = (
  socket: { once(event: string, listener: (...args: unknown[]) => void): unknown },
  event: string,
) => new Promise<unknown[]>((resolve) => socket.once(event, (...args: unknown[]) => resolve(args)));
const stream = (kind: 'socketio' | 'mqtt', patch: Partial<NonNullable<MockRoute['stream']>>) => ({
  ...newMockStream(kind),
  intervalMs: 10,
  repeat: false,
  ...patch,
});

test('TRACE and CONNECT routes answer, and a CONNECT is matched by its host:port', async (t) => {
  const log: MockLogEntry[] = [];
  const servers = new MockServers((entry) => log.push(entry));
  t.after(async () => {
    await servers.stopAll();
    await closeHTTPTransports();
  });
  const port = await freePort();
  await servers.start({
    ...newMock('Proxy', []),
    port,
    routes: [
      newMockRoute({
        id: 'trace',
        method: 'TRACE',
        path: '/echo',
        body: 'TRACE {{headers.x-team}}',
      }),
      newMockRoute({
        id: 'tunnel',
        method: 'CONNECT',
        path: '/api.example.test:443',
        status: 200,
        headers: [{ key: 'X-Tunnel', value: 'mocked', enabled: true }],
        body: '',
      }),
      newMockRoute({
        id: 'denied',
        method: 'CONNECT',
        path: '/blocked.example:443',
        status: 403,
        headers: [{ key: 'Content-Type', value: 'text/plain', enabled: true }],
        body: 'Not through this proxy',
      }),
    ],
  });
  const send = (method: string, url: string, settings?: object) =>
    sendHttpRequest(
      {
        id: crypto.randomUUID(),
        method,
        url,
        headers: { 'X-Team': 'payments' },
        body: '',
        ...(settings ? { httpSettings: settings } : {}),
      },
      new AbortController(),
    );
  const traced = await send('TRACE', `http://127.0.0.1:${port}/echo`);
  assert.equal(traced.status, 200);
  assert.equal(traced.body, 'TRACE payments');

  const proxy = { proxyMode: 'custom', proxyUrl: `http://127.0.0.1:${port}` };
  const tunnel = await send('CONNECT', 'https://api.example.test/', proxy);
  assert.equal(tunnel.status, 200);
  assert.equal(tunnel.headers!['x-tunnel'], 'mocked');
  const denied = await send('CONNECT', 'https://blocked.example/', proxy);
  assert.equal(denied.status, 403);
  assert.equal(denied.body, 'Not through this proxy');
  const missing = await send('CONNECT', 'https://other.example/', proxy);
  assert.equal(missing.status, 404);
  assert.deepEqual(
    log.map((entry) => `${entry.method} ${entry.path} ${entry.status}`),
    [
      'TRACE /echo 200',
      'CONNECT /api.example.test:443 200',
      'CONNECT /blocked.example:443 403',
      'CONNECT /other.example:443 404',
    ],
  );
});

test('a Socket.IO route emits its events, answers events and acknowledgements, and checks the handshake', async (t) => {
  const log: MockLogEntry[] = [];
  const servers = new MockServers((entry) => log.push(entry));
  t.after(() => servers.stopAll());
  const port = await freePort();
  const mock = {
    ...newMock('Live', []),
    port,
    routes: [
      newMockRoute({
        id: 'orders',
        kind: 'socketio',
        path: '/orders',
        headers: [],
        body: '',
        stream: stream('socketio', {
          messages: [{ id: 'm1', data: '{"hello": "{{headers.x-team}}"}', event: 'welcome' }],
          reply: '{"echo": {{body}}}',
        }),
      }),
      newMockRoute({
        id: 'admin',
        kind: 'socketio',
        path: '/admin',
        headers: [],
        body: '',
        rules: [
          { enabled: true, target: 'body', name: 'token', operator: 'equals', value: 'good' },
        ],
        stream: stream('socketio', { messages: [{ id: 'm2', data: 'welcome, admin' }] }),
      }),
    ],
  };
  await servers.start(mock);
  const base = `http://127.0.0.1:${port}`;
  const client = socketIO(`${base}/orders`, {
    transports: ['websocket'],
    extraHeaders: { 'X-Team': 'payments' },
  });
  t.after(() => client.close());
  const [welcome] = await once(client, 'welcome');
  assert.deepEqual(welcome, { hello: 'payments' });
  assert.deepEqual(await client.emitWithAck('price', { sku: 'A1' }), { echo: { sku: 'A1' } });
  client.emit('note', 'plain');
  const [echoed] = await once(client, 'note');
  assert.deepEqual(echoed, { echo: 'plain' });

  // Long polling reaches the same routes; the auth payload is what body rules see.
  const admin = socketIO(`${base}/admin`, { transports: ['polling'], auth: { token: 'good' } });
  t.after(() => admin.close());
  const [message] = await once(admin, 'message');
  assert.equal(message, 'welcome, admin');
  const refused = socketIO(`${base}/admin`, { transports: ['polling'], auth: { token: 'bad' } });
  t.after(() => refused.close());
  const [error] = await once(refused, 'connect_error');
  assert.match((error as Error).message, /No mock Socket.IO route/);
  const nowhere = socketIO(`${base}/missing`, { transports: ['websocket'] });
  t.after(() => nowhere.close());
  await once(nowhere, 'connect_error');

  // Plain HTTP routes keep working beside Socket.IO.
  assert.equal((await fetch(`${base}/orders`)).status, 404);
  const connected = log.filter((entry) => entry.protocol === 'socketio');
  assert.deepEqual(
    connected.map((entry) => `${entry.path} ${entry.status} ${entry.routeId ?? '-'}`),
    ['/orders 101 orders', '/admin 101 admin', '/admin 404 -', '/missing 404 -'],
  );

  // With no Socket.IO routes left, the endpoint is gone.
  await servers.start({ ...mock, routes: [newMockRoute({ path: '/health' })] });
  assert.equal((await fetch(`${base}/socket.io/?EIO=4&transport=polling`)).status, 404);
});

test('an MQTT route publishes to subscribers, replies to messages, and serves MQTT over WebSocket', async (t) => {
  const log: MockLogEntry[] = [];
  const servers = new MockServers((entry) => log.push(entry));
  t.after(() => servers.stopAll());
  const [port, brokerPort] = [await freePort(), await freePort()];
  await servers.start({
    ...newMock('Devices', []),
    port,
    mqtt: { port: brokerPort },
    routes: [
      newMockRoute({
        id: 'status',
        kind: 'mqtt',
        path: 'devices/:id/status',
        headers: [],
        body: '',
        stream: stream('mqtt', { messages: [{ id: 's1', data: '{"device": "{{params.id}}"}' }] }),
      }),
      newMockRoute({
        id: 'fleet',
        kind: 'mqtt',
        path: 'fleet/summary',
        headers: [],
        body: '',
        stream: stream('mqtt', { messages: [{ id: 'f1', data: '{"online": 3}' }] }),
      }),
      newMockRoute({
        id: 'command',
        kind: 'mqtt',
        path: 'devices/+/cmd',
        headers: [],
        body: '',
        stream: stream('mqtt', { messages: [], reply: '{"ok": true, "got": {{body}}}' }),
      }),
    ],
  });
  assert.deepEqual((await servers.status()).running[0].mqttPort, brokerPort);

  const client = await mqtt.connectAsync(`mqtt://127.0.0.1:${brokerPort}`, {
    clientId: 'sensor-1',
  });
  t.after(() => client.end(true));
  const received = new Map<string, string>();
  client.on('message', (topic, payload) => received.set(topic, payload.toString()));
  await client.subscribeAsync(['devices/42/status', 'fleet/#', 'devices/42/cmd/reply']);
  await client.publishAsync('devices/42/cmd', '{"reboot": true}');
  for (const deadline = Date.now() + 5000; received.size < 3;) {
    if (Date.now() > deadline) throw new Error(`Only got ${[...received.keys()].join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(JSON.parse(received.get('devices/42/status')!), { device: '42' });
  assert.deepEqual(
    JSON.parse(received.get('fleet/summary')!),
    { online: 3 },
    'a wildcard takes fixed topics',
  );
  assert.deepEqual(JSON.parse(received.get('devices/42/cmd/reply')!), {
    ok: true,
    got: { reboot: true },
  });

  // Over WebSocket too; clients still reach each other through the broker.
  const web = await mqtt.connectAsync(`ws://127.0.0.1:${port}/mqtt`);
  t.after(() => web.end(true));
  const replies: string[] = [];
  web.on('message', (topic, payload) => replies.push(`${topic} ${payload}`));
  await web.subscribeAsync(['devices/7/cmd/reply', 'chat']);
  await web.publishAsync('devices/7/cmd', '1');
  await client.publishAsync('chat', 'hello');
  for (const deadline = Date.now() + 5000; replies.length < 2;) {
    if (Date.now() > deadline) throw new Error(`Only got ${replies.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(replies.sort(), ['chat hello', 'devices/7/cmd/reply {"ok": true, "got": 1}']);
  const mqttLog = log.filter((entry) => entry.protocol === 'mqtt');
  assert.ok(
    mqttLog.some(
      (entry) =>
        entry.method === 'SUBSCRIBE' &&
        entry.path === 'devices/42/status' &&
        entry.params?.id === '42',
    ),
  );
  assert.ok(mqttLog.some((entry) => entry.method === 'PUBLISH' && entry.routeId === 'command'));
});

test('MQTT topics match by level, with + and :name for one level and # for the rest', () => {
  assert.deepEqual(matchMqttTopic('devices/:id/status', 'devices/42/status'), { id: '42' });
  assert.deepEqual(matchMqttTopic('devices/+/status', 'devices/42/status'), {});
  assert.deepEqual(matchMqttTopic('devices/#', 'devices/42/status'), { '*': '42/status' });
  assert.equal(matchMqttTopic('devices/:id', 'devices/42/status'), undefined);
  assert.equal(mqttFilterMatches('fleet/#', 'fleet/summary'), true);
  assert.equal(mqttFilterMatches('fleet/+', 'fleet/a/b'), false);
  assert.equal(isFixedMqttTopic('fleet/summary'), true);
  assert.equal(isFixedMqttTopic('devices/:id'), false);
});

test('an MQTT port that clashes with the mock’s own is refused', async (t) => {
  const servers = new MockServers(() => {});
  t.after(() => servers.stopAll());
  const port = await freePort();
  await assert.rejects(
    servers.start({
      ...newMock('Clash', []),
      port,
      mqtt: { port },
      routes: [newMockRoute({ kind: 'mqtt', path: 'a', stream: newMockStream('mqtt') })],
    }),
    /MQTT port other than/,
  );
});
