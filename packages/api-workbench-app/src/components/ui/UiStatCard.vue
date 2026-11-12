<script setup lang="ts">
import MdiIcon from '../MdiIcon.vue';

/** A headline number. With `link`, the card is a button that goes where the label says. */
withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    note: string;
    icon: MdiIconName;
    tone?: UITone;
    /** What clicking does, for screen readers and the tooltip, such as "Open Collections". */
    link?: string;
  }>(),
  { tone: 'brand', link: undefined },
);
</script>

<template>
  <component
    :is="link ? 'button' : 'article'"
    :type="link ? 'button' : undefined"
    :class="['metric-card', 'group', { 'metric-link': link }]"
    :title="link"
    :aria-label="link ? `${label}: ${value}. ${link}` : undefined"
  >
    <div class="flex items-center justify-between gap-3">
      <span class="metric-label">{{ label }}</span
      ><span :class="['metric-icon', tone]"><MdiIcon :name="icon" /></span>
    </div>
    <strong>{{ value }}</strong
    ><small>{{ note }}</small>
  </component>
</template>
