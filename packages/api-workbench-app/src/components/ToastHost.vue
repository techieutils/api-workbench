<script setup lang="ts">
import { dismissToast, toasts, type ToastItem } from '../notifications';
import MdiIcon from './MdiIcon.vue';

/**
 * Shows toasts in the bottom-right corner, newest at the bottom. Each one leaves when its
 * progress bar finishes; hovering or focusing it pauses the bar. Errors are announced at once,
 * other toasts politely.
 */
const icons: Record<ToastItem['tone'], MdiIconName> = {
  success: 'check-circle-outline',
  error: 'close-circle-outline',
  warning: 'alert-outline',
  info: 'help-circle-outline',
};
function act(item: ToastItem): void {
  dismissToast(item.id);
  void item.action?.run();
}
</script>

<template>
  <section class="toast-region" aria-label="Notifications">
    <TransitionGroup name="toast" tag="div" class="toast-stack">
      <div
        v-for="item in toasts"
        :key="item.id"
        :class="['toast', `toast-${item.tone}`]"
        :role="item.tone === 'error' ? 'alert' : 'status'"
        :aria-live="item.tone === 'error' ? 'assertive' : 'polite'"
        :data-toast-tone="item.tone"
      >
        <span class="toast-message"
          ><strong v-if="item.title">{{ item.title }}</strong
          >{{ item.message }}</span
        ><MdiIcon :name="icons[item.tone]" class="toast-icon" /><button
          v-if="item.action"
          type="button"
          class="toast-action"
          data-toast-action
          @click="act(item)"
        >
          {{ item.action.label }}</button
        ><button
          type="button"
          class="toast-close"
          aria-label="Dismiss notification"
          data-toast-dismiss
          @click="dismissToast(item.id)"
        >
          <MdiIcon name="close" />
        </button>
        <span
          :key="item.version"
          class="toast-progress"
          :style="{ animationDuration: `${item.duration}ms` }"
          aria-hidden="true"
          @animationend="dismissToast(item.id)"
        ></span>
      </div>
    </TransitionGroup>
  </section>
</template>
