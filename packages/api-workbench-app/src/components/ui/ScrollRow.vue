<script setup lang="ts">
import { ref } from 'vue';
import { useOverflowArrows } from '../../composables/overflow-arrows';
import MdiIcon from '../MdiIcon.vue';

/**
 * A horizontal row (tabs, a segmented control, a section list) that scrolls when its items do
 * not fit, with arrows at the ends that have hidden items. Callers' classes and attributes, such
 * as a role and its keyboard handling, apply to the row itself.
 */
defineOptions({ inheritAttrs: false });
withDefaults(
  defineProps<{
    /** Names what the arrows reveal, as in "Show more tabs". */
    noun?: string;
    /** Classes for the frame around the row and its arrows, for its own layout. */
    frameClass?: string;
  }>(),
  { noun: 'items', frameClass: undefined },
);
const row = ref<HTMLElement>();
const arrows = useOverflowArrows(row);
defineExpose({
  /** Scrolls an item fully into view within the row. */
  reveal: (item: HTMLElement | null | undefined) => arrows.reveal(item),
  element: row,
});
</script>

<template>
  <div
    :class="[
      'ui-tabs-frame',
      frameClass,
      { 'has-prev': arrows.canPrev.value, 'has-next': arrows.canNext.value },
    ]"
  >
    <div v-bind="$attrs" ref="row" class="scroll-row"><slot /></div>
    <!-- Pointer conveniences; keyboard users move through the items themselves. -->
    <button
      v-if="arrows.canPrev.value"
      type="button"
      class="ui-tabs-arrow prev"
      tabindex="-1"
      aria-hidden="true"
      :title="`Show earlier ${noun}`"
      data-tabs-arrow="prev"
      @click="arrows.scroll(-1)"
    >
      <MdiIcon name="chevron-left" />
    </button>
    <button
      v-if="arrows.canNext.value"
      type="button"
      class="ui-tabs-arrow next"
      tabindex="-1"
      aria-hidden="true"
      :title="`Show more ${noun}`"
      data-tabs-arrow="next"
      @click="arrows.scroll(1)"
    >
      <MdiIcon name="chevron-right" />
    </button>
  </div>
</template>
