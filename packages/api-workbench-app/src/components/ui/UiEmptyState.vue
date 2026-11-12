<script setup lang="ts">
import MdiIcon from '../MdiIcon.vue';

defineProps<{ icon: MdiIconName; title: string; description: string }>();
</script>

<template>
  <div class="empty-state">
    <span class="empty-icon"><MdiIcon :name="icon" /></span>
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
    <slot />
  </div>
</template>
