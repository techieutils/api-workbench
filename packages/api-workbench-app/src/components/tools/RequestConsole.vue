<script setup lang="ts">
import { methodIcon } from '../../stores/protocols';
import { computed, nextTick, onBeforeUpdate, onUpdated, ref } from 'vue';
import { toast } from '../../utils';
import { useToolsStore } from '../../stores/tools';
import { useWorkspaceStore } from '../../stores/workspace';
import MdiIcon from '../MdiIcon.vue';
import UiSelect, { type SelectOption } from '../ui/UiSelect.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import { useContextMenu } from '../../composables/context-menu';
import { useRequestsStore } from '../../stores/requests';

/** Status and timing events for sent requests; bodies and header values are never recorded. */
const tools = useToolsStore();
const workspace = useWorkspaceStore();
const options = tools.consoleOptions;
/** The level icons, the same as in the level select box. */
const LEVEL_ICONS: Record<string, MdiIconName> = {
  info: 'information-outline',
  success: 'check-circle-outline',
  error: 'alert-circle-outline',
};
// The toolbar's select boxes: an icon per option, and each level in its colour.
const scopeOptions: SelectOption[] = [
  { value: 'current', label: 'Current request', icon: 'file-document-outline' },
  { value: 'all', label: 'All requests', icon: 'format-list-bulleted' },
];
const levelOptions: SelectOption[] = [
  { value: 'all', label: 'All levels', icon: 'filter-variant' },
  { value: 'info', label: 'Info', icon: 'information-outline', class: 'level-tone-info' },
  { value: 'success', label: 'Success', icon: 'check-circle-outline', class: 'level-tone-success' },
  { value: 'error', label: 'Error', icon: 'alert-circle-outline', class: 'level-tone-error' },
];
const entries = computed(() =>
  tools.consoleEntries.filter(
    (entry) =>
      (options.scope !== 'current' || entry.requestId === workspace.state.active) &&
      (options.level === 'all' || entry.level === options.level) &&
      `${entry.requestName} ${entry.url} ${entry.method} ${entry.message}`
        .toLowerCase()
        .includes(options.search.toLowerCase()),
  ),
);
function clear(): void {
  if (options.scope === 'all') tools.consoleEntries.splice(0);
  else
    for (let index = tools.consoleEntries.length - 1; index >= 0; index--)
      if (tools.consoleEntries[index].requestId === workspace.state.active)
        tools.consoleEntries.splice(index, 1);
}
/** An entry as one line of text, as copied. */
const line = (entry: RequestConsoleEntry) =>
  `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} ${entry.method} ${entry.url} ${entry.message}`;
async function writeClipboard(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
const copy = () => writeClipboard(entries.value.map(line).join('\n'), 'Console copied');

// An entry's context menu: copy parts of it, open its request, filter to its level, or remove it.
// The log takes focus once; arrow keys move between entries.
const requests = useRequestsStore();
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onEntryKeydown,
} = useContextMenu<RequestConsoleEntry>();
const menuItems = computed<MenuItem[]>(() => {
  const entry = menuFor.value;
  return [
    { id: 'message', label: 'Copy message', icon: 'content-copy' },
    { id: 'url', label: 'Copy URL', icon: 'link-variant' },
    { id: 'line', label: 'Copy entry', icon: 'text' },
    {
      id: 'open',
      label: 'Open request',
      icon: 'file-document-outline',
      separated: true,
      disabled: !workspace.state.requests.some((request) => request.id === entry?.requestId),
    },
    {
      id: 'level',
      label: `Show only ${entry?.level ?? ''} events`,
      icon: 'filter-variant',
      disabled: options.level === entry?.level,
    },
    { id: 'remove', label: 'Remove entry', icon: 'delete-outline', danger: true, separated: true },
  ];
});
function onMenuSelect(command: string): void {
  const entry = menuFor.value;
  if (!entry) return;
  if (command === 'message') void writeClipboard(entry.message, 'Message copied');
  else if (command === 'url') void writeClipboard(entry.url, 'URL copied');
  else if (command === 'line') void writeClipboard(line(entry), 'Entry copied');
  else if (command === 'open') requests.openRequest(entry.requestId);
  else if (command === 'level') options.level = entry.level;
  else if (command === 'remove') {
    const index = tools.consoleEntries.indexOf(entry);
    if (index >= 0) tools.consoleEntries.splice(index, 1);
    void nextTick(() => log.value?.focus({ preventScroll: true }));
  }
}
function onLogKeydown(event: KeyboardEvent): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows = [...(log.value?.querySelectorAll<HTMLElement>('.console-entry') ?? [])];
  if (!rows.length) return;
  event.preventDefault();
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : index < 0
          ? event.key === 'ArrowDown'
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
  rows[next].focus();
}

// New events stay in view while the reader is already at the end.
const log = ref<HTMLElement>();
let follow = false;
onBeforeUpdate(() => {
  const element = log.value;
  follow = Boolean(element && element.scrollHeight - element.scrollTop - element.clientHeight < 40);
});
onUpdated(() => {
  if (follow && log.value) log.value.scrollTop = log.value.scrollHeight;
});
</script>

<template>
  <section class="request-console" aria-label="Request console">
    <div class="console-toolbar">
      <UiSelect
        id="console-scope"
        v-model="options.scope"
        aria-label="Console request scope"
        :root-attrs="{ 'data-console-select': 'scope' }"
        :searchable="false"
        :options="scopeOptions"
      /><UiSelect
        id="console-level"
        v-model="options.level"
        aria-label="Console level"
        :root-attrs="{ 'data-console-select': 'level' }"
        :searchable="false"
        :options="levelOptions"
      /><input
        id="console-search"
        v-model="options.search"
        placeholder="Filter console…"
        aria-label="Filter console events"
      /><button
        type="button"
        data-console-copy
        title="Copy filtered console"
        aria-label="Copy filtered console"
        @click="copy"
      >
        <MdiIcon name="content-copy" /></button
      ><button
        type="button"
        data-console-clear
        title="Clear console"
        aria-label="Clear console"
        @click="clear"
      >
        <MdiIcon name="delete-outline" />
      </button>
    </div>
    <div
      ref="log"
      class="console-events"
      role="log"
      aria-live="polite"
      aria-label="Request events"
      tabindex="0"
      @keydown="onLogKeydown"
    >
      <div
        v-for="entry in entries"
        :key="entry.id"
        :class="['console-entry', entry.level]"
        tabindex="-1"
        :data-console-entry="entry.id"
        @contextmenu="openMenu($event, entry)"
        @keydown="onEntryKeydown($event, entry)"
      >
        <time>{{ new Date(entry.at).toLocaleTimeString() }}</time
        ><span class="console-level"
          ><MdiIcon :name="LEVEL_ICONS[entry.level]" />{{ entry.level.toUpperCase() }}</span
        ><span class="console-message"
          ><strong
            ><span :class="['method', entry.method]"
              ><MdiIcon :name="methodIcon(entry.method)" class="method-icon" />{{
                entry.method
              }}</span
            >
            · {{ entry.requestName }}</strong
          ><span>{{ entry.message }}</span
          ><code>{{ entry.url }}</code></span
        >
      </div>
      <div v-if="!entries.length" class="console-empty">
        No matching console events. Send a request to see its status and timing.
      </div>
    </div>
    <ContextMenu
      ref="contextMenu"
      label="Console entry actions"
      :items="menuItems"
      data-console-menu
      @select="onMenuSelect"
    />
  </section>
</template>
