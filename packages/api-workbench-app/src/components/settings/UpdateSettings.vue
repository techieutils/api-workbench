<script setup lang="ts">
import { computed } from 'vue';
import type { UpdateMode } from '@techieutils/api-workbench-common/types';
import { withIcons } from '../../select-options';
import { useUpdatesStore } from '../../stores/updates';
import MdiIcon from '../MdiIcon.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiSelect from '../ui/UiSelect.vue';
import SettingRow from './SettingRow.vue';

/** Settings → Updates: how new versions arrive, applied as soon as they change. */
const updates = useUpdatesStore();
void updates.start();
const info = computed(() => updates.info);
const status = computed(() => info.value?.status ?? { state: 'idle' as const });
const unsupported = computed(() => status.value.state === 'unsupported');
const busy = computed(() => ['checking', 'downloading'].includes(status.value.state));

const MODE_OPTIONS: [UpdateMode, string][] = [
  ['notify', 'Ask before downloading'],
  ['auto', 'Download and install automatically'],
  ['off', 'Only when I check'],
];
const MODE_ICONS: Record<UpdateMode, MdiIconName> = {
  notify: 'bell-outline',
  auto: 'download-outline',
  off: 'close-circle-outline',
};
const MODE_DESCRIPTIONS: Record<UpdateMode, string> = {
  notify: 'Checks GitHub every few hours and asks before downloading a new version.',
  auto: 'Downloads new versions in the background and installs them when you quit.',
  off: 'Never checks on its own; use Check for updates when you want one.',
};
const mode = computed(() => info.value?.preferences.mode ?? 'notify');
const PRERELEASE_DESCRIPTION =
  'Also offer beta versions, which get new features first but may be less stable.';
/** This copy cannot update itself, but the choice is saved for installed copies to use. */
const INSTALLED_ONLY = 'Takes effect in installed builds.';

function setMode(value: string): void {
  if (!info.value) return;
  void updates.setPreferences({ mode: value as UpdateMode });
}
function setPrerelease(event: Event): void {
  if (!info.value) return;
  const prerelease = (event.target as HTMLInputElement).checked;
  void updates.setPreferences({ prerelease });
}

/** A one-line summary of where updating stands, with an icon and tone. */
const summary = computed((): { icon: MdiIconName; tone: UITone; label: string; text: string } => {
  const current = status.value;
  switch (current.state) {
    case 'unsupported':
      return {
        icon: 'information-outline',
        tone: 'neutral',
        label: 'Manual',
        text: current.reason,
      };
    case 'checking':
      return {
        icon: 'refresh',
        tone: 'neutral',
        label: 'Checking',
        text: 'Looking for a new version…',
      };
    case 'current':
      return {
        icon: 'check-circle-outline',
        tone: 'success',
        label: 'Up to date',
        text: 'You have the latest version.',
      };
    case 'available':
      return {
        icon: 'update',
        tone: 'warning',
        label: 'Available',
        text: `Version ${current.version} is available${current.releaseDate ? `, released ${new Date(current.releaseDate).toLocaleDateString()}` : ''}.`,
      };
    case 'downloading':
      return {
        icon: 'download-outline',
        tone: 'neutral',
        label: `${current.percent}%`,
        text: `Downloading version ${current.version}…`,
      };
    case 'downloaded':
      return {
        icon: 'check-circle-outline',
        tone: 'success',
        label: 'Ready',
        text: `Version ${current.version} installs when you quit API Workbench, or restart now.`,
      };
    case 'error':
      return {
        icon: 'alert-circle-outline',
        tone: 'danger',
        label: 'Failed',
        text: current.message,
      };
    default:
      return {
        icon: 'update',
        tone: 'neutral',
        label: 'Not checked',
        text: 'No check has run since API Workbench started.',
      };
  }
});
const lastChecked = computed(() =>
  info.value?.lastChecked ? new Date(info.value.lastChecked).toLocaleString() : '',
);
</script>

<template>
  <h2>Updates</h2>
  <p class="section-description">Choose how new versions of API Workbench arrive.</p>
  <template v-if="info">
    <div class="update-status" data-testid="update-status" :data-state="status.state">
      <span class="card-symbol"><MdiIcon :name="summary.icon" /></span>
      <div>
        <h3>
          API Workbench {{ info.currentVersion }}
          <UiBadge :label="summary.label" :tone="summary.tone" />
        </h3>
        <p>{{ summary.text }}</p>
        <p v-if="status.state === 'available' && status.notes" class="update-notes">
          {{ status.notes }}
        </p>
        <progress
          v-if="status.state === 'downloading'"
          max="100"
          :value="status.percent"
          aria-label="Download progress"
        ></progress>
        <p v-if="lastChecked" class="update-checked">Last checked {{ lastChecked }}</p>
      </div>
      <div class="update-actions">
        <UiButton
          v-if="status.state === 'available'"
          label="Download"
          icon="download-outline"
          variant="primary"
          @click="updates.download()"
        />
        <UiButton
          v-else-if="status.state === 'downloaded'"
          label="Restart and install"
          icon="restart"
          variant="primary"
          @click="updates.install()"
        />
        <UiButton
          v-if="!unsupported && status.state !== 'downloaded'"
          label="Check for updates"
          icon="refresh"
          :disabled="busy"
          @click="updates.check()"
        />
      </div>
    </div>
    <SettingRow
      title="Automatic updates"
      icon="update"
      :description="
        unsupported ? `${MODE_DESCRIPTIONS[mode]} ${INSTALLED_ONLY}` : MODE_DESCRIPTIONS[mode]
      "
      name="updateMode"
    >
      <UiSelect
        id="setting-updateMode"
        :model-value="mode"
        class="field-input"
        name="updateMode"
        aria-describedby="setting-updateMode-description"
        aria-label="Automatic updates"
        :options="withIcons(MODE_OPTIONS, MODE_ICONS)"
        @change="setMode(($event.target as HTMLSelectElement).value)"
      />
    </SettingRow>
    <SettingRow
      title="Include pre-releases"
      icon="flask-outline"
      :description="
        unsupported ? `${PRERELEASE_DESCRIPTION} ${INSTALLED_ONLY}` : PRERELEASE_DESCRIPTION
      "
      name="updatePrerelease"
    >
      <label class="toggle"
        ><input
          id="setting-updatePrerelease"
          :checked="info.preferences.prerelease"
          name="updatePrerelease"
          role="switch"
          aria-describedby="setting-updatePrerelease-description"
          type="checkbox"
          aria-label="Include pre-releases"
          @change="setPrerelease" /><span></span
      ></label>
    </SettingRow>
    <div class="info-callout">
      Updates come from the project's GitHub releases, and each download is checked against the
      release's SHA-512 checksum before it is installed. A check sends only the request for the
      release information — no workspace data.
    </div>
  </template>
  <p v-else class="info-callout">
    Updates are available in the desktop app. Download new versions from the project's GitHub
    releases.
  </p>
</template>
