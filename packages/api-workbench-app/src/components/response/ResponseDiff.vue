<script setup lang="ts">
import { computed } from 'vue';
import * as diff from '@techieutils/api-workbench-common/diff';
import {
  captureVariableName,
  jsonPathAtLine,
} from '@techieutils/api-workbench-common/capture-suggestions';
import { useContextMenu } from '../../composables/context-menu';
import { useRequestTestsStore } from '../../stores/request-tests';
import { useResponseStore } from '../../stores/response';
import { useWorkspaceStore } from '../../stores/workspace';
import { toast } from '../../utils';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import MdiIcon from '../MdiIcon.vue';

/** What a side of the comparison shows: a response, or a response History kept. */
export interface ComparedResponse {
  status: number;
  time: number;
  size: number;
  body: string;
  headers: Record<string, string>;
}
/**
 * Two responses side by side: summary deltas, a body diff, and changed headers. With `capture`,
 * a body line (JSON), a header, or the status, time, or size has a menu that copies it or
 * captures it into a request: the current one, or `requestId`'s, which then opens (History).
 */
const props = defineProps<{
  baseline: ComparedResponse;
  current: ComparedResponse;
  baselineLabel: string;
  currentLabel: string;
  sortKeys: boolean;
  changesOnly: boolean;
  capture?: boolean;
  requestId?: string;
  /** Why capturing is unavailable, shown with the disabled item (a deleted request). */
  captureUnavailable?: string;
}>();
const store = useResponseStore();
const workspace = useWorkspaceStore();
const tests = useRequestTestsStore();
const MAX_ROWS = store.limits.rows;

const normalized = computed(() => ({
  before: diff.normalizeBody(props.baseline.body, props.sortKeys),
  after: diff.normalizeBody(props.current.body, props.sortKeys),
}));
const body = computed(() =>
  diff.sideBySide(normalized.value.before.text, normalized.value.after.text),
);
const rows = computed(() => (props.changesOnly ? diff.foldRows(body.value.rows) : body.value.rows));
const identical = computed(() => body.value.added === 0 && body.value.removed === 0);
const changedHeaders = computed(() =>
  diff
    .diffHeaders(props.baseline.headers, props.current.headers, store.limits.volatileHeaders)
    .filter((header) => header.kind !== 'same'),
);

/** Splits a changed line around the part that differs from its counterpart. */
function segments(text: string, other: string | undefined, kind: string) {
  if (kind !== 'change' || other === undefined) return { before: text || ' ', mark: '', after: '' };
  const { prefix, suffix } = diff.changedSpan(text, other);
  return {
    before: text.slice(0, prefix),
    mark: text.slice(prefix, text.length - suffix),
    after: text.slice(text.length - suffix),
  };
}
function delta(before: number, after: number, unit: string) {
  const format =
    unit === 'KB'
      ? (value: number) => (value / 1024).toFixed(2)
      : (value: number) => String(Math.round(value));
  const difference = after - before;
  return {
    tone: difference === 0 ? '' : difference > 0 ? 'is-up' : 'is-down',
    text: `${format(before)} → ${format(after)} ${unit}`,
    change: difference ? `${difference > 0 ? '+' : '−'}${format(Math.abs(difference))}` : '',
  };
}

/** What a menu acts on: text to copy, and the capture that reads the value from a response. */
interface DiffTarget {
  label: string;
  copy: string;
  source?: string;
  /** The capture's variable name, or the JSON path it is named after. */
  name?: string;
  path?: string;
}
const chips = computed(() => [
  {
    key: 'time',
    label: 'Time',
    icon: 'timer-outline' as const,
    ...delta(props.baseline.time, props.current.time, 'ms'),
    target: { label: 'Time', copy: String(props.current.time), source: 'time', name: 'time_ms' },
  },
  {
    key: 'size',
    label: 'Size',
    icon: 'file-code-outline' as const,
    ...delta(props.baseline.size, props.current.size, 'KB'),
    target: {
      label: 'Size',
      copy: String(props.current.size),
      source: 'size',
      name: 'size_bytes',
    },
  },
]);
const statusTarget = computed<DiffTarget>(() => ({
  label: 'Status',
  copy: String(props.current.status),
  source: 'status',
  name: 'status',
}));
/** A body line: in JSON, the value on it, captured by its path. */
function lineTarget(side: 'left' | 'right', row: diff.DiffRow): DiffTarget | undefined {
  const cell = row[side];
  if (!cell) return undefined;
  const shown = side === 'left' ? normalized.value.before : normalized.value.after;
  const path = shown.json ? jsonPathAtLine(shown.text, cell.line) : undefined;
  return { label: 'Line', copy: cell.text, ...(path ? { source: path, path } : {}) };
}
function headerTarget(header: diff.HeaderChange): DiffTarget {
  return {
    label: header.name,
    copy: header.after ?? header.before ?? '',
    source: `header ${header.name}`,
    name: header.name,
  };
}

const { menu, target, open, onKeydown } = useContextMenu<DiffTarget>();
const items = computed<MenuItem[]>(() => [
  {
    id: 'copy',
    label: target.value?.label === 'Line' ? 'Copy line' : 'Copy value',
    icon: 'content-copy',
  },
  ...(props.capture
    ? [
        {
          id: 'capture',
          label: props.captureUnavailable
            ? `Capture into a variable · ${props.captureUnavailable}`
            : target.value?.source
              ? 'Capture into a variable'
              : 'Capture into a variable · JSON values only',
          icon: 'variable',
          separated: true,
          disabled: Boolean(props.captureUnavailable) || !target.value?.source,
        } satisfies MenuItem,
      ]
    : []),
]);
function openFor(event: MouseEvent | KeyboardEvent, item: DiffTarget | undefined): void {
  if (!item) return;
  if (event instanceof KeyboardEvent) onKeydown(event, item);
  else open(event, item);
}
async function select(command: string): Promise<void> {
  const item = target.value;
  if (!item) return;
  if (command === 'capture' && item.source) {
    const request = props.requestId
      ? workspace.state.requests.find((entry) => entry.id === props.requestId)
      : workspace.current();
    const taken = (request?.captures ?? []).map((capture) => capture.key.trim());
    const variable = item.path
      ? captureVariableName(item.path, taken)
      : captureVariableName(undefined, taken, item.name);
    tests.addCapture(variable, item.source, item.path ?? item.label.toLowerCase(), props.requestId);
    return;
  }
  try {
    await navigator.clipboard.writeText(item.copy);
    toast('Copied', 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
</script>

<template>
  <div class="compare-summary">
    <span
      :class="['compare-chip', { 'is-changed': baseline.status !== current.status }]"
      :tabindex="capture ? 0 : undefined"
      data-compare-chip="status"
      @contextmenu="capture && openFor($event, statusTarget)"
      @keydown="capture && openFor($event, statusTarget)"
      ><MdiIcon name="check-circle-outline" /><span>Status</span
      ><strong>{{ baseline.status }} → {{ current.status }}</strong></span
    >
    <span
      v-for="chip in chips"
      :key="chip.key"
      :class="['compare-chip', chip.tone]"
      :tabindex="capture ? 0 : undefined"
      :data-compare-chip="chip.key"
      @contextmenu="capture && openFor($event, chip.target)"
      @keydown="capture && openFor($event, chip.target)"
      ><MdiIcon :name="chip.icon" /><span>{{ chip.label }}</span
      ><strong>{{ chip.text }}</strong
      ><small v-if="chip.change">{{ chip.change }}</small></span
    >
    <span :class="['compare-chip', { 'is-changed': !identical }]"
      ><MdiIcon name="code-tags" /><span>Body</span
      ><strong>{{
        identical ? 'Identical' : `+${body.added} −${body.removed} lines`
      }}</strong></span
    >
    <span :class="['compare-chip', { 'is-changed': changedHeaders.length }]"
      ><MdiIcon name="swap-horizontal" /><span>Headers</span
      ><strong>{{
        changedHeaders.length ? `${changedHeaders.length} changed` : 'Same'
      }}</strong></span
    >
  </div>
  <p v-if="body.truncated" class="field-help">
    The bodies differ too much for a line-by-line match; both are shown in full.
  </p>
  <div class="compare-grid" role="table" aria-label="Response body differences">
    <div class="compare-heading" role="row">
      <span></span><strong>{{ baselineLabel }}</strong
      ><span></span><strong>{{ currentLabel }}</strong>
    </div>
    <div v-if="identical && changesOnly" class="compare-fold">Bodies are identical.</div>
    <template v-else>
      <template v-for="(row, index) in rows.slice(0, MAX_ROWS)" :key="index">
        <div v-if="'hidden' in row" class="compare-fold">
          <MdiIcon name="dots-horizontal" />{{ row.hidden }} unchanged line{{
            row.hidden === 1 ? '' : 's'
          }}
        </div>
        <div
          v-else
          :class="['compare-row', `is-${row.kind}`]"
          :tabindex="capture ? 0 : undefined"
          :data-compare-row="index"
          @keydown="capture && openFor($event, lineTarget('right', row) ?? lineTarget('left', row))"
        >
          <span class="compare-number">{{ row.left?.line ?? '' }}</span
          ><code
            class="compare-left"
            @contextmenu="capture && openFor($event, lineTarget('left', row))"
            ><template v-if="row.left"
              >{{ segments(row.left.text, row.right?.text, row.kind).before
              }}<mark v-if="segments(row.left.text, row.right?.text, row.kind).mark">{{
                segments(row.left.text, row.right?.text, row.kind).mark
              }}</mark
              >{{ segments(row.left.text, row.right?.text, row.kind).after }}</template
            ></code
          ><span class="compare-number">{{ row.right?.line ?? '' }}</span
          ><code
            class="compare-right"
            @contextmenu="capture && openFor($event, lineTarget('right', row))"
            ><template v-if="row.right"
              >{{ segments(row.right.text, row.left?.text, row.kind).before
              }}<mark v-if="segments(row.right.text, row.left?.text, row.kind).mark">{{
                segments(row.right.text, row.left?.text, row.kind).mark
              }}</mark
              >{{ segments(row.right.text, row.left?.text, row.kind).after }}</template
            ></code
          >
        </div>
      </template>
    </template>
    <div v-if="rows.length > MAX_ROWS" class="compare-fold">
      Showing the first {{ MAX_ROWS }} rows. Copy or download for the full diff.
    </div>
  </div>
  <details class="compare-headers" :open="changedHeaders.length > 0">
    <summary>
      Headers · {{ changedHeaders.length }} changed ·
      {{ store.limits.volatileHeaders.slice(0, 2).join(', ') }} and other per-response headers
      ignored
    </summary>
    <table v-if="changedHeaders.length" class="response-headers-table">
      <thead>
        <tr>
          <th scope="col">Header</th>
          <th scope="col">Baseline</th>
          <th scope="col">Current</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="header in changedHeaders"
          :key="header.name"
          :class="`is-${header.kind}`"
          :tabindex="capture ? 0 : undefined"
          :data-compare-header="header.name"
          @contextmenu="capture && openFor($event, headerTarget(header))"
          @keydown="capture && openFor($event, headerTarget(header))"
        >
          <th scope="row">{{ header.name }}</th>
          <td>{{ header.before ?? '—' }}</td>
          <td>{{ header.after ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="field-help">No header differences.</p>
  </details>
  <ContextMenu
    v-if="capture"
    ref="menu"
    label="Comparison actions"
    :items="items"
    data-compare-menu
    @select="select"
  />
</template>
