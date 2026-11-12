import { createHash } from 'node:crypto';
import { captureTLSCertificate } from './certificates';
import { connect as connectTLS, type TLSSocket } from 'node:tls';
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import {
  Agent,
  Pool,
  buildConnector,
  fetch,
  Headers,
  Response,
  type Dispatcher,
  type RequestInit,
} from 'undici';
import { Readable } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP, type Socket } from 'node:net';
import type {
  NetworkTiming,
  NetworkHop,
  NetworkPhase,
  TLSConnectionInfo,
} from '@techieutils/api-workbench-common/types';
interface Connection {
  certificate?: TLSConnectionInfo;
  proxied?: boolean;
  start: number;
  dns?: number;
  tcp?: number;
  tls?: number;
  ready?: number;
  secure: boolean;
  dnsExpected: boolean;
}
interface Trace {
  start: number;
  end?: number;
  method: string;
  url: string;
  status?: number;
  connection?: Connection;
  sending?: number;
  sent?: number;
  headers?: number;
}
const storage = new AsyncLocalStorage<Trace>();
const requestTraces = new WeakMap<object, Trace>();
const socketConnections = new WeakMap<Socket, Connection>();
// The connector's runtime return is the socket (the public callback type omits that return).
export function createTimingAgent(
  connectOptions: Parameters<typeof buildConnector>[0] = {},
  agentOptions: Agent.Options = {},
  strictHTTP2 = false,
  customConnect?: ReturnType<typeof buildConnector>,
  fixedOrigin?: string | URL,
): Agent {
  const sessionCertificates = new Map<string, TLSConnectionInfo>();
  const sessionKey = (socket: TLSSocket) => {
    const session = socket.getSession();
    return session ? createHash('sha256').update(session).digest('hex') : '';
  };
  const standardConnect = buildConnector(connectOptions);
  const chosenConnect: ReturnType<typeof buildConnector> =
    customConnect ||
    (strictHTTP2
      ? (options, callback) => {
          const hostname = options.hostname.replace(/^\[|\]$/g, '');
          const socket = connectTLS({
            ...connectOptions,
            host: hostname,
            port: Number(options.port) || 443,
            servername: options.servername || (isIP(hostname) ? undefined : hostname),
            ALPNProtocols: ['h2'],
          });
          let finished = false;
          const finish = (error: Error | null) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.removeListener('error', onError);
            if (error) {
              socket.destroy();
              callback(error, null);
            } else callback(null, socket);
          };
          const onError = (error: Error) => finish(error);
          const timer = setTimeout(
            () =>
              finish(
                Object.assign(new Error('Connection timed out.'), {
                  code: 'UND_ERR_CONNECT_TIMEOUT',
                }),
              ),
            connectOptions.timeout || 10000,
          );
          socket.once('error', onError);
          socket.once('secureConnect', () =>
            finish(
              socket.alpnProtocol === 'h2'
                ? null
                : Object.assign(new Error('The server did not negotiate required HTTP/2.'), {
                    code: 'AW_HTTP2_REQUIRED',
                  }),
            ),
          );
          return socket;
        }
      : standardConnect);
  const connect = chosenConnect as unknown as (
    options: Parameters<ReturnType<typeof buildConnector>>[0],
    callback: Parameters<ReturnType<typeof buildConnector>>[1],
  ) => Socket | undefined;
  return new Agent({
    ...agentOptions,
    ...(fixedOrigin
      ? { factory: (_origin: URL, options: object) => new Pool(fixedOrigin, options) }
      : {}),
    connect(options, callback) {
      const connection: Connection = {
        start: performance.now(),
        secure: options.protocol === 'https:',
        proxied: Boolean(customConnect),
        dnsExpected: !isIP(options.hostname.replace(/^\[|\]$/g, '')),
      };
      const trace = storage.getStore();
      if (trace) trace.connection = connection;
      const socket = connect(options, (error, connected) => {
        if (error) {
          callback(error, null);
          return;
        }
        if (
          strictHTTP2 &&
          options.protocol === 'https:' &&
          (connected as TLSSocket).alpnProtocol !== 'h2'
        ) {
          connected?.destroy();
          callback(
            Object.assign(new Error('The server did not negotiate required HTTP/2.'), {
              code: 'AW_HTTP2_REQUIRED',
            }),
            null,
          );
          return;
        }
        if (connected) socketConnections.set(connected, connection);
        connection.ready = performance.now();
        if (connection.secure) {
          connection.tls = connection.ready;
          const secureSocket = connected as TLSSocket;
          const previous = secureSocket.isSessionReused()
            ? sessionCertificates.get(sessionKey(secureSocket))
            : undefined;
          connection.certificate = captureTLSCertificate(
            secureSocket,
            options.hostname,
            Number(options.port) || 443,
            previous?.chain,
          );
        } else connection.tcp = connection.ready;
        callback(null, connected);
      });
      if (!socket || typeof socket.once !== 'function') return;
      socketConnections.set(socket, connection);
      if (connection.secure)
        socket.on('session', (session: Buffer) => {
          if (!connection.certificate) return;
          const key = createHash('sha256').update(session).digest('hex');
          sessionCertificates.delete(key);
          sessionCertificates.set(key, connection.certificate);
          if (sessionCertificates.size > 100)
            sessionCertificates.delete(sessionCertificates.keys().next().value!);
        });
      socket.once('lookup', (error: Error | null) => {
        if (!error) connection.dns = performance.now();
      });
      socket.once('connect', () => {
        connection.tcp ??= performance.now();
      });
      return socket;
    },
  });
}
export const timingAgent = createTimingAgent();
channel('undici:request:create').subscribe((message) => {
  const trace = storage.getStore();
  if (trace) requestTraces.set((message as { request: object }).request, trace);
});
channel('undici:client:sendHeaders').subscribe((message) => {
  const { request, socket } = message as { request: object; socket: Socket };
  const trace = requestTraces.get(request);
  if (trace) {
    trace.sending = performance.now();
    trace.connection = socketConnections.get(socket);
  }
});
channel('undici:request:bodySent').subscribe((message) => {
  const trace = requestTraces.get((message as { request: object }).request);
  if (trace) trace.sent = performance.now();
});
channel('undici:request:headers').subscribe((message) => {
  const { request, response } = message as { request: object; response: { statusCode: number } };
  const trace = requestTraces.get(request);
  if (trace) {
    trace.headers = performance.now();
    trace.status = response.statusCode;
  }
});
export class NetworkTimingRecorder {
  constructor(private readonly dispatcher: Dispatcher = timingAgent) {}
  httpVersionSnapshot(): string | undefined {
    const trace = this.traces.at(-1);
    return trace?.status
      ? trace.connection?.certificate?.alpnProtocol === 'h2'
        ? '2'
        : '1.1'
      : undefined;
  }
  tlsSnapshot(): TLSConnectionInfo | undefined {
    return this.traces.at(-1)?.connection?.certificate;
  }
  private readonly start = performance.now();
  private readonly startedAt = new Date().toISOString();
  private readonly traces: Trace[] = [];
  async fetch(url: URL, init: RequestInit): Promise<Response> {
    const trace: Trace = {
      start: performance.now(),
      method: init.method || 'GET',
      url: url.toString(),
    };
    this.traces.push(trace);
    try {
      const response = await storage.run(trace, () =>
        // fetch refuses TRACE, so it is sent with the dispatcher itself, without a body.
        init.method === 'TRACE'
          ? this.trace(url, init)
          : // undici's own fetch: the global one bundles an older undici whose handlers its Agent rejects.
            fetch(url, { ...init, dispatcher: this.dispatcher }),
      );
      trace.headers ??= performance.now();
      trace.status = response.status;
      return response;
    } catch (error) {
      trace.end = performance.now();
      throw error;
    }
  }
  private async trace(url: URL, init: RequestInit): Promise<Response> {
    const answer = await this.dispatcher.request({
      origin: url.origin,
      path: url.pathname + url.search,
      method: 'TRACE',
      headers: Object.fromEntries(new Headers(init.headers)),
      signal: init.signal ?? undefined,
    });
    return responseOf(
      answer.statusCode,
      answer.statusText,
      answer.headers,
      Readable.toWeb(answer.body) as ReadableStream<Uint8Array>,
      url,
    );
  }
  /**
   * A CONNECT request: asks `origin` (a proxy, or the server itself) to open a tunnel to
   * `authority` (`host:port`), and answers with what it said. The tunnel is closed at once, since
   * nothing is sent through it; a refusal's body, such as a proxy's 407 page, is read first.
   */
  async connect(
    origin: URL,
    authority: string,
    headers: Headers,
    signal: AbortSignal,
    bodyLimit: number,
  ): Promise<Response> {
    const trace: Trace = { start: performance.now(), method: 'CONNECT', url: origin.toString() };
    this.traces.push(trace);
    try {
      const answer = await storage.run(trace, () =>
        this.dispatcher.connect({
          origin: origin.origin,
          path: authority,
          headers: Object.fromEntries(headers),
          signal,
        }),
      );
      trace.headers ??= performance.now();
      trace.status = answer.statusCode;
      let body: Buffer = Buffer.alloc(0);
      if (answer.statusCode < 200 || answer.statusCode > 299)
        body = await readRefusal(answer.socket, answer.headers, bodyLimit);
      answer.socket.destroy();
      return responseOf(answer.statusCode, '', answer.headers, body.length ? body : null, origin);
    } catch (error) {
      trace.end = performance.now();
      throw error;
    }
  }
  completeHop(): void {
    const trace = this.traces.at(-1);
    if (trace) trace.end = performance.now();
  }
  snapshot(): NetworkTiming {
    const end = performance.now();
    const relative = (time: number) => Math.round(Math.max(0, time - this.start) * 100) / 100;
    const requests: NetworkHop[] = this.traces.map((trace) => {
      const phases: NetworkPhase[] = [];
      const finish = trace.end || end;
      const add = (
        id: NetworkPhase['id'],
        label: string,
        from: number | undefined,
        to: number | undefined,
      ) => {
        if (from === undefined || to === undefined || to < from) return;
        const start = Math.max(trace.start, from),
          stop = Math.min(finish, to);
        if (stop < start) return;
        phases.push({
          id,
          label,
          startMs: relative(start),
          durationMs: Math.round((stop - start) * 100) / 100,
        });
      };
      const connection = trace.connection;
      const reused = Boolean(connection?.ready && connection.ready <= trace.start);
      if (connection || trace.sending)
        add(
          'queueing',
          'Queueing / stalled',
          trace.start,
          connection && !reused
            ? Math.max(trace.start, connection.start)
            : trace.sending || trace.headers || finish,
        );
      if (connection?.proxied && !reused) {
        add('stalled', 'Proxy connection / tunnel', connection.start, connection.ready || finish);
      }
      if (connection && !reused && !connection.proxied) {
        add('dns', 'DNS lookup', connection.start, connection.dns);
        add('tcp', 'Initial connection (TCP)', connection.dns || connection.start, connection.tcp);
        if (connection.secure) add('tls', 'SSL / TLS handshake', connection.tcp, connection.tls);
        add('stalled', 'Waiting for socket', connection.ready, trace.sending);
        if (!connection.ready) {
          if (!connection.dns && connection.dnsExpected)
            add('dns', 'DNS lookup (incomplete)', connection.start, finish);
          else if (!connection.tcp)
            add(
              'tcp',
              'Initial connection (incomplete)',
              connection.dns || connection.start,
              finish,
            );
          else if (connection.secure)
            add('tls', 'SSL / TLS handshake (incomplete)', connection.tcp, finish);
        }
      }
      add('sending', 'Request sent', trace.sending, trace.sent || trace.headers);
      if (trace.headers || trace.sending || !connection)
        add(
          'waiting',
          'Waiting for response (TTFB)',
          trace.sent || trace.sending || connection?.ready || trace.start,
          trace.headers || finish,
        );
      add('download', 'Content download', trace.headers, finish);
      return {
        method: trace.method,
        url: trace.url,
        status: trace.status,
        startMs: relative(trace.start),
        durationMs: Math.round((finish - trace.start) * 100) / 100,
        connectionReused: reused,
        phases,
      };
    });
    return {
      startedAt: this.startedAt,
      totalMs: relative(end),
      preparationMs: this.traces.length ? relative(this.traces[0].start) : relative(end),
      requests,
    };
  }
}

/** A fetch Response for an answer the dispatcher got, so TRACE and CONNECT read like other requests. */
function responseOf(
  status: number,
  statusText: string,
  raw: IncomingHttpHeaders,
  body: ReadableStream<Uint8Array> | Buffer | null,
  url: URL,
): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw))
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
      headers.append(name, item);
  const empty = status === 204 || status === 205 || status === 304;
  if (empty && body instanceof ReadableStream) void body.cancel();
  const response = new Response(empty ? null : body, {
    // Response cannot hold an informational status; such an answer is shown as it came.
    status: status < 200 || status > 599 ? 200 : status,
    statusText,
    headers,
  });
  // fetch fills in the URL; a Response made here has none.
  Object.defineProperty(response, 'url', { value: url.toString() });
  if (status < 200) Object.defineProperty(response, 'status', { value: status });
  return response;
}
/** The body of a refused CONNECT, up to its Content-Length, the limit, or two seconds. */
function readRefusal(
  socket: import('node:stream').Duplex,
  headers: IncomingHttpHeaders,
  limit: number,
): Promise<Buffer> {
  const length = Number(headers['content-length']);
  if (length === 0) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      clearTimeout(timer);
      socket.off('data', data);
      resolve(Buffer.concat(chunks).subarray(0, Number.isFinite(length) ? length : limit));
    };
    const data = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit || (Number.isFinite(length) && size >= length)) done();
    };
    const timer = setTimeout(done, 2000);
    socket.on('data', data);
    socket.once('end', done);
    socket.once('close', done);
    socket.once('error', done);
  });
}
