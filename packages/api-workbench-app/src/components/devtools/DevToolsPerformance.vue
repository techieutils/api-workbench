<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive } from 'vue';
import type { NetworkPhase } from '@techieutils/api-workbench-common/types';
import { useToolsStore } from '../../stores/tools';
import MdiIcon from '../MdiIcon.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import { finalPhases, formatBytes, formatMs, percentile, statusTone } from './format';

/** Response times across this session's requests, where they spend it, and the app's own load. */
const tools = useToolsStore();
const CHART_REQUESTS = 60;
const SAMPLES = 60;
const PHASES: { id: NetworkPhase['id']; label: string }[] = [
  { id: 'dns', label: 'DNS' },
  { id: 'tcp', label: 'TCP' },
  { id: 'tls', label: 'TLS' },
  { id: 'sending', label: 'Sending' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'download', label: 'Download' },
];

const stats = computed(() => {
  const entries = tools.networkEntries;
  const times = entries.map((entry) => entry.time).sort((a, b) => a - b);
  const failed = entries.filter((entry) => statusTone(entry) !== 'tone-ok').length;
  return [
    { label: 'Requests', value: String(entries.length), icon: 'lan' },
    {
      label: 'Average',
      value: formatMs(times.length ? times.reduce((a, b) => a + b, 0) / times.length : undefined),
      icon: 'timer-outline',
    },
    { label: 'Median', value: formatMs(percentile(times, 50)), icon: 'chart-line' },
    { label: 'p95', value: formatMs(percentile(times, 95)), icon: 'chart-line' },
    { label: 'Slowest', value: formatMs(times.at(-1)), icon: 'speedometer' },
    {
      label: 'Not 2xx',
      value: entries.length ? `${Math.round((failed / entries.length) * 100)}%` : '—',
      icon: 'alert-circle-outline',
    },
    {
      label: 'Received',
      value: formatBytes(entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)),
      icon: 'download-outline',
    },
  ] satisfies { label: string; value: string; icon: MdiIconName }[];
});

/**
 * The latest requests' response times, as bars scaled to the slowest of them; a few requests get
 * slots for twenty, so their bars stay narrow.
 */
const chart = computed(() => {
  const entries = tools.networkEntries.slice(-CHART_REQUESTS);
  const max = Math.max(1, ...entries.map((entry) => entry.time));
  const slot = 100 / Math.max(20, entries.length);
  return entries.map((entry, index) => ({
    entry,
    x: index * slot,
    width: slot,
    height: Math.max(2, (entry.time / max) * 100),
  }));
});
const chartMax = computed(() =>
  formatMs(Math.max(0, ...tools.networkEntries.slice(-CHART_REQUESTS).map((entry) => entry.time))),
);

/** The average time per phase, over requests with detailed timing. */
const breakdown = computed(() => {
  const timed = tools.networkEntries.filter((entry) => finalPhases(entry).length);
  const totals = PHASES.map((phase) => ({
    ...phase,
    ms:
      timed.reduce(
        (sum, entry) =>
          sum + (finalPhases(entry).find((item) => item.id === phase.id)?.durationMs ?? 0),
        0,
      ) / Math.max(1, timed.length),
  }));
  const total = totals.reduce((sum, phase) => sum + phase.ms, 0);
  return { count: timed.length, total, phases: totals.filter((phase) => phase.ms > 0) };
});

// The application's processes, sampled every two seconds while this tab is open.
const resources = reactive({
  cpu: [] as number[],
  memory: [] as number[],
  processes: 0,
  heap: undefined as number | undefined,
});
let timer: ReturnType<typeof setInterval> | undefined;
async function sample(): Promise<void> {
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  resources.heap = heap?.usedJSHeapSize;
  if (!window.workbench) return;
  try {
    const reading = await window.workbench.runnerResources();
    resources.cpu = [...resources.cpu, reading.cpuPercent].slice(-SAMPLES);
    resources.memory = [...resources.memory, reading.memoryBytes].slice(-SAMPLES);
    resources.processes = reading.processCount;
  } catch {
    /* Readings are best effort; the next sample retries. */
  }
}
onMounted(() => {
  void sample();
  timer = setInterval(() => void sample(), 2000);
});
onBeforeUnmount(() => clearInterval(timer));
/** An SVG polyline for a series, scaled to its own maximum. */
function sparkline(values: number[]): string {
  const max = Math.max(1, ...values);
  return values
    .map((value, index) => `${(index / (SAMPLES - 1)) * 100},${30 - (value / max) * 28}`)
    .join(' ');
}
function reset(): void {
  tools.networkEntries.splice(0);
}
</script>

<template>
  <section class="devtools-performance" aria-label="Performance">
    <div class="devtools-toolbar">
      <span class="devtools-summary">
        Response times for {{ tools.networkEntries.length }} request{{
          tools.networkEntries.length === 1 ? '' : 's'
        }}
        sent this session
      </span>
      <UiIconButton
        label="Clear performance data"
        icon="delete-outline"
        data-performance-clear
        @click="reset"
      />
    </div>
    <div class="performance-content">
      <div class="performance-stats">
        <div
          v-for="stat in stats"
          :key="stat.label"
          class="performance-stat"
          :data-stat="stat.label"
        >
          <span><MdiIcon :name="stat.icon" />{{ stat.label }}</span
          ><strong>{{ stat.value }}</strong>
        </div>
      </div>
      <div class="performance-panels">
        <figure class="performance-card">
          <figcaption>
            Response time <small>last {{ chart.length }} · max {{ chartMax }}</small>
          </figcaption>
          <svg
            v-if="chart.length"
            class="performance-chart"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`Response times of the last ${chart.length} requests`"
          >
            <rect
              v-for="bar in chart"
              :key="bar.entry.id"
              :class="statusTone(bar.entry)"
              :x="bar.x + 0.2"
              :y="100 - bar.height"
              :width="bar.width - 0.4"
              :height="bar.height"
            >
              <title>
                {{ bar.entry.method }} {{ bar.entry.requestName }} · {{ formatMs(bar.entry.time) }}
              </title>
            </rect>
          </svg>
          <p v-else class="devtools-empty">Send requests to chart their response times.</p>
        </figure>
        <figure class="performance-card">
          <figcaption>
            Where time goes
            <small v-if="breakdown.count"
              >average of {{ breakdown.count }} · {{ formatMs(breakdown.total) }}</small
            >
          </figcaption>
          <template v-if="breakdown.phases.length">
            <div class="performance-breakdown" role="img" aria-label="Average time per phase">
              <i
                v-for="phase in breakdown.phases"
                :key="phase.id"
                :class="`phase-${phase.id}`"
                :style="{ width: `${(phase.ms / breakdown.total) * 100}%` }"
                :title="`${phase.label}: ${formatMs(phase.ms)}`"
              ></i>
            </div>
            <ul class="performance-legend">
              <li v-for="phase in breakdown.phases" :key="phase.id">
                <i :class="`phase-${phase.id}`"></i>{{ phase.label }}
                <strong>{{ formatMs(phase.ms) }}</strong>
              </li>
            </ul>
          </template>
          <p v-else class="devtools-empty">
            Detailed timing appears for requests sent from the desktop app.
          </p>
        </figure>
        <figure class="performance-card" data-performance-resources>
          <figcaption>
            Application
            <small v-if="resources.processes">{{ resources.processes }} processes</small>
          </figcaption>
          <div class="performance-resource">
            <span><MdiIcon name="cpu-64-bit" />CPU</span
            ><svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
              <polyline :points="sparkline(resources.cpu)" /></svg
            ><strong>{{
              resources.cpu.length ? `${resources.cpu.at(-1)!.toFixed(1)}%` : '—'
            }}</strong>
          </div>
          <div class="performance-resource">
            <span><MdiIcon name="memory" />Memory</span
            ><svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
              <polyline :points="sparkline(resources.memory)" /></svg
            ><strong>{{ formatBytes(resources.memory.at(-1)) }}</strong>
          </div>
          <div class="performance-resource">
            <span><MdiIcon name="code-braces" />Renderer heap</span><span></span
            ><strong>{{ formatBytes(resources.heap) }}</strong>
          </div>
        </figure>
      </div>
    </div>
  </section>
</template>
