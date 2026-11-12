<script setup lang="ts">
import MdiIcon from '../MdiIcon.vue';

/** A labelled setting. With `name`, the label and description point at `#setting-{name}`. */
defineProps<{ title: string; description: string; name?: string; icon?: MdiIconName }>();
</script>

<template>
  <div class="setting-row">
    <span v-if="icon" class="setting-icon" aria-hidden="true"><MdiIcon :name="icon" /></span>
    <div>
      <label v-if="name" :for="`setting-${name}`">{{ title }}</label
      ><strong v-else>{{ title }}</strong>
      <p :id="name ? `setting-${name}-description` : undefined">{{ description }}</p>
    </div>
    <div class="setting-control"><slot /></div>
  </div>
</template>
