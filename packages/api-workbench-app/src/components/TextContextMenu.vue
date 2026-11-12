<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { keyLabel, mac } from '../shortcuts';
import { toast } from '../utils';
import type { MenuItem } from './ActionMenu.vue';
import ContextMenu from './ContextMenu.vue';

/**
 * The app's default context menu for text, where nothing more specific handles the right-click:
 * text fields get undo, cut, copy, paste, and select all, and other selected text gets Copy.
 * Rows and code editors open their own menus first, which this leaves alone.
 */
type TextField = HTMLInputElement | HTMLTextAreaElement;
const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);
const isTextField = (element: unknown): element is TextField =>
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLInputElement && TEXT_TYPES.has(element.type));

const menu = ref<InstanceType<typeof ContextMenu>>();
/**
 * Where the menu renders: inside an open modal dialog when the text is in one, since everything
 * outside a modal dialog is inert, and in the page otherwise.
 */
const container = shallowRef<HTMLElement | string>('body');
const field = shallowRef<TextField>();
/** The selected text when the menu opened; clicking the menu could clear the page selection. */
const selected = ref('');
const keys = (...names: string[]) => names.map(keyLabel).join(mac ? '' : '+');
const items = computed<MenuItem[]>(() => {
  const target = field.value;
  if (!target)
    return [{ id: 'copy', label: 'Copy', icon: 'content-copy', shortcut: keys('Mod', 'C') }];
  const locked = target.readOnly || target.disabled;
  const secret = target instanceof HTMLInputElement && target.type === 'password';
  return [
    { id: 'undo', label: 'Undo', icon: 'undo', shortcut: keys('Mod', 'Z'), disabled: locked },
    {
      id: 'redo',
      label: 'Redo',
      icon: 'redo',
      shortcut: keys('Mod', 'Shift', 'Z'),
      disabled: locked,
    },
    {
      id: 'cut',
      label: 'Cut',
      icon: 'content-cut',
      shortcut: keys('Mod', 'X'),
      separated: true,
      disabled: locked || secret || !selected.value,
    },
    {
      id: 'copy',
      label: 'Copy',
      icon: 'content-copy',
      shortcut: keys('Mod', 'C'),
      disabled: secret || !selected.value,
    },
    {
      id: 'paste',
      label: 'Paste',
      icon: 'content-paste',
      shortcut: keys('Mod', 'V'),
      disabled: locked,
    },
    {
      id: 'select-all',
      label: 'Select all',
      icon: 'select-all',
      shortcut: keys('Mod', 'A'),
      separated: true,
      disabled: !target.value,
    },
  ];
});

/** Elements that open their own menus, or are menus. */
const handledElsewhere = (element: Element) => Boolean(element.closest('.cm-editor, [popover]'));
function open(target: Element, at?: { x: number; y: number }): boolean {
  if (handledElsewhere(target)) return false;
  if (isTextField(target)) {
    field.value = target;
    selected.value = target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0);
  } else {
    field.value = undefined;
    selected.value = getSelection()?.toString() ?? '';
    if (!selected.value) return false;
  }
  const box = target.getBoundingClientRect();
  container.value = target.closest<HTMLElement>('dialog[open]') ?? 'body';
  void nextTick(() =>
    menu.value?.openFor(target as HTMLElement, at ?? { x: box.left, y: box.bottom }),
  );
  return true;
}
function onContextMenu(event: MouseEvent): void {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  if (open(event.target, { x: event.clientX, y: event.clientY })) event.preventDefault();
}
function onKeydown(event: KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
  )
    return;
  if (isTextField(document.activeElement) && open(document.activeElement)) event.preventDefault();
}
onMounted(() => {
  document.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('contextmenu', onContextMenu);
  document.removeEventListener('keydown', onKeydown);
});

// Edits go through the browser's editing commands, so they can be undone and fire input events
// that the app's fields listen to.
async function onSelect(command: string): Promise<void> {
  const target = field.value;
  try {
    if (command === 'copy') {
      await navigator.clipboard.writeText(selected.value);
      return;
    }
    if (!target) return;
    target.focus();
    if (command === 'undo' || command === 'redo') document.execCommand(command);
    else if (command === 'select-all') target.select();
    else if (command === 'cut') {
      await navigator.clipboard.writeText(selected.value);
      document.execCommand('delete');
    } else if (command === 'paste')
      document.execCommand('insertText', false, await navigator.clipboard.readText());
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
</script>

<template>
  <Teleport :to="container">
    <ContextMenu ref="menu" label="Text actions" :items="items" data-text-menu @select="onSelect" />
  </Teleport>
</template>
