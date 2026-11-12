<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { parseSetCookie } from '@techieutils/api-workbench-common/cookies';
import { useRendered } from '../../composables/rendered';
import { render } from '../../shell';
import { action } from '../../actions';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSourceEditorsStore } from '../../stores/source-editors';
import { useCookiesStore } from '../../stores/cookies';
import { useRequestTestsStore } from '../../stores/request-tests';
import { useScriptsStore } from '../../stores/scripts';
import { isByteView, useResponseStore } from '../../stores/response';
import { useUiStore } from '../../stores/ui';
import MdiIcon from '../MdiIcon.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import UiTabs from '../ui/UiTabs.vue';
import ResponseCertificate from './ResponseCertificate.vue';
import ResponseCompare from './ResponseCompare.vue';
import ResponseFrame from './ResponseFrame.vue';
import ResponseSource from './ResponseSource.vue';
import TestResults from './TestResults.vue';
import ResponsePreview from './ResponsePreview.vue';
import { bodyKind } from '@techieutils/api-workbench-common/response-body';
import type { HttpResponse } from '@techieutils/api-workbench-common/types';
import { responseCookies } from '@techieutils/api-workbench-common/variables';
import ResponseTimeline from './ResponseTimeline.vue';
import ResponseHeaderMenu from './ResponseHeaderMenu.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import { useContextMenu } from '../../composables/context-menu';
import { toast } from '../../utils';
import { vaultIssue } from '@techieutils/api-workbench-common/vault-messages';
import VaultUnlockNotice from '../VaultUnlockNotice.vue';
import UiSelect, { type SelectOption } from '../ui/UiSelect.vue';
import { languageOption } from '../../language-options';

/** The HTTP response: status and timing, and inspector tabs for body, headers, tests, and more. */
const store = useResponseStore();
const ui = useUiStore();
const requestTests = useRequestTestsStore();
const scripts = useScriptsStore();
const cookieStore = useCookiesStore();
const editors = useSourceEditorsStore();
const workspace = useWorkspaceStore();
/** Sends the request again, once a locked vault has been unlocked. */
const resend = () => action('send');
/** CodeMirror languages and formatting, from the editor runtime. */
const editorRuntime = WorkbenchEditor;
// The request and its response are replaced or mutated in place, so read them on every render.
const request = () => workspace.current();
const response = () => request().response;
const https = () => store.hasHTTPS(request());
/** The Certificate tab only exists for HTTPS; a stale choice falls back to Body. */
const tab = () => (store.tab === 'Certificate' && !https() ? 'Body' : store.tab);
watchEffect(() => {
  if (store.tab === 'Certificate' && !https()) store.tab = 'Body';
});
// Sending state, test results, and snapshots change with render().
const pending = computed(() => ui.busy && ui.activeRequestId === request().id);
const tests = useRendered(() => {
  const current = response();
  // Assertions first, then what the request's scripts tested on this response.
  const assertions =
    current && current.error === undefined ? requestTests.runTests(request(), current) : [];
  return [...assertions, ...scripts.assertionsFor(request(), current)];
});
const captures = useRendered(() => [...(requestTests.captureResults.get(request().id) || [])]);
const snapshots = useRendered(() => store.snapshots.get(request().id)?.length || 0);

/** Views of the body that are not syntax languages, listed before the languages. */
const bodyViews: SelectOption[] = [
  {
    value: 'raw',
    label: 'Raw',
    description: 'Plain text, no highlighting',
    icon: 'text-long',
    group: 'Views',
  },
  {
    value: 'hex',
    label: 'Hex',
    description: 'The bytes as a hex dump',
    icon: 'hexadecimal',
    group: 'Views',
  },
  {
    value: 'base64',
    label: 'Base64',
    description: 'The bytes encoded as Base64',
    icon: 'alphabetical-variant',
    group: 'Views',
  },
];
/** The body language select; Auto detect names what it chose. Raw stands in for plain text. */
const languageOptions = (): SelectOption[] => {
  const languages = editorRuntime.languages
    .filter((language) => language.id !== 'text')
    .map((language) => ({ ...languageOption(language), group: 'Languages' }));
  const detected =
    store.language === 'auto'
      ? [...bodyViews, ...languages].find((option) => option.value === sourceLanguage())
      : undefined;
  return [
    {
      value: 'auto',
      label: detected ? `Auto detect · ${detected.label}` : 'Auto detect',
      icon: 'auto-fix',
    },
    ...bodyViews,
    ...languages,
  ];
};
const hasBody = () => Boolean(response() && response()!.error === undefined);
const hasTimeline = () => Boolean(response()?.timings && tab() === 'Timeline');
const hasCertificate = () => Boolean(response() && https() && tab() === 'Certificate');
const canInspect = () => hasBody() || hasTimeline() || hasCertificate();

const tabs = computed((): UITab[] => {
  const current = response();
  const items: UITab[] = [
    { name: 'Body', icon: store.tabIcon('Body') },
    {
      name: 'Headers',
      icon: store.tabIcon('Headers'),
      count: current?.headers ? Object.keys(current.headers).length : 0,
    },
    {
      name: 'Tests',
      icon: store.tabIcon('Tests'),
      count: tests.value.length
        ? `${tests.value.filter((test) => test.pass).length}/${tests.value.length}`
        : undefined,
    },
    {
      name: 'Cookies',
      icon: store.tabIcon('Cookies'),
      count: current?.setCookies?.length || undefined,
    },
    { name: 'Timeline', icon: store.tabIcon('Timeline') },
    {
      name: 'Compare',
      icon: store.tabIcon('Compare'),
      count: snapshots.value > 1 ? snapshots.value : undefined,
    },
  ];
  if (https()) items.push({ name: 'Certificate', icon: store.tabIcon('Certificate') });
  return items;
});
/** Which panel the inspector shows, in the same precedence as the tabs allow. */
const content = (): string => {
  const current = response();
  if (pending.value) return 'pending';
  if (!current) return 'empty';
  if (hasCertificate()) return store.mode === 'Raw' ? 'source' : 'certificate';
  if (current.error !== undefined && hasTimeline())
    return store.mode === 'Raw' ? 'source' : 'timeline';
  if (tab() === 'Compare' && current.error === undefined && store.mode !== 'Raw') return 'compare';
  if (current.error !== undefined) return 'error';
  if (tab() === 'Body' && store.mode === 'Pretty' && previewing()) return 'preview';
  if (tab() === 'Body' || store.mode === 'Raw') return 'source';
  return tab().toLowerCase();
};
/** What the body is: images, PDFs, media, fonts, HTML, Markdown, and binary data have Pretty previews. */
const kind = () => {
  const current = response();
  if (!current || current.error !== undefined) return 'text';
  return bodyKind(current.headers['content-type'], headBytes(current.bodyBase64));
};
/** HTML and Markdown can show rendered or as source; htmlView holds that choice for both. */
const rendersDocument = () => kind() === 'html' || kind() === 'markdown';
const previewing = () =>
  !['text', 'stream'].includes(kind()) && !(rendersDocument() && store.htmlView === 'source');
const showsSource = () =>
  canInspect() && !pending.value && (tab() === 'Body' || store.mode === 'Raw');
const sourceLanguage = () => editors.responseLanguage(request());

function selectTab(name: string): void {
  store.tab = name;
  render();
}
function setHtmlView(view: 'rendered' | 'source'): void {
  store.htmlView = view;
  render();
}
/** The first bytes of a base64 body, enough to recognise its format. */
function headBytes(base64: string | undefined): Uint8Array | undefined {
  if (!base64) return undefined;
  const text = atob(base64.slice(0, 24));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}
function setMode(mode: 'Pretty' | 'Raw'): void {
  store.mode = mode;
  render();
}
function setLanguage(event: Event): void {
  store.language = (event.target as HTMLSelectElement).value;
  render();
}

// The JSON filter applies to the body editor after a short pause in typing.
let filterTimer: ReturnType<typeof setTimeout> | undefined;
function onFilterInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    store.filter = value;
    if (!editors.applyResponseFilter()) void editors.formatResponse(true);
  }, 150);
}
function onFilterKeydown(event: KeyboardEvent): void {
  const input = event.target as HTMLInputElement;
  if (event.key !== 'Escape' || !input.value) return;
  event.preventDefault();
  event.stopPropagation();
  input.value = '';
  store.filter = '';
  editors.applyResponseFilter();
  void editors.formatResponse(true);
}

const cookies = computed(() =>
  (response()?.setCookies || []).map((item) => ({
    header: item.header,
    cookie: parseSetCookie(item.header, item.url),
  })),
);
// Context menus for header rows (a shared component) and for cookie rows.
const headerMenu = ref<InstanceType<typeof ResponseHeaderMenu>>();
/** A header row's menu target; a Set-Cookie row also lists the cookies it sets, to capture. */
function headerTarget(name: string | number, value: string) {
  const header = String(name);
  if (header.toLowerCase() !== 'set-cookie') return { name: header, value };
  const current = response();
  const names =
    current && current.error === undefined
      ? [...new Set(responseCookies(current).map((cookie) => cookie.name))]
      : [];
  return { name: header, value, cookies: names };
}
const {
  menu: cookieMenu,
  target: cookieFor,
  open: openCookieMenu,
  onKeydown: onCookieKeydown,
} = useContextMenu<{ header: string; cookie?: StoredCookie }>();
const cookieMenuItems = computed<MenuItem[]>(() => [
  { id: 'value', label: 'Copy value', icon: 'content-copy', disabled: !cookieFor.value?.cookie },
  {
    id: 'cookie',
    label: 'Copy as Cookie header',
    icon: 'format-header-pound',
    disabled: !cookieFor.value?.cookie,
  },
  { id: 'set-cookie', label: 'Copy Set-Cookie header', icon: 'content-copy' },
  {
    id: 'capture',
    label: 'Capture into a variable',
    icon: 'variable',
    separated: true,
    disabled: !cookieFor.value?.cookie,
  },
]);
async function onCookieMenu(command: string): Promise<void> {
  const target = cookieFor.value;
  if (!target) return;
  if (command === 'capture') {
    if (target.cookie) requestTests.captureCookie(target.cookie.name);
    return;
  }
  const text =
    command === 'value'
      ? target.cookie?.value
      : command === 'cookie'
        ? target.cookie && `Cookie: ${target.cookie.name}=${target.cookie.value}`
        : `Set-Cookie: ${target.header}`;
  if (text === undefined) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
function cookieFlags(cookie: StoredCookie): { label: string; tone: UITone }[] {
  return [
    ...(cookie.hostOnly ? [] : [{ label: 'Subdomains', tone: 'neutral' as const }]),
    ...(cookie.secure ? [{ label: 'Secure', tone: 'success' as const }] : []),
    ...(cookie.httpOnly ? [{ label: 'HttpOnly', tone: 'neutral' as const }] : []),
    ...(cookie.sameSite
      ? [{ label: `SameSite=${cookie.sameSite}`, tone: 'neutral' as const }]
      : []),
  ];
}
</script>

<template>
  <ResponseFrame
    panel-id="response-panel"
    :panel-label="`response-tab-${tab().toLowerCase()}`"
    :source-editor="showsSource() || content() === 'preview'"
  >
    <template #badge>
      <UiBadge v-if="pending" label="Sending…" tone="brand" icon="loading" />
    </template>
    <template #meta>
      <template v-if="response() && response()!.error === undefined">
        <span v-if="response()!.httpVersion" class="response-http-version"
          >HTTP/{{ response()!.httpVersion }}</span
        ><UiBadge
          :label="`${response()!.status} ${response()!.statusText}`"
          :tone="response()!.status >= 400 ? 'danger' : 'success'"
        /><span
          ><MdiIcon name="timer-outline" /><strong>{{ response()!.time }}</strong> ms</span
        ><span
          ><MdiIcon name="file-code-outline" /><strong>{{
            ((response()!.size ?? 0) / 1024).toFixed(2)
          }}</strong>
          KB</span
        >
      </template>
      <span v-else-if="!pending">Awaiting a response</span>
    </template>
    <template #navigation>
      <UiTabs
        group="response"
        label="Response inspector"
        :items="tabs"
        :active="tab()"
        attribute="data-response-tab"
        class="response-tabs"
        @select="selectTab"
      />
      <div class="response-tools">
        <UiIconButton
          :label="`Copy response ${tab().toLowerCase()}`"
          icon="content-copy"
          data-action="copy"
          :disabled="!canInspect()"
          @click="action('copy')"
        /><UiIconButton
          :label="`Download response ${tab().toLowerCase()}`"
          icon="download"
          data-action="download"
          :disabled="!canInspect()"
          @click="action('download')"
        />
      </div>
    </template>
    <template #toolbar>
      <!-- One line of controls; in a narrow pane they scroll with arrows. -->
      <ScrollRow class="code-toolbar" frame-class="code-toolbar-frame" noun="tools">
        <div class="segmented-control">
          <button
            v-for="mode in ['Pretty', 'Raw'] as const"
            :key="mode"
            :data-mode="mode"
            :aria-pressed="store.mode === mode"
            :class="{ selected: store.mode === mode }"
            @click="setMode(mode)"
          >
            {{ mode }}
          </button>
        </div>
        <div
          v-if="hasBody() && tab() === 'Body' && store.mode === 'Pretty' && rendersDocument()"
          class="segmented-control"
          role="group"
          :aria-label="kind() === 'markdown' ? 'Markdown view' : 'HTML view'"
        >
          <button
            v-for="view in ['rendered', 'source'] as const"
            :key="view"
            type="button"
            :data-html-view="view"
            :aria-pressed="store.htmlView === view"
            :class="{ selected: store.htmlView === view }"
            @click="setHtmlView(view)"
          >
            {{ view === 'rendered' ? 'Rendered' : 'Source' }}
          </button>
        </div>
        <template
          v-if="hasBody() && tab() === 'Body' && !(store.mode === 'Pretty' && previewing())"
        >
          <label class="response-language"
            ><span class="sr-only">Response language</span
            ><UiSelect
              id="response-editor-language"
              aria-label="Response editor language"
              :value="store.language"
              @change="setLanguage"
              :options="languageOptions()" /></label
          ><UiButton
            label="Format"
            icon="code-tags"
            variant="ghost"
            data-action="format-response"
            :disabled="!editorRuntime.canFormat(sourceLanguage())"
            @click="action('format-response')"
          />
          <!-- The filter scripts toggle has-error on this label, so its class stays static. -->
          <label
            v-if="store.mode === 'Pretty' && !isByteView(sourceLanguage())"
            class="response-filter"
            title="Filter JSON with a path such as $.items[*].id · Esc clears"
            ><MdiIcon name="filter-variant" /><span class="sr-only">Filter response JSON</span
            ><input
              id="response-filter"
              type="search"
              :value="store.filter"
              placeholder="Filter  $.data[*].id"
              autocomplete="off"
              spellcheck="false"
              aria-describedby="response-filter-status"
              @input="onFilterInput"
              @keydown="onFilterKeydown"
          /></label>
        </template>
        <span class="right code-toolbar-note"
          ><MdiIcon name="code-tags" />{{
            tab() !== 'Body' && store.mode === 'Raw'
              ? tab() === 'Headers'
                ? 'Header text'
                : 'JSON'
              : 'Response inspector'
          }}</span
        >
      </ScrollRow>
    </template>
    <template #status>
      <!-- Formatting and filtering write these directly, so they have no bindings. -->
      <p
        id="response-format-status"
        class="field-help response-format-status"
        role="status"
        hidden
      ></p>
      <p
        id="response-filter-status"
        class="field-help response-format-status"
        role="status"
        hidden
      ></p>
    </template>

    <UiEmptyState
      v-if="content() === 'pending'"
      class="response-empty is-loading"
      icon="loading"
      title="Waiting for your API"
      description="Your request is on its way. You can cancel it at any time."
    />
    <UiEmptyState
      v-else-if="content() === 'empty'"
      class="response-empty"
      icon="console-network-outline"
      title="Ready when you are"
      description="Send a request to explore the response, headers, assertions, and timing."
      ><kbd>⌘ / Ctrl + Enter</kbd></UiEmptyState
    >
    <ResponsePreview
      v-else-if="content() === 'preview'"
      :response="response() as HttpResponse"
      capture
    />
    <ResponseSource v-else-if="content() === 'source'" />
    <ResponseCertificate v-else-if="content() === 'certificate'" />
    <ResponseTimeline
      v-else-if="content() === 'timeline'"
      :request="request()"
      :response="response()!"
    />
    <ResponseCompare v-else-if="content() === 'compare'" />
    <UiEmptyState
      v-else-if="content() === 'error'"
      class="response-empty error-empty"
      icon="close-circle-outline"
      title="Request could not be completed"
      :description="response()!.error!"
    >
      <VaultUnlockNotice
        v-if="vaultIssue(response()!.error)"
        :message="response()!.error"
        :retry="resend"
        retry-label="resend"
      />
    </UiEmptyState>
    <template v-else-if="content() === 'headers'">
      <div v-if="!Object.keys(response()!.headers ?? {}).length" class="assertion-empty">
        No response headers were returned.
      </div>
      <table v-else class="response-headers-table">
        <thead>
          <tr>
            <th scope="col">Header</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(value, name) in response()!.headers ?? {}"
            :key="name"
            tabindex="0"
            :data-response-header="name"
            @contextmenu="headerMenu?.open($event, headerTarget(name, value))"
            @keydown="headerMenu?.onKeydown($event, headerTarget(name, value))"
          >
            <th scope="row">{{ name }}</th>
            <td>{{ value }}</td>
          </tr>
        </tbody>
      </table>
      <ResponseHeaderMenu ref="headerMenu" capture />
    </template>
    <template v-else-if="content() === 'cookies'">
      <div v-if="!cookies.length" class="assertion-empty">
        This response did not set any cookies.
      </div>
      <template v-else>
        <table class="response-headers-table cookie-response-table">
          <thead>
            <tr>
              <th scope="col">Cookie</th>
              <th scope="col">Value</th>
              <th scope="col">Domain / path</th>
              <th scope="col">Expires</th>
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="({ header, cookie }, index) in cookies"
              :key="index"
              tabindex="0"
              :data-response-cookie="index"
              @contextmenu="openCookieMenu($event, { header, cookie })"
              @keydown="onCookieKeydown($event, { header, cookie })"
            >
              <template v-if="cookie">
                <th scope="row">{{ cookie.name }}</th>
                <td>{{ cookie.value }}</td>
                <td>
                  <code>{{ cookie.domain }}{{ cookie.path }}</code>
                </td>
                <td>{{ cookieStore.expiry(cookie) }}</td>
                <td class="cookie-flags">
                  <UiBadge v-for="flag in cookieFlags(cookie)" :key="flag.label" v-bind="flag" />
                </td>
              </template>
              <template v-else>
                <th scope="row"><UiBadge label="Rejected" tone="danger" /></th>
                <td colspan="4">
                  <code>{{ header }}</code>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
        <ContextMenu
          ref="cookieMenu"
          label="Response cookie actions"
          :items="cookieMenuItems"
          data-response-cookie-menu
          @select="onCookieMenu"
        />
        <p class="field-help cookie-response-note">
          {{
            cookieStore.enabled()
              ? 'Valid cookies were saved to the workspace cookie jar.'
              : 'The cookie jar is off, so these cookies were not saved.'
          }}
          Rejected cookies have an invalid name, a Domain this host cannot set, or Secure over plain
          HTTP.
        </p>
      </template>
    </template>
    <template v-else-if="content() === 'tests'">
      <div v-if="!tests.length" class="assertion-empty">
        No assertions configured. Add assertions in the Tests tab.
      </div>
      <TestResults :results="tests" capture />
      <template v-if="captures.length">
        <h3 class="capture-results-title"><MdiIcon name="variable" />Captured variables</h3>
        <div
          v-for="(result, index) in captures"
          :key="index"
          :class="['assertion-result', result.error === undefined ? 'passed' : 'failed']"
        >
          <MdiIcon
            :name="result.error === undefined ? 'check-circle-outline' : 'close-circle-outline'"
          /><strong>{{ result.error === undefined ? 'SET' : 'MISS' }}</strong>
          <div class="assertion-result-detail">
            <span><code v-text="`{{${result.variable}}}`"></code> ← {{ result.source }}</span
            ><small>{{
              result.error === undefined
                ? result.value!.length > 160
                  ? `${result.value!.slice(0, 160)}…`
                  : result.value
                : result.error
            }}</small>
          </div>
        </div>
      </template>
    </template>
    <ResponseTimeline v-else :request="request()" :response="response()!" />
  </ResponseFrame>
</template>
