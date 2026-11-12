import { createPinia, setActivePinia } from 'pinia';
import { createApp, type App as VueApp } from 'vue';
import App from './App.vue';
import { endInlineEditing } from './components/table/cell-editing';
import { useProtocolsStore } from './stores/protocols';
import { useRequestsStore } from './stores/requests';
import { useSettingsStore } from './stores/settings';
import { useToolsStore } from './stores/tools';
import { useUiStore } from './stores/ui';
import { useWorkspaceStore } from './stores/workspace';

export const pinia = createPinia();
setActivePinia(pinia);

let app: VueApp | undefined;
/** Mounts the shell into #app, replacing the startup screen. Safe to call more than once. */
export function mount(): void {
  if (app) return;
  app = createApp(App).use(pinia);
  app.mount('#app');
}

/**
 * Applies a change to the workspace document everywhere it shows. The document is mutated in
 * place, so components that read it re-render through the workspace store's refresh(); this also
 * applies appearance preferences and keeps the URL and docked code in step with the request.
 */
export function render(): void {
  const workspace = useWorkspaceStore();
  if (useUiStore().view === 'Collections') useRequestsStore().syncRequestQuery(workspace.current());
  endInlineEditing();
  useSettingsStore().applyPreferences();
  mount();
  workspace.refresh();
  useProtocolsStore().bindProtocols();
  useToolsStore().scheduleDockedCodeGeneration();
}
