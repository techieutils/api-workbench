<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { confirmation, settleConfirmation } from '../../confirm';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';

/**
 * The app's confirmation dialog. A modal dialog element makes the rest of the window inert,
 * keeps focus inside, and cancels on Escape. Destructive confirmations start on Cancel; focus
 * returns to where it was when the dialog closes.
 */
const dialog = ref<HTMLDialogElement>();
const cancelButton = ref<InstanceType<typeof UiButton>>();
const confirmButton = ref<InstanceType<typeof UiButton>>();
let returnFocus: HTMLElement | null = null;

watch(
  () => confirmation.current,
  async (current, previous) => {
    if (current && !previous) returnFocus = document.activeElement as HTMLElement | null;
    await nextTick();
    if (current) {
      if (!dialog.value?.open) dialog.value?.showModal();
      const button = (current.tone === 'danger' ? cancelButton : confirmButton).value?.$el as
        HTMLButtonElement | undefined;
      button?.focus();
    } else {
      if (dialog.value?.open) dialog.value.close();
      returnFocus?.focus({ preventScroll: true });
      returnFocus = null;
    }
  },
);
function onCancel(event: Event): void {
  // Escape: answer "no" ourselves so the dialog closes through the same path.
  event.preventDefault();
  settleConfirmation(false);
}
</script>

<template>
  <dialog
    ref="dialog"
    class="confirm-dialog"
    :aria-labelledby="confirmation.current ? 'confirm-dialog-title' : undefined"
    :aria-describedby="confirmation.current?.message ? 'confirm-dialog-message' : undefined"
    data-confirm-dialog
    @cancel="onCancel"
  >
    <template v-if="confirmation.current">
      <div :class="['confirm-dialog-icon', confirmation.current.tone ?? 'default']">
        <MdiIcon
          :name="confirmation.current.tone === 'danger' ? 'alert-outline' : 'help-circle-outline'"
        />
      </div>
      <div class="confirm-dialog-copy">
        <h2 id="confirm-dialog-title">{{ confirmation.current.title }}</h2>
        <p v-if="confirmation.current.message" id="confirm-dialog-message">
          {{ confirmation.current.message }}
        </p>
      </div>
      <div class="confirm-dialog-actions">
        <UiButton
          ref="cancelButton"
          :label="confirmation.current.cancelLabel ?? 'Cancel'"
          data-confirm-cancel
          @click="settleConfirmation(false)"
        />
        <UiButton
          ref="confirmButton"
          :label="confirmation.current.confirmLabel ?? 'Confirm'"
          :variant="confirmation.current.tone === 'danger' ? 'danger' : 'primary'"
          data-confirm-accept
          @click="settleConfirmation(true)"
        />
      </div>
    </template>
  </dialog>
</template>
