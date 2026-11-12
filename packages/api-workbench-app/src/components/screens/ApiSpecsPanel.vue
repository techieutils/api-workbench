<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { collectionOf } from '@techieutils/api-workbench-common/folders';
import type { SpecProblem } from '@techieutils/api-workbench-common/api-specs';
import type { EditorHandle } from '../../editor/runtime';
import { withIcons } from '../../select-options';
import { methodIcon } from '../../stores/protocols';
import { useSpecsStore, type SpecTab } from '../../stores/api-specs';
import { useWorkspaceStore } from '../../stores/workspace';
import { useContextMenu } from '../../composables/context-menu';
import type { MenuItem } from '../ActionMenu.vue';
import ActionMenu from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import MdiIcon from '../MdiIcon.vue';
import SourceEditor from '../SourceEditor.vue';
import PageHeader from '../ui/PageHeader.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiTabs from '../ui/UiTabs.vue';

/** API specifications: a list beside an editor with live validation and an endpoint list. */
const store = useSpecsStore();
const workspace = useWorkspaceStore();
// Specs are edited in place, so read them on every render rather than caching them.
const spec = () => store.current()!;
const analysis = () => store.analysis(spec());
const collectionNames = computed(() => {
  void workspace.revision;
  return [...new Set(workspace.state.requests.map((request) => collectionOf(request.folder)))];
});
const fromCollection = ref('');
function createFrom(collection: string): void {
  fromCollection.value = '';
  if (collection) store.createFromCollection(collection);
}
const fileInput = ref<HTMLInputElement>();
function openFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void store.createFromFile(file);
}
const summary = (id: string) => {
  const item = store.specs().find((candidate) => candidate.id === id)!;
  const result = store.analysis(item);
  if (!result.version) return 'Not a recognised specification';
  return `${result.version} · ${result.endpoints.length} endpoint${result.endpoints.length === 1 ? '' : 's'}`;
};
const tabs = (): UITab[] => [
  { name: 'Editor', icon: 'file-code-outline' },
  { name: 'Endpoints', icon: 'api', count: analysis().endpoints.length },
];
/** Endpoints grouped by their first tag, in the order the document lists them. */
const groups = () => {
  const map = new Map<string, ReturnType<typeof analysis>['endpoints']>();
  for (const endpoint of analysis().endpoints) {
    const list = map.get(endpoint.tag || 'Untagged') ?? [];
    list.push(endpoint);
    map.set(endpoint.tag || 'Untagged', list);
  }
  return [...map];
};
const problemCounts = () => {
  const problems = analysis().problems;
  const errors = problems.filter((problem) => problem.severity === 'error').length;
  return { errors, warnings: problems.length - errors };
};
const editor = ref<EditorHandle>();
function showProblem(problem: SpecProblem): void {
  if (!problem.line) return;
  store.ui.tab = 'Editor';
  void nextTick(() => editor.value?.goToLine(problem.line!));
}
function rename(event: Event): void {
  store.rename(spec().id, (event.target as HTMLInputElement).value);
}
const actions: MenuItem[] = [
  { id: 'download', label: 'Download', icon: 'download' },
  { id: 'duplicate', label: 'Duplicate', icon: 'content-copy' },
  { id: 'delete', label: 'Delete', icon: 'delete-outline', danger: true, separated: true },
];
function run(command: string, id: string): void {
  if (command === 'collection') void store.generateCollection(id);
  else if (command === 'mock') store.startMock(id);
  else if (command === 'download') store.downloadSpec(id);
  else if (command === 'duplicate') store.duplicate(id);
  else if (command === 'delete') void store.remove(id);
  else if (command === 'rename')
    void nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('#spec-name');
      input?.focus();
      input?.select();
    });
}
// A row's context menu acts on that specification, selecting it first.
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<string>();
const menuItems = computed<MenuItem[]>(() => [
  { id: 'rename', label: 'Rename', icon: 'pencil-outline' },
  { id: 'collection', label: 'Generate collection', icon: 'folder-plus-outline' },
  { id: 'mock', label: 'Start a mock server', icon: 'server-network' },
  ...actions,
]);
function onMenuSelect(command: string): void {
  const id = menuFor.value;
  if (!id) return;
  store.select(id);
  run(command, id);
}
</script>

<template>
  <section class="panel api-specs-page">
    <PageHeader
      eyebrow="WORKSPACE / DESIGN"
      guide="specs"
      title="API specifications"
      description="Design OpenAPI documents, then turn them into collections and mock servers."
    >
      <UiButton
        label="Open file"
        icon="import"
        data-spec-open
        @click="fileInput?.click()"
      /><UiButton
        label="New specification"
        icon="plus"
        variant="primary"
        data-spec-new
        @click="store.create()"
      />
    </PageHeader>
    <input
      ref="fileInput"
      class="file-input"
      type="file"
      accept=".yaml,.yml,.json"
      data-spec-file
      @change="openFile"
    />
    <UiEmptyState
      v-if="!store.specs().length"
      icon="file-code-outline"
      title="No API specifications yet"
      description="Start from a template, open an OpenAPI or Swagger file, or describe one of your collections."
    >
      <div class="spec-empty-actions">
        <UiButton label="New specification" icon="plus" variant="primary" @click="store.create()" />
        <UiSelect
          v-model="fromCollection"
          class="field-input"
          aria-label="Create a specification from a collection"
          placeholder="From a collection…"
          :options="withIcons(collectionNames, 'folder-outline')"
          @update:model-value="createFrom"
        />
      </div>
    </UiEmptyState>
    <div v-else class="environments-layout">
      <nav class="environment-list" aria-label="API specifications">
        <span class="eyebrow">SPECIFICATIONS · {{ store.specs().length }}</span>
        <ScrollRow class="environment-items" noun="specifications">
          <button
            v-for="item in store.specs()"
            :key="item.id"
            type="button"
            :class="['environment-item', { 'is-active': item.id === spec().id }]"
            :data-spec-select="item.id"
            :aria-pressed="item.id === spec().id"
            @click="store.select(item.id)"
            @contextmenu="openMenu($event, item.id)"
            @keydown="onRowKeydown($event, item.id)"
          >
            <MdiIcon name="file-code-outline" class="environment-item-icon" /><span
              class="environment-item-copy"
              ><strong>{{ item.name }}</strong
              ><small>{{ summary(item.id) }}</small></span
            ><UiBadge
              v-if="store.errors(item)"
              :label="`${store.errors(item)}`"
              tone="danger"
              icon="alert-circle-outline"
            />
          </button>
        </ScrollRow>
        <label class="form-field spec-from-collection"
          ><span>New from a collection</span
          ><UiSelect
            v-model="fromCollection"
            class="field-input"
            data-spec-from-collection
            placeholder="Choose a collection…"
            :options="withIcons(collectionNames, 'folder-outline')"
            @update:model-value="createFrom"
        /></label>
        <ContextMenu
          ref="contextMenu"
          label="Specification actions"
          :items="menuItems"
          data-spec-menu
          @select="onMenuSelect"
        />
      </nav>
      <div class="overview-card spec-editor">
        <div class="environment-editor-heading spec-editor-heading">
          <label class="form-field mb-0 flex-1"
            ><span>Name</span
            ><input
              id="spec-name"
              :key="spec().id"
              class="field-input"
              :value="spec().name"
              maxlength="80"
              aria-label="Specification name"
              @change="rename"
          /></label>
          <UiButton
            label="Generate collection"
            icon="folder-plus-outline"
            class="self-end"
            data-spec-collection
            :title="
              spec().collection
                ? `Refresh the ${spec().collection} collection from this specification`
                : 'Make a collection of requests from this specification'
            "
            @click="run('collection', spec().id)"
          /><UiButton
            label="Start mock"
            icon="server-network"
            class="self-end"
            data-spec-mock
            @click="run('mock', spec().id)"
          /><ActionMenu
            label="More specification actions"
            :items="actions"
            trigger-class="self-end"
            data-spec-more
            @select="run($event, spec().id)"
          />
        </div>
        <div class="spec-status" data-spec-status>
          <UiBadge
            :label="analysis().version || 'Unrecognised'"
            :tone="analysis().version ? 'brand' : 'warning'"
            icon="file-code-outline"
          />
          <UiBadge :label="spec().format.toUpperCase()" />
          <UiBadge
            v-if="problemCounts().errors"
            :label="`${problemCounts().errors} error${problemCounts().errors === 1 ? '' : 's'}`"
            tone="danger"
            icon="alert-circle-outline"
          />
          <UiBadge
            v-if="problemCounts().warnings"
            :label="`${problemCounts().warnings} warning${problemCounts().warnings === 1 ? '' : 's'}`"
            tone="warning"
            icon="alert-outline"
          />
          <UiBadge
            v-if="!analysis().problems.length"
            label="Valid"
            tone="success"
            icon="check-circle-outline"
          />
          <span v-if="spec().collection" class="spec-link"
            ><MdiIcon name="folder-outline" />Collection: {{ spec().collection }}</span
          >
          <UiButton
            v-if="store.ui.tab === 'Editor'"
            label="Format"
            icon="code-tags"
            variant="ghost"
            class="spec-format"
            data-spec-format
            :title="`Format as ${spec().format.toUpperCase()}`"
            @click="store.format(spec().id)"
          />
        </div>
        <UiTabs
          group="spec"
          label="Specification views"
          :items="tabs()"
          :active="store.ui.tab"
          attribute="data-spec-tab"
          class="spec-tabs"
          @select="store.ui.tab = $event as SpecTab"
        />
        <div id="spec-panel" role="tabpanel" class="spec-panel">
          <template v-if="store.ui.tab === 'Editor'">
            <SourceEditor
              id="spec-source-editor"
              :key="spec().id"
              class="source-editor-host spec-source-editor"
              :value="spec().content"
              :language="spec().format"
              :wrap="workspace.settings().wordWrap"
              label="Specification editor"
              context-menu
              formattable
              @format="store.format(spec().id)"
              @change="store.setContent(spec().id, $event)"
              @handle="editor = $event"
            />
            <ul v-if="analysis().problems.length" class="spec-problems" aria-label="Problems">
              <li v-for="(problem, index) in analysis().problems" :key="index">
                <button
                  type="button"
                  :class="['spec-problem', problem.severity]"
                  :disabled="!problem.line"
                  data-spec-problem
                  @click="showProblem(problem)"
                >
                  <MdiIcon
                    :name="problem.severity === 'error' ? 'alert-circle-outline' : 'alert-outline'"
                  /><span>{{ problem.message }}</span
                  ><small v-if="problem.line">Line {{ problem.line }}</small>
                </button>
              </li>
            </ul>
          </template>
          <template v-else>
            <UiEmptyState
              v-if="!analysis().endpoints.length"
              icon="api"
              title="No endpoints yet"
              description="Add operations under paths in the editor to see them here."
            />
            <div v-for="[tag, endpoints] in groups()" :key="tag" class="spec-endpoint-group">
              <h4>{{ tag }}</h4>
              <ul>
                <li
                  v-for="endpoint in endpoints"
                  :key="`${endpoint.method} ${endpoint.path}`"
                  :class="['spec-endpoint', { deprecated: endpoint.deprecated }]"
                  data-spec-endpoint
                >
                  <span :class="['method', endpoint.method]"
                    ><MdiIcon :name="methodIcon(endpoint.method)" class="method-icon" />{{
                      endpoint.method
                    }}</span
                  ><code>{{ endpoint.path }}</code
                  ><span>{{ endpoint.summary }}</span>
                </li>
              </ul>
            </div>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
