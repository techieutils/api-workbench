import { certificateView, timingView, type CertificateView, type TimingView } from './network';
import { OPTION_FIELDS } from './auth';
import type { SchemaState } from './graphql-schema';
import type { MockDraft, MockSettings } from './mock-edit';
import {
  cookiesHidden,
  performanceRows,
  responseCookies,
  timeline,
  type ConsoleEntry,
  type PerformanceRow,
  type RequestDraft,
  type ResponseCookie,
} from './editing';
import { formatBody } from './response';
import { formatBytes, type SendResult } from './report';

/**
 * What the extension's webviews show, built from the command line's JSON: the request editor, a
 * response, a running mock server, and the network log. The webview script (`src/webview/`) only
 * renders these as text; nothing in them is ever run or parsed as HTML.
 */

/** `request show --json`. */
export interface RequestDetails {
  id: string;
  name: string;
  folder: string;
  method: string;
  protocol: string;
  url: string;
  auth: string;
  tags: string[];
  inheritedTags?: { tag: string; from: string }[];
  headers: { key: string; value: string; enabled: boolean }[];
  body?: string;
  /** The body itself, and how it is sent: `raw` and `none` can be edited here. */
  bodyText?: string;
  bodyType?: string;
  /** Auth without its secrets: whether there is a token or password, never its value. */
  authDetails?: {
    type: string;
    username: string;
    hasSecret: boolean;
    apiKeyIn: 'header' | 'query';
    credentialId?: string;
    /** Settings of the other auth types (regions, URLs, algorithms), never their secrets. */
    options?: Record<string, string | boolean>;
    /** Which secrets are saved (`password`, `token`, `awsSessionToken`, …), never their values. */
    saved?: string[];
    /** When an OAuth 2.0 access token expires, in epoch milliseconds. */
    expiresAt?: number;
  };
  /** A gRPC call's method and whether it uses TLS. */
  grpc?: {
    method: string;
    tls: boolean;
    proto?: string;
    methods?: { path: string; requestStream: boolean; responseStream: boolean }[];
  };
  /** A Socket.IO connection's path, event, and acknowledgement; an MQTT connection's settings. */
  socketio?: unknown;
  mqtt?: unknown;
  /** Its pre-request and post-response scripts, empty when it has none. */
  scripts?: { pre: string; post: string };
  /** A form body's fields; a secret-looking value is `<hidden>`, and a file's value empty. */
  formFields?: { key: string; value: string; enabled: boolean; kind: string; fileName?: string }[];
  /** The name of the file a file body sends. */
  binaryName?: string;
  tests: string[];
  captures: { variable: string; from: string; enabled: boolean }[];
}

export interface ResponseView {
  title: string;
  method: string;
  url: string;
  ok: boolean;
  /** `200 OK`, or `No response`. */
  status: string;
  timing: string[];
  error?: string;
  headers: { key: string; value: string }[];
  contentType: string;
  body: string;
  /** JSON bodies are shown with their keys and values told apart. */
  json: boolean;
  tests: { label: string; pass: boolean; message: string }[];
  captures: { name: string; ok: boolean; message: string }[];
  /** `2/2 passed`, when there are tests. */
  testSummary?: string;
  /** The body as it came, for Raw; `body` is formatted. */
  rawBody: string;
  cookies: ResponseCookie[];
  /** It set cookies, whose values stay out of VS Code (the Cookies view lists their names). */
  cookiesHidden: boolean;
  timeline: { label: string; value: string }[];
  /** The Timing tab: each hop's DNS, connecting, TLS, waiting, and downloading. */
  network?: TimingView;
  /** The Certificate tab: the server's TLS connection and certificate chain. */
  certificate?: CertificateView;
  /** Values captured for the requests after it in a `.http` file; secret-looking ones hidden. */
  captured: { name: string; value: string }[];
}

export interface RequestView {
  view: 'request';
  /** Changes on each save, so the editor drops its edits for what was saved. */
  revision: number;
  /** A saved request, edited and saved here; a `.http` file's, shown to send or save. */
  kind: 'saved' | 'file';
  /** The request as saved, which the editor starts from. */
  saved: RequestDraft;
  /** Whether its body is text that can be edited here (raw or none), not a form or file. */
  bodyEditable: boolean;
  /** Tags the request has through its collection or folders, as `#smoke (from Users)`. */
  inheritedTags: string[];
  /** A form's file fields, chosen in the app: `avatar (photo.png)`. */
  files: string[];
  /**
   * Files chosen in VS Code this session, by name: a file body's, and form fields' by field name.
   * Their paths stay with the extension, which gives them to the command line with each send.
   */
  uploads?: { binary?: string; fields: Record<string, string> };
  /** Its scripts, edited in VS Code's own editors (`apiworkbench-script:` documents). */
  scripts: { pre: string; post: string };
  /** Whether the request has a saved token or password, which is never shown here. */
  hasSecret: boolean;
  /** Which of its auth's secrets are saved, by field, and when an OAuth 2.0 token expires. */
  savedSecrets?: string[];
  tokenExpiresAt?: number;
  /** A GraphQL request's schema, once fetched, for the Query's suggestions. */
  graphqlSchema?: SchemaState;
  /** Saved credentials to choose from, when the vault could be read. */
  credentials?: { id: string; label: string }[];
  saving: boolean;
  /** The collection, its folders, then the request's name. */
  breadcrumb: string[];
  name: string;
  method: string;
  protocol: string;
  url: string;
  environment?: string;
  sendable: boolean;
  /** Whether the request has a YAML file to open (team folders). */
  hasFile: boolean;
  params: { key: string; value: string }[];
  headers: { key: string; value: string; enabled: boolean }[];
  auth: string;
  body?: string;
  tests: string[];
  captures: { variable: string; from: string; enabled: boolean }[];
  tags: string[];
  sending: boolean;
  response?: ResponseView;
  error?: string;
}

/** The query parameters of a URL as written, `{{variables}}` and all. */
export function queryParams(url: string): { key: string; value: string }[] {
  const query = url.split('#')[0].split('?').slice(1).join('?');
  if (!query) return [];
  return query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      const [key, value] = at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
      const decode = (text: string) => {
        try {
          return decodeURIComponent(text.replace(/\+/g, ' '));
        } catch {
          return text;
        }
      };
      return { key: decode(key), value: decode(value) };
    });
}

export function requestView(
  details: RequestDetails,
  options: {
    environment?: string;
    hasFile: boolean;
    response?: ResponseView;
    sending?: boolean;
    revision?: number;
    kind?: RequestView['kind'];
  },
): RequestView {
  const bodyType = details.bodyType ?? (details.bodyText ? 'raw' : 'none');
  return {
    view: 'request',
    revision: options.revision ?? 0,
    kind: options.kind ?? 'saved',
    saved: {
      method: details.method,
      url: details.url,
      headers: details.headers.map(({ key, value, enabled }) => ({ key, value, enabled })),
      body: details.bodyText ?? '',
      tests: details.tests.join('\n'),
      tags: [...details.tags],
      captures: details.captures.map((capture) => ({
        key: capture.variable,
        value: capture.from,
      })),
      bodyType,
      form: (details.formFields ?? []).map(({ key, value, enabled, kind, fileName }) =>
        kind === 'file'
          ? { key, value: '', enabled, kind: 'file' as const, ...(fileName ? { fileName } : {}) }
          : { key, value, enabled },
      ),
      ...(details.binaryName ? { binaryName: details.binaryName } : {}),
      auth: {
        type: details.authDetails?.type ?? details.auth,
        username: details.authDetails?.username ?? '',
        secret: '',
        apiKeyIn: details.authDetails?.apiKeyIn ?? 'header',
        credentialId: details.authDetails?.credentialId ?? '',
        // Only the forms' settings: the editor posts them back, and nothing else is accepted.
        options: Object.fromEntries(
          Object.entries(details.authDetails?.options ?? {}).filter(([key]) =>
            OPTION_FIELDS.has(key),
          ),
        ),
        secrets: {},
      },
    },
    files: (details.formFields ?? [])
      .filter((field) => field.kind === 'file')
      .map((field) => `${field.key}${field.fileName ? ` (${field.fileName})` : ''}`),
    hasSecret: details.authDetails?.hasSecret ?? false,
    savedSecrets: details.authDetails?.saved ?? [],
    tokenExpiresAt: details.authDetails?.expiresAt,
    scripts: details.scripts ?? { pre: '', post: '' },
    inheritedTags: (details.inheritedTags ?? []).map(({ tag, from }) => `#${tag} (from ${from})`),
    bodyEditable: true,
    saving: false,
    breadcrumb: [...details.folder.split('/').filter(Boolean), details.name],
    name: details.name,
    method: details.method,
    protocol: details.protocol,
    url: details.url,
    environment: options.environment,
    sendable: details.protocol === 'http',
    hasFile: options.hasFile,
    params: queryParams(details.url),
    headers: details.headers,
    auth: details.auth,
    body: details.body,
    tests: details.tests,
    captures: details.captures,
    tags: [...details.tags, ...(details.inheritedTags ?? []).map(({ tag }) => tag)],
    sending: options.sending ?? false,
    response: options.response,
  };
}

const header = (headers: Record<string, string> | undefined, name: string) =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1] ?? '';

/** Names whose values are kept off screen: electron `team-files.ts` `SECRET_NAME`, as the CLI hides them. */
const SECRET_LOOKING =
  /authorization|cookie|secret|token|password|passwd|api[-_]?key|credential|private[-_]?key|session/i;

export function responseView(
  result: SendResult,
  method = result.request.method,
  startedAt = Date.now() - (result.durationMs ?? 0),
): ResponseView {
  const contentType = header(result.headers, 'content-type');
  const body = result.body ? formatBody(result.body, contentType) : '';
  let json = false;
  if (body && (/json/i.test(contentType) || /^\s*[[{]/.test(body)))
    try {
      JSON.parse(body);
      json = true;
    } catch {
      json = false;
    }
  const passed = result.tests.filter((test) => test.pass).length;
  return {
    title: result.request.name,
    method,
    url: result.url ?? '',
    ok: !result.error && (result.status ?? 0) < 400,
    status: result.error
      ? 'No response'
      : `${result.status ?? ''} ${result.statusText ?? ''}`.trim(),
    timing: [
      result.durationMs === undefined ? '' : `${Math.round(result.durationMs)} ms`,
      result.size === undefined ? '' : formatBytes(result.size),
      result.httpVersion && !result.error ? `HTTP/${result.httpVersion}` : '',
    ].filter(Boolean),
    ...(result.error ? { error: result.error } : {}),
    headers: Object.entries(result.headers ?? {}).map(([key, value]) => ({ key, value })),
    contentType,
    body,
    json,
    tests: result.tests.map((test) => ({
      label: test.label,
      pass: test.pass,
      message: test.message,
    })),
    captures: result.captures.map((capture) => ({
      name: capture.variable ?? capture.name ?? '',
      ok: !capture.error,
      message: capture.error ?? 'captured',
    })),
    ...(result.tests.length ? { testSummary: `${passed}/${result.tests.length} passed` } : {}),
    rawBody: result.body ?? '',
    cookies: responseCookies(result.headers),
    cookiesHidden: cookiesHidden(result.headers),
    timeline: timeline(result, startedAt),
    ...(timingView(result.timings) ? { network: timingView(result.timings) } : {}),
    ...(certificateView(result.tls) ? { certificate: certificateView(result.tls) } : {}),
    captured: result.captures
      .filter((capture) => !capture.error && capture.value !== undefined)
      .map((capture) => {
        const name = capture.variable ?? capture.name ?? '';
        return { name, value: SECRET_LOOKING.test(name) ? 'hidden' : String(capture.value) };
      }),
  };
}

/** A piece of a JSON body, so keys, strings, numbers, and literals can be told apart. */
export interface JsonToken {
  text: string;
  kind: 'key' | 'string' | 'number' | 'literal' | 'punctuation';
}

/** Splits indented JSON text into tokens; the text joined back is exactly the input. */
export function jsonTokens(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const pattern =
    /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) tokens.push({ text: text.slice(last, at), kind: 'punctuation' });
    if (match[1]) {
      tokens.push({ text: match[1], kind: match[2] ? 'key' : 'string' });
      if (match[2]) tokens.push({ text: match[2], kind: 'punctuation' });
    } else if (match[3]) tokens.push({ text: match[3], kind: 'number' });
    else tokens.push({ text: match[4], kind: 'literal' });
    last = at + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), kind: 'punctuation' });
  return tokens;
}

/** `mock list --json`. */
export interface ListedMock {
  id: string;
  name: string;
  port: number;
  routes: number;
  https: boolean;
}

export interface MockLogEntry {
  time: string;
  method: string;
  path: string;
  status: string;
}

/** `mock show --json`: what a mock server answers, without bodies or header values. */
export interface MockDetails {
  id: string;
  name: string;
  port: number;
  https: boolean;
  cors: boolean;
  corsOrigins: string;
  defaultHeaders: number;
  source?: { kind: string; name: string };
  /** Everything `mock update` changes, from `mock show --json`. */
  settings?: MockSettings;
  /** For a mock made from a collection: how far the two are from each other. */
  collectionSync?: { collection: string; missingRoutes: number; missingRequests: number };
  routes: {
    id?: string;
    enabled: boolean;
    kind: string;
    method: string;
    path: string;
    status: number;
    name: string;
    delayMs: number;
    rules: number;
    responses: number;
    validates: boolean;
    /** Its response headers (secret-looking values `<hidden>`) and body, for the route editor. */
    headers?: { key: string; value: string; enabled: boolean }[];
    body?: string;
  }[];
}

export interface MockView {
  view: 'mock';
  name: string;
  workspace: string;
  running: boolean;
  url?: string;
  port: number;
  routes: number;
  https: boolean;
  log: MockLogEntry[];
  error?: string;
  /** Settings shown as chips: CORS, default headers, HTTPS, where its routes came from. */
  chips?: string[];
  /** Its routes, once `mock show` has listed them. */
  routeList?: {
    id?: string;
    method: string;
    path: string;
    status: string;
    ok: boolean;
    note: string;
    enabled?: boolean;
    delayMs?: number;
    /** The note without its switch and delay, which have columns of their own. */
    details?: string;
  }[];
  /** Its settings and routes as saved, for the page to edit; once `mock show` gave them. */
  saved?: MockDraft;
  saving?: boolean;
  /** Settings saved while it runs apply once it is restarted. */
  restartNeeded?: boolean;
  /** The collection it was made from, which routes added to it are added to as well. */
  fromCollection?: string;
  /** How far it is from that collection: requests no route answers, routes with no request. */
  collectionSync?: { collection: string; missingRoutes: number; missingRequests: number };
  /** Changes on each save, so the page drops its edits for what was saved. */
  revision?: number;
}

/** The chips and route table of a mock server, from `mock show`. */
export function mockDetailsView(
  details: MockDetails,
): Pick<MockView, 'chips' | 'routeList' | 'saved' | 'fromCollection' | 'collectionSync'> {
  const chips = [
    details.cors ? `CORS: ${details.corsOrigins || '*'}` : 'CORS off',
    ...(details.defaultHeaders
      ? [`${details.defaultHeaders} default header${details.defaultHeaders === 1 ? '' : 's'}`]
      : []),
    ...(details.https ? ['HTTPS'] : []),
    ...(details.source ? [`From ${details.source.kind} ${details.source.name}`] : []),
  ];
  const routeIds = details.routes.filter((route) => route.id);
  return {
    chips,
    ...(details.source?.kind === 'collection' ? { fromCollection: details.source.name } : {}),
    ...(details.collectionSync ? { collectionSync: details.collectionSync } : {}),
    ...(details.settings && routeIds.length === details.routes.length
      ? {
          saved: {
            settings: details.settings,
            routes: details.routes.map((route) => ({
              id: route.id!,
              kind: route.kind,
              enabled: route.enabled,
              method: route.method,
              path: route.path,
              name: route.name ?? '',
              status: route.status,
              delayMs: route.delayMs ?? 0,
              headers: (route.headers ?? []).map(({ key, value, enabled }) => ({
                key,
                value,
                enabled,
              })),
              body: route.body ?? '',
            })),
          },
        }
      : {}),
    routeList: details.routes.map((route) => ({
      ...(route.id ? { id: route.id } : {}),
      enabled: route.enabled,
      delayMs: route.delayMs ?? 0,
      details: [
        route.name,
        route.rules ? `${route.rules} rule${route.rules === 1 ? '' : 's'}` : '',
        route.responses ? `${route.responses} other answer${route.responses === 1 ? '' : 's'}` : '',
        route.validates ? 'validates requests' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      method: route.kind === 'http' ? route.method : route.kind.toUpperCase(),
      path: route.path,
      status: String(route.status),
      ok: route.status < 400,
      note: [
        route.enabled ? '' : 'Off',
        route.name,
        route.rules ? `${route.rules} rule${route.rules === 1 ? '' : 's'}` : '',
        route.responses ? `${route.responses} other answer${route.responses === 1 ? '' : 's'}` : '',
        route.validates ? 'validates requests' : '',
        route.delayMs ? `delay ${route.delayMs} ms` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  };
}

/**
 * A line `mock start` prints: `Mock “Shop” on http://127.0.0.1:4010. Ctrl+C to stop.` when it is
 * serving, then `12:04:31  GET    /orders?limit=10  200` for each request.
 */
export function mockLine(
  line: string,
): { started: string } | { entry: MockLogEntry } | { stopped: true } | undefined {
  const started = line.match(/\bon (https?:\/\/[^\s,]+?)(?:[.,]\s|\.?$)/);
  if (/^Mock /.test(line) && started) return { started: started[1] };
  if (/^Stopped\.$/.test(line.trim())) return { stopped: true };
  const entry = line.match(/^(\d\d:\d\d:\d\d)\s+([A-Z]+)\s+(.*?)\s+(\d{3})\s*$/);
  if (entry)
    return { entry: { time: entry[1], method: entry[2], path: entry[3], status: entry[4] } };
  return undefined;
}

/** One send in the network log. */
export interface NetworkEntry {
  name: string;
  method: string;
  url: string;
  status?: number;
  error?: string;
  type: string;
  size?: number;
  durationMs: number;
  /** When it started, in milliseconds since the epoch. */
  startedAt: number;
}

export interface NetworkView {
  view: 'network';
  console: ConsoleEntry[];
  performance: PerformanceRow[];
  entries: {
    name: string;
    method: string;
    url: string;
    status: string;
    ok: boolean;
    type: string;
    size: string;
    time: string;
    /** Where its bar starts and how wide it is, in percent of the window shown. */
    left: number;
    width: number;
  }[];
}

export function networkEntry(result: SendResult, startedAt: number): NetworkEntry {
  return {
    name: result.request.name,
    method: result.request.method,
    url: result.url ?? '',
    ...(result.status === undefined ? {} : { status: result.status }),
    ...(result.error ? { error: result.error } : {}),
    type: header(result.headers, 'content-type').split(';')[0],
    ...(result.size === undefined ? {} : { size: result.size }),
    durationMs: result.durationMs ?? 0,
    startedAt,
  };
}

/** The log as a table with a waterfall: each bar placed in the span from the first send to the last. */
export function networkView(entries: NetworkEntry[], console: ConsoleEntry[] = []): NetworkView {
  const start = Math.min(...entries.map((entry) => entry.startedAt));
  const end = Math.max(...entries.map((entry) => entry.startedAt + entry.durationMs));
  const span = Math.max(end - start, 1);
  return {
    view: 'network',
    console,
    performance: performanceRows(entries),
    entries: entries.map((entry) => {
      const left = ((entry.startedAt - start) / span) * 100;
      return {
        name: shortName(entry.url) || entry.name,
        method: entry.method,
        url: entry.url,
        status: entry.error ? 'failed' : String(entry.status ?? ''),
        ok: !entry.error && (entry.status ?? 0) < 400,
        type: entry.type,
        size: entry.size === undefined ? '' : formatBytes(entry.size),
        time: `${Math.round(entry.durationMs)} ms`,
        left: round(Math.min(left, 99)),
        width: round(Math.max(Math.min((entry.durationMs / span) * 100, 100 - left), 1)),
      };
    }),
  };
}
const round = (value: number) => Math.round(value * 10) / 10;

/** The last part of a URL's path, with its query: `orders?limit=10`. */
export function shortName(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).slice(-2).join('/');
    return `${last || parsed.host}${parsed.search}`;
  } catch {
    return url;
  }
}
