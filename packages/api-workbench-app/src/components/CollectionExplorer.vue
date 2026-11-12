<script setup lang="ts">
import {
  describeTagFilter,
  effectiveTags,
  matchesTags,
  prunedTagFilter,
  tagCounts,
  tagFilterActive,
} from '@techieutils/api-workbench-common/tags';
import TagFilterChips from './ui/TagFilterChips.vue';
import { useWorkspacesStore } from '../stores/workspaces';
import { useSpecsStore } from '../stores/api-specs';
import { useMocksStore } from '../stores/mocks';
import { computed, nextTick, ref, watch } from 'vue';
import { action } from '../actions';
import { render } from '../shell';
import { toast } from '../utils';
import { useDialogsStore } from '../stores/dialogs';
import { useHTTPSettingsStore } from '../stores/http-settings';
import { requestMethodClass, requestMethodIcon, requestMethodLabel } from '../stores/protocols';
import { useRequestsStore } from '../stores/requests';
import { PANE_SIZES, useUiStore } from '../stores/ui';
import { useWorkspaceStore } from '../stores/workspace';
import MdiIcon from './MdiIcon.vue';
import PaneResizer from './PaneResizer.vue';
import UiButton from './ui/UiButton.vue';
import UiEmptyState from './ui/UiEmptyState.vue';
import UiIconButton from './ui/UiIconButton.vue';
import ActionMenu, { type MenuItem } from './ActionMenu.vue';
import ContextMenu from './ContextMenu.vue';
import { useContextMenu } from '../composables/context-menu';
import { useRunnerStore } from '../stores/runner';
import { openView } from '../navigation';
import {
  folderLabel,
  folderEntry,
  folderName,
  folderTree,
  isWithin,
  joinFolder,
  parentFolder,
  type FolderNode,
} from '@techieutils/api-workbench-common/folders';

const dialogs = useDialogsStore();
const ui = useUiStore();
const workspace = useWorkspaceStore();
const workspaces = useWorkspacesStore();
const requests = useRequestsStore();
const httpSettings = useHTTPSettingsStore();

// The explorer's right edge resizes it; until then it keeps the width that suits the window.
const sidebar = ref<HTMLElement>();
const width = () =>
  ui.explorerWidth ?? Math.round(sidebar.value?.offsetWidth || PANE_SIZES.explorer.initial);
const measureWidth = ({ x }: { x: number }) => x - sidebar.value!.getBoundingClientRect().left;
function setWidth(value: number): void {
  ui.explorerWidth = value;
}

// Collections, with their folders and requests, as a tree; folders list before requests.
const tree = computed(() => folderTree(workspace.state.requests));
const folderCount = computed(() => tree.value.length);
/** A row inside a collection: a folder heading or a request, indented by its depth. */
type TreeRow =
  | { kind: 'folder'; path: string; name: string; depth: number; expanded: boolean; count: number }
  | { kind: 'request'; request: ApiRequest; depth: number };
/**
 * Whether a request matches the filter: by name, URL, or tag; `#smoke` finds only requests
 * tagged smoke.
 */
const matches = (request: ApiRequest) => {
  const filter = ui.filter.trim().toLowerCase();
  // A request's tags include its collection's and folders'.
  const tags = effectiveTags(workspace.state, request);
  // The tag bar and the search both narrow the tree.
  if (!matchesTags(tags, ui.explorerTags)) return false;
  if (filter.startsWith('#')) return tags.some((tag) => tag.toLowerCase() === filter.slice(1));
  return `${request.name} ${request.url} ${tags.join(' ')}`.toLowerCase().includes(filter);
};
/** Every tag in the workspace, with how many requests have it, for the tag bar. */
const explorerTagCounts = computed(() =>
  tagCounts(
    workspace.state.requests.map((request) => ({ tags: effectiveTags(workspace.state, request) })),
  ),
);
/** Tags no request has any more drop out of the filter, so it never hides everything unseen. */
watch(explorerTagCounts, (counts) => {
  const pruned = prunedTagFilter(
    ui.explorerTags,
    counts.map((entry) => entry.tag),
  );
  if (
    pruned.include.length !== ui.explorerTags.include.length ||
    pruned.exclude.length !== ui.explorerTags.exclude.length
  )
    ui.explorerTags = pruned;
});
const filtering = () => Boolean(ui.filter) || tagFilterActive(ui.explorerTags);
/** Requests in a folder and its folders that match the filter (all of them without one). */
const matchCount = (node: FolderNode<ApiRequest>): number =>
  node.requests.filter(matches).length +
  node.folders.reduce((total, folder) => total + matchCount(folder), 0);
const isExpanded = (path: string) => filtering() || !ui.collapsedFolders.has(path);
function rowsOf(node: FolderNode<ApiRequest>, depth: number): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const folder of node.folders) {
    const count = matchCount(folder);
    if (!count) continue;
    const expanded = isExpanded(folder.path);
    rows.push({ kind: 'folder', path: folder.path, name: folder.name, depth, expanded, count });
    if (expanded) rows.push(...rowsOf(folder, depth + 1));
  }
  for (const request of node.requests)
    if (matches(request)) rows.push({ kind: 'request', request, depth });
  return rows;
}
const groups = computed(() =>
  tree.value
    .map((root) => ({
      folder: root.path,
      count: matchCount(root),
      expanded: isExpanded(root.path),
      rows: rowsOf(root, 0),
    }))
    .filter((group) => group.count),
);
const isActive = (request: ApiRequest) =>
  workspace.state.active === request.id && ui.view === 'Collections';

/** Shows a folder and every folder inside it, or hides them all. */
function setExpandedWithin(folder: string, expanded: boolean): void {
  for (const path of requests.folderPathList())
    if (isWithin(path, folder)) {
      if (expanded) ui.collapsedFolders.delete(path);
      else ui.collapsedFolders.add(path);
    }
}
/** The file manager's name on this system; it shows the collection's or folder's directory. */
const revealItem = (): MenuItem[] => {
  if (!window.workbench?.workspaces.reveal) return [];
  const platform = navigator.platform;
  const label = /Mac/.test(platform)
    ? 'Reveal in Finder'
    : /Win/.test(platform)
      ? 'Show in File Explorer'
      : 'Show in folder';
  const icon: MdiIconName = /Mac/.test(platform) ? 'apple-finder' : 'folder-search-outline';
  return [{ id: 'reveal', label, icon, separated: true }];
};
function reveal(folder: string): void {
  window.workbench?.workspaces
    .reveal?.(folder)
    .catch((error: unknown) =>
      toast(
        `Could not show the folder: ${error instanceof Error ? error.message : error}`,
        'error',
      ),
    );
}
/** Expand all and Collapse all, for a collection or folder and everything inside it. */
const collapseItems = (): MenuItem[] => [
  { id: 'expand', label: 'Expand all', icon: 'expand-all-outline', separated: true },
  { id: 'collapse', label: 'Collapse all', icon: 'collapse-all-outline' },
];

// Collection and request menus.
function collectionItems(folder: string): MenuItem[] {
  return [
    { id: 'new', label: 'New request here', icon: 'plus' },
    { id: 'new-folder', label: 'New folder', icon: 'folder-plus-outline' },
    { id: 'rename', label: 'Rename', icon: 'pencil-outline', shortcut: 'F2' },
    { id: 'duplicate', label: 'Duplicate collection', icon: 'content-copy' },
    ...collapseItems(),
    { id: 'run', label: 'Run in Runner', icon: 'play-outline', separated: true },
    { id: 'export', label: 'Export…', icon: 'export' },
    { id: 'spec', label: 'Create API specification', icon: 'file-code-outline' },
    { id: 'mock', label: 'Create mock server', icon: 'server-network' },
    { id: 'tags', label: 'Tags…', icon: 'tag-multiple-outline' },
    { id: 'settings', label: 'Collection settings', icon: 'cog-outline' },
    ...revealItem(),
    {
      id: 'delete',
      label: 'Delete collection…',
      icon: 'delete-outline',
      danger: true,
      separated: true,
      disabled: workspace.state.requests.every((request) => isWithin(request.folder, folder)),
    },
  ];
}
function onCollectionAction(folder: string, id: string): void {
  if (id === 'new') requests.createRequestIn(folder);
  else if (id === 'new-folder') requests.createFolder(folder);
  else if (id === 'rename') ui.startFolderRename(folder);
  else if (id === 'duplicate') requests.duplicateCollection(folder);
  else if (id === 'settings') httpSettings.openCollection(folder);
  else if (id === 'tags') dialogs.folderTags.folder = folder;
  else if (id === 'expand' || id === 'collapse') setExpandedWithin(folder, id === 'expand');
  else if (id === 'reveal') reveal(folder);
  else if (id === 'delete') void requests.deleteFolder(folder);
  else if (id === 'spec') {
    if (useSpecsStore().createFromCollection(folder)) openView('APIs');
  } else if (id === 'mock') {
    if (useMocksStore().createFromCollection(folder)) openView('Mocks');
  } else if (id === 'export') {
    dialogs.openTransfer('export');
    dialogs.transfer.scope = folder;
  } else if (id === 'run') {
    const runner = useRunnerStore();
    runner.initialize();
    runner.run.folder = folder;
    runner.run.selected = null;
    openView('Runner');
  }
}
/** A folder inside a collection: collection-wide actions (run, export, duplicate) stay on the collection. */
function folderItems(folder: string): MenuItem[] {
  return [
    { id: 'new', label: 'New request here', icon: 'plus' },
    { id: 'new-folder', label: 'New folder', icon: 'folder-plus-outline' },
    { id: 'rename', label: 'Rename', icon: 'pencil-outline', shortcut: 'F2' },
    ...collapseItems(),
    { id: 'tags', label: 'Tags…', icon: 'tag-multiple-outline', separated: true },
    { id: 'settings', label: 'Folder settings', icon: 'cog-outline' },
    ...revealItem(),
    {
      id: 'delete',
      label: 'Delete folder…',
      icon: 'delete-outline',
      danger: true,
      separated: true,
      disabled: workspace.state.requests.every((request) => isWithin(request.folder, folder)),
    },
  ];
}
function onFolderAction(folder: string, id: string): void {
  if (id === 'new') requests.createRequestIn(folder);
  else if (id === 'new-folder') requests.createFolder(folder);
  else if (id === 'expand' || id === 'collapse') setExpandedWithin(folder, id === 'expand');
  else if (id === 'settings') httpSettings.openCollection(folder);
  else if (id === 'tags') dialogs.folderTags.folder = folder;
  else if (id === 'reveal') reveal(folder);
  else if (id === 'rename') ui.startFolderRename(folder);
  else if (id === 'delete') void requests.deleteFolder(folder);
}
function requestItems(request: ApiRequest): MenuItem[] {
  const siblings = workspace.state.requests.filter((item) => item.folder === request.folder);
  const position = siblings.indexOf(request);
  const others = requests.folderPathList().filter((folder) => folder !== request.folder);
  return [
    { id: 'open', label: 'Open', icon: 'arrow-top-right' },
    { id: 'rename', label: 'Rename', icon: 'pencil-outline', shortcut: 'F2' },
    { id: 'duplicate', label: 'Duplicate', icon: 'content-copy' },
    { id: 'up', label: 'Move up', icon: 'arrow-up', shortcut: 'Alt ↑', disabled: position <= 0 },
    {
      id: 'down',
      label: 'Move down',
      icon: 'arrow-down',
      shortcut: 'Alt ↓',
      disabled: position === siblings.length - 1,
    },
    ...others.map((folder, index) => ({
      id: `move:${folder}`,
      label: folderLabel(folder),
      icon: 'folder-move-outline' as MdiIconName,
      heading: index === 0 ? 'MOVE TO' : undefined,
      separated: index === 0,
    })),
    { id: 'delete', label: 'Delete…', icon: 'delete-outline', danger: true, separated: true },
  ];
}
// Right-click (or Shift+F10, or the context menu key) on a row opens the same actions as its ⋯ menu.
type RowTarget =
  | { kind: 'collection' | 'folder'; folder: string }
  | { kind: 'request'; request: ApiRequest }
  /** Empty space in the explorer, below or between its rows. */
  | { kind: 'explorer' };
const {
  menu: contextMenu,
  target: contextTarget,
  open: openRowMenu,
  onKeydown: onRowMenuKeydown,
} = useContextMenu<RowTarget>();
const contextItems = computed<MenuItem[]>(() => {
  const target = contextTarget.value;
  if (!target) return [];
  if (target.kind === 'explorer') return explorerItems();
  if (target.kind === 'request') return requestItems(target.request);
  return target.kind === 'collection' ? collectionItems(target.folder) : folderItems(target.folder);
});
const contextLabel = computed(() => {
  const target = contextTarget.value;
  if (target?.kind === 'explorer') return 'Explorer actions';
  return target?.kind === 'request'
    ? `Actions for ${target.request.name}`
    : `Actions for ${target ? folderName(target.folder) : ''}`;
});
function onContextSelect(id: string): void {
  const target = contextTarget.value;
  if (target?.kind === 'explorer') onExplorerAction(id);
  else if (target?.kind === 'request') onRequestAction(target.request, id);
  else if (target?.kind === 'collection') onCollectionAction(target.folder, id);
  else if (target) onFolderAction(target.folder, id);
}
/** The explorer's own actions, as in its header, plus expanding or collapsing every collection. */
function explorerItems(): MenuItem[] {
  return [
    { id: 'new', label: 'New request', icon: 'plus' },
    { id: 'new-collection', label: 'New collection', icon: 'folder-plus-outline' },
    { id: 'import', label: 'Import…', icon: 'import' },
    { ...collapseItems()[0], disabled: !groups.value.length },
    { ...collapseItems()[1], disabled: !groups.value.length },
    { id: 'hide', label: 'Hide explorer', icon: 'chevron-left', shortcut: '⌘B', separated: true },
  ];
}
function onExplorerAction(id: string): void {
  if (id === 'new') void action('new');
  else if (id === 'new-collection') requests.createCollection();
  else if (id === 'import') dialogs.openTransfer('import');
  else if (id === 'expand' || id === 'collapse')
    for (const group of groups.value) setExpandedWithin(group.folder, id === 'expand');
  else if (id === 'hide') ui.toggleExplorer();
}
/** Right-clicks on a row open its own menu first; anywhere else in the explorer opens this one. */
function onExplorerContextMenu(event: MouseEvent): void {
  if (!event.defaultPrevented) openRowMenu(event, { kind: 'explorer' });
}
function onRequestAction(request: ApiRequest, id: string): void {
  if (id === 'open') requests.openRequest(request.id);
  else if (id === 'rename') ui.startRequestRename(request.id);
  else if (id === 'duplicate') {
    requests.openRequest(request.id);
    requests.duplicateRequest();
  } else if (id === 'up' || id === 'down') requests.shiftRequest(request.id, id === 'up' ? -1 : 1);
  else if (id === 'delete') void requests.deleteRequest(request.id);
  else if (id.startsWith('move:')) requests.moveRequest(request.id, id.slice(5));
}
function onRequestKeydown(event: KeyboardEvent, request: ApiRequest): void {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  event.preventDefault();
  requests.shiftRequest(request.id, event.key === 'ArrowUp' ? -1 : 1);
  void nextTick(() =>
    document.querySelector<HTMLElement>(`.request-item[data-open="${request.id}"]`)?.focus(),
  );
}

// Drag a request onto another request (to place it before or after), a collection, or a folder.
const REQUEST_TYPE = 'application/x-api-workbench-request';
const dragging = ref<string>();
const drop = ref<{ folder: string; beforeId?: string; afterId?: string }>();
function onDragStart(event: DragEvent, request: ApiRequest): void {
  dragging.value = request.id;
  event.dataTransfer?.setData(REQUEST_TYPE, request.id);
  event.dataTransfer?.setData('text/plain', request.name);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function onDragEnd(): void {
  dragging.value = undefined;
  drop.value = undefined;
}
function onDragOverRequest(event: DragEvent, request: ApiRequest): void {
  if (!dragging.value) return;
  event.preventDefault();
  event.stopPropagation();
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const after = event.clientY > box.top + box.height / 2;
  drop.value = after
    ? { folder: request.folder, afterId: request.id }
    : { folder: request.folder, beforeId: request.id };
}
function onDragOverFolder(event: DragEvent, folder: string): void {
  if (!dragging.value) return;
  event.preventDefault();
  // A folder inside a collection takes the drop, not the collection around it.
  event.stopPropagation();
  if (drop.value?.folder !== folder || drop.value.beforeId || drop.value.afterId)
    drop.value = { folder };
}
function onDrop(event: DragEvent): void {
  const id = dragging.value || event.dataTransfer?.getData(REQUEST_TYPE);
  const target = drop.value;
  onDragEnd();
  if (!id || !target) return;
  event.preventDefault();
  let beforeId = target.beforeId;
  if (target.afterId) {
    // After a request is before the one that follows it in the same folder.
    const siblings = workspace.state.requests.filter(
      (request) => request.folder === target.folder && request.id !== id,
    );
    beforeId = siblings[siblings.findIndex((request) => request.id === target.afterId) + 1]?.id;
  }
  requests.moveRequest(id, target.folder, beforeId);
}
function toggleFolder(folder: string): void {
  if (ui.collapsedFolders.has(folder)) ui.collapsedFolders.delete(folder);
  else ui.collapsedFolders.add(folder);
}
function finishRename(save: boolean, input: HTMLInputElement): void {
  const id = ui.renamingRequestId;
  if (!id) return;
  const request = workspace.state.requests.find((item) => item.id === id);
  ui.renamingRequestId = undefined;
  if (save && request && input.value.trim()) {
    request.name = input.value.trim();
    workspace.persist();
  }
  render();
  void nextTick(() =>
    document.querySelector<HTMLElement>(`.request-item[data-open="${id}"]`)?.focus(),
  );
}
// Collection and folder rename: Enter or leaving the field saves, Escape cancels; a taken name
// keeps editing. The field holds the folder's own name, not its path.
const folderRenameError = ref('');
/** The name as typed, so a refused name stays in the field to correct. */
const folderDraft = ref('');
watch(
  () => ui.renamingFolder,
  (folder) => {
    folderDraft.value = folder === undefined ? '' : folderName(folder);
    folderRenameError.value = '';
  },
);
function finishFolderRename(save: boolean, input: HTMLInputElement): void {
  const folder = ui.renamingFolder;
  if (folder === undefined) return;
  const name = input.value.trim();
  if (save && name && name !== folderName(folder)) {
    const error = requests.renameFolder(folder, name);
    if (error) {
      folderRenameError.value = error;
      // Leaving the field with a taken name gives it up rather than trapping focus.
      if (document.activeElement !== input) {
        ui.renamingFolder = undefined;
        folderRenameError.value = '';
        toast(error, 'error');
      }
      return;
    }
  }
  ui.renamingFolder = undefined;
  folderRenameError.value = '';
  render();
  const parent = parentFolder(folder);
  const renamed = save && name ? (parent === undefined ? name : joinFolder(parent, name)) : folder;
  void nextTick(() =>
    document.querySelector<HTMLElement>(`[data-folder-toggle="${CSS.escape(renamed)}"]`)?.focus(),
  );
}
function onFolderRenameKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  finishFolderRename(event.key === 'Enter', event.target as HTMLInputElement);
}
function onRenameKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  finishRename(event.key === 'Enter', event.target as HTMLInputElement);
}
</script>

<template>
  <aside ref="sidebar" class="sidebar" aria-label="Collection explorer">
    <div class="side-title">
      <div class="side-heading">
        <span class="eyebrow">EXPLORER</span>
        <h2>
          Collections <span class="count">{{ folderCount }}</span>
        </h2>
      </div>
      <div class="side-actions">
        <UiIconButton
          label="Import collection"
          icon="import"
          @click="dialogs.openTransfer('import')"
        />
        <UiIconButton
          label="New collection"
          icon="folder-plus-outline"
          data-new-collection
          @click="requests.createCollection()"
        />
        <UiIconButton label="New request" icon="plus" @click="action('new')" />
        <UiIconButton
          label="Hide explorer (⌘B)"
          icon="chevron-left"
          data-toggle-explorer
          @click="ui.toggleExplorer()"
        />
      </div>
    </div>
    <label class="search"
      ><MdiIcon name="magnify" /><input
        id="filter"
        v-model="ui.filter"
        aria-label="Filter collections"
        placeholder="Find a request, or #tag…"
    /></label>
    <TagFilterChips
      v-if="explorerTagCounts.length"
      class="explorer-tags"
      :counts="explorerTagCounts"
      :filter="ui.explorerTags"
      verb="show"
      :limit="6"
      data-explorer-tags
      @change="ui.explorerTags = $event"
    />
    <div class="side-section">
      <span>YOUR COLLECTIONS</span><span>{{ workspace.state.requests.length }} requests</span>
    </div>
    <div class="tree" data-explorer-tree @contextmenu="onExplorerContextMenu">
      <div
        v-for="group in groups"
        :key="group.folder"
        :class="[
          'collection-group',
          { 'drop-target': drop?.folder === group.folder && !drop.beforeId && !drop.afterId },
        ]"
        :data-collection="group.folder"
        @dragover="onDragOverFolder($event, group.folder)"
        @drop="onDrop"
      >
        <div
          v-if="ui.renamingFolder === group.folder"
          class="collection-folder-heading is-renaming"
        >
          <span class="folder-icon"><MdiIcon name="folder-outline" /></span
          ><input
            class="request-rename"
            :data-folder-rename="group.folder"
            aria-label="Rename collection"
            maxlength="120"
            :value="folderDraft"
            :aria-invalid="folderRenameError ? 'true' : undefined"
            :aria-describedby="folderRenameError ? 'folder-rename-error' : undefined"
            @input="
              folderDraft = ($event.target as HTMLInputElement).value;
              folderRenameError = '';
            "
            @keydown="onFolderRenameKeydown"
            @blur="finishFolderRename(true, $event.target as HTMLInputElement)"
          />
          <p
            v-if="folderRenameError"
            id="folder-rename-error"
            class="folder-rename-error"
            role="alert"
          >
            {{ folderRenameError }}
          </p>
        </div>
        <div v-else class="collection-folder-heading">
          <button
            class="folder"
            :data-folder-toggle="group.folder"
            :aria-expanded="group.expanded"
            title="Double-click or press F2 to rename"
            @click="toggleFolder(group.folder)"
            @dblclick.prevent="ui.startFolderRename(group.folder)"
            @keydown.f2.prevent="ui.startFolderRename(group.folder)"
            @keydown="onRowMenuKeydown($event, { kind: 'collection', folder: group.folder })"
            @contextmenu="openRowMenu($event, { kind: 'collection', folder: group.folder })"
          >
            <span class="folder-chevron"
              ><MdiIcon :name="group.expanded ? 'chevron-down' : 'chevron-right'" /></span
            ><span class="folder-icon"><MdiIcon name="folder-outline" /></span
            ><span>{{ group.folder }}</span
            ><span
              v-for="tag in folderEntry(workspace.state.collectionTags, group.folder) ?? []"
              :key="tag"
              class="folder-tag"
              >#{{ tag }}</span
            ><small>{{ group.count }}</small>
          </button>
          <UiIconButton
            :label="`HTTP settings for ${group.folder}`"
            icon="cog-outline"
            class="collection-http-settings"
            :data-collection-http-settings="group.folder"
            @click="httpSettings.openCollection(group.folder)"
          />
          <ActionMenu
            :label="`Actions for ${group.folder}`"
            trigger-class="collection-menu-trigger"
            :items="collectionItems(group.folder)"
            :data-collection-menu="group.folder"
            @select="onCollectionAction(group.folder, $event)"
          />
        </div>
        <div v-if="group.expanded" class="collection-requests">
          <template
            v-for="row in group.rows"
            :key="row.kind === 'folder' ? `folder:${row.path}` : row.request.id"
          >
            <template v-if="row.kind === 'folder'">
              <div
                v-if="ui.renamingFolder === row.path"
                class="collection-folder-heading nested-folder is-renaming"
                :style="{ '--depth': row.depth }"
              >
                <span class="folder-icon"><MdiIcon name="folder-outline" /></span
                ><input
                  class="request-rename"
                  :data-folder-rename="row.path"
                  aria-label="Rename folder"
                  maxlength="120"
                  :value="folderDraft"
                  :aria-invalid="folderRenameError ? 'true' : undefined"
                  :aria-describedby="folderRenameError ? 'folder-rename-error' : undefined"
                  @input="
                    folderDraft = ($event.target as HTMLInputElement).value;
                    folderRenameError = '';
                  "
                  @keydown="onFolderRenameKeydown"
                  @blur="finishFolderRename(true, $event.target as HTMLInputElement)"
                />
                <p
                  v-if="folderRenameError"
                  id="folder-rename-error"
                  class="folder-rename-error"
                  role="alert"
                >
                  {{ folderRenameError }}
                </p>
              </div>
              <div
                v-else
                :class="[
                  'collection-folder-heading',
                  'nested-folder',
                  { 'drop-target': drop?.folder === row.path && !drop.beforeId && !drop.afterId },
                ]"
                :style="{ '--depth': row.depth }"
                :data-folder="row.path"
                @dragover="onDragOverFolder($event, row.path)"
              >
                <button
                  class="folder"
                  :data-folder-toggle="row.path"
                  :aria-expanded="row.expanded"
                  title="Double-click or press F2 to rename"
                  @click="toggleFolder(row.path)"
                  @dblclick.prevent="ui.startFolderRename(row.path)"
                  @keydown.f2.prevent="ui.startFolderRename(row.path)"
                  @keydown="onRowMenuKeydown($event, { kind: 'folder', folder: row.path })"
                  @contextmenu="openRowMenu($event, { kind: 'folder', folder: row.path })"
                >
                  <span class="folder-chevron"
                    ><MdiIcon :name="row.expanded ? 'chevron-down' : 'chevron-right'" /></span
                  ><span class="folder-icon"><MdiIcon name="folder-outline" /></span
                  ><span class="truncate">{{ row.name }}</span
                  ><span
                    v-for="tag in folderEntry(workspace.state.collectionTags, row.path) ?? []"
                    :key="tag"
                    class="folder-tag"
                    >#{{ tag }}</span
                  ><small>{{ row.count }}</small>
                </button>
                <UiIconButton
                  :label="`HTTP settings for ${row.name}`"
                  icon="cog-outline"
                  class="collection-http-settings"
                  :data-folder-http-settings="row.path"
                  @click="httpSettings.openCollection(row.path)"
                />
                <ActionMenu
                  :label="`Actions for ${row.name}`"
                  trigger-class="collection-menu-trigger"
                  :items="folderItems(row.path)"
                  :data-folder-menu="row.path"
                  @select="onFolderAction(row.path, $event)"
                />
              </div>
            </template>
            <template v-else>
              <div
                v-if="ui.renamingRequestId === row.request.id"
                class="request-item is-renaming"
                :style="{ '--depth': row.depth }"
              >
                <span :class="['method', requestMethodClass(row.request)]"
                  ><MdiIcon :name="requestMethodIcon(row.request)" class="method-icon" />{{
                    requestMethodLabel(row.request)
                  }}</span
                ><input
                  class="request-rename"
                  :data-request-rename="row.request.id"
                  aria-label="Rename request"
                  maxlength="120"
                  :value="row.request.name"
                  @keydown="onRenameKeydown"
                  @blur="finishRename(true, $event.target as HTMLInputElement)"
                />
              </div>
              <div
                v-else
                :class="[
                  'collection-request-row',
                  {
                    dragging: dragging === row.request.id,
                    'drop-before': drop?.beforeId === row.request.id,
                    'drop-after': drop?.afterId === row.request.id,
                  },
                ]"
                :style="{ '--depth': row.depth }"
                draggable="true"
                :data-request-row="row.request.id"
                @dragstart="onDragStart($event, row.request)"
                @dragend="onDragEnd"
                @dragover="onDragOverRequest($event, row.request)"
              >
                <button
                  :class="['request-item', { active: isActive(row.request) }]"
                  :data-open="row.request.id"
                  title="Double-click or press F2 to rename"
                  :aria-current="isActive(row.request) ? 'true' : undefined"
                  @click="requests.openRequest(row.request.id)"
                  @dblclick.prevent="ui.startRequestRename(row.request.id)"
                  @keydown.f2.prevent="ui.startRequestRename(row.request.id)"
                  @keydown="
                    onRequestKeydown($event, row.request);
                    onRowMenuKeydown($event, { kind: 'request', request: row.request });
                  "
                  @contextmenu="openRowMenu($event, { kind: 'request', request: row.request })"
                >
                  <span :class="['method', requestMethodClass(row.request)]"
                    ><MdiIcon :name="requestMethodIcon(row.request)" class="method-icon" />{{
                      requestMethodLabel(row.request)
                    }}</span
                  ><span class="truncate">{{ row.request.name }}</span>
                </button>
                <UiIconButton
                  :label="`Delete ${row.request.name}`"
                  icon="delete-outline"
                  class="collection-request-delete"
                  :data-delete-collection-request="row.request.id"
                  @click.stop="requests.deleteRequest(row.request.id)"
                  @dblclick.stop
                />
                <ActionMenu
                  :label="`Actions for ${row.request.name}`"
                  trigger-class="request-menu-trigger"
                  :items="requestItems(row.request)"
                  @select="onRequestAction(row.request, $event)"
                />
              </div>
            </template>
          </template>
        </div>
      </div>
      <UiEmptyState
        v-if="!groups.length"
        class="tree-empty"
        icon="magnify"
        title="No matching requests"
        :description="
          tagFilterActive(ui.explorerTags)
            ? `No request ${ui.filter ? 'matching your search ' : ''}is tagged ${describeTagFilter(ui.explorerTags)}.`
            : 'Try a different name or URL.'
        "
      />
    </div>
    <div class="side-footer">
      <UiButton
        label="New request"
        icon="plus"
        shortcut="⌘ N"
        class="w-full justify-start"
        @click="action('new')"
      />
      <div class="local-note">
        <MdiIcon
          :name="workspaces.isTeam() ? 'account-group-outline' : 'shield-lock-outline'"
        /><span>{{
          workspaces.isTeam()
            ? 'Shared with your team. Secrets stay here.'
            : 'Stored locally. Always yours.'
        }}</span>
      </div>
    </div>
    <PaneResizer
      class="edge"
      direction="columns"
      label="Resize collection explorer"
      :value="width()"
      :min="PANE_SIZES.explorer.min"
      :max="PANE_SIZES.explorer.max"
      :reset="PANE_SIZES.explorer.initial"
      :step="20"
      :measure="measureWidth"
      @change="setWidth"
      @commit="ui.savePanelPreferences()"
    />
    <ContextMenu
      ref="contextMenu"
      :label="contextLabel"
      :items="contextItems"
      data-explorer-context-menu
      @select="onContextSelect"
    />
  </aside>
</template>
