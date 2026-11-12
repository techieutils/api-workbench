<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { errorMessage } from '../../utils';
import { useUiStore } from '../../stores/ui';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';

/**
 * The Terminal tab of dev tools. The terminal is its own page in a view the main process lays
 * over this space (terminal-window.ts), so nothing shown in this window can type into it; this
 * says where the space is. A native view draws above the page, so it steps aside while one of
 * the page's menus or dialogs overlaps it. Expanded, it is in a window of its own.
 */
const ui = useUiStore();
const bridge = window.workbench?.terminalWindow;
const dock = ref<HTMLElement>();
const state = ref<'starting' | 'panel' | 'window' | 'declined' | 'unavailable'>(
  bridge ? 'starting' : 'unavailable',
);
const message = ref('');

/** Menus, dialogs, and lists of this page that a view drawn over them would hide. */
const OVERLAYS =
  ':popover-open, dialog[open], [role="dialog"]:not([hidden]), [role="menu"]:not([hidden]), [role="listbox"]:not([hidden])';
const overlaps = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
let sent = '';
let frame = 0;
/** Tells the main process where the terminal goes, or to hide it; at most once a frame. */
function place(): void {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    let bounds: { x: number; y: number; width: number; height: number } | null = null;
    if (state.value === 'panel' && dock.value) {
      const rect = dock.value.getBoundingClientRect();
      const covered = [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some(
        (item) =>
          !dock.value!.contains(item) &&
          item.getClientRects().length > 0 &&
          overlaps(item.getBoundingClientRect(), rect),
      );
      if (!covered && rect.width > 0 && rect.height > 0)
        bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }
    const next = JSON.stringify(bounds);
    if (next === sent) return;
    sent = next;
    void bridge?.dock(bounds);
  });
}
async function start(): Promise<void> {
  if (!bridge) return;
  state.value = 'starting';
  try {
    state.value = await bridge.open();
    place();
    if (state.value === 'panel') void bridge.focus();
  } catch (error) {
    state.value = 'declined';
    message.value = errorMessage(error);
  }
}

const resizes = new ResizeObserver(place);
const changes = new MutationObserver(place);
const stops: (() => void)[] = [];
onMounted(() => {
  if (dock.value) resizes.observe(dock.value);
  changes.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open', 'hidden', 'class', 'style'],
  });
  addEventListener('resize', place);
  // Popovers open and close without other changes to the page.
  document.addEventListener('toggle', place, true);
  if (bridge)
    stops.push(
      bridge.onPlacement((where) => {
        state.value = where;
        place();
      }),
    );
  void start();
});
onBeforeUnmount(() => {
  resizes.disconnect();
  changes.disconnect();
  removeEventListener('resize', place);
  document.removeEventListener('toggle', place, true);
  stops.forEach((stop) => stop());
  cancelAnimationFrame(frame);
  // Leaving the Terminal tab hides it; its shells keep running.
  void bridge?.dock(null);
});
</script>

<template>
  <section
    ref="dock"
    class="terminal-dock"
    aria-label="Terminal"
    :data-terminal-dock="state"
    data-terminal-launcher
  >
    <div v-if="state === 'window'" class="terminal-launcher">
      <MdiIcon name="dock-window" />
      <div>
        <strong>The terminal is in its own window</strong>
        <p>
          Its shells keep running there.
          <template v-if="ui.liveTerminals">
            {{ ui.liveTerminals }} shell{{ ui.liveTerminals === 1 ? ' is' : 's are' }} running.
          </template>
        </p>
      </div>
      <UiButton
        label="Show terminal"
        icon="open-in-new"
        data-terminal-show
        @click="bridge?.focus()"
      />
      <UiButton
        label="Return to panel"
        icon="dock-bottom"
        variant="primary"
        data-terminal-dock-back
        @click="bridge?.return()"
      />
    </div>
    <div v-else-if="state === 'declined'" class="terminal-launcher">
      <MdiIcon name="console" />
      <div>
        <strong>The terminal is not open</strong>
        <p>{{ message }}</p>
      </div>
      <UiButton
        label="Open terminal"
        icon="console"
        variant="primary"
        data-terminal-open
        @click="start()"
      />
    </div>
    <p v-else-if="state === 'unavailable'" class="field-help terminal-launcher">
      The terminal needs the API Workbench desktop app.
    </p>
  </section>
</template>
