<script setup lang="ts">
import { ref } from 'vue';
import { usePopoverMenu } from '../composables/popover-menu';
import MdiIcon from './MdiIcon.vue';

/**
 * A ⋯ button that opens a menu of actions (WAI-ARIA menu button): arrow keys move between items,
 * Escape and Tab close it and return focus. Items can be grouped under headings.
 */
export interface MenuItem {
  id: string;
  label: string;
  icon?: MdiIconName;
  shortcut?: string;
  disabled?: boolean;
  /** Destructive actions are shown in the danger colour. */
  danger?: boolean;
  /** A heading shown before this item, starting a new group. */
  heading?: string;
  /** A separator before this item. */
  separated?: boolean;
}
defineOptions({ inheritAttrs: false });
defineProps<{
  label: string;
  items: MenuItem[];
  triggerClass?: string;
  /** The trigger's icon; a ⋯ by default. */
  icon?: MdiIconName;
}>();
const emit = defineEmits<{ select: [id: string] }>();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const uid = `action-menu-${Math.random().toString(36).slice(2, 9)}`;
const popover = usePopoverMenu(trigger, menu, {
  place(element, rect) {
    const width = 240;
    element.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    const below = innerHeight - rect.bottom - 12;
    element.style.maxHeight = `${Math.max(140, Math.max(below, rect.top - 12))}px`;
    if (below < 220 && rect.top > below) {
      element.style.top = '';
      element.style.bottom = `${innerHeight - rect.top + 4}px`;
    } else {
      element.style.bottom = '';
      element.style.top = `${rect.bottom + 4}px`;
    }
  },
  openKeys: ['ArrowDown', 'Enter', ' '],
});
function choose(item: MenuItem): void {
  if (item.disabled) return;
  popover.close(true);
  emit('select', item.id);
}
defineExpose({ open: () => popover.open() });
</script>

<template>
  <button
    v-bind="$attrs"
    ref="trigger"
    type="button"
    :class="['icon-button', 'action-menu-trigger', triggerClass]"
    :aria-label="label"
    :title="label"
    aria-haspopup="menu"
    :aria-expanded="popover.expanded.value"
    :aria-controls="uid"
    @click.stop="popover.toggle"
    @dblclick.stop
    @keydown="popover.onTriggerKeydown"
  >
    <MdiIcon :name="icon ?? 'dots-horizontal'" />
  </button>
  <div
    :id="uid"
    ref="menu"
    class="request-tab-menu action-menu"
    popover="auto"
    role="menu"
    :aria-label="label"
    @keydown="popover.onMenuKeydown"
    @toggle="popover.onToggle"
  >
    <template v-for="item in items" :key="item.id">
      <div v-if="item.separated" class="tab-menu-separator" role="separator"></div>
      <div v-if="item.heading" class="tab-menu-heading" role="presentation">{{ item.heading }}</div>
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        :class="{ danger: item.danger }"
        :data-menu-item="item.id"
        :disabled="item.disabled"
        @click.stop="choose(item)"
      >
        <MdiIcon v-if="item.icon" :name="item.icon" /><span>{{ item.label }}</span
        ><kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
      </button>
    </template>
  </div>
</template>
