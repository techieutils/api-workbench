<script setup lang="ts">
import type { GuideName } from '@techieutils/api-workbench-common/support-links';
import { openGuide } from '../../guides';
import UiIconButton from './UiIconButton.vue';

/** A small button beside a tab's heading that opens that feature's guide in the browser. */
defineProps<{ guide: GuideName; topic: string }>();
</script>

<template>
  <UiIconButton
    class="guide-button"
    icon="book-open-variant-outline"
    :label="`Open the ${topic} guide in your browser`"
    :data-guide="guide"
    @click="openGuide(guide)"
  />
</template>
