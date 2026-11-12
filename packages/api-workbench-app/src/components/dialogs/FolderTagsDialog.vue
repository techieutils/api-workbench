<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import {
  folderEntry,
  folderLabel,
  isWithin,
  parentFolder,
  setFolderEntry,
} from '@techieutils/api-workbench-common/folders';
import { inheritedTags } from '@techieutils/api-workbench-common/tags';
import { useRendered } from '../../composables/rendered';
import { render } from '../../shell';
import { useDialogsStore } from '../../stores/dialogs';
import { useWorkspaceStore } from '../../stores/workspace';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';
import TagEditor from '../editor/TagEditor.vue';

/**
 * A collection's or folder's tags, which every request inside it has too. Changes are saved as
 * they are made; Done (or Escape) closes the dialog and returns focus to where it was.
 */
const dialogs = useDialogsStore();
const workspace = useWorkspaceStore();
const dialog = ref<HTMLDialogElement>();
const returnFocus = document.activeElement as HTMLElement | null;

const view = useRendered(() => {
  const folder = dialogs.folderTags.folder;
  const parent = parentFolder(folder);
  return {
    folder,
    kind: parent === undefined ? 'collection' : 'folder',
    tags: [...(folderEntry(workspace.state.collectionTags, folder) ?? [])],
    inherited: parent === undefined ? [] : inheritedTags(workspace.state, parent),
    requests: workspace.state.requests.filter((request) => isWithin(request.folder, folder)).length,
  };
});
function change(tags: string[]) {
  const state = workspace.state;
  const all = { ...state.collectionTags };
  if (tags.length) setFolderEntry(all, view.value.folder, tags);
  else delete all[view.value.folder];
  if (Object.keys(all).length) state.collectionTags = all;
  else delete state.collectionTags;
  workspace.persist();
  render();
}
function close() {
  dialogs.folderTags.folder = '';
  render();
  void nextTick(() => returnFocus?.focus({ preventScroll: true }));
}
onMounted(() => dialog.value?.showModal());
</script>

<template>
  <dialog
    ref="dialog"
    class="confirm-dialog folder-tags-dialog"
    aria-labelledby="folder-tags-title"
    data-folder-tags-dialog
    @cancel.prevent="close"
  >
    <div class="confirm-dialog-icon default"><MdiIcon name="tag-multiple-outline" /></div>
    <div class="confirm-dialog-copy">
      <h2 id="folder-tags-title">Tags for “{{ folderLabel(view.folder) }}”</h2>
      <p>
        Every request in this {{ view.kind }} — {{ view.requests }} now — has these tags too, for
        finding requests and choosing what a run sends.
      </p>
      <TagEditor
        :tags="view.tags"
        :inherited="view.inherited"
        :owner="folderLabel(view.folder)"
        autofocus
        @change="change"
      />
    </div>
    <div class="confirm-dialog-actions">
      <UiButton label="Done" variant="primary" data-folder-tags-done @click="close" />
    </div>
  </dialog>
</template>
