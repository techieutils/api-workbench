import { nextTick, ref, shallowRef, type ShallowRef } from 'vue';

interface ContextMenuHandle {
  openFor(element: HTMLElement, at?: { x: number; y: number }): void;
}

/**
 * A row's context menu (components/ContextMenu.vue): right-click opens it at the pointer, and
 * Shift+F10 or the context menu key opens it below the focused element. `target` names the row
 * the items and actions are for.
 */
export function useContextMenu<T>() {
  const menu = ref<ContextMenuHandle>();
  // Shallow, so an object target stays the row's own object rather than a reactive copy of it:
  // actions find and remove it by identity (a cookie in the jar, a row in a list).
  const target = shallowRef() as ShallowRef<T | undefined>;
  function open(event: MouseEvent | KeyboardEvent, value: T): void {
    event.preventDefault();
    // Focus returns to what was focused from the keyboard, or to the row that was right-clicked.
    const element = (
      event instanceof KeyboardEvent ? event.target : event.currentTarget
    ) as HTMLElement;
    const at = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined;
    target.value = value;
    // The items follow the target, so the menu opens once they have rendered.
    void nextTick(() => menu.value?.openFor(element, at));
  }
  function onKeydown(event: KeyboardEvent, value: T): void {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event, value);
  }
  return { menu, target, open, onKeydown };
}
