<script setup lang="ts">
import MdiIcon from '../MdiIcon.vue';

defineProps<{ title: string; description: string; icon?: MdiIconName }>();
</script>

<template>
  <div class="section-heading">
    <div>
      <h2><MdiIcon v-if="icon" :name="icon" class="section-heading-icon" />{{ title }}</h2>
      <p>{{ description }}</p>
    </div>
    <div class="flex items-center gap-2"><slot /></div>
  </div>
</template>
