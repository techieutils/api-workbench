<script setup lang="ts">
import { trimHistory } from '@techieutils/api-workbench-common/history';
import type { GuideName } from '@techieutils/api-workbench-common/support-links';
import { OPTION_ICONS, withIcons } from '../../select-options';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import ScrollRow from '../ui/ScrollRow.vue';
import * as httpSettings from '@techieutils/api-workbench-common/http-settings';
import { render } from '../../shell';
import { action } from '../../actions';
import { errorMessage, toast } from '../../utils';
import { useSettingsStore } from '../../stores/settings';
import { useWorkspacesStore } from '../../stores/workspaces';
import { useWorkspaceStore } from '../../stores/workspace';
import BrandWordmark from '../BrandWordmark.vue';
import MdiIcon from '../MdiIcon.vue';
import PageHeader from '../ui/PageHeader.vue';
import UiButton from '../ui/UiButton.vue';
import CertificatesSettings from './CertificatesSettings.vue';
import UpdateSettings from './UpdateSettings.vue';
import SupportSettings from './SupportSettings.vue';
import { useUpdatesStore } from '../../stores/updates';
import SettingRow from './SettingRow.vue';
import WorkspaceHTTPFields from './WorkspaceHTTPFields.vue';
import UiExpansionPanel from '../ui/UiExpansionPanel.vue';
import UiSelect from '../ui/UiSelect.vue';
import { keyLabel, SHORTCUT_GROUPS } from '../../shortcuts';

const settingsStore = useSettingsStore();
// In a narrow settings area the sections become a tab row, with scroll arrows when they overflow.
const sectionRow = ref<InstanceType<typeof ScrollRow>>();
watch(
  () => settingsStore.section,
  (section) =>
    void nextTick(() =>
      sectionRow.value?.reveal(
        sectionRow.value?.element?.querySelector<HTMLElement>(
          `[data-settings-section="${section}"]`,
        ),
      ),
    ),
  { flush: 'post' },
);
const workspace = useWorkspaceStore();
const workspaces = useWorkspacesStore();
const updates = useUpdatesStore();
// Where workspaces are saved is read from the main process when Saving opens.
watch(
  () => settingsStore.section,
  (section) => {
    if (section === 'Saving') void workspaces.loadStorage();
  },
  { immediate: true },
);
/** Whether this is the desktop app, which saves to folders on disk. */
const onDisk = Boolean(window.workbench?.workspaces.storage);
const AUTO_SAVE_HELP: Record<AppSettings['autoSave'], string> = {
  change: 'Every change is written to disk as you make it.',
  delay: 'Changes are written once you stop editing for a moment, in one save.',
  off: 'Changes are written only when you press ⌘ S or click Unsaved changes in the status bar. Closing the window or switching workspaces asks first.',
};
function revealWorkspace(): void {
  void window.workbench?.workspaces
    .reveal?.()
    .catch((error: unknown) => toast(errorMessage(error), 'error'));
}

const sections: [SettingsSection, MdiIconName][] = [
  ['General', 'tune-variant'],
  ['Saving', 'content-save-outline'],
  ['Requests', 'swap-horizontal'],
  ['Appearance', 'theme-light-dark'],
  ['Privacy', 'shield-lock-outline'],
  ['Certificates', 'certificate-outline'],
  ['Data', 'database-outline'],
  ['Updates', 'update'],
  ['Shortcuts', 'keyboard-outline'],
  ['Help', 'help-circle-outline'],
];

/** The guide for the open section: its own page where it has one, otherwise Settings. */
const SECTION_GUIDES: Partial<Record<SettingsSection, GuideName>> = {
  Certificates: 'certificates',
  Updates: 'updates',
  Shortcuts: 'shortcuts',
};
const sectionGuide = computed(() => SECTION_GUIDES[settingsStore.section] ?? 'settings');

/**
 * Unsaved edits for the open section. Like a re-rendered form, the draft is discarded when the
 * section changes or the saved settings are replaced (a save, an import, a workspace switch).
 */
const draft = reactive({ ...workspace.settings() });
const http = reactive(httpSettings.workspaceDefaults(workspace.settings()));
const httpError = ref('');
function resetDraft(): void {
  Object.assign(draft, workspace.settings());
  Object.assign(http, httpSettings.workspaceDefaults(workspace.settings()));
  httpError.value = '';
  // Drops an unsaved theme preview.
  settingsStore.applyPreferences();
}
watch(() => settingsStore.section, resetDraft);
watch(() => workspace.state.settings, resetDraft);

const saveable = computed(
  () => !['Data', 'Certificates', 'Updates', 'Shortcuts', 'Help'].includes(settingsStore.section),
);
function previewTheme(event: Event): void {
  settingsStore.applyTheme((event.target as HTMLSelectElement).value as AppSettings['theme']);
}
/** Workspace HTTP defaults as a validated patch; throws with a message for the form. */
function workspaceHTTPSettings(): Partial<HTTPSettings> {
  const values: Record<string, unknown> = {};
  for (const field of httpSettings.fields)
    values[field.key] = field.min !== undefined ? Number(http[field.key]) : http[field.key];
  const patch = httpSettings.overrides(values);
  httpSettings.resolve({ ...httpSettings.defaults }, patch);
  return patch;
}
function save(event: Event): void {
  if (!(event.target as HTMLFormElement).reportValidity()) return;
  const updated: AppSettings = { ...draft };
  if (settingsStore.section === 'Requests') {
    try {
      const patch = workspaceHTTPSettings();
      updated.httpSettings = patch;
      updated.timeoutMs = patch.timeoutMs!;
      updated.followRedirects = patch.followRedirects!;
    } catch (error) {
      httpError.value = errorMessage(error);
      return;
    }
  }
  workspace.state.settings = workspace.normalizedSettings(updated);
  workspace.state.history = trimHistory(workspace.state.history, workspace.settings().historyLimit);
  render();
  // Preferences are saved at once, even with auto save off: Save here means save.
  void workspace.saveNow().then(
    () => toast('Preferences saved', 'success'),
    () => {},
  );
}
/** Icons beside the keyboard shortcut groups. */
const SHORTCUT_GROUP_ICONS: Record<string, MdiIconName> = {
  Requests: 'console-network-outline',
  Collections: 'folder-outline',
  Navigation: 'compass-outline',
  Panels: 'view-split-vertical',
  'Dialogs and menus': 'menu',
};
</script>

<template>
  <section class="panel settings-panel">
    <PageHeader
      eyebrow="WORKSPACE / PREFERENCES"
      title="Settings"
      description="Fine-tune your development workspace."
      :guide="sectionGuide"
    />
    <div class="settings-layout">
      <ScrollRow
        ref="sectionRow"
        class="settings-nav"
        frame-class="settings-nav-frame"
        role="navigation"
        aria-label="Settings sections"
        noun="sections"
      >
        <button
          v-for="[name, icon] in sections"
          :key="name"
          :data-settings-section="name"
          :class="{ active: settingsStore.section === name }"
          :aria-current="settingsStore.section === name ? 'page' : undefined"
          @click="settingsStore.section = name"
        >
          <span><MdiIcon :name="icon" /></span>{{ name
          }}<span class="nav-arrow"><MdiIcon name="chevron-right" /></span>
        </button>
        <div class="settings-version">
          <BrandWordmark /><span>Desktop · v{{ updates.info?.currentVersion ?? '1.0.0' }}</span>
        </div>
      </ScrollRow>
      <form id="settings-form" class="settings-content" @submit.prevent="save">
        <template v-if="settingsStore.section === 'General'">
          <h2>Workspace preferences</h2>
          <p class="section-description">Make this workspace your own.</p>
          <SettingRow
            title="Workspace name"
            icon="briefcase-outline"
            description="Shown in the workspace switcher and exported settings."
            name="workspaceName"
          >
            <input
              id="setting-workspaceName"
              v-model="draft.workspaceName"
              class="field-input"
              name="workspaceName"
              aria-describedby="setting-workspaceName-description"
              aria-label="workspaceName"
              required
              maxlength="60"
            />
          </SettingRow>
          <SettingRow
            title="Default response format"
            icon="file-download-outline"
            description="Accept header for newly created requests."
            name="defaultAccept"
          >
            <UiSelect
              id="setting-defaultAccept"
              v-model="draft.defaultAccept"
              class="field-input"
              name="defaultAccept"
              aria-describedby="setting-defaultAccept-description"
              aria-label="defaultAccept"
              :options="
                withIcons(
                  [
                    ['application/json', 'JSON'],
                    ['*/*', 'Any format'],
                    ['application/xml', 'XML'],
                    ['text/plain', 'Plain text'],
                  ],
                  OPTION_ICONS.accept,
                )
              "
            />
          </SettingRow>
        </template>

        <template v-else-if="settingsStore.section === 'Saving'">
          <h2>Saving</h2>
          <p class="section-description">
            When changes are written to disk, and where workspaces and their collections are kept.
          </p>
          <SettingRow
            title="Auto save"
            icon="content-save-outline"
            :description="AUTO_SAVE_HELP[draft.autoSave]"
            name="autoSave"
          >
            <UiSelect
              id="setting-autoSave"
              v-model="draft.autoSave"
              class="field-input"
              name="autoSave"
              aria-describedby="setting-autoSave-description"
              aria-label="Auto save"
              :options="
                withIcons(
                  [
                    ['change', 'After every change'],
                    ['delay', 'After a pause'],
                    ['off', 'Off · save with ⌘ S'],
                  ],
                  OPTION_ICONS.autoSave,
                )
              "
            />
          </SettingRow>
          <SettingRow
            v-if="draft.autoSave === 'delay'"
            title="Pause before saving"
            icon="timer-outline"
            description="Seconds without changes before they are saved (1–60)."
            name="autoSaveDelaySeconds"
          >
            <input
              id="setting-autoSaveDelaySeconds"
              v-model.number="draft.autoSaveDelaySeconds"
              class="field-input"
              name="autoSaveDelaySeconds"
              aria-describedby="setting-autoSaveDelaySeconds-description"
              aria-label="Pause before saving, in seconds"
              type="number"
              min="1"
              max="60"
              required
            />
          </SettingRow>
          <div class="info-callout">
            Auto save is set per workspace; new workspaces start with this workspace’s choice.
            Switching workspaces and Git sync save first, whatever it is set to.
          </div>
          <section
            v-if="onDisk"
            class="storage-card"
            aria-labelledby="storage-title"
            data-settings-storage
          >
            <header>
              <span class="card-symbol"><MdiIcon name="folder-outline" /></span>
              <div>
                <h3 id="storage-title">Where workspaces are saved</h3>
                <p>
                  Each new workspace gets a folder of its own, named after it, with its workspace
                  file and a file for each collection. Without a folder here, they are saved in the
                  app’s data folder.
                </p>
              </div>
            </header>
            <dl class="storage-paths">
              <div>
                <dt>New workspaces</dt>
                <dd>
                  <code data-storage-default>{{
                    workspaces.storage.info?.storageFolder ??
                    workspaces.storage.info?.appData ??
                    '…'
                  }}</code>
                  <span
                    v-if="workspaces.storage.info && !workspaces.storage.info.storageFolder"
                    class="storage-tag"
                    >App data · default</span
                  >
                  <span v-else-if="workspaces.storage.info" class="storage-tag is-custom"
                    >Your folder</span
                  >
                </dd>
              </div>
              <div>
                <dt>This workspace</dt>
                <dd>
                  <code data-storage-current>{{ workspaces.storage.info?.current ?? '…' }}</code>
                  <UiButton
                    label="Show in folder"
                    icon="folder-open-outline"
                    variant="ghost"
                    data-storage-reveal
                    @click="revealWorkspace"
                  />
                </dd>
              </div>
            </dl>
            <p
              v-if="workspaces.storage.info?.storageProblem"
              class="form-error"
              role="alert"
              data-storage-problem
            >
              {{ workspaces.storage.info.storageProblem }}
            </p>
            <p v-if="workspaces.storage.error" class="form-error" role="alert">
              {{ workspaces.storage.error }}
            </p>
            <div class="storage-actions">
              <UiButton
                label="Choose folder…"
                icon="folder-search-outline"
                data-storage-choose
                :disabled="workspaces.storage.busy"
                @click="workspaces.changeStorageFolder(true)"
              />
              <UiButton
                label="Use app data"
                icon="database-outline"
                variant="ghost"
                data-storage-reset
                :disabled="workspaces.storage.busy || !workspaces.storage.info?.storageFolder"
                @click="workspaces.changeStorageFolder(false)"
              />
            </div>
            <p class="field-help">
              Workspaces already made stay where they are. Credentials in the vault always stay in
              the app’s data folder, encrypted by the system, wherever the workspace is.
            </p>
          </section>
        </template>

        <template v-else-if="settingsStore.section === 'Requests'">
          <h2>Workspace HTTP defaults</h2>
          <p class="section-description">
            Requests inherit these values unless a collection or request overrides them.
          </p>
          <WorkspaceHTTPFields :draft="http" />
          <UiExpansionPanel
            class="settings-runner-panel"
            title="Collection runs"
            description="Delay between requests, and whether to stop on a failure"
            icon="play-outline"
          >
            <SettingRow
              title="Runner delay"
              icon="timer-outline"
              description="Pause between collection requests, in milliseconds (0–30,000)."
              name="runnerDelayMs"
            >
              <input
                id="setting-runnerDelayMs"
                v-model.number="draft.runnerDelayMs"
                class="field-input"
                name="runnerDelayMs"
                aria-describedby="setting-runnerDelayMs-description"
                aria-label="runnerDelayMs"
                type="number"
                min="0"
                max="30000"
                step="100"
                required
              />
            </SettingRow>
            <SettingRow
              title="Stop on failure"
              icon="stop-circle-outline"
              description="Stop a collection run after a request error, HTTP error, or failed assertion."
              name="stopRunnerOnFailure"
            >
              <label class="toggle"
                ><input
                  id="setting-stopRunnerOnFailure"
                  v-model="draft.stopRunnerOnFailure"
                  name="stopRunnerOnFailure"
                  role="switch"
                  aria-describedby="setting-stopRunnerOnFailure-description"
                  type="checkbox"
                  aria-label="Stop runner on failure" /><span></span
              ></label>
            </SettingRow>
          </UiExpansionPanel>
          <p id="workspace-http-error" class="form-error" role="alert">{{ httpError }}</p>
        </template>

        <template v-else-if="settingsStore.section === 'Appearance'">
          <h2>Appearance &amp; editor</h2>
          <p class="section-description">A workspace that fits the way you work.</p>
          <SettingRow
            title="Color theme"
            icon="palette-outline"
            description="Choose a theme or follow your operating system."
            name="theme"
          >
            <UiSelect
              id="setting-theme"
              v-model="draft.theme"
              class="field-input"
              name="theme"
              aria-describedby="setting-theme-description"
              aria-label="theme"
              @change="previewTheme"
              :options="
                withIcons(
                  [
                    ['dark', 'Navy'],
                    ['light', 'Pearl'],
                    ['system', 'System'],
                  ],
                  OPTION_ICONS.theme,
                )
              "
            />
          </SettingRow>
          <SettingRow
            title="Interface density"
            icon="view-compact-outline"
            description="Adjust the spacing of navigation, tables, and controls."
            name="density"
          >
            <UiSelect
              id="setting-density"
              v-model="draft.density"
              class="field-input"
              name="density"
              aria-describedby="setting-density-description"
              aria-label="density"
              :options="
                withIcons(
                  [
                    ['comfortable', 'Comfortable'],
                    ['compact', 'Compact'],
                  ],
                  OPTION_ICONS.density,
                )
              "
            />
          </SettingRow>
          <SettingRow
            title="Editor font size"
            icon="format-size"
            description="Response viewer font size in pixels (10–18)."
            name="editorFontSize"
          >
            <input
              id="setting-editorFontSize"
              v-model.number="draft.editorFontSize"
              class="field-input"
              name="editorFontSize"
              aria-describedby="setting-editorFontSize-description"
              aria-label="editorFontSize"
              type="number"
              min="10"
              max="18"
              required
            />
          </SettingRow>
          <SettingRow
            title="Wrap response lines"
            icon="wrap"
            description="Keep long response content within the editor viewport."
            name="wordWrap"
          >
            <label class="toggle"
              ><input
                id="setting-wordWrap"
                v-model="draft.wordWrap"
                name="wordWrap"
                role="switch"
                aria-describedby="setting-wordWrap-description"
                type="checkbox"
                aria-label="Wrap response lines" /><span></span
            ></label>
          </SettingRow>
        </template>

        <template v-else-if="settingsStore.section === 'Privacy'">
          <h2>Privacy &amp; local storage</h2>
          <p class="section-description">Choose what API Workbench remembers on this device.</p>
          <SettingRow
            title="Record request history"
            icon="history"
            description="Store request URLs, methods, status codes, and timestamps locally."
            name="historyEnabled"
          >
            <label class="toggle"
              ><input
                id="setting-historyEnabled"
                v-model="draft.historyEnabled"
                name="historyEnabled"
                role="switch"
                aria-describedby="setting-historyEnabled-description"
                type="checkbox"
                aria-label="Record request history" /><span></span
            ></label>
          </SettingRow>
          <SettingRow
            title="History retention"
            icon="calendar-clock"
            description="Maximum entries kept on this device (0–1,000)."
            name="historyLimit"
          >
            <input
              id="setting-historyLimit"
              v-model.number="draft.historyLimit"
              class="field-input"
              name="historyLimit"
              aria-describedby="setting-historyLimit-description"
              aria-label="historyLimit"
              type="number"
              min="0"
              max="1000"
              required
            />
          </SettingRow>
          <SettingRow
            title="Persist response bodies"
            icon="content-save-outline"
            description="Off by default. Enabling this saves response bodies and headers in the workspace file."
            name="persistResponses"
          >
            <label class="toggle"
              ><input
                id="setting-persistResponses"
                v-model="draft.persistResponses"
                name="persistResponses"
                role="switch"
                aria-describedby="setting-persistResponses-description"
                type="checkbox"
                aria-label="Persist response bodies" /><span></span
            ></label>
          </SettingRow>
          <div class="info-callout">
            Credentials created in the vault use OS-backed encryption. Inline request authentication
            and environment values remain in the workspace file; use saved credentials for secrets.
          </div>
          <button type="button" class="danger-button" @click="action('clear-history')">
            Clear request history
          </button>
        </template>

        <CertificatesSettings v-else-if="settingsStore.section === 'Certificates'" />

        <template v-else-if="settingsStore.section === 'Data'">
          <h2>Import &amp; export</h2>
          <p class="section-description">
            Keep your workspace portable and your credentials private.
          </p>
          <div class="data-card">
            <span class="card-symbol"><MdiIcon name="export" /></span>
            <div>
              <h3>Export workspace</h3>
              <p>
                Collections, environments, and preferences. Vault credentials, credential links,
                responses, history, and recognized secret fields are excluded.
              </p>
            </div>
            <button type="button" class="subtle-button" @click="action('export')">
              Choose format
            </button>
          </div>
          <div class="data-card">
            <span class="card-symbol"><MdiIcon name="import" /></span>
            <div>
              <h3>Import collections</h3>
              <p>
                Import collections, environments, API specifications, SOAP services, and ZIP
                archives. Preview changes before adding them.
              </p>
            </div>
            <button type="button" class="subtle-button" @click="action('import')">
              Choose file
            </button>
          </div>
          <div class="info-callout">
            Review exported URLs, request bodies, and custom variable names before sharing. Secrets
            embedded in arbitrary text cannot be detected reliably.
          </div>
        </template>

        <UpdateSettings v-else-if="settingsStore.section === 'Updates'" />

        <SupportSettings v-else-if="settingsStore.section === 'Help'" />

        <template v-else-if="settingsStore.section === 'Shortcuts'">
          <h2>Keyboard shortcuts</h2>
          <p class="section-description">Move through your work without leaving the keyboard.</p>
          <template v-for="{ group, shortcuts } in SHORTCUT_GROUPS" :key="group">
            <h3 class="shortcut-group-heading">
              <MdiIcon :name="SHORTCUT_GROUP_ICONS[group] ?? 'keyboard-outline'" />{{ group }}
            </h3>
            <SettingRow
              v-for="shortcut in shortcuts"
              :key="shortcut.label"
              :title="shortcut.label"
              description=""
            >
              <span class="shortcut-keys"
                ><kbd v-for="key in shortcut.keys" :key="key">{{ keyLabel(key) }}</kbd></span
              >
            </SettingRow>
          </template>
        </template>

        <div v-if="saveable" class="settings-save">
          <span><MdiIcon name="shield-lock-outline" /> Saved on this device</span>
          <UiButton
            label="Save changes"
            icon="content-save-outline"
            variant="primary"
            type="submit"
          />
        </div>
      </form>
    </div>
  </section>
</template>
