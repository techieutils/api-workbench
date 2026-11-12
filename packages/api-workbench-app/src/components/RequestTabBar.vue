<script setup lang="ts">
import { useWorkspacesStore } from '../stores/workspaces';
import { action } from '../actions';
import { render } from '../shell';
import { useRequestsStore } from '../stores/requests';
import { requestMethodClass, requestMethodIcon, requestMethodLabel } from '../stores/protocols';
import { useRequestTabsStore } from '../stores/request-tabs';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import { useWorkspaceStore } from '../stores/workspace';
import ContextMenu from './ContextMenu.vue';
import type { MenuItem } from './ActionMenu.vue';
import MdiIcon from './MdiIcon.vue';
import TabMenu from './TabMenu.vue';
import UiIconButton from './ui/UiIconButton.vue';

const ui = useUiStore();
const workspace = useWorkspaceStore();
const workspaces = useWorkspacesStore();
const tabsStore = useRequestTabsStore();
const requests = useRequestsStore();
const tabs = computed(() =>
  workspace.state.tabs
    .map((id) => workspace.state.requests.find((request) => request.id === id))
    .filter((request): request is ApiRequest => Boolean(request)),
);
// Overflow: tabs scroll sideways in their own strip, with arrows, faded edges, and a count of
// tabs out of view that opens the tab menu. The active tab is always scrolled into view.
const strip = ref<HTMLElement>();
const tabMenu = ref<InstanceType<typeof TabMenu>>();
const overflow = ref({ left: false, right: false, hidden: 0 });
/**
 * Whether resizes keep the active tab in view: until the person scrolls the tabs themselves, by
 * wheel or the arrows, and again once a tab is opened or switched to.
 */
let followActive = true;
function measure(): void {
  const element = strip.value;
  if (!element) return;
  const box = element.getBoundingClientRect();
  const outside = (tab: HTMLElement) => {
    const rect = tab.getBoundingClientRect();
    return rect.left < box.left - 1 || rect.right > box.right + 1;
  };
  const hidden = [...element.querySelectorAll<HTMLElement>('.request-tab')].filter(outside).length;
  overflow.value = {
    left: element.scrollLeft > 1,
    right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    hidden,
  };
}
function scrollBy(direction: -1 | 1): void {
  followActive = false;
  strip.value?.scrollBy({ left: direction * strip.value.clientWidth * 0.7, behavior: 'smooth' });
}
function onWheel(event: WheelEvent): void {
  followActive = false;
  const element = strip.value;
  if (!element || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  if (element.scrollWidth <= element.clientWidth) return;
  event.preventDefault();
  element.scrollLeft += event.deltaY;
}
/** Scrolls the active tab fully into view within the strip. */
function keepActiveVisible(): void {
  const active = strip.value?.querySelector<HTMLElement>('.request-tab.active');
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function revealActive(): void {
  followActive = true;
  void nextTick(() => {
    keepActiveVisible();
    measure();
  });
}
watch(() => [workspace.state.active, workspace.state.tabs.length, ui.view], revealActive);
let observer: ResizeObserver | undefined;
onMounted(() => {
  // The strip narrows when the hidden-tab count appears beside it, which can push the active tab
  // out of view again; it stays in view unless the person has scrolled the tabs away from it.
  observer = new ResizeObserver(() =>
    requestAnimationFrame(() => {
      if (followActive) keepActiveVisible();
      measure();
    }),
  );
  if (strip.value) observer.observe(strip.value);
  revealActive();
});
onBeforeUnmount(() => observer?.disconnect());
// Renaming a request from its tab: double-click or F2; Enter or leaving the field saves, Escape
// cancels, and an empty name keeps the old one.
const renaming = ref<string>();
function startRename(id: string): void {
  renaming.value = id;
  void nextTick(() => {
    const input = strip.value?.querySelector<HTMLInputElement>('[data-tab-rename]');
    input?.focus();
    input?.select();
  });
}
function finishRename(save: boolean, input: HTMLInputElement): void {
  const id = renaming.value;
  if (!id) return;
  renaming.value = undefined;
  const request = workspace.state.requests.find((item) => item.id === id);
  if (save && request && input.value.trim() && input.value.trim() !== request.name) {
    request.name = input.value.trim();
    workspace.persist();
    render();
  }
  void nextTick(() =>
    strip.value?.querySelector<HTMLElement>(`.request-tab-label[data-open="${id}"]`)?.focus(),
  );
}
function onRenameKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  finishRename(event.key === 'Enter', event.target as HTMLInputElement);
}
// The tab's context menu: right-click, Shift+F10, or the context menu key.
const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const menuFor = ref<string>();
const menuItems = computed<MenuItem[]>(() => {
  const ids = workspace.state.tabs;
  const index = ids.indexOf(menuFor.value ?? '');
  return [
    { id: 'rename', label: 'Rename', icon: 'pencil-outline', shortcut: 'F2' },
    { id: 'close', label: 'Close tab', icon: 'close', separated: true },
    { id: 'others', label: 'Close other tabs', icon: 'close', disabled: ids.length < 2 },
    {
      id: 'right',
      label: 'Close tabs to the right',
      icon: 'chevron-right',
      disabled: index < 0 || index === ids.length - 1,
    },
    { id: 'all', label: 'Close all tabs', icon: 'close-circle-outline' },
  ];
});
const tabLabel = (id: string) =>
  strip.value?.querySelector<HTMLElement>(`.request-tab-label[data-open="${id}"]`);
function openContextMenu(id: string, at?: { x: number; y: number }): void {
  const label = tabLabel(id);
  if (!label || renaming.value === id) return;
  menuFor.value = id;
  contextMenu.value?.openFor(label, at);
}
function onContextMenu(event: MouseEvent, id: string): void {
  event.preventDefault();
  openContextMenu(id, { x: event.clientX, y: event.clientY });
}
function onMenuSelect(command: string): void {
  const id = menuFor.value;
  const ids = workspace.state.tabs;
  if (!id || !ids.includes(id)) return;
  if (command === 'rename') return startRename(id);
  const index = ids.indexOf(id);
  tabsStore.close(
    command === 'close'
      ? [id]
      : command === 'others'
        ? ids.filter((item) => item !== id)
        : command === 'right'
          ? ids.slice(index + 1)
          : [...ids],
  );
}
function onTabKeydown(event: KeyboardEvent, id: string): void {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    openContextMenu(id);
    return;
  }
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const ids = workspace.state.tabs;
    const neighbour = ids[ids.indexOf(id) + (event.key === 'ArrowRight' ? 1 : -1)];
    event.preventDefault();
    if (neighbour) {
      tabsStore.move(id, neighbour, event.key === 'ArrowRight');
      void nextTick(() => {
        strip.value?.querySelector<HTMLElement>(`.request-tab-label[data-open="${id}"]`)?.focus();
        revealActive();
      });
    }
    return;
  }
  if (event.key !== 'F2') return;
  event.preventDefault();
  startRename(id);
}
// Reordering tabs: drag one onto another (it lands on the nearer side), or Alt+Left/Right.
const dragging = ref<string>();
const dropTarget = ref<{ id: string; after: boolean }>();
function onDragStart(event: DragEvent, request: ApiRequest): void {
  dragging.value = request.id;
  event.dataTransfer?.setData('text/plain', request.name);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function onDragOver(event: DragEvent, id: string): void {
  if (dragging.value === undefined) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropTarget.value =
    id === dragging.value ? undefined : { id, after: event.clientX > box.left + box.width / 2 };
}
function onDrop(event: DragEvent): void {
  event.preventDefault();
  if (dragging.value && dropTarget.value)
    tabsStore.move(dragging.value, dropTarget.value.id, dropTarget.value.after);
  onDragEnd();
}
function onDragEnd(): void {
  dragging.value = undefined;
  dropTarget.value = undefined;
}
function onAuxClick(event: MouseEvent, id: string): void {
  if (event.button !== 1) return;
  event.preventDefault();
  tabsStore.close([id]);
}
</script>

<template>
  <div class="tabbar" aria-label="Open requests">
    <UiIconButton
      v-if="ui.explorerCollapsed && !ui.management"
      label="Show explorer (⌘B)"
      icon="chevron-right"
      class="explorer-expand"
      data-toggle-explorer
      @click="ui.toggleExplorer()"
    />
    <button
      v-if="overflow.left"
      type="button"
      class="tab-scroll"
      aria-label="Scroll tabs left"
      data-tab-scroll="left"
      @click="scrollBy(-1)"
    >
      <MdiIcon name="chevron-left" />
    </button>
    <div
      ref="strip"
      :class="['request-tab-strip', { 'fade-left': overflow.left, 'fade-right': overflow.right }]"
      @scroll.passive="measure"
      @wheel="onWheel"
    >
      <div
        v-for="request in tabs"
        :key="request.id"
        :draggable="renaming !== request.id"
        :class="[
          'request-tab',
          {
            active: request.id === workspace.state.active && ui.view === 'Collections',
            dragging: dragging === request.id,
            'drop-before': dropTarget?.id === request.id && !dropTarget.after,
            'drop-after': dropTarget?.id === request.id && dropTarget.after,
          },
        ]"
        :data-request-tab-item="request.id"
        @auxclick="onAuxClick($event, request.id)"
        @dragstart="onDragStart($event, request)"
        @dragover="onDragOver($event, request.id)"
        @drop="onDrop"
        @dragend="onDragEnd"
        @contextmenu="onContextMenu($event, request.id)"
      >
        <div v-if="renaming === request.id" class="request-tab-label is-renaming">
          <span :class="['method', requestMethodClass(request)]"
            ><MdiIcon :name="requestMethodIcon(request)" class="method-icon" />{{
              requestMethodLabel(request)
            }}</span
          ><input
            class="request-tab-rename"
            data-tab-rename
            aria-label="Rename request"
            maxlength="120"
            :value="request.name"
            @keydown="onRenameKeydown"
            @blur="finishRename(true, $event.target as HTMLInputElement)"
          />
        </div>
        <button
          v-else
          class="request-tab-label"
          :data-open="request.id"
          title="Double-click or press F2 to rename · Drag or Alt+←/→ to move"
          @click="requests.openRequest(request.id)"
          @dblclick="startRename(request.id)"
          @keydown="onTabKeydown($event, request.id)"
        >
          <span :class="['method', requestMethodClass(request)]"
            ><MdiIcon :name="requestMethodIcon(request)" class="method-icon" />{{
              requestMethodLabel(request)
            }}</span
          ><span>{{ request.name }}</span>
        </button>
        <button
          class="close"
          :data-close="request.id"
          :aria-label="`Close ${request.name}`"
          @click.stop="tabsStore.close([request.id])"
        >
          <MdiIcon name="close" />
        </button>
      </div>
    </div>
    <button
      v-if="overflow.right"
      type="button"
      class="tab-scroll"
      aria-label="Scroll tabs right"
      data-tab-scroll="right"
      @click="scrollBy(1)"
    >
      <MdiIcon name="chevron-right" />
    </button>
    <button
      v-if="overflow.hidden"
      type="button"
      class="tab-overflow-count"
      :aria-label="`${overflow.hidden} more tab${overflow.hidden === 1 ? '' : 's'}; open the tab list`"
      :title="`${overflow.hidden} more tab${overflow.hidden === 1 ? '' : 's'}`"
      data-tab-overflow
      @click="tabMenu?.open()"
    >
      +{{ overflow.hidden }}
    </button>
    <UiIconButton label="New request" icon="plus" class="add-tab" @click="action('new')" />
    <TabMenu ref="tabMenu" />
    <ContextMenu
      ref="contextMenu"
      label="Request tab actions"
      :items="menuItems"
      data-request-tab-menu
      @select="onMenuSelect"
    />
    <span class="tabbar-spacer"></span>
    <span class="workspace-location"
      ><MdiIcon :name="workspaces.isTeam() ? 'folder-account-outline' : 'folder-outline'" />
      {{ workspaces.isTeam() ? 'Team workspace' : 'Local workspace' }}</span
    >
  </div>
</template>
