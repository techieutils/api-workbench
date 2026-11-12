<script setup lang="ts">
import { useWorkspacesStore } from '../stores/workspaces';
import { computed, ref } from 'vue';
import { usePopoverMenu } from '../composables/popover-menu';
import { openSettings, openView } from '../navigation';
import { useUpdatesStore } from '../stores/updates';
import { useVaultStore } from '../stores/vault';
import { useWorkspaceStore } from '../stores/workspace';
import { errorMessage, toast } from '../utils';
import MdiIcon from './MdiIcon.vue';

/**
 * "Private workspace" in the top bar, and the panel it opens: where this workspace's data lives,
 * how secrets are protected, what is remembered, and what leaves the device — from live state.
 */
const workspace = useWorkspaceStore();
const workspaces = useWorkspacesStore();
const team = computed(() => workspaces.isTeam());
const updates = useUpdatesStore();
const desktop = Boolean(window.workbench);
const canShowFolder = Boolean(window.workbench?.workspaces.reveal);

const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const popover = usePopoverMenu(trigger, panel, {
  place(element, rect) {
    element.style.top = `${rect.bottom + 8}px`;
    element.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
  },
});

/**
 * The vault's OS encryption, once the Credentials screen has checked it. The panel never asks
 * itself: on macOS that can show a Keychain prompt, which should only follow opening Credentials.
 */
const vaultStore = useVaultStore();
const vault = computed(() => vaultStore.status ?? undefined);
/** The OS store's everyday name, from what Electron reports (if known) and the platform. */
function storeName(backend = ''): string {
  if (/libsecret|gnome/i.test(backend)) return 'GNOME Keyring (Secret Service)';
  if (/kwallet/i.test(backend)) return 'KWallet';
  if (/Windows/i.test(navigator.userAgent)) return 'Windows DPAPI';
  if (/Mac/i.test(navigator.userAgent) || backend === 'Keychain') return 'macOS Keychain';
  return 'your system keyring';
}

const settings = computed(() => workspace.settings());
const rows = computed(() => {
  const config = settings.value;
  // Update checks contact GitHub only in a copy that can update itself, and not in "Only when I check".
  const checksUpdates =
    desktop &&
    updates.info?.status.state !== 'unsupported' &&
    updates.info?.preferences.mode !== undefined &&
    updates.info.preferences.mode !== 'off';
  return [
    team.value
      ? {
          key: 'storage',
          icon: 'folder-account-outline' as MdiIconName,
          title: 'Shared in a team folder',
          text: 'Collections, environments, specifications, mocks, and everyone’s history are files teammates can read. Secret values, tabs, and preferences stay on this device.',
          tone: 'warning',
        }
      : {
          key: 'storage',
          icon: 'laptop' as MdiIconName,
          title: 'Stored on this device',
          text: desktop
            ? 'Collections, environments, and history are files in this workspace’s folder. No account or cloud sync.'
            : 'Saved in this browser’s local storage. No account or cloud sync.',
          tone: 'success',
        },
    {
      key: 'secrets',
      icon: 'shield-key-outline' as MdiIconName,
      title: !desktop
        ? 'Credential vault in the desktop app'
        : !vault.value
          ? `Secrets encrypted with ${storeName()}`
          : vault.value.available
            ? `Secrets encrypted with ${storeName(vault.value.backend)}`
            : 'OS encryption unavailable',
      text: !desktop
        ? 'The browser build does not store secrets.'
        : vault.value && !vault.value.available
          ? 'Secrets are not saved until your system keyring is available. Nothing is stored as plain text.'
          : 'Saved credentials never leave the app’s main process; the interface only sees their names.',
      tone: desktop && vault.value && !vault.value.available ? 'warning' : 'success',
    },
    {
      key: 'history',
      icon: 'history' as MdiIconName,
      title: config.historyEnabled
        ? `History on, up to ${config.historyLimit} entries`
        : 'History off',
      text: config.persistResponses
        ? team.value
          ? 'Responses are saved with your history in the team folder, where teammates can read them.'
          : 'Responses are saved with history in the workspace file.'
        : team.value
          ? 'Your history is shared without responses; responses stay in memory.'
          : 'Responses stay in memory and are gone when you quit.',
      tone: config.persistResponses ? 'warning' : 'success',
    },
    {
      key: 'network',
      icon: 'access-point-network' as MdiIconName,
      title: 'No analytics or telemetry',
      text: checksUpdates
        ? 'Only the requests you send, and update checks to GitHub, leave this device.'
        : 'Only the requests you send leave this device.',
      tone: 'success',
    },
  ];
});

async function showFolder(): Promise<void> {
  popover.close();
  try {
    await window.workbench?.workspaces.reveal?.();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}
function vaultScreen(): void {
  popover.close();
  openView('Credentials');
}
function go(section: SettingsSection): void {
  popover.close();
  openSettings(section);
}
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="private-status"
    data-private-status
    aria-haspopup="dialog"
    :aria-expanded="popover.expanded.value"
    aria-controls="privacy-panel"
    title="What stays private, and where your data lives"
    @click="popover.toggle"
  >
    <MdiIcon :name="team ? 'account-group-outline' : 'shield-lock-outline'" /><span>{{
      team ? 'Team workspace' : 'Private workspace'
    }}</span>
  </button>
  <div
    id="privacy-panel"
    ref="panel"
    class="privacy-panel"
    popover="auto"
    role="dialog"
    aria-labelledby="privacy-panel-title"
    @keydown="popover.onMenuKeydown"
    @toggle="popover.onToggle"
  >
    <div class="privacy-panel-head">
      <span class="privacy-panel-mark"><MdiIcon name="shield-lock-outline" /></span>
      <div>
        <h2 id="privacy-panel-title">{{ team ? 'Team workspace' : 'Private workspace' }}</h2>
        <p>
          {{
            team
              ? `${settings.workspaceName} is shared through a folder; your secrets stay on this device.`
              : `${settings.workspaceName} stays on this device.`
          }}
        </p>
      </div>
    </div>
    <ul>
      <li v-for="row in rows" :key="row.key" :data-privacy-row="row.key" :data-tone="row.tone">
        <MdiIcon :name="row.icon" />
        <div>
          <strong>{{ row.title }}</strong>
          <span>{{ row.text }}</span>
        </div>
      </li>
    </ul>
    <div class="privacy-panel-actions">
      <button v-if="canShowFolder" type="button" data-privacy-folder @click="showFolder">
        <MdiIcon name="folder-open-outline" /><span>Workspace folder</span>
      </button>
      <button type="button" data-privacy-settings @click="go('Privacy')">
        <MdiIcon name="tune-variant" /><span>Privacy settings</span>
      </button>
      <button v-if="desktop" type="button" data-privacy-credentials @click="vaultScreen">
        <MdiIcon name="shield-key-outline" /><span>Credentials</span>
      </button>
    </div>
  </div>
</template>
