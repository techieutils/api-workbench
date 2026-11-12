<script setup lang="ts">
import { computed } from 'vue';
import {
  SUPPORT_LINKS,
  bugReportUrl,
  featureRequestUrl,
} from '@techieutils/api-workbench-common/support-links';
import { useUpdatesStore } from '../../stores/updates';
import { toast } from '../../utils';
import UiButton from '../ui/UiButton.vue';
import SettingRow from './SettingRow.vue';

/**
 * Settings → Help: report a problem or ask for a feature on GitHub, with the version and system
 * filled in; report a vulnerability privately; and the documentation. These are the app's own
 * addresses, so they open without asking. Nothing from a workspace is put in a report.
 */
const updates = useUpdatesStore();
void updates.start();
const version = computed(() => updates.info?.currentVersion ?? '');
const platform = () => navigator.platform || 'unknown';

function open(url: string): void {
  if (!window.workbench?.openExternal) return void toast('Links open in the desktop app.', 'error');
  void window.workbench.openExternal(url);
}
const details = () =>
  [
    `API Workbench ${version.value || '(version unknown)'}`,
    `Platform: ${platform()}`,
    `Language: ${navigator.language}`,
  ].join('\n');
function reportProblem(): void {
  open(
    bugReportUrl({ version: version.value || 'unknown', platform: platform(), details: details() }),
  );
}
async function copyDetails(): Promise<void> {
  await navigator.clipboard.writeText(details());
  toast('Version and system details copied.', 'success');
}

const pages: {
  title: string;
  description: string;
  icon: MdiIconName;
  label: string;
  url: string;
}[] = [
  {
    title: 'Documentation',
    description:
      'Guides for every feature, from sending a request to mock servers and the command line.',
    icon: 'file-document-outline',
    label: 'Open documentation',
    url: SUPPORT_LINKS.docs,
  },
  {
    title: 'Troubleshooting and FAQ',
    description: 'Answers to common problems: certificates, proxies, ports, and updates.',
    icon: 'help-circle-outline',
    label: 'Open troubleshooting',
    url: SUPPORT_LINKS.troubleshooting,
  },
  {
    title: 'What’s new',
    description: 'Every change in each version, newest first.',
    icon: 'history',
    label: 'Open changelog',
    url: SUPPORT_LINKS.changelog,
  },
  {
    title: 'Known issues',
    description: 'Problems already reported, and what is being worked on.',
    icon: 'magnify',
    label: 'Open issues',
    url: SUPPORT_LINKS.issues,
  },
  {
    title: 'Source and releases',
    description: 'The project on GitHub: its code, releases, and how to contribute.',
    icon: 'github',
    label: 'View on GitHub',
    url: SUPPORT_LINKS.repository,
  },
];
</script>

<template>
  <h2>Help</h2>
  <p class="section-description">
    Get help, report a problem, or suggest a feature. Each opens in your browser, on GitHub or the
    documentation site.
  </p>
  <div data-testid="support-settings">
    <SettingRow
      title="Report a problem"
      description="Opens GitHub’s bug report form with this version and your system filled in. Describe what happened, and remove tokens, passwords, and other secrets from anything you paste."
      icon="alert-circle-outline"
    >
      <UiButton
        label="Report a problem"
        icon="open-in-new"
        variant="primary"
        @click="reportProblem"
      />
    </SettingRow>
    <SettingRow
      title="Request a feature"
      description="Suggest something new, or a change to how something works."
      icon="lightbulb-outline"
    >
      <UiButton label="Request a feature" icon="open-in-new" @click="open(featureRequestUrl())" />
    </SettingRow>
    <SettingRow
      title="Report a security vulnerability"
      description="Reported privately to the maintainers, never in a public issue."
      icon="shield-outline"
    >
      <UiButton label="Report privately" icon="open-in-new" @click="open(SUPPORT_LINKS.security)" />
    </SettingRow>
    <SettingRow
      title="Version and system"
      :description="`API Workbench ${version || '…'} on ${platform()}. Copy them for a report or a support conversation.`"
      icon="information-outline"
    >
      <UiButton label="Copy details" icon="content-copy" @click="copyDetails" />
    </SettingRow>
    <SettingRow
      v-for="page in pages"
      :key="page.title"
      :title="page.title"
      :description="page.description"
      :icon="page.icon"
    >
      <UiButton :label="page.label" icon="open-in-new" @click="open(page.url)" />
    </SettingRow>
  </div>
</template>
