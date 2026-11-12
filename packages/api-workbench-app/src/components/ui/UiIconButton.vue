<script setup lang="ts">
import MdiIcon from '../MdiIcon.vue';

withDefaults(
  defineProps<{
    label: string;
    icon: MdiIconName;
    type?: 'button' | 'submit';
    disabled?: boolean;
  }>(),
  { type: 'button' },
);
</script>

<template>
  <button :type="type" class="icon-button" :title="label" :aria-label="label" :disabled="disabled">
    <MdiIcon :name="icon" />
  </button>
</template>
