<script setup lang="ts">
import CollectionExplorer from './components/CollectionExplorer.vue';
import CollectionTransfer from './components/dialogs/CollectionTransfer.vue';
import CommandPalette from './components/dialogs/CommandPalette.vue';
import ConfirmDialog from './components/dialogs/ConfirmDialog.vue';
import FolderTagsDialog from './components/dialogs/FolderTagsDialog.vue';
import ToastHost from './components/ToastHost.vue';
import ShortcutsDialog from './components/dialogs/ShortcutsDialog.vue';
import WorkspaceManager from './components/dialogs/WorkspaceManager.vue';
import WorkspaceSearch from './components/dialogs/WorkspaceSearch.vue';
import EnvironmentsPanel from './components/EnvironmentsPanel.vue';
import CookiesPanel from './components/screens/CookiesPanel.vue';
import CredentialDialog from './components/screens/CredentialDialog.vue';
import CredentialsPanel from './components/screens/CredentialsPanel.vue';
import ApiSpecsPanel from './components/screens/ApiSpecsPanel.vue';
import DocumentationPanel from './components/screens/DocumentationPanel.vue';
import MocksPanel from './components/screens/MocksPanel.vue';
import HistoryPanel from './components/screens/HistoryPanel.vue';
import InterceptorPanel from './components/screens/InterceptorPanel.vue';
import RunnerPanel from './components/screens/RunnerPanel.vue';
import NavRail from './components/NavRail.vue';
import OverviewPanel from './components/OverviewPanel.vue';
import RequestTabBar from './components/RequestTabBar.vue';
import RequestWorkspace from './components/RequestWorkspace.vue';
import SettingsPanel from './components/settings/SettingsPanel.vue';
import StatusBar from './components/StatusBar.vue';
import SuggestionList from './components/table/SuggestionList.vue';
import CodeGenerator from './components/tools/CodeGenerator.vue';
import DevToolsPanel from './components/devtools/DevToolsPanel.vue';
import TextContextMenu from './components/TextContextMenu.vue';
import { ref, watch } from 'vue';
import TopBar from './components/TopBar.vue';
import { useDialogsStore } from './stores/dialogs';
import { useWorkspacesStore } from './stores/workspaces';
import { useToolsStore } from './stores/tools';
import { useUiStore } from './stores/ui';
import { useVaultStore } from './stores/vault';
import { useMocksStore } from './stores/mocks';
import { useRequestsStore } from './stores/requests';
import { useWorkspaceStore } from './stores/workspace';

const ui = useUiStore();
// Dev tools stay mounted once opened, so closing the panel keeps its terminals running.
const devToolsMounted = ref(ui.devTools.open);
watch(
  () => ui.devTools.open,
  (open) => (devToolsMounted.value ||= open),
);
const tools = useToolsStore();
const vault = useVaultStore();
const dialogs = useDialogsStore();
const workspaces = useWorkspacesStore();
// The Collections screen always shows its request as a tab: after the last tab was closed, coming
// back (from the rail, the palette, or a saved session) reopens the active request rather than an
// editor under an empty tab bar.
const workspace = useWorkspaceStore();
const requests = useRequestsStore();
watch(
  () => [ui.view, workspace.state.tabs.length] as const,
  ([view, open]) => {
    if (view !== 'Collections' || open) return;
    const state = workspace.state;
    const id = state.requests.some((request) => request.id === state.active)
      ? state.active
      : state.requests[0]?.id;
    if (id) requests.openRequest(id);
  },
  { immediate: true },
);
// Mock servers keep running across reloads of the window; learn which are, and take their logs.
void useMocksStore().initialize();

function previewFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  void dialogs.previewFiles(Array.from(input.files || []));
}
</script>

<template>
  <TopBar />
  <div
    :class="['layout', { management: ui.management, 'explorer-collapsed': ui.explorerCollapsed }]"
    :style="ui.explorerWidth ? { '--explorer-width': `${ui.explorerWidth}px` } : undefined"
  >
    <NavRail />
    <CollectionExplorer />
    <main id="main-content" class="main">
      <RequestTabBar v-if="!ui.management" />
      <OverviewPanel v-if="ui.view === 'Overview'" />
      <SettingsPanel v-else-if="ui.view === 'Settings'" />
      <EnvironmentsPanel v-else-if="ui.view === 'Environments'" />
      <HistoryPanel v-else-if="ui.view === 'History'" />
      <InterceptorPanel v-else-if="ui.view === 'Interceptor'" />
      <CookiesPanel v-else-if="ui.view === 'Cookies'" />
      <CredentialsPanel v-else-if="ui.view === 'Credentials'" />
      <RunnerPanel v-else-if="ui.view === 'Runner'" />
      <DocumentationPanel v-else-if="ui.view === 'Documentation'" />
      <ApiSpecsPanel v-else-if="ui.view === 'APIs'" />
      <MocksPanel v-else-if="ui.view === 'Mocks'" />
      <RequestWorkspace />
    </main>
    <DevToolsPanel v-if="devToolsMounted" />
  </div>
  <StatusBar />
  <input
    id="import-file"
    class="file-input"
    type="file"
    accept=".json,.yaml,.yml,.bru,.wsdl,.wdsl,.xml,.har,.http,.rest,.curl,.sh,.txt,.zip"
    multiple
    @change="previewFiles"
  />
  <input
    id="import-directory"
    class="file-input"
    type="file"
    webkitdirectory
    multiple
    @change="previewFiles"
  />
  <div v-if="tools.codeDialog && !tools.codeDialog.docked" class="modal-backdrop codegen-backdrop">
    <CodeGenerator />
  </div>
  <!-- Mounted per open draft, so the dialog's setup always has one. -->
  <CredentialDialog v-if="vault.draft" />
  <WorkspaceSearch v-if="dialogs.search.open" />
  <CommandPalette v-if="dialogs.palette.open" />
  <CollectionTransfer v-if="dialogs.transfer.mode" />
  <WorkspaceManager v-if="workspaces.manager.open" />
  <SuggestionList />
  <FolderTagsDialog v-if="dialogs.folderTags.folder" />
  <ConfirmDialog />
  <ShortcutsDialog v-if="ui.shortcutsOpen" />
  <TextContextMenu />
  <ToastHost />
</template>
