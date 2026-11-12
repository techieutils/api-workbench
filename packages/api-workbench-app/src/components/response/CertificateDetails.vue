<script setup lang="ts">
import { computed } from 'vue';
import type { TLSConnectionInfo } from '@techieutils/api-workbench-common/types';
import { captureVariableName } from '@techieutils/api-workbench-common/capture-suggestions';
import { useContextMenu } from '../../composables/context-menu';
import { useRequestTestsStore } from '../../stores/request-tests';
import { useWorkspaceStore } from '../../stores/workspace';
import { download as saveFile, toast } from '../../utils';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import MdiIcon from '../MdiIcon.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';

/**
 * A TLS connection and its server certificate chain. Each field's menu copies it and, with
 * `capture`, captures it (`certificate <field>`) into a request: the current one, or
 * `requestId`'s, which then opens (History).
 */
const props = defineProps<{
  tls: TLSConnectionInfo;
  capture?: boolean;
  requestId?: string;
  /** Why capturing is unavailable, shown with the disabled item (a deleted request). */
  captureUnavailable?: string;
}>();
const workspace = useWorkspaceStore();
const tests = useRequestTestsStore();
type Certificate = TLSConnectionInfo['chain'][number];

/** A shown field; `source` is its capture, for fields a response capture can read. */
interface Field {
  key: string;
  label: string;
  value: string;
  wide?: boolean;
  source?: string;
  name?: string;
}
/** A field of the connection, or of chain certificate `index`, captured as `certificate <field>`. */
function field(
  label: string,
  value: string,
  capture?: string,
  index?: number,
  wide = false,
): Field {
  const position = index ? ` ${index + 1}` : '';
  return {
    key: capture ? `${index === undefined ? '' : `${index + 1}:`}${capture}` : label,
    label,
    value,
    wide,
    ...(capture
      ? {
          source: `certificate ${capture}${position}`,
          name: `cert_${capture.replace(/-/g, '_')}${index ? `_${index + 1}` : ''}`,
        }
      : {}),
  };
}
const connectionFields = computed(() => {
  const tls = props.tls;
  return [
    field('Host', `${tls.host}:${tls.port}`, 'host'),
    field('TLS protocol', tls.protocol, 'protocol'),
    field('Cipher suite', tls.cipher.standardName || tls.cipher.name, 'cipher'),
    field('ALPN protocol', tls.alpnProtocol || 'Not negotiated', 'alpn'),
    field(
      'TLS session',
      tls.sessionResumed
        ? 'Resumed (certificate retained from the original session)'
        : 'Full handshake',
    ),
    field(
      'Client certificate',
      tls.clientCertificate ? tls.clientCertificate.subject : 'None presented',
    ),
  ];
});
function validity(certificate: Certificate): string {
  const from = Date.parse(certificate.validFrom),
    to = Date.parse(certificate.validTo),
    now = Date.now();
  return now < from ? 'Not yet valid' : now > to ? 'Expired' : 'Within validity dates';
}
function title(certificate: Certificate, index: number): string {
  return (
    certificate.subject
      .split('\n')
      .find((part) => part.startsWith('CN='))
      ?.slice(3) ||
    certificate.subject ||
    `Certificate ${index + 1}`
  );
}
function fields(certificate: Certificate, index: number): Field[] {
  return [
    field('Subject', certificate.subject, 'subject', index),
    field('Issuer', certificate.issuer, 'issuer', index),
    field('Valid from', new Date(certificate.validFrom).toLocaleString(), 'valid-from', index),
    field('Valid until', new Date(certificate.validTo).toLocaleString(), 'valid-to', index),
    field('Serial number', certificate.serialNumber, 'serial', index),
    field(
      'Public key',
      `${certificate.publicKeyType.toUpperCase()}${certificate.keyBits ? ` · ${certificate.keyBits} bits` : ''}`,
      'public-key',
      index,
    ),
    field('Subject alternative names', certificate.subjectAltName, 'san', index, true),
    field('SHA-256 fingerprint', certificate.fingerprint256, 'sha256', index, true),
    field('SHA-1 fingerprint', certificate.fingerprint, 'sha1', index, true),
  ];
}
const download = (index: number, certificate: Certificate) =>
  saveFile(`server-certificate-${index + 1}.pem`, certificate.pem, 'application/x-pem-file');

const { menu, target, open, onKeydown } = useContextMenu<Field>();
const items = computed<MenuItem[]>(() => [
  { id: 'copy', label: 'Copy value', icon: 'content-copy' },
  ...(props.capture && target.value?.source
    ? [
        {
          id: 'capture',
          label: props.captureUnavailable
            ? `Capture into a variable · ${props.captureUnavailable}`
            : 'Capture into a variable',
          icon: 'variable',
          separated: true,
          disabled: Boolean(props.captureUnavailable),
        } satisfies MenuItem,
      ]
    : []),
]);
async function select(command: string): Promise<void> {
  const row = target.value;
  if (!row) return;
  if (command === 'capture' && row.source && row.name) {
    const request = props.requestId
      ? workspace.state.requests.find((item) => item.id === props.requestId)
      : workspace.current();
    const taken = (request?.captures ?? []).map((capture) => capture.key.trim());
    tests.addCapture(
      captureVariableName(undefined, taken, row.name),
      row.source,
      `the certificate's ${row.label.toLowerCase()}`,
      props.requestId,
    );
    return;
  }
  try {
    await navigator.clipboard.writeText(row.value);
    toast(`${row.label} copied`, 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
</script>

<template>
  <div class="certificate-inspector">
    <div class="certificate-heading">
      <div>
        <MdiIcon name="shield-lock-outline" />
        <h3>Server certificate</h3>
      </div>
      <UiBadge
        :label="tls.authorized ? 'Verified at connection' : 'Not verified'"
        :tone="tls.authorized ? 'success' : 'danger'"
      />
    </div>
    <p class="field-help">
      Captured from this request's TLS connection at
      {{ new Date(tls.capturedAt).toLocaleString() }}. Reused connections retain the same
      certificate details.
    </p>
    <p v-if="tls.authorizationError" class="form-error">{{ tls.authorizationError }}</p>
    <dl class="certificate-grid">
      <div
        v-for="field in connectionFields"
        :key="field.label"
        class="certificate-field"
        tabindex="0"
        :data-certificate-field="field.key"
        @contextmenu="open($event, field)"
        @keydown="onKeydown($event, field)"
      >
        <dt>{{ field.label }}</dt>
        <dd>{{ field.value || '—' }}</dd>
      </div>
    </dl>
    <p v-if="tls.clientCertificate" class="field-help certificate-client-note">
      <MdiIcon name="shield-lock-outline" />Mutual TLS: presented a client certificate{{
        tls.clientCertificate.issuer ? ` issued by ${tls.clientCertificate.issuer}` : ''
      }}{{
        tls.clientCertificate.validTo
          ? `, valid until ${new Date(tls.clientCertificate.validTo).toLocaleDateString()}`
          : ''
      }}.
    </p>
    <h3 class="certificate-chain-heading">Certificate chain · {{ tls.chain.length }}</h3>
    <p class="field-help">
      Public peer certificates available from the connection, leaf first. A root may be omitted.
    </p>
    <details
      v-for="(certificate, index) in tls.chain"
      :key="certificate.fingerprint256"
      class="certificate-card"
      :open="index === 0"
    >
      <summary>
        <span
          >{{ index === 0 ? 'Leaf' : certificate.ca ? 'CA' : 'Issuer' }} ·
          {{ title(certificate, index) }}</span
        ><UiBadge
          :label="validity(certificate)"
          :tone="validity(certificate) === 'Within validity dates' ? 'neutral' : 'warning'"
        />
      </summary>
      <dl class="certificate-grid">
        <div
          v-for="field in fields(certificate, index)"
          :key="field.label"
          :class="['certificate-field', { 'certificate-wide': field.wide }]"
          tabindex="0"
          :data-certificate-field="field.key"
          @contextmenu="open($event, field)"
          @keydown="onKeydown($event, field)"
        >
          <dt>{{ field.label }}</dt>
          <dd>{{ field.value || '—' }}</dd>
        </div>
      </dl>
      <div class="certificate-pem-heading">
        <strong>Public certificate · PEM</strong
        ><UiButton
          label="Download PEM"
          icon="download"
          variant="ghost"
          :data-certificate-download="index"
          @click="download(index, certificate)"
        />
      </div>
      <pre class="certificate-pem">{{ certificate.pem }}</pre>
    </details>
    <ContextMenu
      ref="menu"
      label="Certificate field actions"
      :items="items"
      data-certificate-menu
      @select="select"
    />
  </div>
</template>
