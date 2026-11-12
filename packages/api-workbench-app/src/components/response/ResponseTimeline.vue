<script setup lang="ts">
import { computed } from 'vue';
import { useResponseStore } from '../../stores/response';
import NetworkTimingChart from './NetworkTimingChart.vue';

/** Network timing per hop (whose phases can be captured) and a summary of the exchange. */
const store = useResponseStore();
const props = defineProps<{ request: ApiRequest; response: RequestResponse }>();
const data = computed(() => store.timelineData(props.request, props.response));
const timing = computed(() => props.response.timings);
const duration = (value: number) => `${value.toFixed(2)} ms`;
</script>

<template>
  <div class="response-timeline">
    <NetworkTimingChart v-if="timing" :timing="timing" capture />
    <p v-else class="field-help timing-legacy">
      Detailed timing was not captured for this response. Send the request again to record network
      phases.
    </p>
    <p v-if="response.error !== undefined" class="form-error">{{ response.error }}</p>
    <dl>
      <div>
        <dt>Request</dt>
        <dd>{{ data.request.method }} {{ data.request.url }}</dd>
      </div>
      <div>
        <dt>Response</dt>
        <dd>{{ data.response.status ?? 'Failed' }} {{ data.response.statusText || '' }}</dd>
      </div>
      <div>
        <dt>Total duration</dt>
        <dd>{{ duration(data.totalDurationMs) }}</dd>
      </div>
      <div>
        <dt>Response body</dt>
        <dd>{{ data.responseBodyBytes }} bytes</dd>
      </div>
      <div>
        <dt>Final URL</dt>
        <dd>{{ data.response.finalUrl }}</dd>
      </div>
    </dl>
    <p class="field-help">
      Offsets are measured from request preparation. Waiting includes network latency and time until
      response headers; download includes body decoding. Missing phases are not estimated.
    </p>
  </div>
</template>
