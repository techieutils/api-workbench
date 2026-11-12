<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  vaultPasswordProblem,
  vaultPasswordStrength,
} from '@techieutils/api-workbench-common/vault-password';
import { useVaultStore } from '../../stores/vault';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';

/**
 * The API Workbench vault, shown when the system has no credential store: set it up with a
 * password, put the recovery key away, unlock it (or set a new password with the recovery key),
 * and once open, lock it, change its password, or reset it. Passwords stay in these fields only
 * until they are sent, and are cleared after.
 */
const vault = useVaultStore();
const status = computed(() => vault.status);
const password = ref('');
const confirm = ref('');
const current = ref('');
const recoveryKey = ref('');
const reveal = ref(false);
const recovering = ref(false);
const changing = ref(false);
const acknowledged = ref(false);
const strength = computed(() => vaultPasswordStrength(password.value));
const problem = computed(() => (password.value ? vaultPasswordProblem(password.value) : undefined));
const STRENGTH = ['Too weak', 'Fair', 'Good', 'Strong'];
const clear = () => {
  password.value = '';
  confirm.value = '';
  current.value = '';
  recoveryKey.value = '';
};
async function create(): Promise<void> {
  if (await vault.setupVault(password.value, confirm.value)) clear();
}
async function unlock(): Promise<void> {
  const value = password.value;
  password.value = '';
  await vault.unlockVault(value);
}
async function recover(): Promise<void> {
  if (await vault.recoverVault(recoveryKey.value, password.value, confirm.value)) {
    clear();
    recovering.value = false;
  }
}
async function change(): Promise<void> {
  if (await vault.changeVaultPassword(current.value, password.value, confirm.value)) {
    clear();
    changing.value = false;
  }
}
function switchTo(mode: 'recover' | 'unlock' | 'change' | 'none'): void {
  clear();
  vault.workbench.error = '';
  recovering.value = mode === 'recover';
  changing.value = mode === 'change';
}
const locksAt = computed(() =>
  status.value?.locksAt
    ? new Date(status.value.locksAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '',
);
async function done(): Promise<void> {
  acknowledged.value = false;
  await vault.finishVaultSetup();
}
</script>

<template>
  <section
    v-if="status?.kind === 'workbench'"
    class="workbench-vault"
    aria-labelledby="workbench-vault-title"
    data-workbench-vault
    :data-workbench-vault-state="
      vault.workbench.recoveryStep
        ? 'recovery'
        : !status.setUp
          ? 'setup'
          : status.locked
            ? 'locked'
            : 'unlocked'
    "
  >
    <header class="workbench-vault-head">
      <span class="workbench-vault-icon" aria-hidden="true"
        ><MdiIcon
          :name="status.locked || !status.setUp ? 'lock-outline' : 'lock-open-variant-outline'"
      /></span>
      <div>
        <h3 id="workbench-vault-title">API Workbench vault</h3>
        <p v-if="status.chosen">
          You chose the API Workbench vault over {{ status.system }}, so the command line and the VS
          Code extension can use your credentials with its password. They are encrypted with
          AES-256, with a key only your vault password (or recovery key) opens.
          <UiButton
            v-if="!status.setUp"
            :label="`Keep using ${status.system}`"
            icon="undo"
            variant="ghost"
            data-workbench-vault-go-back
            :disabled="vault.workbench.busy"
            @click="vault.useWorkbenchVault(false)"
          />
        </p>
        <p v-else>
          This computer has no system credential store, so API Workbench keeps your credentials in
          its own vault: encrypted with AES-256, with a key only your vault password (or recovery
          key) opens.
        </p>
      </div>
      <span
        v-if="status.setUp && !vault.workbench.recoveryStep"
        :class="['workbench-vault-state', status.locked ? 'is-locked' : 'is-open']"
        data-workbench-vault-badge
        ><MdiIcon :name="status.locked ? 'lock-outline' : 'check-circle-outline'" />{{
          status.locked ? 'Locked' : 'Unlocked'
        }}</span
      >
    </header>

    <p v-if="vault.workbench.error" class="form-error workbench-vault-error" role="alert">
      <MdiIcon name="alert-circle-outline" />{{ vault.workbench.error }}
    </p>
    <p
      v-if="status.retryAfterSeconds"
      class="workbench-vault-note is-warning"
      role="status"
      data-workbench-vault-wait
    >
      <MdiIcon name="timer-outline" />Too many wrong attempts: try again in
      {{ status.retryAfterSeconds }} seconds.
    </p>

    <!-- After setup: the recovery key, saved from the main process; the app never sees it. -->
    <div
      v-if="vault.workbench.recoveryStep"
      class="workbench-vault-body"
      data-workbench-vault-recovery
    >
      <h4><MdiIcon name="key-variant" />Save your recovery key</h4>
      <p>
        If you forget your vault password, the recovery key is the only way to set a new one. It is
        shown nowhere else and cannot be made again. Keep it somewhere safe, such as a password
        manager, apart from this computer.
      </p>
      <div class="workbench-vault-actions">
        <UiButton
          label="Save to a file…"
          icon="download"
          data-workbench-vault-save-recovery
          :disabled="vault.workbench.busy"
          @click="vault.saveRecoveryKey()"
        /><UiButton
          label="Copy"
          icon="content-copy"
          variant="ghost"
          data-workbench-vault-copy-recovery
          :disabled="vault.workbench.busy"
          @click="vault.copyRecoveryKey()"
        />
      </div>
      <label class="workbench-vault-check"
        ><input v-model="acknowledged" type="checkbox" data-workbench-vault-acknowledge />I have put
        my recovery key somewhere safe</label
      >
      <UiButton
        label="Done"
        icon="check"
        variant="primary"
        data-workbench-vault-done
        :disabled="!acknowledged || !vault.workbench.recoverySaved"
        :title="vault.workbench.recoverySaved ? undefined : 'Save or copy the recovery key first'"
        @click="done"
      />
    </div>

    <!-- Set up: a password, with what it still needs. -->
    <form
      v-else-if="!status.setUp"
      class="workbench-vault-body"
      data-workbench-vault-setup
      @submit.prevent="create"
    >
      <h4><MdiIcon name="shield-lock-outline" />Set up your vault password</h4>
      <div class="workbench-vault-fields">
        <label class="form-field"
          ><span>Vault password</span
          ><input
            id="workbench-vault-password"
            v-model="password"
            class="field-input"
            :type="reveal ? 'text' : 'password'"
            autocomplete="new-password"
            aria-describedby="workbench-vault-strength"
            required
        /></label>
        <label class="form-field"
          ><span>Confirm password</span
          ><input
            id="workbench-vault-confirm"
            v-model="confirm"
            class="field-input"
            :type="reveal ? 'text' : 'password'"
            autocomplete="new-password"
            required
        /></label>
      </div>
      <div id="workbench-vault-strength" class="workbench-vault-strength" aria-live="polite">
        <span
          :class="['workbench-vault-meter', `is-${strength}`]"
          role="meter"
          aria-label="Password strength"
          aria-valuemin="0"
          aria-valuemax="3"
          :aria-valuenow="strength"
          ><span></span><span></span><span></span
        ></span>
        <span>{{ password ? STRENGTH[strength] : 'At least 12 characters' }}</span>
        <span v-if="problem" class="workbench-vault-hint">{{ problem }}</span>
        <span v-else-if="confirm && confirm !== password" class="workbench-vault-hint">
          The passwords do not match.
        </span>
      </div>
      <label class="workbench-vault-check"
        ><input v-model="reveal" type="checkbox" />Show passwords</label
      >
      <p class="workbench-vault-note">
        <MdiIcon name="information-outline" />There is no way to read the vault without this
        password or the recovery key you get next. It locks after 15 minutes without use.
      </p>
      <UiButton
        label="Create vault"
        icon="shield-lock-outline"
        variant="primary"
        type="submit"
        data-workbench-vault-create
        :disabled="vault.workbench.busy || Boolean(problem) || !password || confirm !== password"
      />
    </form>

    <!-- Locked: the password, or the recovery key and a new password. -->
    <form
      v-else-if="status.locked && recovering"
      class="workbench-vault-body"
      data-workbench-vault-recover
      @submit.prevent="recover"
    >
      <h4><MdiIcon name="key-variant" />Set a new password with your recovery key</h4>
      <label class="form-field"
        ><span>Recovery key</span
        ><input
          id="workbench-vault-recovery-key"
          v-model="recoveryKey"
          class="field-input workbench-vault-key"
          autocomplete="off"
          spellcheck="false"
          placeholder="XXXX-XXXX-XXXX-…"
          required
      /></label>
      <div class="workbench-vault-fields">
        <label class="form-field"
          ><span>New password</span
          ><input
            id="workbench-vault-new-password"
            v-model="password"
            class="field-input"
            type="password"
            autocomplete="new-password"
            required
        /></label>
        <label class="form-field"
          ><span>Confirm new password</span
          ><input
            v-model="confirm"
            class="field-input"
            type="password"
            autocomplete="new-password"
            required
        /></label>
      </div>
      <p v-if="problem" class="workbench-vault-hint">{{ problem }}</p>
      <div class="workbench-vault-actions">
        <UiButton
          label="Set password and unlock"
          icon="lock-open-variant-outline"
          variant="primary"
          type="submit"
          :disabled="vault.workbench.busy || Boolean(problem) || !recoveryKey"
        /><UiButton label="Back" variant="ghost" @click="switchTo('unlock')" />
      </div>
    </form>
    <form
      v-else-if="status.locked"
      class="workbench-vault-body workbench-vault-unlock"
      data-workbench-vault-unlock
      @submit.prevent="unlock"
    >
      <label class="form-field"
        ><span>Vault password</span
        ><input
          id="workbench-vault-unlock-password"
          v-model="password"
          class="field-input"
          type="password"
          autocomplete="current-password"
          required
      /></label>
      <UiButton
        :label="vault.workbench.busy ? 'Unlocking…' : 'Unlock'"
        icon="lock-open-variant-outline"
        variant="primary"
        type="submit"
        data-workbench-vault-unlock-button
        :disabled="vault.workbench.busy || !password || Boolean(status.retryAfterSeconds)"
      />
      <button
        type="button"
        class="text-button"
        data-workbench-vault-forgot
        @click="switchTo('recover')"
      >
        Forgot your password?
      </button>
    </form>

    <!-- Unlocked: when it locks, and what can be done with it. -->
    <div v-else class="workbench-vault-body" data-workbench-vault-open>
      <p class="workbench-vault-note">
        <MdiIcon name="timer-outline" />Locks at {{ locksAt }} if not used, and when API Workbench
        quits.
      </p>
      <div class="workbench-vault-actions">
        <UiButton
          label="Lock now"
          icon="lock-outline"
          data-workbench-vault-lock
          :disabled="vault.workbench.busy"
          @click="vault.lockVault()"
        /><UiButton
          label="Change password"
          icon="form-textbox-password"
          variant="ghost"
          data-workbench-vault-change
          :aria-expanded="changing"
          @click="switchTo(changing ? 'none' : 'change')"
        /><UiButton
          v-if="status.chosen"
          :label="`Go back to ${status.system}…`"
          icon="undo"
          variant="ghost"
          data-workbench-vault-go-back
          :disabled="vault.workbench.busy"
          @click="vault.useWorkbenchVault(false)"
        /><UiButton
          label="Reset vault…"
          icon="delete-outline"
          variant="ghost"
          class="danger"
          data-workbench-vault-reset
          @click="vault.resetVault()"
        />
      </div>
      <form
        v-if="changing"
        class="workbench-vault-change"
        data-workbench-vault-change-form
        @submit.prevent="change"
      >
        <div class="workbench-vault-fields three">
          <label class="form-field"
            ><span>Current password</span
            ><input
              v-model="current"
              class="field-input"
              type="password"
              autocomplete="current-password"
              required
          /></label>
          <label class="form-field"
            ><span>New password</span
            ><input
              v-model="password"
              class="field-input"
              type="password"
              autocomplete="new-password"
              required
          /></label>
          <label class="form-field"
            ><span>Confirm new password</span
            ><input
              v-model="confirm"
              class="field-input"
              type="password"
              autocomplete="new-password"
              required
          /></label>
        </div>
        <p v-if="problem" class="workbench-vault-hint">{{ problem }}</p>
        <UiButton
          label="Change password"
          variant="primary"
          type="submit"
          :disabled="vault.workbench.busy || Boolean(problem) || !current || !password"
        />
      </form>
    </div>
  </section>
</template>
