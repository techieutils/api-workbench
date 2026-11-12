<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  describeTagFilter,
  emptyTagFilter,
  tagFilterActive,
  tagFilterState,
  cycleTagFilter,
  type TagFilter,
} from '@techieutils/api-workbench-common/tags';
import MdiIcon from '../MdiIcon.vue';

/**
 * Tags as chips that filter: click one to require it, again to leave out what has it, and again
 * to stop using it; with several required, choose whether any or all of them must be there. The
 * same in the explorer and the Runner.
 */
const props = withDefaults(
  defineProps<{
    counts: readonly { tag: string; count: number }[];
    filter: TagFilter;
    /** What the filter chooses, for its labels: "run" in the Runner, "show" in the explorer. */
    verb: 'run' | 'show';
    disabled?: boolean;
    /** Show only this many tags until More is clicked; all of them without a limit. */
    limit?: number;
    /** What each count counts: requests, or History's entries. */
    noun?: [one: string, many: string];
  }>(),
  { disabled: false, limit: 0, noun: () => ['request', 'requests'] },
);
const emit = defineEmits<{ change: [filter: TagFilter] }>();
const expanded = ref(false);

/** Chosen tags stay in view however many there are. */
const shown = computed(() => {
  if (!props.limit || expanded.value || props.counts.length <= props.limit) return props.counts;
  const chosen = props.counts.filter((entry) => tagFilterState(props.filter, entry.tag) !== 'off');
  const rest = props.counts.filter((entry) => tagFilterState(props.filter, entry.tag) === 'off');
  return [...chosen, ...rest.slice(0, Math.max(0, props.limit - chosen.length))];
});
const hidden = computed(() => props.counts.length - shown.value.length);
const doing = computed(() => (props.verb === 'run' ? 'running' : 'showing'));

function label(tag: string, count: number) {
  const state = tagFilterState(props.filter, tag);
  const requests = `${count} ${props.noun[count === 1 ? 0 : 1]}`;
  return state === 'include'
    ? `${tag}, ${requests}: ${doing.value} only requests with it. Click to leave them out instead.`
    : state === 'exclude'
      ? `${tag}, ${requests}: leaving them out. Click to stop filtering by it.`
      : `${tag}, ${requests}. Click to ${props.verb} only requests with it.`;
}
</script>

<template>
  <div class="runner-tags" data-tag-filter>
    <span class="runner-tags-label"><MdiIcon name="tag-multiple-outline" />Tags</span>
    <button
      v-for="entry in shown"
      :key="entry.tag"
      type="button"
      :class="['runner-tag', `is-${tagFilterState(filter, entry.tag)}`]"
      :data-runner-tag="entry.tag"
      :data-state="tagFilterState(filter, entry.tag)"
      :aria-label="label(entry.tag, entry.count)"
      :title="label(entry.tag, entry.count)"
      :disabled="disabled"
      @click="emit('change', cycleTagFilter(filter, entry.tag))"
    >
      <MdiIcon
        :name="
          tagFilterState(filter, entry.tag) === 'include'
            ? 'check-circle-outline'
            : tagFilterState(filter, entry.tag) === 'exclude'
              ? 'minus-circle-outline'
              : 'tag-outline'
        "
      />{{ entry.tag }}<span class="runner-tag-count">{{ entry.count }}</span>
    </button>
    <button
      v-if="hidden > 0 || (expanded && limit && counts.length > limit)"
      type="button"
      class="text-button tag-filter-more"
      data-tag-filter-more
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Fewer' : `${hidden} more` }}
    </button>
    <span
      v-if="filter.include.length > 1"
      class="segmented-control runner-tag-mode"
      role="group"
      aria-label="Requests need"
    >
      <button
        type="button"
        data-runner-tag-mode="any"
        :aria-pressed="filter.mode === 'any'"
        :class="{ selected: filter.mode === 'any' }"
        :disabled="disabled"
        @click="emit('change', { ...filter, mode: 'any' })"
      >
        Any tag
      </button>
      <button
        type="button"
        data-runner-tag-mode="all"
        :aria-pressed="filter.mode === 'all'"
        :class="{ selected: filter.mode === 'all' }"
        :disabled="disabled"
        @click="emit('change', { ...filter, mode: 'all' })"
      >
        All tags
      </button>
    </span>
    <button
      v-if="tagFilterActive(filter)"
      type="button"
      class="text-button"
      data-action="clear-tag-filter"
      :disabled="disabled"
      @click="emit('change', emptyTagFilter())"
    >
      Clear
    </button>
    <p class="runner-tags-help">
      {{
        tagFilterActive(filter)
          ? `${verb === 'run' ? 'Running' : 'Showing'} requests tagged ${describeTagFilter(filter)}.`
          : `Click a tag to ${verb} only requests with it; click again to leave them out.`
      }}
    </p>
  </div>
</template>
