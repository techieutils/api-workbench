<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalSession } from '@techieutils/api-workbench-common/types';
import { errorMessage } from '../../utils';
import { openWithAdoptedStyles } from './terminal-styles';

/** One shell in a pseudo-terminal, running in the desktop app's main process. */
const props = defineProps<{
  active: boolean;
  /** The shell to run, by id from the desktop app's list; unset runs the default one. */
  shell?: string;
  /** Text typed at the first prompt, without Enter; a restarted shell does not get it again. */
  input?: string;
}>();
let typedInput = false;
let inputTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Types `input` once the shell has drawn its prompt: after its output has been quiet briefly, or
 * after a few seconds if it prints nothing. Typed earlier, the terminal echoes it before the
 * prompt and the shell then draws it again.
 */
function typeInputWhenReady(delay: number): void {
  if (!props.input || typedInput) return;
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => {
    if (!props.input || typedInput || !session.value || status.value !== 'running') return;
    typedInput = true;
    void bridge?.write(session.value.id, props.input).catch(() => {});
  }, delay);
}
const host = ref<HTMLElement>();
const session = ref<TerminalSession>();
const status = ref<'starting' | 'running' | 'exited' | 'unavailable'>('starting');
const message = ref('');
const bridge = window.workbench?.terminal;
let terminal: Terminal | undefined;
let fit: FitAddon | undefined;
let unsubscribe: (() => void) | undefined;
let observer: ResizeObserver | undefined;
let removeStyles: (() => void) | undefined;

/** Terminal colours from the app's theme tokens. */
function theme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token('--bg'),
    foreground: token('--text'),
    cursor: token('--accent'),
    selectionBackground: token('--accent-soft'),
  };
}
/**
 * Waits (up to about a second) for the terminal to be laid out. A terminal opened while dev tools
 * is still hidden measures no width, and a shell started at that size wraps its first line.
 */
async function laidOut(): Promise<void> {
  // A hidden page (the terminal's view before it is shown, or a minimised window) gets no
  // frames, so each wait also ends on a timer: the shell starts within the second either way.
  const frame = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  for (let attempt = 0; attempt < 50 && !host.value?.clientWidth; attempt++) await frame();
}
async function start(): Promise<void> {
  if (!terminal) return;
  await laidOut();
  if (!bridge) {
    status.value = 'unavailable';
    message.value = 'The terminal needs the API Workbench desktop app.';
    return;
  }
  status.value = 'starting';
  terminal.reset();
  try {
    fit?.fit();
    session.value = await bridge.start({ cols: terminal.cols, rows: terminal.rows }, props.shell);
    status.value = 'running';
    message.value = '';
    typeInputWhenReady(3000);
    if (props.active) terminal.focus();
  } catch (error) {
    status.value = 'unavailable';
    message.value = `The terminal could not start: ${errorMessage(error)}`;
  }
}
function stop(): void {
  if (session.value && status.value === 'running') void bridge?.stop(session.value.id);
}
/** Ends the shell and starts a new one; the old shell's exit is no longer reported. */
function restart(): void {
  const previous = session.value;
  session.value = undefined;
  if (previous && status.value === 'running') void bridge?.stop(previous.id);
  void start();
}
function clear(): void {
  terminal?.clear();
}
function focus(): void {
  terminal?.focus();
}
function resize(): void {
  if (!terminal || !fit || !host.value?.offsetWidth) return;
  fit.fit();
  if (session.value && status.value === 'running')
    void bridge?.resize(session.value.id, terminal.cols, terminal.rows).catch(() => {});
}
// A terminal shown again fits its size and takes the keyboard.
watch(
  () => props.active,
  (active) => {
    if (active) requestAnimationFrame(() => (resize(), focus()));
  },
);
onMounted(() => {
  terminal = new Terminal({
    cursorBlink: true,
    fontFamily:
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono') ||
      'ui-monospace, monospace',
    fontSize: 12,
    scrollback: 5000,
    theme: theme(),
  });
  fit = new FitAddon();
  terminal.loadAddon(fit);
  removeStyles = openWithAdoptedStyles(() => terminal!.open(host.value!));
  terminal.onData((data) => {
    if (session.value && status.value === 'running')
      void bridge?.write(session.value.id, data).catch(() => {});
    else if (status.value === 'exited' && data === '\r') void start();
  });
  unsubscribe = bridge?.onEvent((event) => {
    if (event.id !== session.value?.id) return;
    if (event.type === 'data') {
      terminal?.write(event.data);
      typeInputWhenReady(250);
    } else {
      status.value = 'exited';
      terminal?.write(
        `\r\n\x1b[2m[Process exited with code ${event.exitCode}. Press Enter to start a new shell.]\x1b[0m\r\n`,
      );
    }
  });
  observer = new ResizeObserver(() => resize());
  observer.observe(host.value!);
  void start();
});
onBeforeUnmount(() => {
  clearTimeout(inputTimer);
  observer?.disconnect();
  unsubscribe?.();
  stop();
  terminal?.dispose();
  removeStyles?.();
});
defineExpose({ session, status, message, clear, restart, stop, focus });
</script>

<template>
  <div ref="host" :class="['terminal-host', { active }]" data-terminal></div>
</template>
