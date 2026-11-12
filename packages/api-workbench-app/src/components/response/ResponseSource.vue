<script setup lang="ts">
import { computed } from 'vue';
import { useRendered } from '../../composables/rendered';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSourceEditorsStore } from '../../stores/source-editors';
import { isByteView, useResponseStore } from '../../stores/response';
import { bodyCapture, headerLineCapture } from '../../composables/body-capture';
import SourceEditor from '../SourceEditor.vue';
import { objectId } from '../../utils';

/**
 * The response body, or the Raw view of another inspector tab, in a read-only source editor.
 * It registers as `responseSourceEditor`, which formatting and the JSON filter update in place.
 */
const store = useResponseStore();
const editors = useSourceEditorsStore();
const workspace = useWorkspaceStore();
// The response arrives by replacing request.response, which render() reports.
const source = useRendered(() => store.inspectorSource(workspace.current()));
const responseId = useRendered(() => objectId(workspace.current().response));
const wrap = computed(() => workspace.settings().wordWrap);
/** A new response, tab, or mode shows fresh content, so the editor re-mounts and re-formats. */
const key = computed(
  () => `${responseId.value}:${store.tab}:${store.mode}:${source.value.language}:${wrap.value}`,
);
/** Capture value in the body menu, unless the view does not show the body as received. */
function capture(target: { text: string; from: number; to: number }) {
  const request = workspace.current();
  // Raw headers: the header (or cookie) on the line.
  if (store.tab === 'Headers') return headerLineCapture(target, request);
  if (isByteView(source.value.language)) return { reason: 'not in hex or Base64 views' };
  // A filtered view shows the filter's result, whose paths are not the body's.
  if (store.filteredBody(request)) return { reason: 'clear the filter first' };
  return bodyCapture(target, request.response?.body ?? '', request);
}
function onFormat(): void {
  if (store.tab !== 'Body') return;
  store.mode = 'Pretty';
  void editors.formatResponse(true);
}
</script>

<template>
  <SourceEditor
    id="response-source-editor"
    :key="key"
    class="source-editor-host response-editor-host"
    :value="source.text"
    :language="source.language"
    :wrap="wrap"
    read-only
    context-menu
    :formattable="store.tab === 'Body'"
    :capture="['Body', 'Headers'].includes(store.tab) ? capture : undefined"
    :label="`Response ${store.tab.toLowerCase()} editor (read only)`"
    @format="onFormat"
    @handle="editors.setResponseEditor($event)"
  />
</template>
