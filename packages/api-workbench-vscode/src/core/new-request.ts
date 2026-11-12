import { METHODS } from './editing';
import { GRAPHQL_STARTER } from './graphql';

/**
 * The New Request form: the kinds of request, each described for choosing among them, and the
 * checks on what the form posts back before `request create` gets it. No VS Code API, so the
 * webview shares the descriptions and the URL hints.
 */

export interface RequestType {
  protocol: string;
  label: string;
  /** The short badge, as the explorer shows it. */
  badge: string;
  /** One line: what it is. */
  summary: string;
  /** When to choose it. */
  useFor: string;
  /** What VS Code does with it once made. */
  inVsCode: string;
  placeholder: string;
  /** The URL schemes it connects with; a gRPC address has none (`host:port`). */
  schemes: readonly string[];
}

export const REQUEST_TYPES: readonly RequestType[] = [
  {
    protocol: 'http',
    label: 'HTTP',
    badge: 'GET',
    summary: 'One request, one response: REST, GraphQL over HTTP, webhooks, and files.',
    useFor: 'Most APIs. Choose a method, add params, headers, a body, auth, and tests.',
    inVsCode:
      'Opens in the request editor: send it, see the response, and run its tests in the Testing view and the runner.',
    placeholder: 'https://api.example.com/v1/orders or {{baseUrl}}/orders',
    schemes: ['http', 'https'],
  },
  {
    // Not a protocol of its own: a POST with a JSON body of the query and its variables, as the
    // app and GraphQL servers have it. The request editor shows that body as a query.
    protocol: 'graphql',
    label: 'GraphQL',
    badge: 'GQL',
    summary: 'A query or mutation, with its variables, sent to one GraphQL endpoint.',
    useFor: 'GraphQL APIs, such as GitHub’s, Shopify’s, or your own Apollo or Hasura server.',
    inVsCode:
      'Opens in the request editor with a Query and a Variables editor; GraphQL errors in a 200 response are pointed out.',
    placeholder: 'https://api.example.com/graphql',
    schemes: ['http', 'https'],
  },
  {
    protocol: 'websocket',
    label: 'WebSocket',
    badge: 'WS',
    summary: 'A two-way connection: send messages and see each one the server sends back.',
    useFor: 'Chat, live updates, and anything that talks both ways over one connection.',
    inVsCode: 'Opens in the live editor: connect, send text or JSON messages, and watch the log.',
    placeholder: 'wss://echo.example.com/socket',
    schemes: ['ws', 'wss'],
  },
  {
    protocol: 'sse',
    label: 'Server-sent events',
    badge: 'SSE',
    summary: 'A stream of events the server pushes over HTTP, one after another.',
    useFor: 'Notifications, progress, and streamed AI responses (text/event-stream).',
    inVsCode: 'Opens in the live editor: connect and see each event, with its name and id.',
    placeholder: 'https://api.example.com/events',
    schemes: ['http', 'https'],
  },
  {
    protocol: 'ndjson',
    label: 'NDJSON stream',
    badge: 'NDJSON',
    summary: 'Newline-delimited JSON over HTTP: one JSON value per line, as it arrives.',
    useFor: 'Log tails, exports, and streaming APIs that send JSON lines.',
    inVsCode: 'Opens in the live editor: connect and see each line as it is received.',
    placeholder: 'https://api.example.com/stream',
    schemes: ['http', 'https'],
  },
  {
    protocol: 'grpc',
    label: 'gRPC',
    badge: 'gRPC',
    summary: 'Calls a gRPC service from its .proto schema: unary and streaming methods.',
    useFor: 'Services between backends, typed by Protocol Buffers.',
    inVsCode:
      'Opens in the live editor: paste the .proto schema, choose the method, then call it and stream messages.',
    placeholder: 'localhost:50051 or api.example.com:443',
    schemes: [],
  },
  {
    protocol: 'socketio',
    label: 'Socket.IO',
    badge: 'SIO',
    summary: 'Emits Socket.IO events and shows what the server emits, with acknowledgements.',
    useFor: 'Servers built on Socket.IO, with its events, namespaces, and rooms.',
    inVsCode:
      'Opens in the live editor: choose the event to emit, ask for acknowledgements, and watch every event.',
    placeholder: 'https://chat.example.com/ or https://chat.example.com/admin',
    schemes: ['http', 'https', 'ws', 'wss'],
  },
  {
    protocol: 'mqtt',
    label: 'MQTT',
    badge: 'MQTT',
    summary: 'Publishes to and subscribes to topics on an MQTT broker.',
    useFor: 'Devices, sensors, and message brokers such as Mosquitto, EMQX, or HiveMQ.',
    inVsCode:
      'Opens in the live editor: set subscriptions, publish with QoS and retain, and watch the messages.',
    placeholder: 'mqtt://broker.example.com:1883',
    schemes: ['mqtt', 'mqtts', 'ws', 'wss'],
  },
];

const typeOf = (protocol: string) => REQUEST_TYPES.find((type) => type.protocol === protocol);

/**
 * What is likely wrong with a URL for a kind of request, or nothing. Only a hint: a URL that starts
 * with a `{{variable}}` is not checked, since the variable may hold the scheme.
 */
export function urlHint(protocol: string, url: string): string | undefined {
  const type = typeOf(protocol);
  const text = url.trim();
  if (!type || !text || text.startsWith('{{')) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (!type.schemes.length)
    return scheme
      ? `A gRPC address is host:port, without ${scheme}://; turn on TLS in its settings instead.`
      : /:\d+$/.test(text.split('/')[0])
        ? undefined
        : 'A gRPC address needs its port, such as localhost:50051.';
  if (!scheme) return `Start it with ${type.schemes.map((name) => `${name}://`).join(' or ')}.`;
  if (!type.schemes.includes(scheme))
    return `${type.label} URLs start with ${type.schemes.map((name) => `${name}://`).join(' or ')}, not ${scheme}://.`;
  return undefined;
}

/** A workspace to add the request to, with the collections and folders it has. */
export interface NewRequestTarget {
  key: string;
  label: string;
  /** Team folder or the app's. */
  kind: 'team' | 'app';
  folders: string[];
}

export interface NewRequestView {
  view: 'newRequest';
  targets: NewRequestTarget[];
  /** Chosen when the form opened, from where it was asked for. */
  workspace?: string;
  folder?: string;
  protocol?: string;
  creating: boolean;
  error?: string;
}

export interface NewRequestInput {
  workspace: string;
  protocol: string;
  folder: string;
  name: string;
  method: string;
  url: string;
  tags: string[];
}

/** Every folder path of a workspace's requests, collections first, in the explorer's order. */
export function folderChoices(collections: string[], requestFolders: string[]): string[] {
  const all: string[] = [];
  const add = (path: string) => {
    if (path && !all.includes(path)) all.push(path);
  };
  for (const collection of collections) add(collection);
  for (const folder of requestFolders) {
    const parts = folder.split('/');
    for (let at = 1; at <= parts.length; at++) add(parts.slice(0, at).join('/'));
  }
  const order = (path: string) => collections.indexOf(path.split('/')[0]);
  return all.sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** What the form posted, checked, or a reason it cannot be made. */
export function newRequestFrom(
  value: unknown,
  targets: readonly NewRequestTarget[],
): NewRequestInput | string {
  if (!value || typeof value !== 'object') return 'The form could not be read.';
  const given = value as Record<string, unknown>;
  const text = (key: string, max: number) =>
    typeof given[key] === 'string' && (given[key] as string).length <= max
      ? (given[key] as string).trim()
      : undefined;
  const workspace = text('workspace', 4096);
  if (!workspace || !targets.some((target) => target.key === workspace))
    return 'Choose a workspace.';
  const protocol = text('protocol', 20);
  if (!protocol || !typeOf(protocol)) return 'Choose the kind of request.';
  const folder = text('folder', 1000)
    ?.split('/')
    .map((part) => part.trim())
    .join('/');
  if (!folder) return 'Choose a collection, or name a new one.';
  if (folder.split('/').some((part) => !part)) return 'A folder path has no empty parts.';
  const name = text('name', 200);
  if (!name) return 'Give the request a name.';
  if (/[\r\n]/.test(name)) return 'A name is one line.';
  const method =
    protocol === 'http'
      ? (text('method', 20)?.toUpperCase() ?? 'GET')
      : protocol === 'graphql'
        ? 'POST'
        : 'GET';
  if (!(METHODS as readonly string[]).includes(method)) return 'Choose an HTTP method.';
  const url = text('url', 64 * 1024);
  if (!url) return 'Give its URL.';
  if (/[\r\n]/.test(url)) return 'A URL is one line.';
  const tags: string[] = [];
  const tagText = text('tags', 2000) ?? '';
  for (const tag of tagText.split(/[\s,]+/).map((item) => item.replace(/^#/, ''))) {
    if (!tag) continue;
    if (!/^[\w.-]{1,50}$/.test(tag)) return `“${tag}” is not a tag: letters, digits, - . and _.`;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return { workspace, protocol, folder, name, method, url, tags };
}

/** `request create` arguments for a checked form; every value is `--option=value`. */
export function newRequestArgs(input: NewRequestInput): string[] {
  return [
    // A name starting with a dash stays a name.
    input.name.replace(/^-+/, '').trim() || 'New request',
    `--collection=${input.folder}`,
    `--url=${input.url}`,
    ...(input.protocol === 'graphql'
      ? [
          '--protocol=http',
          '--method=POST',
          '--header=Content-Type: application/json',
          `--body=${GRAPHQL_STARTER.body}`,
        ]
      : [`--protocol=${input.protocol}`]),
    ...(input.protocol === 'http' ? [`--method=${input.method}`] : []),
    ...input.tags.map((tag) => `--tag=${tag}`),
  ];
}
