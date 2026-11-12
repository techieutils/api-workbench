<script setup lang="ts">
import { collectionOf } from '@techieutils/api-workbench-common/folders';
import { computed, ref, watch } from 'vue';
import type { WorkspaceLocationChoice } from '@techieutils/api-workbench-common/types';
import { useRendered } from '../../composables/rendered';
import { useWorkspacesStore } from '../../stores/workspaces';
import { useWorkspaceStore } from '../../stores/workspace';
import MdiIcon from '../MdiIcon.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import TeamGitPanel from './TeamGitPanel.vue';
import { useContextMenu } from '../../composables/context-menu';

/**
 * Create, rename, switch, and delete workspaces: those stored on this device, and team workspaces
 * that live in a shared folder.
 */
const store = useWorkspacesStore();
const manager = store.manager;
const team = store.team;
const desktopTeams = Boolean(window.workbench?.workspaces.openTeamFolder);
const gitSync = Boolean(window.workbench?.workspaces.git);
const gitClone = Boolean(window.workbench?.workspaces.cloneTeam);
function setCloneURL(event: Event): void {
  store.setCloneURL((event.target as HTMLInputElement).value);
}
const workspace = useWorkspaceStore();
// Live sessions and credential operations are not all reactive, so this follows each render.
const lockReason = useRendered(() => store.lockReason());
const locked = computed(() => manager.busy || manager.loading || Boolean(lockReason.value));
const notice = computed(() => manager.error || lockReason.value);
const count = computed(() => manager.index.workspaces.length);
const items = computed(() => {
  const query = manager.query.trim().toLocaleLowerCase();
  return manager.index.workspaces
    .filter((item) => item.name.toLocaleLowerCase().includes(query))
    .sort(
      (a, b) =>
        Number(b.id === manager.id) - Number(a.id === manager.id) ||
        (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    );
});
const item = computed(() =>
  manager.index.workspaces.find((entry) => entry.id === manager.selectedId),
);
const creating = computed(() => manager.mode === 'create');
/** The desktop app saves workspaces to folders, so a new one can go somewhere of its own. */
const chooseLocation = Boolean(window.workbench?.workspaces.storage);
watch(creating, (now) => {
  if (now && chooseLocation) void store.loadStorage();
});
/** Where a new workspace can be saved: the default folder, app data, or one chosen now. */
const locationOptions = (): {
  value: WorkspaceLocationChoice;
  label: string;
  detail: string;
  icon: MdiIconName;
}[] => {
  const info = store.storage.info;
  const folder = info?.storageFolder && !info.storageProblem ? info.storageFolder : undefined;
  return [
    {
      value: 'default',
      label: folder ? 'Default folder' : 'App data (default)',
      detail: `${folder ?? info?.appData ?? 'The app’s data folder'} · set in Settings → Saving`,
      icon: 'folder-outline',
    },
    ...(folder
      ? [
          {
            value: 'app-data' as const,
            label: 'App data',
            detail: info?.appData ?? 'The app’s data folder',
            icon: 'database-outline' as MdiIconName,
          },
        ]
      : []),
    {
      value: 'choose',
      label: 'Choose a folder…',
      detail: 'Asked when you create it; the workspace gets a folder of its own there',
      icon: 'folder-search-outline',
    },
  ];
};
const editing = computed(
  () => creating.value || (manager.mode === 'rename' && Boolean(item.value)),
);
const isCurrent = computed(() => item.value?.id === manager.id);
/** A team workspace's folder, shortened to its last two parts for lists. */
const folderLabel = (folder: string) => folder.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
function setMemberName(event: Event): void {
  store.setMemberName((event.target as HTMLInputElement).value);
}
const saveDisabled = computed(
  () =>
    locked.value ||
    Boolean(store.nameError(manager.draftName)) ||
    (!creating.value && manager.draftName.trim() === item.value?.name),
);
const metrics = computed(() => {
  const state = workspace.state;
  return [
    { value: state.requests.length, label: 'Requests', icon: 'console-network-outline' },
    {
      value: new Set(state.requests.map((request) => collectionOf(request.folder))).size,
      label: 'Collections',
      icon: 'folder-outline',
    },
    { value: state.environments.length, label: 'Environments', icon: 'layers-outline' },
  ] as const;
});
const initials = (name: string) => store.initials(name);
const date = (value: string) => store.formatDate(value);

const search = ref<HTMLInputElement>();
function setQuery(event: Event): void {
  manager.query = (event.target as HTMLInputElement).value;
}
function clearSearch(): void {
  manager.query = '';
  search.value?.focus();
}
function setDraft(event: Event): void {
  manager.draftName = (event.target as HTMLInputElement).value;
  manager.nameError = '';
}
const input = ref<HTMLInputElement>();
function submit(): void {
  store.submitName(input.value!.value);
}
const edit = (mode: 'details' | 'create' | 'rename' | 'delete' | 'team', id?: string) =>
  store.edit(mode, id);
function requestDelete(id: string): void {
  if (id !== manager.id) edit('delete', id);
}
const refresh = () => void store.refresh();

// A workspace's context menu, with the same actions as its row and details.
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<string>();
const menuItems = computed<MenuItem[]>(() => {
  const current = menuFor.value === manager.id;
  return [
    { id: 'details', label: 'Show details', icon: 'information-outline', disabled: manager.busy },
    { id: 'rename', label: 'Rename', icon: 'pencil-outline', disabled: locked.value },
    {
      id: 'switch',
      label: current ? 'Current workspace' : 'Switch to this workspace',
      icon: 'arrow-top-right',
      disabled: current || locked.value,
    },
    {
      id: 'delete',
      label: manager.index.workspaces.find((entry) => entry.id === menuFor.value)?.folder
        ? 'Leave team workspace'
        : 'Delete workspace',
      icon: 'delete-outline',
      danger: true,
      separated: true,
      disabled: current || locked.value,
    },
  ];
});
function onMenuSelect(command: string): void {
  const id = menuFor.value;
  if (!id) return;
  if (command === 'details') edit('details', id);
  else if (command === 'rename') edit('rename', id);
  else if (command === 'switch') store.select(id);
  else if (command === 'delete') requestDelete(id);
}

const dialog = ref<HTMLElement>();
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (manager.mode !== 'details') edit('details');
    else store.close();
  } else if (event.key === 'Tab') {
    const targets = Array.from(
      dialog.value!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
    );
    const first = targets[0],
      last = targets.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}
</script>

<template>
  <div class="modal-backdrop">
    <section
      ref="dialog"
      class="modal workspace-manager"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-manager-title"
      aria-describedby="workspace-manager-description"
      :aria-busy="manager.busy || manager.loading"
      @keydown="onKeydown"
    >
      <div class="modal-heading workspace-manager-heading">
        <div>
          <span class="eyebrow">YOUR LOCAL WORKSPACES</span>
          <h2 id="workspace-manager-title">A space for every project</h2>
          <p id="workspace-manager-description" class="field-help">
            Manage your collections, environments, and credentials in separate workspaces.
          </p>
        </div>
        <div class="workspace-heading-actions">
          <UiIconButton
            label="Refresh workspaces"
            icon="refresh"
            data-workspace-refresh
            :disabled="manager.busy || manager.loading"
            @click="refresh"
          /><UiIconButton
            label="Close workspaces"
            icon="close"
            data-workspace-close
            :disabled="manager.busy"
            @click="store.close()"
          />
        </div>
      </div>
      <div
        v-if="notice && manager.error"
        id="workspace-manager-error"
        class="workspace-manager-notice is-error"
        role="alert"
        tabindex="-1"
      >
        <MdiIcon name="close-circle-outline" /><span>{{ notice }}</span>
      </div>
      <div v-else-if="notice" class="workspace-manager-notice" role="status">
        <MdiIcon name="timer-outline" /><span>{{ notice }}</span>
      </div>
      <div v-if="manager.busy || manager.loading" class="workspace-operation-status" role="status">
        <span class="workspace-progress" aria-hidden="true"></span
        >{{ manager.loading ? 'Loading workspaces…' : manager.pendingLabel }}
      </div>
      <div class="workspace-manager-content">
        <aside class="workspace-sidebar">
          <div class="workspace-list-heading">
            <strong
              >Workspaces <span>{{ count }}</span></strong
            ><span class="workspace-list-actions"
              ><UiButton
                v-if="desktopTeams"
                label="Team"
                icon="account-group-outline"
                variant="ghost"
                data-workspace-team
                :aria-pressed="manager.mode === 'team'"
                :disabled="locked"
                @click="edit('team')" /><UiButton
                label="New"
                icon="plus"
                variant="ghost"
                data-workspace-new
                :disabled="locked"
                @click="edit('create')"
            /></span>
          </div>
          <label class="workspace-search" for="workspace-search"
            ><MdiIcon name="magnify" /><input
              id="workspace-search"
              ref="search"
              type="search"
              placeholder="Find a workspace…"
              aria-label="Search workspaces"
              autocomplete="off"
              :value="manager.query"
              :disabled="manager.busy"
              @input="setQuery"
          /></label>
          <nav id="workspace-list" class="workspace-list" aria-label="Workspaces">
            <div
              v-for="entry in items"
              :key="entry.id"
              :class="[
                'workspace-list-row',
                { 'is-selected': entry.id === manager.selectedId && !creating },
              ]"
              :data-workspace-row="entry.id"
              @contextmenu="openMenu($event, entry.id)"
              @keydown="onRowKeydown($event, entry.id)"
            >
              <button
                type="button"
                class="workspace-choice"
                :title="entry.name"
                :data-workspace-inspect="entry.id"
                :aria-pressed="entry.id === manager.selectedId && !creating"
                :disabled="manager.busy"
                @click="edit('details', entry.id)"
              >
                <span class="workspace-avatar workspace-avatar-small" aria-hidden="true">{{
                  initials(entry.name)
                }}</span
                ><span class="workspace-choice-copy"
                  ><strong>{{ entry.name }}</strong
                  ><small v-if="entry.id === manager.id"
                    ><span class="workspace-current-dot"></span> Current workspace</small
                  ><small v-else-if="entry.folder"
                    ><MdiIcon name="account-group-outline" /> Team ·
                    {{ folderLabel(entry.folder) }}</small
                  ><small v-else-if="entry.location"
                    ><MdiIcon name="folder-outline" /> {{ folderLabel(entry.location) }}</small
                  ><small v-else>Updated {{ date(entry.updatedAt) }}</small></span
                >
              </button>
              <div class="workspace-row-actions">
                <UiIconButton
                  :label="`Rename ${entry.name}`"
                  icon="pencil-outline"
                  :data-workspace-rename="entry.id"
                  :disabled="locked"
                  @click="edit('rename', entry.id)"
                /><UiIconButton
                  v-if="entry.id !== manager.id"
                  :label="`Switch to ${entry.name}`"
                  icon="arrow-top-right"
                  :data-workspace-select="entry.id"
                  :disabled="locked"
                  @click="store.select(entry.id)"
                />
              </div>
            </div>
            <UiEmptyState
              v-if="!items.length"
              class="workspace-search-empty"
              icon="magnify"
              title="No workspaces found"
              description="Try another name or clear your search."
            >
              <UiButton
                label="Clear search"
                variant="ghost"
                data-workspace-clear-search
                @click="clearSearch"
              />
            </UiEmptyState>
          </nav>
          <ContextMenu
            ref="contextMenu"
            label="Workspace actions"
            :items="menuItems"
            data-workspace-menu
            @select="onMenuSelect"
          />
          <div class="workspace-sidebar-note">
            <MdiIcon name="database-outline" /><span
              >{{ count === 1 ? '1 workspace' : `${count} workspaces` }} on this device</span
            >
          </div>
        </aside>
        <div id="workspace-editor" class="workspace-editor">
          <form
            v-if="manager.mode === 'team'"
            class="workspace-editor-form workspace-team-form"
            data-workspace-team-form
            @submit.prevent="store.openTeam(false)"
          >
            <div class="workspace-editor-body">
              <span class="workspace-panel-eyebrow">TEAM WORKSPACES</span
              ><span class="workspace-avatar workspace-draft-avatar" aria-hidden="true"
                ><MdiIcon name="account-group-outline"
              /></span>
              <h3 id="workspace-detail-title" tabindex="-1">Work on a workspace together</h3>
              <p class="workspace-detail-description">
                A team workspace lives in a folder you all can reach: a network drive, a folder
                synced by Dropbox, OneDrive, Google Drive, or iCloud, or a Git checkout. Changes
                appear for everyone within seconds. There is no account or server.
              </p>
              <label class="form-field workspace-name-field" for="team-member-name"
                ><span>Your name, as teammates see it</span
                ><input
                  id="team-member-name"
                  class="field-input"
                  maxlength="60"
                  autocomplete="name"
                  aria-describedby="team-member-error"
                  :aria-invalid="Boolean(team.memberError)"
                  :value="team.memberName"
                  :disabled="locked"
                  @input="setMemberName"
              /></label>
              <p id="team-member-error" class="form-error" aria-live="polite">
                {{ team.memberError }}
              </p>
              <div class="workspace-team-split">
                <div>
                  <strong><MdiIcon name="folder-account-outline" /> In the shared folder</strong>
                  <ul>
                    <li>Collections, requests, tests, and captures</li>
                    <li>Environments, without secret values</li>
                    <li>API specifications and mock servers</li>
                    <li>Everyone’s history, each in their own file</li>
                  </ul>
                </div>
                <div>
                  <strong><MdiIcon name="shield-lock-outline" /> Only on this device</strong>
                  <ul>
                    <li>Saved credentials, tokens, passwords, and secret values</li>
                    <li>Open tabs, the selected environment, and preferences</li>
                    <li>Cookies, client certificates, and last responses</li>
                  </ul>
                </div>
              </div>
              <div v-if="gitClone" class="workspace-team-clone" data-workspace-clone>
                <strong><MdiIcon name="git" /> Or clone a Git repository</strong>
                <p>
                  Joins the team workspace in a GitHub, GitLab, or Bitbucket repository. A
                  repository without one gets this workspace, ready to push.
                </p>
                <div class="workspace-team-clone-row">
                  <label class="form-field" for="team-clone-url"
                    ><span>Repository URL</span
                    ><input
                      id="team-clone-url"
                      class="field-input"
                      spellcheck="false"
                      autocomplete="off"
                      placeholder="https://github.com/team/api.git"
                      aria-describedby="team-clone-error"
                      :aria-invalid="Boolean(team.cloneError)"
                      :value="team.cloneURL"
                      :disabled="locked"
                      @input="setCloneURL"
                      @keydown.enter.prevent="store.cloneTeam()" /></label
                  ><UiButton
                    label="Clone…"
                    icon="source-branch"
                    data-workspace-clone-button
                    :disabled="locked || !team.cloneURL.trim()"
                    @click="store.cloneTeam()"
                  />
                </div>
                <p id="team-clone-error" class="form-error" aria-live="polite">
                  {{ team.cloneError }}
                </p>
              </div>
            </div>
            <div class="workspace-editor-footer">
              <UiButton
                label="Cancel"
                variant="ghost"
                data-workspace-edit-cancel
                :disabled="manager.busy"
                @click="edit('details')"
              /><UiButton
                label="Share this workspace…"
                icon="share-variant-outline"
                data-workspace-share
                :disabled="locked || store.isTeam()"
                :title="store.isTeam() ? 'This workspace is already shared' : undefined"
                @click="store.openTeam(true)"
              /><UiButton
                label="Open team folder…"
                icon="folder-open-outline"
                type="submit"
                variant="primary"
                data-workspace-open-folder
                :disabled="locked"
              />
            </div>
          </form>
          <form
            v-else-if="editing"
            :id="creating ? 'workspace-create-form' : undefined"
            :data-workspace-rename-form="creating ? undefined : item!.id"
            :class="[
              'workspace-editor-form',
              creating ? 'workspace-create-form' : 'workspace-rename-form',
            ]"
            @submit.prevent="submit"
          >
            <div class="workspace-editor-body">
              <span class="workspace-panel-eyebrow">{{
                creating ? 'A FRESH START' : 'WORKSPACE DETAILS'
              }}</span
              ><span class="workspace-avatar workspace-draft-avatar" aria-hidden="true">{{
                initials(manager.draftName)
              }}</span>
              <h3 id="workspace-detail-title">
                {{ creating ? 'Create a workspace' : 'Rename workspace' }}
              </h3>
              <p class="workspace-detail-description">
                {{
                  creating
                    ? 'Give your next project a space of its own.'
                    : 'Choose a name that makes this workspace easy to find.'
                }}
              </p>
              <label
                class="form-field workspace-name-field"
                :for="creating ? 'workspace-create-name' : 'workspace-rename-name'"
                ><span
                  >Workspace name
                  <small id="workspace-name-count">{{ manager.draftName.length }}/60</small></span
                ><input
                  :id="creating ? 'workspace-create-name' : 'workspace-rename-name'"
                  ref="input"
                  class="field-input"
                  name="name"
                  placeholder="e.g. Platform Engineering"
                  required
                  maxlength="60"
                  autocomplete="off"
                  aria-describedby="workspace-name-help workspace-name-error"
                  :aria-invalid="Boolean(manager.nameError)"
                  :value="manager.draftName"
                  :disabled="locked"
                  @input="setDraft"
              /></label>
              <p id="workspace-name-error" class="form-error" aria-live="polite">
                {{ manager.nameError }}
              </p>
              <p id="workspace-name-help" class="field-help">
                {{
                  creating
                    ? 'You can rename this workspace at any time.'
                    : 'Renaming keeps your collections, environments, history, and credentials in place.'
                }}
              </p>
              <template v-if="creating">
                <div class="workspace-starter">
                  <span><MdiIcon name="folder-outline" /></span>
                  <div>
                    <strong>Ready for your first request</strong>
                    <p>
                      Starts with an empty collection, an untitled request, and a Development
                      environment.
                    </p>
                  </div>
                </div>
                <fieldset
                  v-if="chooseLocation"
                  class="workspace-location"
                  data-workspace-location-choice
                >
                  <legend>Save in</legend>
                  <label v-for="option in locationOptions()" :key="option.value"
                    ><input
                      type="radio"
                      name="workspace-location"
                      :value="option.value"
                      :data-workspace-location-option="option.value"
                      :checked="manager.createLocation === option.value"
                      :disabled="locked"
                      @change="manager.createLocation = option.value"
                    /><MdiIcon :name="option.icon" /><span
                      ><strong>{{ option.label }}</strong
                      ><small :title="option.detail">{{ option.detail }}</small></span
                    ></label
                  >
                </fieldset>
                <div class="workspace-privacy-note">
                  <MdiIcon name="shield-lock-outline" /><span
                    >Existing workspaces and their credentials stay separate.</span
                  >
                </div>
              </template>
            </div>
            <div class="workspace-editor-footer">
              <UiButton
                label="Cancel"
                variant="ghost"
                data-workspace-edit-cancel
                :data-workspace-rename-cancel="creating ? undefined : ''"
                :disabled="manager.busy"
                @click="edit('details')"
              /><UiButton
                :label="
                  manager.busy
                    ? creating
                      ? 'Creating…'
                      : 'Saving…'
                    : creating
                      ? 'Create & open workspace'
                      : 'Save changes'
                "
                :icon="creating ? 'plus' : 'content-save-outline'"
                type="submit"
                variant="primary"
                data-workspace-save
                :disabled="saveDisabled"
              />
            </div>
          </form>
          <UiEmptyState
            v-else-if="!item"
            icon="layers-outline"
            title="Choose a workspace"
            description="Select a workspace to view details or create a new one."
          />
          <div v-else-if="manager.mode === 'delete'" class="workspace-detail">
            <div class="workspace-editor-body">
              <span class="workspace-danger-symbol"><MdiIcon name="delete-outline" /></span
              ><span class="workspace-panel-eyebrow">DELETE WORKSPACE</span>
              <template v-if="item.folder">
                <h3 id="workspace-detail-title" tabindex="-1">Leave {{ item.name }}?</h3>
                <p class="workspace-detail-description">
                  This removes the team workspace from this device. The shared folder, and everyone
                  else’s copy, stay as they are.
                </p>
                <div class="workspace-delete-summary">
                  <strong>What is removed from this device</strong>
                  <ul>
                    <li>Your tabs, preferences, and secret values for it</li>
                    <li>Encrypted credentials saved in it</li>
                  </ul>
                </div>
                <p class="workspace-danger-note">
                  Open the same folder again to rejoin; you will need to fill in secrets again.
                </p>
              </template>
              <template v-else-if="item.location">
                <h3 id="workspace-detail-title" tabindex="-1">Remove {{ item.name }}?</h3>
                <p class="workspace-detail-description">
                  This removes the workspace from API Workbench. Its folder, with the workspace file
                  and collections, stays where it is.
                </p>
                <div class="workspace-delete-summary">
                  <strong>What is removed</strong>
                  <ul>
                    <li>The workspace from this list</li>
                    <li>Encrypted credentials saved in it, from the app’s data folder</li>
                  </ul>
                </div>
                <p class="workspace-danger-note" :title="item.location">
                  The files stay in {{ item.location }}.
                </p>
              </template>
              <template v-else>
                <h3 id="workspace-detail-title" tabindex="-1">Delete {{ item.name }}?</h3>
                <p class="workspace-detail-description">
                  This removes the workspace and everything stored in it from this device.
                </p>
                <div class="workspace-delete-summary">
                  <strong>What will be deleted</strong>
                  <ul>
                    <li>Collections and saved requests</li>
                    <li>Environments, history, and settings</li>
                    <li>Encrypted workspace credentials</li>
                  </ul>
                </div>
                <p class="workspace-danger-note">
                  This cannot be undone. Other workspaces will stay in place.
                </p>
              </template>
            </div>
            <div class="workspace-editor-footer">
              <UiButton
                label="Keep workspace"
                data-workspace-edit-cancel
                :disabled="manager.busy"
                @click="edit('details')"
              /><UiButton
                :label="
                  manager.busy
                    ? item.folder
                      ? 'Leaving…'
                      : 'Deleting…'
                    : item.folder
                      ? 'Leave team workspace'
                      : 'Delete workspace'
                "
                icon="delete-outline"
                variant="danger"
                :data-workspace-delete-confirm="item.id"
                :disabled="locked || isCurrent"
                @click="store.deleteSelected()"
              />
            </div>
          </div>
          <div v-else class="workspace-detail">
            <div class="workspace-editor-body">
              <div class="workspace-detail-topline">
                <span class="workspace-avatar" aria-hidden="true">{{ initials(item.name) }}</span
                ><UiBadge
                  v-if="isCurrent"
                  label="Current workspace"
                  tone="success"
                  icon="check-circle-outline"
                /><UiBadge
                  v-if="item.folder"
                  label="Team workspace"
                  tone="brand"
                  icon="account-group-outline"
                /><UiBadge v-else-if="!isCurrent" label="Local workspace" tone="neutral" />
              </div>
              <h3 id="workspace-detail-title" tabindex="-1">{{ item.name }}</h3>
              <p class="workspace-detail-description">
                {{
                  isCurrent
                    ? 'You’re working here. Your changes save automatically.'
                    : 'A separate home for your APIs and workflows.'
                }}
              </p>
              <ScrollRow
                v-if="isCurrent"
                class="workspace-detail-stats"
                frame-class="workspace-detail-stats-frame"
                noun="details"
              >
                <div v-for="metric in metrics" :key="metric.label">
                  <MdiIcon :name="metric.icon" /><strong>{{ metric.value }}</strong
                  ><span>{{ metric.label }}</span>
                </div>
              </ScrollRow>
              <div v-else class="workspace-starter">
                <span><MdiIcon name="layers-outline" /></span>
                <div>
                  <strong>Your project, in its own space</strong>
                  <p>Switch to load this workspace’s collections, environments, and settings.</p>
                </div>
              </div>
              <dl class="workspace-dates">
                <div v-if="item.folder" class="workspace-folder">
                  <dt>Shared folder</dt>
                  <dd :title="item.folder">
                    <code>{{ item.folder }}</code>
                  </dd>
                </div>
                <div v-else-if="item.location" class="workspace-folder">
                  <dt>Saved in</dt>
                  <dd :title="item.location">
                    <code data-workspace-location>{{ item.location }}</code>
                  </dd>
                </div>
                <div v-if="item.folder && isCurrent">
                  <dt>Here now</dt>
                  <dd data-workspace-presence>
                    {{
                      team.others.length
                        ? team.others.map((presence) => presence.member.name).join(', ')
                        : 'Only you'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{{ date(item.createdAt) }}</dd>
                </div>
                <div>
                  <dt>Last updated</dt>
                  <dd>{{ date(item.updatedAt) }}</dd>
                </div>
              </dl>
              <TeamGitPanel v-if="item.folder && isCurrent && gitSync" :disabled="locked" />
              <div class="workspace-detail-options">
                <div>
                  <strong>Workspace name</strong>
                  <p>Keep it recognizable to find it quickly.</p>
                </div>
                <UiButton
                  label="Rename"
                  icon="pencil-outline"
                  :data-workspace-rename="item.id"
                  :disabled="locked"
                  @click="edit('rename', item.id)"
                />
              </div>
              <div class="workspace-detail-options workspace-delete-option">
                <div>
                  <strong>{{ item.folder ? 'Leave team workspace' : 'Delete workspace' }}</strong>
                  <p>
                    {{
                      isCurrent
                        ? `Switch to another workspace to ${item.folder ? 'leave' : 'delete'} this one.`
                        : item.folder
                          ? 'Remove it from this device; the shared folder stays.'
                          : 'Permanently remove this workspace and its data.'
                    }}
                  </p>
                </div>
                <UiIconButton
                  :label="
                    isCurrent
                      ? 'Switch to another workspace before deleting'
                      : item.folder
                        ? `Leave ${item.name}`
                        : `Delete ${item.name}`
                  "
                  :icon="item.folder ? 'exit-to-app' : 'delete-outline'"
                  :data-workspace-delete="item.id"
                  :disabled="locked || isCurrent || count < 2"
                  @click="requestDelete(item.id)"
                />
              </div>
            </div>
            <div class="workspace-editor-footer">
              <span class="workspace-footer-note"
                ><MdiIcon :name="item.folder ? 'account-group-outline' : 'shield-lock-outline'" />
                {{ item.folder ? 'Shared with your team' : 'Stored on this device' }}</span
              ><UiButton
                v-if="isCurrent"
                label="Done"
                data-workspace-close
                :disabled="manager.busy"
                @click="store.close()"
              /><UiButton
                v-else
                :label="manager.busy ? 'Switching…' : 'Open workspace'"
                icon="arrow-top-right"
                variant="primary"
                :data-workspace-select="item.id"
                :disabled="locked"
                @click="store.select(item.id)"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
