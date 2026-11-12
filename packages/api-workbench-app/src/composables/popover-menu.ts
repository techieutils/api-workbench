import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

interface PopoverMenuOptions {
  /** Positions the menu next to its trigger before it opens. */
  place(menu: HTMLElement, trigger: DOMRect): void;
  /** The item that receives focus when the menu opens; defaults to the first enabled item. */
  initialItem?(items: HTMLButtonElement[]): HTMLButtonElement | undefined;
  /** Keys on the trigger that open the menu. */
  openKeys?: string[];
}

/** A `popover="auto"` menu with arrow-key navigation that returns focus to its trigger. */
export function usePopoverMenu(
  trigger: Ref<HTMLElement | undefined>,
  menu: Ref<HTMLElement | undefined>,
  options: PopoverMenuOptions,
) {
  const expanded = ref(false);
  const items = () =>
    Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  function open(): void {
    if (!trigger.value || !menu.value) return;
    options.place(menu.value, trigger.value.getBoundingClientRect());
    menu.value.showPopover({ source: trigger.value });
    expanded.value = true;
    const available = items();
    (options.initialItem?.(available) ?? available[0])?.focus();
  }
  function close(restoreFocus = false): void {
    if (menu.value?.matches(':popover-open')) menu.value.hidePopover();
    if (restoreFocus) trigger.value?.focus({ preventScroll: true });
  }
  /**
   * Pressing the trigger counts as a click outside an open menu, so the browser closes it before
   * the trigger's click arrives; that click must close it, not open it again. The press is noted
   * as it starts (capturing, before the browser's dismissal), with whether the menu was open.
   */
  let press: { at: number; wasOpen: boolean } | undefined;
  const onPress = (event: PointerEvent) => {
    press = trigger.value?.contains(event.target as Node)
      ? { at: performance.now(), wasOpen: Boolean(menu.value?.matches(':popover-open')) }
      : undefined;
  };
  onMounted(() => document.addEventListener('pointerdown', onPress, true));
  onBeforeUnmount(() => document.removeEventListener('pointerdown', onPress, true));
  function toggle(event?: Event): void {
    const pressed = press;
    press = undefined;
    // A mouse click on the trigger while the menu was open: it is closed (by the press), and stays so.
    if (
      (event as MouseEvent | undefined)?.detail &&
      pressed?.wasOpen &&
      performance.now() - pressed.at < 2000
    )
      return close();
    if (menu.value?.matches(':popover-open')) close();
    else open();
  }
  function onTriggerKeydown(event: KeyboardEvent): void {
    if (!(options.openKeys ?? ['ArrowDown']).includes(event.key)) return;
    event.preventDefault();
    open();
  }
  function onMenuKeydown(event: KeyboardEvent): void {
    const available = items();
    const index = available.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? available.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
      available[next]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      close(true);
    }
  }
  function onToggle(): void {
    expanded.value = Boolean(menu.value?.matches(':popover-open'));
  }
  return { expanded, open, close, toggle, onTriggerKeydown, onMenuKeydown, onToggle };
}
