<script setup lang="ts">
import { toast } from '../../utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { render } from '../../shell';
import { mqttConfig, requestProtocol, socketIOConfig } from '../../stores/protocols';
import HTTPSettingsForm from './HTTPSettingsForm.vue';
import UiSelect from '../ui/UiSelect.vue';
import { MQTT_VERSION_OPTIONS, withIcons } from '../../select-options';

const workspace = useWorkspaceStore();

/**
 * Session timeout, gRPC TLS, the Socket.IO path, MQTT session options, and proxy overrides for a
 * live connection.
 */
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
function setSessionTimeout(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(value) || value < 100 || value > 3600000)
    return toast('Use a timeout between 100 and 3600000 ms.', 'warning');
  (request().httpSettings ||= {}).timeoutMs = value;
  workspace.persist();
}
function setPath(event: Event): void {
  const value = (event.target as HTMLInputElement).value.trim();
  if (!value.startsWith('/')) return toast('The Socket.IO path must start with /.', 'warning');
  socketIOConfig(request()).path = value;
  workspace.persist();
}
function setClientId(event: Event): void {
  mqttConfig(request()).clientId = (event.target as HTMLInputElement).value;
  workspace.persist();
}
function setVersion(event: Event): void {
  mqttConfig(request()).version = (event.target as HTMLSelectElement).value === '5' ? 5 : 4;
  workspace.persist();
  render();
}
function setCleanStart(event: Event): void {
  mqttConfig(request()).cleanStart = (event.target as HTMLInputElement).checked;
  workspace.persist();
}
function setKeepalive(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(value) || value < 0 || value > 65535)
    return toast('Use a keep-alive between 0 and 65535 seconds.', 'warning');
  mqttConfig(request()).keepalive = value;
  workspace.persist();
}
function setTLS(event: Event): void {
  (request().grpc ||= { proto: '', method: '', tls: false }).tls = (
    event.target as HTMLInputElement
  ).checked;
  workspace.persist();
}
</script>

<template>
  <div class="protocol-settings">
    <label class="form-field"
      ><span>Session timeout (ms)</span
      ><input
        id="protocol-timeout"
        class="field-input"
        type="number"
        min="100"
        max="3600000"
        :value="request().httpSettings?.timeoutMs || 300000"
        @change="setSessionTimeout"
      /><small class="field-help"
        >Maximum connection duration, from 100 ms to one hour.</small
      ></label
    >
    <label v-if="requestProtocol(request()) === 'socketio'" class="form-field"
      ><span>Socket.IO path</span
      ><input
        id="socketio-path"
        class="field-input"
        :value="socketIOConfig(request()).path"
        placeholder="/socket.io"
        spellcheck="false"
        @change="setPath"
      /><small class="field-help"
        >Where the server handles Socket.IO, usually /socket.io. The namespace is the URL’s
        path.</small
      ></label
    >
    <template v-if="requestProtocol(request()) === 'mqtt'">
      <label class="form-field"
        ><span>Client ID</span
        ><input
          id="mqtt-client-id"
          class="field-input"
          :value="mqttConfig(request()).clientId"
          placeholder="Generated when empty"
          spellcheck="false"
          @change="setClientId"
        /><small class="field-help"
          >Brokers disconnect an older connection that uses the same ID.</small
        ></label
      >
      <label class="form-field"
        ><span>Protocol version</span
        ><UiSelect
          id="mqtt-version"
          class="field-input"
          :value="String(mqttConfig(request()).version)"
          :options="withIcons(MQTT_VERSION_OPTIONS, 'access-point-network')"
          @change="setVersion"
      /></label>
      <label class="form-field"
        ><span>Keep-alive (seconds)</span
        ><input
          id="mqtt-keepalive"
          class="field-input"
          type="number"
          min="0"
          max="65535"
          :value="mqttConfig(request()).keepalive"
          @change="setKeepalive"
        /><small class="field-help"
          >How often the connection is checked; 0 turns it off.</small
        ></label
      >
      <label class="protocol-checkbox"
        ><input
          id="mqtt-clean-start"
          type="checkbox"
          :checked="mqttConfig(request()).cleanStart"
          @change="setCleanStart"
        />Clean start: begin a new session instead of resuming the last one</label
      >
    </template>
    <label v-if="requestProtocol(request()) === 'grpc'" class="protocol-checkbox"
      ><input id="grpc-tls" type="checkbox" :checked="request().grpc?.tls" @change="setTLS" />Use
      TLS with system certificate authorities</label
    >
    <p class="field-help">
      Connections stay active across request tabs. Closing a tab disconnects its session.
    </p>
  </div>
  <HTTPSettingsForm proxy-only />
</template>
