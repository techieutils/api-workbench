<script setup lang="ts">
import {
  describeTagFilter,
  effectiveTags,
  matchesTags,
  tagCounts,
  tagFilterActive,
} from '@techieutils/api-workbench-common/tags';
import TagFilterChips from '../ui/TagFilterChips.vue';
import { useWorkspacesStore } from '../../stores/workspaces';
import { methodIcon } from '../../stores/protocols';
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import type { HistoryEntry, HttpResponse } from '@techieutils/api-workbench-common/types';
import { captureVariableName } from '@techieutils/api-workbench-common/capture-suggestions';
import { action } from '../../actions';
import { parseSetCookie } from '@techieutils/api-workbench-common/cookies';
import { responseCookies } from '@techieutils/api-workbench-common/variables';
import { useRequestTestsStore } from '../../stores/request-tests';
import { useRequestsStore } from '../../stores/requests';
import { useScreensStore } from '../../stores/screens';
import { useWorkspaceStore } from '../../stores/workspace';
import { errorMessage, relativeTime, toast } from '../../utils';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import { useContextMenu } from '../../composables/context-menu';
import { useRendered } from '../../composables/rendered';
import { bodyCapture, headerLineCapture } from '../../composables/body-capture';
import MdiIcon from '../MdiIcon.vue';
import PageHeader from '../ui/PageHeader.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiTabs from '../ui/UiTabs.vue';
import SourceEditor from '../SourceEditor.vue';
import ResponseHeaderMenu from '../response/ResponseHeaderMenu.vue';
import NetworkTimingChart from '../response/NetworkTimingChart.vue';
import CertificateDetails from '../response/CertificateDetails.vue';
import ResponseDiff from '../response/ResponseDiff.vue';
import TestResults from '../response/TestResults.vue';
import HistoryConsole from './HistoryConsole.vue';
import ResponsePreview from '../response/ResponsePreview.vue';
import { bodyKind } from '@techieutils/api-workbench-common/response-body';
import UiSelect from '../ui/UiSelect.vue';
import { withIcons } from '../../select-options';

/** Sent requests on this device, grouped by day, searchable and filterable by status class. */
const workspace = useWorkspaceStore();
const workspaces = useWorkspacesStore();
/** Your own entries count against your limit; teammates' are theirs. */
const ownCount = () => workspace.state.history.filter((entry) => !entry.author).length;
const requests = useRequestsStore();
const filters = useScreensStore().history;
const requestTests = useRequestTestsStore();
const FILTERS = ['All', '2xx', '3xx', '4xx', '5xx', 'Errors'] as const;
const statusGroup = (status: number | undefined) =>
  status ? `${Math.floor(status / 100)}xx` : 'Errors';
const config = computed(() => workspace.settings());
const counts = computed(() => {
  const counts = new Map<string, number>();
  workspace.state.history.forEach((entry) =>
    counts.set(statusGroup(entry.status), (counts.get(statusGroup(entry.status)) || 0) + 1),
  );
  return counts;
});

function historyDay(date: Date): string {
  const start = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(date)) / 86400000);
  return days === 0
    ? 'Today'
    : days === 1
      ? 'Yesterday'
      : date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
/** Matching entries, each marked with the day heading that starts a new group. */
/** Each entry with its request, and that request's tags (none once it is deleted). */
const withRequests = computed(() =>
  workspace.state.history.map((entry, index) => {
    const request = workspace.state.requests.find((item) => item.id === entry.requestId);
    return {
      entry,
      index,
      request,
      tags: request ? effectiveTags(workspace.state, request) : [],
      date: new Date(entry.date),
    };
  }),
);
/** The tags of the requests in History, with how many entries each has. */
const historyTagCounts = computed(() => tagCounts(withRequests.value));
const entries = computed(() => {
  const query = filters.query.trim().toLowerCase();
  let day = '';
  return withRequests.value
    .filter(
      ({ entry, request, tags }) =>
        (filters.status === 'All' || statusGroup(entry.status) === filters.status) &&
        matchesTags(tags, filters.tags) &&
        (!query ||
          (query.startsWith('#')
            ? tags.some((tag) => tag.toLowerCase() === query.slice(1))
            : `${entry.method} ${entry.url} ${request?.name || ''} ${entry.status || ''} ${tags.join(' ')}`
                .toLowerCase()
                .includes(query))),
    )
    .map((item) => {
      const heading = historyDay(item.date);
      const group = heading !== day ? heading : '';
      day = heading;
      return { ...item, group };
    });
});
// A row's context menu: right-click, Shift+F10, or the context menu key. Deleted requests can
// still have their URL copied or their entry removed.
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<number>();
const menuItems = computed<MenuItem[]>(() => {
  const entry = menuFor.value === undefined ? undefined : workspace.state.history[menuFor.value];
  const exists = workspace.state.requests.some((item) => item.id === entry?.requestId);
  const group = statusGroup(entry?.status);
  return [
    { id: 'open', label: 'Open request', icon: 'file-document-outline', disabled: !exists },
    { id: 'send', label: 'Open and send again', icon: 'arrow-top-right', disabled: !exists },
    { id: 'copy', label: 'Copy URL', icon: 'content-copy', separated: true },
    {
      id: 'filter',
      label: group === 'Errors' ? 'Show only errors' : `Show only ${group}`,
      icon: 'filter-variant',
      disabled: filters.status === group,
    },
    {
      id: 'remove',
      // Teammates' history is in their own files; only they can remove it.
      label: entry?.author ? `Sent by ${entry.author.name}` : 'Remove from history',
      icon: 'delete-outline',
      danger: true,
      separated: true,
      disabled: Boolean(entry?.author),
    },
  ];
});
async function onMenuSelect(command: string): Promise<void> {
  const index = menuFor.value;
  const entry = index === undefined ? undefined : workspace.state.history[index];
  if (!entry || index === undefined) return;
  if (command === 'open') requests.openRequest(entry.requestId);
  else if (command === 'send') {
    requests.openRequest(entry.requestId);
    await requests.send();
  } else if (command === 'copy') {
    try {
      await navigator.clipboard.writeText(entry.url);
      toast('URL copied', 'success');
    } catch {
      toast('The URL could not be copied', 'error');
    }
  } else if (command === 'filter') filters.status = statusGroup(entry.status);
  else if (command === 'remove') {
    workspace.state.history.splice(index, 1);
    workspace.persist();
    void nextTick(() =>
      document.querySelector<HTMLElement>('.history-entry')?.focus({ preventScroll: true }),
    );
  }
}
const editorRuntime = WorkbenchEditor;
// The selected entry's response: a read-only body (which Format can tidy) and its headers.
const entryKey = (entry: HistoryEntry) => `${entry.date}|${entry.requestId}`;
const selected = computed(() => {
  void workspace.revision;
  return workspace.state.history.find((entry) => entryKey(entry) === filters.selected);
});
const selectedRequest = computed(() =>
  workspace.state.requests.find((item) => item.id === selected.value?.requestId),
);
function select(entry: HistoryEntry): void {
  filters.selected = filters.selected === entryKey(entry) ? '' : entryKey(entry);
  if (filters.selected)
    void nextTick(() =>
      document
        .querySelector('[data-history-detail]')
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
}
function open(entry: HistoryEntry): void {
  if (workspace.state.requests.some((item) => item.id === entry.requestId))
    requests.openRequest(entry.requestId);
}
/**
 * The cookies the selected response set: each Set-Cookie header with its domain and path when it
 * was valid for the request, or, for entries kept before those headers were, the combined header.
 */
const historyCookies = useRendered(() => {
  const entry = selected.value;
  const response = entry?.response;
  if (!entry || !response) return [];
  if (!response.setCookies?.length)
    return responseCookies(response).map((cookie) => ({ ...cookie, scope: '' }));
  return response.setCookies.flatMap((item) =>
    responseCookies({ headers: {}, setCookies: [item] }).map((cookie) => {
      const parsed = parseSetCookie(item.header, item.url);
      return { ...cookie, scope: parsed ? `${parsed.domain}${parsed.path}` : '' };
    }),
  );
});
/** A response's Content-Type, whatever the header's case. */
const contentTypeOf = (headers: Record<string, string> = {}) =>
  Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
/** HTML and Markdown bodies History kept can be previewed (files were not kept). */
const previewable = useRendered(() => {
  const response = selected.value?.response;
  return Boolean(
    response?.body &&
    !response.binary &&
    ['html', 'markdown'].includes(bodyKind(contentTypeOf(response?.headers))),
  );
});
const historyTabs = (): UITab[] => [
  { name: 'Body', icon: 'code-tags' },
  ...(previewable.value ? [{ name: 'Preview', icon: 'eye-outline' as const }] : []),
  {
    name: 'Headers',
    icon: 'format-list-text',
    count: Object.keys(selected.value?.response?.headers ?? {}).length,
  },
  { name: 'Cookies', icon: 'cookie-outline', count: historyCookies.value.length || undefined },
  { name: 'Timeline', icon: 'timer-outline' },
  { name: 'Certificate', icon: 'shield-lock-outline' },
  { name: 'Compare', icon: 'view-split-vertical' },
  { name: 'Console', icon: 'console', count: selected.value?.console?.length || undefined },
  {
    name: 'Tests',
    icon: 'check-circle-outline',
    count: historyTests.value.length
      ? `${historyTests.value.filter((test) => test.pass).length}/${historyTests.value.length}`
      : undefined,
  },
];
// A failed request: its error card (with a menu to capture it) and the views it kept.
const failureTabs = (): UITab[] => [
  { name: 'Console', icon: 'console', count: selected.value?.console?.length || undefined },
  ...(selected.value?.failure?.timings
    ? [{ name: 'Timeline', icon: 'timer-outline' as const }]
    : []),
  ...(selected.value?.failure?.tls
    ? [{ name: 'Certificate', icon: 'shield-lock-outline' as const }]
    : []),
];
/** The shown tab of a failed entry: the chosen one when the entry has it, else its console. */
const failureTab = computed(() =>
  failureTabs().some((tab) => tab.name === filters.tab) ? filters.tab : 'Console',
);
const {
  menu: errorMenu,
  open: openErrorMenu,
  onKeydown: onErrorKeydown,
} = useContextMenu<{ error: string }>();
const errorMenuItems = computed<MenuItem[]>(() => [
  { id: 'copy', label: 'Copy error', icon: 'content-copy' },
  {
    id: 'capture',
    label: selectedRequest.value
      ? 'Capture into a variable'
      : 'Capture into a variable · the request was deleted',
    icon: 'variable',
    separated: true,
    disabled: !selectedRequest.value,
  },
]);
async function onErrorMenu(command: string): Promise<void> {
  const entry = selected.value;
  const error = entry?.failure?.error;
  if (!entry || error === undefined) return;
  if (command === 'capture') {
    const taken = (selectedRequest.value?.captures ?? []).map((row) => row.key.trim());
    requestTests.addCapture(
      captureVariableName(undefined, taken, 'error'),
      'error',
      'the error',
      entry.requestId,
    );
    return;
  }
  try {
    await navigator.clipboard.writeText(error);
    toast('Error copied', 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
/** The kept response as a response, so tests and captures read it as they would a new one. */
function keptResponse(entry: HistoryEntry): HttpResponse | undefined {
  const response = entry.response;
  if (!response) return undefined;
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
    time: entry.time ?? 0,
    size: response.size,
    url: entry.url,
    ...(response.setCookies ? { setCookies: response.setCookies } : {}),
    ...(response.timings ? { timings: response.timings } : {}),
    ...(response.tls ? { tls: response.tls } : {}),
  };
}
/** The request's tests, run on the selected entry's kept response. */
const historyTests = useRendered(() => {
  const entry = selected.value;
  const response = entry && keptResponse(entry);
  const request = selectedRequest.value;
  return response && request?.tests.trim() ? requestTests.runTests(request, response) : [];
});
// Compare: the selected entry against another kept response of the same request.
const historyCompare = reactive({ baseline: '', sortKeys: false, changesOnly: false });
watch(
  () => filters.selected,
  () => (historyCompare.baseline = ''),
);
/** Other kept responses of the selected entry's request, newest first. */
const compareOptions = useRendered(() => {
  const entry = selected.value;
  if (!entry?.response) return [];
  return workspace.state.history.filter(
    (other) => other !== entry && other.requestId === entry.requestId && other.response,
  );
});
/** The chosen baseline, or the response sent just before the selected one. */
const baselineEntry = computed(() => {
  const options = compareOptions.value;
  const chosen = options.find((entry) => entryKey(entry) === historyCompare.baseline);
  if (chosen) return chosen;
  const index = workspace.state.history.indexOf(selected.value!);
  return options.find((entry) => workspace.state.history.indexOf(entry) > index) ?? options[0];
});
const entryLabel = (entry: HistoryEntry) =>
  `${new Date(entry.date).toLocaleString()} · ${entry.response?.status ?? entry.status ?? 'Failed'}`;
const compared = (entry: HistoryEntry) => ({
  status: entry.response!.status,
  time: entry.time ?? 0,
  size: entry.response!.size,
  body: entry.response!.body,
  headers: entry.response!.headers,
});
// Headers: a table, or raw `name: value` lines whose menu captures the header on a line.
const rawHeaders = useRendered(() =>
  Object.entries(selected.value?.response?.headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n'),
);
function captureFromHeaders(target: { text: string; from: number; to: number }) {
  const request = selectedRequest.value;
  if (!request) return { reason: 'the request was deleted' };
  return headerLineCapture(target, request, true);
}
/** Capture value in the body menu: into the entry's request, which opens on its Vars tab. */
function captureFromBody(target: { text: string; from: number; to: number }) {
  const entry = selected.value;
  const request = selectedRequest.value;
  if (!entry?.response || !request) return { reason: 'the request was deleted' };
  return bodyCapture(target, entry.response.body, request, true);
}
// A header row's menu: copy, or capture the header (or a cookie it sets) into the entry's request.
const headerMenu = ref<InstanceType<typeof ResponseHeaderMenu>>();
function headerTarget(name: string | number, value: string) {
  const header = String(name);
  return header.toLowerCase() === 'set-cookie'
    ? { name: header, value, cookies: [...new Set(historyCookies.value.map((c) => c.name))] }
    : { name: header, value };
}
// A cookie row's menu: copy its value, or capture it into the entry's request.
const {
  menu: cookieMenu,
  target: cookieFor,
  open: openCookieMenu,
  onKeydown: onCookieKeydown,
} = useContextMenu<{ name: string; value: string }>();
const cookieMenuItems = computed<MenuItem[]>(() => [
  { id: 'value', label: 'Copy value', icon: 'content-copy' },
  {
    id: 'capture',
    label: selectedRequest.value
      ? 'Capture into a variable'
      : 'Capture into a variable · the request was deleted',
    icon: 'variable',
    separated: true,
    disabled: !selectedRequest.value,
  },
]);
async function onCookieMenu(command: string): Promise<void> {
  const cookie = cookieFor.value;
  const entry = selected.value;
  if (!cookie || !entry) return;
  if (command === 'capture') {
    requestTests.captureCookie(cookie.name, entry.requestId);
    return;
  }
  try {
    await navigator.clipboard.writeText(cookie.value);
    toast('Cookie value copied', 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
const contentType = () =>
  Object.entries(selected.value?.response?.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1] ?? '';
const bodyLanguage = () =>
  WorkbenchEditor.detectLanguage(contentType(), selected.value?.response?.body ?? '');
/** The body as formatted, for the text it was made from; another entry shows its own body. */
const formatted = shallowRef<{ source: string; text: string }>();
const body = computed(() => {
  const source = selected.value?.response?.body ?? '';
  return formatted.value?.source === source ? formatted.value.text : source;
});
watch(
  () => filters.selected,
  () => (formatted.value = undefined),
);
async function formatBody(): Promise<void> {
  const source = selected.value?.response?.body;
  if (!source) return;
  try {
    const text = await WorkbenchEditor.formatText(source, bodyLanguage());
    if (selected.value?.response?.body !== source) return;
    if (text === body.value) toast('Already formatted', 'info');
    formatted.value = { source, text };
  } catch (error) {
    toast(`Format failed: ${errorMessage(error)}`, 'error');
  }
}
async function copyBody(): Promise<void> {
  try {
    await navigator.clipboard.writeText(body.value);
    toast('Response body copied', 'success');
  } catch {
    toast('The body could not be copied', 'error');
  }
}
const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
const tone = (status: number | undefined): UITone =>
  !status || status >= 400 ? 'danger' : status >= 300 ? 'neutral' : 'success';
// An entry without the chosen view (no Preview for JSON) shows its body instead, also when the
// panel opens with a view chosen for another entry. Last, as it reads everything above.
watch(
  () => [filters.selected, previewable.value],
  () => {
    if (selected.value?.response && !historyTabs().some((tab) => tab.name === filters.tab))
      filters.tab = 'Body';
  },
  { immediate: true },
);
</script>

<template>
  <section class="panel">
    <PageHeader
      eyebrow="WORKSPACE / ACTIVITY"
      guide="history"
      title="Request history"
      :description="
        config.historyEnabled
          ? workspaces.isTeam()
            ? `${ownCount()} of up to ${config.historyLimit} of your entries, and ${workspace.state.history.length - ownCount()} from teammates, in the team folder.`
            : `${workspace.state.history.length} of up to ${config.historyLimit} entries stored on this device.`
          : 'History recording is disabled in Settings → Privacy.'
      "
    >
      <UiButton
        label="Clear history"
        icon="delete-outline"
        data-action="clear-history"
        :disabled="workspace.state.history.length === 0"
        @click="action('clear-history')"
      />
    </PageHeader>
    <template v-if="workspace.state.history.length">
      <div class="history-toolbar">
        <label class="cookie-filter history-search"
          ><MdiIcon name="magnify" /><input
            id="history-search"
            v-model="filters.query"
            type="search"
            placeholder="Search name, URL, method, status, or #tag"
            aria-label="Search history"
            autocomplete="off"
        /></label>
        <ScrollRow
          class="segmented-control"
          role="group"
          aria-label="Filter by status"
          noun="filters"
        >
          <button
            v-for="filter in FILTERS"
            :key="filter"
            type="button"
            :data-history-status="filter"
            :aria-pressed="filters.status === filter"
            :class="{ selected: filters.status === filter }"
            @click="filters.status = filter"
          >
            {{ filter
            }}<span v-if="filter !== 'All'" class="history-count">{{
              counts.get(filter) || 0
            }}</span>
          </button>
        </ScrollRow>
      </div>
      <TagFilterChips
        v-if="historyTagCounts.length"
        class="history-tags"
        :counts="historyTagCounts"
        :filter="filters.tags"
        verb="show"
        :limit="10"
        :noun="['entry', 'entries']"
        data-history-tags
        @change="filters.tags = $event"
      />
      <div :class="['history-layout', { 'has-detail': selected }]">
        <div id="history-list" class="history-list">
          <template v-for="{ entry, index, request, date, group } in entries" :key="index">
            <div v-if="group" class="history-day">{{ group }}</div>
            <button
              type="button"
              :class="['history-entry', { 'is-selected': filters.selected === entryKey(entry) }]"
              :data-history-entry="index"
              :data-deleted="request ? undefined : 'true'"
              :aria-pressed="filters.selected === entryKey(entry)"
              :title="
                request
                  ? `${date.toLocaleString()} · Double-click to open the request`
                  : `${date.toLocaleString()} · The request was deleted`
              "
              @click="select(entry)"
              @dblclick="open(entry)"
              @contextmenu="openMenu($event, index)"
              @keydown="onRowKeydown($event, index)"
            >
              <span :class="['method', entry.method]"
                ><MdiIcon :name="methodIcon(entry.method)" class="method-icon" />{{
                  entry.method
                }}</span
              ><span class="history-copy"
                ><strong>{{ request?.name || 'Deleted request' }}</strong
                ><small
                  ><span v-if="entry.author" class="history-author" data-history-author
                    >{{ entry.author.name }} · </span
                  >{{ entry.url }}</small
                ></span
              ><UiBadge :label="String(entry.status || 'Error')" :tone="tone(entry.status)" /><span
                class="history-time"
                >{{ entry.time !== undefined ? `${Math.round(entry.time)} ms` : '—' }}</span
              ><span class="history-when">{{ relativeTime(date) }}</span
              ><MdiIcon v-if="request" name="chevron-right" /><span v-else></span>
            </button>
          </template>
          <ContextMenu
            ref="contextMenu"
            label="History entry actions"
            :items="menuItems"
            data-history-menu
            @select="onMenuSelect"
          />
          <UiEmptyState
            v-if="!entries.length"
            icon="magnify"
            title="No matching requests"
            :description="
              tagFilterActive(filters.tags)
                ? `Nothing sent is tagged ${describeTagFilter(filters.tags)} with this search and status.`
                : 'Try another search or status filter.'
            "
          />
        </div>
        <aside
          v-if="selected"
          class="overview-card history-detail"
          data-history-detail
          aria-label="Response"
        >
          <div class="history-detail-heading">
            <span :class="['method', selected.method]"
              ><MdiIcon :name="methodIcon(selected.method)" class="method-icon" />{{
                selected.method
              }}</span
            ><code :title="selected.url">{{ selected.url }}</code
            ><UiIconButton
              label="Close response"
              icon="close"
              data-history-close
              @click="filters.selected = ''"
            />
          </div>
          <div class="spec-status">
            <UiBadge
              :label="
                selected.response
                  ? `${selected.response.status} ${selected.response.statusText}`.trim()
                  : String(selected.status || 'Error')
              "
              :tone="tone(selected.status)"
            />
            <span v-if="selected.time !== undefined" class="spec-link"
              ><MdiIcon name="timer-outline" />{{ Math.round(selected.time) }} ms</span
            ><span v-if="selected.response" class="spec-link"
              ><MdiIcon name="file-outline" />{{ size(selected.response.size) }}</span
            ><span class="spec-link"
              ><MdiIcon name="history" />{{ new Date(selected.date).toLocaleString() }}</span
            >
          </div>
          <template v-if="selected.response">
            <UiTabs
              group="history"
              label="Response views"
              :items="historyTabs()"
              :active="filters.tab"
              attribute="data-history-tab"
              class="spec-tabs"
              @select="filters.tab = $event as typeof filters.tab"
            />
            <div id="history-panel" role="tabpanel" class="spec-panel">
              <template v-if="filters.tab === 'Body'">
                <p v-if="selected.response.binary" class="field-help">
                  The body was a file ({{ contentType() || 'binary' }}), so it was not kept.
                </p>
                <template v-else>
                  <div class="history-body-tools">
                    <span class="body-mime">{{ contentType() || 'No Content-Type' }}</span>
                    <UiButton
                      label="Format"
                      icon="code-tags"
                      variant="ghost"
                      data-history-format
                      :disabled="
                        !selected.response.body || !editorRuntime.canFormat(bodyLanguage())
                      "
                      @click="formatBody"
                    /><UiButton
                      label="Copy"
                      icon="content-copy"
                      variant="ghost"
                      data-history-copy
                      :disabled="!selected.response.body"
                      @click="copyBody"
                    />
                  </div>
                  <SourceEditor
                    id="history-response-editor"
                    :key="filters.selected"
                    class="source-editor-host history-body-editor"
                    :value="body"
                    :language="bodyLanguage()"
                    :wrap="workspace.settings().wordWrap"
                    read-only
                    context-menu
                    formattable
                    :capture="captureFromBody"
                    label="Response body (read only)"
                    @format="formatBody"
                  />
                  <p v-if="selected.response.truncated" class="field-help">
                    Only the first 256 KB of the body was kept.
                  </p>
                </template>
              </template>
              <template v-else-if="filters.tab === 'Headers'">
                <div
                  class="segmented-control history-view-switch"
                  role="group"
                  aria-label="Headers view"
                >
                  <button
                    v-for="view in ['Table', 'Raw'] as const"
                    :key="view"
                    :data-history-headers-view="view"
                    :aria-pressed="filters.headersView === view"
                    :class="{ selected: filters.headersView === view }"
                    @click="filters.headersView = view"
                  >
                    {{ view }}
                  </button>
                </div>
                <SourceEditor
                  v-if="filters.headersView === 'Raw'"
                  id="history-headers-editor"
                  :key="`${filters.selected}:headers`"
                  class="source-editor-host history-body-editor"
                  :value="rawHeaders"
                  language="text"
                  :wrap="workspace.settings().wordWrap"
                  read-only
                  context-menu
                  :capture="captureFromHeaders"
                  label="Response headers (read only)"
                />
                <table v-else class="response-headers-table history-headers">
                  <thead>
                    <tr>
                      <th scope="col">Header</th>
                      <th scope="col">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(value, name) in selected.response.headers"
                      :key="name"
                      tabindex="0"
                      :data-history-header="name"
                      @contextmenu="headerMenu?.open($event, headerTarget(name, value))"
                      @keydown="headerMenu?.onKeydown($event, headerTarget(name, value))"
                    >
                      <th scope="row">{{ name }}</th>
                      <td>{{ value }}</td>
                    </tr>
                  </tbody>
                </table>
                <ResponseHeaderMenu
                  ref="headerMenu"
                  capture
                  :request-id="selected.requestId"
                  :capture-unavailable="selectedRequest ? undefined : 'the request was deleted'"
                />
              </template>
              <template v-else-if="filters.tab === 'Preview' && previewable">
                <p v-if="selected.response.truncated" class="field-help">
                  History kept the first 256 KB of this body, so the preview may stop short.
                </p>
                <ResponsePreview
                  :response="keptResponse(selected)!"
                  capture
                  :request-id="selected.requestId"
                  :capture-unavailable="selectedRequest ? undefined : 'the request was deleted'"
                />
              </template>
              <template v-else-if="filters.tab === 'Console'">
                <HistoryConsole
                  :lines="selected.console ?? []"
                  :request-id="selected.requestId"
                  :cookie-names="[...new Set(historyCookies.map((cookie) => cookie.name))]"
                  :capture-unavailable="selectedRequest ? undefined : 'the request was deleted'"
                />
              </template>
              <template v-else-if="filters.tab === 'Tests'">
                <p v-if="!selectedRequest" class="field-help">
                  The request was deleted, so there are no tests to run on this response.
                </p>
                <p v-else-if="!historyTests.length" class="field-help">
                  The request has no tests. Add assertions in its Tests tab.
                </p>
                <template v-else>
                  <p class="field-help">
                    The request's current tests, run on this kept response{{
                      selected.response.truncated ? ' (its body was cut short at 256 KB)' : ''
                    }}.
                  </p>
                  <TestResults :results="historyTests" capture :request-id="selected.requestId" />
                </template>
              </template>
              <template v-else-if="filters.tab === 'Compare'">
                <p v-if="!compareOptions.length" class="field-help">
                  History has no other response of this request to compare with. Send it again, then
                  compare the two here.
                </p>
                <div v-else-if="baselineEntry?.response" class="compare-view">
                  <div class="compare-toolbar">
                    <label class="compare-baseline"
                      ><span>Compare with</span
                      ><UiSelect
                        id="history-compare-baseline"
                        class="field-input"
                        :value="entryKey(baselineEntry)"
                        @change="
                          historyCompare.baseline = ($event.target as HTMLSelectElement).value
                        "
                        :options="
                          withIcons(
                            compareOptions.map((entry) => ({
                              value: entryKey(entry),
                              label: entryLabel(entry),
                            })),
                            'history',
                          )
                        "
                    /></label>
                    <label class="auth-check"
                      ><input v-model="historyCompare.sortKeys" type="checkbox" /><span
                        >Sort JSON keys</span
                      ></label
                    >
                    <label class="auth-check"
                      ><input v-model="historyCompare.changesOnly" type="checkbox" /><span
                        >Changes only</span
                      ></label
                    >
                  </div>
                  <p
                    v-if="selected.response.truncated || baselineEntry.response.truncated"
                    class="field-help"
                  >
                    History keeps the first 256 KB of a body, so long bodies compare only that far.
                  </p>
                  <ResponseDiff
                    :baseline="compared(baselineEntry)"
                    :current="compared(selected)"
                    :baseline-label="entryLabel(baselineEntry)"
                    :current-label="entryLabel(selected)"
                    :sort-keys="historyCompare.sortKeys"
                    :changes-only="historyCompare.changesOnly"
                    capture
                    :request-id="selected.requestId"
                    :capture-unavailable="selectedRequest ? undefined : 'the request was deleted'"
                  />
                </div>
              </template>
              <template v-else-if="filters.tab === 'Certificate'">
                <CertificateDetails
                  v-if="selected.response.tls"
                  :tls="selected.response.tls"
                  capture
                  :request-id="selected.requestId"
                  :capture-unavailable="selectedRequest ? undefined : 'the request was deleted'"
                />
                <p v-else class="field-help">
                  No certificate was kept for this entry: the request was not HTTPS, or was sent
                  before History kept certificates.
                </p>
              </template>
              <template v-else-if="filters.tab === 'Timeline'">
                <NetworkTimingChart
                  v-if="selected.response.timings"
                  :timing="selected.response.timings"
                  capture
                  :request-id="selected.requestId"
                  :capture-unavailable="selectedRequest ? undefined : 'the request was deleted'"
                />
                <p v-else class="field-help">
                  Network timing was not kept for this entry. Responses sent from now on keep it.
                </p>
              </template>
              <template v-else>
                <p v-if="!historyCookies.length" class="field-help">
                  This response did not set any cookies.
                </p>
                <table v-else class="response-headers-table cookie-response-table">
                  <thead>
                    <tr>
                      <th scope="col">Cookie</th>
                      <th scope="col">Value</th>
                      <th scope="col">Domain / path</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(cookie, index) in historyCookies"
                      :key="index"
                      tabindex="0"
                      :data-history-cookie="index"
                      @contextmenu="openCookieMenu($event, cookie)"
                      @keydown="onCookieKeydown($event, cookie)"
                    >
                      <th scope="row">{{ cookie.name }}</th>
                      <td>{{ cookie.value }}</td>
                      <td>
                        <code v-if="cookie.scope">{{ cookie.scope }}</code>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <ContextMenu
                  ref="cookieMenu"
                  label="History cookie actions"
                  :items="cookieMenuItems"
                  data-history-cookie-menu
                  @select="onCookieMenu"
                />
              </template>
            </div>
          </template>
          <template v-else-if="selected.failure || selected.console?.length">
            <div
              class="history-failure"
              role="alert"
              :tabindex="selected.failure ? 0 : undefined"
              data-history-error
              @contextmenu="selected.failure && openErrorMenu($event, selected.failure)"
              @keydown="selected.failure && onErrorKeydown($event, selected.failure)"
            >
              <MdiIcon name="alert-circle-outline" />
              <div>
                <strong>The request failed</strong>
                <span>{{ selected.failure?.error ?? 'The error was not kept.' }}</span>
              </div>
            </div>
            <ContextMenu
              ref="errorMenu"
              label="Error actions"
              :items="errorMenuItems"
              data-history-error-menu
              @select="onErrorMenu"
            />
            <UiTabs
              group="history-failure"
              label="Failure views"
              :items="failureTabs()"
              :active="failureTab"
              attribute="data-history-tab"
              class="spec-tabs"
              @select="filters.tab = $event as typeof filters.tab"
            />
            <div role="tabpanel" class="spec-panel">
              <NetworkTimingChart
                v-if="failureTab === 'Timeline' && selected.failure?.timings"
                :timing="selected.failure.timings"
                capture
                :request-id="selected.requestId"
                :capture-unavailable="selectedRequest ? undefined : 'the request was deleted'"
              />
              <CertificateDetails
                v-else-if="failureTab === 'Certificate' && selected.failure?.tls"
                :tls="selected.failure.tls"
                capture
                :request-id="selected.requestId"
                :capture-unavailable="selectedRequest ? undefined : 'the request was deleted'"
              />
              <HistoryConsole
                v-else
                :lines="selected.console ?? []"
                :request-id="selected.requestId"
                :has-timing="Boolean(selected.failure?.timings)"
                :capture-unavailable="selectedRequest ? undefined : 'the request was deleted'"
              />
            </div>
          </template>
          <UiEmptyState
            v-else
            icon="history"
            title="Response not kept"
            :description="
              selected.status
                ? 'Responses are kept for requests sent from the editor, not Runner runs or entries from before this version.'
                : 'The request failed, so there was no response.'
            "
          />
          <div class="history-detail-actions">
            <UiButton
              label="Open request"
              icon="arrow-top-right"
              data-history-open
              :disabled="!selectedRequest"
              :title="selectedRequest ? undefined : 'The request was deleted'"
              @click="open(selected)"
            />
          </div>
        </aside>
      </div>
    </template>
    <div v-else class="credential-table-wrap">
      <UiEmptyState
        icon="history"
        title="No requests in your history"
        description="Send a request and its method, URL, status, and timestamp will appear here."
      >
        <UiButton label="Create a request" icon="plus" variant="primary" @click="action('new')" />
      </UiEmptyState>
    </div>
  </section>
</template>
