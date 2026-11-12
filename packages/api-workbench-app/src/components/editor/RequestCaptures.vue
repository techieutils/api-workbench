<script setup lang="ts">
import { computed } from 'vue';
import GuideButton from '../ui/GuideButton.vue';
import { captureVariableName } from '@techieutils/api-workbench-common/capture-suggestions';
import {
  CAPTURE_TRANSFORMS,
  suggestedCaptures,
} from '@techieutils/api-workbench-common/capture-completions';
import type { HttpResponse } from '@techieutils/api-workbench-common/types';
import { useRendered } from '../../composables/rendered';
import { render } from '../../shell';
import { useWorkspaceStore } from '../../stores/workspace';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';
import UiExpansionPanel from '../ui/UiExpansionPanel.vue';
import KeyValueTable from '../table/KeyValueTable.vue';

/**
 * Response values saved into the active environment after each send: the capture rows (whose
 * sources complete from the last response and preview what they capture), captures suggested
 * from that response, and a reference of every kind of source, each one a click from a new row.
 */
const workspace = useWorkspaceStore();
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
const view = useRendered(() => {
  const current = request();
  const response =
    current.response && !('error' in current.response && current.response.error)
      ? (current.response as HttpResponse)
      : undefined;
  const rows = current.captures ?? [];
  const environment = workspace.state.environments[workspace.state.environment];
  const names = new Set(environment.variables.map((variable) => variable.key));
  const active = rows.filter((row) => row.enabled && row.key.trim() && row.value.trim());
  return {
    response,
    environment: environment.name,
    count: active.length,
    /** How many of the captures update a variable the environment already has. */
    updates: active.filter((row) => names.has(row.key.trim())).length,
    suggested: suggestedCaptures(
      response,
      rows.map((row) => row.value),
    ),
  };
});

/** Adds a capture row for `source`, named after what it reads. */
function addCapture(source: string): void {
  const rows = (request().captures ||= []);
  const taken = rows.map((row) => row.key);
  // A path (`body.user.id`, `$.token`) is named after its last key; others after what they name.
  const path = /^(\$|body\s*[.[])/.test(source) ? source.replace(/^body/, '$') : undefined;
  const fallback = source
    .replace(/^(header|cookie)\[\s*"(.*)"\s*\]$/, '$2')
    .replace(/^(header|cookie)\./, '')
    .replace(/^(header|cookie|form|timing|certificate)\s+/, '')
    .replace(/^status\./, 'status_')
    .replace(/^(\$|body).*/, 'value');
  rows.push({
    enabled: true,
    key: captureVariableName(path, taken, /^[\w-]+$/.test(fallback) ? fallback : 'value'),
    value: source,
  });
  workspace.persist();
  render();
}

/** Every kind of source, grouped, each with an example that can be added as a row. */
const REFERENCE: { group: string; icon: MdiIconName; items: [string, string][] }[] = [
  {
    group: 'Response body',
    icon: 'code-json',
    items: [
      ['body.data.token', 'A value: JSON, XML, YAML, form, NDJSON, or CSV'],
      ['body.items[*].id', 'Every match, as a list'],
      ['body.users[?(@.role == "admin")].id | first', 'The first item that passes a filter'],
      ['body.user.@id', 'An XML attribute; #text is an element’s text'],
      ['body', 'The whole body, as text'],
      ['regex /csrf" value="([^"]+)/', 'A regular expression group'],
      ['between "<title>" "</title>"', 'The text between two markers'],
      ['html input[name="csrf"] @value', 'An HTML element’s text or @attribute'],
      ['form access_token', 'A field of a form-encoded body'],
    ],
  },
  {
    group: 'Response',
    icon: 'swap-horizontal',
    items: [
      ['header.x-request-id', 'A header, case-insensitive'],
      ['cookie.session', 'A cookie the response sets; cookie["a.b"] for dotted names'],
      ['status.code', 'The status code, such as 200'],
      ['status.text', 'The status text, such as OK'],
      ['time', 'How long it took, in ms; also size'],
    ],
  },
  {
    group: 'Network and TLS',
    icon: 'timer-outline',
    items: [
      ['timing ttfb', 'A timing in ms: total, dns, tcp, tls, ttfb, download'],
      ['certificate days-left', 'The certificate: valid-to, days-left, sha256, cn, …'],
    ],
  },
  {
    group: 'Failures',
    icon: 'alert-circle-outline',
    items: [['error', 'Why the request failed; runs only when it fails']],
  },
];
const transforms = computed(() =>
  CAPTURE_TRANSFORMS.map((item) => item.insert.replace(/ ?["$/.]+$/, '').trim()),
);
const variable = (name: string) => `{{${name}}}`;
</script>

<template>
  <div class="captures-tab" data-captures-tab>
    <div class="table-label captures-header">
      <div>
        <strong>Capture variables</strong
        ><span
          >Save response values after each send · chain them into later requests with
          <code v-text="variable('name')"></code></span
        ><GuideButton guide="variables" topic="variables and captures" />
      </div>
      <div class="captures-facts">
        <span class="captures-fact" :title="`Captured values are saved in ${view.environment}`"
          ><MdiIcon name="layers-outline" />Saves into <strong>{{ view.environment }}</strong></span
        >
        <span v-if="view.count" class="captures-fact" data-captures-count
          >{{ view.count }} active{{
            view.updates ? ` · ${view.updates} update existing` : ''
          }}</span
        >
        <span
          :class="['captures-fact', view.response ? 'is-live' : 'is-idle']"
          data-captures-response
          ><MdiIcon :name="view.response ? 'eye-outline' : 'send-outline'" />{{
            view.response
              ? `Previewing the last response · ${view.response.status}`
              : 'Send the request to preview values'
          }}</span
        >
      </div>
    </div>
    <KeyValueTable
      type="captures"
      :rows="() => request().captures || []"
      :create="() => (request().captures ||= [])"
    />
    <p class="field-help captures-keys">
      Type in a source to see options from the last response — JSON paths, headers, cookies — and
      transforms after <code>|</code>. Press <kbd>Ctrl Space</kbd> to show them, and <kbd>↑</kbd>
      <kbd>↓</kbd> <kbd>Enter</kbd> to choose.
    </p>

    <section
      v-if="view.suggested.length"
      class="captures-suggested"
      aria-labelledby="captures-suggested-title"
      data-captures-suggested
    >
      <h4 id="captures-suggested-title">
        <MdiIcon name="lightning-bolt-outline" />Suggested from the last response
      </h4>
      <div class="captures-suggested-list">
        <button
          v-for="item in view.suggested"
          :key="item.source"
          type="button"
          class="captures-chip"
          :data-capture-suggestion="item.source"
          :title="`Add a capture of ${item.source}`"
          @click="addCapture(item.source)"
        >
          <MdiIcon name="plus" /><code>{{ item.source }}</code
          ><small>{{ item.detail }}</small>
        </button>
      </div>
    </section>

    <UiExpansionPanel
      class="captures-reference"
      title="Source reference"
      description="Every kind of source and transform, with an example to add"
      icon="file-document-outline"
      data-captures-reference
    >
      <div class="captures-reference-grid">
        <section v-for="group in REFERENCE" :key="group.group" class="captures-reference-group">
          <h5><MdiIcon :name="group.icon" />{{ group.group }}</h5>
          <ul>
            <li v-for="[example, description] in group.items" :key="example">
              <code>{{ example }}</code
              ><span>{{ description }}</span
              ><UiButton
                label="Add"
                icon="plus"
                variant="ghost"
                :title="`Add a capture of ${example}`"
                :data-capture-example="example"
                @click="addCapture(example)"
              />
            </li>
          </ul>
        </section>
        <section class="captures-reference-group">
          <h5><MdiIcon name="tune-variant" />Transforms, after |</h5>
          <ul class="captures-transforms" aria-label="Transforms">
            <li v-for="name in transforms" :key="name">
              <code>{{ name }}</code>
            </li>
          </ul>
          <p class="field-help">
            Applied in order, such as <code>$.token | jwt $.sub</code> or
            <code>$.items[*].name | join ", "</code>. <code>default "value"</code> replaces a
            failure in the steps before it.
          </p>
        </section>
      </div>
      <p class="field-help">
        Captures run after a successful response, including collection runs, where each request sees
        values captured by earlier ones. When a request fails, only captures that read the failure
        run: <code>error</code>, <code>timing</code>, and <code>certificate</code>. Dynamic values
        such as <code v-text="variable('$guid')"></code> and
        <code v-text="variable('$timestamp')"></code> work in every field.
      </p>
    </UiExpansionPanel>
  </div>
</template>
