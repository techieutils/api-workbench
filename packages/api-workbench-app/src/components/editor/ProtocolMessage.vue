<script setup lang="ts">
import { computed } from 'vue';
import { useRendered, useLiveProtocol } from '../../composables/rendered';
import { render } from '../../shell';
import { errorMessage, toast } from '../../utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { requestProtocol } from '../../stores/protocols';
import { useProtocolsStore } from '../../stores/protocols';
import SourceEditor from '../SourceEditor.vue';
import UiButton from '../ui/UiButton.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import UiSelect from '../ui/UiSelect.vue';
import { languageOptions } from '../../language-options';
const protocols = useProtocolsStore();
const workspace = useWorkspaceStore();
/** CodeMirror languages and formatting, from the editor runtime. */
const editorRuntime = WorkbenchEditor;

/**
 * The outgoing WebSocket message, gRPC request message, Socket.IO event payload, or MQTT payload,
 * and sending it on a live connection.
 */
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
const protocol = () => requestProtocol(request());
// Per-request view options live in the protocol scripts, which call render() when they change.
const binary = useRendered(() => protocols.protocolUIState(request()).binary);
const language = () => protocols.protocolMessageLanguage(request());
const wrap = computed(() => workspace.settings().wordWrap);
const live = useLiveProtocol(() => {
  const connection = protocols.live.get(request().id);
  const active = protocols.protocolActive(request());
  return {
    canSend: active && connection?.phase === 'open' && connection.writable && !connection.finished,
    canFinish: active && Boolean(connection?.writable) && !connection?.finished,
  };
});
/** Protocols whose messages may be base64 bytes instead of text. */
const allowsBinary = () => ['websocket', 'socketio', 'mqtt'].includes(protocol());
const canFormat = () => !(binary.value && allowsBinary()) && editorRuntime.canFormat(language());
const MESSAGE_HELP: Partial<Record<string, string>> = {
  grpc: 'JSON message · sent when you invoke the call',
  socketio: 'Event payload · JSON is emitted as its value, other text as a string',
  mqtt: 'Message payload · published to the topic above',
};

const report = (operation: () => unknown) => () =>
  Promise.resolve()
    .then(operation)
    .catch((error) => toast(errorMessage(error), 'error'));
const format = report(() => protocols.formatProtocolMessage());
const send = report(() => protocols.sendProtocolMessage());
const finish = report(() => protocols.finishProtocolMessages());

function setBody(value: string): void {
  request().body = value;
  workspace.persist();
}
function setBinary(event: Event): void {
  protocols.protocolUIState(request()).binary = (event.target as HTMLInputElement).checked;
  render();
}
function setLanguage(event: Event): void {
  request().editorLanguage = (event.target as HTMLSelectElement).value;
  workspace.persist();
  render();
}
</script>

<template>
  <div class="protocol-message-panel">
    <div class="protocol-config-toolbar">
      <span class="field-help">{{
        binary && allowsBinary()
          ? 'Binary message · base64 encoded'
          : (MESSAGE_HELP[protocol()] ?? 'Outgoing message')
      }}</span>
      <ScrollRow class="protocol-message-options" frame-class="protocol-toolbar-frame" noun="tools">
        <template v-if="allowsBinary()">
          <label class="protocol-checkbox"
            ><input
              id="protocol-binary"
              type="checkbox"
              :checked="binary"
              @change="setBinary"
            />Binary (base64)</label
          >
          <label class="inline-field"
            >Language<UiSelect
              id="protocol-message-language"
              class="field-input"
              :value="request().editorLanguage || 'auto'"
              @change="setLanguage"
              :options="languageOptions()"
          /></label>
        </template>
        <UiButton
          label="Format"
          icon="code-tags"
          variant="ghost"
          data-protocol-format
          :disabled="!canFormat()"
          @click="format"
        />
      </ScrollRow>
    </div>
    <!-- Kept for scripts and assistive tools that set the message as plain text. -->
    <textarea
      id="protocol-message"
      hidden
      aria-label="Outgoing message"
      :value="request().body"
      @input="setBody(($event.target as HTMLTextAreaElement).value)"
    ></textarea>
    <SourceEditor
      id="protocol-message-editor"
      class="protocol-source-editor"
      :value="request().body"
      :language="language()"
      :wrap="wrap"
      label="Outgoing message editor"
      context-menu
      :formattable="canFormat()"
      @change="setBody"
      @format="canFormat() && format()"
    />
    <div class="protocol-message-actions">
      <span class="field-help">{{
        protocol() === 'grpc'
          ? 'Streaming calls accept additional messages until you finish sending.'
          : live.canSend
            ? 'Messages are sent on the open connection.'
            : 'Connect before sending a message.'
      }}</span>
      <div class="flex gap-2">
        <UiButton
          v-if="protocol() === 'grpc'"
          label="Finish sending"
          icon="check-circle-outline"
          data-protocol-finish
          :disabled="!live.canFinish"
          @click="finish"
        /><UiButton
          :label="
            protocol() === 'mqtt' ? 'Publish' : protocol() === 'socketio' ? 'Emit' : 'Send message'
          "
          icon="arrow-top-right"
          variant="primary"
          data-protocol-send
          :disabled="!live.canSend"
          @click="send"
        />
      </div>
    </div>
  </div>
</template>
