<script setup lang="ts">
import { action } from '../actions';
import { useDialogsStore } from '../stores/dialogs';
import { openView } from '../navigation';
import MdiIcon from './MdiIcon.vue';
import ScrollRow from './ui/ScrollRow.vue';

const dialogs = useDialogsStore();
const quickActions: { title: string; description: string; icon: MdiIconName; run: () => void }[] = [
  {
    title: 'Create a request',
    description: 'Connect to an API endpoint',
    icon: 'plus',
    run: () => void action('new'),
  },
  {
    title: 'Import a collection',
    description: 'Collections, specifications, and ZIP',
    icon: 'import',
    run: () => dialogs.openTransfer('import'),
  },
  {
    title: 'Manage environments',
    description: 'Variables for every stage',
    icon: 'layers-outline',
    run: () => openView('Environments'),
  },
];
</script>

<template>
  <ScrollRow class="quick-actions" frame-class="quick-actions-frame" noun="quick actions">
    <button v-for="item in quickActions" :key="item.title" class="quick-action" @click="item.run()">
      <MdiIcon :name="item.icon" /><span
        ><strong>{{ item.title }}</strong
        ><small>{{ item.description }}</small></span
      ><MdiIcon name="chevron-right" />
    </button>
  </ScrollRow>
</template>
