<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../select-options';
import {
  folderChain,
  folderLabel,
  folderName,
  parentFolder,
} from '@techieutils/api-workbench-common/folders';
import { computed, nextTick, ref } from 'vue';
import { matchClientCertificate } from '@techieutils/api-workbench-common/client-certificates';
import * as http from '@techieutils/api-workbench-common/http-settings';
import { render } from '../../shell';
import { errorMessage, toast } from '../../utils';
import { vChecked } from '../../directives/checked';
import { useHTTPSettingsStore } from '../../stores/http-settings';
import { useSettingsStore } from '../../stores/settings';
import { useUiStore } from '../../stores/ui';
import { useWorkspaceStore } from '../../stores/workspace';
import { useWorkspacesStore } from '../../stores/workspaces';
import MdiIcon from '../MdiIcon.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiSelect from '../ui/UiSelect.vue';

/**
 * Request or collection overrides of the workspace HTTP defaults. Inherited fields stay disabled
 * until overridden; unsaved edits are kept as a draft until saved or discarded.
 */
const props = defineProps<{ proxyOnly?: boolean }>();
const store = useHTTPSettingsStore();
const workspace = useWorkspaceStore();
const settingsStore = useSettingsStore();
const workspaces = useWorkspacesStore();
type HTTPField = (typeof http.fields)[number];
type Value = string | boolean;
const GROUPS = ['Proxy', 'Execution', 'Connection', 'TLS'];

// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
/** The collection or folder the 'collection' scope edits. */
const target = () => store.scopeTarget(request());
/** The levels above the request, nearest first: its folder, the folders above, its collection. */
const levels = () => folderChain(request().folder).reverse();
/** A level's name in the form: "Collection" for the collection, otherwise the folder's name. */
const levelLabel = (path: string) =>
  parentFolder(path) === undefined ? 'Collection' : folderName(path);
const groups = () => (props.proxyOnly ? ['Proxy'] : GROUPS);
const fields = () => http.fields.filter((field) => groups().includes(field.group));
const scopeName = () => (store.scope === 'request' ? 'request' : 'collection');
function saved(): Partial<HTTPSettings> {
  return store.scope === 'request' ? request().httpSettings || {} : store.folderSettings(target());
}
const parent = () => store.scopeParent(store.scope);
const draftKey = () =>
  [
    workspaces.manager.id,
    store.scope,
    store.scope === 'request' ? request().id : `folder:${target()}`,
    props.proxyOnly ? 'proxy' : 'all',
  ].join('|');
const draft = () => store.drafts.get(draftKey());

const overridden = (key: string) =>
  draft() ? draft()!.overrides.includes(key) : Object.hasOwn(saved(), key);
function value(field: HTTPField): Value {
  const current = draft();
  if (!overridden(field.key)) return parent()[field.key] as Value;
  return current
    ? current.values[field.key]
    : ((saved() as Record<string, Value>)[field.key] as Value);
}
const overriddenKeys = () =>
  fields()
    .map((field) => field.key)
    .filter(overridden);
const savedCount = () =>
  Object.keys(saved()).filter((key) => !props.proxyOnly || key.startsWith('proxy')).length;
/** The nearest level above the edited one that sets this key, or the workspace. */
function inheritedFrom(key: string): string {
  const above = store.scope === 'request' ? request().folder : parentFolder(target());
  const source = (above === undefined ? [] : folderChain(above))
    .reverse()
    .find((path) => Object.hasOwn(store.folderSettings(path), key));
  return source ? levelLabel(source) : 'Workspace';
}

/** The draft for this form, created from the saved overrides on the first edit. */
function working(): HTTPSettingsDraft {
  const key = draftKey();
  if (!store.drafts.has(key)) {
    const own = saved() as Record<string, Value>;
    const overrides = fields()
      .map((field) => field.key)
      .filter((field) => Object.hasOwn(own, field));
    store.drafts.set(key, {
      overrides,
      values: Object.fromEntries(overrides.map((field) => [field, own[field]])),
    });
  }
  return store.drafts.get(key)!;
}
/** Drops the draft once it matches what is saved again. */
function settle(): void {
  const current = draft();
  if (!current) return;
  const own = saved() as Record<string, unknown>;
  const rendered = fields().map((field) => field.key as string);
  const savedKeys = Object.keys(own).filter((key) => rendered.includes(key));
  const clean =
    savedKeys.length === current.overrides.length &&
    current.overrides.every(
      (key) => Object.hasOwn(own, key) && String(own[key]) === String(current.values[key]),
    );
  if (clean) store.drafts.delete(draftKey());
}
const error = ref('');
function setOverride(field: HTTPField, enabled: boolean): void {
  const shown = value(field);
  const current = working();
  if (enabled) {
    if (!current.overrides.includes(field.key)) current.overrides.push(field.key);
    current.values[field.key] = shown;
  } else {
    current.overrides = current.overrides.filter((key) => key !== field.key);
    delete current.values[field.key];
  }
  error.value = '';
  settle();
  if (enabled)
    void nextTick(() =>
      document
        .querySelector<HTMLElement>(`[data-http-field="${field.key}"]`)
        ?.focus({ preventScroll: true }),
    );
}
function setValue(field: HTTPField, next: Value): void {
  const current = working();
  if (!current.overrides.includes(field.key)) return;
  current.values[field.key] = next;
  error.value = '';
  settle();
}
const inputValue = (event: Event) => (event.target as HTMLInputElement).value;
const checked = (event: Event) => (event.target as HTMLInputElement).checked;

// Filter: All, Overridden, or a group, plus a text search. The proxy-only form has no filter.
const searchText = (field: HTTPField) => `${field.label} ${field.help} ${field.key}`.toLowerCase();
function visible(field: HTTPField): boolean {
  if (props.proxyOnly) return true;
  const query = store.filter.query.trim().toLowerCase();
  const inGroup =
    store.filter.group === 'All' ||
    (store.filter.group === 'Modified'
      ? overridden(field.key)
      : field.group === store.filter.group);
  return inGroup && (!query || searchText(field).includes(query));
}
const groupCount = (group: string) =>
  group === 'All'
    ? http.fields.length
    : group === 'Modified'
      ? overriddenKeys().length
      : fields().filter((field) => field.group === group && overridden(field.key)).length;
function groupIcon(group: string): MdiIconName {
  return (
    (
      {
        Proxy: 'swap-horizontal',
        Execution: 'timer-outline',
        Connection: 'console-network-outline',
        TLS: 'shield-lock-outline',
        Modified: 'pencil-outline',
      } as Record<string, MdiIconName>
    )[group] || 'tune-variant'
  );
}

// Effective values come from what is saved, as they apply when the request is sent.
const effective = computed(() => {
  void workspace.state;
  const own = props.proxyOnly
    ? Object.fromEntries(Object.entries(saved()).filter(([key]) => key.startsWith('proxy')))
    : saved();
  try {
    return { settings: http.resolve(parent(), own), error: '' };
  } catch (failure) {
    return { settings: undefined, error: errorMessage(failure) };
  }
});
const summary = computed(() => {
  const settings = effective.value.settings;
  if (!settings) return [];
  const seconds = (ms: number) => (ms >= 1000 ? `${Number((ms / 1000).toFixed(2))} s` : `${ms} ms`);
  let proxy = 'Direct';
  if (settings.proxyMode === 'custom')
    try {
      proxy = new URL(settings.proxyUrl).host || 'Custom';
    } catch {
      proxy = 'Custom';
    }
  let certificate: ClientCertificate | undefined;
  try {
    certificate = matchClientCertificate(
      settingsStore.clientCertificates(),
      settingsStore.requestCertificateURL(request()),
    );
  } catch {
    certificate = undefined;
  }
  const chips: { icon: MdiIconName; label: string; value: string; danger?: boolean }[] = [
    { icon: 'timer-outline', label: 'Timeout', value: seconds(settings.timeoutMs) },
    {
      icon: 'arrow-top-right',
      label: 'Redirects',
      value: settings.followRedirects ? `Follow · max ${settings.maxRedirects}` : 'Off',
    },
    {
      icon: 'console-network-outline',
      label: 'HTTP',
      value: settings.httpVersion === 'auto' ? 'Auto' : settings.httpVersion,
    },
    {
      icon: 'shield-lock-outline',
      label: 'TLS',
      value: settings.verifyTLS
        ? `Verified · ${settings.tlsMinVersion.replace('TLSv', '')}+`
        : 'Not verified',
      danger: !settings.verifyTLS,
    },
    { icon: 'swap-horizontal', label: 'Proxy', value: proxy },
  ];
  if (certificate)
    chips.push({ icon: 'shield-lock-outline', label: 'Client cert', value: certificate.host });
  return chips;
});
const savedLabel = () =>
  savedCount()
    ? `${savedCount()} override${savedCount() === 1 ? '' : 's'} saved`
    : 'Using inherited settings';

/** Edits the request, or a collection or folder above it (`folder` names which). */
function setScope(next: 'request' | 'collection', folder = ''): void {
  store.scope = next;
  store.scopeFolder = folder;
  error.value = '';
  render();
}
function openWorkspaceDefaults(): void {
  useUiStore().view = 'Settings';
  settingsStore.section = 'Requests';
  render();
}
/** The overrides shown in the form as a validated patch. */
function readPatch(): Partial<HTTPSettings> {
  const result: Record<string, unknown> = {};
  for (const field of fields()) {
    if (!overridden(field.key)) continue;
    const current = value(field);
    result[field.key] =
      typeof http.defaults[field.key] === 'boolean'
        ? current === true
        : field.min !== undefined
          ? Number(current)
          : String(current);
  }
  const patch = http.overrides(result);
  http.resolve(parent(), patch);
  return patch;
}
function save(patch: Partial<HTTPSettings>): void {
  if (props.proxyOnly) {
    // The proxy-only form leaves the request's other settings, such as its session timeout.
    const others = Object.entries(saved()).filter(([key]) => !key.startsWith('proxy'));
    patch = { ...Object.fromEntries(others), ...patch };
  }
  store.drafts.delete(draftKey());
  if (store.scope === 'request') request().httpSettings = patch;
  else
    workspace.state.collectionHttpSettings = {
      ...workspace.state.collectionHttpSettings,
      [target()]: patch,
    };
  error.value = '';
  workspace.persist();
  render();
  toast('HTTP settings saved', 'success');
}
async function submit(event: Event): Promise<void> {
  const form = event.target as HTMLFormElement;
  if (!form.checkValidity() && !props.proxyOnly) {
    // Reveal every row so the browser can point at the invalid field.
    store.filter.group = 'All';
    store.filter.query = '';
    await nextTick();
  }
  if (!form.reportValidity()) return;
  try {
    save(readPatch());
  } catch (failure) {
    error.value = errorMessage(failure);
  }
}
function discard(): void {
  store.drafts.delete(draftKey());
  error.value = '';
  render();
  toast('Unsaved settings discarded');
}
const placeholder = (field: HTTPField) =>
  field.key === 'proxyUrl'
    ? 'http://localhost:8080'
    : field.key === 'proxyBypass'
      ? 'localhost, .example.com'
      : field.key.startsWith('proxy')
        ? 'Optional'
        : field.key === 'integrityHeaderName'
          ? 'x-checksum'
          : 'Runtime default';
const wide = (field: HTTPField) =>
  ['caCertificates', 'tlsCiphers', 'proxyUrl', 'proxyBypass'].includes(field.key);
</script>

<template>
  <form
    id="http-settings-form"
    :class="[
      'request-http-settings',
      'hs-layout',
      { 'is-proxy-only': proxyOnly, 'is-dirty': draft() },
    ]"
    :data-hs-draft="draftKey()"
    :data-http-scope-form="store.scope"
    :data-http-proxy-only="String(Boolean(proxyOnly))"
    novalidate
    @submit.prevent="submit"
  >
    <div class="hs-header">
      <h3 class="sr-only">
        {{
          store.scope === 'request'
            ? proxyOnly
              ? 'Proxy for this connection'
              : 'Request settings'
            : `Defaults · ${folderLabel(target())}`
        }}
      </h3>
      <!-- One line of levels; deep folders scroll with arrows. -->
      <ScrollRow
        class="segmented-control hs-scope"
        role="group"
        aria-label="Settings scope"
        noun="levels"
      >
        <button
          type="button"
          data-http-scope="request"
          :aria-pressed="store.scope === 'request'"
          :class="{ selected: store.scope === 'request' }"
          @click="setScope('request')"
        >
          This request
        </button>
        <!-- Each level above the request, outward: its folder, the folders above, the collection. -->
        <button
          v-for="path in levels()"
          :key="path"
          type="button"
          :data-http-scope="parentFolder(path) === undefined ? 'collection' : 'folder'"
          :data-http-folder="path"
          :title="folderLabel(path)"
          :aria-pressed="store.scope === 'collection' && target() === path"
          :class="{ selected: store.scope === 'collection' && target() === path }"
          @click="setScope('collection', path)"
        >
          {{ levelLabel(path) }}
        </button>
      </ScrollRow>
      <p class="hs-inherit">
        <template v-if="store.scope === 'request'"
          >Workspace → {{ folderChain(request().folder).map(folderName).join(' → ') }} →
          <strong>request</strong></template
        ><template v-else
          >Defaults for every request in <strong>{{ folderLabel(target()) }}</strong></template
        >
        ·
        <button
          type="button"
          class="text-button"
          data-http-workspace
          @click="openWorkspaceDefaults"
        >
          Workspace defaults <MdiIcon name="arrow-top-right" />
        </button>
      </p>
      <div v-if="effective.settings" class="hs-summary" aria-label="Effective settings">
        <span
          v-for="chip in summary"
          :key="chip.label"
          :class="['hs-chip', { 'is-danger': chip.danger }]"
          ><MdiIcon :name="chip.icon" /><span>{{ chip.label }}</span
          ><strong>{{ chip.value }}</strong></span
        >
      </div>
    </div>
    <p v-if="!effective.settings" class="form-error">{{ effective.error }}</p>
    <p v-if="proxyOnly && request().protocol === 'grpc'" class="field-help">
      gRPC supports HTTP CONNECT proxies. HTTPS proxy endpoints are not supported for gRPC.
    </p>
    <p v-if="effective.settings?.verifyTLS === false" class="info-callout http-verification-status">
      <MdiIcon name="shield-lock-outline" /><span
        >SSL/TLS certificate verification is disabled for these effective settings.</span
      >
    </p>
    <div class="hs-body">
      <nav v-if="!proxyOnly" class="hs-nav" aria-label="Setting groups">
        <label class="hs-search"
          ><MdiIcon name="magnify" /><input
            id="hs-search"
            v-model="store.filter.query"
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
            autocomplete="off"
        /></label>
        <button
          v-for="group in ['All', 'Modified', ...groups()]"
          :key="group"
          type="button"
          :data-hs-filter="group"
          :aria-pressed="store.filter.group === group"
          @click="store.filter.group = group"
        >
          <MdiIcon :name="groupIcon(group)" /><span>{{
            group === 'Modified' ? 'Overridden' : group
          }}</span
          ><span
            :class="['hs-count', { 'is-active': group !== 'All' && groupCount(group) }]"
            :data-hs-count="group"
            >{{ groupCount(group) }}</span
          >
        </button>
      </nav>
      <div class="hs-rows">
        <section
          v-for="group in groups()"
          :key="group"
          class="hs-group"
          :data-hs-section="group"
          :hidden="!fields().some((field) => field.group === group && visible(field))"
        >
          <h4><MdiIcon :name="groupIcon(group)" />{{ group }}</h4>
          <div
            v-for="field in fields().filter((item) => item.group === group)"
            :key="field.key"
            :class="['hs-row', { 'is-overridden': overridden(field.key), 'is-wide': wide(field) }]"
            :data-hs-row="field.key"
            :data-hs-group="group"
            :data-hs-search="searchText(field)"
            :hidden="!visible(field)"
          >
            <div class="hs-meta">
              <label :for="`http-${scopeName()}-${field.key}`">{{ field.label }}</label>
              <p :id="`http-${scopeName()}-${field.key}-help`" class="hs-help" :title="field.help">
                {{ field.help }}
              </p>
            </div>
            <div class="hs-value">
              <label v-if="typeof http.defaults[field.key] === 'boolean'" class="toggle hs-switch"
                ><input
                  :id="`http-${scopeName()}-${field.key}`"
                  type="checkbox"
                  role="switch"
                  :name="`http:${field.key}`"
                  :data-http-field="field.key"
                  :aria-describedby="`http-${scopeName()}-${field.key}-help`"
                  :disabled="!overridden(field.key)"
                  v-checked="value(field) === true"
                  @change="setValue(field, checked($event))" /><span></span
              ></label>
              <UiSelect
                v-else-if="field.options"
                :id="`http-${scopeName()}-${field.key}`"
                class="field-input"
                :name="`http:${field.key}`"
                :data-http-field="field.key"
                :aria-describedby="`http-${scopeName()}-${field.key}-help`"
                :disabled="!overridden(field.key)"
                :value="String(value(field))"
                :options="withIcons(field.options, OPTION_ICONS.httpSetting, 'tune-variant')"
                @change="setValue(field, inputValue($event))"
              />
              <textarea
                v-else-if="field.key === 'caCertificates'"
                :id="`http-${scopeName()}-${field.key}`"
                class="field-input http-ca-editor"
                :name="`http:${field.key}`"
                :data-http-field="field.key"
                :aria-describedby="`http-${scopeName()}-${field.key}-help`"
                :disabled="!overridden(field.key)"
                rows="3"
                spellcheck="false"
                placeholder="-----BEGIN CERTIFICATE-----"
                :value="String(value(field))"
                @input="setValue(field, inputValue($event))"
              ></textarea>
              <input
                v-else
                :id="`http-${scopeName()}-${field.key}`"
                class="field-input"
                :name="`http:${field.key}`"
                :data-http-field="field.key"
                :aria-describedby="`http-${scopeName()}-${field.key}-help`"
                :disabled="!overridden(field.key)"
                :type="
                  field.min !== undefined
                    ? 'number'
                    : field.key === 'proxyPassword'
                      ? 'password'
                      : 'text'
                "
                :value="String(value(field))"
                autocomplete="off"
                :min="field.min"
                :max="field.max"
                :step="field.min !== undefined ? 1 : undefined"
                :required="field.min !== undefined"
                :placeholder="field.min !== undefined ? undefined : placeholder(field)"
                :spellcheck="field.min !== undefined ? undefined : 'false'"
                @input="setValue(field, inputValue($event))"
              />
              <div class="hs-origin">
                <small class="hs-source" :data-http-source="field.key">{{
                  overridden(field.key)
                    ? `${store.scope === 'request' ? 'Request' : levelLabel(target())} override`
                    : `Inherited · ${inheritedFrom(field.key)}`
                }}</small
                ><label
                  class="hs-override"
                  :title="
                    overridden(field.key)
                      ? 'Use the inherited value'
                      : `Override for this ${scopeName()}`
                  "
                  ><input
                    type="checkbox"
                    :data-http-override="field.key"
                    :aria-controls="`http-${scopeName()}-${field.key}`"
                    :aria-label="`Override ${field.label}`"
                    v-checked="overridden(field.key)"
                    @change="setOverride(field, checked($event))"
                  /><span>Override</span></label
                >
              </div>
            </div>
          </div>
        </section>
        <div class="hs-empty" :hidden="fields().some(visible)">
          <UiEmptyState
            icon="magnify"
            title="No matching settings"
            description="Try another search, or choose All."
          />
        </div>
      </div>
    </div>
    <div class="hs-footer">
      <span id="hs-status" class="hs-status" role="status" :data-hs-saved="savedLabel()">
        <template v-if="draft()"
          ><MdiIcon name="pencil-outline" /><span>Unsaved changes</span></template
        >
        <template v-else
          ><MdiIcon name="check-circle-outline" /><span>{{ savedLabel() }}</span></template
        >
      </span>
      <p id="http-settings-error" class="form-error" role="alert">{{ error }}</p>
      <UiButton
        label="Discard changes"
        icon="close"
        variant="ghost"
        class="hs-discard"
        data-http-discard
        @click="discard"
      /><UiButton
        label="Reset overrides"
        icon="undo"
        variant="ghost"
        data-http-reset
        :disabled="!savedCount() && !overriddenKeys().length"
        @click="save({})"
      /><UiButton
        label="Save settings"
        icon="content-save-outline"
        type="submit"
        variant="primary"
      />
    </div>
  </form>
</template>
