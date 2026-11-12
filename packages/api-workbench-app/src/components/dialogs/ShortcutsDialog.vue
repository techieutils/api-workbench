<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { keyLabel, SHORTCUT_GROUPS } from '../../shortcuts';
import { useUiStore } from '../../stores/ui';
import MdiIcon from '../MdiIcon.vue';

/** Every keyboard shortcut, grouped and searchable. Opens with ? and closes with Esc. */
const ui = useUiStore();
const dialog = ref<HTMLDialogElement>();
const search = ref<HTMLInputElement>();
const query = ref('');
let returnFocus: HTMLElement | null = null;
const groups = computed(() => {
  const text = query.value.trim().toLowerCase();
  return SHORTCUT_GROUPS.map(({ group, shortcuts }) => ({
    group,
    shortcuts: shortcuts.filter(
      (shortcut) =>
        !text ||
        `${group} ${shortcut.label} ${shortcut.keys.map(keyLabel).join(' ')}`
          .toLowerCase()
          .includes(text),
    ),
  })).filter((group) => group.shortcuts.length);
});
onMounted(() => {
  returnFocus = document.activeElement as HTMLElement | null;
  dialog.value?.showModal();
  void nextTick(() => search.value?.focus());
});
function close(): void {
  dialog.value?.close();
  ui.shortcutsOpen = false;
  returnFocus?.focus({ preventScroll: true });
}
</script>

<template>
  <dialog
    ref="dialog"
    class="shortcuts-dialog"
    aria-labelledby="shortcuts-title"
    data-shortcuts-dialog
    @cancel.prevent="close"
    @click.self="close"
  >
    <header>
      <div>
        <span class="eyebrow">HELP</span>
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      </div>
      <button type="button" class="icon-button" aria-label="Close" @click="close">
        <MdiIcon name="close" />
      </button>
    </header>
    <label class="cookie-filter shortcuts-search"
      ><MdiIcon name="magnify" /><input
        ref="search"
        v-model="query"
        type="search"
        placeholder="Search shortcuts"
        aria-label="Search shortcuts"
        autocomplete="off"
    /></label>
    <div class="shortcuts-groups">
      <section v-for="{ group, shortcuts } in groups" :key="group">
        <h3>{{ group }}</h3>
        <dl>
          <template v-for="shortcut in shortcuts" :key="shortcut.label"
            ><dt>{{ shortcut.label }}</dt>
            <dd>
              <kbd v-for="key in shortcut.keys" :key="key">{{ keyLabel(key) }}</kbd>
            </dd></template
          >
        </dl>
      </section>
      <p v-if="!groups.length" class="notice">No shortcuts match “{{ query }}”.</p>
    </div>
  </dialog>
</template>
