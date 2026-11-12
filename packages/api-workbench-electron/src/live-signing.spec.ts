import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { parse } from 'protobufjs';
import { startProtocol } from './protocols';
import { digestAuthorization } from '@techieutils/api-workbench-common/auth-signing';
import type { ProtocolEvent, ProtocolPayload } from '@techieutils/api-workbench-common/types';

const digestUser = { type: 'digest' as const, username: 'ada', password: 'secret' };
const challenge = { realm: 'live', nonce: 'n-1', qop: 'auth', algorithm: 'MD5' };
const challengeHeader = 'Digest realm="live", qop="auth", nonce="n-1", algorithm=MD5';
/** Recomputes the expected Digest response with the client's cnonce. */
function validDigest(header: string | undefined, method: string, uri: string): boolean {
  const cnonce = /cnonce="([^"]+)"/.exec(header || '')?.[1];
  return (
    Boolean(cnonce) && header === digestAuthorization(digestUser, challenge, method, uri, cnonce)
  );
}
function run(input: Partial<ProtocolPayload>) {
  const events: ProtocolEvent[] = [];
  const session = startProtocol(
    {
      sessionId: crypto.randomUUID(),
      protocol: 'sse',
      url: '',
      headers: {},
      body: '{}',
      timeoutMs: 4000,
      ...input,
    } as ProtocolPayload,
    (event) => events.push(event),
  );
  const until = async (predicate: (event: ProtocolEvent) => boolean) => {
    const deadline = Date.now() + 5000;
    while (!events.some(predicate)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return events.find(predicate)!;
  };
  return { events, session, until };
}

test('WebSocket and SSE connections sign handshakes and answer Digest challenges', async () => {
  let wsAttempts = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/digest') && !validDigest(req.headers.authorization, 'GET', req.url)) {
      res.writeHead(401, { 'WWW-Authenticate': challengeHeader });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${req.headers.authorization || 'none'}\n\n`);
  });
  const sockets = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      wsAttempts++;
      if (
        info.req.url?.startsWith('/digest') &&
        !validDigest(info.req.headers.authorization, 'GET', info.req.url)
      )
        done(false, 401, 'Unauthorized', { 'WWW-Authenticate': challengeHeader });
      else done(true);
    },
  });
  sockets.on('connection', (socket, req) =>
    socket.send(
      JSON.stringify({ authorization: req.headers.authorization, date: req.headers['x-amz-date'] }),
    ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    const digestWS = run({
      protocol: 'websocket',
      url: `ws://127.0.0.1:${port}/digest?room=1`,
      signing: digestUser,
    });
    const digestMessage = JSON.parse(
      (await digestWS.until((event) => event.type === 'message')).data,
    );
    assert.match(digestMessage.authorization, /^Digest username="ada"/);
    assert.equal(wsAttempts, 2, 'the handshake is retried once with the Digest answer');
    assert.ok(
      digestWS.events.some(
        (event) => event.type === 'status' && event.data.includes('Digest challenge'),
      ),
    );
    digestWS.session.stop();
    const wrong = run({
      protocol: 'websocket',
      url: `ws://127.0.0.1:${port}/digest`,
      signing: { ...digestUser, password: 'nope' },
    });
    assert.match(
      (await wrong.until((event) => event.type === 'error')).data,
      /HTTP 401/,
      'wrong Digest credentials fail instead of looping',
    );
    const awsWS = run({
      protocol: 'websocket',
      url: `ws://127.0.0.1:${port}/aws?stage=prod`,
      signing: {
        type: 'aws',
        accessKeyId: 'AKID',
        secretAccessKey: 's',
        region: 'us-east-1',
        service: 'execute-api',
      },
    });
    const awsMessage = JSON.parse((await awsWS.until((event) => event.type === 'message')).data);
    assert.match(
      awsMessage.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-1\/execute-api\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    assert.match(awsMessage.date, /^\d{8}T\d{6}Z$/);
    assert.ok(
      awsWS.events.some(
        (event) =>
          event.type === 'status' &&
          event.data === 'Authentication: AWS Signature (signed when connecting)',
      ),
    );
    awsWS.session.stop();
    const oauth = run({
      protocol: 'sse',
      url: `http://127.0.0.1:${port}/events`,
      signing: {
        type: 'oauth1',
        consumerKey: 'ck',
        consumerSecret: 'cs',
        signatureMethod: 'HMAC-SHA1',
      },
    });
    assert.match(
      (await oauth.until((event) => event.type === 'message')).data,
      /^OAuth oauth_consumer_key="ck", .*oauth_signature="[^"]+"$/,
    );
    const jwt = run({
      protocol: 'sse',
      url: `http://127.0.0.1:${port}/events`,
      signing: {
        type: 'jwt',
        algorithm: 'HS256',
        secret: 's',
        payload: { sub: 'live' },
        prefix: 'Bearer',
      },
    });
    const token = (await jwt.until((event) => event.type === 'message')).data;
    assert.match(token, /^Bearer eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/);
    assert.equal(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub, 'live');
    const digestSSE = run({
      protocol: 'sse',
      url: `http://127.0.0.1:${port}/digest/events`,
      signing: digestUser,
    });
    assert.match(
      (await digestSSE.until((event) => event.type === 'message')).data,
      /^Digest username="ada"/,
      'SSE answers the Digest challenge',
    );
  } finally {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('gRPC calls carry signed metadata and reject Digest', async () => {
  const proto =
    'syntax = "proto3"; package live; service Who { rpc Ask (Empty) returns (Reply); } message Empty {} message Reply { string authorization = 1; string payload = 2; }';
  const rpc = new grpc.Server();
  rpc.addService(
    loader.fromJSON(parse(proto).root.toJSON())['live.Who'] as grpc.ServiceDefinition,
    {
      ask: (call: grpc.ServerUnaryCall<object, object>, callback: grpc.sendUnaryData<object>) =>
        callback(null, {
          authorization: String(call.metadata.get('authorization')[0] || ''),
          payload: String(call.metadata.get('x-amz-content-sha256')[0] || ''),
        }),
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    rpc.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const grpcInput = {
    protocol: 'grpc' as const,
    url: `127.0.0.1:${port}`,
    grpc: { proto, method: '/live.Who/Ask', tls: false },
  };
  try {
    const aws = run({
      ...grpcInput,
      signing: {
        type: 'aws',
        accessKeyId: 'AKID',
        secretAccessKey: 's',
        region: 'eu-west-1',
        service: 'appmesh',
      },
    });
    const reply = JSON.parse((await aws.until((event) => event.type === 'message')).data);
    assert.match(
      reply.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/appmesh\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=/,
    );
    assert.equal(reply.payload, 'UNSIGNED-PAYLOAD', 'the protobuf body is not signed');
    const jwt = run({
      ...grpcInput,
      signing: { type: 'jwt', algorithm: 'HS256', secret: 's', payload: {}, prefix: 'Bearer' },
    });
    assert.match(
      JSON.parse((await jwt.until((event) => event.type === 'message')).data).authorization,
      /^Bearer eyJ/,
    );
    const digest = run({ ...grpcInput, signing: digestUser });
    assert.match(
      (await digest.until((event) => event.type === 'error')).data,
      /gRPC does not send/,
    );
  } finally {
    rpc.forceShutdown();
  }
});
