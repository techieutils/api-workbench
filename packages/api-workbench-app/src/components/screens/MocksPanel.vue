<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { collectionOf } from '@techieutils/api-workbench-common/folders';
import {
  DEFAULT_MOCK_CORS,
  MOCK_METHODS,
  MOCK_MQTT_WEBSOCKET_PATH,
  MOCK_SOCKETIO_PATH,
  freeMockGrpcPort,
  freeMockMqttPort,
  isStreamRoute,
  mockExamplePath,
  mockHttpsProblem,
  mockPathParamNames,
  mockRouteKind,
  newMockStream,
  missingSecurityHeaders,
  mockPortProblem,
  newMockResponse,
  renderMockBody,
} from '@techieutils/api-workbench-common/mocks';
import type {
  GRPCMethod,
  MockCorsOptions,
  MockHttps,
  MockLogEntry,
  MockResponse,
  MockRoute,
  MockRouteKind,
  MockServer,
  MockValidation,
} from '@techieutils/api-workbench-common/types';
import { detectLanguage } from '../../editor/formatting';
import { OPTION_ICONS, withIcons } from '../../select-options';
import { METHOD_DESCRIPTIONS, methodIcon } from '../../stores/protocols';
import { useMocksStore, type MockTab } from '../../stores/mocks';
import { useRequestBodyStore } from '../../stores/request-body';
import type { EditorCompletion, EditorHandle } from '../../editor/runtime';
import { MOCK_TEMPLATE_HELPERS } from '@techieutils/api-workbench-common/mock-templates';
import {
  MOCK_DOC_FORMATS,
  mockDocOperations,
  mockDocumentation,
  schemaLabel,
  type MockDocFormat,
} from '@techieutils/api-workbench-common/mock-docs';
import { useSpecsStore } from '../../stores/api-specs';
import { shellQuote, shellWord } from '../../terminal-input';
import { useUiStore } from '../../stores/ui';
import { useWorkspaceStore } from '../../stores/workspace';
import { openView } from '../../navigation';
import { useContextMenu } from '../../composables/context-menu';
import { download as saveFile, errorMessage, toast } from '../../utils';
import type { MenuItem } from '../ActionMenu.vue';
import ActionMenu from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import MdiIcon from '../MdiIcon.vue';
import SourceEditor from '../SourceEditor.vue';
import PageHeader from '../ui/PageHeader.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiExpansionPanel from '../ui/UiExpansionPanel.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiTabs from '../ui/UiTabs.vue';
import KeyValueTable from '../table/KeyValueTable.vue';
import MockRulesTable from './MockRulesTable.vue';
import MockStreamEditor from './MockStreamEditor.vue';
import MockPathParamsTable from './MockPathParamsTable.vue';
import {
  constrainsPathParam,
  describeValidation,
  inferJsonSchema,
  mockSchemaProblem,
  newMockValidation,
  validateMockRequest,
} from '@techieutils/api-workbench-common/mock-validation';

/** Mock servers: a list beside an editor of each mock's routes and the requests it answered. */
const store = useMocksStore();
const specs = useSpecsStore();
const workspace = useWorkspaceStore();
onMounted(() => void store.initialize());
// Mocks are edited in place, so read them on every render rather than caching them.
const mock = () => store.current()!;
const route = () => store.currentRoute(mock());
const isRunning = (id: string) => store.running.has(id);
/** How far the mock is from the collection it was made from, re-read as either changes. */
const syncState = () => {
  void workspace.revision;
  return store.syncStatus(mock());
};
/** What is out of step, in words: “2 requests have no route · 1 route has no request”. */
const syncText = () => {
  const state = syncState();
  if (!state) return '';
  return [
    state.missingRoutes
      ? `${state.missingRoutes} request${state.missingRoutes === 1 ? ' has' : 's have'} no route`
      : '',
    state.missingRequests
      ? `${state.missingRequests} route${state.missingRequests === 1 ? ' has' : 's have'} no request`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
};
const collectionNames = computed(() => {
  void workspace.revision;
  return [...new Set(workspace.state.requests.map((request) => collectionOf(request.folder)))];
});
const fromCollection = ref('');
function createFrom(collection: string): void {
  fromCollection.value = '';
  if (collection) store.createFromCollection(collection);
}
// What a route serves, chosen as a request's type is: an HTTP method, or a live protocol.
const PROTOCOLS: [Exclude<MockRouteKind, 'http'>, string, MdiIconName, string][] = [
  ['websocket', 'WebSocket', 'swap-horizontal', 'Messages both ways'],
  ['sse', 'SSE', 'access-point', 'Server-sent events'],
  ['ndjson', 'NDJSON', 'format-list-text', 'Streamed JSON lines'],
  ['grpc', 'gRPC', 'api', 'Calls from a .proto schema'],
  ['socketio', 'Socket.IO', 'lightning-bolt-outline', 'Named events both ways'],
  ['mqtt', 'MQTT', 'access-point-network', 'Messages for topics, through a broker'],
];
const PROTOCOL_LABELS: Record<MockRouteKind, string> = {
  http: 'HTTP',
  websocket: 'WS',
  sse: 'SSE',
  ndjson: 'NDJSON',
  grpc: 'gRPC',
  socketio: 'SIO',
  mqtt: 'MQTT',
};
const methodOptions = withIcons(
  [
    ...MOCK_METHODS.map((method) => ({
      value: method,
      label: method,
      description: METHOD_DESCRIPTIONS[method],
      group: 'HTTP · REST and GraphQL',
      attrs: { 'data-method': method },
    })),
    ...PROTOCOLS.map(([kind, label, , description]) => ({
      value: kind,
      label,
      description,
      group: 'Live protocols',
      attrs: { 'data-method': kind.toUpperCase(), 'data-mock-protocol': kind },
    })),
  ],
  (option) =>
    PROTOCOLS.find(([kind]) => kind === option.value)?.[2] ??
    (option.value === 'ANY' ? 'swap-horizontal' : methodIcon(option.value)),
);
/** The route's method or protocol, as the select and the route list show it. */
const routeType = (item: MockRoute) => (isStreamRoute(item) ? mockRouteKind(item) : item.method);
const routeBadge = (item: MockRoute) =>
  isStreamRoute(item) ? PROTOCOL_LABELS[mockRouteKind(item)] : item.method;
const routeBadgeClass = (item: MockRoute) =>
  isStreamRoute(item) ? mockRouteKind(item).toUpperCase() : item.method;
/** What each kind of route is, in plain words, for the route editor's card and the route list. */
const PROTOCOL_INFO: Record<
  MockRouteKind,
  { title: string; group: string; icon: MdiIconName; summary: string }
> = {
  http: {
    title: 'HTTP route',
    group: 'HTTP',
    icon: 'web',
    summary: 'Answers each request once, with a status, headers, and body.',
  },
  websocket: {
    title: 'WebSocket route',
    group: 'WebSocket',
    icon: 'swap-horizontal',
    summary:
      'Upgrades the connection, then sends its messages and answers each message the client sends with the reply.',
  },
  sse: {
    title: 'Server-sent events route',
    group: 'SSE',
    icon: 'access-point',
    summary: 'Keeps the response open and sends each message as an event (text/event-stream).',
  },
  ndjson: {
    title: 'NDJSON stream route',
    group: 'NDJSON',
    icon: 'format-list-text',
    summary: 'Keeps the response open and sends each message as one line of JSON.',
  },
  grpc: {
    title: 'gRPC method',
    group: 'gRPC',
    icon: 'api',
    summary: 'Answers calls to one method of the schema, over HTTP/2 on the mock’s gRPC port.',
  },
  socketio: {
    title: 'Socket.IO namespace',
    group: 'Socket.IO',
    icon: 'lightning-bolt-outline',
    summary:
      'Takes connections to one namespace at /socket.io on the mock’s port, emits its messages as events, and answers each event the client emits with the reply.',
  },
  mqtt: {
    title: 'MQTT topic',
    group: 'MQTT',
    icon: 'access-point-network',
    summary:
      'Publishes its messages to clients that subscribe to the topic, and replies on the topic with /reply added to each message published to it. The mock’s MQTT 3.1.1 broker serves it.',
  },
};
const KIND_ORDER: MockRouteKind[] = [
  'http',
  'websocket',
  'sse',
  'ndjson',
  'grpc',
  'socketio',
  'mqtt',
];
/** The routes in groups by protocol, in a fixed order; the list shows headings when there are several. */
const routeGroups = () => {
  const query = routeQuery.value.trim().toLowerCase();
  const matches = (item: MockRoute) =>
    !query ||
    [routeBadge(item), item.path, item.name ?? '', PROTOCOL_INFO[mockRouteKind(item)].group].some(
      (text) => text.toLowerCase().includes(query),
    );
  return KIND_ORDER.map((kind) => ({
    kind,
    routes: mock().routes.filter((item) => mockRouteKind(item) === kind && matches(item)),
  })).filter((group) => group.routes.length);
};
/** Text that narrows the route list. */
const routeQuery = ref('');
watch(
  () => mock()?.id,
  () => (routeQuery.value = ''),
);
/** Route groups folded away in the list, by protocol, like folders in the explorer. */
const collapsedGroups = ref(new Set<MockRouteKind>());
function toggleGroup(kind: MockRouteKind): void {
  const next = new Set(collapsedGroups.value);
  if (!next.delete(kind)) next.add(kind);
  collapsedGroups.value = next;
}
// Selecting a route in a folded group, such as from the log, opens the group.
watch(
  () => route()?.id,
  () => {
    const current = route();
    if (current && collapsedGroups.value.has(mockRouteKind(current)))
      toggleGroup(mockRouteKind(current));
  },
);
/** A route's icon in the list: its method's, or its protocol's. */
const routeIcon = (item: MockRoute): MdiIconName =>
  isStreamRoute(item) ? PROTOCOL_INFO[mockRouteKind(item)].icon : methodIcon(item.method);
/** Where clients reach the mock: its HTTP address, and its WebSocket and gRPC ones when it has such routes. */
const endpoints = () => {
  const http = store.url(mock());
  const kinds = new Set(mock().routes.map(mockRouteKind));
  return [
    { kind: 'http' as const, label: 'HTTP', address: http },
    ...(kinds.has('websocket')
      ? [{ kind: 'websocket' as const, label: 'WebSocket', address: http.replace(/^http/, 'ws') }]
      : []),
    ...(kinds.has('grpc')
      ? [
          {
            kind: 'grpc' as const,
            label: 'gRPC',
            address: mock().grpc ? `localhost:${mock().grpc!.port}` : 'Set up in gRPC settings',
          },
        ]
      : []),
    ...(kinds.has('socketio')
      ? [{ kind: 'socketio' as const, label: 'Socket.IO', address: http }]
      : []),
    ...(kinds.has('mqtt')
      ? [
          { kind: 'mqtt' as const, label: 'MQTT', address: `mqtt://localhost:${mqttPort()}` },
          {
            kind: 'mqtt' as const,
            label: 'MQTT over WebSocket',
            address: `${http.replace(/^http/, 'ws')}${MOCK_MQTT_WEBSOCKET_PATH}`,
          },
        ]
      : []),
  ];
};
/** The port the mock's MQTT broker listens on. */
const mqttPort = () => mock().mqtt?.port ?? freeMockMqttPort(store.mocks(), mock().port);
async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`, 'success');
  } catch {
    toast(`Could not copy ${what}`, 'error');
  }
}
/** The schema method a gRPC route answers, for its streaming kind. */
const routeGrpcMethod = () => grpcMethods.value.find((method) => method.path === route()?.path);
const ui = useUiStore();
/** Whether this is the desktop app, which has a terminal to run the command in. */
// The terminal runs in its own window; this one can stage a command there.
const hasTerminal = Boolean(window.workbench?.terminalWindow);
/** A command that calls the route from a terminal, to try it. */
const tryCommand = () => {
  const current = route();
  if (!current) return '';
  const kind = mockRouteKind(current);
  const http = store.url(mock());
  const path = mockExamplePath(current);
  if (kind === 'grpc')
    return `grpcurl -plaintext -proto schema.proto -d '{}' localhost:${mock().grpc?.port ?? 50051} ${shellWord(current.path.replace(/^\//, ''))}`;
  if (kind === 'websocket') return `npx wscat -c ${shellQuote(http.replace(/^http/, 'ws') + path)}`;
  if (kind === 'mqtt')
    return `mosquitto_sub -h 127.0.0.1 -p ${mqttPort()} -v -t ${shellQuote(mqttExampleTopic(current))}`;
  // Socket.IO's own frames, raw: once it opens, send 40${path}, to join the namespace.
  if (kind === 'socketio')
    return `npx wscat -c ${shellQuote(`${http.replace(/^http/, 'ws')}${MOCK_SOCKETIO_PATH}/?EIO=4&transport=websocket`)}`;
  if (kind === 'sse' || kind === 'ndjson') {
    const method =
      current.method === 'GET' || current.method === 'ANY'
        ? ''
        : `-X ${shellWord(current.method)} `;
    return `curl -N ${method}${shellQuote(http + path)}`;
  }
  const method = ['GET', 'ANY'].includes(current.method) ? '' : `-X ${shellWord(current.method)} `;
  return `curl -i ${method}${shellQuote(http + path)}`;
};
/** A concrete topic for an MQTT route: its parameters' examples, or `example`. */
const mqttExampleTopic = (item: MockRoute) =>
  item.path
    .replace(/^\//, '')
    .split('/')
    .map((level) =>
      level.startsWith(':')
        ? item.pathParams?.find((param) => param.name === level.slice(1))?.example?.trim() ||
          'example'
        : ['+', '#', '*'].includes(level)
          ? 'example'
          : level,
    )
    .join('/');
/** The order and timing of a stream's messages, as short steps for the route card. */
const flowSteps = () => {
  const current = route();
  if (!current || !isStreamRoute(current)) return [];
  const kind = mockRouteKind(current);
  const stream = current.stream ?? newMockStream(kind);
  const count = stream.messages.length;
  const grpcMethod = routeGrpcMethod();
  const steps: string[] = [
    kind === 'websocket' || kind === 'socketio'
      ? 'Client connects'
      : kind === 'mqtt'
        ? 'Client subscribes'
        : kind === 'grpc'
          ? `Client calls${grpcMethod ? ` (${grpcKind(grpcMethod).toLowerCase()})` : ''}`
          : 'Client requests',
  ];
  if (current.delayMs > 0) steps.push(`waits ${current.delayMs} ms`);
  const sendsOne = kind === 'grpc' && grpcMethod && !grpcMethod.responseStream;
  if (sendsOne) steps.push(count ? 'answers with message 1' : 'answers with {}');
  else if (count)
    steps.push(
      `sends ${count} message${count === 1 ? '' : 's'}${count > 1 ? `, ${stream.intervalMs} ms apart` : ''}`,
    );
  if (!sendsOne && stream.repeat) steps.push('repeats until the client leaves');
  if (
    (kind === 'websocket' || (kind === 'grpc' && grpcMethod?.requestStream)) &&
    stream.reply?.trim()
  )
    steps.push('replies to each client message');
  if (kind === 'socketio' && stream.reply?.trim()) steps.push('answers each event');
  if (kind === 'mqtt' && stream.reply?.trim()) steps.push('replies on /reply to each message');
  if (kind === 'grpc') steps.push(`ends with status ${current.status || 0}`);
  else if (!stream.repeat && !['websocket', 'socketio', 'mqtt'].includes(kind))
    steps.push('closes');
  return steps;
};
const addRouteItems: MenuItem[] = KIND_ORDER.map((kind) => ({
  id: kind,
  label: PROTOCOL_INFO[kind].title,
  icon: PROTOCOL_INFO[kind].icon,
}));
/** Adds a route of the chosen protocol, set up as choosing it in the route's box would. */
function addRouteOf(kind: string): void {
  const created = store.addRoute(mock().id);
  if (!created || kind === 'http') return;
  setRouteType({ target: { value: kind } } as unknown as Event);
  if (kind === 'grpc') {
    const free = grpcMethods.value.find(
      (method) =>
        !mock().routes.some((item) => mockRouteKind(item) === 'grpc' && item.path === method.path),
    );
    update({ path: free?.path ?? '/package.Service/Method' });
  } else
    update({
      path: (
        {
          websocket: '/ws',
          sse: '/events',
          ndjson: '/stream',
          socketio: '/',
          mqtt: 'devices/:id/status',
        } as Record<string, string>
      )[kind],
    });
}
/** Each protocol a mock serves and how many routes use it, for its row in the list. */
const protocolSummary = (item: MockServer) =>
  KIND_ORDER.map((kind) => ({
    kind,
    label: PROTOCOL_LABELS[kind],
    count: item.routes.filter((route) => mockRouteKind(route) === kind).length,
  })).filter((part) => part.count);
/** Whether a log entry is a failure: a 4xx or 5xx answer, or a gRPC call that did not end OK. */
const failed = (entry: MockLogEntry) =>
  entry.protocol === 'grpc' ? entry.status !== 0 : entry.status >= 400;
/** The mock at a glance: its routes, protocols, and how the requests it served went. */
const stats = () => {
  const routes = mock().routes;
  const log = store.logs.get(mock().id) ?? [];
  const errors = log.filter(failed).length;
  const average = log.length
    ? Math.round(log.reduce((total, entry) => total + entry.durationMs, 0) / log.length)
    : undefined;
  const kinds = KIND_ORDER.filter((kind) => routes.some((route) => mockRouteKind(route) === kind));
  return [
    {
      key: 'routes',
      label: 'Routes',
      icon: 'api' as MdiIconName,
      value: `${routes.filter((route) => route.enabled).length} of ${routes.length} on`,
      tone: '',
    },
    {
      key: 'protocols',
      label: 'Protocols',
      icon: 'swap-horizontal' as MdiIconName,
      value: kinds.length ? kinds.map((kind) => PROTOCOL_INFO[kind].group).join(' · ') : '—',
      tone: '',
    },
    {
      key: 'requests',
      label: 'Requests',
      icon: 'format-list-text' as MdiIconName,
      value: String(log.length),
      tone: '',
    },
    {
      key: 'errors',
      label: 'Errors',
      icon: 'alert-circle-outline' as MdiIconName,
      value: log.length ? `${errors} (${Math.round((errors / log.length) * 100)}%)` : '0',
      tone: errors ? 'is-warning' : '',
    },
    {
      key: 'latency',
      label: 'Avg time',
      icon: 'timer-outline' as MdiIconName,
      value: average === undefined ? '—' : `${average} ms`,
      tone: '',
    },
    {
      key: 'last',
      label: 'Last request',
      icon: 'history' as MdiIconName,
      value: log[0] ? time(log[0].time) : '—',
      tone: '',
    },
  ];
};
interface SettingTile {
  key: ServerSetting;
  title: string;
  icon: MdiIconName;
  /** On, off, or set but needing something; shown with an icon and words, not colour alone. */
  tone: 'on' | 'off' | 'warning';
  status: string;
  /** The value that matters most, such as the origins allowed or the port. */
  detail: string;
  summary: string;
  count?: number;
}
const SETTING_STATUS_ICONS: Record<SettingTile['tone'], MdiIconName> = {
  on: 'check-circle-outline',
  off: 'minus-circle-outline',
  warning: 'alert-outline',
};
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
/** Each server setting at a glance, for its tile. */
const settingTiles = (): SettingTile[] => {
  const current = mock();
  const uses = (kind: MockRouteKind) =>
    current.routes.some((item) => item.enabled && mockRouteKind(item) === kind);
  const origins = cors()
    .origins.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const httpsOn = current.https?.enabled === true;
  const httpsProblem = httpsOn ? mockHttpsProblem(current.https) : undefined;
  const headers = defaultCount();
  const missing = missingSecurityHeaders(current.defaultHeaders).length;
  const proto = Boolean(current.grpc?.proto.trim());
  return [
    {
      key: 'cors',
      title: 'CORS',
      icon: 'tune-variant',
      tone: current.cors ? 'on' : 'off',
      status: current.cors ? 'On' : 'Off',
      detail: !current.cors
        ? 'Browsers on other origins are refused'
        : !origins.length || origins.includes('*')
          ? `Any origin${cors().credentials ? ', with credentials' : ''}`
          : `${plural(origins.length, 'origin')}${cors().credentials ? ', with credentials' : ''}`,
      summary: corsSummary(),
    },
    {
      key: 'https',
      title: 'HTTPS',
      icon: 'lock-outline',
      tone: httpsProblem ? 'warning' : httpsOn ? 'on' : 'off',
      status: httpsProblem ? 'Needs files' : httpsOn ? 'On' : 'Off',
      detail: !httpsOn
        ? 'Plain HTTP'
        : current.https?.certFile
          ? 'Your certificate'
          : 'API Workbench CA',
      summary: httpsSummary(),
    },
    {
      key: 'defaults',
      title: 'Default headers',
      icon: 'shield-lock-outline',
      tone: !headers ? 'off' : missing ? 'warning' : 'on',
      status: !headers ? 'Off' : missing ? `${missing} missing` : 'On',
      detail: plural(headers, 'header'),
      summary: defaultsSummary(),
      count: headers,
    },
    {
      key: 'grpc',
      title: 'gRPC',
      icon: 'api',
      tone:
        (uses('grpc') && !proto) || (proto && grpcError.value) ? 'warning' : proto ? 'on' : 'off',
      status:
        uses('grpc') && !proto
          ? 'Needs schema'
          : proto && grpcError.value
            ? 'Schema error'
            : proto
              ? 'On'
              : 'Off',
      detail: proto
        ? `Port ${current.grpc!.port} · ${plural(grpcMethods.value.length, 'method')}`
        : uses('grpc')
          ? 'No schema yet'
          : 'Not used',
      summary: grpcSummary(),
    },
    {
      key: 'mqtt',
      title: 'MQTT broker',
      icon: 'access-point-network',
      tone: uses('mqtt') ? 'on' : 'off',
      status: uses('mqtt') ? 'On' : 'Off',
      detail: uses('mqtt') ? `Port ${mqttPort()}` : 'Not used',
      summary: mqttSummary(),
    },
  ];
};
/** How many settings are on, and how many need something, for the card's header. */
const settingsHealth = () => {
  const tiles = settingTiles();
  return {
    on: tiles.filter((tile) => tile.tone !== 'off').length,
    attention: tiles.filter((tile) => tile.tone === 'warning'),
  };
};
const openTile = () => settingTiles().find((tile) => tile.key === openSetting.value);
/** One line on each server setting, for its panel's header. */
const corsSummary = () =>
  mock().cors
    ? `Answers preflights; origins ${mock().corsOptions?.origins || DEFAULT_MOCK_CORS.origins}`
    : 'Cross-origin browser requests get no CORS headers';
const httpsSummary = () =>
  mock().https?.enabled
    ? mock().https?.certFile
      ? 'Serves HTTPS with your certificate files'
      : 'Serves HTTPS with the local CA, for localhost'
    : 'Serves plain HTTP';
const defaultsSummary = () => {
  const count = defaultCount();
  return count
    ? `${count} header${count === 1 ? '' : 's'} on every answer, such as security headers`
    : 'No headers are added to every answer';
};
const grpcSummary = () =>
  mock().grpc?.proto.trim()
    ? `${grpcMethods.value.length} method${grpcMethods.value.length === 1 ? '' : 's'} on port ${mock().grpc!.port}, over plaintext HTTP/2`
    : 'Paste a .proto schema to serve gRPC routes';
/** The sections' header badges: how many rules, and how many responses or messages. */
const matchBadge = () => {
  const count = (route()?.rules ?? []).filter((rule) => rule.enabled).length;
  return count ? `${count} rule${count === 1 ? '' : 's'}` : '';
};
const respondBadge = () => {
  const current = route();
  if (!current) return '';
  if (isStreamRoute(current)) {
    const count = current.stream?.messages.length ?? 0;
    return `${count} message${count === 1 ? '' : 's'}`;
  }
  const count = 1 + (current.responses?.length ?? 0);
  return count > 1 ? `${count} responses` : '';
};
const allCollapsed = () =>
  store.ui.collapsed.match && store.ui.collapsed.validate && store.ui.collapsed.respond;
function toggleAllSections(): void {
  const collapse = !allCollapsed();
  store.ui.collapsed.match = collapse;
  store.ui.collapsed.validate = collapse;
  store.ui.collapsed.respond = collapse;
}
// Validation: what a matched request must pass before it is answered.
const validateBadge = () => {
  const validation = route()?.validation;
  if (!validation?.enabled) return '';
  const checks = validation.checks.filter((check) => check.enabled).length;
  const typed = (route()?.pathParams ?? []).filter(constrainsPathParam).length;
  return [
    typed ? `${typed} param${typed === 1 ? '' : 's'}` : '',
    checks ? `${checks} check${checks === 1 ? '' : 's'}` : '',
    validation.schema?.trim() ? 'schema' : '',
    validation.contentTypes?.trim() ? 'type' : '',
    validation.maxBodyBytes !== undefined ? 'size' : '',
    validation.strictQuery ? 'strict' : '',
  ]
    .filter(Boolean)
    .join(' · ');
};
const validateIntro = () =>
  ({
    http: 'A matched request that fails gets the failure answer instead of the route’s, and the log says why.',
    sse: 'A request that fails gets the failure answer instead of the stream.',
    ndjson: 'A request that fails gets the failure answer instead of the stream.',
    websocket: 'A handshake that fails is refused with the failure status and the problems.',
    grpc: 'A call that fails ends with INVALID_ARGUMENT, before any message is sent.',
    socketio:
      'A connection that fails is refused; the client’s connect_error carries the problems.',
    mqtt: '',
  })[route() ? mockRouteKind(route()!) : 'http'];
const failurePlaceholder =
  '{"error": "Request validation failed", "problems": [...]} by default; use {{problems}} for the list';
function setValidation(patch: Partial<MockValidation>): void {
  const validation = route()?.validation;
  if (!validation) return;
  Object.assign(validation, patch);
  store.touch(mock().id);
}
function setValidationEnabled(enabled: boolean): void {
  const current = route();
  if (!current) return;
  if (current.validation) current.validation.enabled = enabled;
  else if (enabled) current.validation = newMockValidation();
  store.touch(mock().id);
}
const pathParamsHelp = () =>
  route() && mockPathParamNames(route()!.path).length
    ? 'Values taken from the path, as {{params.name}} in templates; a type is checked when the route validates'
    : 'Add one below, or type :name in the path, such as /users/:id';
/** A path parameter got a type: types are checked by validation, so turn it on. */
function pathParamConstrained(): void {
  if (route()?.validation?.enabled) return;
  setValidationEnabled(true);
  toast('Validation is on for this route, so path parameter types are checked', 'info');
}
function setMaxBody(event: Event): void {
  const text = (event.target as HTMLInputElement).value.trim();
  const bytes = Number(text);
  if (!text) setValidation({ maxBodyBytes: undefined });
  else if (Number.isInteger(bytes) && bytes >= 0) setValidation({ maxBodyBytes: bytes });
}
function setValidationStatus(event: Event): void {
  const status = Number((event.target as HTMLInputElement).value);
  if (Number.isInteger(status) && status >= 400 && status <= 599) setValidation({ status });
}
async function formatSchema(): Promise<void> {
  const schema = route()?.validation?.schema;
  if (!schema?.trim()) return;
  try {
    setValidation({ schema: await WorkbenchEditor.formatText(schema, 'json') });
  } catch (error) {
    toast(`Format failed: ${errorMessage(error)}`, 'error');
  }
}
/** A body typed to try the route's validation against. */
const validationSample = ref('');
watch(
  () => route()?.id,
  () => (validationSample.value = ''),
);
/** What the sample body would fail: the schema, and the route's body checks. */
const sampleProblems = () => {
  const validation = route()?.validation;
  if (!validation) return [];
  return validateMockRequest(
    {
      ...validation,
      checks: validation.checks.filter((check) => check.target === 'body'),
      // The sample has no headers or query, so only what its body can fail is tested.
      contentTypes: undefined,
      strictQuery: undefined,
    },
    { query: new URLSearchParams(), headers: {}, body: validationSample.value },
  );
};
function inferSchema(): void {
  let sample: unknown;
  try {
    sample = JSON.parse(validationSample.value || route()?.body || '');
  } catch {
    toast('Type a JSON body in Test a body first, and a schema is made from it.', 'warning');
    return;
  }
  setValidation({ schema: JSON.stringify(inferJsonSchema(sample), null, 2) });
  toast('Made a schema from the sample; loosen it as needed', 'success');
}
/** One line on what the route matches, for its Match section. */
const matchSummary = () => {
  const current = route();
  if (!current) return '';
  const kind = mockRouteKind(current);
  const rules = (current.rules ?? []).filter((rule) => rule.enabled).length;
  const what =
    kind === 'grpc'
      ? `Calls to ${current.path}`
      : kind === 'websocket' || kind === 'socketio'
        ? `Connections to ${current.path}`
        : kind === 'mqtt'
          ? `Topic ${current.path}`
          : `${current.method === 'ANY' ? 'Any method' : current.method} ${current.path}`;
  if (!rules) return `${what}, every time`;
  if (rules === 1) return `${what}, when its rule passes`;
  return current.ruleMode === 'any'
    ? `${what}, when any of ${rules} rules passes`
    : `${what}, when all ${rules} rules pass`;
};
/** One line on what the route sends back, for its Respond or Stream section. */
const respondSummary = () => {
  const current = route();
  if (!current) return '';
  if (isStreamRoute(current)) return flowSteps().slice(1).join(' → ');
  const others = current.responses?.length ?? 0;
  return `${current.status}${others ? ` by default, or one of ${others} other response${others === 1 ? '' : 's'}` : ''}${current.delayMs ? ` after ${current.delayMs} ms` : ''}`;
};
/** The rules' heading and help, in the route's terms: a request, a handshake, or a call. */
const rulesTitle = () =>
  ({
    http: 'Request rules',
    websocket: 'Handshake rules',
    grpc: 'Call rules',
    sse: 'Request rules',
    ndjson: 'Request rules',
    socketio: 'Handshake rules',
    mqtt: 'Message rules',
  })[route() ? mockRouteKind(route()!) : 'http'];
const rulesActiveHelp = () =>
  ({
    http: 'This route answers only requests that meet them',
    websocket: 'Only connections whose handshake meets them are accepted by this route',
    grpc: 'This route answers only calls that meet them',
    sse: 'This stream opens only for requests that meet them',
    ndjson: 'This stream opens only for requests that meet them',
    socketio: 'Only connections whose handshake meets them are taken by this route',
    mqtt: 'This route answers only subscriptions and messages that meet them',
  })[route() ? mockRouteKind(route()!) : 'http'];
const rulesEmptyHelp = () =>
  ({
    http: 'Answer only some requests to this path, by query, header, or body',
    websocket: 'Accept only some connections, by the handshake’s query, headers, or path',
    grpc: 'Answer only some calls, by metadata or a field of the request message',
    sse: 'Open the stream only for some requests, by query, header, or path',
    ndjson: 'Open the stream only for some requests, by query, header, path, or body',
    socketio: 'Take only some connections, by the handshake’s query, headers, or auth payload',
    mqtt: 'Answer only some clients or messages, by client ID, username, topic level, or payload',
  })[route() ? mockRouteKind(route()!) : 'http'];
/** The path box's name and example, for the protocols whose path is not a URL path. */
const PATH_FIELD: Partial<Record<MockRouteKind, [string, string]>> = {
  grpc: ['gRPC method', '/package.Service/Method'],
  socketio: ['Socket.IO namespace', '/ or /orders'],
  mqtt: ['MQTT topic', 'devices/:id/status'],
};
/** Where the route is reached: ws:// for WebSocket, the gRPC port for gRPC, else the mock's URL. */
const routeOrigin = () => {
  const kind = route() ? mockRouteKind(route()!) : 'http';
  if (kind === 'grpc') return `grpc://127.0.0.1:${mock().grpc?.port ?? '—'}`;
  if (kind === 'mqtt') return `mqtt://127.0.0.1:${mqttPort()}/`;
  const origin = store.url(mock());
  return kind === 'websocket' ? origin.replace(/^http/, 'ws') : origin;
};
/** Switches a route between HTTP methods and live protocols, keeping its messages. */
function setRouteType(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  const current = route();
  if (!current) return;
  if (!PROTOCOLS.some(([kind]) => kind === value)) {
    update({ kind: undefined, method: value });
    return;
  }
  const kind = value as Exclude<MockRouteKind, 'http'>;
  const stream =
    current.stream && current.stream.messages.length ? current.stream : newMockStream(kind);
  update({
    kind,
    method: 'GET',
    stream,
    // The stream sets its own Content-Type.
    headers: current.headers.filter((row) => row.key.trim().toLowerCase() !== 'content-type'),
    ...(kind === 'grpc' ? { status: 0 } : {}),
  });
  // An MQTT route needs the broker's port: set it the first time.
  if (kind === 'mqtt' && !mock().mqtt) {
    mock().mqtt = { port: freeMockMqttPort(store.mocks(), mock().port, mock().grpc?.port ?? 0) };
    openSetting.value = 'mqtt';
    store.touch(mock().id);
  }
  // An HTTP path is not a topic.
  if (kind === 'mqtt' && current.path.startsWith('/')) update({ path: 'devices/:id/status' });
  // A gRPC route needs the mock's schema and port: set them up the first time.
  if (kind === 'grpc' && !mock().grpc) {
    mock().grpc = { proto: '', port: freeMockGrpcPort(store.mocks(), mock().port) };
    grpcOpen.value = true;
    store.touch(mock().id);
  }
}
/**
 * Server settings: a tile for each, and the open one's panel under them. One is open at a time,
 * so the settings never push the routes far down the page.
 */
type ServerSetting = 'cors' | 'https' | 'defaults' | 'grpc' | 'mqtt';
const openSetting = ref<ServerSetting | ''>('');
function toggleSetting(key: ServerSetting): void {
  openSetting.value = openSetting.value === key ? '' : key;
}
/** Opens a setting from elsewhere on the page, and brings its panel into view. */
function showSetting(key: ServerSetting): void {
  openSetting.value = key;
  void nextTick(() =>
    document
      .querySelector('#mock-setting-panel')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
  );
}
/** Closes the open panel and puts focus back on its tile, for Escape and the close button. */
function closeSetting(): void {
  const key = openSetting.value;
  openSetting.value = '';
  if (key)
    void nextTick(() =>
      document.querySelector<HTMLElement>(`[data-mock-setting="${key}"]`)?.focus(),
    );
}
// gRPC: the schema's methods, read by the desktop app, for the route path and quick routes.
const grpcOpen = computed({
  get: () => openSetting.value === 'grpc',
  set: (open: boolean) => (openSetting.value = open ? 'grpc' : ''),
});
const grpcMethods = ref<GRPCMethod[]>([]);
const grpcError = ref('');
let inspected = '';
async function inspectGrpc(): Promise<void> {
  // With no mock servers yet there is no mock, and nothing to inspect.
  const proto = mock()?.grpc?.proto ?? '';
  if (proto === inspected) return;
  inspected = proto;
  const bridge = window.workbench?.protocols;
  if (!proto.trim() || !bridge) {
    grpcMethods.value = [];
    grpcError.value = '';
    return;
  }
  try {
    const methods = await bridge.inspectProto(proto);
    if (inspected !== proto) return;
    grpcMethods.value = methods;
    grpcError.value = methods.length ? '' : 'The schema has no service methods.';
  } catch (error) {
    if (inspected !== proto) return;
    grpcMethods.value = [];
    grpcError.value = errorMessage(error);
  }
}
const grpcKind = (method: GRPCMethod) =>
  method.requestStream
    ? method.responseStream
      ? 'Bidirectional streaming'
      : 'Client streaming'
    : method.responseStream
      ? 'Server streaming'
      : 'Unary';
let grpcTimer: ReturnType<typeof setTimeout> | undefined;
function setGrpcProto(proto: string): void {
  const grpc = (mock().grpc ??= { proto: '', port: freeMockGrpcPort(store.mocks(), mock().port) });
  grpc.proto = proto;
  store.touch(mock().id);
  clearTimeout(grpcTimer);
  grpcTimer = setTimeout(() => void inspectGrpc(), 300);
}
const mqttSummary = () =>
  mock().routes.some((item) => mockRouteKind(item) === 'mqtt')
    ? `An MQTT 3.1.1 broker on port ${mqttPort()}, and over WebSocket at ${MOCK_MQTT_WEBSOCKET_PATH}`
    : 'Add an MQTT route to run a broker';
function setMqttPort(event: Event): void {
  const port = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(port)) return;
  (mock().mqtt ??= { port }).port = port;
  store.touch(mock().id);
}
function setGrpcPort(event: Event): void {
  const port = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(port)) return;
  (mock().grpc ??= { proto: '', port }).port = port;
  store.touch(mock().id);
}
/** Adds a gRPC route for each schema method that has none yet. */
function addGrpcRoutes(): void {
  const have = new Set(
    mock()
      .routes.filter((item) => mockRouteKind(item) === 'grpc')
      .map((item) => item.path),
  );
  const missing = grpcMethods.value.filter((method) => !have.has(method.path));
  for (const method of missing) {
    const created = store.addRoute(mock().id);
    if (created)
      store.updateRoute(mock().id, created.id, {
        kind: 'grpc',
        method: 'GET',
        path: method.path,
        status: 0,
        headers: [],
        body: '',
        name: method.path.split('/').pop(),
        stream: newMockStream('grpc'),
      });
  }
  toast(
    missing.length
      ? `Added ${missing.length} gRPC route${missing.length === 1 ? '' : 's'}`
      : 'Every method already has a route',
    missing.length ? 'success' : 'info',
  );
}
watch(
  () => [mock()?.id, mock()?.grpc?.proto],
  () => void inspectGrpc(),
  { immediate: true },
);
const tabs = (): UITab[] => [
  { name: 'Routes', icon: 'api', count: mock().routes.length },
  { name: 'Log', icon: 'format-list-text', count: store.logs.get(mock().id)?.length ?? 0 },
  { name: 'API docs', icon: 'file-document-outline', count: docOperations().length },
];
// API docs: the mock's routes as a browsable reference, and as OpenAPI, Swagger, or Markdown.
const docOperations = () => mockDocOperations(mock());
const docsOutput = () =>
  store.ui.docsFormat === 'Reference'
    ? undefined
    : mockDocumentation(mock(), store.ui.docsFormat as Exclude<MockDocFormat, 'Reference'>);
const docsLanguage = () =>
  store.ui.docsFormat === 'Markdown'
    ? 'markdown'
    : store.ui.docsFormat.endsWith('YAML')
      ? 'yaml'
      : 'json';
/** Routes the docs leave out: turned off, or live protocols OpenAPI does not describe. */
const undocumented = () =>
  mock().routes.filter(
    (item) =>
      !item.enabled || ['websocket', 'grpc', 'socketio', 'mqtt'].includes(mockRouteKind(item)),
  ).length;
function docsText(): string {
  return docsOutput()?.text ?? mockDocumentation(mock(), 'OpenAPI JSON').text;
}
function copyDocs(): void {
  void copyText(
    docsText(),
    store.ui.docsFormat === 'Reference' ? 'the OpenAPI document' : store.ui.docsFormat,
  );
}
function downloadDocs(): void {
  const output = docsOutput() ?? mockDocumentation(mock(), 'OpenAPI JSON');
  const name = mock().name.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'mock';
  saveFile(`${name}.${output.kind}.${output.extension}`, output.text, output.mime);
}
/** Saves the mock's OpenAPI document as a specification and opens it in APIs. */
function createSpec(id: string): void {
  if (specs.createFromMock(id)) openView('APIs');
}
/** Opens the route a documented operation comes from. */
function openDocRoute(routeId: string): void {
  store.selectRoute(routeId);
  store.ui.tab = 'Routes';
}
const portProblem = () => mockPortProblem(mock().port);
function setPort(event: Event): void {
  store.setPort(mock().id, Number((event.target as HTMLInputElement).value));
}
function update(patch: Partial<MockRoute>): void {
  const current = route();
  if (current) store.updateRoute(mock().id, current.id, patch);
}
/** Which answer is edited: -1 for the route's own, otherwise one of its other responses. */
const responseIndex = ref(-1);
/** The answer being edited: the route's own status, headers, body, and delay, or a response's. */
const answer = (): MockRoute | MockResponse | undefined =>
  (responseIndex.value >= 0 ? route()?.responses?.[responseIndex.value] : undefined) ?? route();
const answerKey = () => `${route()?.id}:${responseIndex.value}`;
function updateAnswer(patch: Partial<MockResponse>): void {
  const target = answer();
  if (!target) return;
  Object.assign(target, patch);
  store.touch(mock().id);
}
function updateNumber(field: 'status' | 'delayMs', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) updateAnswer({ [field]: Math.max(0, Math.round(value)) });
}
/**
 * The body editor's language, from the route's Content-Type header; plain text stays text, since
 * it was chosen, and a body without a type is recognised from how it starts.
 */
const bodyLanguage = () => {
  const type = contentType().split(';')[0].trim().toLowerCase();
  return type === 'text/plain' ? 'text' : detectLanguage(type, answer()?.body ?? '');
};
// The body's content type: the route's Content-Type header, chosen like a request's raw body.
const contentTypes: [string, string][] = [
  ...useRequestBodyStore().rawContentTypes.filter(([, value]) => value !== 'custom'),
  ['Problem JSON', 'application/problem+json'],
  ['Event stream', 'text/event-stream'],
  ['Binary', 'application/octet-stream'],
  ['Custom', 'custom'],
  ['None', 'none'],
];
const contentTypeOptions = contentTypes.map(([label, value]) => [value, label] as [string, string]);
const contentTypeRow = () =>
  answer()?.headers.find((row) => row.key.trim().toLowerCase() === 'content-type');
const contentType = () => (contentTypeRow()?.enabled ? contentTypeRow()!.value : '');
/** Set when Custom is chosen, so its field shows even for a value the list knows. */
const customType = ref(false);
watch(
  () => [store.ui.selected, store.ui.route],
  () => {
    customType.value = false;
    responseIndex.value = -1;
  },
);
watch(responseIndex, () => (customType.value = false));
const contentTypeChoice = () =>
  !contentType()
    ? 'none'
    : customType.value || !contentTypes.some(([, value]) => value === contentType())
      ? 'custom'
      : contentType();
/** Sets (or, with '', turns off) the Content-Type header, in place so the table keeps its rows. */
function setContentType(value: string): void {
  const current = answer();
  if (!current) return;
  const row = contentTypeRow();
  if (!value) {
    if (row) row.enabled = false;
  } else if (row) {
    row.value = value;
    row.enabled = true;
  } else current.headers.unshift({ key: 'Content-Type', value, enabled: true });
  store.touch(mock().id);
}
function chooseContentType(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  customType.value = value === 'custom';
  if (value === 'custom') setContentType(contentType() || 'application/json');
  else setContentType(value === 'none' ? '' : value);
}
const editorRuntime = WorkbenchEditor;
// Templates: insert one at the cursor, and preview the body as a request would get it.
const bodyEditor = ref<EditorHandle>();
const templateOptions = withIcons(
  MOCK_TEMPLATE_HELPERS.map((helper) => ({
    value: helper.template,
    label: helper.template,
    description: helper.description,
    group: helper.group,
  })),
  'code-braces',
);
/** Templates matching what is typed after `{{`, by name first, then by description. */
function templateCompletions(typed: string): EditorCompletion[] {
  const query = typed.trim().toLowerCase();
  const helpers = MOCK_TEMPLATE_HELPERS.filter(
    (helper) => !helper.template.startsWith('{{#repeat') || !query || '#repeat'.startsWith(query),
  );
  const named = helpers.filter((helper) =>
    helper.template.slice(2).toLowerCase().startsWith(query),
  );
  const described = helpers.filter(
    (helper) =>
      !named.includes(helper) &&
      `${helper.template} ${helper.description}`.toLowerCase().includes(query),
  );
  return [...named, ...described].map((helper) => ({
    text: helper.template,
    description: helper.description,
  }));
}
const templateChoice = ref('');
function insertTemplate(template: string): void {
  templateChoice.value = '';
  if (!template || !bodyEditor.value) return;
  bodyEditor.value.focus();
  bodyEditor.value.replaceSelection(template);
}
const previewing = ref(false);
/** Bumped by New sample, so the preview draws fresh fake values. */
const sample = ref(0);
const preview = computed(() => {
  void sample.value;
  const current = answer();
  if (!previewing.value || !current) return '';
  // Path parameters get their own names as values, so the preview shows where they go.
  const params = Object.fromEntries(
    (route()?.path.match(/:[^/]+/g) ?? []).map((part) => [part.slice(1), part.slice(1)]),
  );
  try {
    return renderMockBody(current.body, {
      params,
      query: new URLSearchParams(),
      headers: {},
      body: '',
    });
  } catch (error) {
    return `Mock template failed: ${errorMessage(error)}`;
  }
});
/** Formats the route's body in its language; a body edited meanwhile is left as it is. */
async function formatBody(): Promise<void> {
  const current = answer();
  if (!current) return;
  const original = current.body;
  try {
    const formatted = await editorRuntime.formatText(original, bodyLanguage());
    if (answer() !== current || current.body !== original)
      return toast(
        'The body changed while formatting. Format again to use the latest content.',
        'warning',
      );
    updateAnswer({ body: formatted });
  } catch (error) {
    toast(`Format failed: ${errorMessage(error)}`, 'error');
  }
}
/** Rules combine as all (the default) or any; stored only when it is any. */
function setRuleMode(target: { ruleMode?: 'all' | 'any' }, event: Event): void {
  if ((event.target as HTMLSelectElement).value === 'any') target.ruleMode = 'any';
  else delete target.ruleMode;
  store.touch(mock().id);
}
const ruleModeOptions = withIcons(
  [
    ['all', 'Match all rules'],
    ['any', 'Match any rule'],
  ],
  'filter-variant',
);
// The route's other responses: the editor below the chips edits the selected one.
const responses = () => route()?.responses ?? [];
const responseLabel = (response: MockResponse, index: number) =>
  response.name || `Response ${index + 2}`;
function addResponse(): void {
  const current = route();
  if (!current) return;
  (current.responses ??= []).push(newMockResponse(current));
  responseIndex.value = current.responses.length - 1;
  store.touch(mock().id);
  void nextTick(() => document.querySelector<HTMLInputElement>('#mock-response-name')?.focus());
}
function removeResponse(): void {
  const current = route();
  if (!current?.responses || responseIndex.value < 0) return;
  current.responses.splice(responseIndex.value, 1);
  if (!current.responses.length) delete current.responses;
  responseIndex.value = -1;
  store.touch(mock().id);
}
// HTTPS: the CA's certificate unless the person picked their own files.
/** Set when "My certificate files" is chosen, before any file is. */
const httpsFiles = ref(false);
watch(
  () => store.ui.selected,
  () => (httpsFiles.value = false),
);
const httpsSource = () =>
  httpsFiles.value || mock().https?.certFile || mock().https?.keyFile ? 'files' : 'ca';
function setHttps(patch: Partial<MockHttps>): void {
  const current = mock();
  current.https = { enabled: false, ...current.https, ...patch };
  for (const field of ['certFile', 'keyFile'] as const)
    if (!current.https[field]) delete current.https[field];
  store.touch(current.id);
}
function useCaCertificate(): void {
  httpsFiles.value = false;
  setHttps({ certFile: undefined, keyFile: undefined });
}
async function chooseHttpsFile(kind: 'cert' | 'key'): Promise<void> {
  const chosen = await window.workbench?.certificates?.choose(kind);
  if (chosen) setHttps(kind === 'cert' ? { certFile: chosen.path } : { keyFile: chosen.path });
}
async function trustAuthority(): Promise<void> {
  try {
    await window.workbench?.interceptor?.trustAuthority();
    toast('Asked the system to trust the API Workbench CA', 'success');
  } catch (error) {
    toast(
      errorMessage(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      'error',
    );
  }
}
async function exportAuthority(): Promise<void> {
  try {
    if (await window.workbench?.interceptor?.exportAuthority())
      toast('Saved the CA certificate', 'success');
  } catch (error) {
    toast(
      errorMessage(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      'error',
    );
  }
}
// Default headers: sent on every answer, starting with the security headers.
const defaultCount = () =>
  (mock().defaultHeaders ?? []).filter((row) => row.enabled && row.key.trim()).length;
function addSecurityHeaders(): void {
  const current = mock();
  const missing = missingSecurityHeaders(current.defaultHeaders);
  if (!missing.length) return;
  (current.defaultHeaders ??= []).push(...missing);
  store.touch(current.id);
  toast(`Added ${missing.length} security header${missing.length === 1 ? '' : 's'}`, 'success');
}
// CORS settings: the defaults are permissive, and a mock keeps its own once one is changed.
const cors = (): MockCorsOptions => mock().corsOptions ?? DEFAULT_MOCK_CORS;
function setCors<K extends keyof MockCorsOptions>(field: K, value: MockCorsOptions[K]): void {
  const current = mock();
  current.corsOptions = { ...cors(), [field]: value };
  store.touch(current.id);
}
function resetCors(): void {
  delete mock().corsOptions;
  store.touch(mock().id);
}
async function copyUrl(): Promise<void> {
  try {
    await navigator.clipboard.writeText(store.url(mock()));
    toast('Copied the mock URL', 'success');
  } catch {
    toast('Could not copy the URL', 'error');
  }
}
const routeName = (routeId?: string) =>
  routeId ? mock().routes.find((item) => item.id === routeId)?.path : undefined;
/** The other response that answered a logged request, by its label. */
const responseName = (routeId?: string, responseId?: string) => {
  const responses = mock().routes.find((item) => item.id === routeId)?.responses ?? [];
  const index = responses.findIndex((item) => item.id === responseId);
  return index < 0 ? undefined : responseLabel(responses[index], index);
};
const time = (value: string) => new Date(value).toLocaleTimeString();
// The log: filtered by search and status class, with the selected entry's details.
const LOG_FILTERS = ['All', '2xx', '3xx', '4xx', '5xx', 'No match'] as const;
const logEntries = () => store.logs.get(mock().id) ?? [];
const logGroup = (entry: MockLogEntry) =>
  entry.routeId || entry.status !== 404 ? `${Math.floor(entry.status / 100)}xx` : 'No match';
const logCounts = () => {
  const counts = new Map<string, number>();
  for (const entry of logEntries())
    counts.set(logGroup(entry), (counts.get(logGroup(entry)) || 0) + 1);
  return counts;
};
/** The route (and response) that answered, in words. */
function answeredBy(entry: MockLogEntry): string {
  const route = routeName(entry.routeId);
  if (!route) return entry.routeId ? 'A route since removed' : 'No route matched';
  const response = responseName(entry.routeId, entry.responseId);
  return response ? `${route} · ${response}` : route;
}
const filteredLog = () => {
  const query = store.ui.logQuery.trim().toLowerCase();
  return logEntries().filter(
    (entry) =>
      (store.ui.logStatus === 'All' || logGroup(entry) === store.ui.logStatus) &&
      (!query ||
        `${entry.method} ${entry.path} ${entry.status} ${answeredBy(entry)}`
          .toLowerCase()
          .includes(query)),
  );
};
const selectedLog = () => logEntries().find((entry) => entry.id === store.ui.logSelected);
const GRPC_STATUS_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
];
/** A log entry's status: a gRPC call's code with its name, a WebSocket's 101 as connected, else the HTTP status. */
const statusLabel = (entry: MockLogEntry) =>
  entry.protocol === 'grpc'
    ? `${entry.status} ${GRPC_STATUS_NAMES[entry.status] ?? ''}`.trim()
    : entry.protocol === 'websocket' && entry.status === 101
      ? '101 Connected'
      : String(entry.status);
const statusTone = (entry: MockLogEntry): UITone =>
  entry.protocol === 'grpc'
    ? entry.status === 0
      ? 'success'
      : 'danger'
    : !entry.routeId && entry.status === 404
      ? 'warning'
      : entry.status >= 400
        ? 'danger'
        : entry.status >= 300
          ? 'neutral'
          : 'success';
const logTabs = (): UITab[] => [
  { name: 'Request', icon: 'arrow-top-right' },
  { name: 'Response', icon: 'tray-arrow-down' },
];
const logMessage = () =>
  store.ui.logTab === 'Request' ? selectedLog()?.request : selectedLog()?.response;
const logQuery = () => {
  const path = selectedLog()?.path ?? '';
  const index = path.indexOf('?');
  return index < 0 ? [] : [...new URLSearchParams(path.slice(index + 1))];
};
const logLanguage = () => {
  const message = logMessage();
  const type =
    Object.entries(message?.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1] ?? '';
  return detectLanguage(type, message?.body ?? '');
};
function goToRoute(entry: MockLogEntry): void {
  if (!entry.routeId) return;
  store.selectRoute(entry.routeId);
  const responses = mock().routes.find((item) => item.id === entry.routeId)?.responses ?? [];
  store.ui.tab = 'Routes';
  void nextTick(() => {
    responseIndex.value = responses.findIndex((item) => item.id === entry.responseId);
  });
}
/** A log entry's badge: its method, or the protocol of a streamed exchange. */
const logBadge = (entry: MockLogEntry) =>
  entry.protocol && entry.protocol !== 'http' ? PROTOCOL_LABELS[entry.protocol] : entry.method;
const logBadgeClass = (entry: MockLogEntry) =>
  entry.protocol && entry.protocol !== 'http' ? entry.protocol.toUpperCase() : entry.method;
const logIcon = (entry: MockLogEntry): MdiIconName =>
  PROTOCOLS.find(([kind]) => kind === entry.protocol)?.[2] ?? methodIcon(entry.method);
/** The request as a cURL command, to send it again from a terminal. */
async function copyCurl(entry: MockLogEntry): Promise<void> {
  const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
  // The method came from whoever called the mock; HTTP allows `|`, `&`, and `$` in it.
  const parts = [
    `curl -X ${shellWord(entry.method)} ${shellQuote(store.url(mock()) + entry.path)}`,
  ];
  for (const [name, value] of Object.entries(entry.request?.headers ?? {}))
    if (!skip.has(name.toLowerCase())) parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  if (entry.request?.body) parts.push(`--data-raw ${shellQuote(entry.request.body)}`);
  try {
    await navigator.clipboard.writeText(parts.join(' \\\n  '));
    toast('Copied the request as cURL', 'success');
  } catch {
    toast('Could not copy the request', 'error');
  }
}

const mockActions: MenuItem[] = [
  { id: 'collection', label: 'Create collection from routes', icon: 'folder-plus-outline' },
  { id: 'export', label: 'Export as collection file…', icon: 'export' },
  { id: 'spec', label: 'Create API specification', icon: 'file-code-outline' },
  { id: 'duplicate', label: 'Duplicate', icon: 'content-copy', separated: true },
  { id: 'delete', label: 'Delete', icon: 'delete-outline', danger: true, separated: true },
];
function run(command: string, id: string): void {
  if (command === 'start') void store.start(id);
  else if (command === 'stop') void store.stop(id);
  else if (command === 'duplicate') store.duplicate(id);
  else if (command === 'collection') store.exportToCollection(id);
  else if (command === 'export') store.exportFile(id);
  else if (command === 'spec') createSpec(id);
  else if (command === 'delete') void store.remove(id);
  else if (command === 'rename')
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('#mock-name');
      input?.focus();
      input?.select();
    });
}
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<string>();
const menuItems = computed<MenuItem[]>(() => [
  menuFor.value && isRunning(menuFor.value)
    ? { id: 'stop', label: 'Stop', icon: 'stop-circle-outline' }
    : { id: 'start', label: 'Start', icon: 'play-circle-outline' },
  { id: 'rename', label: 'Rename', icon: 'pencil-outline' },
  ...mockActions,
]);
function onMenuSelect(command: string): void {
  const id = menuFor.value;
  if (!id) return;
  store.select(id);
  run(command, id);
}
// A route's context menu.
const {
  menu: routeMenu,
  target: routeFor,
  open: openRouteMenu,
  onKeydown: onRouteKeydown,
} = useContextMenu<string>();
const routeMenuItems = computed<MenuItem[]>(() => {
  const index = mock().routes.findIndex((item) => item.id === routeFor.value);
  const current = mock().routes[index];
  return [
    {
      id: 'toggle',
      label: current?.enabled ? 'Disable' : 'Enable',
      icon: current?.enabled ? 'close-circle-outline' : 'check-circle-outline',
    },
    { id: 'duplicate', label: 'Duplicate', icon: 'content-copy' },
    { id: 'up', label: 'Move up', icon: 'arrow-up', disabled: index <= 0 },
    {
      id: 'down',
      label: 'Move down',
      icon: 'arrow-down',
      disabled: index < 0 || index >= mock().routes.length - 1,
    },
    { id: 'delete', label: 'Delete', icon: 'delete-outline', danger: true, separated: true },
  ];
});
function onRouteMenuSelect(command: string): void {
  const id = routeFor.value;
  const current = mock().routes.find((item) => item.id === id);
  if (!id || !current) return;
  if (command === 'toggle') store.updateRoute(mock().id, id, { enabled: !current.enabled });
  else if (command === 'duplicate') store.duplicateRoute(mock().id, id);
  else if (command === 'up' || command === 'down')
    store.moveRoute(mock().id, id, command === 'up' ? -1 : 1);
  else if (command === 'delete') store.removeRoute(mock().id, id);
}
</script>

<template>
  <section class="panel mocks-page">
    <PageHeader
      eyebrow="WORKSPACE / DESIGN"
      guide="mocks"
      title="Mock servers"
      description="Serve canned responses on localhost while the real API is still being built."
    >
      <UiButton
        label="New mock server"
        icon="plus"
        variant="primary"
        data-mock-new
        @click="store.create()"
      />
    </PageHeader>
    <UiEmptyState
      v-if="!store.mocks().length"
      icon="server-network"
      title="No mock servers yet"
      description="Write routes by hand, answer with a collection's saved responses, or start one from an API specification."
    >
      <div class="spec-empty-actions">
        <UiButton label="New mock server" icon="plus" variant="primary" @click="store.create()" />
        <UiSelect
          v-model="fromCollection"
          class="field-input"
          aria-label="Create a mock server from a collection"
          placeholder="From a collection…"
          :options="withIcons(collectionNames, 'folder-outline')"
          @update:model-value="createFrom"
        />
        <UiButton
          v-if="specs.specs().length"
          label="From a specification"
          icon="file-code-outline"
          variant="ghost"
          @click="openView('APIs')"
        />
      </div>
    </UiEmptyState>
    <div v-else class="environments-layout">
      <nav class="environment-list" aria-label="Mock servers">
        <span class="eyebrow">MOCK SERVERS · {{ store.mocks().length }}</span>
        <ScrollRow class="environment-items" noun="mock servers">
          <button
            v-for="item in store.mocks()"
            :key="item.id"
            type="button"
            :class="['environment-item', { 'is-active': item.id === mock().id }]"
            :data-mock-select="item.id"
            :aria-pressed="item.id === mock().id"
            @click="store.select(item.id)"
            @contextmenu="openMenu($event, item.id)"
            @keydown="onRowKeydown($event, item.id)"
          >
            <MdiIcon
              name="server-network"
              :class="['environment-item-icon', { 'is-running': isRunning(item.id) }]"
            /><span class="environment-item-copy"
              ><strong>{{ item.name }}</strong
              ><small
                >:{{ item.port }} · {{ item.routes.length }} route{{
                  item.routes.length === 1 ? '' : 's'
                }}</small
              ><span v-if="protocolSummary(item).length" class="mock-item-protocols"
                ><span
                  v-for="part in protocolSummary(item)"
                  :key="part.kind"
                  :class="[
                    'mock-item-protocol',
                    part.kind === 'http' ? 'GET' : part.kind.toUpperCase(),
                  ]"
                  :data-mock-item-protocol="part.kind"
                  >{{ part.label }} {{ part.count }}</span
                ></span
              ></span
            ><UiBadge v-if="isRunning(item.id)" label="Running" tone="success" />
          </button>
        </ScrollRow>
        <label class="form-field spec-from-collection"
          ><span>New from a collection</span
          ><UiSelect
            v-model="fromCollection"
            class="field-input"
            data-mock-from-collection
            placeholder="Choose a collection…"
            :options="withIcons(collectionNames, 'folder-outline')"
            @update:model-value="createFrom"
        /></label>
        <ContextMenu
          ref="contextMenu"
          label="Mock server actions"
          :items="menuItems"
          data-mock-menu
          @select="onMenuSelect"
        />
      </nav>
      <div class="overview-card mock-editor">
        <div class="mock-server-header">
          <span
            :class="['mock-server-icon', { 'is-running': isRunning(mock().id) }]"
            aria-hidden="true"
            ><MdiIcon name="server-network"
          /></span>
          <div class="mock-server-title">
            <input
              id="mock-name"
              :key="mock().id"
              class="mock-name-input"
              :value="mock().name"
              maxlength="80"
              aria-label="Mock server name"
              title="Rename"
              @change="store.rename(mock().id, ($event.target as HTMLInputElement).value)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            />
            <div class="mock-server-meta">
              <UiBadge
                :label="isRunning(mock().id) ? 'Running' : 'Stopped'"
                :tone="isRunning(mock().id) ? 'success' : 'neutral'"
                :icon="isRunning(mock().id) ? 'play-circle-outline' : 'stop-circle-outline'"
                data-mock-state
              /><span
                >{{ mock().routes.length }} route{{ mock().routes.length === 1 ? '' : 's' }}</span
              ><span v-if="mock().source" class="spec-link"
                ><MdiIcon
                  :name="mock().source!.kind === 'spec' ? 'file-code-outline' : 'folder-outline'"
                />From {{ mock().source!.kind === 'spec' ? 'specification' : 'collection' }}
                {{ mock().source!.name }}</span
              ><span v-if="syncState()" class="mock-sync" data-mock-sync
                ><template v-if="syncState()!.missingRoutes || syncState()!.missingRequests"
                  ><MdiIcon name="sync" />{{ syncText() }}
                  <button
                    type="button"
                    class="mock-sync-button"
                    data-mock-sync-now
                    @click="store.syncWithCollection(mock().id)"
                  >
                    Sync now
                  </button></template
                ><template v-else
                  ><MdiIcon name="check-circle-outline" />In step with it</template
                ></span
              >
            </div>
          </div>
          <label class="mock-port-field"
            ><span>Port</span
            ><input
              id="mock-port"
              :key="mock().id"
              class="field-input"
              type="number"
              min="1024"
              max="65535"
              :value="mock().port"
              :aria-invalid="Boolean(portProblem())"
              aria-label="Port"
              @input="setPort"
              @change="store.commitPort(mock().id)"
          /></label>
          <UiButton
            v-if="isRunning(mock().id)"
            label="Stop"
            icon="stop-circle-outline"
            data-mock-stop
            :disabled="store.busy.has(mock().id)"
            @click="run('stop', mock().id)"
          /><UiButton
            v-else
            label="Start"
            icon="play-circle-outline"
            variant="primary"
            data-mock-start
            :disabled="store.busy.has(mock().id) || Boolean(portProblem())"
            @click="run('start', mock().id)"
          /><ActionMenu
            label="More mock server actions"
            :items="mockActions"
            data-mock-more
            @select="run($event, mock().id)"
          />
        </div>
        <p v-if="portProblem()" class="form-error" role="alert">{{ portProblem() }}</p>
        <div class="spec-status mock-status" data-mock-status>
          <span class="mock-status-label">Endpoints</span>
          <span class="mock-endpoint" data-mock-endpoint="http" data-method="GET"
            ><span class="mock-endpoint-label"><MdiIcon name="web" />HTTP</span
            ><code class="mock-url" data-mock-url>{{ store.url(mock()) }}</code
            ><UiIconButton
              label="Copy URL"
              icon="content-copy"
              data-mock-copy
              @click="void copyUrl()"
          /></span>
          <span
            v-for="endpoint in endpoints().slice(1)"
            :key="endpoint.kind"
            class="mock-endpoint"
            :data-mock-endpoint="endpoint.kind"
            :data-method="endpoint.kind.toUpperCase()"
            ><span class="mock-endpoint-label"
              ><MdiIcon :name="PROTOCOL_INFO[endpoint.kind].icon" />{{ endpoint.label }}</span
            ><code class="mock-url">{{ endpoint.address }}</code
            ><UiIconButton
              :label="`Copy ${endpoint.label} address`"
              icon="content-copy"
              @click="void copyText(endpoint.address, `the ${endpoint.label} address`)"
          /></span>
        </div>
        <dl class="mock-stats" data-mock-stats aria-label="Mock server at a glance">
          <div
            v-for="stat in stats()"
            :key="stat.label"
            :data-mock-stat="stat.key"
            :class="stat.tone"
          >
            <dt><MdiIcon :name="stat.icon" />{{ stat.label }}</dt>
            <dd>{{ stat.value }}</dd>
          </div>
        </dl>
        <!-- Server settings: a tile for each, with its state in words, and the open one's panel. -->
        <section
          class="mock-settings"
          aria-labelledby="mock-settings-title"
          data-mock-settings
          @keydown.esc="openSetting && closeSetting()"
        >
          <header class="mock-settings-head">
            <div>
              <h3 id="mock-settings-title">Server settings</h3>
              <p>Apply to every route of this mock; a running mock takes changes at once.</p>
            </div>
            <div class="mock-settings-health" data-mock-settings-health>
              <span class="mock-settings-health-item"
                ><MdiIcon name="check-circle-outline" />{{ settingsHealth().on }} of
                {{ settingTiles().length }} on</span
              >
              <span
                v-if="settingsHealth().attention.length"
                class="mock-settings-health-item is-warning"
                :title="
                  settingsHealth()
                    .attention.map((tile) => `${tile.title}: ${tile.status}`)
                    .join(', ')
                "
                ><MdiIcon name="alert-outline" />{{ settingsHealth().attention.length }} need{{
                  settingsHealth().attention.length === 1 ? 's' : ''
                }}
                attention</span
              >
            </div>
          </header>
          <div class="mock-settings-tiles">
            <button
              v-for="tile in settingTiles()"
              :key="tile.key"
              type="button"
              :class="[
                'mock-setting-tile',
                `is-${tile.tone}`,
                { selected: openSetting === tile.key },
              ]"
              :aria-expanded="openSetting === tile.key"
              aria-controls="mock-setting-panel"
              :data-mock-setting="tile.key"
              :data-mock-setting-tone="tile.tone"
              :data-mock-setting-count="tile.count"
              v-bind="{ [`data-mock-${tile.key}-settings`]: '' }"
              :title="tile.summary"
              @click="toggleSetting(tile.key)"
            >
              <span class="mock-setting-icon" aria-hidden="true"
                ><MdiIcon :name="tile.icon"
              /></span>
              <span class="mock-setting-copy"
                ><strong>{{ tile.title }}</strong
                ><span class="mock-setting-detail">{{ tile.detail }}</span></span
              >
              <span class="mock-setting-status" data-mock-setting-status
                ><MdiIcon :name="SETTING_STATUS_ICONS[tile.tone]" />{{ tile.status }}</span
              >
              <MdiIcon name="chevron-down" class="mock-setting-chevron" />
            </button>
          </div>
          <div
            v-show="openSetting"
            id="mock-setting-panel"
            class="mock-setting-panel"
            role="region"
            :aria-label="openTile() ? `${openTile()!.title} settings` : 'Server setting'"
          >
            <header v-if="openTile()" class="mock-setting-panel-head">
              <span class="mock-setting-icon" aria-hidden="true"
                ><MdiIcon :name="openTile()!.icon"
              /></span>
              <div class="mock-setting-panel-title">
                <strong>{{ openTile()!.title }}</strong
                ><span>{{ openTile()!.summary }}</span>
              </div>
              <!-- CORS and HTTPS have their own switch; the others are on while routes use them. -->
              <label v-if="openSetting === 'cors'" class="toggle-row mock-setting-switch"
                ><label class="toggle"
                  ><input
                    type="checkbox"
                    role="switch"
                    data-mock-cors
                    :checked="mock().cors"
                    @change="
                      store.setCors(mock().id, ($event.target as HTMLInputElement).checked)
                    " /><span></span></label
                ><span>Allow cross-origin requests</span></label
              >
              <label v-else-if="openSetting === 'https'" class="toggle-row mock-setting-switch"
                ><label class="toggle"
                  ><input
                    type="checkbox"
                    role="switch"
                    data-mock-https
                    :checked="mock().https?.enabled ?? false"
                    @change="
                      setHttps({ enabled: ($event.target as HTMLInputElement).checked })
                    " /><span></span></label
                ><span>Serve over HTTPS</span></label
              >
              <UiIconButton
                label="Close settings"
                icon="close"
                data-mock-setting-close
                @click="closeSetting"
              />
            </header>
            <!-- CORS: which origins, methods, and headers browsers may use, and for how long. -->
            <div
              v-show="openSetting === 'cors'"
              id="mock-cors-panel"
              :class="['mock-setting-body', { 'is-off': !mock().cors }]"
              data-mock-cors-panel
            >
              <p class="mock-setting-intro">
                Lets a web app on another origin call this mock: it answers browser preflight
                requests and adds CORS headers. Lists are comma-separated, and <code>*</code> allows
                any. Origins not listed get no CORS headers, as a real server would answer them.
              </p>
              <div class="mock-setting-groups">
                <fieldset class="mock-setting-group" :disabled="!mock().cors">
                  <legend>Who can call</legend>
                  <label class="form-field"
                    ><span>Allowed origins</span
                    ><input
                      class="field-input"
                      data-mock-cors-field="origins"
                      :disabled="!mock().cors"
                      :value="cors().origins"
                      spellcheck="false"
                      placeholder="*, or http://localhost:3000, https://app.example.com"
                      @input="setCors('origins', ($event.target as HTMLInputElement).value)"
                  /></label>
                  <label class="form-field"
                    ><span>Allowed methods</span
                    ><input
                      class="field-input"
                      data-mock-cors-field="methods"
                      :disabled="!mock().cors"
                      :value="cors().methods"
                      spellcheck="false"
                      @input="setCors('methods', ($event.target as HTMLInputElement).value)"
                  /></label>
                  <label class="form-field"
                    ><span>Allowed request headers</span
                    ><input
                      class="field-input"
                      data-mock-cors-field="headers"
                      :disabled="!mock().cors"
                      :value="cors().headers"
                      spellcheck="false"
                      placeholder="*, or Content-Type, Authorization"
                      @input="setCors('headers', ($event.target as HTMLInputElement).value)"
                  /></label>
                </fieldset>
                <fieldset class="mock-setting-group" :disabled="!mock().cors">
                  <legend>What browsers get</legend>
                  <label class="form-field"
                    ><span>Headers scripts can read</span
                    ><input
                      class="field-input"
                      data-mock-cors-field="exposeHeaders"
                      :disabled="!mock().cors"
                      :value="cors().exposeHeaders"
                      spellcheck="false"
                      placeholder="*, or X-Total-Count, ETag"
                      @input="setCors('exposeHeaders', ($event.target as HTMLInputElement).value)"
                  /></label>
                  <label class="form-field mock-cors-age"
                    ><span>Preflight cache (seconds)</span
                    ><input
                      class="field-input"
                      type="number"
                      min="0"
                      data-mock-cors-field="maxAge"
                      :disabled="!mock().cors"
                      :value="cors().maxAge"
                      @input="
                        setCors(
                          'maxAge',
                          Math.max(0, Number(($event.target as HTMLInputElement).value) || 0),
                        )
                      "
                  /></label>
                  <label class="toggle-row mock-setting-switch-row"
                    ><label class="toggle"
                      ><input
                        type="checkbox"
                        role="switch"
                        data-mock-cors-field="credentials"
                        :disabled="!mock().cors"
                        :checked="cors().credentials"
                        @change="
                          setCors('credentials', ($event.target as HTMLInputElement).checked)
                        " /><span></span></label
                    ><span
                      ><strong>Allow credentials</strong
                      ><small
                        >Cookies and Authorization; origins and headers are echoed instead of
                        *</small
                      ></span
                    ></label
                  >
                </fieldset>
              </div>
              <footer class="mock-setting-footer">
                <span v-if="mock().corsOptions" class="mock-setting-note"
                  ><MdiIcon name="tune-variant" />Customised for this mock</span
                ><span v-else class="mock-setting-note"
                  ><MdiIcon name="check-circle-outline" />Permissive defaults</span
                >
                <UiButton
                  label="Reset to permissive"
                  icon="refresh"
                  variant="ghost"
                  data-mock-cors-reset
                  :disabled="!mock().cors || !mock().corsOptions"
                  @click="resetCors"
                />
              </footer>
            </div>
            <!-- HTTPS: a certificate from the app's local CA, or the person's own files. -->
            <div
              v-show="openSetting === 'https'"
              id="mock-https-panel"
              :class="[
                'mock-setting-body',
                'mock-https-panel',
                { 'is-off': !mock().https?.enabled },
              ]"
              data-mock-https-panel
            >
              <p class="mock-setting-intro">
                The mock answers at
                <code>{{ store.url({ ...mock(), https: { enabled: true } }) }}</code
                >. Changing this restarts a running mock.
              </p>
              <div class="mock-https-sources" role="radiogroup" aria-label="Certificate">
                <label
                  ><input
                    type="radio"
                    name="mock-https-source"
                    value="ca"
                    data-mock-https-source="ca"
                    :checked="httpsSource() === 'ca'"
                    :disabled="!mock().https?.enabled"
                    @change="useCaCertificate"
                  /><span
                    ><strong>API Workbench CA</strong
                    ><small
                      >A certificate for localhost and 127.0.0.1 from the app's local CA, the one
                      the Interceptor uses. Browsers accept it once the CA is trusted.</small
                    ></span
                  ></label
                >
                <label
                  ><input
                    type="radio"
                    name="mock-https-source"
                    value="files"
                    data-mock-https-source="files"
                    :checked="httpsSource() === 'files'"
                    :disabled="!mock().https?.enabled"
                    @change="httpsFiles = true"
                  /><span
                    ><strong>My certificate files</strong
                    ><small>PEM certificate and key files, such as mkcert makes.</small></span
                  ></label
                >
              </div>
              <div v-if="httpsSource() === 'ca'" class="mock-https-actions">
                <UiButton
                  label="Trust the CA…"
                  icon="shield-lock-outline"
                  data-mock-trust-ca
                  :disabled="!mock().https?.enabled"
                  @click="trustAuthority"
                /><UiButton
                  label="Save CA certificate…"
                  icon="download"
                  variant="ghost"
                  :disabled="!mock().https?.enabled"
                  @click="exportAuthority"
                />
              </div>
              <div v-else class="mock-https-files">
                <template v-for="kind in ['cert', 'key'] as const" :key="kind">
                  <span>{{ kind === 'cert' ? 'Certificate' : 'Private key' }}</span>
                  <code :data-mock-https-file="kind">{{
                    (kind === 'cert' ? mock().https?.certFile : mock().https?.keyFile) ||
                    'None chosen'
                  }}</code>
                  <UiButton
                    label="Choose…"
                    icon="folder-search-outline"
                    variant="ghost"
                    :data-mock-https-choose="kind"
                    :disabled="!mock().https?.enabled"
                    @click="chooseHttpsFile(kind)"
                  />
                </template>
              </div>
              <p
                v-if="mockHttpsProblem(mock().https)"
                class="mock-setting-callout is-warning"
                role="alert"
              >
                <MdiIcon name="alert-outline" />
                {{ mockHttpsProblem(mock().https) }}
              </p>
            </div>
            <!-- Headers on every answer: the security headers to start, and any of the person's own. -->
            <div
              v-show="openSetting === 'defaults'"
              id="mock-defaults-panel"
              class="mock-setting-body"
              data-mock-defaults-panel
            >
              <p class="mock-setting-intro">
                Sent on every answer, including 404s and preflights; a route's own header of the
                same name wins.
              </p>
              <div
                v-if="missingSecurityHeaders(mock().defaultHeaders).length"
                class="mock-setting-callout is-warning"
                data-mock-security-missing
              >
                <MdiIcon name="shield-lock-outline" />
                <span
                  ><strong
                    >{{
                      plural(
                        missingSecurityHeaders(mock().defaultHeaders).length,
                        'security header',
                      )
                    }}
                    missing</strong
                  >
                  {{
                    missingSecurityHeaders(mock().defaultHeaders)
                      .map((row) => row.key)
                      .join(', ')
                  }}</span
                >
                <UiButton
                  label="Add security headers"
                  icon="shield-lock-outline"
                  variant="ghost"
                  data-mock-add-security
                  @click="addSecurityHeaders"
                />
              </div>
              <p v-else class="mock-setting-callout is-ok" data-mock-security-complete>
                <MdiIcon name="check-circle-outline" />Every recommended security header is sent.
                <UiButton
                  label="Add security headers"
                  icon="shield-lock-outline"
                  variant="ghost"
                  data-mock-add-security
                  disabled
                />
              </p>
              <!-- Keyed by mock, so switching never carries a draft row across. -->
              <KeyValueTable
                :key="`defaults-${mock().id}`"
                type="headers"
                detached
                :rows="() => mock().defaultHeaders ?? []"
                :create="() => (mock().defaultHeaders ??= [])"
                :changed="() => store.touch(mock().id)"
              />
            </div>
            <!-- gRPC: the schema the mock's gRPC routes implement, served on its own port. -->
            <div
              v-show="openSetting === 'grpc'"
              id="mock-grpc-panel"
              class="mock-setting-body mock-grpc-panel"
              data-mock-grpc-panel
            >
              <p class="mock-setting-intro">
                gRPC routes are served over plaintext HTTP/2 on their own port, from this
                self-contained .proto schema. Each route answers one method; calls to methods
                without a route get UNIMPLEMENTED.
              </p>
              <p
                v-if="settingTiles().find((tile) => tile.key === 'grpc')?.status === 'Needs schema'"
                class="mock-setting-callout is-warning"
              >
                <MdiIcon name="alert-outline" />This mock has gRPC routes but no schema: paste one
                below, and they are served from it.
              </p>
              <div class="mock-grpc-fields">
                <label class="form-field mock-number"
                  ><span>gRPC port</span
                  ><input
                    id="mock-grpc-port"
                    class="field-input"
                    type="number"
                    min="1024"
                    max="65535"
                    :value="mock().grpc?.port ?? ''"
                    :placeholder="String(freeMockGrpcPort(store.mocks(), mock().port))"
                    @change="setGrpcPort"
                /></label>
                <code v-if="mock().grpc" class="mock-url" data-mock-grpc-url
                  >127.0.0.1:{{ mock().grpc!.port }}</code
                >
                <span class="flex-1"></span>
                <UiButton
                  label="Add routes for every method"
                  icon="plus"
                  variant="ghost"
                  data-mock-grpc-add-routes
                  :disabled="!grpcMethods.length"
                  @click="addGrpcRoutes"
                />
              </div>
              <SourceEditor
                id="mock-grpc-proto"
                :key="`grpc-${mock().id}`"
                class="source-editor-host mock-grpc-proto"
                :value="mock().grpc?.proto ?? ''"
                language="protobuf"
                :wrap="workspace.settings().wordWrap"
                label="gRPC schema (.proto)"
                context-menu
                @change="setGrpcProto"
              />
              <p v-if="grpcError" class="form-error mock-cors-help" role="alert">{{ grpcError }}</p>
              <ul
                v-else-if="grpcMethods.length"
                class="mock-grpc-methods"
                aria-label="Schema methods"
              >
                <li v-for="method in grpcMethods" :key="method.path">
                  <code>{{ method.path }}</code
                  ><span>{{ grpcKind(method) }}</span>
                  <UiBadge
                    v-if="
                      mock().routes.some(
                        (item) => mockRouteKind(item) === 'grpc' && item.path === method.path,
                      )
                    "
                    label="Route"
                    tone="success"
                  />
                </li>
              </ul>
            </div>
            <!-- MQTT: the broker MQTT routes publish through, on its own port. -->
            <div
              v-show="openSetting === 'mqtt'"
              class="mock-setting-body mock-grpc-panel"
              data-mock-mqtt-panel
            >
              <p class="mock-setting-intro">
                MQTT routes run on an MQTT 3.1.1 broker. It runs while the mock has an MQTT route,
                and clients can also publish to each other through it.
              </p>
              <div class="mock-grpc-fields">
                <label class="form-field mock-number"
                  ><span>MQTT port</span
                  ><input
                    id="mock-mqtt-port"
                    class="field-input"
                    type="number"
                    min="1024"
                    max="65535"
                    :value="mqttPort()"
                    @change="setMqttPort"
                /></label>
              </div>
              <dl class="mock-setting-addresses">
                <div>
                  <dt>TCP</dt>
                  <dd>
                    <code data-mock-mqtt-url>mqtt://127.0.0.1:{{ mqttPort() }}</code
                    ><UiIconButton
                      label="Copy MQTT address"
                      icon="content-copy"
                      @click="copyText(`mqtt://127.0.0.1:${mqttPort()}`, 'the MQTT address')"
                    />
                  </dd>
                </div>
                <div>
                  <dt>WebSocket</dt>
                  <dd>
                    <code
                      >{{ store.url(mock()).replace(/^http/, 'ws')
                      }}{{ MOCK_MQTT_WEBSOCKET_PATH }}</code
                    ><UiIconButton
                      label="Copy MQTT over WebSocket address"
                      icon="content-copy"
                      @click="
                        copyText(
                          `${store.url(mock()).replace(/^http/, 'ws')}${MOCK_MQTT_WEBSOCKET_PATH}`,
                          'the MQTT over WebSocket address',
                        )
                      "
                    />
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </section>
        <UiTabs
          group="mock"
          label="Mock server views"
          :items="tabs()"
          :active="store.ui.tab"
          attribute="data-mock-tab"
          class="spec-tabs"
          @select="store.ui.tab = $event as MockTab"
        />
        <div id="mock-panel" role="tabpanel" class="spec-panel">
          <div v-if="store.ui.tab === 'Routes'" class="mock-routes">
            <div class="mock-route-list">
              <div class="table-label">
                <div>
                  <strong>Routes</strong><span>First match with the most fixed segments wins</span>
                </div>
                <span class="mock-add-route"
                  ><UiButton
                    label="Add route"
                    icon="plus"
                    variant="ghost"
                    data-mock-add-route
                    @click="store.addRoute(mock().id)" /><ActionMenu
                    label="Add a route for a protocol"
                    icon="chevron-down"
                    :items="addRouteItems"
                    data-mock-add-route-kind
                    @select="addRouteOf"
                /></span>
              </div>
              <label class="cookie-filter history-search mock-route-search"
                ><MdiIcon name="magnify" /><input
                  v-model="routeQuery"
                  type="search"
                  placeholder="Filter by method, path, or name"
                  aria-label="Filter routes"
                  data-mock-route-search
              /></label>
              <p
                v-if="routeQuery.trim() && !routeGroups().length"
                class="field-help mock-route-none"
              >
                No routes match “{{ routeQuery.trim() }}”.
              </p>
              <div class="tree mock-route-tree" role="tree" aria-label="Routes">
                <div
                  v-for="group in routeGroups()"
                  :key="group.kind"
                  class="collection-group mock-route-group"
                  :data-mock-route-group="group.kind"
                >
                  <div class="collection-folder-heading">
                    <button
                      type="button"
                      class="folder"
                      :data-mock-route-group-toggle="group.kind"
                      :aria-expanded="!collapsedGroups.has(group.kind)"
                      @click="toggleGroup(group.kind)"
                    >
                      <span class="folder-chevron"
                        ><MdiIcon
                          :name="
                            collapsedGroups.has(group.kind) ? 'chevron-right' : 'chevron-down'
                          " /></span
                      ><span
                        class="folder-icon mock-route-group-icon"
                        :data-method="group.kind === 'http' ? 'GET' : group.kind.toUpperCase()"
                        ><MdiIcon :name="PROTOCOL_INFO[group.kind].icon" /></span
                      ><span>{{ PROTOCOL_INFO[group.kind].group }}</span
                      ><small>{{ group.routes.length }}</small>
                    </button>
                  </div>
                  <ul
                    v-show="!collapsedGroups.has(group.kind)"
                    class="collection-requests mock-route-items"
                    :aria-label="`${PROTOCOL_INFO[group.kind].group} routes`"
                  >
                    <li v-for="item in group.routes" :key="item.id" class="collection-request-row">
                      <button
                        type="button"
                        :class="[
                          'request-item',
                          'mock-route-item',
                          {
                            active: item.id === route()?.id,
                            'is-active': item.id === route()?.id,
                            disabled: !item.enabled,
                          },
                        ]"
                        :data-mock-route="item.id"
                        :aria-pressed="item.id === route()?.id"
                        :title="`${routeBadge(item)} ${item.path}${item.enabled ? '' : ' (off)'}`"
                        @click="store.selectRoute(item.id)"
                        @contextmenu="openRouteMenu($event, item.id)"
                        @keydown="onRouteKeydown($event, item.id)"
                      >
                        <span :class="['method', routeBadgeClass(item)]"
                          ><MdiIcon :name="routeIcon(item)" class="method-icon" />{{
                            routeBadge(item)
                          }}</span
                        ><span class="mock-route-copy"
                          ><span class="mock-route-name">{{ item.name || item.path }}</span
                          ><small v-if="item.name && item.name !== item.path">{{
                            item.path
                          }}</small></span
                        ><span
                          v-if="item.rules?.some((rule) => rule.enabled)"
                          class="mock-route-rules"
                          :title="`${item.rules!.filter((rule) => rule.enabled).length} request rule(s)`"
                          ><MdiIcon name="filter-variant" />{{
                            item.rules!.filter((rule) => rule.enabled).length
                          }}</span
                        ><span
                          v-if="item.validation?.enabled"
                          class="mock-route-validates"
                          title="Validates requests"
                          ><MdiIcon name="check-circle-outline" /></span
                        ><span
                          v-if="isStreamRoute(item)"
                          class="mock-route-status ok"
                          :title="`${item.stream?.messages.length ?? 0} message(s)`"
                          ><MdiIcon name="format-list-bulleted" />{{
                            item.stream?.messages.length ?? 0
                          }}</span
                        ><span
                          v-else
                          :class="[
                            'mock-route-status',
                            item.status >= 400 ? 'error' : item.status >= 300 ? 'redirect' : 'ok',
                          ]"
                          >{{ item.status }}</span
                        >
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
              <UiEmptyState
                v-if="!mock().routes.length"
                icon="api"
                title="No routes"
                description="Every request gets a 404 until you add a route."
              />
              <ContextMenu
                ref="routeMenu"
                label="Route actions"
                :items="routeMenuItems"
                data-mock-route-menu
                @select="onRouteMenuSelect"
              />
            </div>
            <div v-if="route()" :key="route()!.id" class="mock-route-editor" data-mock-route-editor>
              <div class="mock-route-fields">
                <!-- The method and path, in the same bar a request's method and URL use. -->
                <div class="request-composer mock-composer">
                  <div class="urlbar">
                    <UiSelect
                      id="mock-route-method"
                      aria-label="Route method or protocol"
                      class="method-select"
                      :data-method="routeBadgeClass(route()!)"
                      :root-attrs="{
                        'data-method': routeBadgeClass(route()!),
                        'data-mock-route-kind': mockRouteKind(route()!),
                      }"
                      :searchable="false"
                      :value="routeType(route()!)"
                      :options="withIcons(methodOptions, 'swap-horizontal')"
                      @change="setRouteType"
                    /><code class="mock-composer-origin" :title="routeOrigin()">{{
                      routeOrigin()
                    }}</code
                    ><input
                      id="mock-route-path"
                      :value="route()!.path"
                      spellcheck="false"
                      :aria-label="PATH_FIELD[mockRouteKind(route()!)]?.[0] ?? 'Route path'"
                      :placeholder="PATH_FIELD[mockRouteKind(route()!)]?.[1] ?? '/users/:id'"
                      :list="mockRouteKind(route()!) === 'grpc' ? 'mock-grpc-methods' : undefined"
                      @input="
                        update({ path: ($event.target as HTMLInputElement).value.trim() || '/' })
                      "
                    /><datalist id="mock-grpc-methods">
                      <option
                        v-for="method in grpcMethods"
                        :key="method.path"
                        :value="method.path"
                        :label="grpcKind(method)"
                      ></option>
                    </datalist>
                  </div>
                </div>
                <div class="mock-route-actions">
                  <label class="toggle-row mock-route-toggle"
                    ><label class="toggle"
                      ><input
                        id="mock-route-enabled"
                        type="checkbox"
                        role="switch"
                        :checked="route()!.enabled"
                        @change="
                          update({ enabled: ($event.target as HTMLInputElement).checked })
                        " /><span></span></label
                    ><span>{{ route()!.enabled ? 'On' : 'Off' }}</span></label
                  ><UiIconButton
                    label="Duplicate route"
                    icon="content-copy"
                    data-mock-route-duplicate
                    @click="store.duplicateRoute(mock().id, route()!.id)"
                  /><UiIconButton
                    label="Delete route"
                    icon="delete-outline"
                    class="danger"
                    data-mock-route-delete
                    @click="store.removeRoute(mock().id, route()!.id)"
                  />
                </div>
              </div>
              <!-- What this kind of route does, how its messages flow, and how to try it. -->
              <section
                class="mock-protocol-card"
                :data-method="routeBadgeClass(route()!)"
                :data-mock-protocol-card="mockRouteKind(route()!)"
                :aria-label="PROTOCOL_INFO[mockRouteKind(route()!)].title"
              >
                <span class="mock-protocol-icon" aria-hidden="true"
                  ><MdiIcon :name="PROTOCOL_INFO[mockRouteKind(route()!)].icon"
                /></span>
                <div class="mock-protocol-copy">
                  <strong
                    >{{ PROTOCOL_INFO[mockRouteKind(route()!)].title
                    }}<UiBadge
                      v-if="mockRouteKind(route()!) === 'grpc' && routeGrpcMethod()"
                      :label="grpcKind(routeGrpcMethod()!)"
                      tone="neutral" /><UiBadge
                      v-else-if="mockRouteKind(route()!) === 'grpc' && grpcMethods.length"
                      label="Not in the schema"
                      tone="warning"
                  /></strong>
                  <span>{{ PROTOCOL_INFO[mockRouteKind(route()!)].summary }}</span>
                  <ol v-if="flowSteps().length" class="mock-protocol-flow" aria-label="How it runs">
                    <li v-for="step in flowSteps()" :key="step">{{ step }}</li>
                  </ol>
                  <div class="mock-protocol-try">
                    <span>Try it</span><code data-mock-try>{{ tryCommand() }}</code
                    ><UiIconButton
                      label="Copy command"
                      icon="content-copy"
                      data-mock-try-copy
                      @click="void copyText(tryCommand(), 'the command')"
                    /><UiIconButton
                      v-if="hasTerminal"
                      label="Run in terminal"
                      icon="console"
                      data-mock-try-terminal
                      @click="ui.runInTerminal(tryCommand())"
                    />
                  </div>
                </div>
              </section>
              <div class="table-label mock-route-steps">
                <div>
                  <strong>Route steps</strong
                  ><span>Match the request, validate it, then answer</span>
                </div>
                <button
                  type="button"
                  class="text-button mock-sections-all"
                  data-mock-sections-all
                  @click="toggleAllSections"
                >
                  <MdiIcon :name="allCollapsed() ? 'chevron-down' : 'chevron-up'" />{{
                    allCollapsed() ? 'Expand all' : 'Collapse all'
                  }}
                </button>
              </div>
              <UiExpansionPanel
                class="mock-route-panel"
                data-mock-section="match"
                title="Match"
                icon="filter-variant"
                :description="matchSummary()"
                :badge="matchBadge() || undefined"
                :open="!store.ui.collapsed.match"
                @update:open="store.ui.collapsed.match = !$event"
              >
                <div id="mock-section-match-body" class="mock-section-body">
                  <template v-if="mockRouteKind(route()!) !== 'grpc'">
                    <div class="table-label">
                      <div>
                        <strong>Path parameters</strong><span>{{ pathParamsHelp() }}</span>
                      </div>
                    </div>
                    <MockPathParamsTable
                      :key="`params-${route()!.id}`"
                      :route="() => route()!"
                      :changed="() => store.touch(mock().id)"
                      :constrained="pathParamConstrained"
                    />
                  </template>
                  <div class="table-label">
                    <div>
                      <strong data-mock-rules-title>{{ rulesTitle() }}</strong
                      ><span>{{
                        route()!.rules?.length ? rulesActiveHelp() : rulesEmptyHelp()
                      }}</span>
                    </div>
                    <UiSelect
                      v-if="(route()!.rules?.length ?? 0) > 1"
                      id="mock-rule-mode"
                      class="field-input mock-rule-mode"
                      aria-label="How the route's rules combine"
                      :value="route()!.ruleMode === 'any' ? 'any' : 'all'"
                      :options="withIcons(ruleModeOptions, 'filter-variant')"
                      @change="setRuleMode(route()!, $event)"
                    />
                  </div>
                  <MockRulesTable
                    :key="`route-${route()!.id}`"
                    :protocol="mockRouteKind(route()!)"
                    kind="route"
                    :rules="() => route()!.rules ?? []"
                    :create="() => (route()!.rules ??= [])"
                    :changed="() => store.touch(mock().id)"
                  />
                </div>
              </UiExpansionPanel>
              <!-- MQTT messages have no request to validate; rules pick them instead. -->
              <UiExpansionPanel
                v-if="mockRouteKind(route()!) !== 'mqtt'"
                class="mock-route-panel"
                data-mock-section="validate"
                title="Validate"
                icon="check-circle-outline"
                :description="describeValidation(route()!.validation, route()!.pathParams)"
                :badge="validateBadge() || undefined"
                :open="!store.ui.collapsed.validate"
                @update:open="store.ui.collapsed.validate = !$event"
              >
                <div id="mock-section-validate-body" class="mock-section-body">
                  <label class="toggle-row mock-validate-enabled"
                    ><label class="toggle"
                      ><input
                        id="mock-validate-enabled"
                        type="checkbox"
                        role="switch"
                        :checked="route()!.validation?.enabled === true"
                        @change="
                          setValidationEnabled(($event.target as HTMLInputElement).checked)
                        " /><span></span></label
                    ><span>Validate requests before answering</span></label
                  >
                  <p class="field-help mock-validate-intro">{{ validateIntro() }}</p>
                  <template v-if="route()!.validation?.enabled">
                    <div class="table-label">
                      <div>
                        <strong>Required</strong
                        ><span>Each must pass, or the request gets the failure answer below</span>
                      </div>
                    </div>
                    <MockRulesTable
                      :key="`validation-${route()!.id}`"
                      kind="validation"
                      :protocol="mockRouteKind(route()!)"
                      :rules="() => route()!.validation!.checks"
                      :create="() => route()!.validation!.checks"
                      :changed="() => store.touch(mock().id)"
                    />
                    <template v-if="mockRouteKind(route()!) !== 'grpc'">
                      <div class="table-label">
                        <div>
                          <strong>Request</strong
                          ><span>{{
                            mockRouteKind(route()!) === 'websocket'
                              ? 'What the handshake may carry'
                              : 'What the request may send, before its values are checked'
                          }}</span>
                        </div>
                      </div>
                      <div class="mock-route-fields mock-validate-request">
                        <label
                          v-if="mockRouteKind(route()!) !== 'websocket'"
                          class="form-field flex-1"
                          ><span>Allowed content types</span
                          ><input
                            id="mock-validate-content-types"
                            class="field-input"
                            spellcheck="false"
                            placeholder="Any; such as application/json, multipart/*"
                            :value="route()!.validation!.contentTypes ?? ''"
                            @input="
                              setValidation({
                                contentTypes:
                                  ($event.target as HTMLInputElement).value || undefined,
                              })
                            "
                        /></label>
                        <label
                          v-if="mockRouteKind(route()!) !== 'websocket'"
                          class="form-field mock-number"
                          ><span>Max body (bytes)</span
                          ><input
                            id="mock-validate-max-body"
                            class="field-input"
                            type="number"
                            min="0"
                            placeholder="Any"
                            :value="route()!.validation!.maxBodyBytes ?? ''"
                            @input="setMaxBody"
                        /></label>
                        <label class="toggle-row mock-validate-strict"
                          ><label class="toggle"
                            ><input
                              id="mock-validate-strict-query"
                              type="checkbox"
                              role="switch"
                              :checked="route()!.validation!.strictQuery === true"
                              @change="
                                setValidation({
                                  strictQuery:
                                    ($event.target as HTMLInputElement).checked || undefined,
                                })
                              " /><span></span></label
                          ><span>Reject query parameters not named in a check or rule</span></label
                        >
                      </div>
                    </template>
                    <template v-if="mockRouteKind(route()!) !== 'websocket'">
                      <div class="table-label">
                        <div>
                          <strong>{{
                            mockRouteKind(route()!) === 'grpc' ? 'Message schema' : 'Body schema'
                          }}</strong
                          ><span>{{
                            mockRouteKind(route()!) === 'grpc'
                              ? 'A JSON Schema the request message must satisfy (unary and server-streaming calls)'
                              : 'A JSON Schema the request body must satisfy: JSON, or form fields typed by the schema. $ref, if/then/else, and more are supported'
                          }}</span>
                        </div>
                        <UiButton
                          label="Schema from sample"
                          icon="auto-fix"
                          variant="ghost"
                          data-mock-schema-infer
                          :title="'Describe the sample in the test box below as a schema'"
                          @click="inferSchema"
                        />
                      </div>
                      <SourceEditor
                        id="mock-validate-schema"
                        :key="`schema-${route()!.id}`"
                        class="source-editor-host mock-schema-editor"
                        :value="route()!.validation!.schema ?? ''"
                        language="json"
                        :wrap="workspace.settings().wordWrap"
                        label="Request body schema"
                        context-menu
                        formattable
                        @change="setValidation({ schema: $event || undefined })"
                        @format="formatSchema"
                      />
                      <p
                        v-if="mockSchemaProblem(route()!.validation!.schema)"
                        class="form-error"
                        role="alert"
                      >
                        {{ mockSchemaProblem(route()!.validation!.schema) }}
                      </p>
                    </template>
                    <div class="mock-route-fields mock-answer-fields mock-validate-failure">
                      <label
                        v-if="mockRouteKind(route()!) !== 'grpc'"
                        class="form-field mock-number"
                        ><span>Failure status</span
                        ><input
                          id="mock-validate-status"
                          class="field-input"
                          type="number"
                          min="400"
                          max="599"
                          :value="route()!.validation!.status"
                          @input="setValidationStatus"
                      /></label>
                      <p v-else class="field-help">
                        Calls that fail end with INVALID_ARGUMENT and the problems as the message.
                      </p>
                      <label v-if="mockRouteKind(route()!) !== 'grpc'" class="form-field flex-1"
                        ><span>Failure body (optional)</span
                        ><textarea
                          id="mock-validate-body"
                          class="field-input mock-stream-data"
                          rows="2"
                          spellcheck="false"
                          :value="route()!.validation!.body ?? ''"
                          :placeholder="failurePlaceholder"
                          @input="
                            setValidation({
                              body: ($event.target as HTMLTextAreaElement).value || undefined,
                            })
                          "
                        ></textarea>
                      </label>
                    </div>
                    <template v-if="mockRouteKind(route()!) !== 'websocket'">
                      <div class="table-label">
                        <div>
                          <strong>Test a body</strong
                          ><span>See whether a request body passes, without sending one</span>
                        </div>
                      </div>
                      <div class="mock-validate-test">
                        <textarea
                          id="mock-validate-sample"
                          v-model="validationSample"
                          class="field-input mock-stream-data"
                          rows="3"
                          spellcheck="false"
                          aria-label="A request body to test"
                          placeholder='{"sku": "TSHIRT-1", "quantity": 2}'
                        ></textarea>
                        <div
                          class="mock-validate-result"
                          data-mock-validate-result
                          aria-live="polite"
                        >
                          <template v-if="!validationSample.trim()">
                            <span class="field-help">Type a body to test it.</span>
                          </template>
                          <template v-else-if="!sampleProblems().length">
                            <MdiIcon name="check-circle-outline" class="is-ok" /><span
                              >Passes the body checks</span
                            >
                          </template>
                          <template v-else>
                            <strong
                              ><MdiIcon name="alert-circle-outline" class="is-bad" />Gets
                              {{
                                mockRouteKind(route()!) === 'grpc'
                                  ? 'INVALID_ARGUMENT'
                                  : route()!.validation!.status
                              }}:</strong
                            >
                            <ul>
                              <li v-for="problem in sampleProblems()" :key="problem.message">
                                {{ problem.message }}
                              </li>
                            </ul>
                          </template>
                        </div>
                      </div>
                    </template>
                  </template>
                </div>
              </UiExpansionPanel>
              <UiExpansionPanel
                class="mock-route-panel"
                data-mock-section="respond"
                :title="isStreamRoute(route()!) ? 'Stream' : 'Respond'"
                :icon="isStreamRoute(route()!) ? 'format-list-bulleted' : 'code-json'"
                :description="respondSummary()"
                :badge="respondBadge() || undefined"
                :open="!store.ui.collapsed.respond"
                @update:open="store.ui.collapsed.respond = !$event"
              >
                <div id="mock-section-respond-body" class="mock-section-body">
                  <template v-if="isStreamRoute(route()!)">
                    <p
                      v-if="mockRouteKind(route()!) === 'grpc' && !mock().grpc?.proto.trim()"
                      class="mock-setting-callout is-warning mock-grpc-missing"
                      role="alert"
                    >
                      <MdiIcon name="alert-outline" /><span
                        >Add the .proto schema in the mock's gRPC settings; gRPC routes are served
                        from it.</span
                      ><UiButton
                        label="Open gRPC settings"
                        icon="api"
                        variant="ghost"
                        data-mock-open-grpc-settings
                        @click="showSetting('grpc')"
                      />
                    </p>
                    <template v-if="['sse', 'ndjson'].includes(mockRouteKind(route()!))">
                      <div class="table-label">
                        <div>
                          <strong>Response headers</strong
                          ><span
                            >Content-Type and Cache-Control are set for the stream; add your own
                            here</span
                          >
                        </div>
                      </div>
                      <KeyValueTable
                        :key="`stream-${route()!.id}`"
                        type="headers"
                        detached
                        :rows="() => route()!.headers"
                        :changed="() => store.touch(mock().id)"
                      />
                    </template>
                    <MockStreamEditor
                      :key="`stream-editor-${route()!.id}`"
                      :route="() => route()!"
                      :changed="() => store.touch(mock().id)"
                    />
                  </template>
                  <template v-else>
                    <div class="table-label">
                      <div>
                        <strong>Responses</strong
                        ><span
                          >The first response whose rules pass answers; otherwise the default</span
                        >
                      </div>
                      <UiButton
                        label="Add response"
                        icon="plus"
                        variant="ghost"
                        data-mock-add-response
                        @click="addResponse"
                      />
                    </div>
                    <ScrollRow
                      class="segmented-control mock-responses"
                      frame-class="mock-responses-frame"
                      role="group"
                      aria-label="Responses"
                      noun="responses"
                    >
                      <button
                        type="button"
                        data-mock-response="default"
                        :aria-pressed="responseIndex < 0"
                        :class="{ selected: responseIndex < 0 }"
                        @click="responseIndex = -1"
                      >
                        Default · {{ route()!.status }}
                      </button>
                      <button
                        v-for="(item, index) in responses()"
                        :key="item.id"
                        type="button"
                        :data-mock-response="index"
                        :aria-pressed="responseIndex === index"
                        :class="{ selected: responseIndex === index }"
                        @click="responseIndex = index"
                      >
                        <MdiIcon name="filter-variant" />{{ responseLabel(item, index) }} ·
                        {{ item.status }}
                      </button>
                    </ScrollRow>
                    <template v-if="responseIndex >= 0 && answer() !== route()">
                      <div class="mock-response-heading">
                        <label class="form-field mb-0 flex-1"
                          ><span>Response name</span
                          ><input
                            id="mock-response-name"
                            :key="answerKey()"
                            class="field-input"
                            :value="(answer() as MockResponse).name ?? ''"
                            :placeholder="responseLabel(answer() as MockResponse, responseIndex)"
                            maxlength="60"
                            @change="
                              updateAnswer({
                                name: ($event.target as HTMLInputElement).value.trim() || undefined,
                              })
                            "
                        /></label>
                        <UiButton
                          label="Remove response"
                          icon="delete-outline"
                          variant="danger"
                          class="self-end"
                          data-mock-remove-response
                          @click="removeResponse"
                        />
                      </div>
                      <div class="table-label">
                        <div>
                          <strong>When</strong
                          ><span>{{
                            (answer() as MockResponse).rules.length
                              ? 'This response answers requests that meet these rules'
                              : 'Add a rule; a response without rules is never used'
                          }}</span>
                        </div>
                        <UiSelect
                          v-if="(answer() as MockResponse).rules.length > 1"
                          id="mock-response-rule-mode"
                          class="field-input mock-rule-mode"
                          aria-label="How the response's rules combine"
                          :value="(answer() as MockResponse).ruleMode === 'any' ? 'any' : 'all'"
                          :options="withIcons(ruleModeOptions, 'filter-variant')"
                          @change="setRuleMode(answer() as MockResponse, $event)"
                        />
                      </div>
                      <MockRulesTable
                        :key="`response-${answerKey()}`"
                        kind="response"
                        :rules="() => (answer() as MockResponse).rules"
                        :create="() => (answer() as MockResponse).rules"
                        :changed="() => store.touch(mock().id)"
                      />
                    </template>
                    <div class="mock-route-fields mock-answer-fields">
                      <label class="form-field mock-number"
                        ><span>Status</span
                        ><input
                          id="mock-route-status"
                          class="field-input"
                          type="number"
                          min="100"
                          max="599"
                          :value="answer()!.status"
                          @input="updateNumber('status', $event)"
                      /></label>
                      <label class="form-field mock-number"
                        ><span>Delay (ms)</span
                        ><input
                          id="mock-route-delay"
                          class="field-input"
                          type="number"
                          min="0"
                          max="60000"
                          step="50"
                          :value="answer()!.delayMs"
                          @input="updateNumber('delayMs', $event)"
                      /></label>
                    </div>
                    <div class="table-label">
                      <div>
                        <strong>Response headers</strong
                        ><span>New rows appear as you type · drag handles to reorder</span>
                      </div>
                    </div>
                    <!-- Keyed by route, so switching never carries a draft row across. -->
                    <KeyValueTable
                      :key="answerKey()"
                      type="headers"
                      detached
                      :rows="() => answer()!.headers"
                      :changed="() => store.touch(mock().id)"
                    />
                    <div class="table-label">
                      <div>
                        <strong>Response body</strong
                        ><span>Request values, fake data, and lists: see Insert template</span>
                      </div>
                    </div>
                    <ScrollRow
                      class="body-format-row"
                      frame-class="body-format-row-frame"
                      noun="tools"
                      data-mock-body-format
                    >
                      <label class="inline-field" for="mock-content-type"
                        >Content type<UiSelect
                          id="mock-content-type"
                          :key="answerKey()"
                          class="field-input"
                          :value="contentTypeChoice()"
                          :options="
                            withIcons(
                              contentTypeOptions,
                              OPTION_ICONS.contentType,
                              'file-document-outline',
                            )
                          "
                          @change="chooseContentType"
                      /></label>
                      <input
                        v-if="contentTypeChoice() === 'custom'"
                        id="mock-custom-content-type"
                        class="field-input custom-content-type"
                        aria-label="Custom content type"
                        :value="contentType()"
                        spellcheck="false"
                        placeholder="application/vnd.example+json"
                        @input="setContentType(($event.target as HTMLInputElement).value.trim())"
                      />
                      <code v-else-if="contentType()" class="body-mime">{{ contentType() }}</code>
                      <span v-else class="body-mime">No Content-Type header is sent</span>
                      <UiSelect
                        v-model="templateChoice"
                        class="field-input mock-template-picker"
                        aria-label="Insert a template"
                        placeholder="Insert template…"
                        data-mock-template
                        searchable
                        :options="withIcons(templateOptions, 'code-braces')"
                        @update:model-value="insertTemplate"
                      /><UiButton
                        :label="previewing ? 'Hide preview' : 'Preview'"
                        :icon="previewing ? 'eye-off-outline' : 'eye-outline'"
                        variant="ghost"
                        data-mock-preview
                        :aria-pressed="previewing"
                        @click="previewing = !previewing"
                      /><UiButton
                        label="Format"
                        icon="code-tags"
                        variant="ghost"
                        data-mock-format
                        :disabled="!editorRuntime.canFormat(bodyLanguage())"
                        @click="formatBody"
                      />
                    </ScrollRow>
                    <SourceEditor
                      id="mock-body-editor"
                      :key="answerKey()"
                      class="source-editor-host mock-body-editor"
                      :value="answer()!.body"
                      :language="bodyLanguage()"
                      :wrap="workspace.settings().wordWrap"
                      label="Response body"
                      context-menu
                      formattable
                      :completions="templateCompletions"
                      @change="updateAnswer({ body: $event })"
                      @format="formatBody"
                      @handle="bodyEditor = $event"
                    />
                    <template v-if="previewing">
                      <div class="table-label mock-preview-label">
                        <div>
                          <strong>Preview</strong
                          ><span>A sample answer; path parameters show their names</span>
                        </div>
                        <UiButton
                          label="New sample"
                          icon="refresh"
                          variant="ghost"
                          data-mock-new-sample
                          @click="sample++"
                        />
                      </div>
                      <SourceEditor
                        id="mock-body-preview"
                        :key="`preview-${answerKey()}`"
                        class="source-editor-host mock-body-editor"
                        :value="preview"
                        :language="bodyLanguage()"
                        :wrap="workspace.settings().wordWrap"
                        read-only
                        context-menu
                        label="Response body preview (read only)"
                      />
                    </template>
                  </template>
                </div>
              </UiExpansionPanel>
            </div>
          </div>
          <div v-else-if="store.ui.tab === 'API docs'" class="mock-docs" data-mock-docs>
            <div class="docs-heading mock-docs-heading">
              <ScrollRow
                class="docs-formats"
                role="group"
                aria-label="Documentation format"
                noun="formats"
              >
                <button
                  v-for="format in MOCK_DOC_FORMATS"
                  :key="format"
                  type="button"
                  :data-mock-docs-format="format"
                  :aria-pressed="store.ui.docsFormat === format"
                  @click="store.ui.docsFormat = format"
                >
                  {{ format }}
                </button>
              </ScrollRow>
              <div class="docs-actions">
                <UiButton
                  label="Copy"
                  icon="content-copy"
                  data-mock-docs-copy
                  :disabled="!docOperations().length"
                  :title="
                    store.ui.docsFormat === 'Reference' ? 'Copy the OpenAPI JSON document' : ''
                  "
                  @click="copyDocs"
                /><UiButton
                  label="Download"
                  icon="download"
                  data-mock-docs-download
                  :disabled="!docOperations().length"
                  @click="downloadDocs"
                /><UiButton
                  label="Create specification"
                  icon="file-code-outline"
                  data-mock-docs-spec
                  :disabled="!docOperations().length"
                  title="Save this OpenAPI document as an API specification you can edit"
                  @click="createSpec(mock().id)"
                />
              </div>
            </div>
            <p class="field-help">
              Generated from this mock’s routes, served at <code>{{ store.url(mock()) }}</code
              >.<template v-if="undocumented()">
                {{ undocumented() }} route{{ undocumented() === 1 ? ' is' : 's are' }} left out:
                turned off, or WebSocket and gRPC, which OpenAPI does not describe.</template
              >
            </p>
            <UiEmptyState
              v-if="!docOperations().length"
              icon="file-document-outline"
              title="Nothing to document yet"
              description="Add or turn on an HTTP, SSE, or NDJSON route to see it documented here."
            />
            <div v-else-if="store.ui.docsFormat === 'Reference'" class="docs-endpoints">
              <details
                v-for="operation in docOperations()"
                :key="`${operation.routeId}:${operation.method}`"
                class="docs-endpoint"
                data-mock-docs-operation
              >
                <summary>
                  <span :class="['method', operation.method]"
                    ><MdiIcon :name="methodIcon(operation.method)" class="method-icon" />{{
                      operation.method
                    }}</span
                  ><code>{{ operation.path }}</code
                  ><span>{{ operation.summary }}</span
                  ><MdiIcon name="chevron-down" />
                </summary>
                <div class="docs-endpoint-body">
                  <div class="docs-operation-heading">
                    <h3>{{ operation.summary }}</h3>
                    <UiButton
                      label="Go to route"
                      icon="arrow-top-right"
                      variant="ghost"
                      @click="openDocRoute(operation.routeId)"
                    />
                  </div>
                  <p v-if="operation.kind !== 'http'" class="field-help">
                    Streams {{ operation.kind === 'sse' ? 'server-sent events' : 'NDJSON lines' }}.
                  </p>
                  <template v-if="operation.parameters.length">
                    <h4>Parameters</h4>
                    <div class="table-scroll">
                      <table class="docs-parameters">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>In</th>
                            <th>Type</th>
                            <th>Description</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr
                            v-for="parameter in operation.parameters"
                            :key="`${parameter.in}:${parameter.name}`"
                          >
                            <td>
                              <code>{{ parameter.name }}</code
                              >{{ parameter.required ? ' *' : '' }}
                            </td>
                            <td>{{ parameter.in }}</td>
                            <td>{{ schemaLabel(parameter.schema) }}</td>
                            <td>{{ parameter.description || '—' }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </template>
                  <template v-if="operation.requestSchema !== undefined">
                    <h4>Request body schema</h4>
                    <pre>{{ JSON.stringify(operation.requestSchema, null, 2) }}</pre>
                  </template>
                  <h4>Responses</h4>
                  <template v-for="response in operation.responses" :key="response.status">
                    <p class="mock-docs-response">
                      <UiBadge
                        :label="response.status"
                        :tone="Number(response.status) >= 400 ? 'danger' : 'success'"
                      /><span>{{ response.description }}</span
                      ><code v-if="response.contentType">{{ response.contentType }}</code>
                    </p>
                    <pre v-if="response.example">{{ response.example }}</pre>
                  </template>
                </div>
              </details>
            </div>
            <SourceEditor
              v-else
              id="mock-docs-source"
              :key="`${mock().id}:${store.ui.docsFormat}`"
              class="docs-source"
              :value="docsOutput()!.text"
              :language="docsLanguage()"
              :wrap="workspace.settings().wordWrap"
              read-only
              context-menu
              :label="`${store.ui.docsFormat} (read only)`"
            />
          </div>
          <div v-else class="mock-log">
            <div class="history-toolbar mock-log-toolbar">
              <label class="cookie-filter history-search"
                ><MdiIcon name="magnify" /><input
                  id="mock-log-search"
                  v-model="store.ui.logQuery"
                  type="search"
                  placeholder="Search method, path, status, or route"
                  aria-label="Search the log"
                  autocomplete="off"
              /></label>
              <ScrollRow
                class="segmented-control"
                role="group"
                aria-label="Filter the log by status"
                noun="filters"
              >
                <button
                  v-for="filter in LOG_FILTERS"
                  :key="filter"
                  type="button"
                  :data-mock-log-filter="filter"
                  :aria-pressed="store.ui.logStatus === filter"
                  :class="{ selected: store.ui.logStatus === filter }"
                  @click="store.ui.logStatus = filter"
                >
                  {{ filter
                  }}<span v-if="filter !== 'All'" class="history-count">{{
                    logCounts().get(filter) || 0
                  }}</span>
                </button>
              </ScrollRow>
              <UiButton
                label="Clear"
                icon="close"
                variant="ghost"
                data-mock-clear-log
                :disabled="!logEntries().length"
                @click="store.clearLog(mock().id)"
              />
            </div>
            <UiEmptyState
              v-if="!logEntries().length"
              icon="format-list-text"
              title="No requests yet"
              :description="
                isRunning(mock().id)
                  ? `Send requests to ${store.url(mock())} to see them here, with why each got its answer.`
                  : 'Start the mock server to see the requests it answers.'
              "
            />
            <div v-else :class="['history-layout', { 'has-detail': selectedLog() }]">
              <div class="history-list mock-log-list">
                <button
                  v-for="entry in filteredLog()"
                  :key="entry.id"
                  type="button"
                  :class="['history-entry', { 'is-selected': store.ui.logSelected === entry.id }]"
                  :aria-pressed="store.ui.logSelected === entry.id"
                  data-mock-log-row
                  @click="store.ui.logSelected = store.ui.logSelected === entry.id ? '' : entry.id"
                >
                  <span :class="['method', logBadgeClass(entry)]"
                    ><MdiIcon :name="logIcon(entry)" class="method-icon" />{{
                      logBadge(entry)
                    }}</span
                  ><span class="history-copy"
                    ><strong>{{ entry.path }}</strong
                    ><small>{{ answeredBy(entry) }}</small></span
                  ><UiBadge :label="statusLabel(entry)" :tone="statusTone(entry)" /><span
                    class="history-time"
                    >{{ entry.durationMs }} ms</span
                  ><span class="history-when">{{ time(entry.time) }}</span
                  ><MdiIcon name="chevron-right" />
                </button>
                <UiEmptyState
                  v-if="!filteredLog().length"
                  icon="magnify"
                  title="No matching requests"
                  description="Try another search or status filter."
                />
              </div>
              <aside
                v-if="selectedLog()"
                class="overview-card history-detail mock-log-detail"
                data-mock-log-detail
                aria-label="Request details"
              >
                <div class="history-detail-heading">
                  <span :class="['method', logBadgeClass(selectedLog()!)]"
                    ><MdiIcon :name="logIcon(selectedLog()!)" class="method-icon" />{{
                      logBadge(selectedLog()!)
                    }}</span
                  ><code :title="selectedLog()!.path">{{ selectedLog()!.path }}</code
                  ><UiIconButton
                    label="Close details"
                    icon="close"
                    data-mock-log-close
                    @click="store.ui.logSelected = ''"
                  />
                </div>
                <div class="spec-status">
                  <UiBadge
                    :label="statusLabel(selectedLog()!)"
                    :tone="statusTone(selectedLog()!)"
                  />
                  <span class="spec-link"
                    ><MdiIcon name="timer-outline" />{{ selectedLog()!.durationMs }} ms</span
                  ><span v-if="selectedLog()!.delayMs" class="spec-link"
                    ><MdiIcon name="timer-sand" />{{ selectedLog()!.delayMs }} ms delay</span
                  ><span class="spec-link"
                    ><MdiIcon name="history" />{{
                      new Date(selectedLog()!.time).toLocaleString()
                    }}</span
                  >
                </div>
                <h4 class="mock-log-heading">Why</h4>
                <ul class="mock-log-notes" data-mock-log-notes>
                  <li
                    v-for="(note, index) in selectedLog()!.notes ?? []"
                    :key="index"
                    :class="{ miss: !selectedLog()!.routeId }"
                  >
                    <MdiIcon
                      :name="
                        selectedLog()!.routeId ? 'check-circle-outline' : 'alert-circle-outline'
                      "
                    /><span>{{ note }}</span>
                  </li>
                </ul>
                <dl v-if="selectedLog()!.params" class="history-headers mock-log-params">
                  <template v-for="(value, name) in selectedLog()!.params" :key="name">
                    <dt>:{{ name }}</dt>
                    <dd>{{ value }}</dd>
                  </template>
                </dl>
                <UiTabs
                  group="mock-log"
                  label="Request and response"
                  :items="logTabs()"
                  :active="store.ui.logTab"
                  attribute="data-mock-tab"
                  class="spec-tabs"
                  @select="store.ui.logTab = $event as 'Request' | 'Response'"
                />
                <div id="mock-log-panel" role="tabpanel" class="spec-panel">
                  <template v-if="logMessage()">
                    <template v-if="store.ui.logTab === 'Request' && logQuery().length">
                      <h4 class="mock-log-heading">Query</h4>
                      <dl class="history-headers">
                        <template v-for="([name, value], index) in logQuery()" :key="index">
                          <dt>{{ name }}</dt>
                          <dd>{{ value }}</dd>
                        </template>
                      </dl>
                    </template>
                    <h4 class="mock-log-heading">Headers</h4>
                    <dl class="history-headers" data-mock-log-headers>
                      <template v-for="(value, name) in logMessage()!.headers" :key="name">
                        <dt>{{ name }}</dt>
                        <dd>{{ value }}</dd>
                      </template>
                    </dl>
                    <h4 class="mock-log-heading">
                      Body<small
                        >{{ logMessage()!.size }} bytes{{
                          logMessage()!.truncated ? ' · first 64 KB shown' : ''
                        }}</small
                      >
                    </h4>
                    <p v-if="!logMessage()!.body" class="field-help">No body.</p>
                    <SourceEditor
                      v-else
                      id="mock-log-body"
                      :key="`${store.ui.logSelected}:${store.ui.logTab}`"
                      class="source-editor-host history-body-editor"
                      :value="logMessage()!.body"
                      :language="logLanguage()"
                      :wrap="workspace.settings().wordWrap"
                      read-only
                      context-menu
                      :label="`${store.ui.logTab} body (read only)`"
                    />
                  </template>
                </div>
                <div class="history-detail-actions">
                  <UiButton
                    v-if="selectedLog()!.routeId && routeName(selectedLog()!.routeId)"
                    label="Go to route"
                    icon="arrow-top-right"
                    variant="ghost"
                    data-mock-log-route
                    @click="goToRoute(selectedLog()!)"
                  /><UiButton
                    v-if="!['socketio', 'mqtt'].includes(selectedLog()!.protocol ?? '')"
                    label="Copy as cURL"
                    icon="content-copy"
                    data-mock-log-curl
                    @click="copyCurl(selectedLog()!)"
                  />
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
