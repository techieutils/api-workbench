<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useToolsStore } from '../../stores/tools';
import { methodIcon } from '../../stores/protocols';
import MdiIcon from '../MdiIcon.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiSelect, { type SelectOption } from '../ui/UiSelect.vue';
import { finalPhases, formatBytes, formatMs, statusTone } from './format';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import { useContextMenu } from '../../composables/context-menu';
import { useRequestsStore } from '../../stores/requests';
import { useWorkspaceStore } from '../../stores/workspace';
import { toast } from '../../utils';

/** Every HTTP request sent this session, with its status, size, timing, and response headers. */
const tools = useToolsStore();
const filters = reactive({ search: '', status: 'all' });
const selectedId = ref<string>();
const statusOptions: SelectOption[] = [
  { value: 'all', label: 'All statuses', icon: 'filter-variant' },
  { value: '2', label: '2xx Success', icon: 'check-circle-outline', class: 'tone-ok' },
  { value: '3', label: '3xx Redirect', icon: 'arrow-top-right', class: 'tone-redirect' },
  { value: '4', label: '4xx Client error', icon: 'alert-circle-outline', class: 'tone-client' },
  { value: '5', label: '5xx Server error', icon: 'alert-circle-outline', class: 'tone-server' },
  { value: 'failed', label: 'Failed', icon: 'close', class: 'tone-failed' },
];
const entries = computed(() => {
  const search = filters.search.toLowerCase();
  return tools.networkEntries.filter(
    (entry) =>
      (filters.status === 'all' ||
        (filters.status === 'failed'
          ? entry.error !== undefined
          : String(entry.status ?? '').startsWith(filters.status))) &&
      `${entry.requestName} ${entry.method} ${entry.url} ${entry.status ?? ''}`
        .toLowerCase()
        .includes(search),
  );
});
const selected = computed(() =>
  tools.networkEntries.find((entry) => entry.id === selectedId.value),
);
const summary = computed(() => {
  const list = entries.value;
  const bytes = list.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const time = list.reduce((sum, entry) => sum + entry.time, 0);
  return `${list.length} of ${tools.networkEntries.length} requests · ${formatBytes(bytes)} received · ${formatMs(time)}`;
});
/** Each row's waterfall bar spans its start and duration within the visible requests. */
const span = computed(() => {
  const list = entries.value;
  if (!list.length) return { start: 0, total: 1 };
  const start = Math.min(...list.map((entry) => entry.at));
  const end = Math.max(...list.map((entry) => entry.at + entry.time));
  return { start, total: Math.max(1, end - start) };
});
const bar = (entry: NetworkEntry) => ({
  left: `${((entry.at - span.value.start) / span.value.total) * 100}%`,
  width: `${Math.max(1, (entry.time / span.value.total) * 100)}%`,
});
const name = (entry: NetworkEntry) => {
  try {
    const url = new URL(entry.url);
    return url.pathname.split('/').filter(Boolean).at(-1) || url.host;
  } catch {
    return entry.url;
  }
};
const phaseWidth = (entry: NetworkEntry, durationMs: number) =>
  `${Math.max(1, (durationMs / Math.max(1, entry.timings?.requests.at(-1)?.durationMs ?? entry.time)) * 100)}%`;
// A request's context menu: its details, opening its saved request, copying its URL, and
// narrowing the list to its status class.
const workspace = useWorkspaceStore();
const requests = useRequestsStore();
const statusClass = (entry: NetworkEntry) =>
  entry.error !== undefined ? 'failed' : String(entry.status ?? '').slice(0, 1);
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<NetworkEntry>();
const menuItems = computed<MenuItem[]>(() => {
  const entry = menuFor.value;
  const status = entry ? statusClass(entry) : '';
  return [
    { id: 'details', label: 'Show details', icon: 'information-outline' },
    {
      id: 'open',
      label: 'Open request',
      icon: 'file-document-outline',
      disabled: !workspace.state.requests.some((request) => request.id === entry?.requestId),
    },
    { id: 'copy', label: 'Copy URL', icon: 'content-copy', separated: true },
    {
      id: 'filter',
      label: status === 'failed' ? 'Show only failed requests' : `Show only ${status}xx`,
      icon: 'filter-variant',
      separated: true,
      disabled: filters.status === status,
    },
  ];
});
async function onMenuSelect(command: string): Promise<void> {
  const entry = menuFor.value;
  if (!entry) return;
  if (command === 'details') selectedId.value = entry.id;
  else if (command === 'open') requests.openRequest(entry.requestId);
  else if (command === 'filter') filters.status = statusClass(entry);
  else if (command === 'copy')
    try {
      await navigator.clipboard.writeText(entry.url);
      toast('URL copied', 'success');
    } catch {
      toast('The URL could not be copied', 'error');
    }
}
function clear(): void {
  tools.networkEntries.splice(0);
  selectedId.value = undefined;
}
</script>

<template>
  <section class="devtools-network" aria-label="Network">
    <div class="devtools-toolbar">
      <input
        id="network-search"
        v-model="filters.search"
        placeholder="Filter requests…"
        aria-label="Filter network requests"
      /><UiSelect
        id="network-status"
        v-model="filters.status"
        aria-label="Network status filter"
        :root-attrs="{ 'data-network-select': 'status' }"
        :searchable="false"
        :options="statusOptions"
      /><span class="devtools-summary">{{ summary }}</span
      ><UiIconButton
        label="Clear network log"
        icon="delete-outline"
        data-network-clear
        @click="clear"
      />
    </div>
    <div :class="['network-layout', { 'has-detail': selected }]">
      <div class="network-table" role="group" aria-label="Network requests">
        <div class="network-row network-head" aria-hidden="true">
          <span>Name</span><span>Method</span><span>Status</span><span>Type</span><span>Size</span
          ><span>Time</span><span class="network-waterfall-head">Waterfall</span>
        </div>
        <button
          v-for="entry in [...entries].reverse()"
          :key="entry.id"
          type="button"
          :class="['network-row', { selected: entry.id === selectedId }]"
          :aria-pressed="entry.id === selectedId"
          :data-network-entry="entry.id"
          @click="selectedId = entry.id === selectedId ? undefined : entry.id"
          @contextmenu="openMenu($event, entry)"
          @keydown="onRowKeydown($event, entry)"
        >
          <span class="network-name" :title="entry.url"
            ><strong>{{ name(entry) }}</strong
            ><small>{{ entry.requestName }}</small></span
          ><span :class="['method', entry.method]"
            ><MdiIcon :name="methodIcon(entry.method)" class="method-icon" />{{
              entry.method
            }}</span
          ><span :class="['network-status', statusTone(entry)]">{{
            entry.error !== undefined ? 'Failed' : entry.status
          }}</span
          ><span class="network-type">{{ entry.contentType ?? '—' }}</span
          ><span>{{ formatBytes(entry.size) }}</span
          ><span>{{ formatMs(entry.time) }}</span
          ><span class="network-waterfall"
            ><i :class="statusTone(entry)" :style="bar(entry)"></i
          ></span>
        </button>
        <p v-if="!entries.length" class="devtools-empty">
          {{
            tools.networkEntries.length
              ? 'No requests match the filters.'
              : 'Send a request to see it here with its status, size, and timing.'
          }}
        </p>
      </div>
      <aside v-if="selected" class="network-detail" aria-label="Request details">
        <header>
          <strong :title="selected.url">{{ name(selected) }}</strong
          ><UiIconButton
            label="Close request details"
            icon="close"
            data-network-detail-close
            @click="selectedId = undefined"
          />
        </header>
        <h3>General</h3>
        <dl>
          <dt>URL</dt>
          <dd class="font-mono">{{ selected.url }}</dd>
          <dt>Method</dt>
          <dd>{{ selected.method }}</dd>
          <dt>Status</dt>
          <dd :class="statusTone(selected)">
            {{ selected.error ?? `${selected.status} ${selected.statusText}` }}
          </dd>
          <template v-if="selected.httpVersion">
            <dt>Protocol</dt>
            <dd>HTTP/{{ selected.httpVersion }}</dd>
          </template>
          <dt>Started</dt>
          <dd>{{ new Date(selected.at).toLocaleTimeString() }}</dd>
          <dt>Duration</dt>
          <dd>{{ formatMs(selected.time) }}</dd>
          <dt>Size</dt>
          <dd>{{ formatBytes(selected.size) }}</dd>
        </dl>
        <template v-if="finalPhases(selected).length">
          <h3>Timing</h3>
          <div class="network-phases">
            <div v-for="phase in finalPhases(selected)" :key="phase.id" class="network-phase">
              <span>{{ phase.label }}</span
              ><span class="network-phase-track"
                ><i
                  :class="`phase-${phase.id}`"
                  :style="{ width: phaseWidth(selected, phase.durationMs) }"
                ></i></span
              ><span>{{ formatMs(phase.durationMs) }}</span>
            </div>
          </div>
        </template>
        <template v-if="selected.headers.length">
          <h3>Response headers</h3>
          <dl class="network-headers">
            <template v-for="[key, value] in selected.headers" :key="key">
              <dt>{{ key }}</dt>
              <dd class="font-mono">{{ value }}</dd>
            </template>
          </dl>
        </template>
      </aside>
    </div>
    <ContextMenu
      ref="contextMenu"
      label="Network request actions"
      :items="menuItems"
      data-network-menu
      @select="onMenuSelect"
    />
  </section>
</template>
