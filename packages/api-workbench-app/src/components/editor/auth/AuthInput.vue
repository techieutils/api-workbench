<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../../select-options';
import { vChecked } from '../../../directives/checked';
import UiSelect from '../../ui/UiSelect.vue';

/**
 * One authentication field. `field` names an AuthConfig field (token, username, password) and
 * `option` an AuthOptions key; the matching data attribute identifies the control.
 */
const props = defineProps<{
  label: string;
  value: string | boolean | undefined;
  field?: 'token' | 'username' | 'password';
  option?: keyof AuthOptions;
  secret?: boolean;
  placeholder?: string;
  multiline?: boolean;
  checkbox?: boolean;
  choices?: [string, string][];
}>();
const emit = defineEmits<{ update: [value: string | boolean] }>();
const attributes = () =>
  props.field ? { 'data-auth': props.field } : { 'data-auth-option': props.option };
const text = () => String(props.value ?? '');
const input = (event: Event) => emit('update', (event.target as HTMLInputElement).value);
</script>

<template>
  <label v-if="checkbox" class="auth-check"
    ><input
      v-bind="attributes()"
      v-checked="value === true"
      type="checkbox"
      @change="emit('update', ($event.target as HTMLInputElement).checked)"
    /><span>{{ label }}</span></label
  >
  <label v-else class="form-field"
    ><span>{{ label }}</span
    ><UiSelect
      v-if="choices"
      v-bind="attributes()"
      class="field-input"
      :value="text()"
      @change="input"
      :options="withIcons(choices, OPTION_ICONS.authChoice, 'tune-variant')" /><textarea
      v-else-if="multiline"
      v-bind="attributes()"
      class="field-input auth-textarea"
      :placeholder="placeholder || ''"
      autocomplete="off"
      spellcheck="false"
      rows="4"
      :value="text()"
      @input="input"
    ></textarea
    ><input
      v-else
      v-bind="attributes()"
      class="field-input"
      :placeholder="placeholder || ''"
      autocomplete="off"
      spellcheck="false"
      :type="secret ? 'password' : 'text'"
      :value="text()"
      @input="input"
  /></label>
</template>
