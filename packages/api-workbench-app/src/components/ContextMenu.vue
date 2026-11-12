<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { usePopoverMenu } from '../composables/popover-menu';
import type { MenuItem } from './ActionMenu.vue';
import MdiIcon from './MdiIcon.vue';

/**
 * A right-click menu: it opens at the pointer, or below an element opened from the keyboard
 * (Shift+F10 or the context menu key), and returns focus to that element when it closes.
 *
 * It is a manual popover that closes itself. An automatic one would close at once: a right-click
 * opens the menu on the button press, and the release that follows lands outside it.
 */
defineProps<{ label: string; items: MenuItem[] }>();
const emit = defineEmits<{ select: [id: string] }>();
const owner = ref<HTMLElement>();
const menu = ref<HTMLElement>();
let point: { x: number; y: number } | undefined;
const popover = usePopoverMenu(owner, menu, {
  place(element, rect) {
    const width = 240;
    const x = point?.x ?? rect.left;
    const y = point?.y ?? rect.bottom;
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
    element.style.top = `${y}px`;
    element.style.bottom = '';
  },
});

// While open, a press outside the menu, scrolling outside it with the wheel or a touch, leaving the
// window, or resizing it closes the menu. Scrolls the page makes itself, such as bringing a
// focused field into view when the menu opens, leave it open.
const outside = (event: Event) => {
  if (!menu.value?.contains(event.target as Node)) popover.close();
};
const dismiss = () => popover.close();
function listen(): void {
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('wheel', outside, true);
  document.addEventListener('touchmove', outside, true);
  window.addEventListener('blur', dismiss);
  window.addEventListener('resize', dismiss);
}
function unlisten(): void {
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('wheel', outside, true);
  document.removeEventListener('touchmove', outside, true);
  window.removeEventListener('blur', dismiss);
  window.removeEventListener('resize', dismiss);
}
function onToggle(): void {
  popover.onToggle();
  if (!popover.expanded.value) unlisten();
}
onBeforeUnmount(unlisten);

/** Opens the menu for `element`, at the pointer when there is one. */
function openFor(element: HTMLElement, at?: { x: number; y: number }): void {
  owner.value = element;
  point = at;
  popover.close();
  popover.open();
  listen();
  // Its height is known once shown: a menu that would run off the bottom moves up.
  const box = menu.value?.getBoundingClientRect();
  if (menu.value && box && box.bottom > innerHeight - 8)
    menu.value.style.top = `${Math.max(8, innerHeight - box.height - 8)}px`;
}
function choose(item: MenuItem): void {
  if (item.disabled) return;
  popover.close(true);
  emit('select', item.id);
}
defineExpose({ openFor });
</script>

<template>
  <div
    ref="menu"
    class="request-tab-menu action-menu context-menu"
    popover="manual"
    role="menu"
    :aria-label="label"
    @keydown="popover.onMenuKeydown"
    @toggle="onToggle"
    @contextmenu.prevent
  >
    <template v-for="item in items" :key="item.id">
      <div v-if="item.separated" class="tab-menu-separator" role="separator"></div>
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
