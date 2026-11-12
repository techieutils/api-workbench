<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../select-options';
import { computed } from 'vue';
import { providers } from '@techieutils/api-workbench-common/secret-providers';
import { useVaultStore } from '../../stores/vault';
import { useWorkspaceStore } from '../../stores/workspace';
import MdiIcon from '../MdiIcon.vue';
import PageHeader from '../ui/PageHeader.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiSectionHeading from '../ui/UiSectionHeading.vue';
import UiStatCard from '../ui/UiStatCard.vue';
import { kindLabels } from '../../stores/vault';
import { vaultIssue } from '@techieutils/api-workbench-common/vault-messages';
import UiSelect from '../ui/UiSelect.vue';
import WorkbenchVaultPanel from './WorkbenchVaultPanel.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import { useContextMenu } from '../../composables/context-menu';
import { toast } from '../../utils';

/** Saved authentication profiles, unlocked from the OS keychain only when this screen opens. */
const vault = useVaultStore();
const workspace = useWorkspaceStore();
const kinds = [
  ['all', 'All profiles'],
  ['oauth2', 'OAuth 2.0'],
  ['api-key', 'API keys'],
  ['basic', 'Basic'],
  ['bearer', 'Bearer'],
  ['digest', 'Digest'],
  ['jwt', 'JWT'],
  ['aws', 'AWS'],
  ['oauth1', 'OAuth 1.0'],
  ['ntlm', 'NTLM'],
  ['wsse', 'WSSE'],
  ['edgegrid', 'EdgeGrid'],
  ['hawk', 'Hawk'],
  ['client-certificate', 'Certificates'],
] as const;
const sources = computed((): [string, string][] => [
  ['local', 'Local vault'],
  ...providers.map((provider): [string, string] => [provider.id, provider.label]),
]);
const filtered = computed(() =>
  vault.credentials.filter(
    (credential) =>
      (vault.kindFilter === 'all' || credential.kind === vault.kindFilter) &&
      (vault.providerFilter === 'all' ||
        (credential.external?.provider || 'local') === vault.providerFilter) &&
      `${credential.name} ${credential.allowedOrigin} ${kindLabels[credential.kind]} ${vault.sourceLabel(credential)}`
        .toLowerCase()
        .includes(vault.filter.toLowerCase()),
  ),
);
const connections = computed(
  () =>
    vault.credentials.filter(
      (credential) =>
        credential.kind === 'oauth2' &&
        credential.connected &&
        (!credential.expiresAt || credential.expiresAt > Date.now()),
    ).length,
);
const cancelOAuth = () => void window.workbench?.oauth.cancel();
const restartNeeded = computed(() =>
  ['unavailable', 'restart'].includes(vaultIssue(vault.error) ?? ''),
);
const canRestart = Boolean(window.workbench?.restart);
const busy = computed(() => Boolean(vault.oauthPending || vault.providerCheckPending));
// The same icons as the credential form's kind and source select boxes.
const kindIcon = (kind: string): MdiIconName =>
  (OPTION_ICONS.credentialKind as Partial<Record<string, MdiIconName>>)[kind] ??
  (kind === 'all' ? 'filter-variant' : 'key-variant');
const icon = (credential: CredentialSummary): MdiIconName => kindIcon(credential.kind);
const sourceIcon = (credential: CredentialSummary): MdiIconName =>
  (OPTION_ICONS.secretSource as Partial<Record<string, MdiIconName>>)[
    credential.external?.provider ?? 'local'
  ] ?? 'cloud-lock-outline';
const padded = (value: number) => String(value).padStart(2, '0');
/** Whether a vault certificate is presented to matching hosts; kept in the workspace. */
const certificateEnabled = (credential: CredentialSummary) =>
  workspace.state.clientCertificates?.find((item) => item.credentialId === credential.id)
    ?.enabled !== false;
const oauth = (id: string, operation: 'authorize' | 'refresh' | 'disconnect') =>
  void vault.performOAuth(id, operation);

// A credential's context menu offers the row's own actions; secrets are never copied.
const {
  menu: contextMenu,
  target: menuFor,
  open: openMenu,
  onKeydown: onRowKeydown,
} = useContextMenu<CredentialSummary>();
const menuItems = computed<MenuItem[]>(() => {
  const credential = menuFor.value;
  if (!credential) return [];
  const items: MenuItem[] = [
    { id: 'edit', label: 'Edit credential', icon: 'pencil-outline', disabled: busy.value },
  ];
  if (credential.external)
    items.push({
      id: 'test',
      label: 'Test access',
      icon: 'shield-lock-outline',
      disabled: busy.value,
    });
  if (credential.kind === 'oauth2') {
    items.push({
      id: 'authorize',
      label: credential.connected ? 'Reconnect' : 'Connect',
      icon: 'shield-account-outline',
      disabled: busy.value,
    });
    if (credential.canRefresh)
      items.push({ id: 'refresh', label: 'Refresh token', icon: 'refresh', disabled: busy.value });
    if (credential.connected)
      items.push({
        id: 'disconnect',
        label: 'Disconnect locally',
        icon: 'link-off',
        disabled: busy.value,
      });
  }
  if (credential.kind === 'client-certificate')
    items.push({
      id: 'certificate',
      label: certificateEnabled(credential)
        ? 'Stop presenting this certificate'
        : 'Present this certificate',
      icon: 'certificate-outline',
    });
  items.push(
    { id: 'origin', label: 'Copy allowed origin', icon: 'content-copy', separated: true },
    {
      id: 'delete',
      label: 'Delete credential',
      icon: 'delete-outline',
      danger: true,
      separated: true,
      disabled: busy.value,
    },
  );
  return items;
});
async function onMenuSelect(command: string): Promise<void> {
  const credential = menuFor.value;
  if (!credential) return;
  if (command === 'edit') vault.openCredential(credential.id);
  else if (command === 'test') void vault.testProvider(credential.id);
  else if (command === 'authorize' || command === 'refresh' || command === 'disconnect')
    oauth(credential.id, command);
  else if (command === 'certificate')
    vault.setCertificateEnabled(credential.id, !certificateEnabled(credential));
  else if (command === 'origin') {
    try {
      await navigator.clipboard.writeText(credential.allowedOrigin);
      toast('Allowed origin copied', 'success');
    } catch {
      toast('The allowed origin could not be copied', 'error');
    }
  } else if (command === 'delete') void vault.deleteCredential(credential.id);
}
</script>

<template>
  <section class="panel credentials-panel">
    <PageHeader
      eyebrow="WORKSPACE / SECURITY"
      guide="credentials"
      title="Credentials"
      :description="
        vault.status?.kind === 'workbench'
          ? 'Local and cloud credentials, protected by the API Workbench vault.'
          : 'Local and cloud credentials, protected by your operating system.'
      "
    >
      <UiButton
        label="Add credential"
        icon="plus"
        variant="primary"
        data-action="new-credential"
        :disabled="!vault.status?.available || Boolean(vault.providerCheckPending)"
        @click="vault.openCredential()"
      />
    </PageHeader>
    <div class="metric-grid">
      <UiStatCard
        label="Credential vault"
        :value="
          vault.loading
            ? 'Unlocking…'
            : vault.status?.available
              ? 'Encrypted'
              : vault.status?.kind === 'workbench'
                ? vault.status.setUp
                  ? 'Locked'
                  : 'Not set up'
                : vault.status
                  ? 'Unavailable'
                  : 'Locked'
        "
        :note="
          vault.loading
            ? 'Waiting for your system keychain'
            : vault.status?.kind === 'workbench'
              ? 'API Workbench vault · AES-256'
              : vault.status?.backend || 'Desktop app required'
        "
        icon="shield-lock-outline"
        tone="success"
      />
      <UiStatCard
        label="Saved profiles"
        :value="vault.loaded ? padded(vault.credentials.length) : '—'"
        note="Reusable across your requests"
        icon="key-variant"
      />
      <UiStatCard
        label="OAuth connections"
        :value="vault.loaded ? padded(connections) : '—'"
        note="Active access tokens"
        icon="swap-horizontal"
      />
    </div>
    <WorkbenchVaultPanel />
    <!-- The command line and VS Code read the API Workbench vault, never the system's store. -->
    <section
      v-if="vault.status?.kind === 'os'"
      class="info-callout vault-elsewhere"
      aria-labelledby="vault-elsewhere-title"
      data-vault-elsewhere
    >
      <MdiIcon name="console-line" />
      <div class="vault-elsewhere-text">
        <h3 id="vault-elsewhere-title">Use your credentials in VS Code and the command line</h3>
        <p>
          They can open the API Workbench vault, with a password of your own, but not
          {{ vault.status.backend }}. Move your credentials there to use them outside the app.
        </p>
      </div>
      <UiButton
        label="Use the API Workbench vault…"
        icon="swap-horizontal"
        data-vault-use-workbench
        :disabled="vault.workbench.busy"
        @click="vault.useWorkbenchVault(true)"
      />
    </section>
    <!-- OS encryption is detected at startup, so it offers a restart once the keychain is unlocked. -->
    <div
      v-if="vault.error && restartNeeded"
      class="info-callout error-callout vault-restart-callout"
      role="alert"
    >
      <MdiIcon name="shield-lock-outline" />
      <p :title="vault.error">{{ vault.error }}</p>
      <UiButton
        v-if="canRestart"
        :label="vault.restarting ? 'Restarting…' : 'Restart app'"
        icon="refresh"
        variant="primary"
        data-vault-restart
        :disabled="vault.restarting"
        @click="vault.restartApp()"
      />
    </div>
    <div v-else-if="vault.error" class="info-callout error-callout" role="status">
      <MdiIcon name="shield-lock-outline" /><span>{{ vault.error }}</span
      ><button
        v-if="vaultIssue(vault.error) === 'denied'"
        type="button"
        class="text-button"
        data-vault-retry
        :disabled="vault.loading"
        @click="vault.unlock()"
      >
        <MdiIcon name="lock-open-variant-outline" />{{ vault.loading ? 'Unlocking…' : 'Try again' }}
      </button>
    </div>
    <div v-if="vault.oauthPending" class="info-callout oauth-progress" role="status">
      <span class="icon-spinner"><MdiIcon name="loading" /></span
      ><span
        >OAuth authorization in progress. Complete the sign-in in your browser if prompted.</span
      ><UiButton label="Cancel" data-action="cancel-oauth" @click="cancelOAuth" />
    </div>
    <UiSectionHeading
      title="Authentication profiles"
      description="Requests reference a profile, and client certificates are presented to their hosts. Your secrets stay in the vault."
      icon="shield-key-outline"
    />
    <div class="credential-toolbar">
      <ScrollRow
        class="filter-pills"
        role="group"
        aria-label="Filter credentials by type"
        noun="types"
      >
        <button
          v-for="[kind, label] in kinds"
          :key="kind"
          :data-credential-kind="kind"
          :aria-pressed="vault.kindFilter === kind"
          :class="{ active: vault.kindFilter === kind }"
          @click="vault.kindFilter = kind"
        >
          <MdiIcon :name="kindIcon(kind)" />{{ label }}
        </button>
      </ScrollRow>
      <label class="provider-filter"
        ><span class="sr-only">Filter by secret source</span
        ><UiSelect
          id="credential-provider-filter"
          v-model="vault.providerFilter"
          class="field-input"
          :options="
            withIcons(
              [['all', 'All sources'], ...sources],
              OPTION_ICONS.secretSource,
              'cloud-lock-outline',
            )
          "
      /></label>
      <label class="credential-search"
        ><MdiIcon name="magnify" /><input
          id="credential-filter"
          v-model="vault.filter"
          placeholder="Search profiles…"
          aria-label="Search credentials"
      /></label>
    </div>
    <div class="credential-table-wrap">
      <table class="credential-table">
        <thead>
          <tr>
            <th>PROFILE</th>
            <th>SECRET SOURCE</th>
            <th>ALLOWED API ORIGIN</th>
            <th>STATUS</th>
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="credential in filtered"
            :key="credential.id"
            :data-credential-row="credential.id"
            @contextmenu="openMenu($event, credential)"
            @keydown="onRowKeydown($event, credential)"
          >
            <td>
              <div class="credential-name">
                <span class="credential-icon"><MdiIcon :name="icon(credential)" /></span>
                <div>
                  <strong>{{ credential.name }}</strong
                  ><small>{{ kindLabels[credential.kind] }}</small>
                </div>
              </div>
            </td>
            <td>
              <span class="credential-source-label"
                ><MdiIcon :name="sourceIcon(credential)" />{{ vault.sourceLabel(credential) }}</span
              >
            </td>
            <td>
              <code>{{ credential.allowedOrigin }}</code
              ><small v-if="credential.clientCertificate?.subject" class="credential-subject">{{
                credential.clientCertificate.subject
              }}</small
              ><small v-if="credential.clientCertificate?.validTo"
                >Valid until
                {{ new Date(credential.clientCertificate.validTo).toLocaleDateString() }}</small
              ><small v-if="credential.expiresAt"
                >{{ credential.expiresAt <= Date.now() ? 'Expired' : 'Expires' }}
                {{ new Date(credential.expiresAt).toLocaleString() }}</small
              >
            </td>
            <td>
              <UiBadge v-bind="vault.tokenStatus(credential)" /><small
                v-if="vault.providerChecks.get(credential.id)?.error"
                class="form-error provider-check-error"
                >{{ vault.providerChecks.get(credential.id)!.error }}</small
              ><small v-else-if="vault.providerChecks.get(credential.id)?.checkedAt"
                >Checked
                {{
                  new Date(vault.providerChecks.get(credential.id)!.checkedAt!).toLocaleTimeString()
                }}</small
              >
            </td>
            <td>
              <div class="credential-actions">
                <label
                  v-if="credential.kind === 'client-certificate'"
                  class="toggle"
                  :title="`${certificateEnabled(credential) ? 'Stop presenting' : 'Present'} this certificate`"
                  ><input
                    type="checkbox"
                    role="switch"
                    :data-certificate-enabled="credential.id"
                    :checked="certificateEnabled(credential)"
                    :aria-label="`Present ${credential.name} to matching hosts`"
                    @change="
                      vault.setCertificateEnabled(
                        credential.id,
                        ($event.target as HTMLInputElement).checked,
                      )
                    " /><span></span
                ></label>
                <UiButton
                  v-if="credential.external"
                  label="Test access"
                  icon="shield-lock-outline"
                  class="subtle-button"
                  :data-test-provider="credential.id"
                  :disabled="busy"
                  @click="vault.testProvider(credential.id)"
                />
                <template v-if="credential.kind === 'oauth2'">
                  <UiButton
                    :label="credential.connected ? 'Reconnect' : 'Connect'"
                    class="subtle-button"
                    :data-oauth-connect="credential.id"
                    :disabled="busy"
                    @click="oauth(credential.id, 'authorize')"
                  /><UiIconButton
                    v-if="credential.canRefresh"
                    label="Refresh token"
                    icon="refresh"
                    :data-oauth-refresh="credential.id"
                    :disabled="busy"
                    @click="oauth(credential.id, 'refresh')"
                  /><UiIconButton
                    v-if="credential.connected"
                    label="Disconnect locally"
                    icon="link-off"
                    :data-oauth-disconnect="credential.id"
                    :disabled="busy"
                    @click="oauth(credential.id, 'disconnect')"
                  />
                </template>
                <UiIconButton
                  label="Edit credential"
                  icon="pencil-outline"
                  :data-edit-credential="credential.id"
                  :disabled="busy"
                  @click="vault.openCredential(credential.id)"
                /><UiIconButton
                  label="Delete credential"
                  icon="delete-outline"
                  class="danger-text"
                  :data-delete-credential="credential.id"
                  :disabled="busy"
                  @click="vault.deleteCredential(credential.id)"
                />
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <ContextMenu
        ref="contextMenu"
        label="Credential actions"
        :items="menuItems"
        data-credential-menu
        @select="onMenuSelect"
      />
      <UiEmptyState
        v-if="!filtered.length"
        class="library-empty"
        :icon="vault.loading ? 'loading' : 'shield-key-outline'"
        :title="
          vault.loading
            ? 'Unlocking your vault'
            : vault.credentials.length
              ? 'No matching profiles'
              : vault.error
                ? 'Your vault is unavailable'
                : 'Create your first credential'
        "
        :description="
          vault.loading
            ? 'Complete the keychain prompt to continue.'
            : vault.credentials.length
              ? 'Try another type or search term.'
              : 'Store a token, API key, Basic credential, or OAuth profile and attach it to any request.'
        "
      >
        <UiButton
          v-if="!vault.credentials.length && vault.status?.available"
          label="Add credential"
          icon="plus"
          variant="primary"
          data-action="new-credential"
          @click="vault.openCredential()"
        />
      </UiEmptyState>
    </div>
    <div class="security-footnote">
      <MdiIcon name="shield-lock-outline" /><span
        >{{
          vault.status?.kind === 'workbench'
            ? 'API Workbench vault (AES-256)'
            : 'OS-backed encryption'
        }}
        · Excluded from exports · Restricted to an API origin</span
      >
    </div>
  </section>
</template>
