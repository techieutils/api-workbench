<script setup lang="ts">
const paths = mdiPaths;

/** Paths come exclusively from the official @mdi/js package at build time. */
defineProps<{ name: MdiIconName }>();
</script>

<template>
  <svg
    class="mdi-icon"
    :data-mdi="name"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="paths[name]" />
  </svg>
</template>
