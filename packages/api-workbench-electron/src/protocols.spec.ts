import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { parse } from 'protobufjs';
import { startProtocol, inspectProto } from './protocols';
import type { ProtocolEvent, ProtocolPayload } from '@techieutils/api-workbench-common/types';
import { SSEParser, NDJSONParser } from '@techieutils/api-workbench-common/stream-parser';

const proto = `syntax = "proto3"; package test;
service Echo {
 rpc Unary (Message) returns (Message);
 rpc Watch (Message) returns (stream Message);
 rpc Collect (stream Message) returns (Message);
 rpc Chat (stream Message) returns (stream Message);
}
message Message { string text = 1; }`;
let http: Server;
let ws: WebSocketServer;
let rpc: grpc.Server;
let httpURL: string;
let grpcAddress: string;
const timers = new Set<ReturnType<typeof setInterval>>();
before(async () => {
  http = createServer((request, response) => {
    if (request.url === '/bad') {
      response.writeHead(401);
      response.end('Unauthorized');
      return;
    }
    if (request.url === '/wrong') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (request.url === '/ndjson') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write('{"sequence":1}\n{"se');
      response.end('quence":2}');
      return;
    }
    if (request.url === '/invalid-json') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end('not json\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    let index = 0;
    const timer = setInterval(() => {
      response.write(`id: ${++index}\nevent: sample\ndata: ${index}\n\n`);
      if (index === 3 && request.url !== '/forever') {
        clearInterval(timer);
        timers.delete(timer);
        response.end();
      }
    }, 20);
    timers.add(timer);
    response.on('close', () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  httpURL = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  ws = new WebSocketServer({ server: http });
  ws.on('connection', (socket) =>
    socket.on('message', (message, binary) => socket.send(message, { binary })),
  );
  rpc = new grpc.Server();
  const definition = loader.fromJSON(parse(proto).root.toJSON(), { defaults: true });
  const service = definition['test.Echo'] as grpc.ServiceDefinition;
  rpc.addService(service, {
    unary: (
      call: grpc.ServerUnaryCall<{ text: string }, object>,
      callback: grpc.sendUnaryData<object>,
    ) => callback(null, call.request),
    watch: (call: grpc.ServerWritableStream<{ text: string }, object>) => {
      call.write({ text: 'first' });
      call.write({ text: 'second' });
      call.end();
    },
    collect: (
      call: grpc.ServerReadableStream<{ text: string }, object>,
      callback: grpc.sendUnaryData<object>,
    ) => {
      const values: string[] = [];
      call.on('data', (value) => values.push(value.text));
      call.on('end', () => callback(null, { text: values.join(',') }));
    },
    chat: (call: grpc.ServerDuplexStream<{ text: string }, object>) => {
      call.on('data', (value) => call.write(value));
      call.on('end', () => call.end());
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    rpc.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
  grpcAddress = `127.0.0.1:${port}`;
});
after(async () => {
  for (const timer of timers) clearInterval(timer);
  for (const client of ws.clients) client.terminate();
  await new Promise<void>((resolve) => ws.close(() => resolve()));
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  rpc.forceShutdown();
});
function run(input: Partial<ProtocolPayload> = {}) {
  const events: ProtocolEvent[] = [];
  const payload: ProtocolPayload = {
    sessionId: crypto.randomUUID(),
    protocol: 'sse',
    url: httpURL,
    headers: {},
    body: '{}',
    timeoutMs: 2000,
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
function messages(events: ProtocolEvent[]) {
  return events.filter((event) => event.type === 'message');
}

test('SSE parser handles split CRLF, comments, multiline data and persistent event IDs', () => {
  const events: object[] = [];
  const parser = new SSEParser((event) => events.push(event));
  for (const chunk of [
    ': ping\rid: 7\r',
    '\nevent: update\r\ndata: hello\r',
    '\ndata: world\r\n\r',
    '\ndata: next\n\n',
  ])
    parser.feed(chunk);
  assert.deepEqual(events, [
    { data: 'hello\nworld', event: 'update', eventId: '7' },
    { data: 'next', event: 'message', eventId: '7' },
  ]);
});
test('parsers cap partial messages and reject malformed NDJSON', () => {
  assert.throws(() => new SSEParser(() => {}).feed('x'.repeat(1024 * 1024 + 1)), /exceeds/);
  assert.throws(() => new NDJSONParser(() => {}).feed('oops\n'), /JSON/);
  assert.throws(() => new NDJSONParser(() => {}).feed('x'.repeat(1024 * 1024 + 1)), /exceeds/);
});
test('live SSE emits messages before closure and exposes IDs', async () => {
  const { events, wait, closed } = run();
  await wait((event) => event.type === 'message');
  assert.equal(
    events.some((event) => event.type === 'closed'),
    false,
  );
  await closed();
  assert.deepEqual(
    messages(events).map((event) => [event.data, event.eventId]),
    [
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
    ],
  );
});
test('NDJSON handles chunk boundaries and a final line without newline', async () => {
  const { events, closed } = run({ protocol: 'ndjson', url: `${httpURL}/ndjson` });
  await closed();
  assert.deepEqual(
    messages(events).map((event) => JSON.parse(event.data).sequence),
    [1, 2],
  );
});
test('streams surface HTTP, media type and malformed JSON errors', async () => {
  for (const [protocol, path] of [
    ['sse', '/bad'],
    ['sse', '/wrong'],
    ['ndjson', '/invalid-json'],
  ] as const) {
    const { events, closed } = run({ protocol, url: `${httpURL}${path}` });
    await closed();
    assert.ok(
      events.some((event) => event.type === 'error'),
      path,
    );
  }
});
test('disconnect and timeout terminate streaming sessions', async () => {
  const first = run({ url: `${httpURL}/forever` });
  await first.wait((event) => event.type === 'message');
  first.session.stop();
  await first.closed();
  const count = first.events.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(first.events.length, count);
  const second = run({ url: `${httpURL}/forever`, timeoutMs: 100 });
  assert.match((await second.closed()).data, /timeout/);
});
test('WebSocket text and binary round trips, explicit close and send validation', async () => {
  const { events, session, wait, closed } = run({
    protocol: 'websocket',
    url: httpURL.replace('http:', 'ws:'),
  });
  await wait((event) => event.type === 'open');
  session.send('hello', false);
  await wait((event) => event.type === 'message' && event.data === 'hello');
  session.send('AAH/', true);
  const binary = await wait((event) => event.type === 'message' && event.binary === true);
  assert.equal(binary.data, 'AAH/');
  assert.throws(() => session.send('invalid?', true), /base64/);
  assert.throws(() => session.send('x'.repeat(1024 * 1024 + 1), false), /1 MiB/);
  session.stop();
  await closed();
  assert.equal(events.at(-1)?.type, 'closed');
});
test('proto discovery lists all streaming call types and prevents filesystem imports', () => {
  assert.deepEqual(
    inspectProto(proto).map((method) => [method.requestStream, method.responseStream]),
    [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ],
  );
  assert.throws(() => inspectProto('syntax="proto3"; import "/etc/passwd";'), /imports/);
});
test('gRPC unary and server-streaming decode protobuf responses', async () => {
  for (const name of ['Unary', 'Watch']) {
    const { events, closed } = run({
      protocol: 'grpc',
      url: grpcAddress,
      body: '{"text":"hello"}',
      grpc: { proto, method: `/test.Echo/${name}`, tls: false },
    });
    await closed();
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
      JSON.stringify(events),
    );
    assert.deepEqual(
      messages(events).map((event) => JSON.parse(event.data).text),
      name === 'Unary' ? ['hello'] : ['first', 'second'],
    );
    assert.ok(events.some((event) => event.type === 'status' && event.data.startsWith('OK')));
    assert.equal(
      events.filter((event) => event.type === 'sent').length,
      1,
      'initial gRPC request is recorded for timeline counts',
    );
  }
});
test('gRPC client-streaming and bidi support additional messages and half-close', async () => {
  for (const name of ['Collect', 'Chat']) {
    const { events, session, closed } = run({
      protocol: 'grpc',
      url: grpcAddress,
      body: '{"text":"one"}',
      grpc: { proto, method: `/test.Echo/${name}`, tls: false },
    });
    session.send('{"text":"two"}', false);
    session.finish();
    assert.throws(() => session.send('{}', false), /closed/);
    await closed();
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
      JSON.stringify(events),
    );
    assert.deepEqual(
      messages(events).map((event) => JSON.parse(event.data).text),
      name === 'Collect' ? ['one,two'] : ['one', 'two'],
    );
  }
});
test('invalid destinations, methods and JSON fail without hanging', async () => {
  for (const input of [
    { protocol: 'websocket', url: 'file:///etc/passwd' },
    { protocol: 'grpc', url: grpcAddress, grpc: { proto, method: '/missing/Method', tls: false } },
    {
      protocol: 'grpc',
      url: grpcAddress,
      body: 'oops',
      grpc: { proto, method: '/test.Echo/Unary', tls: false },
    },
  ] as Partial<ProtocolPayload>[]) {
    const { events, closed } = run(input);
    await closed();
    assert.ok(events.some((event) => event.type === 'error'));
  }
});
