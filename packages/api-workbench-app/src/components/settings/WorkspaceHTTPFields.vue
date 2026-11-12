<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../select-options';
import { computed } from 'vue';
import * as http from '@techieutils/api-workbench-common/http-settings';
import UiExpansionPanel from '../ui/UiExpansionPanel.vue';
import UiSelect from '../ui/UiSelect.vue';

type HTTPField = (typeof http.fields)[number];
/** Workspace HTTP defaults. Fields are edited in place on the parent's reactive draft. */
const props = defineProps<{ draft: HTTPSettings }>();

const GROUPS = {
  Proxy: { icon: 'swap-horizontal', description: 'Proxy mode, URL, credentials, and bypass list' },
  Execution: { icon: 'timer-outline', description: 'Timeout, redirects, and response size limits' },
  Connection: {
    icon: 'console-network-outline',
    description: 'HTTP version, connection timeouts, keep-alive, and pooling',
  },
  TLS: {
    icon: 'shield-lock-outline',
    description: 'Certificate verification, TLS versions, CA certificates, and ciphers',
  },
} as const satisfies Record<HTTPField['group'], { icon: MdiIconName; description: string }>;
const changed = (fields: HTTPField[]) =>
  fields.filter((field) => String(props.draft[field.key]) !== String(http.defaults[field.key]))
    .length;
const groups = computed(() =>
  (Object.keys(GROUPS) as HTTPField['group'][]).map((group) => {
    const fields = http.fields.filter((field) => field.group === group);
    const count = changed(fields);
    return { group, ...GROUPS[group], fields, badge: count ? `${count} changed` : undefined };
  }),
);
// Execution holds the everyday settings; other groups start open only when they differ from the
// defaults. Taken once, so a panel never closes under the user as they edit.
const initiallyOpen = new Set(
  groups.value.filter(({ group, badge }) => group === 'Execution' || badge).map((g) => g.group),
);
const id = (field: HTTPField) => `http-workspace-${field.key}`;
// timeoutMs and followRedirects also exist as top-level app settings under the same names.
const name = (field: HTTPField) =>
  ['timeoutMs', 'followRedirects'].includes(field.key) ? field.key : `http:${field.key}`;
const wide = (field: HTTPField) =>
  ['caCertificates', 'tlsCiphers', 'proxyUrl', 'proxyBypass'].includes(field.key);
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
// Typed views of the same draft, one per kind of control.
const flags = computed(() => props.draft as unknown as Record<string, boolean>);
const numbers = computed(() => props.draft as unknown as Record<string, number>);
const text = computed(() => props.draft as unknown as Record<string, string>);
</script>

<template>
  <UiExpansionPanel
    v-for="{ group, icon, description, fields, badge } in groups"
    :key="group"
    class="http-settings-panel"
    :title="group"
    :description="description"
    :icon="icon"
    :badge="badge"
    :open="initiallyOpen.has(group)"
    :data-http-group="group"
  >
    <div class="http-settings-grid">
      <div
        v-for="field in fields"
        :key="field.key"
        :class="['http-setting-field', { 'http-wide': wide(field) }]"
      >
        <div class="http-field-heading">
          <label :for="id(field)">{{ field.label }}</label>
        </div>
        <label v-if="typeof http.defaults[field.key] === 'boolean'" class="http-boolean"
          ><input
            :id="id(field)"
            v-model="flags[field.key]"
            type="checkbox"
            :name="name(field)"
            :data-http-field="field.key"
            :aria-describedby="`${id(field)}-help`"
          /><span>Enabled</span></label
        >
        <UiSelect
          v-else-if="field.options"
          :id="id(field)"
          v-model="text[field.key]"
          class="field-input"
          :name="name(field)"
          :data-http-field="field.key"
          :aria-describedby="`${id(field)}-help`"
          :options="withIcons(field.options, OPTION_ICONS.httpSetting, 'tune-variant')"
        />
        <textarea
          v-else-if="field.key === 'caCertificates'"
          :id="id(field)"
          v-model="text[field.key]"
          class="field-input http-ca-editor"
          :name="name(field)"
          :data-http-field="field.key"
          :aria-describedby="`${id(field)}-help`"
          rows="4"
          spellcheck="false"
          placeholder="-----BEGIN CERTIFICATE-----"
        ></textarea>
        <input
          v-else-if="field.min !== undefined"
          :id="id(field)"
          v-model.number="numbers[field.key]"
          class="field-input"
          :name="name(field)"
          :data-http-field="field.key"
          :aria-describedby="`${id(field)}-help`"
          type="number"
          autocomplete="off"
          :min="field.min"
          :max="field.max"
          step="1"
          required
        />
        <input
          v-else
          :id="id(field)"
          v-model="text[field.key]"
          class="field-input"
          :name="name(field)"
          :data-http-field="field.key"
          :aria-describedby="`${id(field)}-help`"
          :type="field.key === 'proxyPassword' ? 'password' : 'text'"
          autocomplete="off"
          :placeholder="placeholder(field)"
          spellcheck="false"
        />
        <small class="http-setting-source" :data-http-source="field.key">Workspace default</small>
        <p :id="`${id(field)}-help`" class="field-help">{{ field.help }}</p>
      </div>
    </div>
  </UiExpansionPanel>
</template>
