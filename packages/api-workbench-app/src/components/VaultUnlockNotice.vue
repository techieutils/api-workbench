<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { VaultStatus } from '@techieutils/api-workbench-common/types';
import { VAULT_DENIED, vaultIssue } from '@techieutils/api-workbench-common/vault-messages';
import { useVaultStore } from '../stores/vault';
import MdiIcon from './MdiIcon.vue';
import UiButton from './ui/UiButton.vue';

/**
 * Offers to unlock the credential vault beside an error that needed it: unlock here (the system
 * may ask for keychain access), optionally retrying what failed, or open the Credentials screen.
 * When access is denied it says so and offers to try again; when OS encryption is unavailable it
 * offers to restart the app.
 */
const props = defineProps<{
  /** The error being explained; a vault that could not be opened changes the wording. */
  message?: string;
  /** What to do once unlocked, such as resending the request. */
  retry?: () => unknown;
  /** Names the retry in the link, e.g. "resend" gives "Unlock vault and resend". */
  retryLabel?: string;
}>();
const vault = useVaultStore();
/** Whether the latest unlock from here failed; its reason is shown, as the error above is not. */
const failed = ref(false);
const reason = computed(() => (failed.value ? vault.error || VAULT_DENIED : ''));
const issue = computed(() =>
  failed.value ? (vaultIssue(vault.error) ?? 'denied') : vaultIssue(props.message),
);
/** OS encryption is detected at startup, so when it is unavailable the app offers a restart. */
const restartNeeded = computed(() => ['unavailable', 'restart'].includes(issue.value ?? ''));
const canRestart = Boolean(window.workbench?.restart);
const label = computed(() =>
  vault.loading
    ? 'Unlocking…'
    : issue.value && issue.value !== 'locked'
      ? 'Try again'
      : props.retryLabel
        ? `Unlock vault and ${props.retryLabel}`
        : 'Unlock vault',
);

/** The API Workbench vault (no system store) asks for its password here, rather than the OS. */
/**
 * Which store is in use, read afresh when the notice appears (the system's store may have become
 * available or not since); until then it behaves as for the system's store.
 */
const fresh = ref<VaultStatus | null>(null);
const workbench = computed(() => fresh.value?.kind === 'workbench');
onMounted(() => {
  void window.workbench?.credentials
    .status()
    .then((status) => {
      fresh.value = status;
      vault.status = status;
    })
    .catch(() => {});
});
const password = ref('');
async function unlockWorkbench(): Promise<void> {
  const value = password.value;
  password.value = '';
  if (await vault.unlockVault(value)) {
    fresh.value = vault.status;
    await props.retry?.();
  }
}
async function unlock(): Promise<void> {
  if (!vault.status) await vault.loadCredentials();
  if (workbench.value) return;
  const opened = await vault.unlock();
  failed.value = !opened;
  if (opened) await props.retry?.();
}
</script>

<template>
  <div class="vault-unlock" role="group" aria-label="Credential vault">
    <p v-if="reason" class="vault-unlock-reason" role="alert">
      <MdiIcon name="shield-lock-outline" /><span :title="reason">{{ reason }}</span>
    </p>
    <!-- The API Workbench vault: its password, here; or, before it is set up, Credentials. -->
    <form
      v-if="workbench && fresh?.setUp && !fresh.available"
      class="vault-unlock-actions vault-unlock-password"
      data-vault-workbench-unlock
      @submit.prevent="unlockWorkbench"
    >
      <input
        v-model="password"
        class="field-input"
        type="password"
        autocomplete="current-password"
        aria-label="API Workbench vault password"
        placeholder="Vault password"
        data-vault-password
        required
      /><UiButton
        :label="retryLabel ? `Unlock and ${retryLabel}` : 'Unlock vault'"
        icon="lock-open-variant-outline"
        type="submit"
        data-vault-unlock
        :disabled="vault.workbench.busy || !password"
      /><button
        type="button"
        class="text-button"
        data-vault-open
        @click="vault.openCredentialsPage()"
      >
        <MdiIcon name="arrow-top-right" />Open Credentials
      </button>
      <p v-if="vault.workbench.error" class="vault-unlock-reason" role="alert">
        <MdiIcon name="shield-lock-outline" /><span>{{ vault.workbench.error }}</span>
      </p>
    </form>
    <div v-else class="vault-unlock-actions">
      <UiButton
        v-if="restartNeeded && canRestart"
        :label="vault.restarting ? 'Restarting…' : 'Restart app'"
        icon="refresh"
        variant="primary"
        data-vault-restart
        :disabled="vault.restarting"
        @click="vault.restartApp()"
      />
      <button
        v-else-if="!restartNeeded && !workbench"
        type="button"
        class="text-button"
        data-vault-unlock
        :disabled="vault.loading"
        @click="unlock"
      >
        <MdiIcon name="lock-open-variant-outline" />{{ label }}</button
      ><button
        type="button"
        class="text-button"
        data-vault-open
        @click="vault.openCredentialsPage()"
      >
        <MdiIcon name="arrow-top-right" />Open Credentials
      </button>
    </div>
  </div>
</template>
