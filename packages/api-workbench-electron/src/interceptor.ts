import { WORKBENCH_VAULT_LOCKED } from './workbench-vault';
import { WORKBENCH_VAULT_NOT_SET_UP } from '@techieutils/api-workbench-common/vault-messages';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { vaultUnavailable } from '@techieutils/api-workbench-common/vault-messages';
import type { SecretStorage } from './credentials';
import type {
  InterceptorCapture,
  InterceptorStatus,
} from '@techieutils/api-workbench-common/types';
import {
  createAuthority,
  describeAuthority,
  issueCertificate,
  needsRenewal,
  coversHost,
  sameDomains,
  AUTHORITY_DAYS,
  type CertificateAuthority,
} from './interceptor-ca';

/**
 * The Interceptor: a capture proxy on 127.0.0.1 that forwards traffic from browsers and other
 * apps and reports each exchange. HTTPS is decrypted with host certificates from a local CA the
 * user trusts, or passed through as an opaque tunnel when decryption is off or not possible.
 */

/** At most this much of each body is kept for inspection; the rest is forwarded but not stored. */
export const BODY_LIMIT = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const UNTRUSTED_CA =
  'The client did not accept the Interceptor certificate. Trust the API Workbench Interceptor CA on this device, or turn off HTTPS decryption.';

interface Target {
  host: string;
  port: number;
}

/** The CA, saved with its private key encrypted by the operating system, and its public certificate beside it. */
export class AuthorityStore {
  private cached?: CertificateAuthority;
  constructor(
    private directory: string,
    private storage: SecretStorage,
  ) {}
  get certificatePath(): string {
    return path.join(this.directory, 'api-workbench-interceptor-ca.crt');
  }
  private get keyPath(): string {
    return path.join(this.directory, 'authority.json');
  }
  /** Why the CA's key cannot be protected, if it cannot. */
  async unavailable(): Promise<string | undefined> {
    const state = await this.storage.vaultState?.();
    if (state?.kind === 'workbench' && (state.locked || !state.setUp))
      return state.setUp ? WORKBENCH_VAULT_LOCKED : WORKBENCH_VAULT_NOT_SET_UP;
    const backend = this.storage.getSelectedStorageBackend?.();
    return (await this.storage.isAsyncEncryptionAvailable()) && backend !== 'basic_text'
      ? undefined
      : vaultUnavailable(backend);
  }
  /**
   * The saved CA, creating one the first time; undefined when OS encryption is unavailable.
   * `domains` is what it should be limited to: a saved CA limited otherwise is replaced (the main
   * process first removes a trusted one from the trusted certificates). Left out, the saved CA's
   * own limits are kept, also when it is renewed.
   */
  async load(domains?: readonly string[]): Promise<CertificateAuthority | undefined> {
    // A CA kept in memory while the app runs for weeks is renewed as it runs out, too.
    const fits = (authority: CertificateAuthority) =>
      !needsRenewal(authority.certPem) &&
      (domains === undefined || sameDomains(authority.domains, domains));
    if (this.cached && fits(this.cached)) return this.cached;
    let keep = domains ?? this.cached?.domains;
    this.cached = undefined;
    if (await this.unavailable()) return undefined;
    try {
      const saved = JSON.parse(await readFile(this.keyPath, 'utf8')) as {
        certPem: string;
        key: string;
        domains?: string[];
      };
      const { result: keyPem, shouldReEncrypt } = await this.storage.decryptStringAsync(
        Buffer.from(saved.key, 'base64'),
      );
      const authority: CertificateAuthority = {
        certPem: saved.certPem,
        keyPem,
        ...(saved.domains?.length ? { domains: saved.domains } : {}),
      };
      keep ??= authority.domains;
      // One running out is replaced; a long-lived one from an older version is replaced by the
      // main process, which first removes it from the trusted certificates (`isLongLived`).
      if (fits(authority)) {
        // The OS key has rotated: keep the CA, with its key encrypted under the current one.
        if (shouldReEncrypt) await this.save(authority);
        return (this.cached = authority);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
        throw error;
    }
    return this.create(keep ?? []);
  }
  /** Peeks at the saved CA without creating one. */
  async existing(): Promise<CertificateAuthority | undefined> {
    if (this.cached && !needsRenewal(this.cached.certPem)) return this.cached;
    try {
      await readFile(this.keyPath);
    } catch {
      return undefined;
    }
    return this.load();
  }
  /** A new CA, limited to `domains`, or as the current one is when left out. */
  async reset(domains?: readonly string[]): Promise<CertificateAuthority | undefined> {
    const keep = domains ?? (await this.existing().catch(() => undefined))?.domains ?? [];
    this.cached = undefined;
    await rm(this.keyPath, { force: true });
    await rm(this.certificatePath, { force: true });
    return this.load(keep);
  }
  private async create(domains: readonly string[]): Promise<CertificateAuthority> {
    const authority = createAuthority(new Date(), AUTHORITY_DAYS, domains);
    await this.save(authority);
    await writeFile(this.certificatePath, authority.certPem);
    return (this.cached = authority);
  }
  /** Saves the CA with its private key encrypted by the operating system. */
  private async save(authority: CertificateAuthority): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = (await this.storage.encryptStringAsync(authority.keyPem)).toString('base64');
    const domains = authority.domains?.length ? { domains: authority.domains } : {};
    await writeFile(this.keyPath, JSON.stringify({ certPem: authority.certPem, key, ...domains }), {
      mode: 0o600,
    });
  }
}

/** Keeps the first BODY_LIMIT bytes of a stream and counts the rest. */
class BodyTap {
  private chunks: Buffer[] = [];
  private kept = 0;
  size = 0;
  push(chunk: Buffer): void {
    this.size += chunk.length;
    if (this.kept >= BODY_LIMIT) return;
    const part = chunk.subarray(0, BODY_LIMIT - this.kept);
    this.chunks.push(part);
    this.kept += part.length;
  }
  get truncated(): boolean {
    return this.size > this.kept;
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Text when the bytes are UTF-8 without control characters, otherwise base64. */
function encodeBody(bytes: Buffer): { body?: string; encoding?: 'utf8' | 'base64' } {
  if (!bytes.length) return {};
  const text = bytes.toString('utf8');
  // eslint-disable-next-line no-control-regex
  return text.includes('�') || /[\x00-\x08\x0E-\x1F]/.test(text)
    ? { body: bytes.toString('base64'), encoding: 'base64' }
    : { body: text, encoding: 'utf8' };
}
/** Undoes Content-Encoding so the captured body is readable; complete bodies only. */
function decodeBody(bytes: Buffer, encoding: string | undefined, truncated: boolean): Buffer {
  const name = (encoding || '').trim().toLowerCase();
  if (!bytes.length || truncated || !name || name === 'identity') return bytes;
  try {
    if (name === 'gzip' || name === 'x-gzip') return zlib.gunzipSync(bytes);
    if (name === 'deflate') return zlib.inflateSync(bytes);
    if (name === 'br') return zlib.brotliDecompressSync(bytes);
  } catch {
    // Keep the bytes as sent.
  }
  return bytes;
}
const pairs = (raw: string[]): [string, string][] => {
  const result: [string, string][] = [];
  for (let index = 0; index < raw.length; index += 2) result.push([raw[index], raw[index + 1]]);
  return result;
};
/** Raw headers without hop-by-hop ones, including any the Connection header names. */
function forwardable(raw: string[], keep: string[] = []): string[] {
  const named = new Set(
    pairs(raw)
      .filter(([key]) => key.toLowerCase() === 'connection')
      .flatMap(([, value]) => value.split(',').map((item) => item.trim().toLowerCase())),
  );
  return pairs(raw)
    .filter(([key]) => {
      const lower = key.toLowerCase();
      return keep.includes(lower) || (!HOP_BY_HOP.has(lower) && !named.has(lower));
    })
    .flat();
}
const header = (raw: string[], name: string) =>
  pairs(raw).find(([key]) => key.toLowerCase() === name)?.[1];
/** host:port from a CONNECT request, with IPv6 hosts in brackets. */
function authority(value: string | undefined): Target | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value || '');
  const port = Number(match?.[3]);
  return match && port > 0 && port < 65536 ? { host: match[1] || match[2], port } : undefined;
}
const hostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
function describe(error: unknown): string {
  const failure = error as NodeJS.ErrnoException;
  if (failure?.code === 'ENOTFOUND')
    return `Could not resolve ${(failure as { hostname?: string }).hostname || 'the host'}.`;
  if (failure?.code === 'ECONNREFUSED') return 'The server refused the connection.';
  if (failure?.code === 'ETIMEDOUT' || failure?.message === 'timeout')
    return 'The server did not respond in time.';
  return failure?.message || String(error);
}

export interface InterceptorOptions {
  authorities: AuthorityStore;
  publish(capture: InterceptorCapture): void;
  /** Extra CA certificates trusted for upstream servers, in addition to the system's. */
  upstreamCA?: string[];
}

export class Interceptor {
  private server?: http.Server;
  /** Serves requests from decrypted HTTPS connections; it never listens itself. */
  private decrypted = http.createServer();
  private targets = new WeakMap<object, Target>();
  private contexts = new Map<string, tls.SecureContext>();
  private sockets = new Set<net.Socket | Duplex>();
  private authority?: CertificateAuthority;
  private authorityError?: string;
  private port = 8899;
  private decryptHttps = true;
  private recording = true;

  constructor(private options: InterceptorOptions) {
    this.decrypted.on('request', (request, response) =>
      this.forward(request, response, this.targets.get(request.socket)),
    );
    this.decrypted.on('upgrade', (request, socket, head) =>
      this.upgrade(request, socket as net.Socket, head, this.targets.get(request.socket)),
    );
  }

  async status(): Promise<InterceptorStatus> {
    const authority =
      this.authority || (await this.options.authorities.existing().catch(() => undefined));
    return {
      running: Boolean(this.server?.listening),
      port: this.port,
      decryptHttps: this.decryptHttps,
      recording: this.recording,
      authority: authority
        ? {
            ...describeAuthority(authority),
            path: this.options.authorities.certificatePath,
            domains: authority.domains ?? [],
          }
        : undefined,
      authorityError: this.authorityError ?? (await this.options.authorities.unavailable()),
    };
  }

  /** `domains`: the only ones decrypted, with a CA limited to them; empty decrypts every host. */
  async start(
    port: number,
    decryptHttps: boolean,
    domains: readonly string[] = [],
  ): Promise<InterceptorStatus> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error('Choose a port from 1024 to 65535.');
    await this.stop();
    this.port = port;
    this.decryptHttps = decryptHttps;
    this.authorityError = undefined;
    this.contexts.clear();
    if (decryptHttps) {
      try {
        this.authority = await this.options.authorities.load(domains);
        if (!this.authority) this.authorityError = await this.options.authorities.unavailable();
      } catch (error) {
        this.authorityError = `The Interceptor certificate could not be loaded: ${describe(error)}`;
      }
    }
    const server = http.createServer((request, response) => this.forward(request, response));
    server.on('connect', (request, socket, head) =>
      this.connect(request, socket as net.Socket, head),
    );
    server.on('upgrade', (request, socket, head) =>
      this.upgrade(request, socket as net.Socket, head),
    );
    server.on('connection', (socket) => this.track(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            error.code === 'EADDRINUSE'
              ? `Port ${port} is already in use. Choose another port.`
              : describe(error),
          ),
        ),
      );
      server.listen(port, '127.0.0.1', () => resolve());
    });
    this.server = server;
    return this.status();
  }

  async stop(): Promise<InterceptorStatus> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    return this.status();
  }

  setRecording(recording: boolean): Promise<InterceptorStatus> {
    this.recording = recording;
    return this.status();
  }

  async resetAuthority(domains?: readonly string[]): Promise<InterceptorStatus> {
    this.authority = await this.options.authorities.reset(domains);
    this.contexts.clear();
    return this.status();
  }

  private track<T extends net.Socket | Duplex>(socket: T): T {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    return socket;
  }

  /** Starts a capture, or returns undefined while recording is paused. */
  private capture(
    fields: Pick<InterceptorCapture, 'scheme' | 'method' | 'url'> & Partial<InterceptorCapture>,
  ): InterceptorCapture | undefined {
    if (!this.recording) return undefined;
    const capture: InterceptorCapture = {
      id: randomUUID(),
      startedAt: Date.now(),
      requestHeaders: [],
      requestBodySize: 0,
      done: false,
      ...fields,
    };
    this.options.publish(capture);
    return capture;
  }
  private finish(
    capture: InterceptorCapture | undefined,
    fields: Partial<InterceptorCapture>,
  ): void {
    if (!capture || capture.done) return;
    Object.assign(capture, fields, { done: true, durationMs: Date.now() - capture.startedAt });
    this.options.publish(capture);
  }

  /** Forwards one HTTP request: absolute-form from a proxy client, or origin-form inside a decrypted connection. */
  private forward(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    target?: Target,
  ): void {
    let url: URL;
    try {
      url = target
        ? new URL(
            request.url || '/',
            `https://${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`,
          )
        : new URL(request.url || '');
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain' });
      response.end(
        'This is the API Workbench Interceptor. Set 127.0.0.1:' +
          this.port +
          ' as the HTTP and HTTPS proxy of the app you want to capture.',
      );
      return;
    }
    if (this.isSelf(hostname(url), Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) {
      response.writeHead(508, { 'Content-Type': 'text/plain' });
      response.end('The Interceptor does not forward requests to itself.');
      return;
    }
    const capture = this.capture({
      scheme: target ? 'https' : 'http',
      method: request.method || 'GET',
      url: url.toString(),
      requestHeaders: pairs(request.rawHeaders),
    });
    const requestBody = new BodyTap();
    request.on('data', (chunk: Buffer) => requestBody.push(chunk));
    const secure = url.protocol === 'https:';
    const upstream = (secure ? https : http).request({
      protocol: url.protocol,
      hostname: hostname(url),
      port: url.port || undefined,
      method: request.method,
      path: url.pathname + url.search,
      headers: forwardable(request.rawHeaders) as unknown as http.OutgoingHttpHeaders,
      ...(secure && !net.isIP(hostname(url)) ? { servername: hostname(url) } : {}),
      ...this.trust(),
      timeout: UPSTREAM_TIMEOUT_MS,
    });
    const requestFields = () => {
      const { body, encoding } = encodeBody(requestBody.buffer());
      return {
        requestBody: body,
        requestBodyEncoding: encoding,
        requestBodySize: requestBody.size,
      };
    };
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('response', (reply) => {
      const responseBody = new BodyTap();
      response.writeHead(
        reply.statusCode || 502,
        reply.statusMessage,
        forwardable(reply.rawHeaders),
      );
      reply.on('data', (chunk: Buffer) => responseBody.push(chunk));
      reply.pipe(response);
      reply.on('end', () => {
        const bytes = decodeBody(
          responseBody.buffer(),
          header(reply.rawHeaders, 'content-encoding'),
          responseBody.truncated,
        );
        const { body, encoding } = encodeBody(bytes);
        this.finish(capture, {
          ...requestFields(),
          status: reply.statusCode,
          statusText: reply.statusMessage,
          responseHeaders: pairs(reply.rawHeaders),
          responseBody: body,
          responseBodyEncoding: encoding,
          responseBodySize: responseBody.size,
          truncated: requestBody.truncated || responseBody.truncated,
        });
      });
      reply.on('error', (error) =>
        this.finish(capture, {
          ...requestFields(),
          status: reply.statusCode,
          responseHeaders: pairs(reply.rawHeaders),
          error: describe(error),
        }),
      );
    });
    upstream.on('error', (error) => {
      const message = describe(error);
      if (!response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'text/plain' });
        response.end(`API Workbench Interceptor could not reach ${url.host}: ${message}`);
      } else response.destroy();
      this.finish(capture, { ...requestFields(), error: message });
    });
    response.on('close', () => {
      if (!response.writableFinished) {
        upstream.destroy();
        this.finish(capture, { ...requestFields(), error: 'The client closed the connection.' });
      }
    });
    request.pipe(upstream);
  }

  /** CONNECT: decrypts TLS when it can, and otherwise tunnels the bytes through unread. */
  private connect(request: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const target = authority(request.url);
    if (!target || this.isSelf(target.host, target.port)) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    socket.on('error', () => socket.destroy());
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const begin = (first: Buffer) => {
      socket.pause();
      socket.unshift(first);
      // 0x16 starts a TLS handshake; anything else (such as WebSocket over CONNECT) is tunnelled.
      // A CA limited to some domains cannot vouch for another host, so that one passes through.
      if (
        this.decryptHttps &&
        this.authority &&
        first[0] === 0x16 &&
        coversHost(this.authority.domains, target.host)
      )
        this.decrypt(socket, target);
      else this.tunnel(socket, target);
    };
    if (head.length) begin(head);
    else socket.once('data', begin);
  }

  private decrypt(socket: net.Socket, target: Target): void {
    // A generic stream (not the socket itself) so TLS also reads the bytes already peeked at.
    const stream = this.track(
      Duplex.from({ readable: socket, writable: socket } as unknown as Parameters<
        typeof Duplex.from
      >[0]),
    );
    const secure = new tls.TLSSocket(stream, {
      isServer: true,
      ALPNProtocols: ['http/1.1'],
      secureContext: this.context(target.host),
      SNICallback: (servername, callback) => {
        try {
          callback(null, this.context(servername || target.host));
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    this.targets.set(secure, target);
    this.track(secure);
    let established = false;
    let reported = false;
    secure.once('secure', () => (established = true));
    // A client that distrusts the certificate sends an alert or simply hangs up mid-handshake.
    const rejected = (error?: Error) => {
      if (established || reported) return;
      reported = true;
      const url = `https://${target.host}${target.port === 443 ? '' : `:${target.port}`}`;
      const message =
        !error ||
        /alert|certificate|unknown ca/i.test(error.message) ||
        (error as NodeJS.ErrnoException).code === 'ECONNRESET'
          ? UNTRUSTED_CA
          : describe(error);
      this.finish(this.capture({ scheme: 'https', method: 'CONNECT', url }), { error: message });
    };
    secure.on('error', (error) => {
      rejected(error);
      secure.destroy();
    });
    secure.once('end', () => rejected());
    secure.once('close', () => rejected());
    this.decrypted.emit('connection', secure);
  }

  private tunnel(socket: net.Socket, target: Target): void {
    const capture = this.capture({
      scheme: 'tunnel',
      method: 'CONNECT',
      url: `https://${target.host}${target.port === 443 ? '' : `:${target.port}`}`,
    });
    const upstream = this.track(net.connect(target.port, target.host));
    let sent = 0,
      received = 0,
      failure: string | undefined;
    socket.on('data', (chunk: Buffer) => (sent += chunk.length));
    upstream.on('data', (chunk: Buffer) => (received += chunk.length));
    upstream.on('error', (error) => (failure = describe(error)));
    const close = () => {
      socket.destroy();
      upstream.destroy();
      this.finish(capture, { bytesSent: sent, bytesReceived: received, error: failure });
    };
    socket.once('close', close);
    upstream.once('close', close);
    upstream.on('connect', () => {
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  }

  /** WebSocket and other upgrades: relays the handshake, then the raw connection. */
  private upgrade(
    request: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    target?: Target,
  ): void {
    let url: URL;
    try {
      url = target
        ? new URL(request.url || '/', `https://${target.host}:${target.port}`)
        : new URL(request.url || '');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const capture = this.capture({
      scheme: target ? 'https' : 'http',
      method: request.method || 'GET',
      url: url.toString(),
      requestHeaders: pairs(request.rawHeaders),
    });
    const secure = url.protocol === 'https:';
    const upstream = (secure ? https : http).request({
      hostname: hostname(url),
      port: url.port || undefined,
      method: request.method,
      path: url.pathname + url.search,
      headers: forwardable(request.rawHeaders, [
        'connection',
        'upgrade',
      ]) as unknown as http.OutgoingHttpHeaders,
      ...(secure && !net.isIP(hostname(url)) ? { servername: hostname(url) } : {}),
      ...this.trust(),
    });
    socket.on('error', () => upstream.destroy());
    upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
      this.track(upstreamSocket);
      const lines = pairs(reply.rawHeaders).map(([key, value]) => `${key}: ${value}`);
      socket.write(
        `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${lines.join('\r\n')}\r\n\r\n`,
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      this.finish(capture, {
        status: reply.statusCode,
        statusText: reply.statusMessage,
        responseHeaders: pairs(reply.rawHeaders),
      });
    });
    upstream.on('response', (reply) => {
      const lines = pairs(forwardable(reply.rawHeaders)).map(([key, value]) => `${key}: ${value}`);
      socket.write(
        `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${[...lines, 'Connection: close'].join('\r\n')}\r\n\r\n`,
      );
      reply.pipe(socket);
      this.finish(capture, {
        status: reply.statusCode,
        statusText: reply.statusMessage,
        responseHeaders: pairs(reply.rawHeaders),
      });
    });
    upstream.on('error', (error) => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      this.finish(capture, { error: describe(error) });
    });
    upstream.end();
  }

  /** A TLS context with a certificate for the host, issued once and reused. */
  private context(host: string): tls.SecureContext {
    let context = this.contexts.get(host);
    if (!context) {
      const issued = issueCertificate(this.authority!, host);
      context = tls.createSecureContext({ cert: issued.cert, key: issued.key });
      if (this.contexts.size >= 500) this.contexts.delete(this.contexts.keys().next().value!);
      this.contexts.set(host, context);
    }
    return context;
  }

  private trust(): { ca?: string[] } {
    return this.options.upstreamCA?.length
      ? { ca: [...tls.rootCertificates, ...this.options.upstreamCA] }
      : {};
  }

  private isSelf(host: string, port: number): boolean {
    return (
      port === this.port &&
      ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host.toLowerCase())
    );
  }
}
