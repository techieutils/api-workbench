import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINISH_LINE,
  MESSAGE_LIMIT,
  STOP_LINE,
  applyLiveEvent,
  liveDraftFrom,
  liveUpdatePlan,
  liveEvent,
  sendLine,
  type LiveView,
} from './live';

const idle = (protocol: string): LiveView => ({
  view: 'live',
  name: 'Ticker',
  breadcrumb: ['Live', 'Ticker'],
  protocol,
  url: 'ws://127.0.0.1/ticker',
  state: 'idle',
  writable: false,
  finishable: false,
  body: '',
  supported: true,
  events: [],
  saved: {
    url: 'ws://127.0.0.1/ticker',
    headers: [],
    auth: {
      type: 'None',
      username: '',
      secret: '',
      apiKeyIn: 'header',
      credentialId: '',
      options: {},
      secrets: {},
    },
    body: '',
    settings: {},
  },
  revision: 0,
  saving: false,
  hasSecret: false,
});

test('events from request connect move the connection along and fill its log', () => {
  let view = idle('websocket');
  for (const line of [
    '{"type":"connecting","at":1,"data":"Connecting…"}',
    '{"type":"open","at":2,"data":"Connected"}',
    '{"type":"message","at":3,"data":"{\\"price\\":1}"}',
    '{"type":"sent","at":4,"data":"hello"}',
    'not an event',
  ]) {
    const event = liveEvent(line);
    if (event) view = applyLiveEvent(view, event);
  }
  assert.equal(view.state, 'open');
  assert.equal(view.writable, true, 'an open WebSocket takes messages');
  assert.deepEqual(
    view.events.map((event) => [event.type, event.json]),
    [
      ['connecting', false],
      ['open', false],
      ['message', true],
      ['sent', false],
    ],
  );
  assert.equal(view.events[2].text, '{\n  "price": 1\n}', 'JSON is indented');
  view = applyLiveEvent(view, { type: 'closed', at: 5, data: 'Disconnected' });
  assert.equal(view.state, 'closed');
  assert.equal(view.writable, false);
});

test('a gRPC call is writable, and finishable, only while it takes a stream', () => {
  let view = applyLiveEvent(idle('grpc'), { type: 'open', at: 1, data: 'Open', writable: true });
  assert.deepEqual([view.writable, view.finishable], [true, true]);
  view = applyLiveEvent(view, { type: 'status', at: 2, data: 'Half closed', writable: false });
  assert.deepEqual([view.writable, view.finishable], [false, false]);
  const unary = applyLiveEvent(idle('grpc'), { type: 'open', at: 1, data: 'Open' });
  assert.equal(unary.writable, false, 'a unary call takes its one message on connect');
});

test('messages to send are checked, and become input lines', () => {
  assert.deepEqual(sendLine({ message: 'hi\nthere' }), {
    line: '{"action":"send","message":"hi\\nthere"}',
  });
  assert.ok('error' in sendLine({ message: '' }));
  assert.ok('error' in sendLine({ message: 3 }));
  assert.ok('error' in sendLine({ message: 'x'.repeat(MESSAGE_LIMIT + 1) }));
  assert.deepEqual(JSON.parse(FINISH_LINE), { action: 'finish' });
  assert.deepEqual(JSON.parse(STOP_LINE), { action: 'stop' });
});

test('a Socket.IO message carries its event, and an MQTT one its topic, checked as the app does', () => {
  assert.deepEqual(
    JSON.parse(
      (
        sendLine({ message: 'hi', options: { event: 'chat', ack: true } }, 'socketio') as {
          line: string;
        }
      ).line,
    ),
    { action: 'send', message: 'hi', options: { event: 'chat', ack: true } },
  );
  assert.match(
    (sendLine({ message: 'hi', options: { event: '' } }, 'socketio') as { error: string }).error,
    /event/,
  );
  assert.deepEqual(
    JSON.parse(
      (
        sendLine(
          { message: '21.5', options: { topic: 'sensors/kitchen', qos: 1, retain: true } },
          'mqtt',
        ) as {
          line: string;
        }
      ).line,
    ).options,
    { topic: 'sensors/kitchen', qos: 1, retain: true },
  );
  assert.match(
    (sendLine({ message: 'x', options: { topic: 'sensors/#' } }, 'mqtt') as { error: string })
      .error,
    /wildcards/,
  );
  // Options another protocol would take are dropped for a WebSocket.
  assert.deepEqual(
    JSON.parse(
      (sendLine({ message: 'x', options: { event: 'chat' } }, 'websocket') as { line: string })
        .line,
    ),
    { action: 'send', message: 'x' },
  );
});

const mqttDraft = () => ({
  url: 'mqtt://broker:1883',
  headers: [],
  auth: {
    type: 'Basic auth',
    username: 'ada',
    secret: '',
    apiKeyIn: 'header' as const,
    credentialId: '',
    options: {},
    secrets: {},
  },
  body: '',
  settings: {
    mqtt: {
      clientId: '',
      version: 4 as const,
      cleanStart: true,
      keepalive: 60,
      subscriptions: [{ topic: 'sensors/#', qos: 0 as 0 | 1 | 2, enabled: true }],
      topic: 'sensors/kitchen',
      qos: 0 as const,
      retain: false,
    },
  },
});

test('a live draft from a webview keeps only its own protocol’s settings, checked', () => {
  const draft = liveDraftFrom(
    { ...mqttDraft(), settings: { ...mqttDraft().settings, grpc: { proto: 'x', method: 'y' } } },
    'mqtt',
  );
  assert.ok(draft?.settings.mqtt);
  assert.equal(draft?.settings.grpc, undefined, 'another protocol’s settings are dropped');
  assert.equal(liveDraftFrom({ ...mqttDraft(), url: 'a\nb' }, 'mqtt'), undefined);
  const bad = mqttDraft();
  bad.settings.mqtt.keepalive = 70000;
  assert.equal(liveDraftFrom(bad, 'mqtt'), undefined);
  const grpc = liveDraftFrom(
    {
      ...mqttDraft(),
      settings: { grpc: { proto: 'syntax = "proto3";', method: '/a.B/C', tls: true } },
    },
    'grpc',
  );
  assert.deepEqual(grpc?.settings, {
    grpc: { proto: 'syntax = "proto3";', method: '/a.B/C', tls: true },
  });
});

test('saving a live draft changes only what changed, its secret kept off the arguments', () => {
  const saved = mqttDraft();
  assert.deepEqual(liveUpdatePlan(saved, mqttDraft()), { args: [] });
  const draft = mqttDraft();
  draft.url = 'mqtts://broker:8883';
  draft.auth.secret = 'pw';
  draft.settings.mqtt.subscriptions.push({ topic: 'alerts/+', qos: 1, enabled: true });
  const plan = liveUpdatePlan(saved, draft);
  assert.ok(plan.args.includes('--url=mqtts://broker:8883'));
  assert.ok(!plan.args.join(' ').includes('pw'));
  assert.equal(plan.env?.API_WORKBENCH_AUTH_SECRET, 'pw');
  assert.equal(plan.settings?.mqtt?.subscriptions.length, 2);
});
