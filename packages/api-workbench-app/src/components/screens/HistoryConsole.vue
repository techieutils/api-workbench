<script setup lang="ts">
import { computed } from 'vue';
import type { HistoryConsoleEntry } from '@techieutils/api-workbench-common/types';
import { captureVariableName } from '@techieutils/api-workbench-common/capture-suggestions';
import { useContextMenu } from '../../composables/context-menu';
import { useRequestTestsStore } from '../../stores/request-tests';
import { useWorkspaceStore } from '../../stores/workspace';
import { toast } from '../../utils';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import MdiIcon from '../MdiIcon.vue';

/**
 * A send's request console lines, as History keeps them. A line's menu copies it, and captures
 * into the entry's request what it reports: the outcome line its status, time, and size; the
 * cookie line each cookie; the failure line its error (and total time, when timing was kept).
 */
const props = defineProps<{
  lines: HistoryConsoleEntry[];
  requestId: string;
  /** Cookies the response set, offered by the cookie line. */
  cookieNames?: string[];
  /** Whether the failed request's timing was kept, so its total time can be captured. */
  hasTiming?: boolean;
  /** Why capturing is unavailable, shown with the disabled items (a deleted request). */
  captureUnavailable?: string;
}>();
const workspace = useWorkspaceStore();
const tests = useRequestTestsStore();
const LEVEL_ICONS: Record<HistoryConsoleEntry['level'], MdiIconName> = {
  info: 'information-outline',
  success: 'check-circle-outline',
  error: 'alert-circle-outline',
};
interface LineCapture {
  id: string;
  label: string;
  source: string;
  name: string;
}
/** The captures a line offers: the values it reports. */
function lineCaptures(line: HistoryConsoleEntry | undefined): LineCapture[] {
  if (line?.kind === 'completed')
    return [
      { id: 'status', label: 'Status', source: 'status', name: 'status' },
      { id: 'time', label: 'Time (ms)', source: 'time', name: 'time_ms' },
      { id: 'size', label: 'Size (bytes)', source: 'size', name: 'size_bytes' },
    ];
  if (line?.kind === 'failed')
    return [
      { id: 'error', label: 'Error', source: 'error', name: 'error' },
      ...(props.hasTiming
        ? [{ id: 'total', label: 'Total time (ms)', source: 'timing total', name: 'total_ms' }]
        : []),
    ];
  return [];
}

const { menu, target, open, onKeydown } = useContextMenu<HistoryConsoleEntry>();
const items = computed<MenuItem[]>(() => {
  const line = target.value;
  const disabled = Boolean(props.captureUnavailable);
  const heading = (index: number, text: string) => (index === 0 ? { heading: text } : {});
  const values: MenuItem[] = lineCaptures(line).map((capture, index) => ({
    id: `capture-${capture.id}`,
    label: capture.label,
    icon: 'variable' as const,
    disabled,
    ...heading(index, 'Capture into a variable'),
  }));
  const cookies: MenuItem[] =
    line?.kind === 'cookies'
      ? (props.cookieNames ?? []).map((name, index) => ({
          id: `cookie-${index}`,
          label: name,
          icon: 'cookie-outline' as const,
          disabled,
          ...heading(index, 'Capture a cookie'),
        }))
      : [];
  return [{ id: 'copy', label: 'Copy message', icon: 'content-copy' }, ...values, ...cookies];
});
async function select(command: string): Promise<void> {
  const line = target.value;
  if (!line) return;
  const capture = lineCaptures(line).find((item) => command === `capture-${item.id}`);
  if (capture) {
    const request = workspace.state.requests.find((item) => item.id === props.requestId);
    const taken = (request?.captures ?? []).map((row) => row.key.trim());
    tests.addCapture(
      captureVariableName(undefined, taken, capture.name),
      capture.source,
      capture.label.toLowerCase(),
      props.requestId,
    );
    return;
  }
  if (command.startsWith('cookie-')) {
    const name = props.cookieNames?.[Number(command.slice('cookie-'.length))];
    if (name) tests.captureCookie(name, props.requestId);
    return;
  }
  try {
    await navigator.clipboard.writeText(line.message);
    toast('Message copied', 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
</script>

<template>
  <p v-if="!lines.length" class="field-help">
    No console lines were kept for this entry. Sends from now on keep them.
  </p>
  <div v-else class="console-events history-console" aria-label="Request events">
    <div
      v-for="(line, index) in lines"
      :key="index"
      :class="['console-entry', line.level]"
      tabindex="0"
      :data-history-console="index"
      @contextmenu="open($event, line)"
      @keydown="onKeydown($event, line)"
    >
      <time>{{ new Date(line.at).toLocaleTimeString() }}</time
      ><span class="console-level"
        ><MdiIcon :name="LEVEL_ICONS[line.level]" />{{ line.level.toUpperCase() }}</span
      ><span class="console-message"
        ><span>{{ line.message }}</span></span
      >
    </div>
  </div>
  <ContextMenu
    ref="menu"
    label="History console actions"
    :items="items"
    data-history-console-menu
    @select="select"
  />
</template>
