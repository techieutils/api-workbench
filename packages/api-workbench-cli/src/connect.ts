import { randomBytes } from 'node:crypto';
import * as http from '@techieutils/api-workbench-common/http-settings';
import {
  applyAuth,
  effectiveAuth,
  effectiveHTTPSettings,
  requestQueryURL,
} from '@techieutils/api-workbench-common/request-payload';
import { dynamicValue } from '@techieutils/api-workbench-common/variables';
import type {
  ProtocolEvent,
  ProtocolPayload,
  ProtocolSendOptions,
} from '@techieutils/api-workbench-common/types';
import { startProtocol } from '@techieutils/api-workbench-electron/protocols';
import { authorizeProtocol } from '@techieutils/api-workbench-electron/protocol-auth';
import { openVault, terminalPassword } from './vault';
import {
  checkedSendOptions,
  defaultMQTT,
  defaultSocketIO,
  normalizedMQTT,
  normalizedSocketIO,
} from '@techieutils/api-workbench-common/protocol-config';
import { UsageError, allowedHost, hostAllowed, hostNotAllowed } from './args';
import {
  findRequest,
  one,
  positionals,
  printable,
  protocolOf,
  variableAssignment,
  type CommandContext,
  type Parsed,
} from './command-kit';
import { chooseEnvironment } from './run';
import { sourceFromTarget } from './source';
import type { RequestTarget } from './target';

/**
 * `request connect`: opens a live request — WebSocket, gRPC, SSE, NDJSON, Socket.IO, or MQTT — as the app's
 * Connect does, with the same connection code, and keeps it open. Each event (open, a message
 * received or sent, metadata, status, an error, closed) is printed as it happens; messages to
 * send are read from standard input, one per line, until the connection closes or Ctrl+C.
 *
 * With --json, events are JSON lines and so is the input: {"action":"send","message":"…",
 * "binary":false}, {"action":"finish"} to end a gRPC client stream, or {"action":"stop"}. Without
 * it, each line typed is sent as a text message. A saved credential is read from the app's vault
 * when it has a password (API_WORKBENCH_VAULT_PASSWORD); one the system's store encrypts opens only
 * in the app.
 */

const PROTOCOLS = ['websocket', 'grpc', 'sse', 'ndjson', 'socketio', 'mqtt'] as const;

export async function connectRequest(
  parsed: Parsed,
  target: RequestTarget & { dataDir?: string },
  context: CommandContext,
): Promise<number> {
  const { output } = context;
  const [wanted] = positionals(parsed, ['request']);
  const request = findRequest(target.state, wanted);
  const protocol = protocolOf(request);
  if (!(PROTOCOLS as readonly string[]).includes(protocol))
    throw new UsageError(
      protocol === 'http'
        ? `${request.name} is an HTTP request: send it with request send.`
        : `${request.name} uses ${protocol}, which connects from the app.`,
    );
  const source = sourceFromTarget(target);
  const environment = chooseEnvironment(source, {
    environment: one(parsed, '--environment'),
    variables: (parsed.values.get('--var') ?? []).map((text) =>
      variableAssignment(text, context.env),
    ),
  });
  const resolve = (value: string) =>
    String(value ?? '').replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
      const name = key.trim();
      return (
        environment?.variables.find((variable) => variable.enabled && variable.key === name)
          ?.value ??
        dynamicValue(name) ??
        match
      );
    });
  const workspace = source.workspace;
  const auth = effectiveAuth(workspace, request);
  const credentialId = auth.auth === 'Saved credential' ? auth.credentialId : undefined;
  if (auth.auth === 'Saved credential' && !credentialId)
    throw new UsageError(`Choose the saved credential ${request.name} uses, in its Auth.`);
  let applied: ReturnType<typeof applyAuth>;
  try {
    applied = applyAuth(auth, resolve);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (applied.query.length && protocol === 'grpc')
    throw new UsageError('gRPC has no query string. Send the API key as a header (metadata).');
  if (applied.query.length && protocol === 'mqtt')
    throw new UsageError('MQTT brokers take a username and password. Use Basic auth.');
  const headers: Record<string, string> = Object.fromEntries(
    request.headers
      .filter((row) => row.enabled && row.key)
      .map((row) => [resolve(row.key), resolve(row.value)]),
  );
  for (const [key, value] of Object.entries(applied.headers))
    headers[key.toLowerCase() === 'authorization' ? 'authorization' : key] = value;
  let url = resolve(requestQueryURL(request));
  if (applied.query.length) {
    try {
      const withQuery = new URL(url);
      for (const [key, value] of applied.query) withQuery.searchParams.set(key, value);
      url = withQuery.toString();
    } catch {
      throw new UsageError(`“${printable(url)}” is not a URL.`);
    }
  }
  const given = one(parsed, '--timeout');
  const timeoutMs =
    given === undefined ? (request.httpSettings?.timeoutMs ?? 300_000) : Number(given);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000)
    throw new UsageError('--timeout is from 100 to 3600000 milliseconds.');
  if (protocol === 'grpc' && !request.grpc?.proto?.trim())
    throw new UsageError(`${request.name} has no .proto schema: add one in the app.`);
  const transport = Object.fromEntries(
    Object.entries(request.httpSettings ?? {}).filter(([key]) => key !== 'timeoutMs'),
  );
  const payload: ProtocolPayload = {
    sessionId: randomBytes(8).toString('hex'),
    protocol: protocol as ProtocolPayload['protocol'],
    url,
    headers,
    body: resolve(request.body),
    timeoutMs: Math.min(timeoutMs, 3_600_000),
    httpSettings: http.inherit(effectiveHTTPSettings(workspace, request), transport),
    ...(applied.signing ? { signing: applied.signing } : {}),
    ...(request.grpc ? { grpc: { ...request.grpc, method: resolve(request.grpc.method) } } : {}),
    ...(protocol === 'socketio' ? { socketio: socketIO(request.socketio, resolve) } : {}),
    ...(protocol === 'mqtt' ? { mqtt: mqttSettings(request.mqtt, resolve) } : {}),
  };

  // Where it connects once variables are filled in, so a variable cannot take it somewhere
  // --allow-host does not name. Not connected: a usage matter (exit 2), as for request send.
  const allowed = parsed.values.get('--allow-host')?.map(allowedHost);
  if (allowed && !hostAllowed(url, allowed)) throw new UsageError(hostNotAllowed(url));

  // A saved credential is read from the vault (its password from API_WORKBENCH_VAULT_PASSWORD)
  // and applied as the app applies it, only to the origin it is for.
  const authorized = credentialId
    ? await withCredential(target, context, { ...payload, credentialId })
    : payload;

  const json = parsed.flags.has('--json');
  let failed = false;
  let done: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (done = resolve));
  const print = (event: ProtocolEvent) => {
    if (event.type === 'error') failed = true;
    if (json) {
      const { sessionId: _id, ...shown } = event;
      output.out(JSON.stringify(shown));
    } else {
      const mark: Record<ProtocolEvent['type'], string> = {
        connecting: '…',
        open: '●',
        message: '←',
        sent: '→',
        metadata: '#',
        status: '=',
        error: '!',
        closed: '○',
      };
      const text = event.binary
        ? `(${Buffer.from(event.data, 'base64').length} bytes)`
        : event.data;
      const line = `${mark[event.type]} ${event.event ? `${event.event}: ` : ''}${printable(text)}`;
      if (event.type === 'error') output.err(line);
      else output.out(line);
    }
    if (event.type === 'closed') done();
  };
  let session;
  try {
    session = startProtocol(authorized, print);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const stop = () => session.stop();
  context.interrupt?.addEventListener('abort', stop, { once: true });

  // Messages to send, one per line, until the connection closes.
  const reading = (async () => {
    if (!context.lines) return;
    for await (const line of context.lines) {
      if (!line.trim()) continue;
      try {
        if (!json) {
          session.send(line, false);
          continue;
        }
        const input = JSON.parse(line) as {
          action?: string;
          message?: unknown;
          binary?: unknown;
          options?: ProtocolSendOptions;
        };
        if (input.action === 'stop') return stop();
        if (input.action === 'finish') session.finish();
        else if (input.action === 'send' && typeof input.message === 'string')
          // A Socket.IO event, or an MQTT topic, QoS, and retain flag, checked as the app does.
          session.send(
            input.message,
            input.binary === true,
            checkedSendOptions(protocol, input.options),
          );
        else throw new Error('Each line is {"action":"send","message":"…"}, finish, or stop.');
      } catch (error) {
        // A line that cannot be sent is reported, and the connection stays open.
        const text = `Not sent: ${(error as Error).message}`;
        if (json)
          output.out(JSON.stringify({ type: 'error', at: Date.now(), data: text, input: true }));
        else output.err(`! ${text}`);
      }
    }
  })();
  await closed;
  context.interrupt?.removeEventListener('abort', stop);
  void reading;
  return failed ? 1 : 0;
}

/** A request's Socket.IO settings, or the defaults, with its path's variables resolved. */
function socketIO(saved: unknown, resolve: (value: string) => string) {
  const config = normalizedSocketIO(saved) ?? defaultSocketIO();
  return { ...config, path: resolve(config.path) };
}

/** A request's MQTT settings, or the defaults, with its client id and topics resolved. */
function mqttSettings(saved: unknown, resolve: (value: string) => string) {
  const config = normalizedMQTT(saved) ?? defaultMQTT();
  return {
    ...config,
    clientId: resolve(config.clientId),
    topic: resolve(config.topic),
    subscriptions: config.subscriptions.map((row) => ({ ...row, topic: resolve(row.topic) })),
  };
}

/** The payload with a saved credential's headers or signing applied, from the opened vault. */
async function withCredential(
  target: RequestTarget & { dataDir?: string },
  context: CommandContext,
  payload: ProtocolPayload,
): Promise<ProtocolPayload> {
  const dataDir = target.vaultDir ?? target.dataDir;
  if (!dataDir)
    throw new UsageError(
      'A collection file keeps no credentials. Use one of the app’s workspaces.',
    );
  const { vault, close } = await openVault(
    target.vaultPath,
    dataDir,
    context.password ?? terminalPassword(context.env),
  );
  try {
    return await authorizeProtocol(
      payload,
      {
        unlocked: true,
        get: (id) => vault.get(id),
        resolve: async (record) => {
          // AWS, Google Cloud, and other external secrets are fetched by the app.
          if (record.external)
            throw new UsageError(
              'This credential’s secret is kept by an external provider, which the app reads. Connect from the app.',
            );
          return record;
        },
      },
      new AbortController().signal,
    );
  } catch (error) {
    throw error instanceof UsageError ? error : new UsageError((error as Error).message);
  } finally {
    close();
  }
}
