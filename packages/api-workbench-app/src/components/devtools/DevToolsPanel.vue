<script setup lang="ts">
import { computed, ref } from 'vue';
import { DEV_TOOLS_TABS, PANE_SIZES, useUiStore, type DevToolsTab } from '../../stores/ui';
import { useToolsStore } from '../../stores/tools';
import PaneResizer from '../PaneResizer.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiTabs from '../ui/UiTabs.vue';
import RequestConsole from '../tools/RequestConsole.vue';
import DevToolsNetwork from './DevToolsNetwork.vue';
import DevToolsPerformance from './DevToolsPerformance.vue';
import TerminalDock from './TerminalDock.vue';

/** Dev tools above the status bar: the request console, network log, performance, and a terminal. */
const ui = useUiStore();
const tools = useToolsStore();
const panel = ref<HTMLElement>();
const ICONS: Record<DevToolsTab, MdiIconName> = {
  Console: 'console-line',
  Network: 'lan',
  Performance: 'speedometer',
  Terminal: 'console',
};
const tabs = computed(() =>
  DEV_TOOLS_TABS.map((name) => ({
    name,
    icon: ICONS[name],
    count:
      name === 'Console'
        ? tools.consoleEntries.length
        : name === 'Network'
          ? tools.networkEntries.length
          : undefined,
  })),
);
function select(name: string): void {
  ui.devTools.tab = name as DevToolsTab;
  ui.savePanelPreferences();
}
// The panel grows upward from the status bar, up to most of the window.
const maxHeight = () => Math.min(PANE_SIZES.devTools.max, Math.round(innerHeight * 0.7));
const measure = ({ y }: { y: number }) =>
  (panel.value?.getBoundingClientRect().bottom ?? innerHeight) - y;
function setHeight(value: number): void {
  ui.devTools.height = Math.min(value, maxHeight());
}
const maximized = computed(() => ui.devTools.height >= maxHeight());
function toggleMaximized(): void {
  ui.devTools.height = maximized.value ? PANE_SIZES.devTools.initial : maxHeight();
  ui.savePanelPreferences();
}
</script>

<template>
  <PaneResizer
    v-show="ui.devTools.open"
    direction="rows"
    label="Resize dev tools"
    class="devtools-resizer"
    :value="ui.devTools.height"
    :min="PANE_SIZES.devTools.min"
    :max="maxHeight()"
    :reset="PANE_SIZES.devTools.initial"
    :step="20"
    reversed
    :measure="measure"
    @change="setHeight"
    @commit="ui.savePanelPreferences()"
  />
  <!-- Hidden rather than removed when closed, so terminal shells keep running. -->
  <section
    v-show="ui.devTools.open"
    ref="panel"
    :class="['devtools', { open: ui.devTools.open }]"
    aria-label="Dev tools"
    :style="{ height: `${ui.devTools.height}px` }"
  >
    <header class="devtools-header">
      <UiTabs
        group="dev-tools"
        label="Dev tools"
        :items="tabs"
        :active="ui.devTools.tab"
        attribute="data-dev-tools-tab"
        class="devtools-tabs"
        @select="select"
      />
      <div class="devtools-actions">
        <UiIconButton
          :label="maximized ? 'Restore dev tools size' : 'Maximize dev tools'"
          :icon="maximized ? 'chevron-double-down' : 'chevron-double-up'"
          data-dev-tools-maximize
          @click="toggleMaximized"
        /><UiIconButton
          label="Close dev tools"
          icon="close"
          data-dev-tools-close
          @click="ui.toggleDevTools()"
        />
      </div>
    </header>
    <div
      id="dev-tools-panel"
      class="devtools-body"
      role="tabpanel"
      :aria-labelledby="`dev-tools-tab-${ui.devTools.tab.toLowerCase()}`"
    >
      <template v-if="ui.devTools.open">
        <RequestConsole v-if="ui.devTools.tab === 'Console'" />
        <DevToolsNetwork v-else-if="ui.devTools.tab === 'Network'" />
        <DevToolsPerformance v-else-if="ui.devTools.tab === 'Performance'" />
        <TerminalDock v-else-if="ui.devTools.tab === 'Terminal'" />
      </template>
    </div>
  </section>
</template>
