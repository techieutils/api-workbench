<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';
import MdiIcon from '../MdiIcon.vue';

/**
 * The app's select box: a combobox button and a searchable listbox (WAI-ARIA select-only
 * combobox), shown in the top layer so scrolling containers and dialogs never clip it.
 *
 * A visually hidden native select stays the source of truth: it receives the id, name, data
 * attributes, `required`, and listeners passed to this component, so forms read it with
 * FormData, labels and scripts find it by id, and `@change` handlers get a real change event
 * whose target holds the new value. Choosing an option sets it and dispatches that event.
 */
export interface SelectOption {
  value: string;
  label: string;
  /** An icon before the label, in the list and in the closed box. */
  icon?: MdiIconName;
  /** A second line under the label. */
  description?: string;
  /** Options with the same group are listed under a heading, in the order given. */
  group?: string;
  disabled?: boolean;
  /** Classes for the label. */
  class?: string;
  /** Attributes for the option's row, such as `data-method` for a method colour. */
  attrs?: Record<string, string>;
}
type OptionInput = SelectOption | [string, string] | string;

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    options: readonly OptionInput[];
    value?: string;
    modelValue?: string;
    placeholder?: string;
    /** Show a search field; by default, lists of more than ten options have one. */
    searchable?: boolean;
    /** Attributes for the visible box (other attributes go to the native select). */
    rootAttrs?: Record<string, string | undefined>;
  }>(),
  { value: undefined, modelValue: undefined, placeholder: 'Select…', searchable: undefined },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const attrs = useAttrs();

const uid = `ui-select-${Math.random().toString(36).slice(2, 10)}`;
const normalized = computed<SelectOption[]>(() =>
  props.options.map((option) =>
    typeof option === 'string'
      ? { value: option, label: option }
      : Array.isArray(option)
        ? { value: option[0], label: option[1] }
        : option,
  ),
);
const selected = ref(props.modelValue ?? props.value ?? '');
watch(
  () => props.modelValue ?? props.value,
  (value) => {
    if (value !== undefined) selected.value = value;
  },
);
const current = computed(() => normalized.value.find((option) => option.value === selected.value));
/** The native select mirrors the grouping: consecutive options of a group share an optgroup. */
const nativeSegments = computed(() => {
  const segments: { group?: string; options: SelectOption[] }[] = [];
  for (const option of normalized.value) {
    const last = segments.at(-1);
    if (last && last.group === option.group) last.options.push(option);
    else segments.push({ group: option.group, options: [option] });
  }
  return segments;
});

// Attributes: layout and look on the wrapper; identity, form, and listeners on the native select.
const wrapperAttrs = computed(() => ({ class: attrs.class, style: attrs.style }));
const nativeAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs;
  return rest;
});
const disabled = computed(() => attrs.disabled !== undefined && attrs.disabled !== false);
const ariaLabel = computed(() => (attrs['aria-label'] as string | undefined) || undefined);

const trigger = ref<HTMLButtonElement>();
const native = ref<HTMLSelectElement>();
const menu = ref<HTMLElement>();
const search = ref<HTMLInputElement>();
const open = ref(false);
const query = ref('');
const active = ref(-1);
const labelledBy = ref<string>();
const searchable = computed(() => props.searchable ?? normalized.value.length > 10);
const visible = computed(() => {
  const text = query.value.trim().toLowerCase();
  return normalized.value.filter(
    (option) =>
      !text ||
      `${option.label} ${option.description ?? ''} ${option.group ?? ''}`
        .toLowerCase()
        .includes(text),
  );
});
/** Visible options with a heading before each new group. */
const rows = computed(() => {
  let group: string | undefined;
  return visible.value.map((option, index) => {
    const heading = option.group && option.group !== group ? option.group : undefined;
    group = option.group;
    return { option, index, heading };
  });
});
const optionId = (index: number) => `${uid}-option-${index}`;

/** A label pointing at the native select by id names the trigger instead. */
onMounted(() => {
  const id = native.value?.id;
  const label = id
    ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)
    : null;
  if (label) {
    label.id ||= `${uid}-label`;
    labelledBy.value = `${label.id} ${uid}-value`;
  }
});

function place(): void {
  if (!trigger.value || !menu.value) return;
  const box = (trigger.value.parentElement ?? trigger.value).getBoundingClientRect();
  if (box.bottom < 0 || box.top > window.innerHeight) return close();
  // Second lines need room to read on one line, so a list with descriptions opens wider.
  const minimum = normalized.value.some((option) => option.description) ? 260 : 180;
  const width = Math.min(Math.max(box.width, minimum), window.innerWidth - 16);
  const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8);
  const below = window.innerHeight - box.bottom - 8;
  const above = box.top - 8;
  const upward = below < 220 && above > below;
  const style = menu.value.style;
  style.left = `${left}px`;
  style.width = `${width}px`;
  style.maxHeight = `${Math.max(120, Math.min(340, upward ? above - 4 : below - 4))}px`;
  style.top = upward ? '' : `${box.bottom + 4}px`;
  style.bottom = upward ? `${window.innerHeight - box.top + 4}px` : '';
}
function scrollActive(): void {
  void nextTick(() =>
    menu.value?.querySelector(`#${optionId(active.value)}`)?.scrollIntoView({ block: 'nearest' }),
  );
}
function show(): void {
  if (disabled.value || open.value || !menu.value) return;
  query.value = '';
  active.value = Math.max(
    0,
    visible.value.findIndex((option) => option.value === selected.value),
  );
  place();
  menu.value.showPopover();
  open.value = true;
  scrollActive();
  if (searchable.value) void nextTick(() => search.value?.focus());
}
function close(restoreFocus = false): void {
  if (menu.value?.matches(':popover-open')) menu.value.hidePopover();
  open.value = false;
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function onToggle(event: Event): void {
  // Light dismiss (a click elsewhere) closes the popover without our help.
  if ((event as ToggleEvent).newState === 'closed') open.value = false;
}
function choose(option: SelectOption | undefined): void {
  if (!option || option.disabled || !native.value) return;
  close(true);
  if (option.value === selected.value) return;
  native.value.value = option.value;
  // A native select fires input, then change.
  native.value.dispatchEvent(new Event('input', { bubbles: true }));
  native.value.dispatchEvent(new Event('change', { bubbles: true }));
}
/** The native select changed, by a choice here or by a script. */
function onNativeChange(event: Event): void {
  selected.value = (event.target as HTMLSelectElement).value;
  emit('update:modelValue', selected.value);
}
function move(step: number, from = active.value): void {
  const options = visible.value;
  if (!options.length) return;
  let index = from;
  for (let tries = 0; tries < options.length; tries++) {
    index = Math.min(options.length - 1, Math.max(0, index + step));
    if (!options[index].disabled) break;
    if (index === 0 || index === options.length - 1) break;
  }
  if (!options[index].disabled) active.value = index;
  scrollActive();
}
// Type-ahead, as native selects do: letters typed in quick succession find a matching label.
let typed = '';
let typedAt = 0;
function typeAhead(key: string): SelectOption | undefined {
  typed = Date.now() - typedAt > 700 ? key : typed + key;
  typedAt = Date.now();
  const options = visible.value;
  const start =
    (open.value ? active.value : options.findIndex((o) => o.value === selected.value)) +
    (typed.length === 1 ? 1 : 0);
  for (let offset = 0; offset < options.length; offset++) {
    const option = options[(Math.max(0, start) + offset) % options.length];
    if (!option.disabled && option.label.toLowerCase().startsWith(typed.toLowerCase()))
      return option;
  }
  return undefined;
}
function onKeydown(event: KeyboardEvent): void {
  if (disabled.value) return;
  const key = event.key;
  if (!open.value) {
    if (
      ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key) ||
      (key === 'ArrowDown' && event.altKey)
    ) {
      event.preventDefault();
      show();
    } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const match = typeAhead(key);
      if (match) choose(match);
    }
    return;
  }
  const typing = event.target === search.value;
  if (key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (key === 'Tab') close();
  else if (key === 'ArrowDown' || key === 'ArrowUp') {
    event.preventDefault();
    if (event.altKey) return choose(visible.value[active.value]);
    move(key === 'ArrowDown' ? 1 : -1);
  } else if ((key === 'Home' || key === 'End') && !typing) {
    event.preventDefault();
    move(key === 'Home' ? 1 : -1, key === 'Home' ? -1 : visible.value.length);
  } else if (key === 'PageDown' || key === 'PageUp') {
    event.preventDefault();
    move(key === 'PageDown' ? 10 : -10);
  } else if (key === 'Enter' || (key === ' ' && !typing)) {
    event.preventDefault();
    choose(visible.value[active.value]);
  } else if (!typing && key.length === 1 && !event.metaKey && !event.ctrlKey) {
    const match = typeAhead(key);
    if (match) {
      active.value = visible.value.indexOf(match);
      scrollActive();
    }
  }
}
watch(query, () => {
  active.value = visible.value.findIndex((option) => !option.disabled);
});
// Keep the open list beside its trigger while the page scrolls or resizes.
const reposition = () => open.value && place();
onMounted(() => {
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
});
onBeforeUnmount(() => {
  window.removeEventListener('scroll', reposition, true);
  window.removeEventListener('resize', reposition);
});
</script>

<template>
  <div
    v-bind="rootAttrs"
    :class="['ui-select', wrapperAttrs.class, { open, disabled }]"
    :style="wrapperAttrs.style as never"
  >
    <button
      ref="trigger"
      type="button"
      class="ui-select-trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="`${uid}-listbox`"
      :aria-activedescendant="open && !searchable && active >= 0 ? optionId(active) : undefined"
      :aria-label="ariaLabel"
      :aria-labelledby="ariaLabel ? undefined : labelledBy"
      :disabled="disabled"
      :title="current?.label"
      @click="open ? close(true) : show()"
      @keydown="onKeydown"
    >
      <MdiIcon v-if="current?.icon" :name="current.icon" class="ui-select-value-icon" />
      <span
        :id="`${uid}-value`"
        :class="['ui-select-value', current?.class, { placeholder: !current }]"
        >{{ current?.label ?? placeholder }}</span
      >
      <MdiIcon name="chevron-down" class="ui-select-chevron" />
    </button>
    <select
      ref="native"
      v-bind="nativeAttrs"
      class="ui-select-native"
      tabindex="-1"
      aria-hidden="true"
      :value="selected"
      @change="onNativeChange"
      @focus="trigger?.focus()"
    >
      <option v-if="!current" value="" disabled>{{ placeholder }}</option>
      <template v-for="(segment, index) in nativeSegments" :key="index">
        <optgroup v-if="segment.group" :label="segment.group">
          <option
            v-for="option in segment.options"
            :key="option.value"
            :value="option.value"
            :disabled="option.disabled"
          >
            {{ option.label }}
          </option>
        </optgroup>
        <template v-else>
          <option
            v-for="option in segment.options"
            :key="option.value"
            :value="option.value"
            :disabled="option.disabled"
          >
            {{ option.label }}
          </option>
        </template>
      </template>
    </select>
    <!--
      Clicks in the list are not allowed to activate a label the select sits in: that would click
      the trigger again and reopen the list just closed.
    -->
    <div
      ref="menu"
      popover="auto"
      class="ui-select-menu"
      @toggle="onToggle"
      @keydown="onKeydown"
      @click.prevent
    >
      <div v-if="searchable" class="ui-select-search">
        <MdiIcon name="magnify" /><input
          ref="search"
          v-model="query"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          :aria-controls="`${uid}-listbox`"
          :aria-expanded="open"
          :aria-activedescendant="active >= 0 ? optionId(active) : undefined"
          aria-label="Filter options"
          placeholder="Filter…"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <ul
        :id="`${uid}-listbox`"
        role="listbox"
        :aria-label="ariaLabel"
        :aria-labelledby="ariaLabel ? undefined : labelledBy"
      >
        <template v-for="{ option, index, heading } in rows" :key="option.value">
          <li v-if="heading" class="ui-select-group" role="presentation">{{ heading }}</li>
          <li
            :id="optionId(index)"
            role="option"
            :aria-selected="option.value === selected"
            :aria-disabled="option.disabled || undefined"
            v-bind="option.attrs"
            :data-value="option.value"
            :class="[
              'ui-select-option',
              { active: index === active, selected: option.value === selected },
            ]"
            @pointerenter="!option.disabled && (active = index)"
            @pointerdown.prevent
            @click="choose(option)"
          >
            <MdiIcon v-if="option.icon" :name="option.icon" class="ui-select-option-icon" />
            <span class="ui-select-option-text"
              ><span :class="option.class">{{ option.label }}</span
              ><small v-if="option.description">{{ option.description }}</small></span
            ><MdiIcon v-if="option.value === selected" name="check" class="ui-select-check" />
          </li>
        </template>
        <li v-if="!rows.length" class="ui-select-empty" role="presentation">No matching options</li>
      </ul>
    </div>
  </div>
</template>
