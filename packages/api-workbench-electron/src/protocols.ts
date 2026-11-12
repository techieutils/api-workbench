import { Agent as HTTPAgent } from 'node:http';
import { Agent as HTTPSAgent } from 'node:https';
import { transportErrorMessage } from './http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { resolve as resolveHTTPSettings } from '@techieutils/api-workbench-common/http-settings';
import { proxyForURL } from '@techieutils/api-workbench-common/proxy';
import { acquireHTTPTransport } from './http-transport';
import { createSecureContext } from 'node:tls';
import type { LoadedClientCertificate } from './client-certificates';
import {
  cachedJWT,
  checkedSigningAuth,
  digestAuthorization,
  edgeGridHeader,
  hawkHeader,
  oauth1Header,
  parseDigestChallenge,
  signAWS,
  wsseHeaders,
  type SigningAuth,
} from '@techieutils/api-workbench-common/auth-signing';
/** Applies header-based signing for a connection's opening request (handshake, stream GET, or gRPC POST). */
function signedHeaders(
  signing: SigningAuth | undefined,
  method: string,
  url: URL,
  headers: Record<string, string>,
  unsignedPayload = false,
): Record<string, string> {
  if (!signing || signing.type === 'digest' || signing.type === 'ntlm') return headers;
  const signed = new Headers(headers);
  if (signing.type === 'jwt')
    signed.set('authorization', `${signing.prefix} ${cachedJWT(signing)}`.trim());
  else if (signing.type === 'aws')
    signAWS(signing, { method, url, headers: signed, body: '', unsignedPayload });
  else if (signing.type === 'wsse')
    for (const [name, value] of Object.entries(wsseHeaders(signing))) signed.set(name, value);
  else if (signing.type === 'edgegrid')
    signed.set('authorization', edgeGridHeader(signing, { method, url, headers: signed }));
  else if (signing.type === 'hawk')
    signed.set(
      'authorization',
      hawkHeader(signing, { method, url, contentType: signed.get('content-type') ?? undefined }),
    );
  else signed.set('authorization', oauth1Header(signing, { method, url }));
  return Object.fromEntries(signed);
}
const signingLabels: Record<SigningAuth['type'], string> = {
  digest: 'Digest auth',
  aws: 'AWS Signature',
  oauth1: 'OAuth 1.0',
  jwt: 'JWT bearer',
  ntlm: 'NTLM',
  wsse: 'WSSE',
  edgegrid: 'Akamai EdgeGrid',
  hawk: 'Hawk',
};
import WebSocket from 'ws';
import {
  io as socketIO,
  type ManagerOptions,
  type Socket,
  type SocketOptions,
} from 'socket.io-client';
import mqtt from 'mqtt';
import { randomUUID } from 'node:crypto';
import {
  checkedSendOptions,
  defaultMQTT,
  defaultSocketIO,
  mqttTopicProblem,
  normalizedMQTT,
  normalizedSocketIO,
} from '@techieutils/api-workbench-common/protocol-config';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { parse } from 'protobufjs';
import { EventEmitter } from 'node:events';
import { fetch } from 'undici';
import type {
  GRPCMethod,
  ProtocolEvent,
  ProtocolPayload,
  ProtocolSendOptions,
} from '@techieutils/api-workbench-common/types';
import { SSEParser, NDJSONParser } from '@techieutils/api-workbench-common/stream-parser';

export interface ProtocolSession {
  send(message: string, binary: boolean, options?: ProtocolSendOptions): void;
  finish(): void;
  stop(): void;
}
const LIMIT = 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Checks an outgoing text or base64 message before it is sent. */
function checkedMessage(message: unknown, binary: boolean): string {
  if (typeof message !== 'string' || Buffer.byteLength(message) > LIMIT)
    throw new Error('Messages are limited to 1 MiB.');
  if (binary && !BASE64.test(message)) throw new Error('Binary messages must use valid base64.');
  return message;
}
/** UTF-8 text, or undefined for bytes that are not text (shown as base64). */
function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
/** Socket.IO arguments as one message: a lone string as is, anything else as JSON. */
function socketIOData(args: unknown[]): { data: string; binary?: boolean } {
  if (args.length === 1 && typeof args[0] === 'string') return { data: args[0] };
  if (args.length === 1 && Buffer.isBuffer(args[0]))
    return { data: args[0].toString('base64'), binary: true };
  return { data: args.length ? JSON.stringify(args.length === 1 ? args[0] : args) : '' };
}
/** An outgoing Socket.IO argument: JSON text is sent as its value, other text as a string. */
function socketIOArgument(message: string): unknown {
  try {
    return message.trim() ? (JSON.parse(message) as unknown) : message;
  } catch {
    return message;
  }
}
/** A schema's services, for calling them or (in mock servers) serving them. */
export function protoDefinition(proto: string): loader.PackageDefinition {
  if (typeof proto !== 'string' || !proto.trim() || Buffer.byteLength(proto) > LIMIT)
    throw new Error('Enter a self-contained .proto schema up to 1 MiB.');
  const result = parse(proto, { keepCase: true });
  if (result.imports?.length || result.weakImports?.length)
    throw new Error('Proto imports are not supported yet. Paste a bundled, self-contained schema.');
  result.root.resolveAll();
  return loader.fromJSON(result.root.toJSON(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
}
function methods(proto: string): [string, loader.MethodDefinition<object, object>][] {
  return Object.values(protoDefinition(proto)).flatMap((service) => {
    if ('format' in service) return [];
    return Object.values(service)
      .filter((method) => typeof method.path === 'string')
      .map((method) => [method.path, method] as [string, loader.MethodDefinition<object, object>]);
  });
}
export function inspectProto(proto: string): GRPCMethod[] {
  return methods(proto).map(([path, method]) => ({
    path,
    requestStream: method.requestStream,
    responseStream: method.responseStream,
  }));
}
/** One method's streaming kind and request message name, for code generation. */
export function describeMethod(
  proto: string,
  path: string,
): (GRPCMethod & { requestType?: string }) | undefined {
  const found = methods(proto).find(
    ([candidate]) => candidate.replace(/^\//, '') === path.replace(/^\//, ''),
  );
  if (!found) return undefined;
  const [methodPath, method] = found;
  const type = (method.requestType as { type?: { name?: string } } | undefined)?.type?.name;
  return {
    path: methodPath,
    requestStream: method.requestStream,
    responseStream: method.responseStream,
    requestType: type,
  };
}
export function startProtocol(
  input: ProtocolPayload,
  receive: (event: ProtocolEvent) => void,
  clientCertificate?: LoadedClientCertificate,
): ProtocolSession {
  if (
    !input ||
    !['websocket', 'sse', 'ndjson', 'grpc', 'socketio', 'mqtt'].includes(input.protocol)
  )
    throw new Error('Choose a supported protocol.');
  if (typeof input.sessionId !== 'string' || !/^[\w-]{1,80}$/.test(input.sessionId))
    throw new Error('Invalid session ID.');
  if (typeof input.url !== 'string' || input.url.length > 8192)
    throw new Error('Invalid destination.');
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > LIMIT)
    throw new Error('Messages are limited to 1 MiB.');
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 3600000)
    throw new Error('Timeout must be 100–3600000 ms.');
  if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers))
    throw new Error('Invalid headers.');
  for (const [key, value] of Object.entries(input.headers)) {
    if (!key || typeof value !== 'string' || /[\r\n]/.test(key + value))
      throw new Error('Invalid header or metadata.');
  }
  if (Object.keys(input.headers).some((key) => key.toLowerCase() === 'proxy-authorization'))
    throw new Error(
      'Set proxy credentials in Proxy settings instead of a Proxy-Authorization request header.',
    );
  const config = resolveHTTPSettings(input.httpSettings);
  const signing = checkedSigningAuth(input.signing);
  if (signing?.type === 'ntlm')
    throw new Error('NTLM authenticates HTTP connections only. Use it with an HTTP request.');
  let stopped = false;
  let cleanup = () => {};
  let total = 0;
  const emit = (type: ProtocolEvent['type'], data: string, extra: Partial<ProtocolEvent> = {}) => {
    if (stopped) return;
    const bytes = Buffer.byteLength(data);
    if (bytes > LIMIT || (total += bytes) > 10 * LIMIT) {
      fail('Session exceeded the 1 MiB message or 10 MiB receive limit.');
      return;
    }
    receive({ ...extra, sessionId: input.sessionId, type, at: Date.now(), data });
  };
  const close = (message: string) => {
    if (stopped) return;
    emit('closed', message);
    stopped = true;
    clearTimeout(timer);
    cleanup();
  };
  const fail = (message: string) => {
    if (stopped) return;
    // Bypass the data budget to ensure the reason is always visible.
    receive({ sessionId: input.sessionId, type: 'error', at: Date.now(), data: message });
    stopped = true;
    clearTimeout(timer);
    cleanup();
    receive({
      sessionId: input.sessionId,
      type: 'closed',
      at: Date.now(),
      data: 'Connection failed',
    });
  };
  const session: ProtocolSession = {
    send: () => {
      throw new Error('This protocol does not accept additional messages.');
    },
    finish: () => {
      throw new Error('This call does not have a writable stream.');
    },
    stop: () => close('Disconnected'),
  };
  emit('connecting', 'Connecting…');
  const certificateOptions = clientCertificate
    ? {
        cert: clientCertificate.cert,
        key: clientCertificate.key,
        pfx: clientCertificate.pfx,
        passphrase: clientCertificate.passphrase,
      }
    : {};
  const presentsCertificate =
    clientCertificate &&
    (input.protocol === 'grpc' ? input.grpc?.tls : /^(wss|https|mqtts):/i.test(input.url));
  if (presentsCertificate)
    emit('status', `Client certificate: ${clientCertificate.subject || 'configured'}`);
  if (signing)
    emit(
      'status',
      `Authentication: ${signingLabels[signing.type]}${signing.type === 'digest' ? ' (answers the server challenge)' : ' (signed when connecting)'}`,
    );
  const timer = setTimeout(() => close('Session timeout reached'), input.timeoutMs);
  /** TLS options from HTTP settings, with the client certificate on secure connections. */
  const tlsFor = (secure: boolean) => ({
    rejectUnauthorized: config.verifyTLS,
    minVersion: config.tlsMinVersion,
    maxVersion: config.tlsMaxVersion,
    ...(config.caCertificates ? { ca: config.caCertificates } : {}),
    ...(config.tlsCiphers ? { ciphers: config.tlsCiphers } : {}),
    ...(secure ? certificateOptions : {}),
  });
  /** The agent for an HTTP upgrade (WebSocket handshake), through the proxy when one applies. */
  const upgradeAgent = (url: URL, secure: boolean, tls: ReturnType<typeof tlsFor>) => {
    const proxy = proxyForURL(config, url);
    return proxy
      ? new HttpsProxyAgent(proxy, {
          ...tls,
          headers:
            config.proxyUsername || config.proxyPassword
              ? {
                  'Proxy-Authorization': `Basic ${Buffer.from(`${config.proxyUsername}:${config.proxyPassword}`).toString('base64')}`,
                }
              : {},
        })
      : secure
        ? new HTTPSAgent(tls)
        : new HTTPAgent();
  };
  try {
    if (input.protocol === 'websocket') {
      const url = new URL(input.url);
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Enter a ws:// or wss:// URL.');
      const tls = tlsFor(url.protocol === 'wss:');
      const agent = upgradeAgent(url, url.protocol === 'wss:', tls);
      // Signatures cover the HTTP handshake, so ws:// and wss:// sign as http:// and https://.
      const handshakeURL = new URL(url);
      handshakeURL.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      let socket: WebSocket;
      const connect = (headers: Record<string, string>, retryDigest: boolean) => {
        socket = new WebSocket(url, {
          ...tls,
          agent,
          headers,
          maxPayload: LIMIT,
          handshakeTimeout: Math.min(input.timeoutMs, 30000),
          followRedirects: false,
        });
        socket.on('unexpected-response', (_request, response) => {
          const challenge =
            retryDigest && signing?.type === 'digest' && response.statusCode === 401
              ? parseDigestChallenge(
                  (response.headers['www-authenticate'] as string | undefined) ?? null,
                )
              : undefined;
          response.resume();
          if (!challenge || signing?.type !== 'digest') {
            fail(`WebSocket handshake failed: HTTP ${response.statusCode}`);
            return;
          }
          socket.removeAllListeners();
          socket.on('error', () => {});
          socket.terminate();
          emit('status', 'Answering the Digest challenge…');
          connect(
            {
              ...headers,
              authorization: digestAuthorization(
                signing,
                challenge,
                'GET',
                url.pathname + url.search,
              ),
            },
            false,
          );
        });
        socket.on('upgrade', (response) => emit('metadata', JSON.stringify(response.headers)));
        socket.on('open', () => emit('open', 'WebSocket connected', { writable: true }));
        socket.on('message', (data, binary) =>
          emit(
            'message',
            binary ? Buffer.from(data as Buffer).toString('base64') : data.toString(),
            { binary },
          ),
        );
        socket.on('error', (error) => fail(error.message));
        socket.on('close', (code, reason) =>
          close(`WebSocket closed: ${code}${reason.length ? ` ${reason.toString()}` : ''}`),
        );
      };
      connect(signedHeaders(signing, 'GET', handshakeURL, input.headers), true);
      cleanup = () => {
        socket.terminate();
        agent?.destroy();
      };
      session.send = (message, binary) => {
        if (stopped || socket.readyState !== WebSocket.OPEN)
          throw new Error('Connect the WebSocket before sending.');
        checkedMessage(message, binary);
        socket.send(binary ? Buffer.from(message, 'base64') : message, { binary });
        emit('sent', message, { binary });
      };
    } else if (input.protocol === 'socketio') {
      const options = normalizedSocketIO(input.socketio) ?? defaultSocketIO();
      const url = new URL(input.url);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol))
        throw new Error('Enter an http://, https://, ws://, or wss:// Socket.IO server URL.');
      if (!options.path.startsWith('/')) throw new Error('The Socket.IO path must start with /.');
      // The client connects over WebSocket only, so the handshake is a single HTTP request.
      // Engine.IO adds its own query to that request, so signatures that cover the URL would not
      // match what is sent; header-only schemes work.
      if (signing && signing.type !== 'jwt' && signing.type !== 'wsse')
        throw new Error(
          `${signingLabels[signing.type]} is not supported for Socket.IO. Use a header-based authentication type.`,
        );
      const secure = url.protocol === 'https:' || url.protocol === 'wss:';
      url.protocol = secure ? 'https:' : 'http:';
      const tls = tlsFor(secure);
      const agent = upgradeAgent(url, secure, tls);
      // Engine.IO hands the TLS options and agent to ws as they are; its types list strings only.
      const socket: Socket = socketIO(url.toString(), {
        ...tls,
        path: options.path,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        timeout: Math.min(input.timeoutMs, 30000),
        extraHeaders: signedHeaders(signing, 'GET', url, input.headers),
        agent,
      } as unknown as Partial<ManagerOptions & SocketOptions>);
      cleanup = () => {
        socket.offAny();
        socket.removeAllListeners();
        socket.disconnect();
        socket.io.engine?.close();
        agent.destroy();
      };
      socket.on('connect', () => {
        emit(
          'metadata',
          JSON.stringify({
            id: socket.id,
            namespace: url.pathname || '/',
            transport: socket.io.engine?.transport?.name ?? 'websocket',
          }),
        );
        emit('open', `Socket.IO connected · ${url.pathname || '/'}`, { writable: true });
      });
      socket.on('connect_error', (error: Error) =>
        fail(`Socket.IO connection failed: ${error.message}`),
      );
      socket.on('disconnect', (reason: string) => close(`Socket.IO disconnected: ${reason}`));
      socket.onAny((event: string, ...args: unknown[]) => {
        const { data, binary } = socketIOData(args);
        emit('message', data, { event, ...(binary ? { binary } : {}) });
      });
      session.send = (message, binary, sendOptions) => {
        if (stopped || !socket.connected)
          throw new Error('Connect to the Socket.IO server before sending.');
        checkedMessage(message, binary);
        const { event, ack } = checkedSendOptions(
          'socketio',
          sendOptions ?? { event: options.event, ack: options.ack },
        )!;
        const value = binary ? Buffer.from(message, 'base64') : socketIOArgument(message);
        if (ack)
          socket
            .timeout(Math.min(input.timeoutMs, 10000))
            .emit(event!, value, (error: Error | null, ...response: unknown[]) => {
              if (error) emit('status', `No acknowledgement for ${event} in time.`);
              else {
                const reply = socketIOData(response);
                emit('message', reply.data, {
                  event: `${event} (ack)`,
                  ...(reply.binary ? { binary: true } : {}),
                });
              }
            });
        else socket.emit(event!, value);
        emit('sent', message, { event, binary });
      };
    } else if (input.protocol === 'mqtt') {
      const options = normalizedMQTT(input.mqtt) ?? defaultMQTT();
      const url = new URL(input.url);
      if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(url.protocol))
        throw new Error('Enter an mqtt://, mqtts://, ws://, or wss:// broker URL.');
      if (url.username || url.password)
        throw new Error('Set the username and password with Basic auth, not in the URL.');
      const overWebSocket = url.protocol === 'ws:' || url.protocol === 'wss:';
      const secure = url.protocol === 'mqtts:' || url.protocol === 'wss:';
      // Brokers read a username and password from the CONNECT packet, so Basic auth becomes those
      // fields rather than an Authorization header.
      const headers = { ...input.headers };
      let username: string | undefined;
      let password: string | undefined;
      const authorization = Object.keys(headers).find(
        (key) => key.toLowerCase() === 'authorization',
      );
      const basic = authorization ? /^Basic\s+(\S+)$/i.exec(headers[authorization]) : null;
      if (authorization && basic) {
        const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        username = colon < 0 ? decoded : decoded.slice(0, colon);
        password = colon < 0 ? undefined : decoded.slice(colon + 1);
        delete headers[authorization];
      } else if (authorization && !overWebSocket)
        throw new Error(
          'MQTT brokers take a username and password. Use Basic auth, or connect over ws:// or wss:// to send an Authorization header.',
        );
      if (signing && (!overWebSocket || signing.type === 'digest'))
        throw new Error(
          `${signingLabels[signing.type]} signs HTTP requests. Use Basic auth for MQTT${signing.type === 'digest' ? '' : ', or connect over ws:// or wss://'}.`,
        );
      const subscriptions = options.subscriptions.filter((row) => row.enabled && row.topic);
      for (const row of subscriptions) {
        const problem = mqttTopicProblem(row.topic, true);
        if (problem) throw new Error(problem);
      }
      if (Buffer.byteLength(options.clientId) > 256)
        throw new Error('Client IDs are limited to 256 bytes.');
      const clientId = options.clientId || `api-workbench-${randomUUID().slice(0, 8)}`;
      const tls = tlsFor(secure);
      const handshakeURL = new URL(url);
      handshakeURL.protocol = secure ? 'https:' : 'http:';
      const agent = overWebSocket ? upgradeAgent(url, secure, tls) : undefined;
      if (!overWebSocket && Object.keys(headers).length)
        emit('status', 'Headers are sent only over ws:// and wss://; this connection sends none.');
      if (!overWebSocket && proxyForURL(config, handshakeURL))
        emit('status', 'MQTT over TCP connects directly; the proxy applies to ws:// and wss://.');
      const client = mqtt.connect(url.toString(), {
        ...tls,
        protocolVersion: options.version,
        clientId,
        clean: options.cleanStart,
        keepalive: options.keepalive,
        username,
        password,
        reconnectPeriod: 0,
        connectTimeout: Math.min(input.timeoutMs, 30000),
        ...(options.version === 5 ? { properties: { maximumPacketSize: 2 * LIMIT } } : {}),
        ...(overWebSocket
          ? {
              wsOptions: {
                ...tls,
                agent,
                maxPayload: 2 * LIMIT,
                followRedirects: false,
                headers: signedHeaders(signing, 'GET', handshakeURL, headers),
              },
            }
          : {}),
      });
      let connected = false;
      cleanup = () => {
        client.removeAllListeners();
        client.on('error', () => {});
        client.end(true);
        agent?.destroy();
      };
      client.on('connect', (connack) => {
        connected = true;
        emit(
          'metadata',
          JSON.stringify({
            clientId,
            sessionPresent: connack.sessionPresent,
            ...(connack.properties ?? {}),
          }),
        );
        emit('open', `MQTT connected · ${clientId}`, { writable: true });
        if (!subscriptions.length) return;
        client.subscribe(
          Object.fromEntries(subscriptions.map((row) => [row.topic, { qos: row.qos }])),
          (error, granted) => {
            if (error) {
              emit('status', `Subscribe failed: ${error.message}`);
              return;
            }
            for (const grant of granted ?? [])
              emit(
                'status',
                grant.qos === 128 || grant.qos > 2
                  ? `Subscription refused: ${grant.topic}`
                  : `Subscribed to ${grant.topic} (QoS ${grant.qos})`,
              );
          },
        );
      });
      client.on('message', (topic, payload) => {
        const text = utf8(payload);
        emit('message', text ?? payload.toString('base64'), {
          event: topic,
          ...(text === undefined ? { binary: true } : {}),
        });
      });
      client.on('error', (error) => fail(`MQTT: ${error.message}`));
      client.on('disconnect', (packet) =>
        close(`Broker disconnected${packet.reasonCode ? `: reason ${packet.reasonCode}` : ''}`),
      );
      client.on('close', () =>
        connected ? close('MQTT connection closed') : fail('Could not connect to the broker.'),
      );
      session.send = (message, binary, sendOptions) => {
        if (stopped || !client.connected)
          throw new Error('Connect to the broker before publishing.');
        checkedMessage(message, binary);
        const { topic, qos, retain } = checkedSendOptions(
          'mqtt',
          sendOptions ?? { topic: options.topic, qos: options.qos, retain: options.retain },
        )!;
        client.publish(
          topic!,
          binary ? Buffer.from(message, 'base64') : message,
          { qos: qos ?? 0, retain: retain === true },
          (error) => {
            if (error) emit('status', `Publish to ${topic} failed: ${error.message}`);
          },
        );
        emit('sent', message, { event: topic, binary });
      };
    } else if (input.protocol === 'sse' || input.protocol === 'ndjson') {
      const url = new URL(input.url);
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('Enter an HTTP or HTTPS stream URL.');
      const transport = acquireHTTPTransport(
        { ...config, httpVersion: '1.1' },
        url,
        url.protocol === 'https:' ? clientCertificate : undefined,
      );
      const controller = new AbortController();
      cleanup = () => controller.abort();
      const protocol = input.protocol;
      const ndjson = new NDJSONParser((data) => emit('message', data));
      const sse = new SSEParser((event) =>
        emit('message', event.data, { event: event.event, eventId: event.eventId }),
      );
      void (async () => {
        const streamHeaders = signedHeaders(signing, 'GET', url, {
          Accept: protocol === 'sse' ? 'text/event-stream' : 'application/x-ndjson',
          ...input.headers,
        });
        const open = (headers: Record<string, string>) =>
          fetch(url, {
            headers,
            signal: controller.signal,
            redirect: 'error',
            dispatcher: transport.agent,
          });
        let response = await open(streamHeaders);
        const challenge =
          signing?.type === 'digest' && response.status === 401
            ? parseDigestChallenge(response.headers.get('www-authenticate'))
            : undefined;
        if (challenge && signing?.type === 'digest') {
          await response.body?.cancel();
          emit('status', 'Answering the Digest challenge…');
          response = await open({
            ...streamHeaders,
            authorization: digestAuthorization(
              signing,
              challenge,
              'GET',
              url.pathname + url.search,
            ),
          });
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        if (!response.body) throw new Error('No response stream.');
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (protocol === 'sse' && type !== 'text/event-stream')
          throw new Error('The server did not return text/event-stream.');
        if (
          protocol === 'ndjson' &&
          !['application/x-ndjson', 'application/ndjson', 'application/jsonl'].includes(type || '')
        )
          throw new Error('The server did not return an NDJSON content type.');
        emit('metadata', JSON.stringify(Object.fromEntries(response.headers)));
        emit('open', `${protocol.toUpperCase()} connected · HTTP ${response.status}`);
        const decoder = new TextDecoder();
        let bytes = 0;
        for await (const chunk of response.body) {
          if (stopped) break;
          if ((bytes += chunk.length) > 10 * LIMIT) throw new Error('Stream exceeded 10 MiB.');
          const text = decoder.decode(chunk, { stream: true });
          if (protocol === 'sse') sse.feed(text);
          else ndjson.feed(text);
        }
        const remaining = decoder.decode();
        if (protocol === 'sse') sse.feed(remaining);
        else ndjson.feed(remaining, true);
        close('Stream completed');
      })()
        .catch((error) => {
          if (!stopped) fail(error instanceof Error ? transportErrorMessage(error) : String(error));
        })
        .finally(() => transport.release());
    } else {
      if (!input.grpc) throw new Error('Import a .proto schema and select a method.');
      const url = new URL(`http://${input.url}`);
      if (url.host !== input.url || !url.port || url.username || url.password)
        throw new Error('Use a gRPC host:port destination, for example localhost:50051.');
      const selected = methods(input.grpc.proto).find(([path]) => path === input.grpc!.method);
      if (!selected) throw new Error('Select a method defined in the proto schema.');
      const [path, method] = selected;
      if (signing?.type === 'digest')
        throw new Error(
          'Digest auth needs an HTTP challenge, which gRPC does not send. Use another authentication type for gRPC.',
        );
      // gRPC calls are HTTP/2 POSTs to the method path; the protobuf body is not signed.
      const callURL = new URL(
        `${input.grpc.tls ? 'https' : 'http'}://${input.url}${input.grpc.method}`,
      );
      const metadata = new grpc.Metadata();
      for (const [key, value] of Object.entries(
        signedHeaders(signing, 'POST', callURL, input.headers, true),
      ))
        metadata.set(
          key.toLowerCase(),
          key.toLowerCase().endsWith('-bin') ? Buffer.from(value, 'base64') : value,
        );
      const proxy = proxyForURL(config, url);
      if (proxy?.protocol === 'https:')
        throw new Error(
          'gRPC currently supports HTTP CONNECT proxies. Use an http:// proxy URL or explicitly bypass this destination.',
        );
      const channelOptions: grpc.ChannelOptions = {
        'grpc.enable_http_proxy': 0,
        'grpc.use_local_subchannel_pool': 1,
        'grpc.max_receive_message_length': LIMIT,
        'grpc.max_send_message_length': LIMIT,
      };
      if (proxy) {
        channelOptions['grpc.http_connect_target'] = `dns:///${input.url}`;
        channelOptions['grpc.default_authority'] = input.url;
        channelOptions['grpc.ssl_target_name_override'] = url.hostname.replace(/^\[|\]$/g, '');
        if (config.proxyUsername || config.proxyPassword)
          channelOptions['grpc.http_connect_creds'] =
            `${config.proxyUsername}:${config.proxyPassword}`;
      }
      const target = proxy ? `${proxy.hostname}:${proxy.port || 80}` : input.url;
      // A secure context covers PEM and PFX client certificates alike; without one, keep grpc-js defaults.
      const credentials = !input.grpc.tls
        ? grpc.credentials.createInsecure()
        : clientCertificate
          ? grpc.credentials.createFromSecureContext(
              createSecureContext({
                ...(config.caCertificates ? { ca: config.caCertificates } : {}),
                ...certificateOptions,
              }),
              { rejectUnauthorized: config.verifyTLS },
            )
          : grpc.credentials.createSsl(
              config.caCertificates ? Buffer.from(config.caCertificates) : undefined,
            );
      const client = new grpc.Client(target, credentials, channelOptions);
      let call:
        | grpc.ClientUnaryCall
        | grpc.ClientReadableStream<object>
        | grpc.ClientWritableStream<object>
        | grpc.ClientDuplexStream<object, object>;
      let ended = false;
      cleanup = () => {
        call?.cancel();
        client.close();
      };
      const options = { deadline: Date.now() + input.timeoutMs };
      const reply = (error: grpc.ServiceError | null, value?: object) => {
        if (error) {
          fail(`${grpc.status[error.code]}: ${error.details}`);
          return;
        }
        if (value !== undefined) emit('message', JSON.stringify(value, null, 2));
      };
      const parseMessage = (message: string) => {
        if (Buffer.byteLength(message) > LIMIT) throw new Error('Messages are limited to 1 MiB.');
        const value: unknown = JSON.parse(message || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Enter a JSON object for the gRPC message.');
        return value;
      };
      const initial = parseMessage(input.body);
      if (method.requestStream && method.responseStream)
        call = client.makeBidiStreamRequest(
          path,
          method.requestSerialize,
          method.responseDeserialize,
          metadata,
          options,
        );
      else if (method.requestStream)
        call = client.makeClientStreamRequest(
          path,
          method.requestSerialize,
          method.responseDeserialize,
          metadata,
          options,
          reply,
        );
      else if (method.responseStream)
        call = client.makeServerStreamRequest(
          path,
          method.requestSerialize,
          method.responseDeserialize,
          initial,
          metadata,
          options,
        );
      else
        call = client.makeUnaryRequest(
          path,
          method.requestSerialize,
          method.responseDeserialize,
          initial,
          metadata,
          options,
          reply,
        );
      if (!method.requestStream) emit('sent', JSON.stringify(initial, null, 2));
      call.on('metadata', (value: grpc.Metadata) => {
        emit('metadata', JSON.stringify(value.getMap()));
        emit('open', 'gRPC connected', { writable: method.requestStream });
      });
      call.on('status', (value: grpc.StatusObject) => {
        emit(
          'status',
          `${grpc.status[value.code]} (${value.code})${value.details ? ` · ${value.details}` : ''}`,
        );
        if (value.code !== grpc.status.OK && !stopped)
          fail(`${grpc.status[value.code]}: ${value.details}`);
        else close('gRPC call completed');
      });
      (call as EventEmitter).on('error', (error: grpc.ServiceError) =>
        fail(`${grpc.status[error.code]}: ${error.details}`),
      );
      if (method.responseStream)
        (call as grpc.ClientReadableStream<object>).on('data', (value: object) =>
          emit('message', JSON.stringify(value, null, 2)),
        );
      if (method.requestStream) {
        const writable = call as grpc.ClientWritableStream<object>;
        session.send = (message, binary) => {
          if (stopped || ended) throw new Error('The gRPC send stream is closed.');
          if (binary) throw new Error('gRPC messages use JSON.');
          const value = parseMessage(message);
          writable.write(value);
          emit('sent', JSON.stringify(value, null, 2));
        };
        session.finish = () => {
          if (stopped || ended) throw new Error('The gRPC send stream is closed.');
          ended = true;
          writable.end();
          emit('status', 'Finished sending; waiting for the server.');
        };
        session.send(input.body, false);
        emit('open', 'gRPC stream ready', { writable: true });
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return session;
}
