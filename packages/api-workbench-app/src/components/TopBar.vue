<script setup lang="ts">
import { useWorkspaceStore } from '../stores/workspace';
import { useDialogsStore } from '../stores/dialogs';
import { useWorkspacesStore } from '../stores/workspaces';
import { computed } from 'vue';
import { openView } from '../navigation';
import MdiIcon from './MdiIcon.vue';
import PrivacyStatus from './PrivacyStatus.vue';

const dialogs = useDialogsStore();
const workspaces = useWorkspacesStore();
const workspace = useWorkspaceStore();
// workspace.settings() reads the workspace document, so this tracks it.
const workspaceName = computed(() => workspace.settings().workspaceName);
// Teammates with this team workspace open, and where they are.
const others = computed(() => workspaces.team.others);
const presenceLabel = computed(
  () =>
    `Here now: ${others.value
      .map((presence) =>
        presence.requestName
          ? `${presence.member.name} (on ${presence.requestName})`
          : presence.member.name,
      )
      .join(', ')}`,
);
</script>

<template>
  <header class="topbar">
    <div class="brand-lockup">
      <img
        class="theme-art-dark"
        src="assets/branding/app-icon-dark.png"
        width="30"
        height="30"
        alt=""
      /><img
        class="theme-art-light"
        src="assets/branding/app-icon-light.png"
        width="30"
        height="30"
        alt=""
      /><span class="brand">API <span class="brand-name">Workbench</span></span
      ><span class="version-tag">DESKTOP</span>
    </div>
    <span class="top-separator"></span>
    <button
      class="workspace"
      :title="`${workspaceName} · Switch or manage workspaces`"
      aria-haspopup="dialog"
      @click="workspaces.open()"
    >
      <MdiIcon
        v-if="workspaces.isTeam()"
        name="account-group-outline"
        class="workspace-team-icon"
      /><span class="workspace-name">{{ workspaceName }}</span
      ><MdiIcon name="chevron-down" />
    </button>
    <button
      v-if="others.length"
      type="button"
      class="team-presence"
      data-team-presence
      :aria-label="presenceLabel"
      :title="presenceLabel"
      aria-haspopup="dialog"
      @click="workspaces.open()"
    >
      <span
        v-for="presence in others.slice(0, 3)"
        :key="presence.member.id"
        class="team-avatar"
        aria-hidden="true"
        >{{ workspaces.initials(presence.member.name) }}</span
      ><span v-if="others.length > 3" class="team-avatar team-avatar-more" aria-hidden="true"
        >+{{ others.length - 3 }}</span
      >
    </button>
    <button
      class="top-search"
      aria-label="Search workspace"
      aria-haspopup="dialog"
      @click="dialogs.openSearch()"
    >
      <MdiIcon name="magnify" /><span>Search your workspace…</span><kbd>⌘ K</kbd>
    </button>
    <PrivacyStatus />
    <button
      class="avatar"
      data-view="Settings"
      aria-label="Workspace settings"
      @click="openView('Settings')"
    >
      AW
    </button>
  </header>
</template>
