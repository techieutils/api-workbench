import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createServer as createTCPServer } from 'node:net';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { Server as SocketIOServer } from 'socket.io';
import { Aedes } from 'aedes';
import { buildSchema, graphql } from 'graphql';
import { EchoService, grpc } from './grpc.mjs';

const schema = buildSchema('type Query { hello(name: String): String! protocol: String! }');
const graphRoot = {
  hello: ({ name }) => `Hello, ${name || 'Workbench'}!`,
  protocol: () => 'GraphQL',
};
const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Sample bodies are limited to 1 MiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function bounded(value, fallback, maximum) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= maximum ? number : null;
}
function stream(response, count, interval, format) {
  let sequence = 0;
  const timer = setInterval(() => {
    sequence++;
    const event = { sequence, message: `Sample event ${sequence}` };
    response.write(format(event));
    if (sequence === count) {
      clearInterval(timer);
      response.end();
    }
  }, interval);
  response.on('close', () => clearInterval(timer));
}

export async function startPlayground({ httpPort = 4780, grpcPort = 4781, mqttPort = 4782 } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/health')
        return json(response, 200, {
          ok: true,
          protocols: ['HTTP', 'GraphQL', 'SSE', 'WebSocket', 'gRPC', 'Socket.IO', 'MQTT'],
        });
      if (url.pathname === '/echo') {
        const raw = await readBody(request);
        const contentType = request.headers['content-type'] || '';
        let body = raw;
        if (raw && contentType.includes('application/json')) body = JSON.parse(raw);
        else if (contentType.includes('application/x-www-form-urlencoded'))
          body = Object.fromEntries(new URLSearchParams(raw));
        return json(response, 200, {
          method: request.method,
          query: Object.fromEntries(url.searchParams),
          headers: request.headers,
          body,
        });
      }
      if (url.pathname === '/graphql') {
        if (request.method !== 'POST')
          return json(
            response,
            405,
            { error: 'Use POST with a JSON query and optional variables.' },
            { allow: 'POST' },
          );
        const input = JSON.parse(await readBody(request));
        const result = await graphql({
          schema,
          source: input.query,
          variableValues: input.variables,
          rootValue: graphRoot,
        });
        return json(response, 200, result);
      }
      if (url.pathname === '/auth/bearer') {
        if (request.headers.authorization !== 'Bearer sample-token')
          return json(
            response,
            401,
            { error: 'Use Bearer sample-token' },
            { 'www-authenticate': 'Bearer' },
          );
        return json(response, 200, { authenticated: true });
      }
      if (url.pathname === '/redirect') {
        response.writeHead(302, { location: '/health' });
        return response.end();
      }
      if (url.pathname === '/gzip') {
        response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        return response.end(
          gzipSync(JSON.stringify({ compressed: true, message: 'Hello, Workbench!' })),
        );
      }
      if (url.pathname.startsWith('/status/')) {
        const status = Number(url.pathname.slice('/status/'.length));
        if (!Number.isInteger(status) || status < 200 || status > 599)
          return json(response, 400, { error: 'Use a status between 200 and 599.' });
        return json(response, status, { status });
      }
      if (url.pathname === '/delay') {
        const milliseconds = bounded(url.searchParams.get('ms'), 500, 5000);
        if (milliseconds === null) return json(response, 400, { error: 'ms must be 1–5000.' });
        const timer = setTimeout(
          () => json(response, 200, { delayedMs: milliseconds }),
          milliseconds,
        );
        response.on('close', () => clearTimeout(timer));
        return;
      }
      if (url.pathname === '/events' || url.pathname === '/ndjson') {
        const count = bounded(url.searchParams.get('count'), 3, 20);
        const interval = bounded(url.searchParams.get('interval'), 100, 1000);
        if (count === null || interval === null)
          return json(response, 400, { error: 'count must be 1–20; interval must be 1–1000 ms.' });
        const sse = url.pathname === '/events';
        response.writeHead(200, {
          'content-type': sse ? 'text/event-stream' : 'application/x-ndjson',
          'cache-control': 'no-cache',
        });
        response.flushHeaders();
        stream(response, count, interval, (event) =>
          sse
            ? `id: ${event.sequence}\nevent: sample\ndata: ${JSON.stringify(event)}\n\n`
            : `${JSON.stringify(event)}\n`,
        );
        return;
      }
      json(response, 404, { error: 'Unknown sample endpoint.' });
    } catch (error) {
      if (!response.headersSent && !response.destroyed)
        json(response, 400, { error: error.message });
      else response.destroy();
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // MQTT, over TCP and over WebSocket at /mqtt: anonymous, with every topic open.
  const broker = await Aedes.createBroker();
  const mqttSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const mqttServer = createTCPServer((stream) => broker.handle(stream));
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    // Socket.IO answers upgrades on its own path.
    if (path.startsWith('/socket.io/')) return;
    if (path === '/mqtt') {
      mqttSockets.handleUpgrade(request, socket, head, (client) =>
        broker.handle(createWebSocketStream(client)),
      );
      return;
    }
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client));
  });
  // Socket.IO at /socket.io: a greeting, then `echo` events echoed back and acknowledged.
  const io = new SocketIOServer(server, { maxHttpBufferSize: 1024 * 1024 });
  io.on('connection', (client) => {
    client.emit('welcome', { protocol: 'Socket.IO', id: client.id });
    client.on('echo', (value, ack) => {
      client.emit('echo', value);
      if (typeof ack === 'function') ack({ received: value, protocol: 'Socket.IO' });
    });
  });
  sockets.on('connection', (client) => {
    client.on('error', () => {});
    client.send(JSON.stringify({ type: 'connected', protocol: 'WebSocket' }));
    client.on('message', (data, binary) => client.send(data, { binary }));
  });
  const rpc = new grpc.Server();
  const rpcTimers = new Set();
  rpc.addService(EchoService.service, {
    echo: (call, callback) => callback(null, { message: call.request.message, protocol: 'gRPC' }),
    collect: (call, callback) => {
      const messages = [];
      call.on('data', (value) => messages.push(value.message));
      call.on('end', () => callback(null, { message: messages.join(', '), protocol: 'gRPC' }));
      call.on('error', () => {});
    },
    chat: (call) => {
      call.on('data', (value) => call.write({ message: value.message, protocol: 'gRPC' }));
      call.on('end', () => call.end());
      call.on('error', () => {});
    },
    count: (call) => {
      const count = bounded(call.request.count, 3, 20);
      if (count === null) {
        call.destroy({ code: grpc.status.INVALID_ARGUMENT, details: 'count must be 1–20.' });
        return;
      }
      let value = 0;
      const clear = () => {
        clearInterval(timer);
        rpcTimers.delete(timer);
      };
      const timer = setInterval(() => {
        call.write({ value: ++value });
        if (value === count) {
          clear();
          call.end();
        }
      }, 50);
      rpcTimers.add(timer);
      call.on('cancelled', clear);
      call.on('error', clear);
    },
  });
  let rpcAddress;
  try {
    rpcAddress = await new Promise((resolve, reject) =>
      rpc.bindAsync(
        `127.0.0.1:${grpcPort}`,
        grpc.ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolve(port)),
      ),
    );
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(httpPort, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => {
      mqttServer.once('error', reject);
      mqttServer.listen(mqttPort, '127.0.0.1', resolve);
    });
  } catch (error) {
    rpc.forceShutdown();
    sockets.close();
    mqttSockets.close();
    io.close();
    broker.close();
    server.close();
    throw error;
  }
  return {
    httpURL: `http://127.0.0.1:${server.address().port}`,
    grpcAddress: `127.0.0.1:${rpcAddress}`,
    mqttURL: `mqtt://127.0.0.1:${mqttServer.address().port}`,
    close: async () => {
      await io.close();
      for (const client of mqttSockets.clients) client.terminate();
      mqttSockets.close();
      await new Promise((resolve) => broker.close(resolve));
      await new Promise((resolve) => mqttServer.close(resolve));
      for (const timer of rpcTimers) clearInterval(timer);
      rpcTimers.clear();
      for (const client of sockets.clients) client.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rpc.forceShutdown();
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const playground = await startPlayground();
  console.log(
    `HTTP / GraphQL / SSE: ${playground.httpURL}\nWebSocket: ${playground.httpURL.replace('http:', 'ws:')}/ws\ngRPC: ${playground.grpcAddress}\nSocket.IO: ${playground.httpURL}\nMQTT: ${playground.mqttURL} (WebSocket: ${playground.httpURL.replace('http:', 'ws:')}/mqtt)`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => void playground.close().then(() => process.exit(0)));
}
