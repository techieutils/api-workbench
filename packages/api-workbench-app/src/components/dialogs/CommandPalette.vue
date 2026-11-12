<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRendered } from '../../composables/rendered';
import { useDialogsStore } from '../../stores/dialogs';
import MdiIcon from '../MdiIcon.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';

/** Run any workspace command by name. */
const dialogs = useDialogsStore();
const palette = dialogs.palette;
// Command titles depend on pane layout and other renderer state, which render() reports.
const results = useRendered(() => {
  void palette.query;
  return dialogs.paletteResults().map((command, index, all) => ({
    command,
    index,
    group: index === 0 || all[index - 1].group !== command.group ? command.group : '',
  }));
});
const selected = computed(() => Math.max(0, Math.min(palette.selected, results.value.length - 1)));
const input = ref<HTMLInputElement>();

function onInput(event: Event): void {
  palette.query = (event.target as HTMLInputElement).value;
  palette.selected = 0;
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    dialogs.closePalette();
  } else if (['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
    event.preventDefault();
    const count = results.value.length;
    if (event.key === 'Enter') void dialogs.runCommand(selected.value);
    else if (count) {
      palette.selected = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      void nextTick(() =>
        document
          .querySelector(`#command-result-${palette.selected}`)
          ?.scrollIntoView({ block: 'nearest' }),
      );
    }
  } else if (event.key === 'Tab') {
    event.preventDefault();
    input.value?.focus();
  }
}
</script>

<template>
  <div
    class="modal-backdrop command-palette-backdrop"
    @click.self="dialogs.closePalette()"
    @keydown="onKeydown"
  >
    <section
      class="modal workspace-search-dialog command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div class="workspace-search-input-row">
        <MdiIcon name="lightning-bolt-outline" /><input
          id="command-palette-input"
          ref="input"
          role="combobox"
          aria-label="Run a command"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="command-results"
          :aria-activedescendant="results.length ? `command-result-${selected}` : undefined"
          autocomplete="off"
          spellcheck="false"
          placeholder="Type a command…"
          :value="palette.query"
          @input="onInput"
        /><UiIconButton
          label="Close command palette"
          icon="close"
          data-command-close
          @click="dialogs.closePalette()"
        />
      </div>
      <div
        id="command-results"
        class="workspace-search-results command-results"
        role="listbox"
        aria-label="Commands"
      >
        <template v-for="{ command, index, group } in results" :key="`${command.id}:${index}`">
          <div v-if="group" class="command-group" role="presentation">{{ group }}</div>
          <button
            :id="`command-result-${index}`"
            type="button"
            :class="[
              'workspace-search-result',
              'command-result',
              { 'is-selected': index === selected },
            ]"
            role="option"
            :aria-selected="index === selected"
            :data-command-result="index"
            tabindex="-1"
            @click="dialogs.runCommand(index)"
          >
            <span class="workspace-search-result-icon"><MdiIcon :name="command.icon" /></span
            ><span class="workspace-search-result-copy"
              ><strong>{{ command.title }}</strong></span
            ><kbd v-if="command.shortcut">{{ command.shortcut }}</kbd>
          </button>
        </template>
        <UiEmptyState
          v-if="!results.length"
          icon="console-line"
          title="No matching commands"
          description="Try “send”, “environment”, “cookies”, or “theme”."
        />
      </div>
      <div class="workspace-search-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Run</span
        ><span><kbd>Esc</kbd> Close</span
        ><span class="right">Search requests with <kbd>⌘ K</kbd></span>
      </div>
    </section>
  </div>
</template>
