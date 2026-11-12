<script setup lang="ts">
import { ref, watch } from 'vue';
import MdiIcon from '../MdiIcon.vue';

/**
 * A collapsible section for optional or secondary settings. It is a native details element, so
 * the header is a keyboard-operable disclosure for assistive technology. `open` sets whether it
 * starts open, and opens or closes it again whenever the value changes; in between, the user's
 * choice stands. `update:open` reports the user's toggles. A field inside that fails form
 * validation opens the panel, so the browser can focus it and show why.
 */
const props = defineProps<{
  title: string;
  /** A short summary shown under the title, such as what the section contains. */
  description?: string;
  icon?: MdiIconName;
  /** A count or state shown at the end of the header. */
  badge?: string;
  open?: boolean;
}>();
const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const expanded = ref(props.open ?? false);
watch(
  () => props.open,
  (open) => {
    if (open !== undefined) expanded.value = open;
  },
);
// Set on the element directly: the browser focuses the invalid field before Vue would re-render.
function reveal(event: Event): void {
  (event.currentTarget as HTMLDetailsElement).open = true;
}
function toggle(event: Event): void {
  const open = (event.target as HTMLDetailsElement).open;
  if (open === expanded.value) return;
  expanded.value = open;
  emit('update:open', open);
}
</script>

<template>
  <details class="ui-expansion-panel" :open="expanded" @toggle="toggle" @invalid.capture="reveal">
    <summary>
      <MdiIcon name="chevron-right" class="ui-expansion-chevron" /><MdiIcon
        v-if="icon"
        :name="icon"
        class="ui-expansion-icon"
      /><span class="ui-expansion-heading"
        ><strong>{{ title }}</strong
        ><small v-if="description">{{ description }}</small></span
      ><span v-if="badge" class="ui-expansion-badge">{{ badge }}</span>
    </summary>
    <div class="ui-expansion-body"><slot /></div>
  </details>
</template>
