<script setup lang="ts">
import MdiIcon from '../MdiIcon.vue';

withDefaults(defineProps<{ label: string; tone?: UITone; icon?: MdiIconName }>(), {
  tone: 'neutral',
});
</script>

<template>
  <span :class="['badge', tone]"><MdiIcon v-if="icon" :name="icon" />{{ label }}</span>
</template>
