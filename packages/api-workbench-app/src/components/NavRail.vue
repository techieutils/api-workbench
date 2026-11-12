<script setup lang="ts">
import { openView } from '../navigation';
import { useUiStore } from '../stores/ui';
import MdiIcon from './MdiIcon.vue';

const ui = useUiStore();
const navigation = [
  'Overview',
  'Collections',
  'APIs',
  'Mocks',
  'Environments',
  'Credentials',
  'Runner',
  'Interceptor',
  'History',
  'Cookies',
  'Documentation',
];
const icons: Record<string, MdiIconName> = {
  Overview: 'view-dashboard-outline',
  Collections: 'folder-outline',
  APIs: 'api',
  Mocks: 'server-network',
  Environments: 'layers-outline',
  Credentials: 'shield-key-outline',
  Runner: 'play-outline',
  Interceptor: 'radar',
  History: 'history',
  Cookies: 'cookie-outline',
  Documentation: 'file-document-outline',
  Settings: 'cog-outline',
};
const shortName = (name: string) =>
  name === 'Documentation' ? 'Docs' : name === 'Environments' ? 'Envs' : name;
function select(name: string): void {
  // Clicking the active Collections icon toggles the explorer, as in code editors.
  if (name === 'Collections' && ui.view === 'Collections') ui.toggleExplorer();
  else openView(name);
}
</script>

<template>
  <nav class="rail" aria-label="Main navigation">
    <button
      v-for="name in navigation"
      :key="name"
      :data-view="name"
      :class="{ active: ui.view === name }"
      :aria-current="ui.view === name ? 'page' : undefined"
      :title="name"
      :aria-label="name"
      @click="select(name)"
    >
      <span><MdiIcon :name="icons[name]" /></span><span>{{ shortName(name) }}</span>
    </button>
    <div class="rail-divider"></div>
    <button
      :class="['bottom', { active: ui.view === 'Settings' }]"
      data-view="Settings"
      title="Settings"
      :aria-current="ui.view === 'Settings' ? 'page' : undefined"
      @click="select('Settings')"
    >
      <span><MdiIcon :name="icons.Settings" /></span><span>Settings</span>
    </button>
  </nav>
</template>
