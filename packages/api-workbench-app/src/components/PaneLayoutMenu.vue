<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRendered } from '../composables/rendered';
import { usePopoverMenu } from '../composables/popover-menu';
import { paneLayoutLabels, useUiStore, type PaneLayout } from '../stores/ui';
import MdiIcon from './MdiIcon.vue';

const ui = useUiStore();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const popover = usePopoverMenu(trigger, menu, {
  place(element, rect) {
    element.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 208))}px`;
    element.style.bottom = `${innerHeight - rect.top + 6}px`;
  },
  initialItem: (items) => items.find((item) => item.getAttribute('aria-checked') === 'true'),
  openKeys: ['ArrowDown', 'ArrowUp'],
});

const layouts: PaneLayout[] = ['stacked', 'side', 'auto'];
// Auto depends on the window width, which render() re-checks on resize.
const resolved = useRendered(() => ui.paneLayout());
const label = computed(() =>
  ui.requestPanels.layout === 'auto'
    ? `Auto · ${paneLayoutLabels[resolved.value]}`
    : paneLayoutLabels[ui.requestPanels.layout],
);
const icon = (layout: PaneLayout): MdiIconName =>
  layout === 'auto'
    ? 'theme-light-dark'
    : layout === 'stacked'
      ? 'view-split-horizontal'
      : 'view-split-vertical';
function choose(layout: PaneLayout): void {
  popover.close(true);
  ui.setPaneLayout(layout);
}
</script>

<template>
  <div class="status-layout-control">
    <button
      ref="trigger"
      type="button"
      class="status-layout-trigger"
      aria-label="Choose panel layout"
      :title="`Panel layout: ${label} (⌘ \\ to switch)`"
      aria-haspopup="menu"
      :aria-expanded="popover.expanded.value"
      aria-controls="status-layout-menu"
      @click="popover.toggle"
      @keydown="popover.onTriggerKeydown"
    >
      <MdiIcon :name="resolved === 'stacked' ? 'view-split-horizontal' : 'view-split-vertical'" />
      <span>{{ label }}</span>
    </button>
    <div
      id="status-layout-menu"
      ref="menu"
      class="status-layout-menu"
      popover="auto"
      role="menu"
      aria-label="Panel layout"
      @keydown="popover.onMenuKeydown"
      @toggle="popover.onToggle"
    >
      <button
        v-for="layout in layouts"
        :key="layout"
        type="button"
        role="menuitemradio"
        tabindex="-1"
        :data-panel-layout="layout"
        :aria-checked="ui.requestPanels.layout === layout"
        @click="choose(layout)"
      >
        <MdiIcon :name="icon(layout)" />
        <span
          >{{ paneLayoutLabels[layout]
          }}<small v-if="layout === 'auto'">Side by side on wide windows</small></span
        >
        <MdiIcon v-if="ui.requestPanels.layout === layout" name="check-circle-outline" />
      </button>
    </div>
  </div>
</template>
