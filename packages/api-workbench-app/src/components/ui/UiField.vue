<script setup lang="ts">
/**
 * A labelled text input for uncontrolled forms read with FormData: `value` is the initial value,
 * and further attributes (maxlength, min, autocomplete…) go to the input.
 */
defineOptions({ inheritAttrs: false });
defineProps<{
  label: string;
  name: string;
  value?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  help?: string;
}>();
</script>

<template>
  <label class="form-field"
    ><span>{{ label }}<span v-if="required" class="field-required" aria-hidden="true">*</span></span
    ><input
      class="field-input"
      :name="name"
      :type="type || 'text'"
      :defaultValue="value ?? ''"
      :placeholder="placeholder || ''"
      :required="required"
      v-bind="$attrs"
    /><small v-if="help" class="field-help">{{ help }}</small></label
  >
</template>
