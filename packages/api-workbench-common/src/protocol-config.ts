import type {
  MQTTConfig,
  MQTTQoS,
  MQTTSubscription,
  ProtocolSendOptions,
  SocketIOConfig,
} from './types';

/** Socket.IO and MQTT settings: defaults, and checks shared by the editor, imports, and main. */

export const MAX_MQTT_SUBSCRIPTIONS = 50;
const MAX_NAME = 1024;

export const defaultSocketIO = (): SocketIOConfig => ({
  path: '/socket.io',
  event: 'message',
  ack: false,
});
export const defaultMQTT = (): MQTTConfig => ({
  clientId: '',
  version: 4,
  cleanStart: true,
  keepalive: 60,
  subscriptions: [{ topic: '#', qos: 0, enabled: true }],
  topic: '',
  qos: 0,
  retain: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const qos = (value: unknown): MQTTQoS => (value === 1 || value === 2 ? value : 0);
const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length <= MAX_NAME ? value : fallback;

/** Saved or imported Socket.IO settings, with anything unusable replaced by its default. */
export function normalizedSocketIO(value: unknown): SocketIOConfig | undefined {
  if (!isRecord(value)) return undefined;
  const defaults = defaultSocketIO();
  return {
    path: text(value.path, defaults.path) || defaults.path,
    event: text(value.event, defaults.event),
    ack: value.ack === true,
  };
}
/** Saved or imported MQTT settings, with anything unusable replaced by its default. */
export function normalizedMQTT(value: unknown): MQTTConfig | undefined {
  if (!isRecord(value)) return undefined;
  const defaults = defaultMQTT();
  const keepalive = Number(value.keepalive);
  return {
    clientId: text(value.clientId, ''),
    version: value.version === 5 ? 5 : 4,
    cleanStart: value.cleanStart !== false,
    keepalive:
      Number.isInteger(keepalive) && keepalive >= 0 && keepalive <= 65535
        ? keepalive
        : defaults.keepalive,
    subscriptions: Array.isArray(value.subscriptions)
      ? value.subscriptions
          .filter(isRecord)
          .slice(0, MAX_MQTT_SUBSCRIPTIONS)
          .map((row): MQTTSubscription => ({
            topic: text(row.topic, ''),
            qos: qos(row.qos),
            enabled: row.enabled !== false,
          }))
      : defaults.subscriptions,
    topic: text(value.topic, ''),
    qos: qos(value.qos),
    retain: value.retain === true,
  };
}

/**
 * Why an MQTT topic cannot be used, or undefined when it can. Filters (subscriptions) may use the
 * `+` and `#` wildcards as whole levels, `#` only last; topics messages are published to may not.
 */
export function mqttTopicProblem(topic: string, filter: boolean): string | undefined {
  if (typeof topic !== 'string' || !topic) return 'Enter a topic.';
  if (new TextEncoder().encode(topic).length > 65535) return 'Topics are limited to 65,535 bytes.';
  if (topic.includes('\u0000')) return 'Topics cannot contain a null character.';
  const levels = topic.split('/');
  if (!filter)
    return /[+#]/.test(topic)
      ? `Publish to a topic without the + or # wildcards: ${topic}`
      : undefined;
  for (const [index, level] of levels.entries()) {
    if (level.includes('#') && (level !== '#' || index !== levels.length - 1))
      return `# must be the whole last level of a topic filter: ${topic}`;
    if (level.includes('+') && level !== '+')
      return `+ must be a whole level of a topic filter: ${topic}`;
  }
  return undefined;
}

/** Checks per-message options sent over IPC, keeping only the fields each protocol uses. */
export function checkedSendOptions(
  protocol: string,
  options: unknown,
): ProtocolSendOptions | undefined {
  if (options === undefined || options === null) return undefined;
  if (!isRecord(options)) throw new Error('Invalid message options.');
  if (protocol === 'socketio') {
    if (typeof options.event !== 'string' || !options.event.trim())
      throw new Error('Enter the Socket.IO event to emit.');
    if (options.event.length > MAX_NAME)
      throw new Error('Event names are limited to 1,024 characters.');
    return { event: options.event, ack: options.ack === true };
  }
  if (protocol === 'mqtt') {
    const topic = typeof options.topic === 'string' ? options.topic : '';
    const problem = mqttTopicProblem(topic, false);
    if (problem) throw new Error(problem);
    if (options.qos !== undefined && ![0, 1, 2].includes(options.qos as number))
      throw new Error('QoS must be 0, 1, or 2.');
    return { topic, qos: qos(options.qos), retain: options.retain === true };
  }
  return undefined;
}

/**
 * An MQTT broker URL as the HTTP(S) origin that saved credentials and client certificates are
 * matched against: mqtt:// and ws:// map to http://, mqtts:// and wss:// to https://, keeping the
 * broker's port (1883 and 8883 when the URL leaves it out).
 */
export function mqttOriginURL(value: string): URL {
  const url = new URL(value);
  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(url.protocol))
    throw new Error('Enter an mqtt://, mqtts://, ws://, or wss:// broker URL.');
  const secure = url.protocol === 'mqtts:' || url.protocol === 'wss:';
  const port =
    url.port || (url.protocol === 'mqtt:' ? '1883' : url.protocol === 'mqtts:' ? '8883' : '');
  const mapped = new URL(`${secure ? 'https' : 'http'}://${url.host}/`);
  if (port) mapped.port = port;
  mapped.pathname = url.pathname;
  mapped.search = url.search;
  return mapped;
}
