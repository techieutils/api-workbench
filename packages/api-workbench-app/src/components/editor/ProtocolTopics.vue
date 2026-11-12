<script setup lang="ts">
import { nextTick } from 'vue';
import type { MQTTQoS } from '@techieutils/api-workbench-common/types';
import {
  MAX_MQTT_SUBSCRIPTIONS,
  mqttTopicProblem,
} from '@techieutils/api-workbench-common/protocol-config';
import { render } from '../../shell';
import { mqttConfig } from '../../stores/protocols';
import { useWorkspaceStore } from '../../stores/workspace';
import UiButton from '../ui/UiButton.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiSelect from '../ui/UiSelect.vue';
import { MQTT_QOS_ICONS, MQTT_QOS_OPTIONS, withIcons } from '../../select-options';

const workspace = useWorkspaceStore();

/** An MQTT request's topic filters, subscribed to when the connection opens. */
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const rows = () => mqttConfig(workspace.current()).subscriptions;
/** A topic filter's problem, shown under the table; variables are checked once resolved. */
const problem = (topic: string) =>
  topic && !topic.includes('{{') ? mqttTopicProblem(topic, true) : undefined;
const problems = () =>
  rows()
    .map((row) => problem(row.topic))
    .filter(Boolean);

function update(): void {
  workspace.persist();
  render();
}
function setTopic(index: number, event: Event): void {
  rows()[index].topic = (event.target as HTMLInputElement).value;
  workspace.persist();
}
function setEnabled(index: number, event: Event): void {
  rows()[index].enabled = (event.target as HTMLInputElement).checked;
  update();
}
function setQoS(index: number, event: Event): void {
  rows()[index].qos = Number((event.target as HTMLSelectElement).value) as MQTTQoS;
  update();
}
function remove(index: number): void {
  rows().splice(index, 1);
  update();
  // Focus stays in the table: on the row that took this one's place, or on Add.
  void nextTick(() =>
    (
      document.querySelector<HTMLElement>(`[data-mqtt-topic="${index}"]`) ??
      document.querySelector<HTMLElement>('[data-mqtt-add]')
    )?.focus(),
  );
}
function add(): void {
  rows().push({ topic: '', qos: 0, enabled: true });
  update();
  void nextTick(() =>
    document.querySelector<HTMLElement>(`[data-mqtt-topic="${rows().length - 1}"]`)?.focus(),
  );
}
</script>

<template>
  <div class="table-label">
    <div>
      <strong>Subscriptions</strong
      ><span
        >Topic filters to subscribe to when connecting. Use + for one level and # for the
        rest.</span
      >
    </div>
  </div>
  <div class="table-scroll">
    <table class="kv-table mqtt-topics">
      <thead>
        <tr>
          <th class="checkcell"><span class="sr-only">Enabled</span></th>
          <th>Topic filter</th>
          <th class="mqtt-qos-cell">QoS</th>
          <th class="deletecell"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in rows()" :key="index" :class="{ disabled: !row.enabled }">
          <td class="checkcell">
            <input
              type="checkbox"
              :checked="row.enabled"
              :aria-label="`Subscribe to ${row.topic || `row ${index + 1}`}`"
              @change="setEnabled(index, $event)"
            />
          </td>
          <td>
            <input
              :value="row.topic"
              :data-mqtt-topic="index"
              placeholder="sensors/+/temperature"
              spellcheck="false"
              :aria-label="`Topic filter ${index + 1}`"
              :aria-invalid="problem(row.topic) ? 'true' : undefined"
              @input="setTopic(index, $event)"
              @change="update"
            />
          </td>
          <td class="mqtt-qos-cell">
            <UiSelect
              :value="String(row.qos)"
              :options="withIcons(MQTT_QOS_OPTIONS, MQTT_QOS_ICONS)"
              :aria-label="`Quality of service for ${row.topic || `row ${index + 1}`}`"
              @change="setQoS(index, $event)"
            />
          </td>
          <td class="deletecell">
            <UiIconButton label="Remove subscription" icon="close" @click="remove(index)" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="mqtt-topics-footer">
    <UiButton
      label="Add subscription"
      icon="plus"
      variant="ghost"
      data-mqtt-add
      :disabled="rows().length >= MAX_MQTT_SUBSCRIPTIONS"
      @click="add"
    />
    <p v-for="message in problems()" :key="message" class="field-help field-error" role="alert">
      {{ message }}
    </p>
    <p v-if="!problems().length" class="field-help">
      Changes apply the next time you connect. Messages appear in the response pane with their
      topic.
    </p>
  </div>
</template>
