<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { useLiveProtocol } from '../../composables/rendered';
import { useWorkspaceStore } from '../../stores/workspace';
import { requestProtocol, SENDS_MESSAGES } from '../../stores/protocols';
import { useProtocolsStore } from '../../stores/protocols';
import { render } from '../../shell';
import { errorMessage, toast } from '../../utils';
import { useContextMenu } from '../../composables/context-menu';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
const protocols = useProtocolsStore();
const workspace = useWorkspaceStore();

/** Session phases, message activity, and the retained event history of a live connection. */
const request = () => workspace.current();
const data = useLiveProtocol(() => protocols.protocolTimelineData(request()));
const active = useLiveProtocol(() => protocols.protocolActive(request()));
const protocolName = () => protocols.protocolName(requestProtocol(request()));
const duration = (value: number | null) => (value === null ? '—' : `${value.toFixed(2)} ms`);
const scale = (value: number) => (value / Math.max(data.value.durationMs, 1)) * 1000;
const labels: Record<ProtocolEvent['type'], string> = {
  connecting: 'Opening session',
  open: 'Session ready',
  metadata: 'Headers / metadata',
  message: 'Received',
  sent: 'Sent',
  status: 'Protocol status',
  error: 'Error',
  closed: 'Session closed',
};
const channels = computed(() =>
  [
    {
      label: 'Connection events',
      events: data.value.events.filter((event) => !['message', 'sent'].includes(event.type)),
    },
    { label: 'Sent messages', events: data.value.events.filter((event) => event.type === 'sent') },
    {
      label: 'Received messages',
      events: data.value.events.filter((event) => event.type === 'message'),
    },
  ].filter((channel) => channel.events.length),
);
/** The most recent 100 events; earlier ones are summarized by the counts above. */
const visible = computed(() => data.value.events.slice(-100));
const hidden = computed(() => data.value.events.length - visible.value.length);
const error = computed(() => data.value.events.filter((event) => event.type === 'error').at(-1));
const preview = (text: string) => (text.length > 160 ? `${text.slice(0, 160)}…` : text);
const eventKey = (event: ProtocolEvent, index: number) =>
  `${event.at}-${event.type}-${hidden.value + index}`;

// An event's context menu: copy it, open its details, reuse a message in the composer, or send a
// sent message again while the connection still accepts messages.
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<{ event: ProtocolEvent; key: string }>();
const json = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
};
const compact = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return undefined;
  }
};
/** Every received message this session, as retained. */
const received = () =>
  (protocols.live.get(request().id)?.events ?? []).filter((event) => event.type === 'message');
const details = (key: string) =>
  document.querySelector<HTMLDetailsElement>(`[data-timeline-event="${key}"]`);
const composes = () => SENDS_MESSAGES.includes(requestProtocol(request()));
const canResend = () => {
  const live = protocols.live.get(request().id);
  return Boolean(live && live.phase === 'open' && live.writable);
};
const menuItems = computed<MenuItem[]>(() => {
  const target = menuFor.value;
  const message = target && ['message', 'sent'].includes(target.event.type);
  return [
    { id: 'copy', label: 'Copy data', icon: 'content-copy' },
    {
      id: 'json',
      label: 'Copy formatted JSON',
      icon: 'code-json',
      disabled: !target || target.event.binary || json(target.event.data) === undefined,
    },
    { id: 'event', label: 'Copy event', icon: 'text' },
    // Server-sent events keep their id and name, so they can be copied as written on the wire.
    ...(requestProtocol(request()) === 'sse'
      ? [
          {
            id: 'event-id',
            label: 'Copy event ID',
            icon: 'pound-box-outline',
            disabled: !target?.event.eventId,
          } satisfies MenuItem,
          {
            id: 'sse',
            label: 'Copy as SSE event',
            icon: 'format-list-text',
            disabled: target?.event.type !== 'message',
          } satisfies MenuItem,
        ]
      : []),
    // NDJSON messages are JSON lines: copy one compactly, or the whole stream as received.
    ...(requestProtocol(request()) === 'ndjson'
      ? [
          {
            id: 'ndjson-line',
            label: 'Copy as NDJSON line',
            icon: 'format-list-text',
            disabled: !target || compact(target.event.data) === undefined,
          } satisfies MenuItem,
          {
            id: 'ndjson-all',
            label: 'Copy all messages as NDJSON',
            icon: 'content-copy',
            disabled: !received().length,
          } satisfies MenuItem,
        ]
      : []),
    {
      id: 'details',
      label: target && details(target.key)?.open ? 'Collapse details' : 'Expand details',
      icon: 'arrow-expand-horizontal',
      separated: true,
    },
    ...(composes()
      ? [
          {
            id: 'compose',
            label: 'Use as next message',
            icon: 'pencil-outline',
            separated: true,
            disabled: !message,
          } satisfies MenuItem,
          {
            id: 'resend',
            label: 'Send again',
            icon: 'arrow-top-right',
            disabled: target?.event.type !== 'sent' || !canResend(),
          } satisfies MenuItem,
        ]
      : []),
  ];
});
async function writeClipboard(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
async function onMenuSelect(command: string): Promise<void> {
  const target = menuFor.value;
  if (!target) return;
  const { event, key } = target;
  if (command === 'copy') void writeClipboard(event.data, 'Data copied');
  else if (command === 'json') void writeClipboard(json(event.data) ?? event.data, 'JSON copied');
  else if (command === 'event')
    void writeClipboard(
      `${new Date(event.at).toISOString()} ${labels[event.type]} ${event.data}`,
      'Event copied',
    );
  else if (command === 'event-id' && event.eventId)
    void writeClipboard(event.eventId, 'Event ID copied');
  else if (command === 'sse')
    void writeClipboard(
      [
        ...(event.event ? [`event: ${event.event}`] : []),
        ...(event.eventId ? [`id: ${event.eventId}`] : []),
        ...event.data.split('\n').map((line) => `data: ${line}`),
      ].join('\n') + '\n',
      'SSE event copied',
    );
  else if (command === 'ndjson-line' && compact(event.data) !== undefined)
    void writeClipboard(compact(event.data)!, 'NDJSON line copied');
  else if (command === 'ndjson-all')
    void writeClipboard(
      received()
        .map((message) => compact(message.data) ?? message.data)
        .join('\n') + '\n',
      'Messages copied as NDJSON',
    );
  else if (command === 'details') {
    const element = details(key);
    if (element) element.open = !element.open;
  } else if (command === 'compose') {
    const current = request();
    current.body = event.data;
    if (['websocket', 'socketio', 'mqtt'].includes(requestProtocol(current)))
      protocols.protocolUIState(current).binary = Boolean(event.binary);
    // The event or topic comes along, so sending repeats the message where it went.
    const options = protocols.resendOptions(current, event);
    if (requestProtocol(current) === 'socketio' && options?.event && current.socketio)
      current.socketio.event = options.event;
    if (requestProtocol(current) === 'mqtt' && options?.topic && current.mqtt)
      current.mqtt.topic = options.topic;
    protocols.protocolUIState(current).tab = 'Message';
    workspace.persist();
    render();
    void nextTick(() => toast('Loaded into the message editor', 'success'));
  } else if (command === 'resend') {
    const live = protocols.live.get(request().id);
    if (!live || !canResend()) return;
    try {
      await window.workbench?.protocols?.send(
        live.id,
        event.data,
        Boolean(event.binary),
        protocols.resendOptions(request(), event),
      );
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }
}
</script>

<template>
  <div class="response-timeline protocol-session-timeline">
    <div class="network-timing">
      <div class="timing-heading">
        <strong>Session timing</strong><span>{{ duration(data.durationMs) }}</span>
      </div>
      <div class="timing-axis">
        <span>0 ms</span><span>{{ duration(data.durationMs / 2) }}</span
        ><span>{{ duration(data.durationMs) }}</span>
      </div>
      <div class="timing-hop">
        <div class="timing-hop-title">
          <span
            >{{ protocolName() }}{{ data.request.method ? ` · ${data.request.method}` : '' }}</span
          ><strong>{{ data.response.state }}</strong>
        </div>
        <div v-for="phase in data.phases" :key="phase.id" class="timing-row">
          <span class="timing-label">{{ phase.label }}</span>
          <svg
            class="timing-track"
            viewBox="0 0 1000 20"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`${phase.label}: ${duration(phase.durationMs)}`"
          >
            <rect class="timing-track-bg" x="0" y="4" width="1000" height="12" rx="2" />
            <rect
              :class="['timing-fill', phase.id]"
              :x="Math.min(999, Math.max(0, scale(phase.startMs)))"
              y="4"
              :width="Math.max(1, Math.min(1000, scale(phase.durationMs)))"
              height="12"
              rx="2"
            />
          </svg>
          <span class="timing-duration">{{ duration(phase.durationMs) }}</span>
        </div>
      </div>
      <div class="timing-heading protocol-activity-heading">
        <strong>Message activity</strong
        ><span>{{ data.sentMessages }} sent · {{ data.receivedMessages }} received</span>
      </div>
      <div v-for="channel in channels" :key="channel.label" class="timing-row">
        <span class="timing-label">{{ channel.label }}</span>
        <svg
          class="timing-track protocol-activity-track"
          viewBox="0 0 1000 20"
          preserveAspectRatio="none"
          role="img"
          :aria-label="`${channel.label}: ${channel.events.length} recorded events`"
        >
          <rect class="timing-track-bg" x="0" y="4" width="1000" height="12" rx="2" />
          <circle
            v-for="(event, index) in channel.events"
            :key="index"
            :class="['protocol-activity-marker', event.type]"
            :cx="Math.max(5, Math.min(995, scale(event.offsetMs)))"
            cy="10"
            r="4"
          >
            <title>{{ labels[event.type] }} · {{ duration(event.offsetMs) }}</title>
          </circle>
        </svg>
        <span class="timing-duration">{{ channel.events.length }}</span>
      </div>
    </div>
    <p v-if="error" class="form-error">{{ error.data }}</p>
    <dl>
      <div>
        <dt>Request</dt>
        <dd>{{ protocolName() }} {{ data.request.url }}</dd>
      </div>
      <div v-if="data.request.method">
        <dt>Service method</dt>
        <dd>{{ data.request.method }}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>{{ data.response.state }}</dd>
      </div>
      <div>
        <dt>{{ data.partial ? 'Recorded duration' : 'Session duration' }}</dt>
        <dd>{{ duration(data.durationMs) }}</dd>
      </div>
      <div>
        <dt>Session ready</dt>
        <dd>{{ duration(data.connectionMs) }}</dd>
      </div>
      <div>
        <dt>First message</dt>
        <dd>{{ duration(data.firstMessageMs) }}</dd>
      </div>
      <div>
        <dt>Messages sent / received</dt>
        <dd>{{ data.sentMessages }} / {{ data.receivedMessages }}</dd>
      </div>
      <div>
        <dt>Decoded data sent / received</dt>
        <dd>{{ data.sentBytes }} / {{ data.receivedBytes }} bytes</dd>
      </div>
    </dl>
    <p class="field-help">
      Offsets use recorded session events{{ active ? ', through the latest event' : '' }}. Receiving
      spans the first to last message and includes gaps. DNS, TCP, and TLS timings are not captured.
      {{
        data.partial
          ? 'Earlier events are no longer retained; missing connection timings are not estimated.'
          : 'Unavailable timings are not estimated.'
      }}
    </p>
    <div class="protocol-timeline-heading">
      <h3>Event history</h3>
      <span>{{ visible.length }} of {{ data.events.length }} retained events</span>
    </div>
    <div class="protocol-timeline-events">
      <table class="response-headers-table protocol-timeline">
        <thead>
          <tr>
            <th>Offset</th>
            <th>Event</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          <!-- Keyed by event, so expanded details stay open as new events arrive. -->
          <tr
            v-for="(event, index) in visible"
            :key="eventKey(event, index)"
            :class="{ 'protocol-timeline-error': event.type === 'error' }"
            tabindex="0"
            :data-timeline-row="eventKey(event, index)"
            @contextmenu="openMenu($event, { event, key: eventKey(event, index) })"
            @keydown="onRowKeydown($event, { event, key: eventKey(event, index) })"
          >
            <th :title="new Date(event.at).toLocaleTimeString()">
              +{{ duration(event.offsetMs) }}
            </th>
            <td>
              <span :class="['protocol-timeline-kind', event.type]">{{ labels[event.type] }}</span>
            </td>
            <td>
              <template v-if="event.event"
                ><strong>{{ event.event }}</strong>
              </template>
              <template v-if="event.eventId"
                ><span>ID {{ event.eventId }}</span>
              </template>
              <template v-if="event.binary"><span>binary · base64</span> </template>
              <details :data-timeline-event="eventKey(event, index)">
                <summary>{{ preview(event.data) }}</summary>
                <pre>{{ event.data }}</pre>
              </details>
            </td>
          </tr>
        </tbody>
      </table>
      <ContextMenu
        ref="contextMenu"
        label="Event actions"
        :items="menuItems"
        data-timeline-menu
        @select="onMenuSelect"
      />
    </div>
  </div>
</template>
