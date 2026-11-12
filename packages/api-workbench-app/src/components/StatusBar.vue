<script setup lang="ts">
import { useWorkspacesStore } from '../stores/workspaces';
import { useDialogsStore } from '../stores/dialogs';
import { computed } from 'vue';
import { useUiStore } from '../stores/ui';
import { useUpdatesStore } from '../stores/updates';
import { useWorkspaceStore } from '../stores/workspace';
import { action } from '../actions';
import MdiIcon from './MdiIcon.vue';
import PaneLayoutMenu from './PaneLayoutMenu.vue';
import PaneToggleMenu from './PaneToggleMenu.vue';

const dialogs = useDialogsStore();
const ui = useUiStore();
const workspace = useWorkspaceStore();
const workspaces = useWorkspacesStore();
const updates = useUpdatesStore();
const version = computed(() => updates.info?.currentVersion ?? '1.0.0');
/** A new version found, downloading, or downloaded and waiting for a restart. */
const pending = computed(() => {
  const status = updates.info?.status;
  if (status?.state === 'available') return `Version ${status.version} is available`;
  if (status?.state === 'downloading')
    return `Downloading version ${status.version} (${status.percent}%)`;
  if (status?.state === 'downloaded') return `Version ${status.version} is ready to install`;
  return '';
});
const environmentName = computed(
  () => workspace.state.environments[workspace.state.environment]?.name,
);
</script>

<template>
  <footer class="footer">
    <span class="online"><MdiIcon name="circle" /></span
    ><span>{{ workspaces.isTeam() ? 'Team workspace' : 'Local workspace' }}</span
    ><span class="footer-divider"></span
    ><span><MdiIcon name="layers-outline" />{{ environmentName }}</span>
    <template v-if="ui.view === 'Collections'">
      <span class="footer-divider"></span>
      <PaneLayoutMenu />
      <PaneToggleMenu />
    </template>
    <!-- With changes waiting, the save state is a button that saves them now. -->
    <button
      v-if="workspace.unsaved && !ui.busy"
      id="save-status"
      type="button"
      class="right footer-command is-unsaved"
      data-save-now
      title="Save the workspace now (⌘ S)"
      @click="action('save')"
    >
      <MdiIcon name="content-save-outline" /><span>{{ ui.saveState }}</span
      ><kbd>⌘ S</kbd>
    </button>
    <span v-else id="save-status" class="right">{{
      ui.busy ? 'Sending request…' : ui.saveState
    }}</span
    ><span class="footer-divider"></span>
    <button
      type="button"
      class="footer-command"
      data-open-palette
      title="Open command palette"
      @click="dialogs.openPalette()"
    >
      <MdiIcon name="lightning-bolt-outline" /><span>Commands</span><kbd>⌘ ⇧ P</kbd>
    </button>
    <span class="footer-divider"></span>
    <button
      type="button"
      class="footer-command"
      data-open-shortcuts
      title="Keyboard shortcuts (?)"
      @click="ui.shortcutsOpen = true"
    >
      <MdiIcon name="keyboard-outline" /><span>Shortcuts</span><kbd>?</kbd>
    </button>
    <span class="footer-divider"></span>
    <button
      type="button"
      :class="['footer-command', { active: ui.devTools.open }]"
      data-dev-tools-toggle
      title="Dev tools: console, network, performance, and terminal (⌘ J)"
      aria-controls="dev-tools-panel"
      :aria-expanded="ui.devTools.open"
      @click="ui.toggleDevTools()"
    >
      <MdiIcon name="tools" /><span>Dev tools</span
      ><span
        v-if="!ui.devTools.open && ui.liveTerminals"
        class="footer-badge"
        data-dev-tools-terminals
        :title="`${ui.liveTerminals} terminal${ui.liveTerminals === 1 ? '' : 's'} running`"
        ><MdiIcon name="console" />{{ ui.liveTerminals }}</span
      ><kbd>⌘ J</kbd>
    </button>
    <span class="footer-divider"></span><span class="font-mono">⌘ ↵ to send</span
    ><button
      type="button"
      :class="['version-label', { 'update-pending': pending }]"
      data-version-button
      :data-update-pending="pending ? '' : undefined"
      :aria-busy="updates.checking"
      :title="pending || (updates.checking ? 'Checking for updates…' : 'Check for updates')"
      :aria-label="`v${version}. ${pending || 'Check for updates'}`"
      @click="updates.report()"
    >
      v{{ version }}<span v-if="pending" class="update-dot" aria-hidden="true"></span>
    </button>
  </footer>
</template>
