<script setup lang="ts">
import MdiIcon from '../MdiIcon.vue';

withDefaults(
  defineProps<{
    label: string;
    icon?: MdiIconName;
    variant?: UIButtonVariant;
    type?: 'button' | 'submit';
    disabled?: boolean;
    shortcut?: string;
  }>(),
  { variant: 'secondary', type: 'button' },
);
</script>

<template>
  <button :type="type" :class="['ui-button', `ui-button-${variant}`]" :disabled="disabled">
    <MdiIcon v-if="icon" :name="icon" /><span>{{ label }}</span
    ><kbd v-if="shortcut" class="button-shortcut">{{ shortcut }}</kbd>
  </button>
</template>
