import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import * as grpc from '@grpc/grpc-js';
import type * as loader from '@grpc/proto-loader';
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws';
import { Server as EngineServer } from 'engine.io';
import { Server as SocketIOServer, type Socket as SocketIOSocket } from 'socket.io';
import type { Aedes, Client as MqttClient } from 'aedes';
import type {
  KeyValue,
  MockLogEntry,
  MockLogMessage,
  MockRoute,
  MockServer,
  MockStatus,
} from '@techieutils/api-workbench-common/types';
import {
  DEFAULT_MOCK_MQTT_PORT,
  MOCK_MQTT_WEBSOCKET_PATH,
  MOCK_SOCKETIO_PATH,
  explainMockMatch,
  isFixedMqttTopic,
  isStreamRoute,
  matchMockPath,
  mqttFilterMatches,
  mergeMockHeaders,
  mockCorsHeaders,
  matchMockRoute,
  mockAnswer,
  mockHttpsProblem,
  mockPortProblem,
  mockRouteKind,
  mockStreamFrame,
  normalizeMock,
  renderMockBody,
  type MockRequestDetails,
} from '@techieutils/api-workbench-common/mocks';
import {
  validateMockRequest,
  validationFailureBody,
} from '@techieutils/api-workbench-common/mock-validation';
import { protoDefinition } from './protocols';

/** An HTTPS server, or an error saying the certificate or key is not usable. */
function secureServer(credentials: MockCertificate, handler: http.RequestListener): http.Server {
  try {
    return https.createServer({ cert: credentials.cert, key: credentials.key }, handler);
  } catch (error) {
    throw new Error(`The certificate or key cannot be used: ${(error as Error).message}`, {
      cause: error,
    });
  }
}
/** The most of a body each log entry keeps, for the request and for the response. */
const LOG_BODY_LIMIT = 64 * 1024;
function logMessage(headers: Record<string, string>, body: string): MockLogMessage {
  const size = Buffer.byteLength(body);
  return {
    headers,
    body: body.length > LOG_BODY_LIMIT ? body.slice(0, LOG_BODY_LIMIT) : body,
    ...(body.length > LOG_BODY_LIMIT ? { truncated: true } : {}),
    size,
  };
}
/** Request headers as single strings, repeated ones joined. */
const flatHeaders = (headers: http.IncomingHttpHeaders) =>
  Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]),
  );
/** The most of a request body rules can look at. */
const BODY_LIMIT = 1024 * 1024;
/** A request's body as text, up to the limit. */
function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      if (size >= BODY_LIMIT) return;
      chunks.push(chunk.subarray(0, BODY_LIMIT - size));
      size += chunk.length;
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
/** The longest a route may wait before answering, so a typo cannot hang a client for hours. */
const MAX_DELAY_MS = 60_000;
/** The shortest gap between repeated messages, so a stream set to 0 ms cannot spin. */
const MIN_REPEAT_INTERVAL_MS = 50;
type TemplateValues = Parameters<typeof renderMockBody>[1];

/**
 * Sends a streaming route's messages in order, `intervalMs` apart (after the route's delay), and
 * again from the first when it repeats. Returns a function that stops it; `done` runs once the
 * last message is sent, unless it repeats or was stopped.
 */
function playStream(
  route: MockRoute,
  values: TemplateValues,
  send: (data: string, index: number, event?: string) => void,
  done: () => void,
): () => void {
  const stream = route.stream ?? { messages: [], intervalMs: 1000 };
  const messages = stream.messages;
  const interval = stream.repeat
    ? Math.max(MIN_REPEAT_INTERVAL_MS, stream.intervalMs)
    : Math.max(0, stream.intervalMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let sent = 0;
  const next = () => {
    if (stopped) return;
    if (!messages.length || (!stream.repeat && sent >= messages.length)) return done();
    const message = messages[sent % messages.length];
    let data: string;
    try {
      data = renderMockBody(message.data, values);
    } catch (error) {
      data = `Mock template failed: ${(error as Error).message}`;
    }
    send(data, sent, message.event);
    sent++;
    timer = setTimeout(next, interval);
  };
  timer = setTimeout(next, Math.min(route.delayMs, MAX_DELAY_MS));
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
/** One pass of a stream's messages as the client receives them, for the log. */
function streamPreview(route: MockRoute, values: TemplateValues): string {
  const kind = mockRouteKind(route);
  return (route.stream?.messages ?? [])
    .map((message, index) => {
      let data: string;
      try {
        data = renderMockBody(message.data, values);
      } catch (error) {
        data = `Mock template failed: ${(error as Error).message}`;
      }
      return kind === 'sse' || kind === 'ndjson'
        ? mockStreamFrame(kind, data, { event: message.event, id: index + 1 })
        : `${data}\n`;
    })
    .join(kind === 'sse' || kind === 'ndjson' ? '' : '\n');
}
/** Plain words on how a stream is sent, for the log. */
function streamNote(route: MockRoute): string {
  const stream = route.stream;
  const count = stream?.messages.length ?? 0;
  const parts = [
    `Streams ${count} message${count === 1 ? '' : 's'}${count > 1 ? ` ${stream!.intervalMs} ms apart` : ''}${stream?.repeat ? ', repeating until the client disconnects' : ''}.`,
  ];
  if (stream?.reply?.trim()) parts.push('Replies to each message received.');
  return parts.join(' ');
}
const GRPC_KINDS = (method: loader.MethodDefinition<object, object>) =>
  method.requestStream
    ? method.responseStream
      ? 'bidirectional streaming'
      : 'client streaming'
    : method.responseStream
      ? 'server streaming'
      : 'unary';

interface RunningGrpc {
  server: grpc.Server;
  port: number;
  /** The schema it serves; a change restarts it. */
  proto: string;
  /** Calls in progress, ended when it stops. */
  calls: Set<() => void>;
}
interface RunningSocketIO {
  io: SocketIOServer;
  engine: EngineServer;
}
interface RunningMqtt {
  broker: Aedes;
  server: net.Server;
  port: number;
  /** MQTT over WebSocket, upgraded from the mock's HTTP port at /mqtt. */
  websockets: WebSocketServer;
  connections: Set<net.Socket>;
  /** Each client's subscriptions that a route is publishing to, by client and topic filter. */
  streams: Map<string, () => void>;
}
interface Running {
  server: http.Server;
  /** The mock as last started or updated; requests read it, so edits apply at once. */
  mock: MockServer;
  sockets: Set<import('node:net').Socket>;
  /** Its HTTPS settings when it started; a change restarts it. */
  https: string;
  /** WebSocket routes' connections, upgraded from the HTTP server. */
  websockets: WebSocketServer;
  /** Streams in progress (SSE, NDJSON, WebSocket), stopped when the mock stops. */
  streams: Set<() => void>;
  grpc?: RunningGrpc;
  socketio?: RunningSocketIO;
  mqtt?: RunningMqtt;
}
const hasRoutes = (mock: MockServer, kind: 'socketio' | 'mqtt') =>
  mock.routes.some((route) => route.enabled && mockRouteKind(route) === kind);
const mqttPort = (mock: MockServer) => mock.mqtt?.port ?? DEFAULT_MOCK_MQTT_PORT;
/** A message as a Socket.IO client receives it: JSON when it is JSON, otherwise text. */
function eventValue(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}
/** Whether a request is for the Socket.IO endpoint. */
const isSocketIOPath = (url = '/') => {
  const path = url.split('?')[0];
  return path === MOCK_SOCKETIO_PATH || path.startsWith(`${MOCK_SOCKETIO_PATH}/`);
};
/** Whether a mock has gRPC routes and a schema to serve them from. */
const servesGrpc = (mock: MockServer) =>
  Boolean(
    mock.grpc?.proto.trim() &&
    mock.routes.some((route) => route.enabled && mockRouteKind(route) === 'grpc'),
  );
/** A PEM certificate (with any chain) and its private key, for an HTTPS mock. */
export interface MockCertificate {
  cert: string;
  key: string;
}
/** A template filled in, or empty when it cannot be. */
function renderSafely(template: string, values: TemplateValues): string {
  try {
    return renderMockBody(template, values);
  } catch {
    return '';
  }
}
/** The HTTPS settings that need a restart when they change. */
const httpsKey = (mock: MockServer) =>
  mock.https?.enabled ? JSON.stringify([mock.https.certFile ?? '', mock.https.keyFile ?? '']) : '';

/**
 * Local mock servers: each listens on 127.0.0.1 at its port and answers with its routes, over
 * HTTP or HTTPS. Starting a running mock again applies its new routes and settings, restarting it
 * only for a new port or new HTTPS settings.
 */
export class MockServers {
  private running = new Map<string, Running>();
  constructor(
    private readonly publish: (entry: MockLogEntry) => void,
    /** The certificate an HTTPS mock serves with; without it, HTTPS is unavailable. */
    private readonly certificate?: (mock: MockServer) => Promise<MockCertificate>,
  ) {}

  status(): MockStatus {
    return {
      running: [...this.running].map(([id, item]) => ({
        id,
        port: item.mock.port,
        ...(item.grpc ? { grpcPort: item.grpc.port } : {}),
        ...(item.mqtt ? { mqttPort: item.mqtt.port } : {}),
      })),
    };
  }

  async start(input: unknown): Promise<MockStatus> {
    const mock = normalizeMock(input, 'Mock server');
    if (!mock || typeof (input as MockServer)?.id !== 'string')
      throw new Error('Invalid mock server.');
    const problem = mockPortProblem(mock.port) ?? mockHttpsProblem(mock.https);
    if (problem) throw new Error(problem);
    if (servesGrpc(mock)) {
      const grpcProblem = mockPortProblem(mock.grpc!.port);
      if (grpcProblem) throw new Error(`gRPC port: ${grpcProblem}`);
      if (mock.grpc!.port === mock.port)
        throw new Error('Choose a gRPC port other than the mock’s HTTP port.');
      // The schema is checked first, so a broken one leaves a running mock as it was.
      try {
        protoDefinition(mock.grpc!.proto);
      } catch (error) {
        throw new Error(`The gRPC schema cannot be used: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    if (hasRoutes(mock, 'mqtt')) {
      const mqttProblem = mockPortProblem(mqttPort(mock));
      if (mqttProblem) throw new Error(`MQTT port: ${mqttProblem}`);
      if (mqttPort(mock) === mock.port || (servesGrpc(mock) && mqttPort(mock) === mock.grpc!.port))
        throw new Error('Choose an MQTT port other than the mock’s HTTP and gRPC ports.');
    }
    const current = this.running.get(mock.id);
    if (current && current.mock.port === mock.port && current.https === httpsKey(mock)) {
      current.mock = mock;
      await this.syncGrpc(current);
      await this.syncPubSub(current);
      return this.status();
    }
    // The certificate first, so a mock that cannot switch to HTTPS keeps running as it was.
    let credentials: MockCertificate | undefined;
    if (mock.https?.enabled) {
      if (!this.certificate) throw new Error('HTTPS is not available for mock servers here.');
      credentials = await this.certificate(mock);
    }
    if (current) await this.stop(mock.id);
    const owner = [...this.running.values()].find((item) => item.mock.port === mock.port);
    if (owner) throw new Error(`Port ${mock.port} is used by ${owner.mock.name}.`);
    const sockets = new Set<import('node:net').Socket>();
    const handler: http.RequestListener = (request, response) => {
      // Socket.IO's long-polling requests go to its engine; everything else to the routes.
      if (entry.socketio && isSocketIOPath(request.url))
        return entry.socketio.engine.handleRequest(request, response);
      void this.answer(entry, request, response);
    };
    const entry: Running = {
      mock,
      sockets,
      https: httpsKey(mock),
      server: credentials ? secureServer(credentials, handler) : http.createServer(handler),
      websockets: new WebSocketServer({ noServer: true, maxPayload: BODY_LIMIT }),
      streams: new Set(),
    };
    entry.server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    entry.server.on('upgrade', (request, socket, head) =>
      this.upgrade(entry, request, socket, head),
    );
    // CONNECT asks for a tunnel; a route answers it as it would any request, and the tunnel is
    // never opened, so nothing passes through the mock.
    entry.server.on('connect', (request: http.IncomingMessage, socket: Duplex) => {
      const response = new http.ServerResponse(request);
      response.assignSocket(socket as net.Socket);
      response.shouldKeepAlive = false;
      // The connection closes after the answer, which ends its body; chunks would be read as data.
      response.useChunkedEncodingByDefault = false;
      response.on('finish', () => {
        response.detachSocket(socket as net.Socket);
        socket.end();
      });
      socket.on('error', () => socket.destroy());
      void this.answer(entry, request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            error.code === 'EADDRINUSE'
              ? `Port ${mock.port} is already in use. Choose another port.`
              : error.code === 'EACCES'
                ? `Port ${mock.port} is not available. Choose another port.`
                : error.message,
          ),
        );
      entry.server.once('error', failed);
      entry.server.listen(mock.port, '127.0.0.1', () => {
        entry.server.off('error', failed);
        resolve();
      });
    });
    this.running.set(mock.id, entry);
    try {
      await this.syncGrpc(entry);
      await this.syncPubSub(entry);
    } catch (error) {
      await this.stop(mock.id);
      throw error;
    }
    return this.status();
  }

  async stop(id: unknown): Promise<MockStatus> {
    const entry = typeof id === 'string' ? this.running.get(id) : undefined;
    if (entry) {
      this.running.delete(id as string);
      for (const stop of entry.streams) stop();
      for (const client of entry.websockets.clients) client.terminate();
      entry.websockets.close();
      await this.stopGrpc(entry);
      this.stopSocketIO(entry);
      await this.stopMqtt(entry);
      await new Promise<void>((resolve) => {
        entry.server.close(() => resolve());
        for (const socket of entry.sockets) socket.destroy();
      });
    }
    return this.status();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  /**
   * An SSE or NDJSON route: answers 200 with the stream's content type, then sends its messages
   * as events or lines until the last (or, when it repeats, until the client disconnects).
   */
  private streamHttp(
    entry: Running,
    route: MockRoute,
    params: Record<string, string>,
    details: MockRequestDetails,
    response: http.ServerResponse,
    log: (
      status: number,
      answered: { headers: Record<string, string>; body: string },
      extra?: Pick<MockLogEntry, 'routeId' | 'params' | 'delayMs' | 'protocol'>,
    ) => void,
    withHeaders: (
      values: TemplateValues,
      ...layers: (readonly KeyValue[] | undefined)[]
    ) => Record<string, string>,
  ): void {
    const kind = mockRouteKind(route) as 'sse' | 'ndjson';
    const values = { params, query: details.query, headers: details.headers, body: details.body };
    // The stream's Content-Type comes last: a client only reads the stream with it.
    const headers = withHeaders(
      values,
      entry.mock.defaultHeaders,
      [{ key: 'Cache-Control', value: 'no-cache', enabled: true }],
      route.headers,
      [
        {
          key: 'Content-Type',
          value: kind === 'sse' ? 'text/event-stream; charset=utf-8' : 'application/x-ndjson',
          enabled: true,
        },
      ],
    );
    response.writeHead(200, headers);
    response.flushHeaders();
    log(
      200,
      { headers, body: streamPreview(route, values) },
      {
        routeId: route.id,
        protocol: kind,
        ...(Object.keys(params).length ? { params } : {}),
        ...(route.delayMs > 0 ? { delayMs: Math.min(route.delayMs, MAX_DELAY_MS) } : {}),
      },
    );
    const stop = playStream(
      route,
      values,
      (data, index, event) => response.write(mockStreamFrame(kind, data, { event, id: index + 1 })),
      () => {
        entry.streams.delete(stop);
        response.end();
      },
    );
    entry.streams.add(stop);
    response.on('close', () => {
      stop();
      entry.streams.delete(stop);
    });
  }

  /** A WebSocket handshake: the matching WebSocket route takes the connection, or it is refused with 404. */
  private upgrade(
    entry: Running,
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const started = Date.now();
    const mock = entry.mock;
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (entry.socketio && isSocketIOPath(request.url))
      return entry.socketio.engine.handleUpgrade(request, socket, head);
    const mqtt = entry.mqtt;
    if (
      mqtt &&
      url.pathname === MOCK_MQTT_WEBSOCKET_PATH &&
      /(^|,)\s*mqtt\s*(,|$)/i.test(String(request.headers['sec-websocket-protocol'] ?? ''))
    )
      return mqtt.websockets.handleUpgrade(request, socket, head, (client: WebSocket) =>
        mqtt.broker.handle(createWebSocketStream(client) as unknown as net.Socket),
      );
    const details = { query: url.searchParams, headers: request.headers, body: '' };
    const match = matchMockRoute(mock.routes, 'GET', url.pathname, details, 'websocket');
    const notes = explainMockMatch(mock.routes, 'GET', url.pathname, details, 'websocket');
    const record = (status: number, body: string, extra: Partial<MockLogEntry> = {}) =>
      this.publish({
        id: randomUUID(),
        mockId: mock.id,
        time: new Date(started).toISOString(),
        method: 'GET',
        path: url.pathname + url.search,
        status,
        durationMs: Date.now() - started,
        request: logMessage(flatHeaders(request.headers), ''),
        response: logMessage({}, body),
        notes,
        protocol: 'websocket',
        ...extra,
      });
    if (!match) {
      const message = 'No mock WebSocket route matches this path.';
      socket.end(
        `HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
      );
      return record(404, message);
    }
    const { route, params } = match;
    const values = { params, query: url.searchParams, headers: request.headers, body: '' };
    const problems = validateMockRequest(
      route.validation,
      details,
      params,
      route.pathParams,
      route.rules,
    );
    if (problems.length) {
      const status =
        route.validation!.status >= 400 && route.validation!.status <= 599
          ? route.validation!.status
          : 422;
      const failure = validationFailureBody(route.validation!, problems);
      socket.end(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(failure)}\r\nConnection: close\r\n\r\n${failure}`,
      );
      return record(status, failure, {
        routeId: route.id,
        notes: [
          ...notes,
          `Validation failed, so the handshake got ${status}: ${problems.map((problem) => problem.message).join('; ')}.`,
        ],
      });
    }
    entry.websockets.handleUpgrade(request, socket, head, (client: WebSocket) => {
      record(101, streamPreview(route, values), {
        routeId: route.id,
        notes: [...notes, streamNote(route)],
        ...(Object.keys(params).length ? { params } : {}),
      });
      const stop = playStream(
        route,
        values,
        (data) => client.readyState === client.OPEN && client.send(data),
        () => entry.streams.delete(stop),
      );
      entry.streams.add(stop);
      client.on('message', (data, binary) => {
        // The route as it is now, so edits to the reply apply to open connections.
        const reply = entry.mock.routes.find((item) => item.id === route.id)?.stream?.reply;
        if (!reply?.trim()) return;
        const body = binary ? Buffer.from(data as Buffer).toString('base64') : data.toString();
        try {
          client.send(renderMockBody(reply, { ...values, body }));
        } catch (error) {
          client.send(`Mock template failed: ${(error as Error).message}`);
        }
      });
      client.on('close', () => {
        stop();
        entry.streams.delete(stop);
      });
    });
  }

  /** Starts or stops a mock's Socket.IO endpoint and MQTT broker to match its routes. */
  private async syncPubSub(entry: Running): Promise<void> {
    this.syncSocketIO(entry);
    await this.syncMqtt(entry);
  }

  /**
   * Socket.IO on the mock's HTTP port, at /socket.io: a connection to a namespace is taken by the
   * Socket.IO route for it, whose rules and validation look at the handshake (headers, query, and
   * the `auth` payload as the body); with none, it is refused.
   */
  private syncSocketIO(entry: Running): void {
    if (!hasRoutes(entry.mock, 'socketio')) return this.stopSocketIO(entry);
    if (entry.socketio) return;
    // The engine is given requests for /socket.io only (see isSocketIOPath), so it needs no path.
    const engine = new EngineServer({
      maxHttpBufferSize: BODY_LIMIT,
      // Browsers poll cross-origin; the mock's CORS switch decides whether they may.
      ...(entry.mock.cors ? { cors: { origin: true, credentials: true } } : {}),
    });
    const io = new SocketIOServer({ path: MOCK_SOCKETIO_PATH, serveClient: false });
    io.bind(engine);
    const guard = (socket: SocketIOSocket, next: (error?: Error) => void) =>
      this.socketIOHandshake(entry, socket, next);
    const connection = (socket: SocketIOSocket) => this.socketIOConnection(entry, socket);
    io.of('/').use(guard).on('connection', connection);
    // Other namespaces exist while a route's path takes them; a refusal is logged like a 404.
    io.of((name, _auth, next) => {
      const taken = entry.mock.routes.some(
        (route) =>
          route.enabled &&
          mockRouteKind(route) === 'socketio' &&
          Boolean(matchMockPath(route.path, name)),
      );
      if (!taken)
        this.publish({
          id: randomUUID(),
          mockId: entry.mock.id,
          time: new Date().toISOString(),
          method: 'GET',
          path: name,
          status: 404,
          durationMs: 0,
          protocol: 'socketio',
          notes: explainMockMatch(
            entry.mock.routes,
            'GET',
            name,
            { query: new URLSearchParams(), headers: {}, body: '' },
            'socketio',
          ),
        });
      next(null, taken);
    })
      .use(guard)
      .on('connection', connection);
    entry.socketio = { io, engine };
  }
  private stopSocketIO(entry: Running): void {
    const running = entry.socketio;
    if (!running) return;
    entry.socketio = undefined;
    running.io.disconnectSockets(true);
    void running.io.close();
  }
  /** What rules see in a Socket.IO handshake: its headers and query, and its auth payload as the body. */
  private socketIODetails(socket: SocketIOSocket): MockRequestDetails {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(socket.handshake.query))
      for (const item of Array.isArray(value) ? value : [value])
        if (typeof item === 'string' && name !== 'EIO' && name !== 'transport' && name !== 't')
          query.append(name, item);
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    return {
      query,
      headers: socket.handshake.headers,
      body: auth && Object.keys(auth).length ? JSON.stringify(auth) : '',
    };
  }
  private socketIORecord(
    entry: Running,
    socket: SocketIOSocket,
    status: number,
    body: string,
    extra: Partial<MockLogEntry> = {},
  ): void {
    const details = this.socketIODetails(socket);
    const name = socket.nsp.name;
    this.publish({
      id: randomUUID(),
      mockId: entry.mock.id,
      time: new Date().toISOString(),
      method: 'GET',
      path: name + (details.query.size ? `?${details.query}` : ''),
      status,
      durationMs: 0,
      request: logMessage(flatHeaders(socket.handshake.headers), details.body),
      response: logMessage({}, body),
      protocol: 'socketio',
      ...extra,
      notes: [
        ...explainMockMatch(entry.mock.routes, 'GET', name, details, 'socketio'),
        ...(extra.notes ?? []),
      ],
    });
  }
  private socketIOHandshake(
    entry: Running,
    socket: SocketIOSocket,
    next: (error?: Error) => void,
  ): void {
    const details = this.socketIODetails(socket);
    const match = matchMockRoute(entry.mock.routes, 'GET', socket.nsp.name, details, 'socketio');
    if (!match) {
      const message = 'No mock Socket.IO route matches this namespace.';
      this.socketIORecord(entry, socket, 404, message);
      return next(new Error(message));
    }
    const { route, params } = match;
    const problems = validateMockRequest(
      route.validation,
      details,
      params,
      route.pathParams,
      route.rules,
    );
    if (problems.length) {
      const status =
        route.validation!.status >= 400 && route.validation!.status <= 599
          ? route.validation!.status
          : 422;
      const failure = validationFailureBody(route.validation!, problems);
      this.socketIORecord(entry, socket, status, failure, {
        routeId: route.id,
        notes: [
          `Validation failed, so the connection was refused: ${problems.map((problem) => problem.message).join('; ')}.`,
        ],
      });
      // The client's connect_error carries the problems, as an HTTP answer's body would.
      return next(
        Object.assign(new Error('Request validation failed'), { data: eventValue(failure) }),
      );
    }
    socket.data.match = match;
    next();
  }
  /** A connection a Socket.IO route took: its messages are emitted, and each event gets the reply. */
  private socketIOConnection(entry: Running, socket: SocketIOSocket): void {
    const { route, params } = socket.data.match as {
      route: MockRoute;
      params: Record<string, string>;
    };
    const details = this.socketIODetails(socket);
    const values = { params, query: details.query, headers: details.headers, body: details.body };
    this.socketIORecord(entry, socket, 101, streamPreview(route, values), {
      routeId: route.id,
      notes: [streamNote(route)],
      ...(Object.keys(params).length ? { params } : {}),
    });
    const stop = playStream(
      route,
      values,
      (data, _index, event) => socket.emit(event || 'message', eventValue(data)),
      () => entry.streams.delete(stop),
    );
    entry.streams.add(stop);
    socket.onAny((event: string, ...args: unknown[]) => {
      // The route as it is now, so edits to the reply apply to open connections.
      const reply = entry.mock.routes.find((item) => item.id === route.id)?.stream?.reply;
      const ack =
        typeof args.at(-1) === 'function' ? (args.pop() as (value: unknown) => void) : undefined;
      if (!reply?.trim()) return;
      // Event arguments are values, so the body is their JSON: `{{body}}` drops into a JSON reply.
      const body = JSON.stringify(args.length === 1 ? args[0] : args) ?? 'null';
      let text: string;
      try {
        text = renderMockBody(reply, { ...values, body });
      } catch (error) {
        text = `Mock template failed: ${(error as Error).message}`;
      }
      // A client waiting for an acknowledgement gets the reply as it; others get the same event.
      if (ack) ack(eventValue(text));
      else socket.emit(event, eventValue(text));
    });
    socket.on('disconnect', () => {
      stop();
      entry.streams.delete(stop);
    });
  }

  /**
   * An MQTT 3.1.1 broker for the mock's MQTT routes, on its own port (and over WebSocket at /mqtt
   * on the HTTP port). It is a real broker, so clients can also publish to each other; a route adds
   * messages for the topics it matches and replies to messages published to them.
   */
  private async syncMqtt(entry: Running): Promise<void> {
    const mock = entry.mock;
    if (!hasRoutes(mock, 'mqtt')) return this.stopMqtt(entry);
    const port = mqttPort(mock);
    if (entry.mqtt?.port === port) return;
    await this.stopMqtt(entry);
    const owner = [...this.running.values()].find(
      (item) =>
        item !== entry &&
        (item.mock.port === port || item.grpc?.port === port || item.mqtt?.port === port),
    );
    if (owner) throw new Error(`Port ${port} is used by ${owner.mock.name}.`);
    const { Aedes } = await import('aedes');
    const broker = await Aedes.createBroker();
    const connections = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      broker.handle(socket);
    });
    const running: RunningMqtt = {
      broker,
      server,
      port,
      websockets: new WebSocketServer({ noServer: true, maxPayload: BODY_LIMIT }),
      connections,
      streams: new Map(),
    };
    broker.on('subscribe', (subscriptions, client) => {
      if (client)
        for (const item of subscriptions) this.mqttSubscribed(entry, running, item.topic, client);
    });
    broker.on('unsubscribe', (topics, client) => {
      if (client) for (const topic of topics) this.mqttStop(running, `${client.id}\n${topic}`);
    });
    broker.on('clientDisconnect', (client) => {
      for (const key of [...running.streams.keys()])
        if (key.startsWith(`${client.id}\n`)) this.mqttStop(running, key);
    });
    // Only clients' messages: the broker's own (route messages and replies) have no client.
    broker.on('publish', (packet, client) => {
      if (client && !packet.topic.startsWith('$')) this.mqttPublished(entry, packet, client);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            error.code === 'EADDRINUSE'
              ? `MQTT port ${port} is already in use. Choose another port.`
              : error.message,
          ),
        ),
      );
      server.listen(port, '127.0.0.1', () => resolve());
    }).catch(async (error) => {
      await new Promise<void>((resolve) => broker.close(() => resolve()));
      throw error;
    });
    entry.mqtt = running;
  }
  private async stopMqtt(entry: Running): Promise<void> {
    const running = entry.mqtt;
    if (!running) return;
    entry.mqtt = undefined;
    for (const key of [...running.streams.keys()]) this.mqttStop(running, key);
    for (const client of running.websockets.clients) client.terminate();
    running.websockets.close();
    await new Promise<void>((resolve) => running.broker.close(() => resolve()));
    await new Promise<void>((resolve) => {
      running.server.close(() => resolve());
      for (const socket of running.connections) socket.destroy();
    });
  }
  private mqttStop(running: RunningMqtt, key: string): void {
    running.streams.get(key)?.();
    running.streams.delete(key);
  }
  /** What MQTT rules see: the client as headers (`client-id`, `username`), and the payload as the body. */
  private mqttDetails(client: MqttClient, body = ''): MockRequestDetails {
    const username = (client as MqttClient & { _parser?: unknown; username?: string }).username;
    return {
      query: new URLSearchParams(),
      headers: { 'client-id': client.id, ...(username ? { username } : {}) },
      body,
    };
  }
  /**
   * A client subscribed: the route for the topic publishes its messages to that client. A filter
   * with wildcards takes the routes whose fixed topics it covers; a concrete topic, the route that
   * matches it, with its `:name` levels as parameters.
   */
  private mqttSubscribed(
    entry: Running,
    running: RunningMqtt,
    filter: string,
    client: MqttClient,
  ): void {
    if (filter.startsWith('$')) return;
    const mock = entry.mock;
    const details = this.mqttDetails(client);
    const topics = /[+#]/.test(filter)
      ? mock.routes
          .filter(
            (route) =>
              route.enabled &&
              mockRouteKind(route) === 'mqtt' &&
              isFixedMqttTopic(route.path) &&
              mqttFilterMatches(filter, route.path.replace(/^\//, '')),
          )
          .map((route) => route.path.replace(/^\//, ''))
      : [filter];
    const key = `${client.id}\n${filter}`;
    this.mqttStop(running, key);
    const stops: (() => void)[] = [];
    for (const topic of new Set(topics)) {
      const match = matchMockRoute(mock.routes, 'GET', topic, details, 'mqtt');
      const record = (status: number, body: string, extra: Partial<MockLogEntry> = {}) =>
        this.publish({
          id: randomUUID(),
          mockId: mock.id,
          time: new Date().toISOString(),
          method: 'SUBSCRIBE',
          path: topic,
          status,
          durationMs: 0,
          request: logMessage(flatHeaders(details.headers as http.IncomingHttpHeaders), ''),
          response: logMessage({}, body),
          protocol: 'mqtt',
          ...extra,
          notes: [
            ...explainMockMatch(mock.routes, 'GET', topic, details, 'mqtt'),
            ...(extra.notes ?? []),
          ],
        });
      if (!match) {
        record(404, '', {
          notes: ['The broker still delivers what other clients publish to it.'],
        });
        continue;
      }
      const { route, params } = match;
      const values = { params, query: details.query, headers: details.headers, body: '' };
      record(200, streamPreview(route, values), {
        routeId: route.id,
        notes: [streamNote(route)],
        ...(Object.keys(params).length ? { params } : {}),
      });
      const stop = playStream(
        route,
        values,
        (data) =>
          client.publish(
            {
              cmd: 'publish',
              topic,
              payload: Buffer.from(data),
              qos: 0,
              retain: false,
              dup: false,
            },
            () => {},
          ),
        () => entry.streams.delete(stop),
      );
      entry.streams.add(stop);
      stops.push(() => {
        stop();
        entry.streams.delete(stop);
      });
    }
    if (stops.length) running.streams.set(key, () => stops.forEach((stop) => stop()));
  }
  /**
   * A client published to a topic: the route for it replies, when it has a reply, on the topic
   * with `/reply` added.
   */
  private mqttPublished(
    entry: Running,
    packet: {
      topic: string;
      payload: Buffer | string;
      properties?: { responseTopic?: string; correlationData?: Buffer };
    },
    client: MqttClient,
  ): void {
    const mock = entry.mock;
    const payload = Buffer.isBuffer(packet.payload)
      ? packet.payload.toString('utf8')
      : String(packet.payload);
    const details = this.mqttDetails(client, payload);
    const match = matchMockRoute(mock.routes, 'POST', packet.topic, details, 'mqtt');
    if (!match) return;
    const { route, params } = match;
    const reply = route.stream?.reply;
    const replyTopic = `${packet.topic}/reply`;
    let text = '';
    if (reply?.trim()) {
      try {
        text = renderMockBody(reply, {
          params,
          query: details.query,
          headers: details.headers,
          body: payload,
        });
      } catch (error) {
        text = `Mock template failed: ${(error as Error).message}`;
      }
      const send = () =>
        entry.mqtt?.broker.publish(
          {
            cmd: 'publish',
            topic: replyTopic,
            payload: Buffer.from(text),
            qos: 0,
            retain: false,
            dup: false,
          },
          () => {},
        );
      if (route.delayMs > 0) setTimeout(send, Math.min(route.delayMs, MAX_DELAY_MS));
      else send();
    }
    this.publish({
      id: randomUUID(),
      mockId: mock.id,
      time: new Date().toISOString(),
      method: 'PUBLISH',
      path: packet.topic,
      status: 200,
      durationMs: 0,
      routeId: route.id,
      ...(Object.keys(params).length ? { params } : {}),
      request: logMessage(flatHeaders(details.headers as http.IncomingHttpHeaders), payload),
      response: logMessage(reply?.trim() ? { topic: replyTopic } : {}, text),
      protocol: 'mqtt',
      notes: [
        ...explainMockMatch(mock.routes, 'POST', packet.topic, details, 'mqtt'),
        reply?.trim()
          ? `Replied on ${replyTopic}.`
          : 'The route has no reply, so nothing was sent back.',
      ],
    });
  }

  /** Starts, restarts, or stops a mock's gRPC server to match its schema, port, and routes. */
  private async syncGrpc(entry: Running): Promise<void> {
    const mock = entry.mock;
    if (!servesGrpc(mock)) return this.stopGrpc(entry);
    const { proto, port } = mock.grpc!;
    if (entry.grpc && entry.grpc.proto === proto && entry.grpc.port === port) return;
    await this.stopGrpc(entry);
    const owner = [...this.running.values()].find(
      (item) => item !== entry && (item.mock.port === port || item.grpc?.port === port),
    );
    if (owner) throw new Error(`Port ${port} is used by ${owner.mock.name}.`);
    const server = new grpc.Server();
    const running: RunningGrpc = { server, port, proto, calls: new Set() };
    for (const service of Object.values(protoDefinition(proto))) {
      if ('format' in service) continue;
      const implementation: grpc.UntypedServiceImplementation = {};
      for (const [name, method] of Object.entries(service))
        implementation[name] = this.grpcHandler(entry, running, method);
      server.addService(service as grpc.ServiceDefinition, implementation);
    }
    await new Promise<void>((resolve, reject) =>
      server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (error) =>
        error
          ? reject(
              new Error(
                /EADDRINUSE|address already in use/i.test(error.message)
                  ? `gRPC port ${port} is already in use. Choose another port.`
                  : error.message,
              ),
            )
          : resolve(),
      ),
    );
    entry.grpc = running;
  }
  private async stopGrpc(entry: Running): Promise<void> {
    const running = entry.grpc;
    if (!running) return;
    entry.grpc = undefined;
    for (const end of running.calls) end();
    running.server.forceShutdown();
  }
  /**
   * Serves one schema method: the mock's gRPC route for its path answers with its messages (the
   * first for a unary or client-streaming call, all of them for a server stream), ending with the
   * route's status as the gRPC status code; with no route, the call is UNIMPLEMENTED.
   */
  private grpcHandler(
    entry: Running,
    running: RunningGrpc,
    method: loader.MethodDefinition<object, object>,
  ): grpc.UntypedHandleCall {
    const path = method.path;
    type AnyCall = grpc.ServerUnaryCall<object, object> &
      grpc.ServerWritableStream<object, object> &
      grpc.ServerReadableStream<object, object> &
      grpc.ServerDuplexStream<object, object>;
    return ((call: AnyCall, callback?: grpc.sendUnaryData<object>) => {
      const started = Date.now();
      const mock = entry.mock;
      const metadata = Object.fromEntries(
        Object.entries(call.metadata.getMap()).map(([key, value]) => [key, String(value)]),
      );
      const request = method.requestStream ? '' : JSON.stringify(call.request ?? {});
      const details = { query: new URLSearchParams(), headers: metadata, body: request };
      const match = matchMockRoute(mock.routes, 'POST', path, details, 'grpc');
      const values = { params: {}, query: details.query, headers: metadata, body: request };
      const record = (status: number, body: string, extra: Partial<MockLogEntry> = {}) =>
        this.publish({
          id: randomUUID(),
          mockId: mock.id,
          time: new Date(started).toISOString(),
          method: 'gRPC',
          path,
          status,
          durationMs: Date.now() - started,
          request: logMessage(metadata, request),
          response: logMessage({}, body),
          notes: [
            ...explainMockMatch(mock.routes, 'POST', path, details, 'grpc'),
            `A ${GRPC_KINDS(method)} call.`,
          ],
          protocol: 'grpc',
          ...extra,
        });
      const fail = (code: grpc.status, message: string) => {
        const error = Object.assign(new Error(message), { code, details: message });
        if (callback) callback(error);
        else call.emit('error', error);
      };
      if (!match) {
        record(grpc.status.UNIMPLEMENTED, `No mock route for ${path}.`);
        return fail(grpc.status.UNIMPLEMENTED, `No mock route for ${path}.`);
      }
      const route = match.route;
      // gRPC calls are checked when they open: metadata, and the request message of a unary or
      // server-streaming call (a client stream's messages arrive later, so its schema is skipped).
      const problems = validateMockRequest(
        route.validation && method.requestStream
          ? { ...route.validation, schema: undefined }
          : route.validation,
        details,
      );
      if (problems.length) {
        const message = `Request validation failed: ${problems.map((problem) => problem.message).join('; ')}`;
        record(grpc.status.INVALID_ARGUMENT, message, {
          routeId: route.id,
          notes: [
            ...explainMockMatch(mock.routes, 'POST', path, details, 'grpc'),
            `Validation failed, so the call ended with INVALID_ARGUMENT: ${problems.map((problem) => problem.message).join('; ')}.`,
          ],
        });
        return fail(grpc.status.INVALID_ARGUMENT, message);
      }
      const code =
        Number.isInteger(route.status) && route.status >= 0 && route.status <= 16
          ? route.status
          : 0;
      record(code, streamPreview(route, values), {
        routeId: route.id,
        notes: [
          ...explainMockMatch(mock.routes, 'POST', path, details, 'grpc'),
          `A ${GRPC_KINDS(method)} call.`,
          streamNote(route),
        ],
      });
      /** A message from a template, as the object the schema serializes. */
      const message = (data: string) => JSON.parse(data) as object;
      const finish = () => {
        if (code === 0) {
          if (!callback) call.end();
        } else fail(code, renderSafely(route.body, values) || grpc.status[code]);
      };
      let stop: () => void = () => {};
      const ended = () => {
        stop();
        running.calls.delete(end);
      };
      const end = () => {
        ended();
        call.destroy?.();
      };
      running.calls.add(end);
      call.on('cancelled', ended);
      if (!method.responseStream) {
        // One answer: at once for a unary call, after the client finishes for a client stream.
        const respond = (body: string) => {
          const first = route.stream?.messages[0];
          setTimeout(
            () => {
              ended();
              if (code !== 0) return finish();
              try {
                callback!(null, message(renderMockBody(first?.data ?? '{}', { ...values, body })));
              } catch (error) {
                fail(
                  grpc.status.INTERNAL,
                  `Mock message is not valid JSON for this method: ${(error as Error).message}`,
                );
              }
            },
            Math.min(route.delayMs, MAX_DELAY_MS),
          );
        };
        if (!method.requestStream) return respond(request);
        let last = '';
        call.on('data', (data: object) => (last = JSON.stringify(data)));
        call.on('end', () => respond(last));
        return;
      }
      // Whether the client has finished sending, which may happen before the stream is done.
      let clientDone = false;
      if (method.requestStream) call.on('end', () => (clientDone = true));
      if (method.requestStream)
        call.on('data', (data: object) => {
          const reply = entry.mock.routes.find((item) => item.id === route.id)?.stream?.reply;
          if (!reply?.trim()) return;
          try {
            call.write(message(renderMockBody(reply, { ...values, body: JSON.stringify(data) })));
          } catch (error) {
            fail(grpc.status.INTERNAL, `Mock reply is not valid JSON: ${(error as Error).message}`);
          }
        });
      stop = playStream(
        route,
        values,
        (data) => {
          try {
            call.write(message(data));
          } catch (error) {
            stop();
            fail(
              grpc.status.INTERNAL,
              `Mock message is not valid JSON for this method: ${(error as Error).message}`,
            );
          }
        },
        () => {
          running.calls.delete(end);
          // A bidirectional stream stays open for replies until the client finishes.
          if (method.requestStream && code === 0) {
            if (clientDone) call.end();
            else call.on('end', () => call.end());
          } else finish();
        },
      );
    }) as grpc.UntypedHandleCall;
  }

  private async answer(
    entry: Running,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const started = Date.now();
    const mock = entry.mock;
    const method = (request.method || 'GET').toUpperCase();
    // A CONNECT's target is `host:port`, matched as the path `/host:port`.
    const url = new URL(method === 'CONNECT' ? '/' : request.url || '/', 'http://127.0.0.1');
    if (method === 'CONNECT') url.pathname = `/${request.url || ''}`;
    // The body, for rules that look at it; past the limit the rest is read and dropped, so
    // keep-alive connections stay usable. A CONNECT has none: what follows it is the tunnel's.
    const body = method === 'CONNECT' ? '' : await readBody(request);
    // CORS headers as the mock's settings allow, for this request's origin.
    const cors = mock.cors
      ? mockCorsHeaders(mock.corsOptions, {
          origin: request.headers.origin,
          requestHeaders: request.headers['access-control-request-headers'],
          preflight: method === 'OPTIONS' && 'access-control-request-method' in request.headers,
        })
      : {};
    const details = { query: url.searchParams, headers: request.headers, body };
    /** Records what came in, what went out, and why, for the mock's log. */
    const log = (
      status: number,
      answered: { headers: Record<string, string>; body: string },
      extra: Pick<MockLogEntry, 'routeId' | 'responseId' | 'params' | 'delayMs' | 'protocol'> = {},
    ) =>
      this.publish({
        id: randomUUID(),
        mockId: mock.id,
        time: new Date(started).toISOString(),
        method,
        path: url.pathname + url.search,
        status,
        ...extra,
        durationMs: Date.now() - started,
        request: logMessage(flatHeaders(request.headers), body),
        response: logMessage(answered.headers, answered.body),
        notes: explainMockMatch(mock.routes, method, url.pathname, details),
      });
    /**
     * Headers from layers, later ones replacing earlier ones by name (ignoring case): the CORS
     * headers, then the mock's defaults, then a route's own. Values are templates; one that
     * cannot be filled in, or that a client could not receive, is left out.
     */
    const withHeaders = (
      values: Parameters<typeof renderMockBody>[1],
      ...layers: (readonly KeyValue[] | undefined)[]
    ): Record<string, string> => {
      const headers: Record<string, string> = {};
      const put = (name: string, value: string) => {
        for (const existing of Object.keys(headers))
          if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
        headers[name] = value;
      };
      for (const [name, value] of Object.entries(cors)) put(name, value);
      for (const row of mergeMockHeaders(...layers)) {
        let value: string;
        try {
          value = renderMockBody(row.value, values).replace(/[\r\n]+/g, ' ');
        } catch {
          continue;
        }
        if (!/[^\t\x20-\x7e\x80-\xff]/.test(value)) put(row.key.trim(), value);
      }
      return headers;
    };
    const plainValues = { params: {}, query: url.searchParams, headers: request.headers, body };
    const json: KeyValue[] = [{ key: 'Content-Type', value: 'application/json', enabled: true }];
    const match = matchMockRoute(mock.routes, method, url.pathname, details);
    if (!match) {
      if (mock.cors && method === 'OPTIONS') {
        const preflight = withHeaders(plainValues, mock.defaultHeaders);
        response.writeHead(204, preflight).end();
        return log(204, { headers: preflight, body: '' });
      }
      const message = JSON.stringify(
        { error: 'No mock route matches this request.', method, path: url.pathname },
        null,
        2,
      );
      const notFound = withHeaders(plainValues, mock.defaultHeaders, json);
      response.writeHead(404, notFound).end(message);
      return log(404, { headers: notFound, body: message });
    }
    const { route, params } = match;
    // A matched request that fails the route's validation gets the problems, not the answer.
    const problems = validateMockRequest(
      route.validation,
      details,
      params,
      route.pathParams,
      route.rules,
    );
    if (problems.length) {
      const status =
        route.validation!.status >= 100 && route.validation!.status <= 599
          ? route.validation!.status
          : 422;
      const values = { params, query: url.searchParams, headers: request.headers, body };
      const failure = validationFailureBody(route.validation!, problems);
      let answer: string;
      try {
        answer = renderMockBody(failure, values);
      } catch {
        answer = failure;
      }
      const failed = withHeaders(values, mock.defaultHeaders, json);
      response.writeHead(status, failed).end(method === 'HEAD' ? undefined : answer);
      return this.publish({
        id: randomUUID(),
        mockId: mock.id,
        time: new Date(started).toISOString(),
        method,
        path: url.pathname + url.search,
        status,
        routeId: route.id,
        ...(Object.keys(params).length ? { params } : {}),
        durationMs: Date.now() - started,
        request: logMessage(flatHeaders(request.headers), body),
        response: logMessage(failed, answer),
        notes: [
          ...explainMockMatch(mock.routes, method, url.pathname, details),
          `Validation failed, so it got ${status}: ${problems.map((problem) => problem.message).join('; ')}.`,
        ],
        ...(isStreamRoute(route) ? { protocol: mockRouteKind(route) } : {}),
      });
    }
    if (isStreamRoute(route))
      return this.streamHttp(entry, route, params, details, response, log, withHeaders);
    // A response whose rules pass, or the route's own.
    const chosen = mockAnswer(
      route,
      { query: url.searchParams, headers: request.headers, body },
      params,
    );
    if (chosen.delayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, Math.min(chosen.delayMs, MAX_DELAY_MS)));
    if (response.destroyed) return;
    const values = { params, query: url.searchParams, headers: request.headers, body };
    // Header values are templates too, filled in like the body.
    const headers = withHeaders(values, mock.defaultHeaders, chosen.headers);
    let answer: string;
    try {
      answer = renderMockBody(chosen.body, values);
    } catch (error) {
      // A template that cannot be filled in (one that grows too large) is reported to the caller.
      const failed = withHeaders(values, mock.defaultHeaders, json);
      const message = JSON.stringify({
        error: `Mock template failed: ${(error as Error).message}`,
      });
      response.writeHead(500, failed).end(message);
      return log(
        500,
        { headers: failed, body: message },
        { routeId: route.id, responseId: chosen.responseId, params },
      );
    }
    const status = chosen.status >= 100 && chosen.status <= 599 ? chosen.status : 200;
    let sent: Record<string, string> = headers;
    try {
      response.writeHead(status, headers);
    } catch {
      // A header the client could not receive: answer without the route's own headers.
      response.writeHead(status, cors);
      sent = cors;
    }
    const empty = method === 'HEAD' || status === 204 || status === 304;
    response.end(empty ? undefined : answer);
    log(
      status,
      { headers: sent, body: empty ? '' : answer },
      {
        routeId: route.id,
        ...(chosen.responseId ? { responseId: chosen.responseId } : {}),
        ...(Object.keys(params).length ? { params } : {}),
        ...(chosen.delayMs > 0 ? { delayMs: Math.min(chosen.delayMs, MAX_DELAY_MS) } : {}),
      },
    );
  }
}
