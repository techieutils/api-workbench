<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import MdiIcon from '../MdiIcon.vue';
import {
  beginEditing,
  closeSuggestions,
  editing,
  finishEditing,
  openSuggestions,
  suggestions,
} from './cell-editing';
import type { FieldSuggestion } from './suggestions';

/**
 * A Params or Headers cell: a label that becomes a text field with suggestions when
 * double-clicked (or on Enter / F2), so rows read as a table rather than a form.
 */
const props = defineProps<{
  /** Unique per row and field. */
  id: string;
  type: 'params' | 'headers';
  field: 'key' | 'value';
  index: number;
  value: string;
  suggest(): FieldSuggestion[];
  /** Replaces the value placeholder, where variables are not resolved. */
  valuePlaceholder?: string;
}>();
const emit = defineEmits<{ update: [value: string] }>();
const box = ref<HTMLElement>();
const label = ref<HTMLButtonElement>();
const input = ref<HTMLInputElement>();
const placeholder = computed(() =>
  props.field === 'key'
    ? props.type === 'params'
      ? 'Parameter name'
      : 'Header name'
    : props.valuePlaceholder || 'Value or {{variable}}',
);
const isEditing = computed(() => editing.value?.id === props.id);
const listOpen = computed(() => suggestions.cell === props.id);

function edit(): void {
  beginEditing({ id: props.id, element: box.value!, focusLabel: () => label.value?.focus() });
}
function open(all: boolean): void {
  // The field's live text: while typing, the prop updates only after the parent re-renders.
  const text = input.value?.value ?? props.value;
  const query = all ? '' : text.trim().toLowerCase();
  openSuggestions({
    cell: props.id,
    label: `${props.type === 'headers' ? 'Header' : 'Parameter'} ${props.field} suggestions`,
    anchor: box.value!,
    current: text,
    items: props
      .suggest()
      .filter(
        (option) => !query || `${option.value} ${option.detail}`.toLowerCase().includes(query),
      ),
    choose(value) {
      closeSuggestions();
      emit('update', value);
      finishEditing(props.id, true);
    },
  });
}
function begin(): void {
  edit();
  open(true);
  void nextTick(() => input.value?.focus());
}
function onInput(event: Event): void {
  edit();
  emit('update', (event.target as HTMLInputElement).value);
  open(false);
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!listOpen.value) open(true);
    if (!suggestions.items.length) return;
    suggestions.active =
      event.key === 'ArrowDown'
        ? (suggestions.active + 1) % suggestions.items.length
        : (suggestions.active <= 0 ? suggestions.items.length : suggestions.active) - 1;
    void nextTick(() =>
      document
        .getElementById(`kv-option-${suggestions.active}`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
  } else if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    if (listOpen.value && suggestions.active >= 0)
      suggestions.choose?.(suggestions.items[suggestions.active].value);
    else finishEditing(props.id, true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    finishEditing(props.id, true);
  } else if (event.key === 'Tab') closeSuggestions();
}
function onLabelKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== 'F2') return;
  event.preventDefault();
  event.stopPropagation();
  begin();
}
function toggleList(): void {
  edit();
  input.value?.focus();
  if (listOpen.value) closeSuggestions();
  else open(true);
}
</script>

<template>
  <div ref="box" :class="['kv-combobox', 'has-suggestions', { 'is-editing': isEditing }]">
    <button
      ref="label"
      type="button"
      :class="['kv-field-label', { 'is-empty': !value }]"
      :aria-label="`Edit row ${index + 1} ${field}`"
      title="Double-click or press Enter to edit"
      @dblclick="begin"
      @keydown="onLabelKeydown"
    >
      {{ value || placeholder }}</button
    ><input
      ref="input"
      :placeholder="placeholder"
      :aria-label="`Row ${index + 1} ${field}`"
      :value="value"
      :data-row="index"
      :data-type="type"
      :data-field="field"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      data-suggestions
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="listOpen"
      aria-controls="kv-suggestion-list"
      aria-haspopup="listbox"
      :aria-activedescendant="
        listOpen && suggestions.active >= 0 ? `kv-option-${suggestions.active}` : undefined
      "
      @input="onInput"
      @keydown="onKeydown"
      @blur="finishEditing(id)"
    /><button
      type="button"
      class="kv-suggestion-toggle"
      :aria-label="`Show ${type === 'headers' ? 'header' : 'parameter'} ${field} suggestions for row ${index + 1}`"
      tabindex="-1"
      @pointerdown.prevent
      @click="toggleList"
    >
      <MdiIcon name="chevron-down" />
    </button>
  </div>
</template>
