<script setup lang="ts">
import { folderLabel } from '@techieutils/api-workbench-common/folders';
import { useRequestsStore } from '../stores/requests';
import { requestMethodClass, requestMethodIcon, requestMethodLabel } from '../stores/protocols';
import { useRequestTabsStore } from '../stores/request-tabs';
import { computed, ref } from 'vue';
import { usePopoverMenu } from '../composables/popover-menu';
import { useWorkspaceStore } from '../stores/workspace';
import MdiIcon from './MdiIcon.vue';

const workspace = useWorkspaceStore();
const tabs = useRequestTabsStore();
const requests = useRequestsStore();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const popover = usePopoverMenu(trigger, menu, {
  place(element, rect) {
    element.style.left = `${Math.max(8, Math.min(rect.right - 300, innerWidth - 308))}px`;
    element.style.top = `${rect.bottom + 6}px`;
    element.style.maxHeight = `${Math.max(100, innerHeight - rect.bottom - 18)}px`;
  },
});

// tabs.recent() reads the workspace store's state, so these track it.
const recent = computed(() => tabs.recent('recentTabs').slice(0, 8));
const closed = computed(() =>
  tabs.recent('closedTabs').filter((request) => !workspace.state.tabs.includes(request.id)),
);

interface TabCommand {
  id: string;
  label: string;
  icon: MdiIconName;
  disabled: boolean;
  shortcut?: string;
}
const groups = computed((): TabCommand[][] => {
  const { tabs, active } = workspace.state;
  const activeIndex = tabs.indexOf(active || '');
  const hasActive = activeIndex >= 0;
  return [
    [
      { id: 'close', label: 'Close tab', icon: 'close', disabled: !hasActive },
      {
        id: 'others',
        label: 'Close other tabs',
        icon: 'close',
        disabled: !hasActive || tabs.length < 2,
      },
      {
        id: 'left',
        label: 'Close tabs to the left',
        icon: 'chevron-left',
        disabled: activeIndex < 1,
      },
      {
        id: 'right',
        label: 'Close tabs to the right',
        icon: 'chevron-right',
        disabled: !hasActive || activeIndex === tabs.length - 1,
      },
      { id: 'all', label: 'Close all tabs', icon: 'close-circle-outline', disabled: !tabs.length },
    ],
    [
      { id: 'previous', label: 'Previous tab', icon: 'chevron-left', disabled: tabs.length < 2 },
      { id: 'next', label: 'Next tab', icon: 'chevron-right', disabled: tabs.length < 2 },
      {
        id: 'duplicate',
        label: 'Duplicate current request',
        icon: 'content-copy',
        disabled: !hasActive,
      },
      {
        id: 'reopen',
        label: 'Reopen closed tab',
        icon: 'undo',
        disabled: !closed.value.length,
        shortcut: '⌘ / Ctrl ⇧ T',
      },
    ],
  ];
});

defineExpose({ open: () => popover.open() });
function runCommand(command: string): void {
  popover.close();
  tabs.runCommand(command);
}
function reopen(id: string): void {
  popover.close();
  requests.openRequest(id);
}
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="icon-button add-tab tab-menu-trigger"
    aria-label="Tab actions and recent tabs"
    title="Tab actions and recent tabs"
    aria-haspopup="menu"
    :aria-expanded="popover.expanded.value"
    aria-controls="request-tab-menu"
    @click="popover.toggle"
    @keydown="popover.onTriggerKeydown"
  >
    <MdiIcon name="dots-horizontal" />
  </button>
  <div
    id="request-tab-menu"
    ref="menu"
    class="request-tab-menu"
    popover="auto"
    role="menu"
    aria-label="Tab actions and recent tabs"
    @keydown="popover.onMenuKeydown"
    @toggle="popover.onToggle"
  >
    <div class="tab-menu-heading" role="presentation">TAB ACTIONS</div>
    <template v-for="group in groups" :key="group[0].id">
      <button
        v-for="command in group"
        :key="command.id"
        type="button"
        role="menuitem"
        tabindex="-1"
        :data-tab-command="command.id"
        :disabled="command.disabled"
        @click="runCommand(command.id)"
      >
        <MdiIcon :name="command.icon" /><span>{{ command.label }}</span
        ><kbd v-if="command.shortcut">{{ command.shortcut }}</kbd>
      </button>
      <div class="tab-menu-separator" role="separator"></div>
    </template>
    <div class="tab-menu-heading" role="presentation">RECENTLY OPENED</div>
    <button
      v-for="request in recent"
      :key="request.id"
      type="button"
      role="menuitem"
      tabindex="-1"
      :data-tab-reopen="request.id"
      :title="`${folderLabel(request.folder)} · ${request.name}`"
      @click="reopen(request.id)"
    >
      <span :class="['method', requestMethodClass(request)]"
        ><MdiIcon :name="requestMethodIcon(request)" class="method-icon" />{{
          requestMethodLabel(request)
        }}</span
      ><span class="tab-menu-request"
        ><strong>{{ request.name }}</strong
        ><small>{{ folderLabel(request.folder) }}</small></span
      ><small v-if="workspace.state.tabs.includes(request.id)">Open</small>
    </button>
    <p v-if="!recent.length" class="tab-menu-empty">No recent tabs</p>
    <div class="tab-menu-heading" role="presentation">RECENTLY CLOSED</div>
    <button
      v-for="request in closed.slice(0, 8)"
      :key="request.id"
      type="button"
      role="menuitem"
      tabindex="-1"
      :data-tab-reopen="request.id"
      :title="`${folderLabel(request.folder)} · ${request.name}`"
      @click="reopen(request.id)"
    >
      <span :class="['method', requestMethodClass(request)]"
        ><MdiIcon :name="requestMethodIcon(request)" class="method-icon" />{{
          requestMethodLabel(request)
        }}</span
      ><span class="tab-menu-request"
        ><strong>{{ request.name }}</strong
        ><small>{{ folderLabel(request.folder) }}</small></span
      >
    </button>
    <p v-if="!closed.length" class="tab-menu-empty">No closed tabs</p>
  </div>
</template>
