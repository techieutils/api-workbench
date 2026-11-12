<script setup lang="ts">
import { methodIcon } from '../../stores/protocols';
import { withIcons } from '../../select-options';
import { collectionOf, isWithin } from '@techieutils/api-workbench-common/folders';
import { computed, shallowRef, watch, watchEffect } from 'vue';
import { collectionRequests } from '@techieutils/api-workbench-common/documentation';
import { action } from '../../actions';
import { download as saveFile, errorMessage, toast } from '../../utils';
import { useMocksStore } from '../../stores/mocks';
import { useRequestsStore } from '../../stores/requests';
import { useScreensStore } from '../../stores/screens';
import { useWorkspaceStore } from '../../stores/workspace';
import MdiIcon from '../MdiIcon.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import SourceEditor from '../SourceEditor.vue';
import PageHeader from '../ui/PageHeader.vue';
import UiButton from '../ui/UiButton.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import TagFilterChips from '../ui/TagFilterChips.vue';
import {
  describeTagFilter,
  emptyTagFilter,
  tagCounts,
  tagFilterActive,
} from '@techieutils/api-workbench-common/tags';

/** API reference and specifications generated from each collection's saved requests. */
const workspace = useWorkspaceStore();
const docsStore = useScreensStore();
const requestsStore = useRequestsStore();
const docs = docsStore.documentation;
const mocks = useMocksStore();
const collectionOptions = computed(() =>
  collections.value.map((name) => ({
    value: name,
    label: name,
    description: `${count(name)} request${count(name) === 1 ? '' : 's'}`,
  })),
);
const collections = computed(() => [
  ...new Set(workspace.state.requests.map((request) => collectionOf(request.folder))),
]);
// A collection that no longer exists falls back to the first one.
watchEffect(() => {
  if (!collections.value.includes(docs.collection)) docs.collection = collections.value[0] || '';
});
// Tags belong to a collection's requests, so another collection starts without a filter.
watch(
  () => docs.collection,
  () => (docs.tags = emptyTagFilter()),
);
/** The tags in the chosen collection, with how many requests have each. */
const collectionTagCounts = computed(() => {
  void workspace.state;
  void docs.collection;
  return tagCounts(
    docsStore.collectionRequestsAll().map((request) => ({ tags: docsStore.tagsOf(request) })),
  );
});
const total = computed(() => {
  void workspace.state;
  void docs.collection;
  return docsStore.collectionRequestsAll().length;
});
const requests = computed(() => {
  void workspace.state;
  void docs.tags;
  return collectionRequests(docsStore.documentationRequests());
});
const count = (name: string) =>
  workspace.state.requests.filter((request) => isWithin(request.folder, name)).length;
const output = computed(() => {
  void workspace.state;
  void docs.mode;
  void docs.collection;
  void docs.tags;
  return docsStore.documentationOutput();
});
const wrap = computed(() => workspace.settings().wordWrap);
const language = () => (docs.mode === 'YAML' ? 'yaml' : 'json');
/**
 * The source as formatted, for the text it was made from: a new collection, format, or edit
 * shows freshly generated text again. Copy and Download take what is shown.
 */
const formatted = shallowRef<{ source: string; text: string }>();
const shown = computed(() =>
  formatted.value?.source === output.value.text ? formatted.value.text : output.value.text,
);
async function format(): Promise<void> {
  const source = output.value.text;
  try {
    const text = await WorkbenchEditor.formatText(source, language());
    if (output.value.text !== source) return;
    if (text === shown.value) toast('Already formatted', 'info');
    formatted.value = { source, text };
  } catch (error) {
    toast(`Format failed: ${errorMessage(error)}`, 'error');
  }
}
const rows = (items: KeyValue[]) => items.filter((row) => row.enabled && row.key);
const sections = (request: (typeof requests.value)[number]) =>
  [
    ['Query parameters', rows(request.params)],
    ['Headers', rows(request.headers)],
  ] as const;

function copy(): void {
  void navigator.clipboard
    .writeText(shown.value)
    .then(() => toast('Documentation copied', 'success'))
    .catch(() => toast('Could not copy documentation', 'error'));
}
function download(): void {
  const name = docs.collection.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'collection';
  const kind =
    docs.mode === 'JSON' ? 'collection' : docs.mode === 'Swagger JSON' ? 'swagger' : 'openapi';
  saveFile(`${name}.${kind}.${output.value.extension}`, shown.value, output.value.mime);
}
</script>

<template>
  <section class="panel docs-page">
    <PageHeader
      eyebrow="WORKSPACE / REFERENCE"
      guide="documentation"
      title="API documentation"
      description="Browse API references and specifications by collection."
    >
      <UiButton
        label="Import specification"
        icon="import"
        variant="primary"
        data-action="import"
        @click="action('import')"
      />
    </PageHeader>
    <div class="docs-layout">
      <div class="docs-content">
        <div class="docs-heading">
          <div class="docs-collection-picker">
            <h2 class="sr-only">{{ docs.collection || 'No collections' }}</h2>
            <label for="docs-collection">Collection</label>
            <UiSelect
              id="docs-collection"
              v-model="docs.collection"
              class="field-input"
              data-docs-collection
              placeholder="No collections"
              :options="withIcons(collectionOptions, 'folder-outline')"
            />
            <p>
              {{
                tagFilterActive(docs.tags)
                  ? `${requests.length} of ${total} requests · tagged ${describeTagFilter(docs.tags)}`
                  : `${requests.length} requests · Generated from saved requests`
              }}
            </p>
          </div>
          <div class="docs-actions">
            <UiButton
              v-if="docs.mode !== 'Swagger'"
              label="Format"
              icon="code-tags"
              variant="ghost"
              data-docs-format
              :disabled="!requests.length"
              @click="format"
            /><UiButton
              label="Copy"
              icon="content-copy"
              data-docs-copy
              :disabled="!requests.length"
              @click="copy"
            /><UiButton
              label="Download"
              icon="download"
              data-docs-download
              :disabled="!requests.length"
              @click="download"
            /><UiButton
              label="Start mock"
              icon="server-network"
              data-docs-mock
              :disabled="!requests.length"
              title="Serve this collection's saved responses from a local mock server"
              @click="mocks.startFromCollection(docs.collection)"
            />
          </div>
        </div>
        <TagFilterChips
          v-if="collectionTagCounts.length"
          class="docs-tags"
          :counts="collectionTagCounts"
          :filter="docs.tags"
          verb="show"
          :limit="10"
          data-docs-tags
          @change="docs.tags = $event"
        />
        <ScrollRow
          class="docs-formats"
          role="group"
          aria-label="Documentation format"
          noun="formats"
        >
          <button
            v-for="mode in docsStore.documentationModes"
            :key="mode"
            type="button"
            :data-docs-mode="mode"
            :aria-pressed="mode === docs.mode"
            @click="docs.mode = mode"
          >
            {{ mode }}
          </button>
        </ScrollRow>
        <p class="field-help">
          {{
            docs.mode === 'Swagger'
              ? 'Expand an endpoint to inspect its saved parameters, headers, and body.'
              : docs.mode === 'JSON'
                ? 'API Workbench collection JSON, ready to import.'
                : 'API specification generated from this collection. Imported schemas and response definitions are not inferred from request examples.'
          }}
        </p>
        <div v-if="docs.mode === 'Swagger'" class="docs-endpoints">
          <details v-for="request in requests" :key="request.id" class="docs-endpoint">
            <summary>
              <span :class="['method', request.method]"
                ><MdiIcon :name="methodIcon(request.method)" class="method-icon" />{{
                  request.method
                }}</span
              ><code>{{ request.url.split('?')[0] }}</code
              ><span>{{ request.name }}</span
              ><span v-if="docsStore.tagsOf(request).length" class="docs-endpoint-tags"
                ><span v-for="tag in docsStore.tagsOf(request)" :key="tag">{{ tag }}</span></span
              ><MdiIcon name="chevron-down" />
            </summary>
            <div class="docs-endpoint-body">
              <div class="docs-operation-heading">
                <h3>{{ request.name }}</h3>
                <UiButton
                  label="Open request"
                  icon="arrow-top-right"
                  :data-open="request.id"
                  @click="requestsStore.openRequest(request.id)"
                />
              </div>
              <p class="field-help">Authentication: {{ request.auth }}</p>
              <template v-for="[label, items] in sections(request)" :key="label">
                <template v-if="items.length">
                  <h4>{{ label }}</h4>
                  <div class="table-scroll">
                    <table class="docs-parameters">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Example</th>
                          <th>Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(row, index) in items" :key="index">
                          <td>
                            <code>{{ row.key }}</code>
                          </td>
                          <td>
                            <code>{{ row.value }}</code>
                          </td>
                          <td>{{ row.description || '—' }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>
              </template>
              <template
                v-if="
                  request.body &&
                  !['GET', 'HEAD'].includes(request.method) &&
                  request.bodyType !== 'none'
                "
              >
                <h4>Request body</h4>
                <pre>{{ request.body }}</pre>
              </template>
              <template v-if="rows(request.bodyFields || []).length">
                <h4>Body fields</h4>
                <div class="table-scroll">
                  <table class="docs-parameters">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Example</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(row, index) in rows(request.bodyFields || [])" :key="index">
                        <td>
                          <code>{{ row.key }}</code>
                        </td>
                        <td>
                          <code>{{ row.value }}</code>
                        </td>
                        <td>{{ row.description || '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>
              <h4>Response</h4>
              <p class="field-help">
                Response is defined by the API server. Open the request to send it and inspect the
                response.
              </p>
            </div>
          </details>
        </div>
        <SourceEditor
          v-else
          id="documentation-source"
          :key="`${docs.collection}:${docs.mode}`"
          class="docs-source"
          aria-label="Specification source"
          :value="shown"
          :language="language()"
          :wrap="wrap"
          read-only
          context-menu
          formattable
          :label="`${docs.mode} documentation`"
          @format="format"
          @handle="docsStore.setDocumentationEditor($event)"
        />
        <UiEmptyState
          v-if="!requests.length"
          icon="file-document-outline"
          title="No requests in this collection"
          description="Create or import requests to generate documentation."
        />
      </div>
    </div>
  </section>
</template>
