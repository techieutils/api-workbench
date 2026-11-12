<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRendered } from '../composables/rendered';
import { render } from '../shell';
import { useWorkspaceStore } from '../stores/workspace';
import { useProtocolsStore } from '../stores/protocols';
import { requestMethodLabel, requestProtocol } from '../stores/protocols';
import { useToolsStore } from '../stores/tools';
import { PANE_SIZES, useUiStore } from '../stores/ui';
import ProtocolEditor from './editor/ProtocolEditor.vue';
import RequestEditor from './editor/RequestEditor.vue';
import ProtocolResponse from './response/ProtocolResponse.vue';
import ResponseViewer from './response/ResponseViewer.vue';
import CodeGenerator from './tools/CodeGenerator.vue';
import MdiIcon from './MdiIcon.vue';
import PaneResizer from './PaneResizer.vue';

/** The request page: request and response panes, and the docked code panel. */
const ui = useUiStore();
const panels = ui.requestPanels;
const tools = useToolsStore();
const protocols = useProtocolsStore();
const workspace = useWorkspaceStore();

// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
// Auto layout depends on the window width, which render() re-checks on resize.
const layout = useRendered(() => ui.paneLayout());
const withCode = computed(() => panels.code);
const both = computed(() => panels.request && panels.response);
const requestSummary = computed(
  () => `${requestMethodLabel(request())} ${workspace.resolve(request().url)}`,
);
// Live protocol status is not reactive yet.
const responseSummary = useRendered(() => {
  const current = request();
  const response = current.response;
  if (requestProtocol(current) !== 'http')
    return protocols.live.get(current.id)?.phase || 'Not connected';
  if (!response) return 'No response yet';
  if (response.error !== undefined) return 'Request failed';
  return `${response.status} ${response.statusText} · ${response.time} ms`;
});

function showPane(pane: 'request' | 'response'): void {
  panels[pane] = true;
  render();
}

// Dividers: request and response share the panes as a percentage; the code panel is pixels.
const docks = ref<HTMLElement>();
const panes = ref<HTMLElement>();
function measureShare({ x, y }: { x: number; y: number }): number {
  const box = panes.value!.getBoundingClientRect();
  return layout.value === 'stacked'
    ? ((y - box.top) / box.height) * 100
    : ((x - box.left) / box.width) * 100;
}
const measureCode = ({ x }: { x: number }) => docks.value!.getBoundingClientRect().right - x;
/**
 * Stacked, the request pane keeps at least its heading, URL bar, and tab row, so the divider never
 * cuts across the URL; the limit is measured, since it varies with window height and protocol.
 */
const REQUEST_MIN = 25;
const minShare = ref(REQUEST_MIN);
function measureMinShare(): void {
  const box = panes.value;
  const pane = box?.querySelector<HTMLElement>('.request-pane');
  const tabs = pane?.querySelector<HTMLElement>('[role=tablist]');
  if (layout.value !== 'stacked' || !box || !pane || !tabs) {
    minShare.value = REQUEST_MIN;
    return;
  }
  const essentials =
    tabs.getBoundingClientRect().bottom - pane.getBoundingClientRect().top + pane.scrollTop + 8;
  const share = Math.ceil((essentials / box.getBoundingClientRect().height) * 100);
  minShare.value = Math.min(70, Math.max(REQUEST_MIN, share));
}
/** The share in effect: the saved one, raised to the minimum when the window is too short for it. */
const share = computed(() => Math.max(panels.share, minShare.value));
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(() => requestAnimationFrame(measureMinShare));
  if (panes.value) observer.observe(panes.value);
  measureMinShare();
});
onBeforeUnmount(() => observer?.disconnect());
watch(
  () => [layout.value, request().id, requestProtocol(request()), panels.request, panels.response],
  () => requestAnimationFrame(measureMinShare),
);
function setShare(value: number): void {
  panels.share = Math.max(value, minShare.value);
}
function setCodeWidth(value: number): void {
  panels.codeWidth = value;
}
const save = () => ui.savePanelPreferences();
</script>

<template>
  <!-- Hidden rather than removed on other screens, so render() can always fill its hosts. -->
  <section v-show="ui.view === 'Collections'" class="request-workspace">
    <div
      ref="docks"
      :class="['workspace-docks', layout, { 'with-code': withCode }]"
      :style="{ '--code-width': `${panels.codeWidth}px` }"
    >
      <div
        ref="panes"
        :class="[
          'request-response-panes',
          both ? 'split' : 'single',
          layout,
          { 'request-hidden': !panels.request, 'response-hidden': !panels.response },
        ]"
        :style="{ '--pane-share': `${share}%` }"
      >
        <div v-if="panels.request" class="request-pane" aria-label="Request editor panel">
          <RequestEditor v-if="requestProtocol(request()) === 'http'" />
          <ProtocolEditor v-else />
        </div>
        <div
          v-else
          class="pane-strip pane-strip-request"
          role="region"
          aria-label="Request panel hidden"
        >
          <span
            ><MdiIcon name="tune-variant" /><strong>Request</strong
            ><small>{{ requestSummary }}</small></span
          ><button
            type="button"
            class="text-button"
            data-show-pane="request"
            @click="showPane('request')"
          >
            <MdiIcon name="chevron-up" />Show request
          </button>
        </div>
        <PaneResizer
          v-if="both"
          :direction="layout === 'stacked' ? 'rows' : 'columns'"
          label="Resize request and response panels"
          :value="share"
          :min="layout === 'stacked' ? minShare : REQUEST_MIN"
          :max="75"
          :reset="50"
          :measure="measureShare"
          @change="setShare"
          @commit="save"
        />
        <template v-if="panels.response">
          <ResponseViewer v-if="requestProtocol(request()) === 'http'" />
          <ProtocolResponse v-else />
        </template>
        <div
          v-else
          class="pane-strip pane-strip-response"
          role="region"
          aria-label="Response panel hidden"
        >
          <span
            ><MdiIcon name="console-network-outline" /><strong>Response</strong
            ><small>{{ responseSummary }}</small></span
          ><button
            type="button"
            class="text-button"
            data-show-pane="response"
            @click="showPane('response')"
          >
            <MdiIcon name="chevron-up" />Show response
          </button>
        </div>
      </div>
      <PaneResizer
        v-if="withCode"
        direction="columns"
        label="Resize generated code panel"
        :value="panels.codeWidth"
        :min="PANE_SIZES.code.min"
        :max="PANE_SIZES.code.max"
        :reset="PANE_SIZES.code.initial"
        :step="20"
        reversed
        :measure="measureCode"
        @change="setCodeWidth"
        @commit="save"
      />
      <aside v-if="withCode" class="code-dock" aria-label="Generated code panel">
        <CodeGenerator v-if="tools.codeDialog?.docked" docked />
        <div v-else class="p-4 text-muted" role="status">Loading code generator…</div>
      </aside>
    </div>
  </section>
</template>
