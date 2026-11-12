<script setup lang="ts">
import { methodIcon } from '../../stores/protocols';
import { withIcons } from '../../select-options';
import { computed, onMounted, ref } from 'vue';
import type { InterceptorCapture } from '@techieutils/api-workbench-common/types';
import {
  domainList,
  bodyText,
  FILTERS,
  FOLDER,
  useInterceptorStore,
} from '../../stores/interceptor';
import { toast } from '../../utils';
import MdiIcon from '../MdiIcon.vue';
import PaneResizer from '../PaneResizer.vue';
import PageHeader from '../ui/PageHeader.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiExpansionPanel from '../ui/UiExpansionPanel.vue';
import UiSelect from '../ui/UiSelect.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import { useContextMenu } from '../../composables/context-menu';

/** The Interceptor screen: run the capture proxy, set up apps to use it, and inspect what it saw. */
const interceptor = useInterceptorStore();
const status = computed(() => interceptor.status);
const running = computed(() => Boolean(status.value?.running));
const port = computed(() => (running.value ? status.value!.port : interceptor.settings.port));
/** Decrypting needs the domains to decrypt; the main process refuses to start without them. */
const needsDomains = computed(
  () => interceptor.settings.decryptHttps && !domainList(interceptor.settings.domains).length,
);
const address = computed(() => `127.0.0.1:${port.value}`);
/** Trusting the CA from here is supported where the OS has one trust store for the user. */
const canTrust = /Mac|Win/.test(navigator.platform);
const caPath = computed(() => status.value?.authority?.path || '<Interceptor CA path>');
const snippets = computed(() => [
  {
    label: 'cURL',
    text: `curl -x http://${address.value} --cacert "${caPath.value}" https://api.example.com`,
  },
  {
    label: 'Node.js',
    text: `HTTP_PROXY=http://${address.value} HTTPS_PROXY=http://${address.value} NODE_EXTRA_CA_CERTS="${caPath.value}" node app.js`,
  },
  { label: 'Chrome', text: `--proxy-server=${address.value}` },
]);
// Host and method filters list what has been captured, busiest first, with counts.
const captureCount = (count: number) => `${count} capture${count === 1 ? '' : 's'}`;
const hostOptions = computed(() => [
  { value: '', label: 'All hosts', description: captureCount(interceptor.captures.length) },
  ...interceptor.hosts.map(([host, count]) => ({
    value: host,
    label: host,
    description: captureCount(count),
  })),
]);
const methodOptions = computed(() => [
  { value: '', label: 'All methods', description: captureCount(interceptor.captures.length) },
  ...interceptor.methods.map(([method, count]) => ({
    value: method,
    label: method,
    description: captureCount(count),
    attrs: { 'data-method': method },
  })),
]);
const detailTab = ref<'Request' | 'Response'>('Response');
const detailWidth = ref(480);
const split = ref<HTMLElement>();
const measureDetail = ({ x }: { x: number }) =>
  (split.value?.getBoundingClientRect().right ?? x) - x;

onMounted(() => void interceptor.refresh());

const tone = (capture: InterceptorCapture): UITone =>
  capture.error
    ? 'danger'
    : !capture.status
      ? 'neutral'
      : capture.status >= 400
        ? 'danger'
        : capture.status >= 300
          ? 'neutral'
          : 'success';
const statusLabel = (capture: InterceptorCapture) =>
  capture.error
    ? 'Error'
    : capture.scheme === 'tunnel'
      ? capture.done
        ? 'Closed'
        : 'Open'
      : capture.status
        ? String(capture.status)
        : 'Pending';
function location(capture: InterceptorCapture): { host: string; path: string } {
  try {
    const url = new URL(capture.url);
    return {
      host: url.host,
      path: capture.scheme === 'tunnel' ? 'Tunnel' : `${url.pathname}${url.search}`,
    };
  } catch {
    return { host: capture.url, path: '' };
  }
}
function size(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const duration = (capture: InterceptorCapture) =>
  capture.durationMs === undefined ? '…' : `${Math.round(capture.durationMs)} ms`;
/** JSON is shown indented; anything else as captured. */
function pretty(body: string | undefined, encoding: string | undefined): string {
  const text = bodyText(body, encoding);
  if (encoding !== 'utf8' || !/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
// A capture's context menu: its details, saving it as a request, copying its URL, and narrowing
// the list to its host or method.
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<InterceptorCapture>();
const menuItems = computed<MenuItem[]>(() => {
  const capture = menuFor.value;
  const host = capture ? location(capture).host : '';
  return [
    { id: 'details', label: 'Show details', icon: 'information-outline' },
    {
      id: 'save',
      label: 'Save to collection',
      icon: 'content-save-outline',
      disabled: capture?.scheme === 'tunnel',
    },
    { id: 'copy', label: 'Copy URL', icon: 'content-copy', separated: true },
    {
      id: 'host',
      label: `Show only ${host}`,
      icon: 'filter-variant',
      separated: true,
      disabled: interceptor.view.host === host,
    },
    {
      id: 'method',
      label: `Show only ${capture?.method ?? ''} requests`,
      icon: 'filter-variant',
      disabled: interceptor.view.method === capture?.method,
    },
  ];
});
function onMenuSelect(command: string): void {
  const capture = menuFor.value;
  if (!capture) return;
  if (command === 'details') interceptor.selectedId = capture.id;
  else if (command === 'save') void interceptor.saveToCollection([capture]);
  else if (command === 'copy') void copy(capture.url, 'URL');
  else if (command === 'host') interceptor.view.host = location(capture).host;
  else if (command === 'method') interceptor.view.method = capture.method;
}
async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, 'success');
  } catch {
    toast(`Could not copy the ${what.toLowerCase()}`, 'error');
  }
}
function setPort(event: Event): void {
  interceptor.settings.port = Number((event.target as HTMLInputElement).value);
}
</script>

<template>
  <section class="panel interceptor-panel">
    <PageHeader
      eyebrow="WORKSPACE / TRAFFIC"
      guide="interceptor"
      title="Interceptor"
      description="Capture traffic from browsers and other apps through a local proxy, then inspect it or save it as requests."
    >
      <UiButton
        label="Clear"
        icon="delete-outline"
        data-interceptor-clear
        :disabled="!interceptor.captures.length"
        @click="interceptor.clear()"
      />
      <UiButton
        v-if="running"
        label="Stop"
        icon="stop-circle-outline"
        variant="primary"
        data-interceptor-stop
        :disabled="interceptor.busy"
        @click="interceptor.stop()"
      />
      <UiButton
        v-else
        :label="interceptor.busy ? 'Starting…' : 'Start'"
        icon="play-circle-outline"
        variant="primary"
        data-interceptor-start
        :disabled="interceptor.busy || !interceptor.available || needsDomains"
        :title="needsDomains ? 'List the domains to decrypt, or turn off Decrypt HTTPS' : ''"
        @click="interceptor.start()"
      />
    </PageHeader>
    <p v-if="!interceptor.available" class="info-callout">
      The Interceptor requires the desktop application.
    </p>
    <div class="overview-card interceptor-setup">
      <div class="interceptor-controls">
        <span :class="['interceptor-state', { running }]" data-interceptor-state role="status">
          <MdiIcon name="circle" />{{
            running
              ? `Listening on ${address}${status?.recording ? '' : ' · recording paused'}`
              : 'Stopped'
          }}
        </span>
        <label class="interceptor-port"
          >Port<input
            class="field-input"
            type="number"
            min="1024"
            max="65535"
            data-interceptor-port
            :value="port"
            :disabled="running"
            @change="setPort"
        /></label>
        <label class="toggle-row" :title="running ? 'Stop the Interceptor to change this' : ''"
          ><label class="toggle"
            ><input
              v-model="interceptor.settings.decryptHttps"
              type="checkbox"
              role="switch"
              data-interceptor-decrypt
              :disabled="running" /><span></span></label
          ><span
            ><strong>Decrypt HTTPS</strong
            ><small>{{
              interceptor.settings.decryptHttps
                ? 'Apps must trust the Interceptor certificate'
                : 'HTTPS passes through as unread tunnels'
            }}</small></span
          ></label
        >
        <label
          v-if="interceptor.settings.decryptHttps"
          class="interceptor-domains"
          :title="running ? 'Stop the Interceptor to change this' : ''"
          >Domains to decrypt<input
            v-model="interceptor.settings.domains"
            class="field-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            maxlength="2000"
            placeholder="example.com, api.test"
            required
            aria-required="true"
            :aria-invalid="needsDomains"
            aria-describedby="interceptor-domains-help"
            data-interceptor-domains
            :disabled="running"
          /><small id="interceptor-domains-help" :class="{ 'field-error': needsDomains }">{{
            needsDomains
              ? 'Required to decrypt HTTPS: list the domains you test, or turn off Decrypt HTTPS.'
              : 'The certificate vouches only for these domains, their subdomains, and this computer; other HTTPS passes through unread.'
          }}</small></label
        >
        <label v-if="running" class="toggle-row"
          ><label class="toggle"
            ><input
              type="checkbox"
              role="switch"
              data-interceptor-recording
              :checked="status?.recording"
              @change="
                interceptor.setRecording(($event.target as HTMLInputElement).checked)
              " /><span></span></label
          ><span
            ><strong>Record</strong><small>Forward without recording when off</small></span
          ></label
        >
      </div>
      <p v-if="interceptor.error" class="info-callout error-callout" role="alert">
        <MdiIcon name="close-circle-outline" /><span>{{ interceptor.error }}</span>
      </p>
      <div v-if="interceptor.settings.decryptHttps" class="interceptor-certificate">
        <MdiIcon name="certificate-outline" />
        <div v-if="status?.authority" class="interceptor-certificate-copy">
          <strong>{{ status.authority.subject }}</strong
          ><small
            >Valid until {{ new Date(status.authority.validTo).toLocaleDateString() }} · SHA-256
            {{ status.authority.fingerprint.slice(0, 23) }}…</small
          ><small data-interceptor-scope>{{
            status.authority.domains?.length
              ? `Only for ${status.authority.domains.join(', ')} and this computer`
              : 'For any site, from an earlier version: replaced with a limited one when you start'
          }}</small>
        </div>
        <div v-else-if="status?.authorityError" class="interceptor-certificate-copy">
          <strong>HTTPS cannot be decrypted</strong><small>{{ status.authorityError }}</small>
        </div>
        <div v-else class="interceptor-certificate-copy">
          <strong>Interceptor certificate</strong
          ><small>Created the first time you start with HTTPS decryption on.</small>
        </div>
        <div class="interceptor-certificate-actions">
          <UiButton
            v-if="canTrust"
            label="Trust certificate"
            icon="shield-lock-outline"
            data-interceptor-trust
            :disabled="!status?.authority || interceptor.busy"
            @click="interceptor.trustAuthority()"
          />
          <UiButton
            label="Save certificate…"
            icon="tray-arrow-down"
            variant="ghost"
            data-interceptor-export-ca
            :disabled="!status?.authority"
            @click="interceptor.exportAuthority()"
          />
          <UiButton
            label="New certificate"
            icon="refresh"
            variant="ghost"
            data-interceptor-reset-ca
            :disabled="!status?.authority || interceptor.busy"
            @click="interceptor.resetAuthority()"
          />
        </div>
      </div>
      <UiExpansionPanel
        class="interceptor-help"
        title="Connect an app"
        description="Proxy address, trusting the certificate, and command-line examples"
        icon="lan-connect"
      >
        <p>
          Set <code>{{ address }}</code> as the HTTP and HTTPS proxy in the app, browser, or system
          network settings. To decrypt HTTPS, the app must also trust the Interceptor certificate:
          use <strong>Trust certificate</strong>, or save it and add it to the app's trust store
          (Firefox and many command-line tools keep their own). Only this device can connect.
        </p>
        <div v-for="snippet in snippets" :key="snippet.label" class="interceptor-snippet">
          <span>{{ snippet.label }}</span
          ><code>{{ snippet.text }}</code
          ><button
            type="button"
            class="icon-button"
            :aria-label="`Copy ${snippet.label} example`"
            @click="copy(snippet.text, `${snippet.label} example`)"
          >
            <MdiIcon name="content-copy" />
          </button>
        </div>
      </UiExpansionPanel>
    </div>
    <div class="history-toolbar interceptor-toolbar">
      <div class="interceptor-filters">
        <label class="cookie-filter history-search"
          ><MdiIcon name="magnify" /><input
            v-model="interceptor.view.query"
            type="search"
            data-interceptor-search
            placeholder="Search method, URL, or status"
            aria-label="Search captured traffic"
            autocomplete="off"
        /></label>
        <UiSelect
          v-model="interceptor.view.host"
          class="field-input interceptor-filter"
          aria-label="Filter by host"
          data-interceptor-host
          :options="withIcons(hostOptions, 'web')"
        />
        <UiSelect
          v-model="interceptor.view.method"
          class="field-input interceptor-filter"
          aria-label="Filter by method"
          data-interceptor-method
          :options="withIcons(methodOptions, 'swap-horizontal')"
        />
      </div>
      <ScrollRow
        class="segmented-control"
        role="group"
        aria-label="Filter captured traffic"
        noun="filters"
      >
        <button
          v-for="filter in FILTERS"
          :key="filter"
          type="button"
          :data-interceptor-filter="filter"
          :aria-pressed="interceptor.view.filter === filter"
          :class="{ selected: interceptor.view.filter === filter }"
          @click="interceptor.view.filter = filter"
        >
          {{ filter
          }}<span v-if="filter !== 'All'" class="history-count">{{
            interceptor.counts.get(filter) || 0
          }}</span>
        </button>
      </ScrollRow>
      <div class="flex gap-2">
        <UiButton
          label="Export HAR"
          icon="export"
          variant="ghost"
          data-interceptor-har
          :disabled="!interceptor.shown.length"
          @click="interceptor.exportHAR()"
        />
        <UiButton
          :label="`Save ${interceptor.shown.length} to ${FOLDER}`"
          icon="content-save-outline"
          variant="ghost"
          data-interceptor-save-all
          :disabled="!interceptor.shown.length"
          @click="interceptor.saveToCollection(interceptor.shown)"
        />
      </div>
    </div>
    <div
      ref="split"
      class="interceptor-split"
      :style="{ '--interceptor-detail': `${interceptor.selected ? detailWidth : 0}px` }"
    >
      <div
        class="interceptor-list"
        role="listbox"
        aria-label="Captured traffic"
        data-interceptor-list
      >
        <div class="interceptor-row interceptor-head" aria-hidden="true">
          <span>Method</span><span>Host</span><span>Path</span><span>Status</span><span>Size</span
          ><span>Time</span>
        </div>
        <button
          v-for="capture in interceptor.shown"
          :key="capture.id"
          type="button"
          role="option"
          :aria-selected="interceptor.selectedId === capture.id"
          :class="['interceptor-row', { selected: interceptor.selectedId === capture.id }]"
          :data-capture="capture.id"
          @click="interceptor.selectedId = capture.id"
          @contextmenu="openMenu($event, capture)"
          @keydown="onRowKeydown($event, capture)"
        >
          <span :class="['method', capture.method]"
            ><MdiIcon :name="methodIcon(capture.method)" class="method-icon" />{{
              capture.method
            }}</span
          ><span class="interceptor-host"
            ><span
              v-if="capture.scheme !== 'http'"
              :title="
                capture.scheme === 'tunnel' ? 'HTTPS tunnel, not decrypted' : 'Decrypted HTTPS'
              "
              ><MdiIcon
                :name="capture.scheme === 'tunnel' ? 'tunnel-outline' : 'lock-outline'" /></span
            >{{ location(capture).host }}</span
          ><span class="interceptor-path" :title="capture.url">{{ location(capture).path }}</span
          ><span><UiBadge :label="statusLabel(capture)" :tone="tone(capture)" /></span
          ><span class="interceptor-number">{{
            size(capture.scheme === 'tunnel' ? capture.bytesReceived : capture.responseBodySize)
          }}</span
          ><span class="interceptor-number">{{ duration(capture) }}</span>
        </button>
        <UiEmptyState
          v-if="!interceptor.captures.length"
          icon="radar"
          :title="running ? 'Waiting for traffic' : 'The Interceptor is stopped'"
          :description="
            running
              ? `Point an app's HTTP and HTTPS proxy at ${address}. Requests appear here as they happen.`
              : 'Start it, then point an app\'s proxy at it to see its requests and responses.'
          "
        />
        <UiEmptyState
          v-else-if="!interceptor.shown.length"
          icon="magnify"
          title="No matching traffic"
          description="Try another search or filter."
        />
      </div>
      <template v-if="interceptor.selected">
        <PaneResizer
          direction="columns"
          label="Resize capture details"
          :value="detailWidth"
          :min="320"
          :max="900"
          :reset="480"
          :step="20"
          reversed
          :measure="measureDetail"
          @change="detailWidth = $event"
        />
        <aside class="interceptor-detail" aria-label="Capture details" data-interceptor-detail>
          <header>
            <span :class="['method', interceptor.selected.method]"
              ><MdiIcon :name="methodIcon(interceptor.selected.method)" class="method-icon" />{{
                interceptor.selected.method
              }}</span
            ><span class="interceptor-detail-url" :title="interceptor.selected.url">{{
              interceptor.selected.url
            }}</span
            ><button
              type="button"
              class="icon-button"
              aria-label="Close details"
              @click="interceptor.selectedId = undefined"
            >
              <MdiIcon name="close" />
            </button>
          </header>
          <div class="interceptor-detail-meta">
            <UiBadge
              :label="statusLabel(interceptor.selected)"
              :tone="tone(interceptor.selected)"
            />
            <span>{{ duration(interceptor.selected) }}</span>
            <span>{{ new Date(interceptor.selected.startedAt).toLocaleTimeString() }}</span>
            <span v-if="interceptor.selected.truncated">Bodies over 1 MB are partly kept</span>
          </div>
          <p v-if="interceptor.selected.error" class="info-callout error-callout" role="alert">
            <MdiIcon name="close-circle-outline" /><span>{{ interceptor.selected.error }}</span>
          </p>
          <p v-if="interceptor.selected.scheme === 'tunnel'" class="info-callout">
            <MdiIcon name="tunnel-outline" /><span
              >HTTPS passed through without decryption:
              {{ size(interceptor.selected.bytesSent) }} sent,
              {{ size(interceptor.selected.bytesReceived) }} received. Turn on HTTPS decryption to
              see its requests.</span
            >
          </p>
          <template v-else-if="interceptor.selected.method !== 'CONNECT'">
            <div class="interceptor-detail-actions">
              <ScrollRow
                class="segmented-control"
                role="tablist"
                aria-label="Capture part"
                noun="parts"
              >
                <button
                  v-for="tab in ['Request', 'Response'] as const"
                  :key="tab"
                  type="button"
                  role="tab"
                  :data-interceptor-tab="tab"
                  :aria-selected="detailTab === tab"
                  :class="{ selected: detailTab === tab }"
                  @click="detailTab = tab"
                >
                  {{ tab }}
                </button>
              </ScrollRow>
              <UiButton
                label="Save as request"
                icon="content-save-outline"
                data-interceptor-save
                @click="interceptor.saveToCollection([interceptor.selected])"
              />
            </div>
            <template v-if="detailTab === 'Request'">
              <h3>Headers</h3>
              <dl class="interceptor-headers">
                <template
                  v-for="([key, value], index) in interceptor.selected.requestHeaders"
                  :key="index"
                  ><dt>{{ key }}</dt>
                  <dd>{{ value }}</dd></template
                >
              </dl>
              <h3>Body · {{ size(interceptor.selected.requestBodySize) }}</h3>
              <pre v-if="interceptor.selected.requestBody" class="interceptor-body">{{
                pretty(interceptor.selected.requestBody, interceptor.selected.requestBodyEncoding)
              }}</pre>
              <p v-else class="notice">No body</p>
            </template>
            <template v-else>
              <h3>Headers</h3>
              <dl v-if="interceptor.selected.responseHeaders" class="interceptor-headers">
                <template
                  v-for="([key, value], index) in interceptor.selected.responseHeaders"
                  :key="index"
                  ><dt>{{ key }}</dt>
                  <dd>{{ value }}</dd></template
                >
              </dl>
              <p v-else class="notice">
                {{ interceptor.selected.done ? 'No response' : 'Waiting for the response…' }}
              </p>
              <h3>Body · {{ size(interceptor.selected.responseBodySize) }}</h3>
              <pre
                v-if="interceptor.selected.responseBody"
                class="interceptor-body"
                data-interceptor-response-body
                >{{
                  pretty(
                    interceptor.selected.responseBody,
                    interceptor.selected.responseBodyEncoding,
                  )
                }}</pre>
              <p v-else class="notice">No body</p>
            </template>
          </template>
        </aside>
      </template>
    </div>
    <ContextMenu
      ref="contextMenu"
      label="Capture actions"
      :items="menuItems"
      data-capture-menu
      @select="onMenuSelect"
    />
  </section>
</template>
