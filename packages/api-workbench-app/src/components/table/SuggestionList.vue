<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import MdiIcon from '../MdiIcon.vue';
import { suggestions } from './cell-editing';

/** The suggestion list for the editing Params or Headers cell, positioned under (or over) it. */
const list = ref<HTMLElement>();
watch(
  () => suggestions.cell && suggestions.anchor,
  async (anchor) => {
    if (!anchor) return;
    await nextTick();
    const popup = list.value;
    if (!popup) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 24);
    const availableBelow = window.innerHeight - rect.bottom - 12;
    const above = availableBelow < 180 && rect.top > availableBelow;
    Object.assign(popup.style, {
      width: `${width}px`,
      maxHeight: `${Math.min(280, Math.max(100, above ? rect.top - 12 : availableBelow))}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      top: above ? '' : `${rect.bottom + 4}px`,
      bottom: above ? `${window.innerHeight - rect.top + 4}px` : '',
    });
    if (!popup.matches(':popover-open')) popup.showPopover();
  },
);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="suggestions.cell"
      id="kv-suggestion-list"
      ref="list"
      :class="['kv-suggestions', { 'is-rich': suggestions.items.some((item) => item.icon) }]"
      popover="manual"
      role="listbox"
      :aria-label="suggestions.label"
      @pointerdown.prevent
    >
      <template v-if="suggestions.items.length">
        <template v-for="(option, index) in suggestions.items" :key="option.value">
          <div
            v-if="option.group && option.group !== suggestions.items[index - 1]?.group"
            class="kv-suggestion-group"
            role="presentation"
          >
            <span>{{ option.group }}</span
            ><span class="kv-suggestion-count">{{
              suggestions.items.filter((item) => item.group === option.group).length
            }}</span>
          </div>
          <div
            :id="`kv-option-${index}`"
            role="option"
            :aria-selected="index === suggestions.active"
            :data-suggestion-index="index"
            :class="[
              'kv-suggestion-option',
              {
                active: index === suggestions.active,
                'is-current': option.value === suggestions.current,
              },
            ]"
            @click="suggestions.choose?.(option.value)"
            @pointermove="suggestions.active = index"
          >
            <MdiIcon v-if="option.icon" :name="option.icon" class="kv-suggestion-icon" /><span
              ><strong>{{ option.label ?? option.value }}</strong
              ><em v-if="option.badge" class="kv-suggestion-badge">{{ option.badge }}</em
              ><small :title="option.detail">{{ option.detail }}</small></span
            ><MdiIcon v-if="option.value === suggestions.current" name="check-circle-outline" />
          </div>
        </template>
        <div
          v-if="suggestions.items.some((item) => item.group)"
          class="kv-suggestion-footer"
          aria-hidden="true"
        >
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> choose</span
          ><span><kbd>Esc</kbd> close</span>
        </div>
      </template>
      <p v-else class="kv-no-suggestions">No suggestions match. You can enter any custom value.</p>
    </div>
  </Teleport>
</template>
