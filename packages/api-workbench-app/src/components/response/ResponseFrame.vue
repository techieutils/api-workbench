<script setup lang="ts">
import { useUiStore } from '../../stores/ui';
import UiIconButton from '../ui/UiIconButton.vue';

/** Response chrome shared by HTTP and live protocol responses. */
const ui = useUiStore();
defineProps<{ panelId: string; panelLabel: string; sourceEditor: boolean }>();
const panels = useUiStore().requestPanels;
</script>

<template>
  <section class="response">
    <div class="response-top">
      <div class="response-heading">
        <span class="response-marker"></span>
        <h2>Response</h2>
        <slot name="badge" />
      </div>
      <div class="response-meta">
        <slot name="meta" /><UiIconButton
          :label="panels.request ? 'Maximize response (⌘⇧M)' : 'Restore split (⌘⇧M)'"
          :icon="panels.request ? 'arrow-top-right' : 'view-split-horizontal'"
          class="response-maximize"
          data-maximize-response
          :aria-pressed="String(!panels.request)"
          @click="ui.toggleResponseMaximized()"
        />
      </div>
    </div>
    <div class="response-navigation"><slot name="navigation" /></div>
    <div class="response-body">
      <slot name="toolbar" />
      <slot name="status" />
      <div
        :id="panelId"
        :class="['code-area', { 'has-source-editor': sourceEditor }]"
        role="tabpanel"
        :aria-labelledby="panelLabel"
      >
        <slot />
      </div>
    </div>
  </section>
</template>
