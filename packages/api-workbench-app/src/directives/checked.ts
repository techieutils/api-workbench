import type { Directive } from 'vue';

/**
 * Keeps a checkbox's live state equal to its value on every render. A `:checked` binding (and
 * checkbox v-model) skips the DOM when the value matches the previous render, so an edit undone
 * before Vue re-renders would leave the box showing the undone state.
 */
export const vChecked: Directive<HTMLInputElement, boolean> = {
  mounted(element, { value }) {
    element.checked = value;
  },
  updated(element, { value }) {
    element.checked = value;
  },
};
