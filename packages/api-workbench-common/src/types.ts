export interface KeyValue {
  enabled: boolean;
  key: string;
  value: string;
  description?: string;
}
export type BodyType = 'none' | 'form-data' | 'x-www-form-urlencoded' | 'raw' | 'binary';
export interface BodyField extends KeyValue {
  kind?: 'text' | 'file';
  fileId?: string;
  fileName?: string;
}
export interface UploadData {
  name: string;
  type: string;
  base64: string;
}
export interface NetworkPhase {
  id: 'queueing' | 'dns' | 'tcp' | 'tls' | 'stalled' | 'sending' | 'waiting' | 'download';
  label: string;
  startMs: number;
  durationMs: number;
}
export interface NetworkHop {
  method: string;
  url: string;
  status?: number;
  startMs: number;
  durationMs: number;
  connectionReused: boolean;
  phases: NetworkPhase[];
}
export interface NetworkTiming {
  startedAt: string;
  totalMs: number;
  preparationMs: number;
  requests: NetworkHop[];
}
export interface TLSCertificateInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  serialNumber: string;
  subjectAltName: string;
  fingerprint: string;
  fingerprint256: string;
  fingerprint512: string;
  publicKeyType: string;
  keyBits?: number;
  ca: boolean;
  pem: string;
}
export interface TLSConnectionInfo {
  sessionResumed?: boolean;
  host: string;
  port: number;
  capturedAt: string;
  authorized: boolean;
  authorizationError?: string;
  protocol: string;
  cipher: { name: string; standardName?: string; version: string };
  alpnProtocol?: string;
  chain: TLSCertificateInfo[];
  /** The client certificate presented for mutual TLS, when one matched. */
  clientCertificate?: { subject: string; issuer?: string; validTo?: string };
}
export interface HttpResponse {
  httpVersion?: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  /**
   * The original bytes, base64-encoded, when the body is not text (an image, PDF, or stream),
   * so previews and downloads are exact; `body` then holds a lossy UTF-8 reading. Kept up to
   * 25 MiB, and never saved with the workspace.
   */
  bodyBase64?: string;
  time: number;
  timings?: NetworkTiming;
  tls?: TLSConnectionInfo;
  size: number;
  url: string;
  /** Every Set-Cookie header received, including redirect hops. */
  setCookies?: import('./cookies').SetCookieHeader[];
  error?: never;
}
export interface RequestError {
  error: string;
  timings?: NetworkTiming;
  tls?: TLSConnectionInfo;
  status?: never;
  statusText?: never;
  headers?: never;
  body?: never;
  bodyBase64?: never;
  time?: never;
  size?: never;
  url?: never;
  httpVersion?: never;
  setCookies?: never;
}
export type RequestResponse = HttpResponse | RequestError;
export type AuthType =
  | 'None'
  | 'Inherit from collection'
  | 'Bearer token'
  | 'Basic auth'
  | 'API key'
  | 'Digest auth'
  | 'JWT bearer'
  | 'AWS Signature'
  | 'OAuth 1.0'
  | 'NTLM'
  | 'WSSE'
  | 'Akamai EdgeGrid'
  | 'Hawk'
  | 'OAuth 2.0 (request)'
  | 'Saved credential';
export const AUTH_TYPES: readonly AuthType[] = [
  'None',
  'Inherit from collection',
  'Bearer token',
  'Basic auth',
  'API key',
  'Digest auth',
  'JWT bearer',
  'AWS Signature',
  'OAuth 1.0',
  'NTLM',
  'WSSE',
  'Akamai EdgeGrid',
  'Hawk',
  'OAuth 2.0 (request)',
  'Saved credential',
];
/** Type-specific settings; username, password, and token hold each type's primary secrets. */
export interface AuthOptions {
  apiKeyIn?: 'header' | 'query';
  awsRegion?: string;
  awsService?: string;
  awsSessionToken?: string;
  jwtAlgorithm?: import('./auth-signing').JWTAlgorithm;
  jwtSecretBase64?: boolean;
  jwtPayload?: string;
  jwtHeader?: string;
  jwtPrefix?: string;
  jwtExpiresIn?: string;
  oauth1SignatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT';
  oauth1Token?: string;
  oauth1TokenSecret?: string;
  oauth1Realm?: string;
  ntlmDomain?: string;
  ntlmWorkstation?: string;
  /** Header names, separated by commas, that the EdgeGrid signature covers. */
  edgegridHeadersToSign?: string;
  edgegridMaxBody?: string;
  hawkAlgorithm?: import('./auth-signing').HawkAlgorithm;
  hawkExt?: string;
  hawkApp?: string;
  hawkDlg?: string;
  hawkPayloadHash?: boolean;
  oauth2GrantType?: 'authorization_code' | 'client_credentials' | 'password';
  oauth2AuthorizationUrl?: string;
  oauth2TokenUrl?: string;
  oauth2ClientId?: string;
  oauth2ClientSecret?: string;
  oauth2ClientAuth?: 'none' | 'basic' | 'body';
  oauth2Scope?: string;
  oauth2Audience?: string;
  oauth2Resource?: string;
  oauth2CallbackPort?: string;
  oauth2RefreshToken?: string;
  /** Epoch milliseconds when the stored access token expires. */
  oauth2ExpiresAt?: number;
}
/** Authentication fields shared by requests and collection defaults. */
export interface AuthConfig {
  auth: AuthType;
  token: string;
  username: string;
  password: string;
  credentialId?: string;
  authOptions?: AuthOptions;
}
export type RequestProtocol =
  'http' | 'websocket' | 'sse' | 'ndjson' | 'grpc' | 'socketio' | 'mqtt';
/** Every request protocol, for validating saved and imported requests. */
export const REQUEST_PROTOCOLS: readonly RequestProtocol[] = [
  'http',
  'websocket',
  'sse',
  'ndjson',
  'grpc',
  'socketio',
  'mqtt',
];
export interface GRPCConfig {
  proto: string;
  method: string;
  tls: boolean;
}
/** A Socket.IO connection: the namespace comes from the URL's path. */
export interface SocketIOConfig {
  /** The Engine.IO endpoint on the server, `/socket.io` unless the server changed it. */
  path: string;
  /** The event the outgoing message is emitted as. */
  event: string;
  /** Wait for the server's acknowledgement of each emitted message. */
  ack: boolean;
}
export type MQTTQoS = 0 | 1 | 2;
export interface MQTTSubscription {
  topic: string;
  qos: MQTTQoS;
  enabled: boolean;
}
/** An MQTT connection over mqtt://, mqtts://, ws://, or wss://. */
export interface MQTTConfig {
  /** Empty asks for a generated client ID. */
  clientId: string;
  /** 4 is MQTT 3.1.1; 5 is MQTT 5. */
  version: 4 | 5;
  cleanStart: boolean;
  /** Seconds between pings; 0 turns keep-alive off. */
  keepalive: number;
  /** Topic filters subscribed to when the connection opens. */
  subscriptions: MQTTSubscription[];
  /** Where outgoing messages are published. */
  topic: string;
  qos: MQTTQoS;
  retain: boolean;
}
/** Per-message options: the Socket.IO event, or the MQTT topic, QoS, and retain flag. */
export interface ProtocolSendOptions {
  event?: string;
  ack?: boolean;
  topic?: string;
  qos?: MQTTQoS;
  retain?: boolean;
}
export interface ProtocolPayload {
  httpSettings?: Partial<import('./http-settings').HTTPSettings>;
  sessionId: string;
  protocol: Exclude<RequestProtocol, 'http'>;
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  grpc?: GRPCConfig;
  socketio?: SocketIOConfig;
  mqtt?: MQTTConfig;
  credentialId?: string;
  /** Per-connection signing (Digest, AWS SigV4, OAuth 1.0, JWT), applied by Electron when connecting. */
  signing?: import('./auth-signing').SigningAuth;
  /** Client certificate for wss://, HTTPS streams, and TLS gRPC; read by Electron when connecting. */
  clientCertificate?: import('./client-certificates').ClientCertificatePayload;
}
export interface ProtocolEvent {
  sessionId: string;
  type: 'connecting' | 'open' | 'message' | 'sent' | 'metadata' | 'status' | 'error' | 'closed';
  at: number;
  data: string;
  binary?: boolean;
  writable?: boolean;
  event?: string;
  eventId?: string;
}
export interface GRPCMethod {
  path: string;
  requestStream: boolean;
  responseStream: boolean;
}
/** A shell session in the dev tools terminal. */
export interface TerminalSession {
  id: string;
  /** The shell's name, such as zsh or powershell.exe. */
  shell: string;
  cwd: string;
}
/** A shell the terminal can open, found on this machine. */
export interface TerminalShell {
  /** Stable for the platform, such as `zsh`, `powershell`, or `cmd`. */
  id: string;
  /** As shown in menus, such as "zsh" or "Command Prompt". */
  label: string;
  /** The executable, for display. */
  path: string;
  /** The person's login shell, or the platform's usual one. */
  default?: boolean;
}
export type TerminalEvent =
  { id: string; type: 'data'; data: string } | { id: string; type: 'exit'; exitCode: number };
export interface TerminalBridge {
  /** Starts a shell from `shells()`, or the default one. */
  start(size: { cols: number; rows: number }, shell?: string): Promise<TerminalSession>;
  shells(): Promise<TerminalShell[]>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  stop(id: string): Promise<void>;
  onEvent(callback: (event: TerminalEvent) => void): () => void;
}
/**
 * What the app's window may do with the terminal, which runs in a window of its own: open it,
 * stage a command at a new terminal's prompt (never run it), and hear how many shells run.
 */
export interface TerminalWindowBridge {
  /** Starts the terminal (asked about once per run), and says where it is. */
  open(): Promise<'panel' | 'window'>;
  /** Where the docked terminal goes, in the window's content pixels; null hides it. */
  dock(bounds: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  focus(): Promise<void>;
  /** Moves the terminal, shells and all, into a window of its own. */
  expand(): Promise<void>;
  /** Puts an expanded terminal back in the panel. */
  return(): Promise<void>;
  onPlacement(callback: (where: 'panel' | 'window') => void): () => void;
  /** A command was staged: show the Terminal tab, so the docked terminal has room. */
  onReveal(callback: () => void): () => void;
  type(text: string): Promise<void>;
  onLive(callback: (count: number) => void): () => void;
}
/** The terminal window's own: its saved default shell, staged commands, and the app's theme. */
export interface TerminalHostBridge {
  preferences(): Promise<{ defaultShell?: string }>;
  setDefaultShell(shell: string | undefined): Promise<void>;
  /** Commands the app staged, oldest first; each is taken once. */
  takeStaged(): Promise<string[]>;
  expand(): Promise<void>;
  return(): Promise<void>;
  onPlacement(callback: (where: 'panel' | 'window') => void): () => void;
  onStaged(callback: () => void): () => void;
  onTheme(callback: (theme: 'light' | 'dark') => void): () => void;
}
export interface ProtocolBridge {
  start(input: ProtocolPayload): Promise<void>;
  send(
    sessionId: string,
    message: string,
    binary: boolean,
    options?: ProtocolSendOptions,
  ): Promise<void>;
  finish(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  inspectProto(proto: string): Promise<GRPCMethod[]>;
  onEvent(callback: (event: ProtocolEvent) => void): () => void;
}
export interface ApiRequest {
  protocol?: RequestProtocol;
  grpc?: GRPCConfig;
  socketio?: SocketIOConfig;
  mqtt?: MQTTConfig;
  httpSettings?: Partial<import('./http-settings').HTTPSettings>;
  id: string;
  name: string;
  method: string;
  url: string;
  folder: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: string;
  bodyType?: BodyType;
  rawContentType?: string;
  editorLanguage?: string;
  bodyFields?: BodyField[];
  binaryName?: string;
  auth: AuthType;
  token: string;
  username: string;
  password: string;
  tests: string;
  response: RequestResponse | null;
  credentialId?: string;
  authOptions?: AuthOptions;
  /** Post-response captures: key is the environment variable, value is the response source. */
  captures?: KeyValue[];
  /** Labels for finding the request and choosing what a run sends (tags.ts). */
  tags?: string[];
  /** JavaScript run before the request is sent and after its response (scripts.ts). */
  scripts?: { pre?: string; post?: string };
}
/** A library module: JavaScript that scripts load by name, saved as `scripts/<name>.js`. */
export interface ScriptModule {
  name: string;
  source: string;
}
export interface Environment {
  name: string;
  variables: KeyValue[];
}
export interface HistoryEntry {
  requestId: string;
  method: string;
  url: string;
  status?: number;
  date: string;
  /** Total response time in milliseconds, when recorded. */
  time?: number;
  /** What came back, kept for the History view (saved only while responses are saved). */
  response?: HistoryResponse;
  /** The request console's lines for this send (saved only while responses are saved). */
  console?: HistoryConsoleEntry[];
  /** Why the request failed, when it did (saved only while responses are saved). */
  failure?: HistoryFailure;
  /** In a team workspace, the teammate who sent it; absent for your own sends. */
  author?: TeamMember;
}
/** A failed request as History keeps it: the error, and the timing and TLS it got through. */
export interface HistoryFailure {
  error: string;
  timings?: NetworkTiming;
  tls?: TLSConnectionInfo;
}
/** A request console line of one send: metadata only, never bodies or header values. */
export interface HistoryConsoleEntry {
  at: number;
  level: 'info' | 'success' | 'error';
  message: string;
  /** What the line reports, which says what can be captured from it. */
  kind: 'started' | 'completed' | 'failed' | 'cookies' | 'captures';
}
export interface HistoryResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The body as text, cut short when it was longer than the limit; empty for binary bodies. */
  body: string;
  truncated?: boolean;
  /** The body was not text (an image, PDF, or other file), so it was not kept. */
  binary?: boolean;
  size: number;
  /** Every Set-Cookie header received, including redirect hops, for the Cookies view. */
  setCookies?: import('./cookies').SetCookieHeader[];
  /** The network timing of the exchange, for the Timeline view. */
  timings?: NetworkTiming;
  /** The TLS connection and server certificate chain, for the Certificate view. */
  tls?: TLSConnectionInfo;
}
export interface WorkspaceState {
  collectionHttpSettings?: Record<string, Partial<import('./http-settings').HTTPSettings>>;
  requests: ApiRequest[];
  active?: string;
  tabs: string[];
  recentTabs?: string[];
  closedTabs?: string[];
  environments: Environment[];
  environment: number;
  history: HistoryEntry[];
  settings?: AppSettings;
  cookieJar?: { enabled: boolean; cookies: import('./cookies').StoredCookie[] };
  /** Client certificates for mutual TLS, matched by host. */
  clientCertificates?: import('./client-certificates').ClientCertificate[];
  /** Snippets people saved for the snippets panel, shared with the workspace (script-snippets.ts). */
  scriptSnippets?: import('./script-snippets').UserSnippet[];
  /** Modules of shared functions that scripts load with `aw.require(name)` (scripts.ts). */
  scriptLibrary?: ScriptModule[];
  /** Scripts run around every request in the workspace, before collection scripts (scripts.ts). */
  workspaceScripts?: { pre?: string; post?: string };
  /** Tags per collection and folder, which every request inside has too (tags.ts). */
  collectionTags?: Record<string, string[]>;
  /** Scripts per collection and folder, run around every request inside (scripts.ts). */
  collectionScripts?: Record<string, { pre?: string; post?: string }>;
  /** Default authentication per collection, used by requests set to inherit. */
  collectionAuth?: Record<string, AuthConfig>;
  /** API specifications (OpenAPI 3 or Swagger 2), each saved as its own file. */
  specs?: ApiSpec[];
  /** Mock servers, each saved as its own file. */
  mocks?: MockServer[];
}
/** An API specification as written: its text is kept exactly, in YAML or JSON. */
export interface ApiSpec {
  id: string;
  name: string;
  format: 'yaml' | 'json';
  content: string;
  /** The collection last generated from this specification, refreshed by the next generation. */
  collection?: string;
}
/** One canned response a mock server gives for a method and path. */
/** What a mock route serves: plain HTTP answers, or a stream of messages over a live protocol. */
export type MockRouteKind = 'http' | 'sse' | 'ndjson' | 'websocket' | 'grpc' | 'socketio' | 'mqtt';
export interface MockRoute {
  id: string;
  enabled: boolean;
  /** HTTP (the default), or a live protocol whose messages come from `stream`. */
  kind?: MockRouteKind;
  /** An HTTP method, or `ANY` for every method; WebSocket, gRPC, Socket.IO, and MQTT routes ignore it. */
  method: string;
  /**
   * A path such as `/users/:id`; `:name` matches one segment and `*` the rest of the path. For
   * gRPC, the method's full name, such as `/shop.Orders/Watch`. For Socket.IO, the namespace,
   * such as `/` or `/orders`. For MQTT, a topic such as `devices/:id/status`, where `+` or `:name`
   * matches one level and `#` or `*` the rest. For CONNECT, the target `host:port` after a slash,
   * such as `/api.example.com:443`.
   */
  path: string;
  status: number;
  headers: KeyValue[];
  body: string;
  /** Milliseconds to wait before responding. */
  delayMs: number;
  /** A short label, such as the request or operation it came from. */
  name?: string;
  /** Conditions on the request; a route answers only when they pass. */
  rules?: MockRule[];
  /** Whether every rule must pass (the default) or any one. */
  ruleMode?: 'all' | 'any';
  /**
   * Other answers for the route, each with its own rules: a request gets the first whose rules
   * pass, or the route's own status, headers, body, and delay when none do.
   */
  responses?: MockResponse[];
  /** The messages a WebSocket, SSE, NDJSON, gRPC, Socket.IO, or MQTT route sends. */
  stream?: MockStream;
  /** Checks a matched request must pass before it is answered; failures get an error answer. */
  validation?: MockValidation;
  /** What each `:name` in the path is: its type or allowed values, an example, a description. */
  pathParams?: MockPathParam[];
  /**
   * For a mock made from a collection: the request this route is in step with there, which
   * changes when the route's method, path, or name does.
   */
  requestId?: string;
}
/** A path parameter of a mock route, such as `id` in `/users/:id`. */
export interface MockPathParam {
  name: string;
  /**
   * What its value must be, checked when the route validates requests: a type, `enum` (one of
   * `values`, separated by commas), or `pattern` (`values` is a regular expression). Unset takes anything.
   */
  type?: MockPathParamType;
  values?: string;
  /** A value to show and try the route with, such as `42`. */
  example?: string;
  description?: string;
}
export type MockPathParamType =
  'integer' | 'number' | 'boolean' | 'uuid' | 'date' | 'enum' | 'pattern';
/**
 * Request validation for a route: required values and a JSON Schema for the body. A matched
 * request that fails is answered with `status` and the problems, not the route's answer.
 */
export interface MockValidation {
  enabled: boolean;
  /** Conditions every request must meet, such as a required query parameter or header. */
  checks: MockRule[];
  /** A JSON Schema the request body must satisfy, as JSON text; empty checks no schema. */
  schema?: string;
  /** The status sent when validation fails: 422 by default. gRPC calls fail with INVALID_ARGUMENT. */
  status: number;
  /** A body template sent when it fails, where `{{problems}}` is the list as JSON; empty sends a JSON report. */
  body?: string;
  /**
   * Content types a request with a body may send, separated by commas, such as
   * `application/json`; `type/*` allows a family. Empty allows any.
   */
  contentTypes?: string;
  /** The largest request body allowed, in bytes; unset allows any size. */
  maxBodyBytes?: number;
  /** Query parameters the route does not name in its checks or rules are refused. */
  strictQuery?: boolean;
}
/** One reason a request failed validation. */
export interface MockValidationProblem {
  in: 'query' | 'header' | 'cookie' | 'param' | 'body';
  /** The parameter, header, or body path, such as `limit` or `items[0].sku`; empty for the whole body. */
  name: string;
  message: string;
}
/** The messages a live-protocol route sends, and how. */
export interface MockStream {
  /**
   * Sent in order, each a template like a body: SSE events, NDJSON lines, WebSocket messages,
   * gRPC response messages as JSON, Socket.IO events, or MQTT messages published to the topic a
   * client subscribed to. A unary or client-streaming gRPC call gets the first.
   */
  messages: MockStreamMessage[];
  /** Milliseconds between messages. */
  intervalMs: number;
  /** Starts again from the first message, until the client disconnects. */
  repeat?: boolean;
  /**
   * WebSocket, Socket.IO, MQTT, and client- or bidirectional-streaming gRPC: a template sent back
   * for each message received, with the message as `{{body}}`. Socket.IO replies with the same
   * event (or the acknowledgement the client asked for); MQTT publishes to the message's response
   * topic, or the topic with `/reply` added. Empty sends nothing back.
   */
  reply?: string;
}
export interface MockStreamMessage {
  id: string;
  data: string;
  /** SSE: the event name, sent as `event:`. Socket.IO: the event emitted, `message` when empty. */
  event?: string;
}
/** One of a route's other answers, given when its rules pass. */
export interface MockResponse {
  id: string;
  /** A short label, such as "Out of stock". */
  name?: string;
  rules: MockRule[];
  ruleMode?: 'all' | 'any';
  status: number;
  headers: KeyValue[];
  body: string;
  delayMs: number;
}
/**
 * How a rule compares: as text, against a list, as a number or a length, by the kind of value it
 * is, or by whether it is there at all.
 */
export type MockRuleOperator =
  | 'equals'
  | 'not-equals'
  | 'equals-ignore-case'
  | 'not-equals-ignore-case'
  | 'contains'
  | 'contains-ignore-case'
  | 'not-contains-ignore-case'
  | 'contains-all'
  | 'contains-any'
  | 'not-contains'
  | 'starts-with'
  | 'not-starts-with'
  | 'ends-with'
  | 'not-ends-with'
  | 'matches'
  | 'not-matches'
  | 'one-of'
  | 'not-one-of'
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'not-between'
  | 'length-equals'
  | 'min-length'
  | 'max-length'
  | 'before'
  | 'after'
  | 'is-integer'
  | 'is-number'
  | 'is-boolean'
  | 'is-uuid'
  | 'is-email'
  | 'is-date'
  | 'is-url'
  | 'is-ip'
  | 'is-json'
  | 'is-array'
  | 'is-object'
  | 'is-alphanumeric'
  | 'is-base64'
  | 'is-hex'
  | 'is-jwt'
  | 'is-uppercase'
  | 'is-lowercase'
  | 'empty'
  | 'not-empty'
  | 'exists'
  | 'missing';
/** A condition a request must meet for a mock route to answer it. */
export interface MockRule {
  enabled: boolean;
  /** Where the value comes from: a query parameter, header, cookie, path parameter, or the body. */
  target: 'query' | 'header' | 'cookie' | 'param' | 'body';
  /** Its name; for the body, a JSON path such as `user.id` or `items[0].sku`, or empty for all of it. */
  name: string;
  operator: MockRuleOperator;
  /**
   * What to compare with: text, a regular expression for `matches`, values separated by commas for
   * `one-of`, a number, `min..max` for `between`, or a length. Unused by the kind and presence checks.
   */
  value: string;
}
export interface MockServer {
  id: string;
  name: string;
  /** The local port it listens on, on 127.0.0.1. */
  port: number;
  /** Serves HTTPS instead of HTTP: with the app's local CA, or the person's own certificate. */
  https?: MockHttps;
  /** Answers browser preflight requests and adds CORS headers, as `corsOptions` says. */
  cors: boolean;
  /** Which origins, methods, and headers cross-origin requests may use; permissive when unset. */
  corsOptions?: MockCorsOptions;
  /**
   * Headers sent on every response (route answers, 404s, errors, and preflights), such as
   * security headers; a route's own header of the same name wins.
   */
  defaultHeaders?: KeyValue[];
  routes: MockRoute[];
  /** gRPC: the self-contained schema its gRPC routes implement, and the port they are served on. */
  grpc?: MockGrpc;
  /** MQTT: the port its broker listens on, over TCP; MQTT over WebSocket uses the HTTP port's `/mqtt`. */
  mqtt?: MockMqtt;
  /** What the routes were created from, for display. */
  source?: { kind: 'collection' | 'spec'; name: string };
}
/** gRPC for a mock server: served over plaintext HTTP/2 on its own port. */
export interface MockGrpc {
  proto: string;
  port: number;
}
/** MQTT for a mock server: a broker on its own port, which its MQTT routes publish through. */
export interface MockMqtt {
  port: number;
}
/** HTTPS for a mock server. */
export interface MockHttps {
  enabled: boolean;
  /**
   * PEM certificate and key files, such as mkcert makes; without them the certificate is issued
   * by API Workbench's local CA (the Interceptor's), for localhost and 127.0.0.1.
   */
  certFile?: string;
  keyFile?: string;
}
/** CORS for a mock server. Lists are comma-separated; `*` allows any. */
export interface MockCorsOptions {
  origins: string;
  methods: string;
  headers: string;
  exposeHeaders: string;
  /** Allows cookies and authorization; origins and headers are then echoed instead of `*`. */
  credentials: boolean;
  /** Seconds a browser may cache a preflight answer; 0 sends no Access-Control-Max-Age. */
  maxAge: number;
}
/** A request a running mock server answered, with what it sent and what it got. */
export interface MockLogEntry {
  /** Unique within the session, to select an entry. */
  id: string;
  mockId: string;
  time: string;
  method: string;
  /** The path with its query string. */
  path: string;
  status: number;
  /** The route that answered, or none when nothing matched (a 404). */
  routeId?: string;
  /** The route's other response that answered, when its rules passed. */
  responseId?: string;
  durationMs: number;
  /** How long the route waited before answering. */
  delayMs?: number;
  /** Path parameters the route's pattern took from the path. */
  params?: Record<string, string>;
  request?: MockLogMessage;
  response?: MockLogMessage;
  /** Why this route and response answered, or why none did, in plain words. */
  notes?: string[];
  /** The protocol, for a WebSocket, SSE, NDJSON, gRPC, Socket.IO, or MQTT exchange. */
  protocol?: MockRouteKind;
}
export interface MockLogMessage {
  headers: Record<string, string>;
  /** The body as text, cut short past the log's limit. */
  body: string;
  truncated?: boolean;
  size: number;
}
export interface MockStatus {
  /** Ids of the mock servers running now, with their ports. */
  running: { id: string; port: number; grpcPort?: number; mqttPort?: number }[];
}
export interface MockBridge {
  status(): Promise<MockStatus>;
  /** Starts the mock, or applies its new routes and settings if it is already running. */
  start(mock: MockServer): Promise<MockStatus>;
  stop(id: string): Promise<MockStatus>;
  onLog(callback: (entry: MockLogEntry) => void): () => void;
}
export interface RequestPayload {
  httpSettings?: Partial<import('./http-settings').HTTPSettings>;
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  multipart?: { name: string; value: string; file?: UploadData }[];
  binary?: UploadData;
  credentialId?: string;
  /** Client certificate for mutual TLS, read by Electron when sending. */
  clientCertificate?: import('./client-certificates').ClientCertificatePayload;
  /** Authentication computed by Electron from the final request (Digest, AWS SigV4, OAuth 1.0, JWT). */
  signing?: import('./auth-signing').SigningAuth;
  /** When present, Electron sends matching cookies on every hop, including redirects. */
  cookieJar?: import('./cookies').StoredCookie[];
  timeoutMs?: number;
  followRedirects?: boolean;
}
export interface CodegenTarget {
  id: string;
  label: string;
  extension: string;
  clients: { id: string; label: string }[];
}
export interface CodegenInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  bodyType: BodyType;
  fields: { name: string; value: string; fileName?: string }[];
  binaryName?: string;
  /** A live connection: its snippets come from electron/codegen-live.ts. Absent for HTTP. */
  protocol?: Exclude<RequestProtocol, 'http'>;
  /** WebSocket: the message is base64 bytes, sent as a binary frame. */
  binary?: boolean;
  grpc?: GRPCConfig;
  socketio?: SocketIOConfig;
  mqtt?: MQTTConfig;
}
export interface CodegenResult {
  code: string;
  filename: string;
  notes: string[];
}
export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  hasData?: boolean;
  /** A team workspace: the shared folder its collections, environments, and history live in. */
  folder?: string;
  /**
   * A workspace kept on this device outside the app's data folder: the folder its workspace file
   * and collections are saved in. Its credential vault stays in the app's data folder.
   */
  location?: string;
}
export interface WorkspaceIndex {
  version: 1;
  activeId: string;
  workspaces: WorkspaceSummary[];
  /**
   * Where new workspaces are saved, each in a folder of its own named after it; unset saves them
   * in the app's data folder.
   */
  storageFolder?: string;
  /** You, as teammates see you in team workspaces. */
  member?: TeamMember;
}
/** A person using a team workspace: a random id for this device, and the name they chose. */
export interface TeamMember {
  id: string;
  name: string;
}
/** A teammate with the active team workspace open, and the request they are looking at. */
export interface TeamPresence {
  member: TeamMember;
  requestId?: string;
  requestName?: string;
  /** ISO time of their last heartbeat; presence older than a minute is dropped. */
  updatedAt: string;
}
/** Who else has the active team workspace open, sent whenever it changes. */
export interface TeamPresenceChange {
  workspaceId: string;
  others: TeamPresence[];
}
/**
 * The active workspace's files changed outside the app: the workspace as it is now on disk, or why
 * it could not be read. The app confirms an applied change by its sequence.
 */
export type WorkspaceChange =
  { sequence: number; state: WorkspaceState } | { sequence: number; error: string };
/** workspaces.json changed outside the app: the workspace list as it is now, or why it is unreadable. */
export type WorkspaceIndexChange = { index: WorkspaceIndex; warning?: string } | { error: string };
/** Where a new workspace is saved: the default folder, the app's data folder, or one asked for. */
export type WorkspaceLocationChoice = 'default' | 'app-data' | 'choose';
/** Where workspaces are saved, for Settings → Saving. */
export interface WorkspaceStorageInfo {
  /** The app's data folder, used when no storage folder is set. */
  appData: string;
  /** The folder new workspaces go in, when one is set. */
  storageFolder?: string;
  /** Set when the storage folder cannot be reached, such as an unplugged drive. */
  storageProblem?: string;
  /** The folder the open workspace's files are in. */
  current: string;
}
/** Where secrets are kept, and whether that store can be used now. */
export interface VaultStatus {
  /** Whether secrets can be read and saved now. */
  available: boolean;
  /** The store's name, such as macOS Keychain, or API Workbench vault. */
  backend: string;
  /** The OS's credential store, or the API Workbench vault when the OS has none. */
  kind: 'os' | 'workbench';
  /** For the API Workbench vault: whether a vault password has been set. */
  setUp: boolean;
  /** For the API Workbench vault: whether it is locked. */
  locked: boolean;
  /** When an unlocked API Workbench vault locks if not used, as an ISO time. */
  locksAt?: string;
  /** Seconds before another password attempt is allowed, after several wrong ones. */
  retryAfterSeconds?: number;
  /**
   * The API Workbench vault was chosen over the system's store, so the command line and the VS
   * Code extension can read credentials; `system` is that store's name, to go back to.
   */
  chosen?: boolean;
  system?: string;
}
/**
 * The API Workbench vault. Passwords are sent once to the main process and never kept here; the
 * recovery key never comes to the app at all: it is saved to a file or the clipboard from main.
 */
export interface WorkbenchVaultBridge {
  setup(password: string): Promise<VaultStatus>;
  unlock(password: string): Promise<VaultStatus>;
  recover(recoveryKey: string, password: string): Promise<VaultStatus>;
  changePassword(current: string, next: string): Promise<VaultStatus>;
  lock(): Promise<VaultStatus>;
  /** Forgets the vault and the credentials it encrypted, in every workspace. */
  reset(): Promise<VaultStatus>;
  /**
   * Uses the API Workbench vault even where the system has a credential store (so the command line
   * and VS Code can read credentials), moving them into it once it opens; false goes back.
   */
  useWorkbench(enabled: boolean): Promise<VaultStatus>;
  /** Saves the recovery key made at setup to a file the person chooses; false when cancelled. */
  saveRecoveryKey(): Promise<boolean>;
  /** Copies the recovery key made at setup to the clipboard, cleared again after a minute. */
  copyRecoveryKey(): Promise<void>;
  /** Forgets the recovery key made at setup, once it has been saved. */
  finishSetup(): Promise<void>;
  /** Calls `callback` when the vault locks on its own, after going unused. */
  onLocked(callback: () => void): () => void;
}
export interface WorkspaceBridge {
  list(): Promise<WorkspaceIndex>;
  /** Null when `location` is `choose` and the person cancels. */
  create(
    name: string,
    state: WorkspaceState,
    location?: WorkspaceLocationChoice,
  ): Promise<WorkspaceSummary | null>;
  /** Where workspaces are saved. */
  storage?(): Promise<WorkspaceStorageInfo>;
  /** Asks for a folder for new workspaces; the same info, unchanged, when the person cancels. */
  chooseStorageFolder?(): Promise<WorkspaceStorageInfo>;
  /** Saves new workspaces in the app's data folder again. */
  resetStorageFolder?(): Promise<WorkspaceStorageInfo>;
  /**
   * Tells the app whether there are changes not yet saved, so closing the window can save them
   * (`ask` false) or ask first (`ask` true, when auto save is off).
   */
  setUnsaved?(unsaved: boolean, ask: boolean): Promise<void>;
  /** Calls `callback` when the window is closing with unsaved changes it should save now. */
  onSaveBeforeClose?(callback: () => void): () => void;
  /** Says the save asked for before closing is done, so the window can close. */
  closeReady?(saved: boolean): Promise<void>;
  switch(id: string): Promise<WorkspaceState | null>;
  rename(id: string, name: string): Promise<void>;
  delete(id: string): Promise<void>;
  /** Shows a collection's or folder's directory (by folder path) in the system file manager. */
  reveal?(folder?: string): Promise<void>;
  /** Calls `callback` when the active workspace's files change outside the app. */
  onWorkspaceChange?(callback: (change: WorkspaceChange) => void): () => void;
  /** Confirms that the change with this sequence has been applied. */
  workspaceChangeApplied?(sequence: number): Promise<void>;
  /** Calls `callback` when workspaces.json, the workspace list, changes outside the app. */
  onIndexChange?(callback: (change: WorkspaceIndexChange) => void): () => void;
  /**
   * Asks for a folder and opens the team workspace in it, or starts one there from `initial` when
   * the folder has none. Null when the person cancels.
   */
  openTeamFolder?(initial: WorkspaceState, memberName: string): Promise<WorkspaceSummary | null>;
  /** Asks for a folder and copies this workspace into it as a team workspace. Null on cancel. */
  shareToFolder?(state: WorkspaceState, memberName: string): Promise<WorkspaceSummary | null>;
  /** You, as teammates see you. */
  member?(): Promise<TeamMember>;
  setMemberName?(name: string): Promise<TeamMember>;
  /** Tells teammates which request you are looking at (none when no request is open). */
  setPresence?(requestId?: string, requestName?: string): Promise<void>;
  /** Calls `callback` when teammates open, leave, or move around the active team workspace. */
  onPresence?(callback: (change: TeamPresenceChange) => void): () => void;
  /** Git sync for the active team workspace's folder. */
  git?: TeamGitBridge;
  /**
   * Asks where to put a clone of a Git repository, clones it, and opens the team workspace in it;
   * when it holds none, shares `state` there. Null when the person cancels.
   */
  cloneTeam?(
    url: string,
    state: WorkspaceState,
    memberName: string,
  ): Promise<TeamCloneResult | null>;
}
/** How a file in a team folder differs from the last commit. */
export type GitChangeKind =
  'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
export interface GitChange {
  /** Relative to the team folder. */
  path: string;
  kind: GitChangeKind;
}
/** A team folder's Git repository, as the Team panel shows it. Remote URLs carry no credentials. */
export interface TeamGitStatus {
  /** Whether git is installed and found. */
  available: boolean;
  version?: string;
  /** Whether the team folder is inside a Git repository. */
  repository: boolean;
  branch?: string;
  remote?: string;
  /** The remote branch this one pulls from and pushes to, such as `origin/main`. */
  upstream?: string;
  ahead: number;
  behind: number;
  /** Changed files in the team folder (the first 200), and how many there are in all. */
  changes: GitChange[];
  changeCount: number;
}
/** Which side wins in files changed both here and on the remote. */
export type GitConflictChoice = 'mine' | 'theirs';
export interface TeamGitResult {
  status: TeamGitStatus;
  /** What happened, for a toast. */
  message: string;
  /** Files changed both here and on the remote; the pull was undone, so nothing is half-merged. */
  conflicts?: string[];
}
export interface TeamGitBridge {
  /** Null when the active workspace is not a team workspace. */
  status(): Promise<TeamGitStatus | null>;
  /** Makes the team folder a repository (when it is not in one) with this remote, and pushes it. */
  connect(url: string): Promise<TeamGitResult>;
  commit(message: string): Promise<TeamGitResult>;
  pull(choice?: GitConflictChoice): Promise<TeamGitResult>;
  push(): Promise<TeamGitResult>;
  /** Commits the team folder's changes, pulls, and pushes. */
  sync(message: string, choice?: GitConflictChoice): Promise<TeamGitResult>;
}
export interface TeamCloneResult {
  workspace: WorkspaceSummary;
  /** True when the clone held no team workspace and this workspace was shared into it. */
  shared: boolean;
}
/** An export to publish as a GitHub gist; the token is the saved credential `credentialId`. */
export interface GistPublishInput {
  credentialId: string;
  files: { name: string; content: string }[];
  description: string;
  /** Public gists are listed on the account; secret ones only open with their link. */
  public: boolean;
  /** Updates this gist instead of creating one. */
  gistId?: string;
}
export interface GistPublishResult {
  id: string;
  /** The gist's page on GitHub. */
  url: string;
  public: boolean;
  /** True when an existing gist was updated. */
  updated: boolean;
}
/** Files downloaded from a link to a collection: a gist's files, or one file. */
export interface LinkImport {
  /** The address the files came from, without credentials. */
  source: string;
  files: { name: string; data: Uint8Array }[];
}
/** One exchange seen by the Interceptor's capture proxy, sent to the renderer as it progresses. */
export interface InterceptorCapture {
  id: string;
  startedAt: number;
  /** `https` was decrypted; `tunnel` is HTTPS passed through without decryption, so only its host is known. */
  scheme: 'http' | 'https' | 'tunnel';
  method: string;
  url: string;
  requestHeaders: [string, string][];
  /** Bodies are text when they decode as UTF-8, otherwise base64; at most 1 MB is kept. */
  requestBody?: string;
  requestBodyEncoding?: 'utf8' | 'base64';
  requestBodySize: number;
  status?: number;
  statusText?: string;
  responseHeaders?: [string, string][];
  responseBody?: string;
  responseBodyEncoding?: 'utf8' | 'base64';
  responseBodySize?: number;
  /** True when a body was larger than the capture limit and is only partly kept. */
  truncated?: boolean;
  durationMs?: number;
  /** Bytes in each direction, for tunnels. */
  bytesSent?: number;
  bytesReceived?: number;
  error?: string;
  done: boolean;
}
export interface InterceptorStatus {
  running: boolean;
  port: number;
  decryptHttps: boolean;
  recording: boolean;
  /** The CA that signs decrypted hosts' certificates, once created. */
  authority?: {
    subject: string;
    validTo: string;
    fingerprint: string;
    path: string;
    /** The domains it is limited to, with their subdomains and this computer; empty: any site. */
    domains: string[];
  };
  /** Why HTTPS cannot be decrypted, e.g. OS encryption for the CA key is unavailable. */
  authorityError?: string;
}
export interface InterceptorBridge {
  status(): Promise<InterceptorStatus>;
  /** `domains`: decrypt only these (and subdomains), with a CA limited to them; empty: every host. */
  start(options: {
    port: number;
    decryptHttps: boolean;
    domains?: string[];
  }): Promise<InterceptorStatus>;
  stop(): Promise<InterceptorStatus>;
  setRecording(recording: boolean): Promise<InterceptorStatus>;
  /** Saves the CA certificate (public part only) where the user chooses; false if cancelled. */
  exportAuthority(): Promise<boolean>;
  /** Adds the CA to the user's trusted roots; the operating system asks to confirm. */
  trustAuthority(): Promise<void>;
  /** Replaces the CA with a new one; the old one should be removed from trusted roots. */
  resetAuthority(): Promise<InterceptorStatus>;
  onCapture(callback: (capture: InterceptorCapture) => void): () => void;
}
/** How the app keeps itself up to date: on its own, by asking first, or only when asked. */
export type UpdateMode = 'auto' | 'notify' | 'off';
export interface UpdatePreferences {
  mode: UpdateMode;
  /** Offer pre-release versions (betas) as well as releases. */
  prerelease: boolean;
}
/** Where an update stands. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'unsupported'; reason: string }
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'available'; version: string; releaseDate?: string; notes?: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };
export interface UpdateInfo {
  currentVersion: string;
  preferences: UpdatePreferences;
  status: UpdateStatus;
  /** When the last check finished (ISO), if one has. */
  lastChecked?: string;
}
/** Application updates, checked against the project's GitHub releases by the main process. */
export interface UpdateBridge {
  info(): Promise<UpdateInfo>;
  setPreferences(preferences: UpdatePreferences): Promise<UpdateInfo>;
  check(): Promise<UpdateInfo>;
  download(): Promise<UpdateInfo>;
  /** Quits, installs the downloaded update, and starts the new version. */
  install(): Promise<void>;
  onChange(callback: (info: UpdateInfo) => void): () => void;
}
export interface WorkbenchBridge {
  protocols?: ProtocolBridge;
  /** Local mock servers run by the main process. */
  mocks?: MockBridge;
  interceptor?: InterceptorBridge;
  /** The dev tools terminal: the person's own shell, in a pseudo-terminal. */
  /** Only in the terminal window (terminal-preload.ts). */
  terminal?: TerminalBridge;
  /** Only in the terminal window. */
  terminalHost?: TerminalHostBridge;
  /** Only in the app's window. */
  terminalWindow?: TerminalWindowBridge;
  setTheme?: (theme: 'light' | 'dark') => Promise<void>;
  /** Opens a web or mail link in the system browser or mail app; others are refused. */
  openExternal?: (url: string) => Promise<void>;
  /** Restarts the application; the caller saves its work first. */
  restart?: () => Promise<void>;
  /** Application updates; absent where the app cannot update itself (a browser preview). */
  updates?: UpdateBridge;
  runnerResources(): Promise<import('./runner-resources').ResourceReading>;
  /** Request scripts, run in a separate engine in the main process (scripts.ts). */
  scripts?: {
    run(input: import('./scripts').ScriptInput): Promise<import('./scripts').ScriptOutput>;
    /** Whether each script may run: written in the app, or allowed by the person. */
    trusted(sources: string[]): Promise<boolean[]>;
    /** Allows scripts after the person reviewed them. */
    allow(sources: string[]): Promise<void>;
    /** Records an edit made in the app; the result says whether the new text may run. */
    edited(previous: string, next: string): Promise<boolean>;
  };
  codegen: {
    targets(protocol?: Exclude<RequestProtocol, 'http'>): Promise<CodegenTarget[]>;
    generate(input: CodegenInput, target: string, client: string): Promise<CodegenResult>;
  };
  parseImportDocument: (text: string) => Promise<unknown>;
  /** Publishes an export to GitHub as a gist, with a token from the vault. */
  gists?: { publish(input: GistPublishInput): Promise<GistPublishResult> };
  /** Downloads a collection from a link (a gist, a GitHub, GitLab, or Bitbucket file, or any URL). */
  importLink?: (url: string) => Promise<LinkImport>;
  workspaces: WorkspaceBridge;
  load(workspaceId?: string): Promise<WorkspaceState | null>;
  save(state: WorkspaceState, workspaceId?: string): Promise<void>;
  send(request: RequestPayload): Promise<RequestResponse>;
  cancel(id: string): Promise<void>;
  credentials: {
    list(): Promise<CredentialSummary[]>;
    test(id: string): Promise<{ checkedAt: string }>;
    save(input: CredentialInput): Promise<CredentialSummary>;
    delete(id: string): Promise<void>;
    /** Moves a certificate saved in workspace settings (by file path) into the vault. */
    importCertificate(
      entry: import('./client-certificates').ClientCertificate,
      name?: string,
    ): Promise<CredentialSummary>;
    status(): Promise<VaultStatus>;
  };
  /** The API Workbench vault, used for secrets when the system has no credential store. */
  vault?: WorkbenchVaultBridge;
  certificates?: {
    /** Opens a file picker; `ca` returns the validated PEM text as well as the path. */
    choose(
      kind: 'cert' | 'key' | 'pfx' | 'ca',
    ): Promise<{ path: string; name: string; pem?: string } | null>;
    inspect(
      payload: import('./client-certificates').ClientCertificatePayload,
    ): Promise<{ subject?: string; issuer?: string; validTo?: string }>;
  };
  oauth: {
    authorize(id: string): Promise<CredentialSummary>;
    refresh(id: string): Promise<CredentialSummary>;
    cancel(): Promise<void>;
    disconnect(id: string): Promise<CredentialSummary>;
    /** Fetches a token for request-level OAuth 2.0 without storing it in the vault. */
    token(input: RequestOAuthInput): Promise<OAuthTokens>;
    /** Finds OAuth endpoints from an API, issuer, or well-known metadata URL. */
    discover(url: string): Promise<import('./oauth-discovery').OAuthDiscovery>;
  };
}
export interface AppSettings {
  httpSettings?: Partial<import('./http-settings').HTTPSettings>;
  workspaceName: string;
  timeoutMs: number;
  followRedirects: boolean;
  defaultAccept: string;
  historyEnabled: boolean;
  historyLimit: number;
  persistResponses: boolean;
  theme: 'dark' | 'light' | 'system';
  density: 'comfortable' | 'compact';
  editorFontSize: number;
  wordWrap: boolean;
  runnerDelayMs: number;
  stopRunnerOnFailure: boolean;
  /**
   * When changes are written to disk: as they happen (`change`, the default), after a pause in
   * editing (`delay`), or only when saved with Save (`off`).
   */
  autoSave: AutoSaveMode;
  /** Seconds without changes before a `delay` auto save writes them (1–60). */
  autoSaveDelaySeconds: number;
}
export type AutoSaveMode = 'change' | 'delay' | 'off';
export type CredentialKind =
  | 'bearer'
  | 'basic'
  | 'api-key'
  | 'digest'
  | 'jwt'
  | 'aws'
  | 'oauth1'
  | 'ntlm'
  | 'wsse'
  | 'edgegrid'
  | 'hawk'
  | 'oauth2'
  | 'client-certificate';
/** Non-secret settings for vault credentials; secrets live in `secret` and `extraSecret`. */
export interface CredentialOptions {
  apiKeyIn?: 'header' | 'query';
  awsRegion?: string;
  awsService?: string;
  jwtAlgorithm?: import('./auth-signing').JWTAlgorithm;
  jwtSecretBase64?: boolean;
  jwtPayload?: string;
  jwtHeader?: string;
  jwtPrefix?: string;
  jwtExpiresIn?: string;
  oauth1SignatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT';
  oauth1Token?: string;
  oauth1Realm?: string;
  ntlmDomain?: string;
  ntlmWorkstation?: string;
  /** Header names, separated by commas, that the EdgeGrid signature covers. */
  edgegridHeadersToSign?: string;
  edgegridMaxBody?: string;
  hawkAlgorithm?: import('./auth-signing').HawkAlgorithm;
  hawkExt?: string;
  hawkApp?: string;
  hawkDlg?: string;
  hawkPayloadHash?: boolean;
}
export interface OAuthConfig {
  grantType: 'authorization_code' | 'client_credentials';
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
  audience: string;
  /** RFC 8707 resource indicator: the API the token is for, from discovery or entered. */
  resource?: string;
  clientAuth: 'none' | 'basic' | 'body';
  callbackPort: number;
}
export interface CredentialInput {
  id?: string;
  name: string;
  kind: CredentialKind;
  allowedOrigin: string;
  username?: string;
  secret?: string;
  headerName?: string;
  oauth?: OAuthConfig;
  external?: import('./secret-providers').ExternalSecretConfig;
  providerSecrets?: Record<string, string>;
  secretField?: string;
  options?: CredentialOptions;
  /** AWS session token, OAuth 1.0 token secret, EdgeGrid access token, or certificate passphrase. */
  extraSecret?: string;
  /** Client certificate: where it is presented. Its key or bundle is stored as `secret`. */
  clientCertificate?: import('./client-certificates').CertificateProfile;
  /**
   * Client certificate files to copy into the vault when saving. Read once in the main
   * process; the paths are never stored.
   */
  certificateFiles?: { certPath?: string; keyPath?: string; pfxPath?: string };
}
/** Settings for a request-level OAuth 2.0 token, validated before any network call. */
export interface RequestOAuthInput {
  grantType: 'authorization_code' | 'client_credentials' | 'password' | 'refresh_token';
  authorizationUrl?: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  clientAuth: 'none' | 'basic' | 'body';
  scope?: string;
  audience?: string;
  resource?: string;
  callbackPort?: number;
  username?: string;
  password?: string;
  refreshToken?: string;
}
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}
export interface CredentialRecord extends CredentialInput {
  id: string;
  updatedAt: string;
  tokens?: OAuthTokens;
  clientCertificate?: import('./client-certificates').VaultCertificate;
}
export interface CredentialSummary {
  id: string;
  name: string;
  kind: CredentialKind;
  allowedOrigin: string;
  username?: string;
  headerName?: string;
  updatedAt: string;
  oauth?: Omit<OAuthConfig, 'clientSecret'>;
  external?: import('./secret-providers').ExternalSecretConfig;
  providerSecretFields?: string[];
  secretField?: string;
  options?: CredentialOptions;
  hasSecret: boolean;
  hasExtraSecret?: boolean;
  connected: boolean;
  expiresAt?: number;
  canRefresh: boolean;
  clientCertificate?: import('./client-certificates').CertificateProfile;
}
declare global {
  interface Window {
    workbench?: WorkbenchBridge;
  }
}
