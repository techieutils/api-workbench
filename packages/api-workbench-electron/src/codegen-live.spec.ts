import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { generateLiveCode, liveTargets } from './codegen-live';
import type { CodegenInput } from '@techieutils/api-workbench-common/types';

const proto = `syntax = "proto3";
package demo;
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc Watch (HelloRequest) returns (stream HelloReply);
  rpc Chat (stream HelloRequest) returns (stream HelloReply);
}
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }`;
const base = (
  protocol: CodegenInput['protocol'],
  extra: Partial<CodegenInput> = {},
): CodegenInput => ({
  protocol,
  url: 'https://api.example.com/stream',
  method: 'GET',
  headers: { Authorization: 'Bearer <REDACTED>', 'X-Team': "o'brien" },
  body: '{"subscribe":"orders","active":true,"limit":null}',
  bodyType: 'raw',
  fields: [],
  ...extra,
});
const inputs: Record<string, CodegenInput> = {
  websocket: base('websocket', { url: 'wss://api.example.com/ws' }),
  sse: base('sse'),
  ndjson: base('ndjson'),
  grpc: base('grpc', {
    url: 'localhost:50051',
    body: '{"name":"Ada"}',
    grpc: { proto, method: '/demo.Greeter/Watch', tls: false },
  }),
  socketio: base('socketio', {
    url: 'https://api.example.com/chat',
    socketio: { path: '/socket.io', event: 'subscribe', ack: true },
  }),
  mqtt: base('mqtt', {
    url: 'mqtts://broker.example.com:8883',
    headers: { Authorization: 'Basic YWRhOnMzY3JldA==' }, // gitleaks:allow
    mqtt: {
      clientId: "o'brien",
      version: 5,
      cleanStart: true,
      keepalive: 30,
      subscriptions: [
        { topic: 'orders/+', qos: 1, enabled: true },
        { topic: 'alerts/#', qos: 0, enabled: true },
      ],
      topic: 'orders/new',
      qos: 1,
      retain: false,
    },
  }),
};
/** Whether a command is installed; optional checkers are skipped when they are not. */
const has = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;

/** Syntax-checks a snippet with the language's own tools, when they are installed. */
function syntaxCheck(code: string, extension: string, directory: string): void {
  const file = path.join(directory, `snippet${extension}`);
  writeFileSync(file, code);
  if (extension === '.mjs' || extension === '.js')
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  else if (extension === '.py' && has('python3'))
    execFileSync('python3', ['-m', 'py_compile', file], { stdio: 'pipe' });
  else if (extension === '.sh') execFileSync('bash', ['-n', file], { stdio: 'pipe' });
  else if (extension === '.go' && has('gofmt')) {
    const result = spawnSync('gofmt', ['-e', file]);
    assert.equal(result.status, 0, result.stderr.toString());
  }
}

test('every live protocol, language, and library generates valid code', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'codegen-live-'));
  try {
    for (const [protocol, input] of Object.entries(inputs)) {
      for (const target of liveTargets(input.protocol!)) {
        for (const client of target.clients) {
          const label = `${protocol} ${target.id}/${client.id}`;
          const result = generateLiveCode(input, target.id, client.id);
          assert.ok(result.code.trim(), `${label} produces code`);
          assert.equal(result.filename, `${protocol}${target.extension}`);
          const extension = target.extension === '.js' ? '.mjs' : target.extension;
          assert.doesNotThrow(
            () => syntaxCheck(result.code, extension, directory),
            `${label} is valid ${extension}`,
          );
          if (protocol !== 'grpc' || target.id !== 'python')
            assert.ok(
              result.code.includes('example.com') || result.code.includes('localhost:50051'),
              `${label} uses the URL`,
            );
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gRPC snippets follow the method and schema', () => {
  const unary = { ...inputs.grpc, grpc: { proto, method: '/demo.Greeter/SayHello', tls: true } };
  const shell = generateLiveCode(unary, 'shell', 'grpcurl').code;
  assert.match(shell, /-proto service\.proto/);
  assert.doesNotMatch(shell, /-plaintext/, 'TLS calls do not use -plaintext');
  assert.match(shell, /'demo\.Greeter\/SayHello'/);
  assert.match(
    generateLiveCode(unary, 'node', 'grpc-js').code,
    /client\.sayHello\(\{"name":"Ada"\}, metadata, \(error, reply\)/,
  );
  assert.match(
    generateLiveCode(inputs.grpc, 'node', 'grpc-js').code,
    /call\.on\('data'/,
    'server streams listen for data',
  );
  const chat = { ...inputs.grpc, grpc: { proto, method: '/demo.Greeter/Chat', tls: false } };
  assert.match(
    generateLiveCode(chat, 'node', 'grpc-js').code,
    /client\.chat\(metadata\);[\s\S]*call\.write/,
    'bidirectional streams write',
  );
  const python = generateLiveCode(unary, 'python', 'grpcio');
  assert.match(
    python.code,
    /service_pb2\.HelloRequest\(\)/,
    'Python uses the request message type from the schema',
  );
  assert.match(python.code, /GreeterStub/);
  assert.match(python.notes.join(' '), /grpc_tools\.protoc/);
  assert.throws(
    () =>
      generateLiveCode(
        { ...inputs.grpc, grpc: { proto, method: '', tls: false } },
        'shell',
        'grpcurl',
      ),
    /Choose a gRPC method/,
  );
});

test('shell quoting survives quotes, and browsers are warned about headers', () => {
  const websocat = generateLiveCode(inputs.websocket, 'shell', 'websocat');
  assert.match(websocat.code, /-H 'X-Team: o'\\''brien'/);
  assert.match(
    generateLiveCode(inputs.websocket, 'javascript', 'websocket').notes.join(' '),
    /cannot set headers/,
  );
  assert.match(
    generateLiveCode(inputs.sse, 'javascript', 'eventsource').notes.join(' '),
    /cannot send custom headers/,
  );
  const binary = generateLiveCode(
    { ...inputs.websocket, body: 'AAEC', binary: true },
    'node',
    'ws',
  ).code;
  assert.match(binary, /Buffer\.from\("AAEC", 'base64'\)/);
  assert.throws(
    () => generateLiveCode(inputs.sse, 'go', 'gorilla'),
    /Choose an available language/,
  );
});

test('the Node.js snippets work against real SSE, NDJSON, and WebSocket servers', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`event: greeting\ndata: hello ${request.headers['x-team']}\n\n`);
      response.end('data: line one\ndata: line two\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      response.write('{"n":1}\n{"n"');
      response.end(':2}\n');
    }
  });
  const sockets = new WebSocketServer({ server, path: '/ws' });
  sockets.on('connection', (socket, request) => {
    socket.on('message', (data) => {
      socket.send(`echo ${data} from ${request.headers['x-team']}`);
      socket.close();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const directory = mkdtempSync(path.join(__dirname, 'codegen-run-'));
  const runNode = async (code: string) => {
    const file = path.join(directory, `run-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, code);
    const child = (await import('node:child_process')).spawn(process.execPath, [file], {
      cwd: process.cwd(),
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill(), 5000);
    await once(child, 'close');
    clearTimeout(timer);
    return output;
  };
  try {
    const headers = { 'X-Team': 'api' };
    const sse = await runNode(
      generateLiveCode(base('sse', { url: `http://${origin}/events`, headers }), 'node', 'fetch')
        .code,
    );
    assert.match(sse, /greeting hello api/);
    assert.match(sse, /message line one\nline two/);
    const ndjson = await runNode(
      generateLiveCode(base('ndjson', { url: `http://${origin}/lines`, headers }), 'node', 'fetch')
        .code,
    );
    assert.match(ndjson, /\{ n: 1 \}\n\{ n: 2 \}/, 'lines split across chunks are joined');
    const ws = await runNode(
      generateLiveCode(
        base('websocket', { url: `ws://${origin}/ws`, headers, body: 'ping' }),
        'node',
        'ws',
      ).code,
    );
    assert.match(ws, /Received: echo ping from api/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    sockets.close();
    server.close();
  }
});
