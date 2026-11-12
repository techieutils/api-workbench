import { defineStore } from 'pinia';
import { markRaw, nextTick } from 'vue';
import { buildProtocolTimeline } from '@techieutils/api-workbench-common/protocol-timeline';
import type {
  ApiRequest,
  MQTTConfig,
  ProtocolEvent,
  ProtocolSendOptions,
  RequestProtocol,
  SocketIOConfig,
} from '@techieutils/api-workbench-common/types';
import { defaultMQTT, defaultSocketIO } from '@techieutils/api-workbench-common/protocol-config';
import { render } from '../shell';
import { OPTION_ICONS } from '../select-options';
import { download, errorMessage, toast, uid } from '../utils';
import { useRequestsStore } from './requests';
import { useAuthenticationStore } from './authentication';
import { useHTTPSettingsStore } from './http-settings';
import { useSettingsStore } from './settings';
import { useToolsStore } from './tools';
import { useUiStore } from './ui';
import { useWorkspaceStore } from './workspace';

type EditorHandle = import('../editor/runtime').EditorHandle;
const MAX_EVENTS = 500;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

const protocolNames: Record<RequestProtocol, string> = {
  http: 'HTTP / GraphQL',
  websocket: 'WebSocket',
  sse: 'SSE',
  ndjson: 'NDJSON',
  grpc: 'gRPC',
  socketio: 'Socket.IO',
  mqtt: 'MQTT',
};
const sampleProto = `syntax = "proto3";
package playground;
service EchoService {
  rpc Echo (EchoRequest) returns (EchoReply);
  rpc Count (CountRequest) returns (stream CountReply);
  rpc Collect (stream EchoRequest) returns (EchoReply);
  rpc Chat (stream EchoRequest) returns (stream EchoReply);
}
message EchoRequest { string message = 1; }
message EchoReply { string message = 1; string protocol = 2; }
message CountRequest { int32 count = 1; }
message CountReply { int32 value = 1; }`;
export function requestProtocol(request: ApiRequest): RequestProtocol {
  return request.protocol || 'http';
}
/** The color key for a request's method badge: the HTTP method, or the live protocol. */
export function requestMethodClass(request: ApiRequest): string {
  const protocol = requestProtocol(request);
  return protocol === 'http' ? request.method : protocol.toUpperCase();
}
/** What each HTTP method is for, shown under its name wherever a method is chosen. */
export const METHOD_DESCRIPTIONS: Record<string, string> = {
  ANY: 'Every method',
  GET: 'Read a resource',
  POST: 'Create or submit',
  PUT: 'Replace a resource',
  PATCH: 'Change part of a resource',
  DELETE: 'Remove a resource',
  HEAD: 'Headers only, no body',
  OPTIONS: 'Allowed methods and CORS',
  TRACE: 'Echo the request back, to see what arrives',
  CONNECT: 'Ask a proxy to open a tunnel',
};
/** Icons for live protocols; HTTP requests use their method's icon, as in the method box. */
const PROTOCOL_ICONS: Record<Exclude<RequestProtocol, 'http'>, MdiIconName> = {
  websocket: 'swap-horizontal',
  sse: 'access-point',
  ndjson: 'format-list-text',
  grpc: 'api',
  socketio: 'lightning-bolt-outline',
  mqtt: 'access-point-network',
};
/** The icon for an HTTP method, as in the method box; methods of its own get a globe. */
export const methodIcon = (method: string): MdiIconName =>
  (OPTION_ICONS.method as Partial<Record<string, MdiIconName>>)[method] ?? 'web';
/** The icon beside a request's method or protocol, in tabs and lists. */
export function requestMethodIcon(request: ApiRequest): MdiIconName {
  const protocol = requestProtocol(request);
  return protocol === 'http' ? methodIcon(request.method) : PROTOCOL_ICONS[protocol];
}
export function requestMethodLabel(request: ApiRequest): string {
  const protocol = requestProtocol(request);
  return protocol === 'http'
    ? request.method
    : protocol === 'websocket'
      ? 'WS'
      : protocol === 'grpc'
        ? 'gRPC'
        : protocol === 'socketio'
          ? 'SIO'
          : protocol.toUpperCase();
}
/** Protocols with a message editor, where messages are composed and sent on the connection. */
export const SENDS_MESSAGES: readonly RequestProtocol[] = ['websocket', 'grpc', 'socketio', 'mqtt'];
/** A Socket.IO request's settings, added with defaults the first time they are needed. */
export const socketIOConfig = (request: ApiRequest): SocketIOConfig =>
  (request.socketio ||= defaultSocketIO());
/** An MQTT request's settings, added with defaults the first time they are needed. */
export const mqttConfig = (request: ApiRequest): MQTTConfig => (request.mqtt ||= defaultMQTT());

/**
 * Live protocol connections (WebSocket, SSE, NDJSON, gRPC, Socket.IO, MQTT): their sessions and events, the live
 * editor's view state, and the actions behind its controls. Sessions change on every streamed
 * event, so they are not reactive; views read them through useLiveProtocol(), which follows
 * `liveRevision`.
 */
export const useProtocolsStore = defineStore('protocols', () => {
  const workspace = useWorkspaceStore();
  const shell = useUiStore();
  const authentication = () => useAuthenticationStore();
  const liveProtocols = markRaw(new Map<string, LiveProtocolState>());
  let protocolEventsBound = false;

  /** Per-request view state of the live editor and response; not reactive, like the sessions. */
  const protocolUI = markRaw(new Map<string, ProtocolUIState>());
  function protocolUIState(request: ApiRequest): ProtocolUIState {
    let state = protocolUI.get(request.id);
    if (!state) {
      state = {
        tab: 'Message',
        inspector: 'Body',
        language: 'auto',
        mode: 'Pretty',
        binary: false,
      };
      protocolUI.set(request.id, state);
    }
    return state;
  }
  function protocolActive(request: ApiRequest): boolean {
    const live = liveProtocols.get(request.id);
    return !!live && live.phase !== 'closed';
  }
  function protocolConfigTabs(request: ApiRequest): string[] {
    const protocol = requestProtocol(request);
    return [
      SENDS_MESSAGES.includes(protocol) ? 'Message' : 'Connection',
      ...(protocol === 'grpc' ? ['Schema'] : []),
      ...(protocol === 'mqtt' ? ['Topics'] : []),
      protocol === 'grpc' ? 'Metadata' : 'Headers',
      'Auth',
      'Settings',
    ];
  }
  function protocolMessageLanguage(request: ApiRequest): string {
    return requestProtocol(request) === 'grpc'
      ? 'json'
      : request.editorLanguage && request.editorLanguage !== 'auto'
        ? request.editorLanguage
        : WorkbenchEditor.detectLanguage(undefined, request.body);
  }
  function protocolResponseHeaders(request: ApiRequest): Record<string, string> {
    const metadata = liveProtocols
      .get(request.id)
      ?.events.filter((event) => event.type === 'metadata')
      .at(-1);
    if (!metadata) return {};
    try {
      return Object.fromEntries(
        Object.entries(JSON.parse(metadata.data) as Record<string, unknown>).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : JSON.stringify(value),
        ]),
      );
    } catch {
      return {};
    }
  }
  function protocolResponseSource(request: ApiRequest): { text: string; language: string } {
    const ui = protocolUIState(request);
    const events = liveProtocols.get(request.id)?.events || [];
    if (ui.inspector === 'Timeline')
      return { text: JSON.stringify(protocolTimelineData(request), null, 2), language: 'json' };
    if (ui.inspector === 'Headers')
      return {
        text: Object.entries(protocolResponseHeaders(request))
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n'),
        language: 'text',
      };
    const messages = events.filter((event) => event.type === 'message');
    const raw = messages.map((event) => event.data).join('\n');
    if (ui.mode === 'Raw' && requestProtocol(request) === 'ndjson' && ui.language === 'auto')
      return { text: raw, language: 'ndjson' };
    if (ui.mode === 'Pretty' && messages.length && !messages.some((event) => event.binary)) {
      try {
        const values = messages.map((event) => JSON.parse(event.data) as unknown);
        return {
          text: JSON.stringify(values.length === 1 ? values[0] : values, null, 2),
          language: ui.language === 'auto' ? 'json' : ui.language,
        };
      } catch {
        /* Text and mixed streams retain their original message data. */
      }
    }
    return {
      text: raw,
      language:
        ui.language === 'auto'
          ? messages.length > 1
            ? 'text'
            : WorkbenchEditor.detectLanguage(undefined, raw)
          : ui.language,
    };
  }
  function protocolResponseHasSource(request: ApiRequest): boolean {
    const ui = protocolUIState(request);
    const events = liveProtocols.get(request.id)?.events || [];
    return ui.inspector === 'Body'
      ? events.some((event) => event.type === 'message')
      : ui.mode === 'Raw' && events.length > 0;
  }
  function protocolTimelineData(request: ApiRequest) {
    const live = liveProtocols.get(request.id);
    const timeline = buildProtocolTimeline(live?.events || []);
    return {
      request: {
        protocol: requestProtocol(request),
        url: live?.destination || workspace.resolve(request.url),
        ...(requestProtocol(request) === 'grpc'
          ? { method: live?.grpcMethod || request.grpc?.method || '' }
          : {}),
        ...(requestProtocol(request) === 'socketio' ? { path: socketIOConfig(request).path } : {}),
      },
      response: {
        state: timeline.errors
          ? 'Failed'
          : live?.phase === 'open'
            ? 'Connected'
            : live?.phase === 'connecting'
              ? 'Connecting'
              : timeline.events.at(-1)?.data.toLowerCase().includes('completed')
                ? 'Completed'
                : 'Closed',
        sentMessages: timeline.sentMessages,
        receivedMessages: timeline.receivedMessages,
        sentBytes: timeline.sentBytes,
        receivedBytes: timeline.receivedBytes,
      },
      totalDurationMs: timeline.durationMs,
      ...timeline,
    };
  }
  let protocolResponseEditor: EditorHandle | undefined;
  /** ProtocolResponse.vue registers its body editor while it is shown, for formatting and tests. */
  function setProtocolResponseEditor(editor: EditorHandle | undefined): void {
    protocolResponseEditor = editor;
  }
  function protocolName(protocol: RequestProtocol): string {
    return protocolNames[protocol];
  }
  /** The live response and connection controls are Vue views that follow liveChanged(). */
  function updateProtocolView(requestId: string): void {
    if (
      shell.view !== 'Collections' ||
      workspace.current().id !== requestId ||
      requestProtocol(workspace.current()) === 'http'
    )
      return;
    workspace.liveRevision++;
  }
  async function stopLiveProtocol(id: string): Promise<void> {
    const live = liveProtocols.get(id);
    if (live && live.phase !== 'closed') {
      await window.workbench?.protocols?.stop(live.id);
      live.phase = 'closed';
      updateProtocolView(id);
    }
  }
  /** Headers, destination query parameters, and signing for a live connection. */
  function liveProtocolAuth(request: ApiRequest): {
    headers: Record<string, string>;
    query: [string, string][];
    signing?: SigningAuth;
  } {
    const headers = Object.fromEntries(
      request.headers
        .filter((row) => row.enabled && row.key)
        .map((row) => [workspace.resolve(row.key), workspace.resolve(row.value)]),
    );
    const config = authentication().effectiveAuth(request);
    if (config.auth === 'Saved credential' && !config.credentialId)
      throw new Error('Select a saved credential in the Authentication tab.');
    const applied = authentication().applyRequestAuth(config);
    for (const [key, value] of Object.entries(applied.headers))
      headers[key.toLowerCase() === 'authorization' ? 'authorization' : key] = value;
    if (applied.query.length && requestProtocol(request) === 'grpc')
      throw new Error('gRPC has no query string. Send the API key as a header (metadata).');
    if (applied.query.length && requestProtocol(request) === 'mqtt')
      throw new Error('MQTT brokers take a username and password. Use Basic auth.');
    return { headers, query: applied.query, signing: applied.signing };
  }
  async function connectLiveProtocol(): Promise<void> {
    const request = workspace.current();
    const bridge = window.workbench?.protocols;
    if (!bridge) return toast('Live protocols require the desktop app.', 'warning');
    if (protocolActive(request)) {
      await stopLiveProtocol(request.id);
      return;
    }
    const protocol = requestProtocol(request);
    if (protocol === 'http') return;
    let auth: ReturnType<typeof liveProtocolAuth>;
    try {
      await authentication().ensureInlineOAuthToken(request);
      auth = liveProtocolAuth(request);
    } catch (error) {
      toast(errorMessage(error), 'error');
      return;
    }
    let destination = workspace.resolve(useRequestsStore().requestQueryURL(request));
    if (auth.query.length) {
      const target = new URL(destination);
      auth.query.forEach(([key, value]) => target.searchParams.set(key, value));
      destination = target.toString();
    }
    const live: LiveProtocolState = {
      id: uid(),
      phase: 'connecting',
      events: [],
      methods: liveProtocols.get(request.id)?.methods || [],
      finished: false,
      writable: false,
      destination,
      grpcMethod: request.grpc ? workspace.resolve(request.grpc.method) : undefined,
    };
    liveProtocols.set(request.id, live);
    updateProtocolView(request.id);
    try {
      await bridge.start({
        sessionId: live.id,
        protocol,
        url: live.destination!,
        headers: auth.headers,
        signing: auth.signing,
        body: workspace.resolve(request.body),
        timeoutMs: request.httpSettings?.timeoutMs || 300000,
        httpSettings: useHTTPSettingsStore().effectiveProtocol(request),
        clientCertificate: useSettingsStore().requestClientCertificate(
          useSettingsStore().requestCertificateURL(request),
        ),
        credentialId:
          authentication().effectiveAuth(request).auth === 'Saved credential'
            ? authentication().effectiveAuth(request).credentialId
            : undefined,
        grpc: request.grpc
          ? { ...request.grpc, method: workspace.resolve(request.grpc.method) }
          : undefined,
        ...(protocol === 'socketio'
          ? {
              socketio: {
                ...socketIOConfig(request),
                path: workspace.resolve(socketIOConfig(request).path),
              },
            }
          : {}),
        ...(protocol === 'mqtt'
          ? {
              mqtt: {
                ...mqttConfig(request),
                clientId: workspace.resolve(mqttConfig(request).clientId),
                subscriptions: mqttConfig(request).subscriptions.map((row) => ({
                  ...row,
                  topic: workspace.resolve(row.topic),
                })),
              },
            }
          : {}),
      });
    } catch (error) {
      live.phase = 'closed';
      live.events.push({
        sessionId: live.id,
        type: 'error',
        at: Date.now(),
        data: errorMessage(error),
      });
      updateProtocolView(request.id);
    }
  }
  /** Switches the active request's type, stopping any live connection it had. */
  async function selectRequestProtocol(protocol: RequestProtocol): Promise<void> {
    const request = workspace.current();
    if (requestProtocol(request) === protocol) return;
    await stopLiveProtocol(request.id);
    liveProtocols.delete(request.id);
    request.protocol = protocol;
    if (protocol === 'socketio') socketIOConfig(request);
    if (protocol === 'mqtt') mqttConfig(request);
    const ui = protocolUIState(request);
    ui.tab =
      request.protocol === 'grpc' && !request.grpc?.proto
        ? 'Schema'
        : request.protocol === 'sse' || request.protocol === 'ndjson'
          ? 'Connection'
          : 'Message';
    if (request.protocol !== 'http') shell.requestPanels.response = true;
    // Open code follows the new protocol, with that protocol's languages.
    useToolsStore().scheduleDockedCodeGeneration();
    workspace.persist();
    render();
    // The type select moves between the HTTP and live protocol editors; focus follows it.
    void nextTick(() =>
      document
        .querySelector<HTMLElement>('.request-type-select .ui-select-trigger')
        ?.focus({ preventScroll: true }),
    );
  }
  /** Points the active live request at the bundled protocol playground (examples/). */
  function useLocalProtocolSample(): void {
    const request = workspace.current();
    const protocol = requestProtocol(request);
    request.url =
      protocol === 'grpc'
        ? '127.0.0.1:4781'
        : protocol === 'socketio'
          ? 'http://127.0.0.1:4780/'
          : protocol === 'mqtt'
            ? 'mqtt://127.0.0.1:4782'
            : `${protocol === 'websocket' ? 'ws' : 'http'}://127.0.0.1:4780/${protocol === 'websocket' ? 'ws' : protocol === 'sse' ? 'events?count=3&interval=100' : 'ndjson?count=3&interval=100'}`;
    request.params = [];
    request.headers = [];
    request.auth = 'None';
    request.body = ['grpc', 'socketio'].includes(protocol)
      ? '{ "message": "Hello from Workbench" }'
      : 'Hello from Workbench';
    if (protocol === 'grpc')
      request.grpc = { proto: sampleProto, method: '/playground.EchoService/Echo', tls: false };
    if (protocol === 'socketio') request.socketio = { ...defaultSocketIO(), event: 'echo' };
    if (protocol === 'mqtt')
      request.mqtt = {
        ...defaultMQTT(),
        subscriptions: [{ topic: 'playground/#', qos: 0, enabled: true }],
        topic: 'playground/echo',
      };
    workspace.persist();
    render();
  }
  const protoConfig = () => (workspace.current().grpc ||= { proto: '', method: '', tls: false });
  async function formatProtocolMessage(): Promise<void> {
    const request = workspace.current();
    const formatted = await WorkbenchEditor.formatText(
      request.body,
      protocolMessageLanguage(request),
    );
    if (workspace.current().id !== request.id) return;
    request.body = formatted;
    workspace.persist();
    render();
  }
  /** Whether a protocol's messages can be base64 bytes rather than text. */
  const sendsBinary = (request: ApiRequest) =>
    ['websocket', 'socketio', 'mqtt'].includes(requestProtocol(request)) &&
    protocolUIState(request).binary;
  /** The Socket.IO event or MQTT topic, QoS, and retain flag for the next message. */
  function protocolSendOptions(request: ApiRequest): ProtocolSendOptions | undefined {
    const protocol = requestProtocol(request);
    if (protocol === 'socketio') {
      const config = socketIOConfig(request);
      return { event: workspace.resolve(config.event), ack: config.ack };
    }
    if (protocol === 'mqtt') {
      const config = mqttConfig(request);
      return { topic: workspace.resolve(config.topic), qos: config.qos, retain: config.retain };
    }
    return undefined;
  }
  /**
   * Options to resend a timeline message: to the event or topic it was sent or received on, so a
   * received MQTT message can be published back to its topic.
   */
  function resendOptions(
    request: ApiRequest,
    event: ProtocolEvent,
  ): ProtocolSendOptions | undefined {
    const options = protocolSendOptions(request);
    if (!options || !event.event) return options;
    if (requestProtocol(request) === 'socketio')
      return { ...options, event: event.event.replace(/ \(ack\)$/, '') };
    return { ...options, topic: event.event };
  }
  async function sendProtocolMessage(): Promise<void> {
    const request = workspace.current();
    const live = liveProtocols.get(request.id);
    if (live)
      await window.workbench?.protocols?.send(
        live.id,
        workspace.resolve(request.body),
        sendsBinary(request),
        protocolSendOptions(request),
      );
  }
  async function finishProtocolMessages(): Promise<void> {
    const live = liveProtocols.get(workspace.current().id);
    if (!live) return;
    await window.workbench?.protocols?.finish(live.id);
    live.finished = true;
    updateProtocolView(workspace.current().id);
  }
  /** Lists the schema's service methods and selects one, ready to invoke. */
  async function discoverProtoMethods(): Promise<void> {
    const bridge = window.workbench?.protocols;
    if (!bridge) return toast('Proto discovery requires the desktop app.', 'warning');
    const request = workspace.current();
    const schema = protoConfig().proto;
    const methods = await bridge.inspectProto(schema);
    if (!methods.length) throw new Error('No service methods found.');
    if (workspace.current().id !== request.id || request.grpc?.proto !== schema) return;
    const live = liveProtocols.get(request.id) || {
      id: '',
      phase: 'closed' as const,
      events: [],
      methods: [],
      finished: false,
      writable: false,
    };
    live.methods = methods;
    liveProtocols.set(request.id, live);
    if (!methods.some((method) => method.path === request.grpc?.method))
      request.grpc!.method = methods[0].path;
    protocolUIState(request).tab = 'Message';
    workspace.persist();
    render();
  }
  async function importProtoFile(file: File): Promise<void> {
    if (file.size > 1024 * 1024) throw new Error('Proto schemas are limited to 1 MiB.');
    const request = workspace.current();
    const text = await file.text();
    if (workspace.current().id !== request.id || requestProtocol(request) !== 'grpc') return;
    protoConfig().proto = text;
    workspace.persist();
    render();
    await discoverProtoMethods();
  }
  async function formatProtocolResponse(): Promise<void> {
    const request = workspace.current();
    protocolUIState(request).mode = 'Pretty';
    render();
    const source = protocolResponseSource(request);
    const formatted = await WorkbenchEditor.formatText(source.text, source.language);
    if (
      workspace.current().id !== request.id ||
      protocolResponseSource(request).text !== source.text
    )
      return;
    protocolResponseEditor?.setValue(formatted);
  }
  async function copyProtocolResponse(): Promise<void> {
    await navigator.clipboard.writeText(protocolResponseSource(workspace.current()).text);
    toast('Response copied', 'success');
  }
  function exportProtocolResponse(): void {
    const source = protocolResponseSource(workspace.current());
    download(
      `response-${protocolUIState(workspace.current()).inspector.toLowerCase()}.${source.language === 'json' ? 'json' : 'txt'}`,
      source.text,
      source.language === 'json' ? 'application/json' : 'text/plain',
    );
  }
  function clearProtocolResponse(): void {
    const live = liveProtocols.get(workspace.current().id);
    if (live) live.events = [];
    updateProtocolView(workspace.current().id);
  }
  /** Routes live connection events into their sessions; the views follow liveChanged(). */
  function bindProtocols(): void {
    const bridge = window.workbench?.protocols;
    if (bridge && !protocolEventsBound) {
      protocolEventsBound = true;
      bridge.onEvent((event) => {
        for (const [id, live] of liveProtocols) {
          if (live.id !== event.sessionId) continue;
          if (event.type === 'open') {
            live.phase = 'open';
            live.writable = event.writable === true;
          }
          if (event.type === 'closed') live.phase = 'closed';
          live.events.push(event);
          let size = live.events.reduce((sum, item) => sum + item.data.length, 0);
          while (live.events.length > MAX_EVENTS || size > MAX_EVENT_BYTES)
            size -= live.events.shift()!.data.length;
          updateProtocolView(id);
        }
      });
    }
  }
  return {
    liveProtocolAuth,
    resendOptions,
    live: liveProtocols,
    protocolUI,
    protocolUIState,
    protocolActive,
    protocolConfigTabs,
    protocolMessageLanguage,
    protocolResponseHeaders,
    protocolResponseSource,
    protocolResponseHasSource,
    protocolTimelineData,
    setProtocolResponseEditor,
    protocolResponseEditor: () => protocolResponseEditor,
    protocolName,
    stopLiveProtocol,
    connectLiveProtocol,
    selectRequestProtocol,
    useLocalProtocolSample,
    formatProtocolMessage,
    sendProtocolMessage,
    finishProtocolMessages,
    discoverProtoMethods,
    importProtoFile,
    formatProtocolResponse,
    copyProtocolResponse,
    exportProtocolResponse,
    clearProtocolResponse,
    bindProtocols,
    liveSessionsOpen: () =>
      [...liveProtocols.values()].some((session) => session.phase !== 'closed'),
  };
});
