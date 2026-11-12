<script setup lang="ts">
import type { GuideName } from '@techieutils/api-workbench-common/support-links';
import { openGuide } from '../../guides';
import UiButton from './UiButton.vue';

/** A screen's heading; `guide` adds a link to its page on the documentation site. */
defineProps<{ eyebrow: string; title: string; description: string; guide?: GuideName }>();
</script>

<template>
  <div class="page-heading">
    <div>
      <span class="eyebrow">{{ eyebrow }}</span>
      <h1>{{ title }}</h1>
      <p>{{ description }}</p>
    </div>
    <div class="page-actions">
      <slot />
      <UiButton
        v-if="guide"
        class="page-guide"
        label="Guide"
        icon="book-open-variant-outline"
        variant="ghost"
        title="Open the guide for this screen in your browser"
        data-testid="page-guide"
        @click="openGuide(guide)"
      />
    </div>
  </div>
</template>
