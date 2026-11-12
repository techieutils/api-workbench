<script setup lang="ts">
import { computed, ref } from 'vue';
import { columnPath, compact, niceMax, plotFor, useWidth } from './chart';

/** How client latency is spread across requests, with the p95 marked. */
const props = defineProps<{
  bins: { fromMs: number; toMs: number; count: number }[];
  p95: number;
  format: (value: number) => string;
}>();

const HEIGHT = 140;
const BASE = HEIGHT - 20;
const TOP = 22;
const hovered = ref<number>();
const frame = ref<HTMLElement>();
const width = useWidth(frame);
const PLOT = computed(() => plotFor(width.value));

const band = computed(() => PLOT.value.width / Math.max(1, props.bins.length));
const max = computed(() => niceMax(Math.max(0, ...props.bins.map((bin) => bin.count))));
const low = computed(() => props.bins[0]?.fromMs ?? 0);
const high = computed(() => props.bins.at(-1)?.toMs ?? 0);
const columns = computed(() => {
  const width = Math.min(24, Math.max(1, band.value - 2));
  return props.bins.map((bin, index) => ({
    path:
      bin.count > 0
        ? columnPath(
            PLOT.value.left + band.value * index + (band.value - width) / 2,
            width,
            BASE - (bin.count / max.value) * (BASE - TOP),
            BASE,
          )
        : '',
  }));
});
const p95X = computed(() =>
  high.value > low.value
    ? PLOT.value.left + ((props.p95 - low.value) / (high.value - low.value)) * PLOT.value.width
    : undefined,
);
const range = (bin: { fromMs: number; toMs: number }) =>
  `${props.format(bin.fromMs)}–${props.format(bin.toMs)} ms`;
const readout = computed(() => {
  const bin = hovered.value === undefined ? undefined : props.bins[hovered.value];
  return bin ? { range: range(bin), count: bin.count } : undefined;
});

function pointAt(event: PointerEvent): void {
  const box = (event.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * PLOT.value.viewWidth;
  hovered.value = Math.min(
    props.bins.length - 1,
    Math.max(0, Math.floor((x - PLOT.value.left) / band.value)),
  );
}
function onKeydown(event: KeyboardEvent): void {
  const last = props.bins.length - 1;
  const current = hovered.value ?? -1;
  const next =
    event.key === 'ArrowLeft'
      ? Math.max(0, current - 1)
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
  hovered.value = Math.min(last, next);
}
</script>

<template>
  <section class="runner-chart runner-distribution">
    <h3>Latency distribution</h3>
    <p class="runner-chart-readout" aria-live="polite">
      <template v-if="readout"
        ><span>{{ readout.range }}</span
        ><span
          ><strong>{{ readout.count }}</strong> requests</span
        ></template
      >
      <span v-else>Point at a bar, or focus the chart and use the arrow keys.</span>
    </p>
    <div ref="frame" class="runner-chart-frame">
      <svg
        :viewBox="`0 0 ${PLOT.viewWidth} ${HEIGHT}`"
        role="img"
        tabindex="0"
        aria-label="Number of requests by client latency"
        @keydown="onKeydown"
        @blur="hovered = undefined"
      >
        <line class="axis" :x1="PLOT.left" :y1="BASE" :x2="PLOT.right" :y2="BASE" />
        <text class="tick" x="0" :y="TOP + 4">{{ compact(max) }}</text>
        <text class="tick" x="0" :y="BASE">0</text>
        <template v-for="(column, index) in columns" :key="index">
          <path
            v-if="column.path"
            :class="['mark', { hovered: index === hovered }]"
            :d="column.path"
          />
        </template>
        <g v-if="p95X !== undefined" class="marker">
          <line :x1="p95X" :y1="TOP - 8" :x2="p95X" :y2="BASE" />
          <text :x="Math.min(p95X + 4, PLOT.right - 70)" :y="TOP - 10">
            p95 {{ format(p95) }} ms
          </text>
        </g>
        <text class="tick" :x="PLOT.left" :y="HEIGHT - 4">{{ format(low) }} ms</text>
        <text class="tick" :x="PLOT.right" :y="HEIGHT - 4" text-anchor="end">
          {{ format(high) }} ms
        </text>
        <rect
          class="hit"
          :x="PLOT.left"
          :y="TOP - 8"
          :width="PLOT.width"
          :height="BASE - TOP + 8"
          @pointermove="pointAt"
          @pointerleave="hovered = undefined"
        />
      </svg>
    </div>
    <details class="runner-table-view">
      <summary>Show as table</summary>
      <div class="table-scroll">
        <table class="runner-table">
          <thead>
            <tr>
              <th>Latency (ms)</th>
              <th>Requests</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="bin in bins" :key="bin.fromMs">
              <td>{{ range(bin) }}</td>
              <td>{{ bin.count }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </section>
</template>
