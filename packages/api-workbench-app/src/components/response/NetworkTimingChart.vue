<script setup lang="ts">
import { computed } from 'vue';
import type { NetworkHop, NetworkTiming } from '@techieutils/api-workbench-common/types';
import { captureVariableName } from '@techieutils/api-workbench-common/capture-suggestions';
import { useContextMenu } from '../../composables/context-menu';
import { useRequestTestsStore } from '../../stores/request-tests';
import { useWorkspaceStore } from '../../stores/workspace';
import { toast } from '../../utils';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';

/**
 * The network timing waterfall: each request of the exchange (redirect hops included) and its
 * phases on a shared axis. With `capture`, the total and each phase have a menu that copies the
 * duration or captures it (`timing <phase>`) into a request: the current one, or `requestId`'s.
 */
const props = defineProps<{
  timing: NetworkTiming;
  capture?: boolean;
  /** The request captures go to, which then opens (History); the current one otherwise. */
  requestId?: string;
  /** Why capturing is unavailable, shown with the disabled item (a deleted request). */
  captureUnavailable?: string;
}>();
const workspace = useWorkspaceStore();
const tests = useRequestTestsStore();
const duration = (value: number) => `${value.toFixed(2)} ms`;
const scale = (value: number) => (value / Math.max(props.timing.totalMs, 1)) * 1000;
function hopNote(hop: NetworkHop): string {
  if (hop.connectionReused) return 'Reused connection: DNS, TCP, and TLS setup were skipped.';
  if (!hop.phases.some((phase) => phase.id === 'tcp'))
    return 'Some transport phases were unavailable or did not complete.';
  return `${hop.phases.some((phase) => phase.id === 'dns') ? '' : 'DNS was not required or not recorded. '}${hop.url.startsWith('https:') ? '' : 'TLS is not used for HTTP.'}`;
}

/** What a row's menu acts on: its duration, and the capture that reads it from a response. */
interface TimingTarget {
  label: string;
  ms: number;
  source: string;
  name: string;
}
const total = computed<TimingTarget>(() => ({
  label: 'Total time',
  ms: props.timing.totalMs,
  source: 'timing total',
  name: 'total_ms',
}));
/** A phase of hop `index`: the last hop is the response's, so it needs no number. */
function phaseTarget(index: number, phase: NetworkHop['phases'][number]): TimingTarget {
  const last = index === props.timing.requests.length - 1;
  return {
    label: phase.label,
    ms: phase.durationMs,
    source: `timing ${phase.id}${last ? '' : ` ${index + 1}`}`,
    name: `${phase.id}_ms${last ? '' : `_${index + 1}`}`,
  };
}
const { menu, target, open, onKeydown } = useContextMenu<TimingTarget>();
const items = computed<MenuItem[]>(() => [
  { id: 'copy', label: 'Copy duration', icon: 'content-copy' },
  {
    id: 'capture',
    label: props.captureUnavailable
      ? `Capture into a variable · ${props.captureUnavailable}`
      : 'Capture into a variable',
    icon: 'variable',
    separated: true,
    disabled: Boolean(props.captureUnavailable),
  },
]);
async function select(command: string): Promise<void> {
  const row = target.value;
  if (!row) return;
  if (command === 'capture') {
    const request = props.requestId
      ? workspace.state.requests.find((item) => item.id === props.requestId)
      : workspace.current();
    const taken = (request?.captures ?? []).map((capture) => capture.key.trim());
    tests.addCapture(
      captureVariableName(undefined, taken, row.name),
      row.source,
      row.label.toLowerCase(),
      props.requestId,
    );
    return;
  }
  try {
    await navigator.clipboard.writeText(String(Math.round(row.ms * 100) / 100));
    toast(`${row.label} copied`, 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
</script>

<template>
  <div class="network-timing">
    <div
      class="timing-heading"
      :tabindex="capture ? 0 : undefined"
      data-timing-row="total"
      @contextmenu="capture && open($event, total)"
      @keydown="capture && onKeydown($event, total)"
    >
      <strong>Network timing</strong><span>{{ duration(timing.totalMs) }}</span>
    </div>
    <div class="timing-axis">
      <span>0 ms</span><span>{{ duration(timing.totalMs / 2) }}</span
      ><span>{{ duration(timing.totalMs) }}</span>
    </div>
    <div v-if="timing.preparationMs > 0" class="timing-preparation">
      Request preparation <span>{{ duration(timing.preparationMs) }}</span>
    </div>
    <div v-for="(hop, index) in timing.requests" :key="index" class="timing-hop">
      <div class="timing-hop-title">
        <span
          >{{ timing.requests.length > 1 ? `#${index + 1} · ` : '' }}{{ hop.method }}
          {{ hop.url }}</span
        ><strong>{{ hop.status || 'Incomplete' }}</strong>
      </div>
      <div
        v-for="phase in hop.phases"
        :key="phase.id"
        class="timing-row"
        :tabindex="capture ? 0 : undefined"
        :data-timing-row="`${index + 1}:${phase.id}`"
        @contextmenu="capture && open($event, phaseTarget(index, phase))"
        @keydown="capture && onKeydown($event, phaseTarget(index, phase))"
      >
        <span class="timing-label">{{ phase.label }}</span>
        <svg
          class="timing-track"
          viewBox="0 0 1000 20"
          preserveAspectRatio="none"
          role="img"
          :aria-label="`${phase.label}: ${duration(phase.durationMs)}`"
        >
          <rect class="timing-track-bg" x="0" y="4" width="1000" height="12" rx="2" />
          <rect
            :class="['timing-fill', phase.id]"
            :x="Math.min(999, Math.max(0, scale(phase.startMs)))"
            y="4"
            :width="Math.max(1, Math.min(1000, scale(phase.durationMs)))"
            height="12"
            rx="2"
          />
        </svg>
        <span class="timing-duration">{{ duration(phase.durationMs) }}</span>
      </div>
      <p class="timing-note">{{ hopNote(hop) }}</p>
    </div>
    <ContextMenu
      v-if="capture"
      ref="menu"
      label="Timing actions"
      :items="items"
      data-timing-menu
      @select="select"
    />
  </div>
</template>
