/** Shared geometry and helpers for the Runner's inline SVG charts. */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

export interface Plot {
  /** The SVG's width in pixels, so text and marks draw at their real size. */
  viewWidth: number;
  left: number;
  right: number;
  width: number;
}
/** A gutter for tick labels, then the plot, across the measured width. */
export const plotFor = (width: number): Plot => ({
  viewWidth: width,
  left: 44,
  right: width - 16,
  width: Math.max(1, width - 60),
});

/** Follows an element's width, so a chart can draw in pixels instead of scaling a viewBox. */
export function useWidth(element: Ref<Element | undefined>, initial = 760): Ref<number> {
  const width = ref(initial);
  let observer: ResizeObserver | undefined;
  let frame = 0;
  onMounted(() => {
    // The new width is applied on the next frame: redrawing inside the observer's callback can
    // change layout again in the same frame, which the browser reports as an observer loop.
    observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      cancelAnimationFrame(frame);
      if (next > 0) frame = requestAnimationFrame(() => (width.value = next));
    });
    observer.observe(element.value!);
  });
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
  });
  return width;
}

/** A clean upper bound for an axis, close above the largest value. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
    .map((step) => step * power)
    .find((step) => step >= value)!;
}

/** Compact tick text: 950, 1.2K, 3.4M. */
export function compact(value: number): string {
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(1))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toFixed(1))}K`;
  return String(Number(value.toFixed(value < 10 ? 1 : 0)));
}

/** A column growing from the baseline, rounded only at its data end. */
export function columnPath(x: number, width: number, top: number, base: number): string {
  const radius = Math.min(4, width / 2, Math.max(0, base - top));
  return [
    `M${x},${base}`,
    `V${top + radius}`,
    `Q${x},${top} ${x + radius},${top}`,
    `H${x + width - radius}`,
    `Q${x + width},${top} ${x + width},${top + radius}`,
    `V${base}`,
    'Z',
  ].join(' ');
}
