<script setup lang="ts">
import { onBeforeUnmount, provide, reactive, ref } from 'vue';
import DevToolsTerminal from '../components/devtools/DevToolsTerminal.vue';
import { TERMINAL_HOST, type TerminalHost } from '../components/devtools/terminal-host';

/**
 * The terminal: its own page, with only the terminal's bridge (terminal-preload.ts), shown over
 * the app's dev tools panel or in a window of its own. Its default shell is kept by the main
 * process, and commands the app stages arrive from there.
 */
const bridge = window.workbench?.terminalHost;
const host = reactive<TerminalHost>({
  defaultShell: undefined,
  commands: [],
  live: 0,
  placement:
    new URLSearchParams(location.search).get('placement') === 'window' ? 'window' : 'panel',
  setDefaultShell(id) {
    host.defaultShell = id;
    void bridge?.setDefaultShell(id);
  },
  expand: () => void bridge?.expand(),
  returnToPanel: () => void bridge?.return(),
});
provide(TERMINAL_HOST, host);
/** Shown once the default shell and any staged command are known, so the first tab uses them. */
const ready = ref(false);
async function takeStaged(): Promise<void> {
  host.commands.push(...((await bridge?.takeStaged().catch(() => [])) ?? []));
}
void (async () => {
  const saved = await bridge?.preferences().catch(() => undefined);
  host.defaultShell = saved?.defaultShell;
  await takeStaged();
  ready.value = true;
})();
const stops = [
  bridge?.onStaged(() => void takeStaged()),
  bridge?.onTheme((theme) => (document.documentElement.dataset.theme = theme)),
  bridge?.onPlacement((where) => (host.placement = where)),
];
onBeforeUnmount(() => stops.forEach((stop) => stop?.()));
</script>

<template>
  <main class="terminal-window">
    <DevToolsTerminal v-if="ready" />
  </main>
</template>
