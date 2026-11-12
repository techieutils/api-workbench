<script setup lang="ts">
import { ref } from 'vue';
import { usePopoverMenu } from '../composables/popover-menu';
import { useUiStore } from '../stores/ui';
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

type Pane = 'request' | 'response' | 'code';
const panes: { pane: Pane; label: string; icon: MdiIconName }[] = [
  { pane: 'request', label: 'Request', icon: 'tune-variant' },
  { pane: 'response', label: 'Response', icon: 'console-network-outline' },
  { pane: 'code', label: 'Code', icon: 'code-tags' },
];
function maximize(): void {
  popover.close();
  ui.toggleResponseMaximized();
}
</script>

<template>
  <div class="panel-toggles">
    <button
      ref="trigger"
      type="button"
      class="status-panels-trigger"
      aria-haspopup="menu"
      :aria-expanded="popover.expanded.value"
      aria-controls="status-panels-menu"
      @click="popover.toggle"
      @keydown="popover.onTriggerKeydown"
    >
      <MdiIcon name="tune-variant" /><span>Panes</span><MdiIcon name="chevron-down" />
    </button>
    <div
      id="status-panels-menu"
      ref="menu"
      class="status-layout-menu"
      popover="auto"
      role="menu"
      aria-label="Visible request panes"
      @keydown="popover.onMenuKeydown"
      @toggle="popover.onToggle"
    >
      <button
        v-for="item in panes"
        :key="item.pane"
        type="button"
        role="menuitemcheckbox"
        tabindex="-1"
        :data-toggle-panel="item.pane"
        :aria-checked="ui.requestPanels[item.pane]"
        @click="ui.toggleRequestPanel(item.pane)"
      >
        <MdiIcon :name="item.icon" /><span>{{ item.label }}</span
        ><MdiIcon v-if="ui.requestPanels[item.pane]" name="check-circle-outline" />
      </button>
      <div class="status-menu-divider" role="separator"></div>
      <button type="button" role="menuitem" tabindex="-1" data-maximize-response @click="maximize">
        <MdiIcon :name="ui.requestPanels.request ? 'arrow-top-right' : 'view-split-horizontal'" />
        <span>{{ ui.requestPanels.request ? 'Maximize response' : 'Restore split' }}</span
        ><kbd>⌘ ⇧ M</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        data-reset-panes
        @click="ui.resetPanelLayout()"
      >
        <MdiIcon name="undo" /><span>Reset layout</span>
      </button>
    </div>
  </div>
</template>
