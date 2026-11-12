<script setup lang="ts">
import { methodIcon } from '../stores/protocols';
import { collectionOf } from '@techieutils/api-workbench-common/folders';
import { action } from '../actions';
import { useRequestsStore } from '../stores/requests';
import { useDialogsStore } from '../stores/dialogs';
import { computed, nextTick } from 'vue';
import { openSettings, openView } from '../navigation';
import { useScreensStore } from '../stores/screens';
import { useUpdatesStore } from '../stores/updates';
import { relativeTime } from '../utils';
import type { HistoryEntry } from '@techieutils/api-workbench-common/types';
import { useUiStore } from '../stores/ui';
import { useWorkspaceStore } from '../stores/workspace';
import BrandWordmark from './BrandWordmark.vue';
import MdiIcon from './MdiIcon.vue';
import OverviewQuickActions from './OverviewQuickActions.vue';
import PageHeader from './ui/PageHeader.vue';
import ScrollRow from './ui/ScrollRow.vue';
import UiBadge from './ui/UiBadge.vue';
import UiButton from './ui/UiButton.vue';
import UiEmptyState from './ui/UiEmptyState.vue';
import UiIconButton from './ui/UiIconButton.vue';
import UiSectionHeading from './ui/UiSectionHeading.vue';
import UiStatCard from './ui/UiStatCard.vue';
import { useVaultStore } from '../stores/vault';

const dialogs = useDialogsStore();
const ui = useUiStore();
const workspace = useWorkspaceStore();
const config = computed(() => workspace.settings());
// Environments are renamed in place, so read the active one on every render.
const environment = () => workspace.state.environments[workspace.state.environment];
const recent = computed(() => workspace.state.history.slice(0, ui.overviewBannerHidden ? 8 : 6));
// The vault is loaded by the Credentials screen.
const vaultStore = useVaultStore();
const requests = useRequestsStore();
const vault = computed(() => ({ loaded: vaultStore.loaded, count: vaultStore.credentials.length }));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The value at fraction `p` (0–1) of sorted numbers, by nearest rank. */
const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
/** Today's sends from History: how many, how many failed, and their response times. */
const today = computed(() => {
  const start = new Date().setHours(0, 0, 0, 0);
  const sent = workspace.state.history.filter((entry) => new Date(entry.date).getTime() >= start);
  const times = sent
    .map((entry) => entry.time)
    .filter((time): time is number => typeof time === 'number')
    .sort((a, b) => a - b);
  return {
    sent: sent.length,
    failed: sent.filter((entry) => !entry.status || entry.status >= 400).length,
    times,
  };
});
const stats = computed(() => {
  const collections = new Set(
    workspace.state.requests.map((request) => collectionOf(request.folder)),
  ).size;
  const { sent, failed, times } = today.value;
  const succeeded = sent ? Math.round(((sent - failed) / sent) * 100) : 0;
  return [
    {
      label: 'Saved requests',
      value: String(workspace.state.requests.length),
      note: `In ${plural(collections, 'collection')}`,
      icon: 'console-network-outline' as MdiIconName,
      link: 'Open Collections',
      open: () => openView('Collections'),
    },
    {
      label: 'Environments',
      value: String(workspace.state.environments.length),
      note: `Active: ${environment().name}`,
      icon: 'layers-outline' as MdiIconName,
      tone: 'success' as UITone,
      link: 'Manage environments',
      open: () => openView('Environments'),
    },
    {
      label: 'Sent today',
      value: String(sent),
      note: !sent
        ? 'Nothing sent yet today'
        : failed
          ? `${succeeded}% succeeded · ${failed} failed`
          : 'All succeeded',
      icon: 'send-outline' as MdiIconName,
      tone: (failed ? 'warning' : 'success') as UITone,
      link: 'Open History',
      open: () => openView('History'),
    },
    {
      label: 'Median response',
      value: times.length ? formatMs(percentile(times, 0.5)) : '—',
      note: times.length
        ? `p95 ${formatMs(percentile(times, 0.95))} · ${plural(times.length, 'timed request')} today`
        : 'Send a request to measure',
      icon: 'timer-outline' as MdiIconName,
      link: 'Open History',
      open: () => openView('History'),
    },
  ];
});

// Recent activity
const requestName = (id: string) =>
  workspace.state.requests.find((request) => request.id === id)?.name;
const statusTone = (status?: number): UITone =>
  !status || status >= 500
    ? 'danger'
    : status >= 400
      ? 'warning'
      : status >= 300
        ? 'neutral'
        : 'success';
const exactTime = (date: string) => new Date(date).toLocaleString();
const activitySummary = computed(() => {
  if (!workspace.state.history.length) return 'Your most recent requests.';
  if (!today.value.sent) return 'Nothing sent today yet; your most recent requests.';
  const sent = `${today.value.sent} request${today.value.sent === 1 ? '' : 's'} sent today`;
  return today.value.failed ? `${sent}, ${today.value.failed} failed.` : `${sent}, all succeeded.`;
});
/** Opens one send in History, with its response showing and no filter hiding it. */
function openInHistory(entry: HistoryEntry): void {
  Object.assign(useScreensStore().history, {
    query: '',
    status: 'All',
    selected: `${entry.date}|${entry.requestId}`,
  });
  openView('History');
  void nextTick(() =>
    document.querySelector('[data-history-detail]')?.scrollIntoView({ block: 'nearest' }),
  );
}

// Workspace essentials
const updates = useUpdatesStore();
const updateSummary = computed((): { title: string; note: string } | undefined => {
  const info = updates.info;
  if (!info) return undefined;
  const status = info.status;
  const title = `API Workbench ${info.currentVersion}`;
  if (status.state === 'available')
    return {
      title: `Version ${status.version} available`,
      note: `You have ${info.currentVersion}`,
    };
  if (status.state === 'downloading')
    return { title: `Downloading ${status.version}`, note: `${status.percent}% downloaded` };
  if (status.state === 'downloaded')
    return { title: `Version ${status.version} ready`, note: 'Installs when you quit' };
  if (status.state === 'current') return { title, note: 'Up to date' };
  if (status.state === 'unsupported') return { title, note: 'Updated by downloading new versions' };
  if (status.state === 'error') return { title, note: 'The last check failed' };
  return {
    title,
    note:
      info.preferences.mode === 'off'
        ? 'Checks only when you ask'
        : info.preferences.mode === 'auto'
          ? 'Updates automatically'
          : 'Asks before downloading updates',
  };
});
const updatePending = computed(() =>
  ['available', 'downloading', 'downloaded'].includes(updates.info?.status.state ?? ''),
);
</script>

<template>
  <section :class="['panel', 'overview-panel', { 'is-compact': ui.overviewBannerHidden }]">
    <PageHeader
      eyebrow="YOUR WORKSPACE"
      guide="overview"
      :title="`Welcome to ${config.workspaceName}`"
      description="Everything you need to build, test, and understand your APIs."
    >
      <UiButton
        v-if="ui.overviewBannerHidden"
        label="Show welcome"
        icon="eye-outline"
        variant="ghost"
        data-overview-banner="show"
        @click="ui.setOverviewBannerHidden(false)"
      />
      <UiButton label="New request" icon="plus" variant="primary" @click="action('new')" />
    </PageHeader>
    <div v-if="!ui.overviewBannerHidden" class="overview-hero">
      <UiIconButton
        label="Hide welcome banner"
        icon="close"
        class="overview-hero-dismiss"
        data-overview-banner="hide"
        @click="ui.setOverviewBannerHidden(true)"
      />
      <span class="hero-mark" aria-hidden="true"
        ><img
          class="theme-art-dark"
          src="assets/branding/app-icon-dark.png"
          width="144"
          height="144"
          alt="" /><img
          class="theme-art-light"
          src="assets/branding/app-icon-light.png"
          width="144"
          height="144"
          alt=""
      /></span>
      <div class="hero-brand"><BrandWordmark /></div>
      <span class="eyebrow">LOCAL FIRST. DEVELOPER FOCUSED.</span>
      <h2>A clearer view of your APIs.</h2>
      <p>
        Organize requests, switch environments, and inspect every response in a workspace that stays
        on your machine.
      </p>
      <div>
        <UiButton
          label="Create a request"
          icon="arrow-top-right"
          variant="primary"
          @click="action('new')"
        /><UiButton
          label="Import collection"
          icon="import"
          @click="dialogs.openTransfer('import')"
        />
      </div>
    </div>
    <!-- The stat cards stay on one line; in a narrow window they scroll with arrows. -->
    <ScrollRow class="overview-stats" frame-class="overview-stats-frame" noun="stats">
      <UiStatCard
        v-for="{ open, ...stat } in stats"
        :key="stat.label"
        v-bind="stat"
        :data-overview-stat="stat.label"
        @click="open()"
      />
    </ScrollRow>
    <!-- Returning users see activity first once the welcome banner is dismissed. -->
    <OverviewQuickActions v-if="!ui.overviewBannerHidden" />
    <div class="overview-columns">
      <div class="overview-card">
        <UiSectionHeading title="Recent activity" :description="activitySummary" icon="history">
          <UiButton
            label="View all"
            icon="arrow-top-right"
            variant="ghost"
            data-overview-history
            @click="openView('History')"
          />
        </UiSectionHeading>
        <ul v-if="recent.length" class="recent-list" aria-label="Recent requests">
          <li v-for="(entry, index) in recent" :key="`${entry.date}-${index}`" class="recent-row">
            <button
              type="button"
              class="recent-main"
              data-recent-entry
              :title="`Show this send in History — ${exactTime(entry.date)}`"
              @click="openInHistory(entry)"
            >
              <span :class="['method', entry.method]"
                ><MdiIcon :name="methodIcon(entry.method)" class="method-icon" />{{
                  entry.method
                }}</span
              ><span class="recent-target"
                ><strong v-if="requestName(entry.requestId)">{{
                  requestName(entry.requestId)
                }}</strong
                ><span class="recent-url">{{ entry.url }}</span></span
              ><UiBadge
                :label="String(entry.status || 'Error')"
                :tone="statusTone(entry.status)"
              /><span class="recent-meta"
                ><span v-if="entry.time !== undefined">{{ Math.round(entry.time) }} ms</span
                ><time :datetime="entry.date">{{ relativeTime(new Date(entry.date)) }}</time></span
              >
            </button>
            <UiIconButton
              v-if="requestName(entry.requestId) !== undefined"
              class="recent-open"
              label="Open request"
              icon="open-in-new"
              :data-open="entry.requestId"
              @click="requests.openRequest(entry.requestId)"
            />
          </li>
        </ul>
        <UiEmptyState
          v-else
          class="py-7"
          icon="history"
          title="Your activity starts here"
          description="Send a request to see your recent API activity."
        >
          <UiButton label="Create a request" icon="plus" variant="primary" @click="action('new')" />
        </UiEmptyState>
        <button
          v-if="workspace.state.history.length > recent.length"
          type="button"
          class="recent-more"
          data-recent-more
          @click="openView('History')"
        >
          Showing {{ recent.length }} of {{ workspace.state.history.length }} sends<span
            >Open History<MdiIcon name="arrow-right"
          /></span>
        </button>
      </div>
      <div class="overview-card">
        <UiSectionHeading
          title="Workspace essentials"
          description="Configured for the way you work."
          icon="clipboard-check-outline"
        />
        <button
          type="button"
          class="essentials-row"
          data-essential="environment"
          @click="openView('Environments')"
        >
          <MdiIcon name="layers-outline" />
          <span>
            <strong>{{ environment().name }}</strong
            ><small>Active environment</small>
          </span>
          <MdiIcon name="chevron-right" class="essentials-go" />
        </button>
        <button
          type="button"
          class="essentials-row"
          data-essential="vault"
          @click="openView('Credentials')"
        >
          <MdiIcon :name="vault.loaded ? 'shield-lock-open-outline' : 'shield-lock-outline'" />
          <span>
            <strong>{{ vault.loaded ? 'Vault unlocked' : 'Credential vault locked' }}</strong
            ><small>{{
              vault.loaded
                ? `${vault.count} credential${vault.count === 1 ? '' : 's'}, ready for requests`
                : 'Unlock only when you need it'
            }}</small>
          </span>
          <MdiIcon name="chevron-right" class="essentials-go" />
        </button>
        <button
          type="button"
          class="essentials-row"
          data-essential="history"
          @click="openView('History')"
        >
          <MdiIcon name="history" />
          <span>
            <strong>History {{ config.historyEnabled ? 'on' : 'off' }}</strong
            ><small>{{
              config.historyEnabled
                ? `${workspace.state.history.length} of up to ${config.historyLimit} entries kept`
                : 'Requests are not recorded'
            }}</small>
          </span>
          <MdiIcon name="chevron-right" class="essentials-go" />
        </button>
        <button
          type="button"
          class="essentials-row"
          data-essential="responses"
          @click="openSettings('Privacy')"
        >
          <MdiIcon name="database-outline" />
          <span>
            <strong>{{
              config.persistResponses ? 'Responses saved locally' : 'Responses stay in memory'
            }}</strong
            ><small>Change in Settings → Privacy</small>
          </span>
          <MdiIcon name="chevron-right" class="essentials-go" />
        </button>
        <button
          v-if="updateSummary"
          type="button"
          :class="['essentials-row', { 'is-attention': updatePending }]"
          data-essential="updates"
          @click="openSettings('Updates')"
        >
          <MdiIcon name="update" />
          <span>
            <strong>{{ updateSummary.title }}</strong
            ><small>{{ updateSummary.note }}</small>
          </span>
          <MdiIcon name="chevron-right" class="essentials-go" />
        </button>
      </div>
    </div>
    <OverviewQuickActions v-if="ui.overviewBannerHidden" />
  </section>
</template>
