<script setup lang="ts">
import { computed, ref } from 'vue';
import type { RunnerBucket } from '@techieutils/api-workbench-common/runner';
import MdiIcon from '../../MdiIcon.vue';
import { columnPath, compact, niceMax, plotFor, useWidth } from './chart';

/**
 * Throughput, p95 latency, and failures over the run, as three charts on one time axis: they
 * measure different things, so each keeps its own scale. A shared crosshair reads all three.
 */
const props = defineProps<{ buckets: RunnerBucket[]; format: (value: number) => string }>();

const HEIGHT = 84;
const BASE = HEIGHT - 16;
const TOP = 10;
const hovered = ref<number>();
const frame = ref<HTMLElement>();
const width = useWidth(frame);
const PLOT = computed(() => plotFor(width.value));

const band = computed(() => PLOT.value.width / Math.max(1, props.buckets.length));
const seconds = (ms: number) => props.format(ms / 1000);
const charts = computed(() => {
  const buckets = props.buckets;
  const series = [
    {
      id: 'throughput',
      title: 'Throughput',
      unit: 'req/s',
      kind: 'columns' as const,
      values: buckets.map((bucket) => bucket.rps),
    },
    {
      id: 'latency',
      title: 'p95 latency',
      unit: 'ms',
      kind: 'line' as const,
      values: buckets.map((bucket) => bucket.p95),
    },
    {
      id: 'failures',
      title: 'Failed requests',
      unit: 'failed',
      kind: 'columns' as const,
      values: buckets.map((bucket) => bucket.failed),
    },
  ];
  return series.map((chart) => {
    const max = niceMax(Math.max(0, ...chart.values));
    const y = (value: number) => BASE - (value / max) * (BASE - TOP);
    const x = (index: number) => PLOT.value.left + band.value * index;
    const width = Math.min(24, Math.max(1, band.value - 2));
    return {
      ...chart,
      max,
      columns:
        chart.kind === 'columns'
          ? chart.values.flatMap((value, index) =>
              value > 0
                ? [columnPath(x(index) + (band.value - width) / 2, width, y(value), BASE)]
                : [],
            )
          : [],
      // Intervals with no completed request have no latency, so the line breaks across them.
      line:
        chart.kind === 'line'
          ? buckets
              .map((bucket, index) =>
                bucket.completed
                  ? `${index && buckets[index - 1].completed ? 'L' : 'M'}${x(index) + band.value / 2},${y(chart.values[index])}`
                  : '',
              )
              .join(' ')
          : '',
      end:
        chart.kind === 'line' && buckets.at(-1)?.completed
          ? { x: x(buckets.length - 1) + band.value / 2, y: y(chart.values.at(-1)!) }
          : undefined,
    };
  });
});
const total = computed(() => props.buckets.reduce((sum, bucket) => sum + bucket.failed, 0));
const crosshair = computed(() =>
  hovered.value === undefined ? undefined : PLOT.value.left + band.value * (hovered.value + 0.5),
);
const readout = computed(() => {
  const bucket = hovered.value === undefined ? props.buckets.at(-1) : props.buckets[hovered.value];
  if (!bucket) return undefined;
  return {
    range: `${seconds(bucket.startMs)}–${seconds(bucket.startMs + bucket.durationMs)} s`,
    rps: props.format(bucket.rps),
    p95: bucket.completed ? props.format(bucket.p95) : '—',
    failed: bucket.failed,
    completed: bucket.completed,
    latest: hovered.value === undefined,
  };
});

function pointAt(event: PointerEvent): void {
  const box = (event.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * PLOT.value.viewWidth;
  const index = Math.floor((x - PLOT.value.left) / band.value);
  hovered.value = Math.min(props.buckets.length - 1, Math.max(0, index));
}
function onKeydown(event: KeyboardEvent): void {
  const last = props.buckets.length - 1;
  const current = hovered.value ?? last;
  const next =
    event.key === 'ArrowLeft'
      ? current - 1
      : event.key === 'ArrowRight'
        ? current + 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : undefined;
  if (event.key === 'Escape') hovered.value = undefined;
  if (next === undefined) return;
  event.preventDefault();
  hovered.value = Math.min(last, Math.max(0, next));
}
</script>

<template>
  <section class="runner-chart runner-activity">
    <h3>Activity over time</h3>
    <p class="field-help">
      Per {{ seconds(buckets[0]?.durationMs || 1000) }}-second interval, by when requests completed.
      Point at a chart, or focus it and use the arrow keys, to read an interval.
    </p>
    <!-- Values lead the readout; it shows the latest interval until one is chosen. -->
    <p v-if="readout" class="runner-chart-readout" aria-live="polite">
      <span>{{ readout.latest ? 'Latest' : 'Interval' }} {{ readout.range }}</span>
      <span
        ><strong>{{ readout.rps }}</strong> req/s</span
      ><span
        ><strong>{{ readout.p95 }}</strong> ms p95</span
      ><span
        ><strong>{{ readout.failed }}</strong> of {{ readout.completed }} failed</span
      >
    </p>
    <div
      ref="frame"
      class="runner-activity-charts"
      role="group"
      tabindex="0"
      aria-label="Throughput, p95 latency, and failed requests per interval"
      @keydown="onKeydown"
      @blur="hovered = undefined"
    >
      <figure v-for="chart in charts" :key="chart.id" :class="['runner-small-chart', chart.id]">
        <figcaption>
          <MdiIcon v-if="chart.id === 'failures'" name="close-circle-outline" />{{ chart.title }}
          <small v-if="chart.id === 'failures'">{{ total }} in total</small>
        </figcaption>
        <svg
          :viewBox="`0 0 ${PLOT.viewWidth} ${HEIGHT}`"
          role="img"
          :aria-label="`${chart.title} per interval`"
        >
          <line class="axis" :x1="PLOT.left" :y1="BASE" :x2="PLOT.right" :y2="BASE" />
          <text class="tick" x="0" :y="TOP + 4">{{ compact(chart.max) }}</text>
          <text class="tick" x="0" :y="BASE">0</text>
          <path v-for="(column, index) in chart.columns" :key="index" class="mark" :d="column" />
          <path v-if="chart.line" class="mark-line" :d="chart.line" />
          <circle v-if="chart.end" class="mark-end" :cx="chart.end.x" :cy="chart.end.y" r="4" />
          <line
            v-if="crosshair !== undefined"
            class="crosshair"
            :x1="crosshair"
            :y1="TOP - 4"
            :x2="crosshair"
            :y2="BASE"
          />
          <rect
            class="hit"
            :x="PLOT.left"
            y="0"
            :width="PLOT.width"
            :height="BASE"
            @pointermove="pointAt"
            @pointerleave="hovered = undefined"
          />
        </svg>
      </figure>
      <div class="runner-chart-axis" aria-hidden="true">
        <span>0 s</span
        ><span
          >{{ seconds((buckets.at(-1)?.startMs ?? 0) + (buckets.at(-1)?.durationMs ?? 0)) }} s</span
        >
      </div>
    </div>
    <details class="runner-table-view">
      <summary>Show as table</summary>
      <div class="table-scroll">
        <table class="runner-table">
          <thead>
            <tr>
              <th>Interval (s)</th>
              <th>Completed</th>
              <th>Req/s</th>
              <th>Avg ms</th>
              <th>p95 ms</th>
              <th>Failed</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="bucket in buckets" :key="bucket.startMs">
              <td>
                {{ seconds(bucket.startMs) }}–{{ seconds(bucket.startMs + bucket.durationMs) }}
              </td>
              <td>{{ bucket.completed }}</td>
              <td>{{ format(bucket.rps) }}</td>
              <td>{{ bucket.completed ? format(bucket.average) : '—' }}</td>
              <td>{{ bucket.completed ? format(bucket.p95) : '—' }}</td>
              <td>{{ bucket.failed }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </section>
</template>
