<script setup lang="ts">
import { withIcons } from '../../select-options';
import { FOLDER_SEPARATOR } from '@techieutils/api-workbench-common/folders';
import { render } from '../../shell';
import { action } from '../../actions';
import { useWorkspaceStore } from '../../stores/workspace';
import { useWorkspacesStore } from '../../stores/workspaces';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';
import UiSelect from '../ui/UiSelect.vue';
import RequestTags from './RequestTags.vue';

/** Breadcrumb, editable name, environment, and the page's actions; the type is in the URL bar. */
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
const workspace = useWorkspaceStore();
const workspaces = useWorkspacesStore();
/** In a team workspace, the teammates on this request, so you know before you both edit it. */
const here = () => workspaces.othersOn(request().id).map((presence) => presence.member.name);

function rename(event: FocusEvent): void {
  request().name = (event.target as HTMLElement).textContent?.trim() || 'Untitled request';
  workspace.persist();
}
function setEnvironment(event: Event): void {
  workspace.state.environment = Number((event.target as HTMLSelectElement).value);
  workspace.persist();
  render();
}
</script>

<template>
  <div class="request-heading">
    <div class="request-heading-title">
      <div class="breadcrumb">
        <span>Collections</span
        ><template v-for="(segment, index) in request().folder.split(FOLDER_SEPARATOR)" :key="index"
          ><MdiIcon name="chevron-right" /><span>{{ segment }}</span></template
        >
      </div>
      <div class="request-title-row">
        <h1
          id="request-name"
          contenteditable="true"
          role="textbox"
          aria-label="Request name"
          spellcheck="false"
          :textContent="request().name"
          @blur="rename"
        ></h1>
        <span
          v-if="here().length"
          class="request-presence"
          role="status"
          data-request-presence
          :title="`${here().join(', ')} ${here().length === 1 ? 'has' : 'have'} this request open`"
          ><MdiIcon name="eye-outline" />{{
            here().length === 1 ? here()[0] : `${here().length} teammates`
          }}
          {{ here().length === 1 ? 'is' : 'are' }} here</span
        >
      </div>
      <RequestTags />
    </div>
    <div class="actions">
      <label class="environment-control"
        ><span class="environment-dot"><MdiIcon name="circle" /></span
        ><UiSelect
          id="environment"
          class="environment"
          aria-label="Active environment"
          @change="setEnvironment"
          :value="String(workspace.state.environment)"
          :options="
            withIcons(
              workspace.state.environments.map((environment, index) => ({
                value: String(index),
                label: environment.name,
              })),
              'layers-outline',
            )
          " /></label
      ><span class="action-divider"></span><slot /><UiButton
        label="Save"
        icon="content-save-outline"
        class="save-button"
        data-action="save"
        @click="action('save')"
      />
    </div>
  </div>
</template>
