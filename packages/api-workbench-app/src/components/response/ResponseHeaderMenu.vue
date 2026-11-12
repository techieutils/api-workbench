<script setup lang="ts">
import { computed } from 'vue';
import { useContextMenu } from '../../composables/context-menu';
import { useRequestTestsStore } from '../../stores/request-tests';
import { toast } from '../../utils';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';

/**
 * A response header's context menu: copy its name, value, or both, and (for HTTP responses)
 * capture it into a variable from the request's Vars tab; a Set-Cookie row also offers each
 * cookie it sets.
 */
const props = defineProps<{
  capture?: boolean;
  /** The request captures go to: the current one unless named (History names an entry's). */
  requestId?: string;
  /** Why capturing is unavailable, shown with the disabled items (a deleted request). */
  captureUnavailable?: string;
}>();
const {
  menu: contextMenu,
  target: header,
  open,
  onKeydown,
} = useContextMenu<{ name: string; value: string; cookies?: string[] }>();
const items = computed<MenuItem[]>(() => [
  { id: 'name', label: 'Copy name', icon: 'content-copy' },
  { id: 'value', label: 'Copy value', icon: 'content-copy' },
  { id: 'header', label: 'Copy as header', icon: 'format-header-pound' },
  ...(props.capture
    ? [
        {
          id: 'capture',
          label: props.captureUnavailable
            ? `Capture into a variable · ${props.captureUnavailable}`
            : 'Capture into a variable',
          icon: 'variable',
          separated: true,
          disabled: Boolean(props.captureUnavailable),
        } satisfies MenuItem,
        // A Set-Cookie row offers each cookie it sets, captured by name.
        ...(header.value?.cookies ?? []).map(
          (name, index) =>
            ({
              id: `cookie-${index}`,
              label: name,
              icon: 'cookie-outline',
              disabled: Boolean(props.captureUnavailable),
              ...(index === 0 ? { heading: 'Capture a cookie' } : {}),
            }) satisfies MenuItem,
        ),
      ]
    : []),
]);
async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, 'success');
  } catch {
    toast(`The ${what.toLowerCase()} could not be copied`, 'error');
  }
}
/** Adds a Vars capture of the header to the current request, named after it. */
function captureHeader(name: string): void {
  const variable = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  useRequestTestsStore().addCapture(variable, `header ${name}`, name, props.requestId);
}
function select(command: string): void {
  const target = header.value;
  if (!target) return;
  if (command === 'name') void copy(target.name, 'Header name');
  else if (command === 'value') void copy(target.value, 'Header value');
  else if (command === 'header') void copy(`${target.name}: ${target.value}`, 'Header');
  else if (command === 'capture') captureHeader(target.name);
  else if (command.startsWith('cookie-')) {
    const name = target.cookies?.[Number(command.slice('cookie-'.length))];
    if (name) useRequestTestsStore().captureCookie(name, props.requestId);
  }
}
defineExpose({ open, onKeydown });
</script>

<template>
  <ContextMenu
    ref="contextMenu"
    label="Response header actions"
    :items="items"
    data-response-header-menu
    @select="select"
  />
</template>
