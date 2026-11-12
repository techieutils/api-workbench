import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHTTPServer, type Server as HTTPServer } from 'node:http';
import { createServer as createTCPServer, type Server as TCPServer } from 'node:net';
import { once } from 'node:events';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { Server as SocketIOServer } from 'socket.io';
import type { Aedes } from 'aedes';
import { startProtocol } from './protocols';
import { generateLiveCode } from './codegen-live';
import { protocolCredentialURL } from './protocol-auth';
import type { ProtocolEvent, ProtocolPayload } from '@techieutils/api-workbench-common/types';
import {
  checkedSendOptions,
  defaultMQTT,
  mqttOriginURL,
  mqttTopicProblem,
  normalizedMQTT,
  normalizedSocketIO,
} from '@techieutils/api-workbench-common/protocol-config';

/** Socket.IO and MQTT sessions against a real Socket.IO server and an in-process MQTT broker. */

let http: HTTPServer;
let io: SocketIOServer;
let tcp: TCPServer;
let mqttSockets: WebSocketServer;
let broker: Aedes;
let httpURL: string;
let mqttURL: string;
const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

before(async () => {
  http = createHTTPServer();
  io = new SocketIOServer(http);
  io.on('connection', (socket) => {
    socket.emit('welcome', { hello: socket.handshake.headers['x-team'] ?? 'world' });
    socket.on('echo', (value: unknown, ack?: (reply: unknown) => void) => {
      socket.emit('echo', value);
      if (typeof ack === 'function') ack({ ok: true, value });
    });
  });
  io.of('/admin').use((socket, next) =>
    socket.handshake.headers.authorization === 'Bearer good'
      ? next()
      : next(new Error('unauthorized')),
  );
  io.of('/admin').on('connection', (socket) => socket.emit('admin', 'welcome'));

  const { Aedes } = await import('aedes');
  broker = await Aedes.createBroker();
  // Anonymous clients are allowed; a username must come with the right password.
  broker.authenticate = (_client, username, password, done) =>
    done(null, !username || (username === 'user' && password?.toString() === 'pass'));
  tcp = createTCPServer((stream) => broker.handle(stream));
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  mqttURL = `mqtt://127.0.0.1:${(tcp.address() as { port: number }).port}`;
  mqttSockets = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/mqtt')) return;
    // Headers reach the broker only over WebSocket; this one proves they were sent.
    if (request.headers['x-team'] !== 'blue') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    mqttSockets.handleUpgrade(request, socket, head, (ws) =>
      broker.handle(createWebSocketStream(ws)),
    );
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  httpURL = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => {
  await io.close();
  for (const client of mqttSockets.clients) client.terminate();
  mqttSockets.close();
  await new Promise<void>((resolve) => broker.close(() => resolve()));
  tcp.close();
  http.closeAllConnections();
});

function run(input: Partial<ProtocolPayload>) {
  const events: ProtocolEvent[] = [];
  const payload: ProtocolPayload = {
    sessionId: crypto.randomUUID(),
    protocol: 'socketio',
    url: httpURL,
    headers: {},
    body: '',
    timeoutMs: 4000,
    ...input,
  };
  const session = startProtocol(payload, (event) => events.push(event));
  const wait = async (predicate: (event: ProtocolEvent) => boolean) => {
    const deadline = Date.now() + 4000;
    while (!events.some(predicate)) {
      if (Date.now() > deadline) throw new Error(`Event timed out: ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return events.find(predicate)!;
  };
  return { events, session, wait, closed: () => wait((event) => event.type === 'closed') };
}

test('Socket.IO receives every event, emits JSON or text, and reads acknowledgements', async () => {
  const { session, wait, closed, events } = run({
    headers: { 'x-team': 'blue' },
    socketio: { path: '/socket.io', event: 'echo', ack: false },
  });
  const welcome = await wait((event) => event.type === 'message' && event.event === 'welcome');
  assert.deepEqual(JSON.parse(welcome.data), { hello: 'blue' }, 'headers reach the handshake');
  const open = await wait((event) => event.type === 'open');
  assert.equal(open.writable, true);
  assert.match(events.find((event) => event.type === 'metadata')!.data, /"transport":"websocket"/);

  session.send('{"n":1}', false);
  const echoed = await wait((event) => event.type === 'message' && event.event === 'echo');
  assert.equal(echoed.data, '{"n":1}', 'JSON text is emitted as its value');
  session.send('plain text', false, { event: 'echo' });
  await wait((event) => event.type === 'message' && event.data === 'plain text');
  session.send('[1,2]', false, { event: 'echo', ack: true });
  const ack = await wait((event) => event.type === 'message' && event.event === 'echo (ack)');
  assert.deepEqual(JSON.parse(ack.data), { ok: true, value: [1, 2] });
  assert.ok(events.some((event) => event.type === 'sent' && event.event === 'echo'));

  assert.throws(() => session.send('x', false, { event: '' }), /event/);
  assert.throws(() => session.send('x', false, { event: 'connect' }), /reserved/);
  session.stop();
  await closed();
});

test('Socket.IO namespaces come from the URL, and connection errors are reported', async () => {
  const allowed = run({ url: `${httpURL}/admin`, headers: { authorization: 'Bearer good' } });
  const admin = await allowed.wait((event) => event.type === 'message');
  assert.equal(admin.event, 'admin');
  assert.equal(admin.data, 'welcome');
  allowed.session.stop();
  await allowed.closed();

  const refused = run({ url: `${httpURL}/admin`, headers: { authorization: 'Bearer bad' } });
  const error = await refused.wait((event) => event.type === 'error');
  assert.match(error.data, /unauthorized/);
  await refused.closed();

  const wrongPath = run({ socketio: { path: '/elsewhere', event: 'message', ack: false } });
  await wrongPath.wait((event) => event.type === 'error');

  for (const [input, message] of [
    [{ url: 'ftp://127.0.0.1/' }, /http/],
    [{ socketio: { path: 'socket.io', event: 'message', ack: false } }, /start with \//],
    [
      { signing: { type: 'digest', username: 'u', password: 'p' } as ProtocolPayload['signing'] },
      /not supported for Socket\.IO/,
    ],
  ] as const) {
    const session = run(input as Partial<ProtocolPayload>);
    assert.match((await session.wait((event) => event.type === 'error')).data, message);
  }
});

test('MQTT subscribes, publishes with QoS and retain, and receives its own messages', async () => {
  const { session, wait, closed, events } = run({
    protocol: 'mqtt',
    url: mqttURL,
    mqtt: {
      ...defaultMQTT(),
      clientId: 'workbench-test',
      subscriptions: [
        { topic: 'sensors/+/temperature', qos: 1, enabled: true },
        { topic: 'ignored/#', qos: 0, enabled: false },
      ],
      topic: 'sensors/kitchen/temperature',
      qos: 1,
    },
  });
  const open = await wait((event) => event.type === 'open');
  assert.match(open.data, /workbench-test/);
  await wait(
    (event) =>
      event.type === 'status' &&
      /Subscribed to sensors\/\+\/temperature \(QoS 1\)/.test(event.data),
  );
  assert.ok(!events.some((event) => /ignored/.test(event.data)), 'disabled rows are skipped');

  session.send('21.5', false);
  const received = await wait((event) => event.type === 'message');
  assert.equal(received.event, 'sensors/kitchen/temperature');
  assert.equal(received.data, '21.5');
  session.send('AAH/', true, { topic: 'sensors/hall/temperature', qos: 0 });
  const bytes = await wait((event) => event.type === 'message' && event.binary === true);
  assert.equal(bytes.data, 'AAH/', 'non-text payloads arrive as base64');

  assert.throws(() => session.send('x', false, { topic: 'sensors/#' }), /wildcards/);
  assert.throws(() => session.send('x', false, { topic: '' }), /topic/);
  session.stop();
  await closed();

  // A retained message is delivered to a later subscriber.
  const publisher = run({
    protocol: 'mqtt',
    url: mqttURL,
    mqtt: { ...defaultMQTT(), subscriptions: [] },
  });
  await publisher.wait((event) => event.type === 'open');
  publisher.session.send('on', false, { topic: 'lights/porch', qos: 1, retain: true });
  await publisher.wait((event) => event.type === 'sent');
  await new Promise((resolve) => setTimeout(resolve, 50));
  publisher.session.stop();
  const subscriber = run({
    protocol: 'mqtt',
    url: mqttURL,
    mqtt: { ...defaultMQTT(), subscriptions: [{ topic: 'lights/porch', qos: 0, enabled: true }] },
  });
  const retained = await subscriber.wait((event) => event.type === 'message');
  assert.equal(retained.data, 'on');
  subscriber.session.stop();
});

test('MQTT takes Basic auth as username and password, and refuses other schemes over TCP', async () => {
  const good = run({
    protocol: 'mqtt',
    url: mqttURL,
    headers: { Authorization: basic('user', 'pass') },
  });
  await good.wait((event) => event.type === 'open');
  good.session.stop();

  const bad = run({
    protocol: 'mqtt',
    url: mqttURL,
    headers: { authorization: basic('user', 'nope') },
  });
  assert.match((await bad.wait((event) => event.type === 'error')).data, /Not authorized|refused/i);

  const bearer = run({
    protocol: 'mqtt',
    url: mqttURL,
    headers: { authorization: 'Bearer token' },
  });
  assert.match((await bearer.wait((event) => event.type === 'error')).data, /Basic auth/);

  const embedded = run({ protocol: 'mqtt', url: mqttURL.replace('//', '//user:pass@') });
  assert.match((await embedded.wait((event) => event.type === 'error')).data, /not in the URL/);

  const refused = run({ protocol: 'mqtt', url: 'mqtt://127.0.0.1:1', timeoutMs: 2000 });
  await refused.wait((event) => event.type === 'error');

  const filter = run({
    protocol: 'mqtt',
    url: mqttURL,
    mqtt: { ...defaultMQTT(), subscriptions: [{ topic: 'a/#/b', qos: 0, enabled: true }] },
  });
  assert.match((await filter.wait((event) => event.type === 'error')).data, /# must be/);
});

test('MQTT over WebSocket sends headers with the handshake', async () => {
  const url = `${httpURL.replace('http:', 'ws:')}/mqtt`;
  const allowed = run({
    protocol: 'mqtt',
    url,
    headers: { 'x-team': 'blue', authorization: basic('user', 'pass') },
    // aedes speaks MQTT 3.1.1, so MQTT 5 is covered by the snippet tests only.
    mqtt: defaultMQTT(),
  });
  await allowed.wait((event) => event.type === 'open');
  allowed.session.stop();
  const forbidden = run({ protocol: 'mqtt', url, headers: {} });
  await forbidden.wait((event) => event.type === 'error');
});

test('settings are normalized, topics checked, and broker origins mapped for credentials', () => {
  assert.deepEqual(normalizedSocketIO({ path: '', event: 5, ack: 'yes' }), {
    path: '/socket.io',
    event: 'message',
    ack: false,
  });
  const mqtt = normalizedMQTT({
    version: 3,
    keepalive: -1,
    subscriptions: [{ topic: 'a', qos: 7 }],
    qos: 2,
  });
  assert.equal(mqtt?.version, 4);
  assert.equal(mqtt?.keepalive, 60);
  assert.deepEqual(mqtt?.subscriptions, [{ topic: 'a', qos: 0, enabled: true }]);
  assert.equal(mqtt?.qos, 2);
  assert.equal(normalizedMQTT('nope'), undefined);

  assert.equal(mqttTopicProblem('a/+/b', true), undefined);
  assert.equal(mqttTopicProblem('a/b/#', true), undefined);
  assert.match(mqttTopicProblem('a/b+', true)!, /\+ must be/);
  assert.match(mqttTopicProblem('a/+', false)!, /wildcards/);
  assert.throws(() => checkedSendOptions('mqtt', { topic: 'a', qos: 3 }), /QoS/);
  assert.deepEqual(checkedSendOptions('websocket', { topic: 'ignored' }), undefined);

  assert.equal(mqttOriginURL('mqtt://broker.test').origin, 'http://broker.test:1883');
  assert.equal(mqttOriginURL('mqtts://broker.test').origin, 'https://broker.test:8883');
  assert.equal(mqttOriginURL('wss://broker.test/mqtt').origin, 'https://broker.test');
  const base = { sessionId: 'x', headers: {}, body: '', timeoutMs: 1000 };
  assert.equal(
    new URL(protocolCredentialURL({ ...base, protocol: 'mqtt', url: 'mqtts://broker.test:9000' }))
      .origin,
    'https://broker.test:9000',
  );
  assert.equal(
    new URL(protocolCredentialURL({ ...base, protocol: 'socketio', url: 'wss://io.test/chat' }))
      .origin,
    'https://io.test',
  );
});

test('Socket.IO and MQTT snippets use the event, topics, and Basic credentials', () => {
  const socket = generateLiveCode(
    {
      protocol: 'socketio',
      url: 'wss://io.example.com/chat',
      method: 'GET',
      headers: { 'X-Team': 'blue' },
      body: '{"text":"hi"}',
      bodyType: 'raw',
      fields: [],
      socketio: { path: '/socket.io', event: 'chat message', ack: true },
    },
    'node',
    'socket.io-client',
  ).code;
  assert.match(socket, /io\("https:\/\/io\.example\.com\/chat"/);
  assert.match(socket, /timeout\(10000\)\.emit\("chat message"/);
  const mqtt = generateLiveCode(
    {
      protocol: 'mqtt',
      url: 'mqtts://broker.example.com',
      method: 'GET',
      headers: { Authorization: basic('ada', 'secret') },
      body: 'on',
      bodyType: 'raw',
      fields: [],
      mqtt: { ...defaultMQTT(), topic: 'lights/porch', retain: true },
    },
    'shell',
    'mosquitto',
  ).code;
  assert.match(mqtt, /mosquitto_pub[\s\S]*-L 'mqtts:\/\/broker\.example\.com\/lights\/porch'/);
  assert.match(mqtt, /-u 'ada'[\s\S]*-P 'secret'/);
  assert.match(mqtt, /-r/);
  const redacted = generateLiveCode(
    {
      protocol: 'mqtt',
      url: 'mqtt://broker.example.com',
      method: 'GET',
      headers: { Authorization: 'Basic <REDACTED>' },
      body: '',
      bodyType: 'raw',
      fields: [],
    },
    'node',
    'mqtt',
  ).code;
  assert.match(redacted, /"password": "<REDACTED>"/);
});
