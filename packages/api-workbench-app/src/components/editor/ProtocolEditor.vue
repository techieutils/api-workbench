<script setup lang="ts">
import RequestTypeSelect from './RequestTypeSelect.vue';
import { computed } from 'vue';
import { useRendered, useLiveProtocol } from '../../composables/rendered';
import { render } from '../../shell';
import { action } from '../../actions';
import { errorMessage, toast } from '../../utils';
import { mqttConfig, requestProtocol, socketIOConfig } from '../../stores/protocols';
import { useRequestRowsStore } from '../../stores/request-rows';
import { useProtocolsStore } from '../../stores/protocols';
import { useUiStore } from '../../stores/ui';
import { useWorkspaceStore } from '../../stores/workspace';
import KeyValueTable from '../table/KeyValueTable.vue';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiTabs from '../ui/UiTabs.vue';
import AuthenticationPanel from './auth/AuthenticationPanel.vue';
import ProtocolMessage from './ProtocolMessage.vue';
import ProtocolSchema from './ProtocolSchema.vue';
import ProtocolSettings from './ProtocolSettings.vue';
import ProtocolTopics from './ProtocolTopics.vue';
import UiSelect from '../ui/UiSelect.vue';
import { MQTT_QOS_ICONS, MQTT_QOS_OPTIONS, withIcons } from '../../select-options';
import type { MQTTQoS } from '@techieutils/api-workbench-common/types';
import RequestHeading from './RequestHeading.vue';
const protocols = useProtocolsStore();

/**
 * The WebSocket, SSE, NDJSON, gRPC, Socket.IO, and MQTT editor: endpoint, connection, and
 * configuration tabs.
 */
const workspace = useWorkspaceStore();
const ui = useUiStore();
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
const protocol = () => requestProtocol(request());
const environmentName = computed(
  () => workspace.state.environments[workspace.state.environment].name,
);
const desktop = Boolean(window.workbench?.protocols);
const PLACEHOLDERS: Partial<Record<string, string>> = {
  grpc: 'localhost:50051',
  websocket: 'wss://example.com/ws',
  socketio: 'https://example.com/namespace',
  mqtt: 'mqtt://broker.example.com:1883',
};
const placeholder = () => PLACEHOLDERS[protocol()] ?? 'https://example.com/events';

const live = useLiveProtocol(() => ({
  active: protocols.protocolActive(request()),
  methods: [...(protocols.live.get(request().id)?.methods || [])],
}));
// Per-request tab choice lives in the protocol scripts, which call render() when it changes. A
// choice that does not apply to the current protocol shows its first tab.
const activeTab = useRendered(() => {
  const tab = protocols.protocolUIState(request()).tab;
  const tabs = protocols.protocolConfigTabs(request());
  return tabs.includes(tab) ? tab : tabs[0];
});
// Tabs, URL bar, and variable status follow the HTTP editor: icons on every tab, and counts only
// where there are rows.
const TAB_ICONS: Record<string, MdiIconName> = {
  Message: 'message-text-outline',
  Schema: 'file-code-outline',
  Topics: 'format-list-checks',
  Connection: 'lan-connect',
  Headers: 'swap-horizontal',
  Metadata: 'swap-horizontal',
  Auth: 'shield-key-outline',
  Settings: 'cog-outline',
};
const tabs = useRendered((): UITab[] =>
  protocols.protocolConfigTabs(request()).map((name) => ({
    name,
    icon: TAB_ICONS[name],
    count:
      name === 'Headers' || name === 'Metadata'
        ? request().headers.length
        : name === 'Topics'
          ? mqttConfig(request()).subscriptions.filter((row) => row.enabled && row.topic).length
          : undefined,
  })),
);
const rows = useRequestRowsStore();
const unresolved = useRendered(() => rows.unresolvedVariables(request()));

const report = (operation: () => unknown) => () =>
  Promise.resolve()
    .then(operation)
    .catch((error) => toast(errorMessage(error), 'error'));
const connect = report(() => protocols.connectLiveProtocol());
const useSample = report(() => protocols.useLocalProtocolSample());
function setURL(event: Event): void {
  request().url = (event.target as HTMLInputElement).value;
  workspace.persist();
}
function setMethod(event: Event): void {
  (request().grpc ||= { proto: '', method: '', tls: false }).method = (
    event.target as HTMLInputElement
  ).value;
  workspace.persist();
}
function setEvent(event: Event): void {
  socketIOConfig(request()).event = (event.target as HTMLInputElement).value;
  workspace.persist();
}
function setAck(event: Event): void {
  socketIOConfig(request()).ack = (event.target as HTMLInputElement).checked;
  workspace.persist();
}
function setTopic(event: Event): void {
  mqttConfig(request()).topic = (event.target as HTMLInputElement).value;
  workspace.persist();
}
function setQoS(event: Event): void {
  mqttConfig(request()).qos = Number((event.target as HTMLSelectElement).value) as MQTTQoS;
  workspace.persist();
  render();
}
function setRetain(event: Event): void {
  mqttConfig(request()).retain = (event.target as HTMLInputElement).checked;
  workspace.persist();
}
function selectTab(name: string): void {
  protocols.protocolUIState(request()).tab = name;
  render();
}
</script>

<template>
  <section class="editor protocol-editor">
    <RequestHeading>
      <UiButton
        label="Code"
        icon="code-tags"
        variant="ghost"
        data-action="code"
        :aria-pressed="String(ui.requestPanels.code)"
        @click="action('code')"
      /><UiIconButton
        label="Duplicate request"
        icon="content-copy"
        @click="action('duplicate')"
      /><UiIconButton
        label="Delete request"
        icon="delete-outline"
        @click="action('delete-request')"
      />
    </RequestHeading>
    <div class="request-composer protocol-composer">
      <div class="urlbar">
        <RequestTypeSelect />
        <input
          id="url"
          aria-label="Request URL"
          :value="request().url"
          :placeholder="placeholder()"
          spellcheck="false"
          @input="setURL"
        />
        <UiButton
          :label="live.active ? 'Disconnect' : protocol() === 'grpc' ? 'Invoke' : 'Connect'"
          :title="live.active ? 'Disconnect' : protocol() === 'grpc' ? 'Invoke' : 'Connect'"
          :icon="live.active ? 'close' : 'arrow-top-right'"
          variant="primary"
          class="send"
          data-protocol-connect
          @click="connect"
        />
      </div>
      <div v-if="protocol() === 'grpc'" class="protocol-method-row">
        <label for="grpc-method">Method</label
        ><input
          id="grpc-method"
          list="grpc-methods"
          :value="request().grpc?.method || ''"
          placeholder="/package.Service/Method"
          spellcheck="false"
          @input="setMethod"
        /><datalist id="grpc-methods">
          <option v-for="method in live.methods" :key="method.path" :value="method.path">
            {{ method.requestStream ? 'Client streaming' : 'Unary request' }} ·
            {{ method.responseStream ? 'Streaming response' : 'Unary response' }}
          </option>
        </datalist>
      </div>
      <div v-if="protocol() === 'socketio'" class="protocol-method-row">
        <label for="socketio-event">Event</label
        ><input
          id="socketio-event"
          :value="socketIOConfig(request()).event"
          placeholder="message"
          spellcheck="false"
          @input="setEvent"
        /><label class="protocol-checkbox"
          ><input
            id="socketio-ack"
            type="checkbox"
            :checked="socketIOConfig(request()).ack"
            @change="setAck"
          />Wait for acknowledgement</label
        >
      </div>
      <div v-if="protocol() === 'mqtt'" class="protocol-method-row">
        <label for="mqtt-topic">Publish to</label
        ><input
          id="mqtt-topic"
          :value="mqttConfig(request()).topic"
          placeholder="sensors/kitchen/temperature"
          spellcheck="false"
          @input="setTopic"
        /><UiSelect
          id="mqtt-qos"
          class="protocol-qos"
          aria-label="Publish quality of service"
          :value="String(mqttConfig(request()).qos)"
          :options="withIcons(MQTT_QOS_OPTIONS, MQTT_QOS_ICONS)"
          @change="setQoS"
        /><label class="protocol-checkbox"
          ><input
            id="mqtt-retain"
            type="checkbox"
            :checked="mqttConfig(request()).retain"
            @change="setRetain"
          />Retain</label
        >
      </div>
      <div class="composer-hint">
        <span
          ><MdiIcon name="layers-outline" /> Variables resolve from
          <strong>{{ environmentName }}</strong></span
        >
        <span class="composer-hint-end">
          <span id="composer-variables" role="status">
            <template v-if="!unresolved.length"
              ><MdiIcon name="check-circle-outline" /><span>All variables resolved</span></template
            >
            <span
              v-else
              class="variable-warning"
              :title="`Define these in ${environmentName} or capture them from an earlier response`"
              ><MdiIcon name="close-circle-outline" />{{ unresolved.length }} unresolved:
              <template v-for="name in unresolved.slice(0, 4)" :key="name"
                ><code v-text="`{{${name}}}`"></code>
              </template>
              <template v-if="unresolved.length > 4">+{{ unresolved.length - 4 }}</template></span
            >
          </span>
          <button type="button" data-protocol-sample :disabled="live.active" @click="useSample">
            Use local sample
          </button>
        </span>
      </div>
    </div>
    <p v-if="!desktop" class="field-help">Live connections require the desktop app.</p>
    <UiTabs
      group="protocol"
      label="Connection configuration"
      :items="tabs"
      :active="activeTab"
      attribute="data-protocol-tab"
      panel="protocol-config-panel"
      class="request-tabs"
      @select="selectTab"
    />
    <div
      id="protocol-config-panel"
      class="request-config protocol-config"
      role="tabpanel"
      :aria-labelledby="`protocol-tab-${activeTab.toLowerCase()}`"
    >
      <ProtocolSettings v-if="activeTab === 'Settings'" />
      <AuthenticationPanel v-else-if="activeTab === 'Auth'" />
      <template v-else-if="activeTab === 'Headers' || activeTab === 'Metadata'">
        <div class="table-label">
          <div>
            <strong>{{ activeTab === 'Metadata' ? 'Request metadata' : 'Request headers' }}</strong
            ><span>Variables resolve from the active environment</span>
          </div>
        </div>
        <KeyValueTable type="headers" :rows="() => request().headers" />
      </template>
      <ProtocolSchema v-else-if="activeTab === 'Schema'" />
      <ProtocolTopics v-else-if="activeTab === 'Topics'" />
      <div v-else-if="activeTab === 'Connection'" class="protocol-connection-info">
        <span class="empty-icon"><MdiIcon name="console-network-outline" /></span>
        <div>
          <h3>{{ protocol() === 'sse' ? 'Listen for server events' : 'Stream JSON records' }}</h3>
          <p>
            {{
              protocol() === 'sse'
                ? 'Event data, names, and IDs appear live in the response pane.'
                : 'Each complete JSON record appears live in the response pane.'
            }}
          </p>
          <span class="field-help"
            >Configure headers and authentication in the tabs above, then connect.</span
          >
        </div>
      </div>
      <ProtocolMessage v-else />
    </div>
  </section>
</template>
