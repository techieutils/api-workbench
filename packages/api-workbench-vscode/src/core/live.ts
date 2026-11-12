import { checkedSendOptions } from '@techieutils/api-workbench-common/protocol-config';
import type { ProtocolSendOptions } from '@techieutils/api-workbench-common/types';
import { draftFrom, updatePlan, type AuthDraft, type RequestDraft } from './editing';
import { formatBody } from './response';

/**
 * A live request — WebSocket, gRPC, SSE, NDJSON, Socket.IO, or MQTT — as its editor tab shows it: the connection's
 * state and a log of what was received and sent, built from the JSON lines `request connect --json`
 * prints, and the lines it reads to send a message, end a client stream, or stop. What a webview
 * asks to send is checked here first, since a webview is only trusted to render.
 */

export const LIVE_PROTOCOLS = ['websocket', 'grpc', 'sse', 'ndjson', 'socketio', 'mqtt'];
/** What `request connect` sends at most in one message, as the app does. */
export const MESSAGE_LIMIT = 1024 * 1024;
/** The most events a tab keeps; older ones are dropped. */
const EVENT_LIMIT = 1000;

/** One line of `request connect --json`. */
export interface LiveEvent {
  type: 'connecting' | 'open' | 'message' | 'sent' | 'metadata' | 'status' | 'error' | 'closed';
  at: number;
  data: string;
  binary?: boolean;
  writable?: boolean;
  event?: string;
}

export interface LiveView {
  view: 'live';
  name: string;
  breadcrumb: string[];
  protocol: string;
  url: string;
  /** A gRPC call's method, such as `/shop.Orders/Watch`. */
  method?: string;
  environment?: string;
  state: 'idle' | 'connecting' | 'open' | 'closed';
  /** Whether messages can be sent now: an open WebSocket, or a gRPC call taking a stream. */
  writable: boolean;
  /** Whether a gRPC client stream can be ended with Finish. */
  finishable: boolean;
  /** The saved request's first message: a gRPC call's request, or nothing for a WebSocket. */
  body: string;
  /** Whether the request can be sent from here at all (not with a saved credential). */
  supported: boolean;
  /** Each message's Socket.IO event and acknowledgement, or MQTT topic, QoS, and retain flag. */
  sendOptions?: ProtocolSendOptions;
  /** The MQTT topic filters subscribed to when it connects. */
  subscriptions?: string[];
  /** The request as saved, which its Connection and Settings tabs start from. */
  saved: LiveDraft;
  /** Changes on each save, so the editor drops its edits for what was saved. */
  revision: number;
  saving: boolean;
  /** Whether it has a saved token or password, never shown here. */
  hasSecret: boolean;
  /** Which of its auth's secrets are saved, by field. */
  savedSecrets?: string[];
  credentials?: { id: string; label: string }[];
  /** The methods its gRPC schema defines, to choose from. */
  methods?: { path: string; kind: string }[];
  events: {
    type: LiveEvent['type'];
    time: string;
    text: string;
    /** JSON is shown indented. */
    json: boolean;
  }[];
  error?: string;
}

/** Parses a line `request connect --json` printed, or undefined when it is not an event. */
export function liveEvent(line: string): LiveEvent | undefined {
  try {
    const event = JSON.parse(line) as Partial<LiveEvent>;
    if (typeof event.type !== 'string' || typeof event.data !== 'string') return undefined;
    return { at: Date.now(), ...event } as LiveEvent;
  } catch {
    return undefined;
  }
}

/** The view after `event`: its state, whether it is writable, and the event in the log. */
export function applyLiveEvent(view: LiveView, event: LiveEvent): LiveView {
  let { state, writable, finishable } = view;
  if (event.type === 'connecting') state = 'connecting';
  else if (event.type === 'open') state = 'open';
  else if (event.type === 'closed') {
    state = 'closed';
    writable = false;
    finishable = false;
  }
  if (event.writable !== undefined && event.type !== 'closed') {
    writable = event.writable;
    finishable = view.protocol === 'grpc' && event.writable;
  } else if (event.type === 'open' && view.protocol === 'websocket') writable = true;
  let text = event.binary
    ? `(${Math.round((event.data.length * 3) / 4)} bytes, binary)`
    : event.data;
  let json = false;
  if (!event.binary && /^\s*[[{]/.test(text))
    try {
      JSON.parse(text);
      text = formatBody(text, 'application/json');
      json = true;
    } catch {
      json = false;
    }
  return {
    ...view,
    state,
    writable,
    finishable,
    events: [
      ...view.events,
      {
        type: event.type,
        time: new Date(event.at).toLocaleTimeString(),
        text: event.event ? `${event.event}: ${text}` : text,
        json,
      },
    ].slice(-EVENT_LIMIT),
  };
}

/**
 * The input line that sends `message`, or why it cannot be sent. A Socket.IO message's event and an
 * MQTT message's topic, QoS, and retain flag are checked as the app checks them.
 */
export function sendLine(
  value: unknown,
  protocol = 'websocket',
): { line: string } | { error: string } {
  const given = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const message = typeof value === 'string' ? value : given.message;
  if (typeof message !== 'string' || !message.length) return { error: 'Type a message first.' };
  if (new TextEncoder().encode(message).length > MESSAGE_LIMIT)
    return { error: 'Messages are limited to 1 MiB.' };
  let options: ProtocolSendOptions | undefined;
  try {
    options = checkedSendOptions(protocol, given.options ?? undefined);
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { line: JSON.stringify({ action: 'send', message, ...(options ? { options } : {}) }) };
}
export const FINISH_LINE = JSON.stringify({ action: 'finish' });
export const STOP_LINE = JSON.stringify({ action: 'stop' });

/** A live request's protocol settings, as `request update --settings-file` takes them. */
export interface LiveSettings {
  grpc?: { proto: string; method: string; tls: boolean };
  socketio?: { path: string; event: string; ack: boolean };
  mqtt?: {
    clientId: string;
    version: 4 | 5;
    cleanStart: boolean;
    keepalive: number;
    subscriptions: { topic: string; qos: 0 | 1 | 2; enabled: boolean }[];
    topic: string;
    qos: 0 | 1 | 2;
    retain: boolean;
  };
}

/**
 * A live request as its editor changes it: where it connects, its headers and auth, what it sends
 * when it connects, and its protocol's settings.
 */
export interface LiveDraft {
  url: string;
  headers: { key: string; value: string; enabled: boolean }[];
  auth: AuthDraft;
  body: string;
  settings: LiveSettings;
}

const short = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length <= max && !/[\r\n]/.test(value) ? value : undefined;

/** A live draft posted by a webview, every field checked, or undefined when it is not one. */
export function liveDraftFrom(value: unknown, protocol: string): LiveDraft | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const given = value as Record<string, unknown>;
  // The URL, headers, auth, and body are checked as the request editor's are.
  const base = draftFrom({
    method: 'GET',
    url: given.url,
    headers: given.headers,
    body: given.body,
    tests: '',
    tags: [],
    captures: [],
    bodyType: 'none',
    form: [],
    auth: given.auth,
  });
  if (!base) return undefined;
  const raw = (given.settings ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const settings: LiveSettings = {};
  if (protocol === 'grpc' && raw.grpc) {
    const proto = typeof raw.grpc.proto === 'string' ? raw.grpc.proto : undefined;
    const method = short(raw.grpc.method, 1024);
    if (proto === undefined || new TextEncoder().encode(proto).length > MESSAGE_LIMIT) return;
    if (method === undefined) return;
    settings.grpc = { proto, method, tls: raw.grpc.tls === true };
  } else if (protocol === 'socketio' && raw.socketio) {
    const path = short(raw.socketio.path, 1024);
    const event = short(raw.socketio.event, 1024);
    if (path === undefined || event === undefined) return;
    settings.socketio = { path, event, ack: raw.socketio.ack === true };
  } else if (protocol === 'mqtt' && raw.mqtt) {
    const m = raw.mqtt;
    const qos = (v: unknown): 0 | 1 | 2 => (v === 1 || v === 2 ? v : 0);
    const clientId = short(m.clientId, 1024);
    const topic = short(m.topic, 65535);
    const keepalive = Number(m.keepalive);
    if (clientId === undefined || topic === undefined) return;
    if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 65535) return;
    if (!Array.isArray(m.subscriptions) || m.subscriptions.length > 50) return;
    const subscriptions: NonNullable<LiveSettings['mqtt']>['subscriptions'] = [];
    for (const row of m.subscriptions as Record<string, unknown>[]) {
      const filter = short(row?.topic, 65535);
      if (filter === undefined) return;
      if (filter)
        subscriptions.push({ topic: filter, qos: qos(row.qos), enabled: row.enabled !== false });
    }
    settings.mqtt = {
      clientId,
      version: m.version === 5 ? 5 : 4,
      cleanStart: m.cleanStart !== false,
      keepalive,
      subscriptions,
      topic,
      qos: qos(m.qos),
      retain: m.retain === true,
    };
  }
  return { url: base.url, headers: base.headers, auth: base.auth, body: base.body, settings };
}

/**
 * What saving a live draft takes: the request editor's plan for its URL, headers, auth, and body,
 * and the protocol settings that changed, for `--settings-file`.
 */
export function liveUpdatePlan(
  saved: LiveDraft,
  draft: LiveDraft,
): { args: string[]; input?: string; env?: Record<string, string>; settings?: LiveSettings } {
  const asRequest = (live: LiveDraft): RequestDraft => ({
    method: 'GET',
    url: live.url,
    headers: live.headers,
    body: live.body,
    tests: '',
    tags: [],
    captures: [],
    bodyType: live.body ? 'raw' : 'none',
    form: [],
    auth: live.auth,
  });
  const plan: ReturnType<typeof liveUpdatePlan> = updatePlan(asRequest(saved), asRequest(draft));
  // The body type follows the body here: a live request's message is text.
  plan.args = plan.args.filter((arg) => !arg.startsWith('--body-type='));
  if (JSON.stringify(draft.settings) !== JSON.stringify(saved.settings))
    plan.settings = draft.settings;
  return plan;
}
