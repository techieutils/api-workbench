<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import ScrollRow from './ScrollRow.vue';
import MdiIcon from '../MdiIcon.vue';

/**
 * ARIA tabs with Arrow Left/Right, Home, and End navigation. Tabs that do not fit scroll, with
 * arrows at the ends that have hidden tabs; the active tab is always scrolled into view.
 */
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  group: string;
  label: string;
  items: UITab[];
  active: string;
  /** The data attribute naming each tab, kept for styles and tests. */
  attribute:
    | 'data-request-tab'
    | 'data-response-tab'
    | 'data-protocol-tab'
    | 'data-protocol-inspector'
    | 'data-dev-tools-tab'
    | 'data-runner-mode'
    | 'data-runner-result-tab'
    | 'data-spec-tab'
    | 'data-mock-tab'
    | 'data-history-tab'
    | 'data-transfer-tab';
  /** The tab panel's id; defaults to `{group}-panel`. */
  panel?: string;
  /** Tabs can be looked at but not switched, such as while a run is in progress. */
  disabled?: boolean;
}>();
const emit = defineEmits<{ select: [name: string] }>();
const id = (name: string) => `${props.group}-tab-${name.toLowerCase().replace(/\s+/g, '-')}`;
const row = ref<InstanceType<typeof ScrollRow>>();
watch(
  () => props.active,
  () => void nextTick(() => row.value?.reveal(document.getElementById(id(props.active)))),
  { immediate: true, flush: 'post' },
);
function onKeydown(event: KeyboardEvent): void {
  if (props.disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const names = props.items.map((tab) => tab.name);
  const current = names.indexOf(document.activeElement?.getAttribute(props.attribute) ?? '');
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? names.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
  event.preventDefault();
  emit('select', names[index]);
  document.getElementById(id(names[index]))?.focus();
}
</script>

<template>
  <!-- Callers' classes and attributes style the row of tabs itself. -->
  <ScrollRow
    v-bind="$attrs"
    ref="row"
    class="ui-tabs"
    role="tablist"
    :aria-label="label"
    noun="tabs"
    @keydown="onKeydown"
  >
    <button
      v-for="tab in items"
      :id="id(tab.name)"
      :key="tab.name"
      type="button"
      :class="['ui-tab', { active: tab.name === active }]"
      role="tab"
      :aria-selected="tab.name === active"
      :aria-controls="panel || `${group}-panel`"
      :tabindex="tab.name === active ? 0 : -1"
      :title="tab.name"
      :disabled="disabled"
      v-bind="{ [attribute]: tab.name }"
      @click="emit('select', tab.name)"
    >
      <MdiIcon v-if="tab.icon" :name="tab.icon" /><span>{{ tab.name }}</span
      ><span v-if="tab.count !== undefined && tab.count !== 0" class="count">{{ tab.count }}</span>
    </button>
  </ScrollRow>
</template>
