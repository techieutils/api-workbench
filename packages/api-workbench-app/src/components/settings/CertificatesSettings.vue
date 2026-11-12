<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { render } from '../../shell';
import { errorMessage, toast } from '../../utils';
import { useSettingsStore } from '../../stores/settings';
import { useVaultStore } from '../../stores/vault';
import { useWorkspaceStore } from '../../stores/workspace';
import MdiIcon from '../MdiIcon.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import { confirmAction } from '../../confirm';

const settingsStore = useSettingsStore();
const workspace = useWorkspaceStore();
const desktop = Boolean(window.workbench?.certificates);
// Certificates are toggled in place, so read the list on every render.
const certificates = () => workspace.state.clientCertificates || [];
const vault = useVaultStore();
const caCount = computed(
  () =>
    (workspace.settings().httpSettings?.caCertificates || '').match(/-----BEGIN CERTIFICATE-----/g)
      ?.length || 0,
);
const fileName = (file?: string) => (file ? file.split(/[\\/]/).pop() || file : '');
function expiry(validTo?: string): { label: string; tone: UITone } {
  if (!validTo) return { label: 'Expiry unknown', tone: 'neutral' };
  const days = Math.floor((new Date(validTo).getTime() - Date.now()) / 86400000);
  if (days < 0) return { label: 'Expired', tone: 'danger' };
  if (days < 30) return { label: `Expires in ${days} day${days === 1 ? '' : 's'}`, tone: 'danger' };
  return { label: `Valid until ${new Date(validTo).toLocaleDateString()}`, tone: 'success' };
}

function setEnabled(certificate: ClientCertificate, enabled: boolean): void {
  certificate.enabled = enabled;
  workspace.persist();
  render();
}
/** Removes a certificate still saved by file path; vault certificates are removed in Credentials. */
async function remove(certificate: ClientCertificate): Promise<void> {
  const confirmed = await confirmAction({
    title: `Remove the client certificate for ${certificate.host}?`,
    message: 'Requests to this host stop presenting it. The certificate files are not deleted.',
    confirmLabel: 'Remove certificate',
    tone: 'danger',
  });
  if (!confirmed) return;
  workspace.state.clientCertificates = certificates().filter((item) => item !== certificate);
  workspace.persist();
  render();
}
async function addCA(): Promise<void> {
  try {
    const chosen = await window.workbench?.certificates?.choose('ca');
    if (!chosen?.pem) return;
    const existing = (workspace.settings().httpSettings?.caCertificates || '').trim();
    if (existing.includes(chosen.pem))
      return toast('These CA certificates are already trusted', 'warning');
    settingsStore.setWorkspaceCA([existing, chosen.pem].filter(Boolean).join('\n'));
    toast(`Added CA certificates from ${chosen.name}`, 'success');
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}
function editCA(): void {
  settingsStore.section = 'Requests';
  void nextTick(() =>
    document.querySelector<HTMLElement>('[data-http-field="caCertificates"]')?.focus(),
  );
}
async function clearCA(): Promise<void> {
  const confirmed = await confirmAction({
    title: 'Stop trusting the custom CA certificates?',
    message:
      'Requests in this workspace will trust only the system certificate store. Servers signed by these CAs will fail verification.',
    confirmLabel: 'Stop trusting',
    tone: 'danger',
  });
  if (confirmed) settingsStore.setWorkspaceCA('');
}
</script>

<template>
  <h2>Certificates</h2>
  <p class="section-description">
    Client certificates for mutual TLS, and the CA certificates this workspace trusts.
  </p>
  <div class="cert-section">
    <div class="cert-section-heading">
      <div>
        <h3>Client certificates</h3>
        <p>
          Kept in the encrypted credential vault and presented automatically to matching hosts over
          HTTPS, wss://, HTTPS streams, and TLS gRPC. The most specific match wins: exact host over
          wildcard, specific port over any port.
        </p>
      </div>
      <UiButton
        label="Manage in Credentials"
        icon="key-variant"
        data-cert-manage
        :disabled="!desktop"
        @click="vault.openCredentialsPage()"
      />
    </div>
    <p v-if="!desktop" class="info-callout">Client certificates require the desktop application.</p>
    <div v-if="certificates().length" class="cert-list">
      <div
        v-for="certificate in certificates()"
        :key="certificate.id"
        :class="['cert-row', { 'is-disabled': !certificate.enabled }]"
      >
        <span class="cert-row-icon"><MdiIcon name="shield-lock-outline" /></span>
        <div class="cert-row-main">
          <strong
            >{{ certificate.host
            }}<span v-if="certificate.port" class="cert-port">:{{ certificate.port }}</span></strong
          ><small :title="certificate.subject || ''">{{
            certificate.subject || 'Subject not read'
          }}</small
          ><small class="cert-files">{{
            certificate.credentialId
              ? 'Stored in the credential vault'
              : `${certificate.type === 'pfx' ? fileName(certificate.pfxPath) : `${fileName(certificate.certPath)} · ${fileName(certificate.keyPath)}`} · moves into the vault when you open Credentials`
          }}</small>
        </div>
        <UiBadge :label="certificate.type === 'pfx' ? 'PFX' : 'PEM'" /><UiBadge
          v-bind="expiry(certificate.validTo)"
        />
        <label class="toggle" :title="`${certificate.enabled ? 'Disable' : 'Enable'} certificate`"
          ><input
            type="checkbox"
            role="switch"
            :data-cert-enabled="certificate.id"
            :checked="certificate.enabled"
            :aria-label="`Use certificate for ${certificate.host}`"
            @change="
              setEnabled(certificate, ($event.target as HTMLInputElement).checked)
            " /><span></span
        ></label>
        <UiIconButton
          v-if="!certificate.credentialId"
          :label="`Remove certificate for ${certificate.host}`"
          icon="delete-outline"
          :data-cert-delete="certificate.id"
          @click="remove(certificate)"
        />
      </div>
    </div>
    <UiEmptyState
      v-else
      icon="shield-lock-outline"
      title="No client certificates"
      description="Add a client certificate in Credentials for APIs that require mutual TLS."
    />
  </div>
  <div class="cert-section">
    <div class="cert-section-heading">
      <div>
        <h3>CA certificates</h3>
        <p>
          {{
            caCount
              ? `${caCount} custom CA certificate${caCount === 1 ? '' : 's'} trusted in addition to the system store.`
              : 'Only the system certificate store is trusted.'
          }}
        </p>
      </div>
      <div class="flex gap-2">
        <UiButton
          label="Add CA file"
          icon="import"
          data-ca-add
          :disabled="!desktop"
          @click="addCA"
        />
        <UiButton
          label="Edit PEM bundle"
          icon="pencil-outline"
          variant="ghost"
          data-ca-edit
          @click="editCA"
        />
        <UiButton
          v-if="caCount"
          label="Clear"
          icon="delete-outline"
          variant="ghost"
          data-ca-clear
          @click="clearCA"
        />
      </div>
    </div>
    <p class="field-help">
      Collections and requests can override the CA bundle in their Settings tab. Turning off
      certificate verification is a separate, per-scope TLS setting.
    </p>
  </div>
</template>
