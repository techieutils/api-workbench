<script setup lang="ts">
import { inheritedTags } from '@techieutils/api-workbench-common/tags';
import { useRendered } from '../../composables/rendered';
import { render } from '../../shell';
import { useWorkspaceStore } from '../../stores/workspace';
import TagEditor from './TagEditor.vue';

/**
 * A request's tags under its name: its own, which can be changed here, after the ones it has from
 * its collection and folders. Tags choose what collection runs send.
 */
const workspace = useWorkspaceStore();
const request = () => workspace.current();
const view = useRendered(() => ({
  id: request().id,
  tags: [...(request().tags ?? [])],
  inherited: inheritedTags(workspace.state, request().folder),
}));
function change(tags: string[]) {
  const current = request();
  if (tags.length) current.tags = tags;
  else delete current.tags;
  workspace.persist();
  render();
}
</script>

<template>
  <TagEditor
    :key="view.id"
    :tags="view.tags"
    :inherited="view.inherited"
    owner="Request"
    @change="change"
  />
</template>
