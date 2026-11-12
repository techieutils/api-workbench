<script setup lang="ts">
import { ref, watch } from 'vue';
import type { OAuthDiscovery } from '@techieutils/api-workbench-common/oauth-discovery';
import { errorMessage } from '../../../utils';
import MdiIcon from '../../MdiIcon.vue';
import UiButton from '../../ui/UiButton.vue';
import UiExpansionPanel from '../../ui/UiExpansionPanel.vue';

/**
 * Finds OAuth endpoints from an API, issuer, or well-known metadata URL and hands them to the
 * form, which applies them and reports what changed. The outcome is passed back in, so it
 * survives forms that are rebuilt when their values change.
 */
const props = defineProps<{
  /** Prefilled URL, such as the request URL or the credential's allowed origin. */
  url?: string;
  outcome?: { discovery: OAuthDiscovery; changes: string[] };
  /** Whether the panel is open; forms open it until their endpoints are set. */
  open?: boolean;
}>();
const emit = defineEmits<{ discovered: [discovery: OAuthDiscovery, url: string] }>();
const available = Boolean(window.workbench?.oauth?.discover);
const target = ref(props.url || '');
watch(
  () => props.url,
  (url) => {
    if (url && !target.value) target.value = url;
  },
);
const pending = ref(false);
const error = ref('');
const sourceLabel = (discovery: OAuthDiscovery) =>
  discovery.source === 'openid-configuration'
    ? 'OpenID Connect discovery'
    : 'OAuth server metadata';

async function discover(): Promise<void> {
  if (!target.value.trim() || pending.value) return;
  pending.value = true;
  error.value = '';
  try {
    emit(
      'discovered',
      await window.workbench!.oauth.discover(target.value.trim()),
      target.value.trim(),
    );
  } catch (failure) {
    error.value = errorMessage(failure);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <UiExpansionPanel
    v-if="available"
    class="oauth-discover"
    title="Discover settings"
    description="Fill the endpoints from what the API or authorization server publishes"
    icon="magnify"
    :badge="outcome ? 'Discovered' : undefined"
    :open="open || Boolean(outcome) || Boolean(error)"
  >
    <label class="form-field"
      ><span>API, issuer, or metadata URL</span>
      <div class="oauth-discover-row">
        <input
          v-model="target"
          class="field-input"
          type="url"
          data-oauth-discover-url
          placeholder="https://api.example.com or https://login.example.com"
          autocomplete="off"
          spellcheck="false"
          @keydown.enter.prevent="discover"
        /><UiButton
          :label="pending ? 'Discovering…' : 'Discover'"
          :icon="pending ? 'loading' : 'magnify'"
          data-oauth-discover
          :disabled="pending || !target.trim()"
          @click="discover"
        />
      </div>
    </label>
    <p class="field-help">
      Enter the API's URL, the authorization server (issuer), or a <code>/.well-known/</code> URL.
      The endpoints, resource, and scopes it publishes fill the fields below.
    </p>
    <p v-if="error" class="form-error" role="alert" data-oauth-discover-error>{{ error }}</p>
    <div
      v-else-if="outcome"
      class="info-callout oauth-discover-result"
      role="status"
      data-oauth-discover-result
    >
      <MdiIcon name="check-circle-outline" />
      <div>
        <strong>{{
          outcome.changes.length
            ? `Filled ${outcome.changes.join(', ')}`
            : 'The fields already match the published settings'
        }}</strong>
        <small
          >From {{ outcome.discovery.issuer }} · {{ sourceLabel(outcome.discovery)
          }}<template v-if="outcome.discovery.resource">
            · for {{ outcome.discovery.resourceName || outcome.discovery.resource }}</template
          ></small
        >
        <small v-if="!outcome.discovery.resourceScopes && outcome.discovery.supportedScopes?.length"
          >Scopes offered: {{ outcome.discovery.supportedScopes.slice(0, 12).join(' ')
          }}{{ outcome.discovery.supportedScopes.length > 12 ? ' …' : '' }}</small
        >
        <small v-if="outcome.discovery.registrationUrl"
          >The server accepts dynamic client registration.</small
        >
        <small
          v-for="warning in outcome.discovery.warnings"
          :key="warning"
          class="oauth-discover-warning"
          ><MdiIcon name="clock-alert-outline" />{{ warning }}</small
        >
      </div>
    </div>
  </UiExpansionPanel>
</template>
