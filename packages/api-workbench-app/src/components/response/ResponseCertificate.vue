<script setup lang="ts">
import { computed } from 'vue';
import { useWorkspaceStore } from '../../stores/workspace';
import { useResponseStore } from '../../stores/response';
import UiEmptyState from '../ui/UiEmptyState.vue';
import CertificateDetails from './CertificateDetails.vue';

/** The server certificate chain captured from the request's TLS connection. */
// Each send replaces the response (and its TLS details), so these computeds track new ones.
const store = useResponseStore();
const workspace = useWorkspaceStore();
const request = () => workspace.current();
const tls = computed(() => request().response?.tls);
const unavailable = computed(
  () => (store.certificateData(request()) as { message: string }).message,
);
</script>

<template>
  <UiEmptyState
    v-if="!tls"
    class="response-empty"
    icon="shield-lock-outline"
    title="Certificate unavailable"
    :description="unavailable"
  />
  <CertificateDetails v-else :tls="tls" capture />
</template>
