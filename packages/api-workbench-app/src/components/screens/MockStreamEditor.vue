<script setup lang="ts">
import { newMockStream, mockRouteKind } from '@techieutils/api-workbench-common/mocks';
import type { MockRoute, MockStream } from '@techieutils/api-workbench-common/types';
import { withIcons } from '../../select-options';
import UiButton from '../ui/UiButton.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiSelect from '../ui/UiSelect.vue';

/**
 * The messages a WebSocket, SSE, NDJSON, or gRPC route sends: a list of templates sent in order,
 * how far apart, whether they repeat, and (WebSocket and gRPC) what is sent back for each message
 * received. Edits change the route in place and then call `changed`.
 */
const props = defineProps<{
  /** Read on every render: the route is edited in place. */
  route(): MockRoute;
  changed(): void;
}>();
const kind = () => mockRouteKind(props.route());
const stream = (): MockStream => (props.route().stream ??= newMockStream(kind()));
const GRPC_CODES = [
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
const grpcOptions = withIcons(
  GRPC_CODES.map((name, code) => ({ value: String(code), label: `${code} · ${name}` })),
  (option) => (option.value === '0' ? 'check-circle-outline' : 'alert-circle-outline'),
);
const INTRO: Record<string, string> = {
  sse: 'Each message is sent as an event (text/event-stream); multi-line data becomes several data: lines.',
  ndjson:
    'Each message is sent as one line of JSON (application/x-ndjson), compacted onto one line.',
  websocket: 'Sent once the connection opens. Messages are templates, like a body.',
  grpc: 'Messages are JSON for the method’s response type. A unary or client-streaming call gets the first; a server stream gets them all.',
  socketio:
    'Emitted once the client joins the namespace, each as its event (message when empty). JSON is sent as a value, anything else as text.',
  mqtt: 'Published to each client that subscribes to the topic, to the topic it subscribed to; :name levels fill {{params.name}}.',
};
/** What the messages are called for each protocol. */
const NOUN: Record<string, [string, string]> = {
  sse: ['Events', 'Add event'],
  ndjson: ['Lines', 'Add line'],
  websocket: ['Messages sent', 'Add message'],
  grpc: ['Response messages', 'Add message'],
  socketio: ['Events emitted', 'Add event'],
  mqtt: ['Messages published', 'Add message'],
};
const REPLY_HELP: Record<string, string> = {
  grpc: 'Sent back for each message a client- or bidirectional-streaming call receives',
  socketio:
    'Sent back for each event the client emits: as its acknowledgement when it asks for one, otherwise as the same event, with its value as JSON',
  mqtt: 'Published on the topic with /reply added, for each message a client publishes to the topic',
};
const noun = () => NOUN[kind()] ?? ['Messages', 'Add message'];
/** When a message goes out, after the start delay, on the first pass. */
const sentAt = (index: number) => {
  const ms = props.route().delayMs + index * stream().intervalMs;
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s` : `${ms} ms`;
};
function addMessage(): void {
  stream().messages.push({ id: crypto.randomUUID(), data: '{}' });
  props.changed();
}
function setMessage(index: number, patch: { data?: string; event?: string }): void {
  Object.assign(stream().messages[index], patch);
  if (patch.event === '') delete stream().messages[index].event;
  props.changed();
}
function move(index: number, by: number): void {
  const messages = stream().messages;
  const target = index + by;
  if (target < 0 || target >= messages.length) return;
  [messages[index], messages[target]] = [messages[target], messages[index]];
  props.changed();
}
function remove(index: number): void {
  stream().messages.splice(index, 1);
  props.changed();
}
function setNumber(field: 'intervalMs' | 'delayMs', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  if (field === 'delayMs') props.route().delayMs = Math.max(0, Math.round(value));
  else stream().intervalMs = Math.max(0, Math.round(value));
  props.changed();
}
function setRepeat(event: Event): void {
  stream().repeat = (event.target as HTMLInputElement).checked || undefined;
  props.changed();
}
function setReply(event: Event): void {
  stream().reply = (event.target as HTMLTextAreaElement).value;
  props.changed();
}
function setStatus(event: Event): void {
  props.route().status = Number((event.target as HTMLSelectElement).value);
  props.changed();
}
function setError(event: Event): void {
  props.route().body = (event.target as HTMLInputElement).value;
  props.changed();
}
const text = (event: Event) => (event.target as HTMLTextAreaElement).value;
</script>

<template>
  <div class="mock-stream" :data-mock-stream="kind()">
    <div class="mock-route-fields mock-answer-fields">
      <label v-if="kind() === 'grpc'" class="form-field mock-grpc-status"
        ><span>gRPC status</span
        ><UiSelect
          id="mock-grpc-status"
          class="field-input"
          :value="String(route().status >= 0 && route().status <= 16 ? route().status : 0)"
          :options="withIcons(grpcOptions, 'alert-circle-outline')"
          @change="setStatus"
      /></label>
      <label
        v-if="kind() === 'grpc' && route().status > 0 && route().status <= 16"
        class="form-field flex-1"
        ><span>Error message</span
        ><input
          id="mock-grpc-error"
          class="field-input"
          :value="route().body"
          placeholder="Order {{body.id}} not found"
          spellcheck="false"
          @input="setError"
      /></label>
      <label class="form-field mock-number"
        ><span>Start delay (ms)</span
        ><input
          id="mock-stream-delay"
          class="field-input"
          type="number"
          min="0"
          max="60000"
          step="50"
          :value="route().delayMs"
          @input="setNumber('delayMs', $event)"
      /></label>
      <label class="form-field mock-number"
        ><span>Every (ms)</span
        ><input
          id="mock-stream-interval"
          class="field-input"
          type="number"
          min="0"
          max="60000"
          step="50"
          :value="stream().intervalMs"
          @input="setNumber('intervalMs', $event)"
      /></label>
      <label class="mock-enabled mock-stream-repeat"
        ><input
          id="mock-stream-repeat"
          type="checkbox"
          :checked="stream().repeat === true"
          @change="setRepeat"
        />Repeat until the client disconnects</label
      >
    </div>
    <div class="table-label">
      <div>
        <strong>{{ noun()[0] }}</strong
        ><span>{{ INTRO[kind()] }}</span>
      </div>
      <UiButton
        :label="noun()[1]"
        icon="plus"
        variant="ghost"
        data-mock-add-message
        @click="addMessage"
      />
    </div>
    <ol class="mock-stream-messages" aria-label="Messages">
      <li
        v-for="(message, index) in stream().messages"
        :key="message.id"
        class="mock-stream-message"
      >
        <span class="mock-stream-index" aria-hidden="true"
          >{{ index + 1
          }}<small :title="`Sent at ${sentAt(index)} on the first pass`">{{
            sentAt(index)
          }}</small></span
        >
        <div class="mock-stream-fields">
          <input
            v-if="kind() === 'sse' || kind() === 'socketio'"
            class="field-input mock-stream-event"
            :value="message.event ?? ''"
            :aria-label="`Message ${index + 1} event name`"
            :data-mock-message-event="index"
            placeholder="Event name (optional)"
            spellcheck="false"
            @input="setMessage(index, { event: text($event).trim() })"
          />
          <textarea
            class="field-input mock-stream-data"
            :value="message.data"
            :aria-label="`Message ${index + 1}`"
            :data-mock-message="index"
            rows="2"
            spellcheck="false"
            @input="setMessage(index, { data: text($event) })"
          ></textarea>
        </div>
        <div class="mock-stream-actions">
          <UiIconButton
            label="Move up"
            icon="chevron-up"
            :disabled="index === 0"
            @click="move(index, -1)"
          />
          <UiIconButton
            label="Move down"
            icon="chevron-down"
            :disabled="index === stream().messages.length - 1"
            @click="move(index, 1)"
          />
          <UiIconButton
            label="Remove message"
            icon="close"
            :data-mock-remove-message="index"
            @click="remove(index)"
          />
        </div>
      </li>
    </ol>
    <p v-if="!stream().messages.length" class="field-help">
      No messages: the
      {{
        ['websocket', 'socketio', 'mqtt'].includes(kind())
          ? 'route only replies'
          : 'stream opens and ends'
      }}.
    </p>
    <template v-if="['websocket', 'grpc', 'socketio', 'mqtt'].includes(kind())">
      <div class="table-label">
        <div>
          <strong>Reply</strong
          ><span
            >{{ REPLY_HELP[kind()] ?? 'Sent back for each message received' }};
            {{ '{' + '{body}' + '}' }} is that message. Leave empty to send nothing back.</span
          >
        </div>
      </div>
      <textarea
        id="mock-stream-reply"
        class="field-input mock-stream-data"
        :value="stream().reply ?? ''"
        rows="2"
        spellcheck="false"
        placeholder='{"echo": {{body}}}'
        @input="setReply"
      ></textarea>
    </template>
  </div>
</template>
