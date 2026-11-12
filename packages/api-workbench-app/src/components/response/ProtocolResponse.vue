<script setup lang="ts">
import { computed, onBeforeUpdate, onUpdated, ref } from 'vue';
import { useLiveProtocol } from '../../composables/rendered';
import { render } from '../../shell';
import { errorMessage, toast } from '../../utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { requestProtocol } from '../../stores/protocols';
import { useProtocolsStore } from '../../stores/protocols';
import { useResponseStore } from '../../stores/response';
import MdiIcon from '../MdiIcon.vue';
import SourceEditor from '../SourceEditor.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import UiTabs from '../ui/UiTabs.vue';
import ProtocolTimeline from './ProtocolTimeline.vue';
import ResponseFrame from './ResponseFrame.vue';
import { vaultIssue } from '@techieutils/api-workbench-common/vault-messages';
import VaultUnlockNotice from '../VaultUnlockNotice.vue';
import UiSelect from '../ui/UiSelect.vue';
import { languageOptions } from '../../language-options';
import ResponseHeaderMenu from './ResponseHeaderMenu.vue';
const protocols = useProtocolsStore();

/** A live connection's response: received messages, headers or metadata, and session timeline. */
const response = useResponseStore();
const workspace = useWorkspaceStore();
/** CodeMirror languages and formatting, from the editor runtime. */
const editorRuntime = WorkbenchEditor;
const request = () => workspace.current();
// Connection state changes with every streamed event; view options change with render().
const view = useLiveProtocol(() => {
  const current = request();
  const ui = protocols.protocolUIState(current);
  const events = protocols.live.get(current.id)?.events || [];
  const live = protocols.live.get(current.id);
  const messages = events.filter((event) => event.type === 'message');
  const headers = protocols.protocolResponseHeaders(current);
  return {
    inspector: ui.inspector,
    mode: ui.mode,
    language: ui.language,
    source: protocols.protocolResponseSource(current),
    hasSource: protocols.protocolResponseHasSource(current),
    headers,
    headerCount: Object.keys(headers).length,
    events: events.length,
    error: events.filter((event) => event.type === 'error').at(-1),
    active: protocols.protocolActive(current),
    phase: live?.phase,
    connected: Boolean(live),
    messages: messages.length,
    bytes: messages.reduce(
      (sum, event) =>
        sum +
        (event.binary ? atob(event.data).length : new TextEncoder().encode(event.data).length),
      0,
    ),
    elapsed: events.length > 1 ? events.at(-1)!.at - events[0].at : 0,
  };
});
const badge = computed((): { label: string; tone: UITone } => {
  const { error, phase, connected } = view.value;
  return {
    label: error
      ? 'Error'
      : phase === 'open'
        ? 'Connected'
        : phase === 'connecting'
          ? 'Connecting…'
          : connected
            ? 'Completed'
            : 'Disconnected',
    tone: error ? 'danger' : phase === 'open' ? 'success' : 'neutral',
  };
});
const tabs = computed((): UITab[] =>
  (['Body', 'Headers', 'Timeline'] as const).map((name) => ({
    name,
    icon: response.tabIcon(name),
    count: name === 'Headers' && view.value.headerCount ? view.value.headerCount : undefined,
  })),
);
const wrap = computed(() => workspace.settings().wordWrap);
/** A new inspector, mode, or language re-mounts the editor; new messages only update it. */
const editorKey = computed(
  () => `${request().id}:${view.value.inspector}:${view.value.mode}:${view.value.source.language}`,
);

function setInspector(name: string): void {
  protocols.protocolUIState(request()).inspector = name as 'Body' | 'Headers' | 'Timeline';
  render();
}
function setMode(mode: 'Pretty' | 'Raw'): void {
  protocols.protocolUIState(request()).mode = mode;
  render();
}
function setLanguage(event: Event): void {
  protocols.protocolUIState(request()).language = (event.target as HTMLSelectElement).value;
  render();
}
const report = (operation: () => unknown) =>
  Promise.resolve()
    .then(operation)
    .catch((error) => toast(errorMessage(error), 'error'));
const format = () => report(() => protocols.formatProtocolResponse());
const copy = () => report(() => protocols.copyProtocolResponse());

// The timeline stays scrolled to the newest event while the reader is already there.
let followPanel = false;
const panel = () => document.getElementById('protocol-response-panel');
onBeforeUpdate(() => {
  const element = panel();
  followPanel = Boolean(
    element && element.scrollHeight - element.scrollTop - element.clientHeight < 80,
  );
});
onUpdated(() => {
  const element = panel();
  if (element && followPanel && view.value.inspector === 'Timeline')
    element.scrollTop = element.scrollHeight;
});
/** Header rows open their context menu (copy name, value, or both). */
const headerMenu = ref<InstanceType<typeof ResponseHeaderMenu>>();
</script>

<template>
  <ResponseFrame
    class="protocol-response"
    panel-id="protocol-response-panel"
    :panel-label="`protocol-inspector-tab-${view.inspector.toLowerCase()}`"
    :source-editor="view.hasSource"
  >
    <template #badge>
      <span id="protocol-state" role="status"><UiBadge v-bind="badge" /></span>
    </template>
    <template #meta>
      <span class="response-http-version">{{
        protocols.protocolName(requestProtocol(request()))
      }}</span
      ><span title="Session duration"
        ><MdiIcon name="timer-outline" /><strong>{{ view.elapsed }}</strong> ms</span
      ><span
        ><MdiIcon name="file-code-outline" /><strong>{{ (view.bytes / 1024).toFixed(2) }}</strong>
        KB</span
      ><span class="protocol-message-count">{{ view.messages }} messages</span>
    </template>
    <template #navigation>
      <UiTabs
        group="protocol-inspector"
        label="Response inspector"
        :items="tabs"
        :active="view.inspector"
        attribute="data-protocol-inspector"
        panel="protocol-response-panel"
        class="response-tabs"
        @select="setInspector"
      />
      <div class="response-tools">
        <UiIconButton
          label="Copy response"
          icon="content-copy"
          data-protocol-copy
          :disabled="!view.source.text"
          @click="copy"
        /><UiIconButton
          label="Download response"
          icon="download"
          data-protocol-export
          :disabled="!view.source.text"
          @click="protocols.exportProtocolResponse()"
        /><UiIconButton
          label="Clear response"
          icon="delete-outline"
          data-protocol-clear
          @click="protocols.clearProtocolResponse()"
        />
      </div>
    </template>
    <template #toolbar>
      <!-- One line of controls; in a narrow pane they scroll with arrows. -->
      <ScrollRow class="code-toolbar" frame-class="code-toolbar-frame" noun="tools">
        <div class="segmented-control" role="group" aria-label="Response display">
          <button
            v-for="mode in ['Pretty', 'Raw'] as const"
            :key="mode"
            type="button"
            :class="{ selected: view.mode === mode }"
            :aria-pressed="view.mode === mode"
            :data-protocol-view="mode"
            @click="setMode(mode)"
          >
            {{ mode }}
          </button>
        </div>
        <template v-if="view.inspector === 'Body'">
          <label class="response-language"
            ><span class="sr-only">Response language</span
            ><UiSelect
              id="protocol-response-language"
              aria-label="Response editor language"
              :value="view.language"
              @change="setLanguage"
              :options="languageOptions()" /></label
          ><UiButton
            label="Format"
            icon="code-tags"
            variant="ghost"
            data-protocol-response-format
            :disabled="!view.hasSource || !editorRuntime.canFormat(view.source.language)"
            @click="format"
          />
        </template>
        <span class="right code-toolbar-note"><MdiIcon name="code-tags" />Response inspector</span>
      </ScrollRow>
    </template>
    <template #status>
      <p
        id="protocol-response-format-status"
        class="field-help response-format-status"
        role="status"
        hidden
      ></p>
    </template>

    <SourceEditor
      v-if="view.hasSource"
      id="protocol-response-source-editor"
      :key="editorKey"
      class="source-editor-host response-editor-host"
      :value="view.source.text"
      :language="view.source.language"
      :wrap="wrap"
      read-only
      follow
      context-menu
      :formattable="view.inspector === 'Body'"
      :label="`Response ${view.inspector.toLowerCase()} editor (read only)`"
      @format="format"
      @handle="protocols.setProtocolResponseEditor($event)"
    />
    <template v-else-if="view.inspector === 'Headers'">
      <div v-if="!view.headerCount" class="assertion-empty">No response headers were returned.</div>
      <table v-else class="response-headers-table">
        <thead>
          <tr>
            <th scope="col">Header</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(value, name) in view.headers"
            :key="name"
            tabindex="0"
            :data-response-header="name"
            @contextmenu="headerMenu?.open($event, { name: String(name), value })"
            @keydown="headerMenu?.onKeydown($event, { name: String(name), value })"
          >
            <th scope="row">{{ name }}</th>
            <td>{{ value }}</td>
          </tr>
        </tbody>
      </table>
      <ResponseHeaderMenu ref="headerMenu" />
    </template>
    <ProtocolTimeline v-else-if="view.inspector === 'Timeline' && view.events" />
    <UiEmptyState
      v-else
      :class="[
        'response-empty',
        { 'error-empty': view.error, 'is-loading': !view.error && view.active },
      ]"
      :icon="
        view.error ? 'close-circle-outline' : view.active ? 'loading' : 'console-network-outline'
      "
      :title="
        view.error
          ? 'Request could not be completed'
          : view.active
            ? 'Waiting for your API'
            : 'Ready when you are'
      "
      :description="
        view.error
          ? view.error.data
          : 'Connect or invoke a call to inspect the response, headers, and timeline.'
      "
    >
      <VaultUnlockNotice
        v-if="view.error && vaultIssue(view.error.data)"
        :message="view.error.data"
        :retry="protocols.connectLiveProtocol"
        retry-label="connect"
      />
    </UiEmptyState>
  </ResponseFrame>
</template>
