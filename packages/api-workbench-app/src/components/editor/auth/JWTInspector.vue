<script setup lang="ts">
import { computed } from 'vue';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useAuthenticationStore } from '../../../stores/authentication';
import MdiIcon from '../../MdiIcon.vue';
import UiBadge from '../../ui/UiBadge.vue';
import { decodeJWT } from '@techieutils/api-workbench-common/variables';

/** Decodes a bearer JWT locally; the signature is never verified or sent anywhere. */
const props = defineProps<{ token: string }>();
const store = useAuthenticationStore();
const workspace = useWorkspaceStore();
const decoded = computed(() =>
  props.token ? decodeJWT(workspace.resolve(props.token)) : undefined,
);
const claims = computed(() =>
  decoded.value
    ? (['sub', 'iss', 'aud', 'scope'] as const)
        .filter((claim) => decoded.value!.payload[claim] !== undefined)
        .map((claim) => {
          const value = decoded.value!.payload[claim];
          return { claim, value: typeof value === 'string' ? value : JSON.stringify(value) };
        })
    : [],
);
</script>

<template>
  <details
    v-if="decoded"
    id="jwt-inspector"
    class="jwt-inspector"
    :open="store.jwtInspectorOpen"
    @toggle="store.jwtInspectorOpen = ($event.target as HTMLDetailsElement).open"
  >
    <summary>
      <MdiIcon name="card-account-details-outline" /><span>JSON Web Token</span
      ><UiBadge :label="String(decoded.header.alg || 'unknown alg')" /><UiBadge
        v-if="decoded.expiresAt"
        :label="`${decoded.expired ? 'Expired' : 'Expires'} ${new Date(decoded.expiresAt).toLocaleString()}`"
        :tone="decoded.expired ? 'danger' : 'success'"
      /><UiBadge v-else label="No expiry claim" />
    </summary>
    <dl class="jwt-claims">
      <div v-for="item in claims" :key="item.claim">
        <dt>{{ item.claim }}</dt>
        <dd>{{ item.value }}</dd>
      </div>
      <div v-if="decoded.issuedAt">
        <dt>Issued</dt>
        <dd>{{ new Date(decoded.issuedAt).toLocaleString() }}</dd>
      </div>
    </dl>
    <div class="jwt-sections">
      <div>
        <span>Header</span>
        <pre>{{ JSON.stringify(decoded.header, null, 2) }}</pre>
      </div>
      <div>
        <span>Payload</span>
        <pre>{{ JSON.stringify(decoded.payload, null, 2) }}</pre>
      </div>
    </div>
    <p class="field-help">Decoded on this device. The signature is not verified.</p>
  </details>
  <div v-else id="jwt-inspector" hidden></div>
</template>
