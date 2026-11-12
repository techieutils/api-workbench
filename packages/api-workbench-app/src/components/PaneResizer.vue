<script setup lang="ts">
import { ref } from 'vue';

/**
 * A draggable divider between two panes. It reports the size under the pointer through
 * `measure`, which turns a pointer position into the size it controls, and stays keyboard
 * operable: arrow keys step, Home and End jump to the limits, and a double-click resets.
 */
const props = withDefaults(
  defineProps<{
    /** `columns` separates side-by-side panes (drag left and right); `rows` stacks them. */
    direction: 'columns' | 'rows';
    label: string;
    value: number;
    min: number;
    max: number;
    reset: number;
    /** How far one arrow key press moves the divider. */
    step?: number;
    /**
     * True when the sized pane sits after the divider (right of or below it), so arrows toward the
     * start of the axis grow it.
     */
    reversed?: boolean;
    measure: (point: { x: number; y: number }) => number;
  }>(),
  { step: 5, reversed: false },
);
const emit = defineEmits<{ change: [value: number]; commit: [] }>();

const element = ref<HTMLElement>();
const clamp = (value: number) => Math.min(props.max, Math.max(props.min, Math.round(value)));
function onPointerDown(event: PointerEvent): void {
  element.value?.setPointerCapture(event.pointerId);
  event.preventDefault();
}
function onPointerMove(event: PointerEvent): void {
  if (!element.value?.hasPointerCapture(event.pointerId)) return;
  emit('change', clamp(props.measure({ x: event.clientX, y: event.clientY })));
}
function onPointerUp(event: PointerEvent): void {
  if (!element.value?.hasPointerCapture(event.pointerId)) return;
  element.value.releasePointerCapture(event.pointerId);
  emit('commit');
}
function onKeydown(event: KeyboardEvent): void {
  const toStart = ['ArrowLeft', 'ArrowUp'].includes(event.key);
  const toEnd = ['ArrowRight', 'ArrowDown'].includes(event.key);
  if (!toStart && !toEnd && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  const delta = (toStart ? -props.step : props.step) * (props.reversed ? -1 : 1);
  emit(
    'change',
    event.key === 'Home' ? props.min : event.key === 'End' ? props.max : clamp(props.value + delta),
  );
  emit('commit');
}
function onDoubleClick(): void {
  emit('change', clamp(props.reset));
  emit('commit');
}
</script>

<template>
  <div
    ref="element"
    :class="['pane-resizer', direction]"
    role="separator"
    tabindex="0"
    title="Drag to resize · Double-click to reset"
    :aria-label="label"
    :aria-orientation="direction === 'columns' ? 'vertical' : 'horizontal'"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="value"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @dblclick="onDoubleClick"
    @keydown="onKeydown"
  >
    <span class="pane-grip" aria-hidden="true"></span>
  </div>
</template>
