<script setup lang="ts">
import RequestTypeSelect from './RequestTypeSelect.vue';
import { computed } from 'vue';
import { useRendered } from '../../composables/rendered';
import { render } from '../../shell';
import { action } from '../../actions';
import { useRequestRowsStore } from '../../stores/request-rows';
import { useHTTPSettingsStore } from '../../stores/http-settings';
import { useRunnerStore } from '../../stores/runner';
import { useUiStore } from '../../stores/ui';
import { useWorkspaceStore } from '../../stores/workspace';
import { useWorkspacesStore } from '../../stores/workspaces';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiTabs from '../ui/UiTabs.vue';
import RequestHeading from './RequestHeading.vue';
import AuthenticationPanel from './auth/AuthenticationPanel.vue';
import HTTPSettingsForm from './HTTPSettingsForm.vue';
import RequestBody from './RequestBody.vue';
import RequestCaptures from './RequestCaptures.vue';
import RequestRowsTab from './RequestRowsTab.vue';
import RequestTests from './RequestTests.vue';
import RequestScripts from './RequestScripts.vue';
import { useScriptsStore } from '../../stores/scripts';
import { allScriptSteps } from '@techieutils/api-workbench-common/scripts';
const rows = useRequestRowsStore();

/** The HTTP request composer: URL bar, variable status, and configuration tabs. */
const ui = useUiStore();
const httpSettings = useHTTPSettingsStore();
const workspace = useWorkspaceStore();
const runner = useRunnerStore();
const scripts = useScriptsStore();
const workspaces = useWorkspacesStore();
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
const environmentName = computed(
  () => workspace.state.environments[workspace.state.environment].name,
);
// The runner and unsaved HTTP settings drafts are not reactive yet.
const sending = computed(() => ui.busy && !runner.run.running);
const tabs = useRendered((): UITab[] => [
  { name: 'Params', count: request().params.length, icon: 'tune-variant' },
  { name: 'Headers', count: request().headers.length, icon: 'swap-horizontal' },
  { name: 'Body', icon: 'code-tags' },
  { name: 'Auth', icon: 'shield-key-outline' },
  { name: 'Tests', icon: 'check-circle-outline' },
  {
    name: 'Scripts',
    icon: 'language-javascript',
    // Paused scripts say so on the tab, so they are noticed before a send fails.
    count: scripts.requestPaused(request())
      ? 'Paused'
      : allScriptSteps(workspace.state, request()).length || undefined,
  },
  { name: 'Vars', count: request().captures?.length || undefined, icon: 'variable' },
  {
    name: 'Settings',
    icon: 'cog-outline',
    count: httpSettings.hasDraft(workspaces.manager.id, request()) ? 'Unsaved' : undefined,
  },
]);
const unresolved = computed(() => rows.unresolvedVariables(request()));

function setURL(event: Event): void {
  request().url = (event.target as HTMLInputElement).value;
  workspace.persist();
}
function selectTab(name: string): void {
  ui.requestTab = name;
  if (name === 'Settings') httpSettings.scope = 'request';
  render();
}
</script>

<template>
  <section class="editor">
    <RequestHeading>
      <UiButton
        label="Code"
        icon="code-tags"
        variant="ghost"
        data-action="code"
        :aria-pressed="String(ui.requestPanels.code)"
        @click="action('code')"
      /><UiIconButton
        label="Duplicate request"
        icon="content-copy"
        @click="action('duplicate')"
      /><UiIconButton
        label="Delete request"
        icon="delete-outline"
        @click="action('delete-request')"
      />
    </RequestHeading>
    <div class="request-composer">
      <div class="urlbar">
        <RequestTypeSelect />
        <input
          id="url"
          :value="request().url"
          placeholder="https://api.example.com/resource"
          aria-label="Request URL"
          spellcheck="false"
          @input="setURL"
        />
        <UiButton
          :label="sending ? 'Cancel' : 'Send'"
          :title="sending ? 'Cancel' : 'Send (⌘/Ctrl + Enter)'"
          :icon="sending ? 'close' : 'arrow-top-right'"
          variant="primary"
          class="send"
          data-action="send"
          @click="action('send')"
        />
      </div>
      <div class="composer-hint">
        <span
          ><MdiIcon name="layers-outline" /> Variables resolve from
          <strong>{{ environmentName }}</strong></span
        >
        <span id="composer-variables" role="status">
          <template v-if="!unresolved.length"
            ><MdiIcon name="check-circle-outline" /><span
              >All variables resolved · <code v-text="'{{$guid}}'"></code> and other dynamic values
              available</span
            ></template
          >
          <span
            v-else
            class="variable-warning"
            :title="`Define these in ${environmentName} or capture them from an earlier response`"
            ><MdiIcon name="close-circle-outline" />{{ unresolved.length }} unresolved:
            <template v-for="name in unresolved.slice(0, 4)" :key="name"
              ><code v-text="`{{${name}}}`"></code>
            </template>
            <template v-if="unresolved.length > 4">+{{ unresolved.length - 4 }}</template></span
          >
        </span>
      </div>
    </div>
    <UiTabs
      group="request"
      label="Request configuration"
      :items="tabs"
      :active="ui.requestTab"
      attribute="data-request-tab"
      class="request-tabs"
      @select="selectTab"
    />
    <div
      id="request-panel"
      class="request-config"
      role="tabpanel"
      :aria-labelledby="`request-tab-${ui.requestTab.toLowerCase()}`"
    >
      <RequestTests v-if="ui.requestTab === 'Tests'" />
      <RequestScripts v-else-if="ui.requestTab === 'Scripts'" />
      <HTTPSettingsForm v-else-if="ui.requestTab === 'Settings'" />
      <AuthenticationPanel v-else-if="ui.requestTab === 'Auth'" />
      <RequestCaptures v-else-if="ui.requestTab === 'Vars'" />
      <RequestRowsTab
        v-else-if="ui.requestTab === 'Params' || ui.requestTab === 'Headers'"
        :type="ui.requestTab === 'Params' ? 'params' : 'headers'"
      />
      <RequestBody v-else-if="ui.requestTab === 'Body'" />
    </div>
  </section>
</template>
