import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/**
 * Scroll arrows for a horizontal strip whose items can overflow, as tab rows do: `canPrev` and
 * `canNext` say whether items are hidden before or after the visible part, and `scroll` moves by
 * most of the strip's width. They update as the strip scrolls, resizes, or gains items.
 */
export function useOverflowArrows(strip: Ref<HTMLElement | undefined>) {
  const canPrev = ref(false);
  const canNext = ref(false);
  function measure(): void {
    const element = strip.value;
    if (!element) return;
    const overflows = element.scrollWidth > element.clientWidth + 1;
    // An arrow shows only when an item is cut off: a strip's own padding and border can overflow
    // by a few pixels while every item is still in full view.
    const items = Array.from(element.children).filter((item) => item.getClientRects().length);
    if (!overflows || !items.length) {
      canPrev.value = overflows && element.scrollLeft > 1;
      canNext.value =
        overflows && element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      return;
    }
    const box = element.getBoundingClientRect();
    const left = box.left + element.clientLeft;
    const right = left + element.clientWidth;
    canPrev.value = items[0].getBoundingClientRect().left < left - 1;
    canNext.value = items[items.length - 1].getBoundingClientRect().right > right + 1;
  }
  function scroll(direction: -1 | 1): void {
    const element = strip.value;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(80, element.clientWidth * 0.7),
      behavior: 'smooth',
    });
  }
  /** Scrolls an item fully into view within the strip, without moving the page. */
  function reveal(item: HTMLElement | null | undefined): void {
    const element = strip.value;
    if (!element || !item) return;
    const box = element.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    // The arrows sit over the strip's ends, so an item is clear of them by their width.
    const inset = 28;
    if (rect.left < box.left + (canPrev.value ? inset : 0))
      element.scrollLeft -= box.left + inset - rect.left;
    else if (rect.right > box.right - (canNext.value ? inset : 0))
      element.scrollLeft += rect.right - box.right + inset;
    measure();
  }
  let resize: ResizeObserver | undefined;
  let mutations: MutationObserver | undefined;
  onMounted(() => {
    const element = strip.value;
    if (!element) return;
    element.addEventListener('scroll', measure, { passive: true });
    resize = new ResizeObserver(() => measure());
    // Items are watched too: one can grow (a web font loading, a label changing elsewhere) and
    // overflow the strip without the strip itself resizing.
    const observeItems = () => {
      resize?.observe(element);
      for (const item of Array.from(element.children)) resize?.observe(item);
    };
    observeItems();
    mutations = new MutationObserver(() => {
      observeItems();
      requestAnimationFrame(measure);
    });
    // Class and hidden changes can resize items without resizing the strip.
    mutations.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'hidden'],
    });
    measure();
  });
  onBeforeUnmount(() => {
    strip.value?.removeEventListener('scroll', measure);
    resize?.disconnect();
    mutations?.disconnect();
  });
  return { canPrev, canNext, scroll, reveal, measure };
}
