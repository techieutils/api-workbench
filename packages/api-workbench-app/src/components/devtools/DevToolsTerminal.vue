<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch, watchEffect } from 'vue';
import ScrollRow from '../ui/ScrollRow.vue';
import { keyLabel, mac } from '../../shortcuts';
import { TERMINAL_HOST } from './terminal-host';
import ContextMenu from '../ContextMenu.vue';
import ActionMenu, { type MenuItem } from '../ActionMenu.vue';
import type { TerminalShell } from '@techieutils/api-workbench-common/types';
import MdiIcon from '../MdiIcon.vue';
import PaneResizer from '../PaneResizer.vue';
import UiButton from '../ui/UiButton.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import TerminalView from './TerminalView.vue';

/**
 * Terminal tabs, each a grid of panes with a shell apiece: columns side by side, and panes stacked
 * within a column. The toolbar acts on the focused pane.
 */
type View = InstanceType<typeof TerminalView>;
interface Column {
  id: number;
  panes: number[];
  /** Each pane's share of the column's height, in percent. */
  sizes: number[];
}
interface Tab {
  id: number;
  number: number;
  /** A name the person gave the tab, in place of the shell and number. */
  name?: string;
  /** The shell its panes run, by id; unset runs the default one. */
  shell?: string;
  /** A command its first shell gets at the prompt, not yet run (from "Run in terminal"). */
  input?: string;
  columns: Column[];
  /** Each column's share of the tab's width, in percent. */
  sizes: number[];
  focused: number;
}
const MAX_PANES = 4;
const MIN_PANE = 12;
let nextId = 1;
const newTab = (number: number, shell?: string): Tab => {
  const id = nextId++;
  return {
    id,
    number,
    ...(shell ? { shell } : {}),
    columns: [{ id, panes: [id], sizes: [100] }],
    sizes: [100],
    focused: id,
  };
};
// Where it runs: the terminal window, which keeps the default shell and staged commands.
const host = inject(TERMINAL_HOST)!;
/** The shells this computer has, from the desktop app. */
const shells = ref<TerminalShell[]>([]);
/** The shell new terminals use: the chosen default while it is still installed, else the login shell. */
const defaultShellId = () =>
  shells.value.find((shell) => shell.id === host.defaultShell)?.id ??
  shells.value.find((shell) => shell.default)?.id;
const tabs = ref<Tab[]>([newTab(1, host.defaultShell)]);
// A command sent before the terminal first opened goes to its first tab rather than a second one.
if (host.commands.length) tabs.value[0].input = host.commands.shift();
const activeId = ref<number | undefined>(1);
/** Terminal views by pane id. */
const views = ref<Record<number, View | null>>({});
/** Tab and column elements by id, for dividers to measure against. */
const boxes = ref<Record<string, HTMLElement | null>>({});
const bridge = window.workbench?.terminal;
void bridge
  ?.shells()
  .then((list) => (shells.value = list))
  .catch(() => {});
const shellLabel = (id?: string) => shells.value.find((shell) => shell.id === id)?.label;
const panesOf = (tab: Tab) => tab.columns.flatMap((column) => column.panes);
// The status bar shows how many shells run while dev tools are closed.
watchEffect(() => {
  host.live = tabs.value
    .flatMap(panesOf)
    .filter((pane) => views.value[pane]?.status === 'running').length;
});
onBeforeUnmount(() => (host.live = 0));
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeId.value));
const active = computed(() => (activeTab.value ? views.value[activeTab.value.focused] : undefined));
const full = computed(() => !activeTab.value || panesOf(activeTab.value).length >= MAX_PANES);
const defaultTitle = (tab: Tab) =>
  `${shellLabel(tab.shell) ?? views.value[panesOf(tab)[0]]?.session?.shell ?? 'Terminal'} ${tab.number}`;
const title = (tab: Tab) => tab.name ?? defaultTitle(tab);

// Renaming a tab in place: double-click or F2, Enter or leaving the field saves, Escape cancels.
const MAX_NAME = 40;
const renaming = ref<number>();
const draft = ref('');
const focusTab = (id: number) =>
  void nextTick(() => document.getElementById(`terminal-tab-${id}`)?.focus());
function startRename(tab: Tab): void {
  renaming.value = tab.id;
  draft.value = title(tab);
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('[data-terminal-rename]');
    input?.focus();
    input?.select();
  });
}
/** Saves the name; an empty one, or the default title, returns the tab to its default. */
function commitRename(tab: Tab): void {
  if (renaming.value !== tab.id) return;
  const name = draft.value.trim().slice(0, MAX_NAME);
  tab.name = name && name !== defaultTitle(tab) ? name : undefined;
  renaming.value = undefined;
  focusTab(tab.id);
}
function cancelRename(tab: Tab): void {
  renaming.value = undefined;
  focusTab(tab.id);
}

// Terminal tabs scroll when they do not fit, with arrows like the app's other tab rows.
const tabRow = ref<InstanceType<typeof ScrollRow>>();
watch(
  activeId,
  (id) =>
    void nextTick(() =>
      tabRow.value?.reveal(document.getElementById(`terminal-tab-${id}`)?.parentElement),
    ),
  { flush: 'post' },
);
function select(id: number): void {
  activeId.value = id;
}
/** Opens a terminal tab with the lowest free number, running `shell` or the default, and shows it. */
function add(shell: string | undefined = defaultShellId()): void {
  const used = new Set(tabs.value.map((tab) => tab.number));
  let number = 1;
  while (used.has(number)) number++;
  const tab = newTab(number, shell);
  tabs.value.push(tab);
  activeId.value = tab.id;
}
// Later commands each open a new tab, with the command at its prompt.
watch(
  () => host.commands.length,
  () => {
    for (let command = host.commands.shift(); command; command = host.commands.shift()) {
      add();
      tabs.value[tabs.value.length - 1].input = command;
    }
  },
);
/**
 * The shell menu: open a terminal with any installed shell, or choose the one new terminals use
 * (remembered for this computer).
 */
const shellItems = computed((): MenuItem[] => {
  const current = defaultShellId();
  return [
    ...shells.value.map((shell, index) => ({
      id: `open:${shell.id}`,
      label: shell.label,
      icon: 'console' as MdiIconName,
      ...(shell.id === current ? { shortcut: 'Default' } : {}),
      ...(index === 0 ? { heading: 'New terminal with' } : {}),
    })),
    ...shells.value.map((shell, index) => ({
      id: `default:${shell.id}`,
      label: shell.label,
      icon: (shell.id === current ? 'check' : 'circle-outline') as MdiIconName,
      ...(index === 0 ? { heading: 'Default shell', separated: true } : {}),
    })),
  ];
});
function chooseShell(id: string): void {
  const [action, shell] = id.split(':');
  if (action === 'open') add(shell);
  else {
    host.setDefaultShell(shell);
  }
}
/**
 * Splits the focused pane: `right` adds a column beside its column, and `down` a pane below it;
 * the new shell takes half of the space.
 */
function split(direction: 'right' | 'down'): void {
  const tab = activeTab.value;
  if (!tab || full.value) return;
  const index = tab.columns.findIndex((column) => column.panes.includes(tab.focused));
  const column = tab.columns[index];
  const id = nextId++;
  if (direction === 'right') {
    const half = tab.sizes[index] / 2;
    tab.columns.splice(index + 1, 0, { id, panes: [id], sizes: [100] });
    tab.sizes.splice(index, 1, half, half);
  } else {
    const row = column.panes.indexOf(tab.focused);
    const half = column.sizes[row] / 2;
    column.panes.splice(row + 1, 0, id);
    column.sizes.splice(row, 1, half, half);
  }
  tab.focused = id;
}
/**
 * Closes one pane and its shell; its space goes to a neighbour, an emptied column closes, and the
 * last pane closes the tab.
 */
function closePane(tab: Tab, pane: number): void {
  if (panesOf(tab).length === 1) return close(tab.id);
  const index = tab.columns.findIndex((column) => column.panes.includes(pane));
  const column = tab.columns[index];
  const row = column.panes.indexOf(pane);
  delete views.value[pane];
  if (column.panes.length === 1) {
    tab.columns.splice(index, 1);
    const [size] = tab.sizes.splice(index, 1);
    tab.sizes[Math.max(0, index - 1)] += size;
    if (tab.focused === pane) tab.focused = tab.columns[Math.max(0, index - 1)].panes[0];
  } else {
    column.panes.splice(row, 1);
    const [size] = column.sizes.splice(row, 1);
    column.sizes[Math.max(0, row - 1)] += size;
    if (tab.focused === pane) tab.focused = column.panes[Math.max(0, row - 1)];
  }
  void nextTick(() => views.value[tab.focused]?.focus());
}
/** Closes a terminal tab and all its shells; the neighbouring tab is shown in its place. */
function close(id: number): void {
  const index = tabs.value.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const [tab] = tabs.value.splice(index, 1);
  for (const pane of panesOf(tab)) delete views.value[pane];
  if (activeId.value === id)
    activeId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id;
  void nextTick(() =>
    document
      .querySelector<HTMLElement>(
        activeId.value ? '[data-terminal-tab][aria-selected="true"]' : '[data-terminal-new]',
      )
      ?.focus(),
  );
}
/** A divider moves the boundary between entry `index` of `sizes` and the next. */
function resize(sizes: number[], index: number, value: number): void {
  const pair = sizes[index] + sizes[index + 1];
  sizes[index] = value;
  sizes[index + 1] = pair - value;
}
/** The size, in percent of `box`, that a divider at the pointer gives entry `index`. */
function measure(
  box: HTMLElement | null | undefined,
  sizes: number[],
  index: number,
  vertical: boolean,
  point: { x: number; y: number },
): number {
  if (!box) return sizes[index];
  const rect = box.getBoundingClientRect();
  const before = sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
  return vertical
    ? ((point.y - rect.top) / rect.height) * 100 - before
    : ((point.x - rect.left) / rect.width) * 100 - before;
}
/** Focuses the nearest pane of the shown tab in a direction from the focused one. */
function focusPane(direction: 'left' | 'right' | 'up' | 'down'): void {
  const tab = activeTab.value;
  const row = tab && boxes.value[`tab-${tab.id}`];
  if (!tab || !row) return;
  const rects = new Map(
    [...row.querySelectorAll<HTMLElement>('[data-terminal-pane]')].map((element, index) => [
      panesOf(tab)[index],
      element.getBoundingClientRect(),
    ]),
  );
  const from = rects.get(tab.focused);
  if (!from) return;
  const center = (rect: DOMRect) => ({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });
  const origin = center(from);
  let best: { pane: number; distance: number } | undefined;
  for (const [pane, rect] of rects) {
    if (pane === tab.focused) continue;
    const point = center(rect);
    const ahead =
      direction === 'left'
        ? rect.right <= from.left + 1
        : direction === 'right'
          ? rect.left >= from.right - 1
          : direction === 'up'
            ? rect.bottom <= from.top + 1
            : rect.top >= from.bottom - 1;
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    if (ahead && (!best || distance < best.distance)) best = { pane, distance };
  }
  if (best) tab.focused = best.pane;
}
const ARROWS = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
} as const;
/**
 * Terminal shortcuts while focus is in the panel, caught before the shell and the app's own
 * shortcuts (where Mod+\ switches the request layout).
 */
function onShortcut(event: KeyboardEvent): void {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (mod && !event.altKey && event.code === 'Backslash') split(event.shiftKey ? 'down' : 'right');
  else if (event.ctrlKey && event.shiftKey && !event.metaKey && event.code === 'Backquote') add();
  // Mod+W closes the window from the default menu, so closing a pane takes Shift as well.
  else if (mod && event.shiftKey && !event.altKey && event.code === 'KeyW') {
    if (activeTab.value) closePane(activeTab.value, activeTab.value.focused);
  } else if (mod && event.altKey && event.key in ARROWS)
    focusPane(ARROWS[event.key as keyof typeof ARROWS]);
  else return;
  event.preventDefault();
  event.stopPropagation();
}
const shortcut = (...keys: string[]) => keys.map(keyLabel).join(mac ? '' : '+');
// Reordering tabs: drag one onto another (it lands on the nearer side), or Alt+Left/Right.
const dragging = ref<number>();
const dropTarget = ref<{ id: number; after: boolean }>();
/** Moves a tab to sit before or after another. */
function moveTab(id: number, target: number, after: boolean): void {
  if (id === target) return;
  const from = tabs.value.findIndex((tab) => tab.id === id);
  if (from < 0) return;
  const [tab] = tabs.value.splice(from, 1);
  const to = tabs.value.findIndex((item) => item.id === target);
  tabs.value.splice(to + (after ? 1 : 0), 0, tab);
}
function onDragStart(event: DragEvent, tab: Tab): void {
  dragging.value = tab.id;
  event.dataTransfer?.setData('text/plain', title(tab));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function onDragOver(event: DragEvent, tab: Tab): void {
  if (dragging.value === undefined) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropTarget.value =
    tab.id === dragging.value
      ? undefined
      : { id: tab.id, after: event.clientX > box.left + box.width / 2 };
}
function onDrop(event: DragEvent): void {
  event.preventDefault();
  if (dragging.value !== undefined && dropTarget.value)
    moveTab(dragging.value, dropTarget.value.id, dropTarget.value.after);
  onDragEnd();
}
function onDragEnd(): void {
  dragging.value = undefined;
  dropTarget.value = undefined;
}
// A tab's context menu: right-click, Shift+F10, or the context menu key.
const contextMenu = ref<InstanceType<typeof ContextMenu>>();
const menuFor = ref<number>();
const menuItems = computed<MenuItem[]>(() => {
  const index = tabs.value.findIndex((tab) => tab.id === menuFor.value);
  const tab = tabs.value[index];
  const splitFull = !tab || panesOf(tab).length >= MAX_PANES;
  return [
    { id: 'rename', label: 'Rename', icon: 'pencil-outline', shortcut: 'F2' },
    {
      id: 'split-right',
      label: 'Split right',
      icon: 'view-split-vertical',
      shortcut: shortcut('Mod', '\\'),
      disabled: !bridge || splitFull,
      separated: true,
    },
    {
      id: 'split-down',
      label: 'Split down',
      icon: 'view-split-horizontal',
      shortcut: shortcut('Mod', 'Shift', '\\'),
      disabled: !bridge || splitFull,
    },
    { id: 'close', label: 'Close terminal', icon: 'close', separated: true },
    {
      id: 'others',
      label: 'Close other terminals',
      icon: 'close',
      disabled: tabs.value.length < 2,
    },
    {
      id: 'right',
      label: 'Close terminals to the right',
      icon: 'chevron-right',
      disabled: index < 0 || index === tabs.value.length - 1,
    },
  ];
});
function openContextMenu(tab: Tab, at?: { x: number; y: number }): void {
  const button = document.getElementById(`terminal-tab-${tab.id}`);
  if (!button || renaming.value === tab.id) return;
  menuFor.value = tab.id;
  contextMenu.value?.openFor(button, at);
}
function onContextMenu(event: MouseEvent, tab: Tab): void {
  event.preventDefault();
  openContextMenu(tab, { x: event.clientX, y: event.clientY });
}
function onMenuSelect(command: string): void {
  const index = tabs.value.findIndex((tab) => tab.id === menuFor.value);
  const tab = tabs.value[index];
  if (!tab) return;
  if (command === 'rename') return startRename(tab);
  if (command === 'split-right' || command === 'split-down') {
    activeId.value = tab.id;
    return split(command === 'split-right' ? 'right' : 'down');
  }
  const closing =
    command === 'close'
      ? [tab]
      : command === 'others'
        ? tabs.value.filter((item) => item.id !== tab.id)
        : tabs.value.slice(index + 1);
  for (const item of closing) close(item.id);
}
function onKeydown(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement) return;
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const tab = activeTab.value;
    const index = tab ? tabs.value.indexOf(tab) : -1;
    const neighbour = tabs.value[index + (event.key === 'ArrowRight' ? 1 : -1)];
    event.preventDefault();
    if (tab && neighbour) {
      moveTab(tab.id, neighbour.id, event.key === 'ArrowRight');
      focusTab(tab.id);
    }
    return;
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    const tab = activeTab.value;
    if (tab) openContextMenu(tab);
    event.preventDefault();
    return;
  }
  if (event.key === 'F2') {
    const tab = activeTab.value;
    if (tab) startRename(tab);
    event.preventDefault();
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const ids = tabs.value.map((tab) => tab.id);
  const current = ids.indexOf(activeId.value ?? ids[0]);
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? ids.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
  event.preventDefault();
  activeId.value = ids[index];
  void nextTick(() =>
    document.querySelector<HTMLElement>('[data-terminal-tab][aria-selected="true"]')?.focus(),
  );
}
</script>

<template>
  <section class="devtools-terminal" aria-label="Terminal" @keydown.capture="onShortcut">
    <div class="devtools-toolbar terminal-toolbar">
      <ScrollRow
        ref="tabRow"
        class="terminal-tabs"
        frame-class="terminal-tabs-frame"
        role="tablist"
        aria-label="Terminals"
        noun="terminals"
        @keydown="onKeydown"
      >
        <div
          v-for="tab in tabs"
          :key="tab.id"
          :draggable="renaming !== tab.id"
          :class="[
            'terminal-tab',
            {
              dragging: dragging === tab.id,
              'drop-before': dropTarget?.id === tab.id && !dropTarget.after,
              'drop-after': dropTarget?.id === tab.id && dropTarget.after,
              active: tab.id === activeId,
              exited: panesOf(tab).every((pane) => views[pane]?.status === 'exited'),
            },
          ]"
          data-terminal-tab-item
          @dragstart="onDragStart($event, tab)"
          @dragover="onDragOver($event, tab)"
          @drop="onDrop"
          @dragend="onDragEnd"
          @contextmenu="onContextMenu($event, tab)"
        >
          <input
            v-if="renaming === tab.id"
            v-model="draft"
            class="terminal-tab-rename"
            data-terminal-rename
            :maxlength="MAX_NAME"
            :placeholder="defaultTitle(tab)"
            aria-label="Terminal name"
            @keydown.enter.prevent="commitRename(tab)"
            @keydown.esc.prevent.stop="cancelRename(tab)"
            @blur="commitRename(tab)"
          />
          <button
            v-else
            :id="`terminal-tab-${tab.id}`"
            type="button"
            role="tab"
            title="Double-click or press F2 to rename · Drag or Alt+←/→ to move"
            data-terminal-tab
            :aria-selected="tab.id === activeId"
            :aria-controls="`terminal-panel-${tab.id}`"
            :tabindex="tab.id === activeId ? 0 : -1"
            @click="select(tab.id)"
            @dblclick="startRename(tab)"
          >
            <MdiIcon :name="panesOf(tab).length > 1 ? 'view-grid-outline' : 'console'" /><span>{{
              title(tab)
            }}</span
            ><span
              v-if="panesOf(tab).length > 1"
              class="terminal-tab-panes"
              data-terminal-pane-count
              >{{ panesOf(tab).length }}</span
            ></button
          ><button
            type="button"
            class="terminal-tab-close"
            data-terminal-close
            :aria-label="`Close ${title(tab)}`"
            :title="`Close ${title(tab)}`"
            @click="close(tab.id)"
          >
            <MdiIcon name="close" />
          </button>
        </div>
      </ScrollRow>
      <UiIconButton
        :label="`New terminal (${shortcut('Ctrl', 'Shift', '\`')})`"
        icon="plus"
        data-terminal-new
        :disabled="!bridge"
        @click="add()"
      /><ActionMenu
        label="Choose a shell"
        icon="chevron-down"
        :items="shellItems"
        trigger-class="terminal-shell-trigger"
        data-terminal-shells
        :disabled="!bridge || !shells.length"
        @select="chooseShell"
      /><UiIconButton
        :label="
          full
            ? `A terminal splits into at most ${MAX_PANES} panes`
            : `Split right (${shortcut('Mod', '\\')})`
        "
        icon="view-split-vertical"
        data-terminal-split
        :disabled="!bridge || full"
        @click="split('right')"
      /><UiIconButton
        :label="
          full
            ? `A terminal splits into at most ${MAX_PANES} panes`
            : `Split down (${shortcut('Mod', 'Shift', '\\')})`
        "
        icon="view-split-horizontal"
        data-terminal-split-down
        :disabled="!bridge || full"
        @click="split('down')"
      />
      <span class="devtools-summary" data-terminal-status>
        <template v-if="!active"></template>
        <template v-else-if="active.status === 'running' && active.session">
          <span class="font-mono">{{ active.session.cwd }}</span>
        </template>
        <template v-else-if="active.status === 'starting'">Starting shell…</template>
        <template v-else-if="active.status === 'exited'">Shell exited</template>
        <template v-else>{{ active.message }}</template>
      </span>
      <UiIconButton
        label="Clear terminal"
        icon="delete-outline"
        data-terminal-clear
        :disabled="!active || active.status === 'unavailable'"
        @click="active?.clear()"
      /><UiIconButton
        label="Restart shell"
        icon="refresh"
        data-terminal-restart
        :disabled="!active || !bridge"
        @click="active?.restart()"
      /><UiIconButton
        label="Stop shell"
        icon="stop-circle-outline"
        data-terminal-stop
        :disabled="active?.status !== 'running'"
        @click="active?.stop()"
      /><UiIconButton
        v-if="host.placement === 'panel'"
        label="Open in new window"
        icon="dock-window"
        data-terminal-expand
        @click="host.expand()"
      /><UiIconButton
        v-else
        label="Return to panel"
        icon="dock-bottom"
        data-terminal-return
        @click="host.returnToPanel()"
      />
    </div>
    <ContextMenu
      ref="contextMenu"
      label="Terminal tab actions"
      :items="menuItems"
      data-terminal-tab-menu
      @select="onMenuSelect"
    />
    <div class="terminal-views">
      <div
        v-for="tab in tabs"
        v-show="tab.id === activeId"
        :id="`terminal-panel-${tab.id}`"
        :key="tab.id"
        :ref="(element) => (boxes[`tab-${tab.id}`] = element as HTMLElement | null)"
        class="terminal-view"
        role="tabpanel"
        :aria-labelledby="`terminal-tab-${tab.id}`"
      >
        <template v-for="(column, index) in tab.columns" :key="column.id">
          <PaneResizer
            v-if="index > 0"
            direction="columns"
            label="Resize terminal columns"
            class="terminal-divider"
            :value="Math.round(tab.sizes[index - 1])"
            :min="MIN_PANE"
            :max="Math.round(tab.sizes[index - 1] + tab.sizes[index] - MIN_PANE)"
            :reset="Math.round((tab.sizes[index - 1] + tab.sizes[index]) / 2)"
            :step="2"
            :measure="
              (point) => measure(boxes[`tab-${tab.id}`], tab.sizes, index - 1, false, point)
            "
            @change="(value) => resize(tab.sizes, index - 1, value)"
          />
          <div
            :ref="(element) => (boxes[`column-${column.id}`] = element as HTMLElement | null)"
            class="terminal-column"
            :style="{ flexBasis: `${tab.sizes[index]}%` }"
          >
            <template v-for="(pane, row) in column.panes" :key="pane">
              <PaneResizer
                v-if="row > 0"
                direction="rows"
                label="Resize terminal rows"
                class="terminal-divider-row"
                :value="Math.round(column.sizes[row - 1])"
                :min="MIN_PANE"
                :max="Math.round(column.sizes[row - 1] + column.sizes[row] - MIN_PANE)"
                :reset="Math.round((column.sizes[row - 1] + column.sizes[row]) / 2)"
                :step="2"
                :measure="
                  (point) =>
                    measure(boxes[`column-${column.id}`], column.sizes, row - 1, true, point)
                "
                @change="(value) => resize(column.sizes, row - 1, value)"
              />
              <div
                :class="[
                  'terminal-pane',
                  { focused: panesOf(tab).length > 1 && pane === tab.focused },
                ]"
                :style="{ flexBasis: `${column.sizes[row]}%` }"
                data-terminal-pane
                @focusin="tab.focused = pane"
                @pointerdown="tab.focused = pane"
              >
                <TerminalView
                  :ref="(view) => (views[pane] = view as View | null)"
                  :active="tab.id === activeId && pane === tab.focused"
                  :shell="tab.shell"
                  :input="pane === tab.columns[0].panes[0] ? tab.input : undefined"
                />
                <button
                  v-if="panesOf(tab).length > 1"
                  type="button"
                  class="terminal-pane-close"
                  data-terminal-pane-close
                  :aria-label="`Close a pane of ${title(tab)}`"
                  :title="`Close pane (${shortcut('Mod', 'Shift', 'W')})`"
                  @click.stop="closePane(tab, pane)"
                >
                  <MdiIcon name="close" />
                </button>
              </div>
            </template>
          </div>
        </template>
      </div>
      <div v-if="!tabs.length" class="terminal-empty">
        <p>No terminals are open.</p>
        <UiButton label="New terminal" icon="plus" data-terminal-empty-new @click="add()" />
      </div>
    </div>
  </section>
</template>
