<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../select-options';
import { nextTick, reactive, ref, shallowRef, toRaw } from 'vue';
import { vChecked } from '../../directives/checked';
import { SENSITIVE_VARIABLE, useEnvironmentsStore } from '../../stores/environments';
import { useWorkspaceStore } from '../../stores/workspace';
import type { HttpResponse } from '@techieutils/api-workbench-common/types';
import { render } from '../../shell';
import { errorMessage, toast, uid } from '../../utils';
import { useRequestRowsStore } from '../../stores/request-rows';
import { useRequestBodyStore } from '../../stores/request-body';
import MdiIcon from '../MdiIcon.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import { closeSuggestions } from './cell-editing';
import KvCombobox from './KvCombobox.vue';
import CaptureSourceInput from './CaptureSourceInput.vue';
import { fieldSuggestions } from './suggestions';
import UiSelect from '../ui/UiSelect.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import { useContextMenu } from '../../composables/context-menu';
const rowsStore = useRequestRowsStore();
const body = useRequestBodyStore();

type RowType = 'params' | 'headers' | 'captures' | 'variables' | 'bodyFields';
type Field = 'key' | 'value' | 'description';

/**
 * Editable key/value rows with a trailing draft row: typing into the draft adds a row and a new
 * draft. Params and Headers add suggestions, drag and keyboard reordering, and (for HTTP headers)
 * the automatic headers the client adds. Environment variables mask secret-looking values, and
 * form-data body fields can hold files.
 */
const props = defineProps<{
  type: RowType;
  /** The rows as stored; read on every render because they are edited in place. */
  rows(): KeyValue[];
  /** The stored rows for an edit, creating the list if the request has none yet. */
  create?(): KeyValue[];
  /** Runs after any change, with the keys before it (Params keep the URL query in step). */
  changed?(previousKeys: string[]): void;
  automaticHeaders?: boolean;
  /** Body fields sent as multipart form data, where a value can be a file. */
  formData?: boolean;
  /** Headers outside the open request (a mock's response headers), so not the request's table. */
  detached?: boolean;
}>();
// A table is created per row type (callers key it by type), so these do not change.
const ordered = props.type === 'params' || props.type === 'headers';
/** The type, for cells that only exist on ordered (params and headers) rows. */
const orderedType = props.type as 'params' | 'headers';
const captures = props.type === 'captures';
/** The request's last response, which capture sources complete and preview from. */
const captureResponse = (): HttpResponse | undefined => {
  const response = workspace.current().response;
  return response && !('error' in response && response.error)
    ? (response as HttpResponse)
    : undefined;
};
const variables = props.type === 'variables';
const environments = useEnvironmentsStore();
const workspace = useWorkspaceStore();
const masked = (row: KeyValue) => variables && Boolean(row.key) && SENSITIVE_VARIABLE.test(row.key);
const revealed = (row: KeyValue) => environments.isRevealed(workspace.state.environment, row.key);
const writable = () => (props.create ?? props.rows)();
function commit(previousKeys: string[]): void {
  if (props.changed) props.changed(previousKeys);
  else workspace.persist();
}

// Stable row identities let a row keep its DOM (and focus) when it moves or is created from the
// draft, which hands its identity to the new row.
const ids = new WeakMap<KeyValue, string>();
const rowId = (row: KeyValue) => {
  if (!ids.has(row)) ids.set(row, uid());
  return ids.get(row)!;
};
const draft = reactive<KeyValue>({ key: '', value: '', description: '', enabled: true });
const draftId = ref(uid());
const allRows = () => [...props.rows(), draft];
const keyOf = (row: KeyValue) => (row === draft ? draftId.value : rowId(row));

function update(index: number, field: Field | 'enabled', value: string | boolean): void {
  const rows = writable();
  const previousKeys = rows.map((row) => row.key);
  if (index >= rows.length) {
    // The draft becomes a row only once text is typed; its checkbox state carries over.
    if (field === 'enabled' || !value) {
      (draft as unknown as Record<string, unknown>)[field] = value;
      return;
    }
    const row: KeyValue = { key: '', value: '', enabled: draft.enabled };
    row[field] = String(value);
    ids.set(row, draftId.value);
    rows.push(row);
    Object.assign(draft, { key: '', value: '', description: '', enabled: true });
    draftId.value = uid();
  } else if (field === 'enabled') rows[index].enabled = value === true;
  else rows[index][field] = String(value);
  commit(previousKeys);
}
const input = (event: Event) => (event.target as HTMLInputElement).value;

// Form-data fields: a value is text or a file, read into memory for this session only.
function setKind(index: number, kind: 'text' | 'file'): void {
  const rows = writable() as BodyField[];
  if (index >= rows.length) {
    const row: BodyField = { key: draft.key, value: draft.value, enabled: draft.enabled, kind };
    ids.set(row, draftId.value);
    rows.push(row);
    Object.assign(draft, { key: '', value: '', description: '', enabled: true });
    draftId.value = uid();
  } else rows[index].kind = kind;
  workspace.persist();
  render();
}
async function chooseFile(index: number, event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  const field = (props.rows() as BodyField[])[index];
  if (!file || !field) return;
  try {
    const data = await body.readUpload(file);
    field.fileId ||= uid();
    field.fileName = file.name;
    body.uploads.set(field.fileId, data);
    workspace.persist();
    render();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}
const bodyField = (row: KeyValue) => row as BodyField;
const checked = (event: Event) => (event.target as HTMLInputElement).checked;

function remove(index: number): void {
  const rows = writable();
  const previousKeys = rows.map((row) => row.key);
  rows.splice(index, 1);
  commit(previousKeys);
  void nextTick(() =>
    (
      document.querySelector<HTMLElement>(
        `[data-delete="${Math.min(index, rows.length - 1)}"][data-type="${props.type}"]`,
      ) ||
      document
        .querySelector<HTMLElement>(`[data-type="${props.type}"][data-field="key"]`)
        ?.parentElement?.querySelector<HTMLElement>('.kv-field-label') ||
      document.querySelector<HTMLElement>(`[data-type="${props.type}"][data-field="key"]`)
    )?.focus({ preventScroll: true }),
  );
}

// Reordering
const orderStatus = ref('');
function move(from: number, to: number): void {
  const rows = writable();
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return;
  const previousKeys = rows.map((row) => row.key);
  rows.splice(to, 0, rows.splice(from, 1)[0]);
  commit(previousKeys);
  orderStatus.value =
    `Moved ${props.type === 'headers' ? 'header' : props.type === 'params' ? 'parameter' : ''} row ${from + 1} to position ${to + 1} of ${rows.length}.`.replace(
      '  ',
      ' ',
    );
  void nextTick(() =>
    document
      .querySelector<HTMLElement>(`[data-row-order="${to}"][data-order-type="${props.type}"]`)
      ?.focus({ preventScroll: true }),
  );
}
function onHandleKeydown(event: KeyboardEvent, from: number): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const last = props.rows().length - 1;
  const to = (
    {
      ArrowUp: Math.max(0, from - 1),
      ArrowDown: Math.min(last, from + 1),
      Home: 0,
      End: last,
    } as Record<string, number>
  )[event.key];
  if (to === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  move(from, to);
}
// A row's context menu: right-click, Shift+F10, or the context menu key from any of its cells.
const {
  menu: contextMenu,
  target: menuFor,
  open: openRowMenu,
  onKeydown: onRowMenuKeydown,
} = useContextMenu<number>();
const separator = props.type === 'headers' ? ': ' : '=';
function rowMenuItems(): MenuItem[] {
  const rows = props.rows();
  const index = menuFor.value ?? -1;
  const row = rows[index];
  return [
    {
      id: 'toggle',
      label: row?.enabled === false ? 'Enable row' : 'Disable row',
      icon: row?.enabled === false ? 'check-circle-outline' : 'circle-outline',
    },
    { id: 'above', label: 'Insert row above', icon: 'arrow-up', separated: true },
    { id: 'below', label: 'Insert row below', icon: 'arrow-down' },
    { id: 'duplicate', label: 'Duplicate row', icon: 'content-copy' },
    { id: 'up', label: 'Move up', icon: 'chevron-up', separated: true, disabled: index <= 0 },
    {
      id: 'down',
      label: 'Move down',
      icon: 'chevron-down',
      disabled: index < 0 || index >= rows.length - 1,
    },
    { id: 'copy-key', label: 'Copy key', icon: 'content-copy', separated: true },
    { id: 'copy-value', label: 'Copy value', icon: 'content-copy' },
    {
      id: 'copy-row',
      label: props.type === 'headers' ? 'Copy as header' : 'Copy as key=value',
      icon: 'content-copy',
    },
    { id: 'delete', label: 'Delete row', icon: 'delete-outline', danger: true, separated: true },
  ];
}
async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, 'success');
  } catch {
    toast(`The ${what.toLowerCase()} could not be copied`, 'error');
  }
}
/**
 * Adds an empty row at `at` (or a copy of `source`) and focuses its key: the input, or for params
 * and headers the key's label, where Enter or F2 starts editing.
 */
function insertRow(at: number, source?: KeyValue): void {
  const rows = writable();
  const previousKeys = rows.map((row) => row.key);
  rows.splice(
    at,
    0,
    source ? structuredClone(toRaw(source)) : { key: '', value: '', enabled: true },
  );
  commit(previousKeys);
  render();
  void nextTick(() => {
    const key = document.querySelector<HTMLElement>(
      `[data-row="${at}"][data-type="${props.type}"][data-field="key"]`,
    );
    (ordered ? key?.parentElement?.querySelector<HTMLElement>('.kv-field-label') : key)?.focus();
  });
}
function onRowMenu(command: string): void {
  const index = menuFor.value;
  const row = index === undefined ? undefined : props.rows()[index];
  if (index === undefined || !row) return;
  if (command === 'toggle') update(index, 'enabled', row.enabled === false);
  else if (command === 'above') insertRow(index);
  else if (command === 'below') insertRow(index + 1);
  else if (command === 'duplicate') insertRow(index + 1, row);
  else if (command === 'up' || command === 'down') move(index, index + (command === 'up' ? -1 : 1));
  else if (command === 'copy-key') void copyText(row.key, 'Key');
  else if (command === 'copy-value') void copyText(row.value, 'Value');
  else if (command === 'copy-row') void copyText(`${row.key}${separator}${row.value}`, 'Row');
  else if (command === 'delete') remove(index);
}
const drag = shallowRef<{ rows: KeyValue[]; row: KeyValue } | undefined>();
const drop = ref<{ index: number; after: boolean } | undefined>();
function onDragStart(event: DragEvent, index: number): void {
  const rows = props.rows();
  if (!rows[index] || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  closeSuggestions();
  drag.value = { rows, row: rows[index] };
  event.dataTransfer.effectAllowed = 'move';
  // Never put header or parameter values on the OS drag clipboard.
  event.dataTransfer.setData('application/x-api-workbench-row', 'move');
  const tr = (event.target as HTMLElement).closest('tr')!;
  event.dataTransfer.setDragImage(tr, 12, tr.getBoundingClientRect().height / 2);
}
function endDrag(): void {
  drag.value = undefined;
  drop.value = undefined;
}
const accepts = () => drag.value !== undefined && props.rows() === drag.value.rows;
function insertion(event: DragEvent, index: number): number {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return index + (event.clientY >= box.top + box.height / 2 ? 1 : 0);
}
function onDragOver(event: DragEvent, index: number): void {
  if (!accepts()) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  drop.value = { index, after: insertion(event, index) !== index };
}
function onDragLeave(event: DragEvent, index: number): void {
  const row = event.currentTarget as HTMLElement;
  if (!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget))
    if (drop.value?.index === index) drop.value = undefined;
}
function onDrop(event: DragEvent, index: number): void {
  if (!accepts()) return;
  event.preventDefault();
  event.stopPropagation();
  const { rows, row } = drag.value!;
  const from = rows.indexOf(row);
  const slot = insertion(event, index);
  endDrag();
  move(from, Math.min(rows.length - 1, slot - (from < slot ? 1 : 0)));
}

// Automatic headers, listed first and editable as overrides where the client allows it.
const editingAutomatic = ref<string>();
const automaticRows = () => rowsStore.automaticHeaderRows(workspace.current());
const overridable = (key: string) =>
  Object.hasOwn(rowsStore.automaticRequestHeaders(), key) ||
  (key === 'Content-Type' && body.bodyType(workspace.current()) === 'raw');
function editAutomatic(key: string): void {
  if (overridable(key)) editingAutomatic.value = key;
}
function finishAutomatic(key: string, value: string, original: string, save: boolean): void {
  if (editingAutomatic.value !== key) return;
  editingAutomatic.value = undefined;
  if (save && value !== original) {
    const headers = workspace.current().headers;
    const existing = headers.find(
      (row) => workspace.resolve(row.key).trim().toLowerCase() === key.toLowerCase(),
    );
    if (existing) {
      existing.value = value;
      existing.enabled = true;
    } else headers.push({ key, value, enabled: true, description: 'Custom override' });
    workspace.persist();
  }
  render();
  void nextTick(() => {
    const target = Array.from(
      document.querySelectorAll<HTMLInputElement>('[data-type=headers][data-field=key]'),
    ).find((field) => field.value.toLowerCase() === key.toLowerCase());
    if (target)
      target.closest('tr')?.querySelector<HTMLInputElement>('[data-field=value]')?.focus();
    else document.querySelector<HTMLElement>(`[data-auto-header-value="${key}"]`)?.focus();
  });
}
function onAutomaticKeydown(event: KeyboardEvent, key: string, original: string): void {
  if (event.key !== 'Enter' && event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  finishAutomatic(key, (event.target as HTMLInputElement).value, original, event.key === 'Enter');
}
/** Focuses and selects an automatic header's override field when it appears. */
const vFocusSelect = {
  mounted: (element: HTMLInputElement) => {
    element.focus();
    element.select();
  },
};
</script>

<template>
  <span v-if="ordered" id="row-order-status" class="sr-only" role="status" aria-live="polite">{{
    orderStatus
  }}</span>
  <div class="table-scroll">
    <table class="kv-table">
      <thead>
        <tr>
          <th v-if="ordered" class="ordercell"><span class="sr-only">Row order</span></th>
          <th class="checkcell"><span class="sr-only">Enabled</span></th>
          <th>{{ captures ? 'VARIABLE' : 'KEY' }}</th>
          <th>{{ captures ? 'SOURCE' : 'VALUE' }}</th>
          <th v-if="!variables">DESCRIPTION</th>
          <th class="deletecell"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody :id="type === 'headers' && !detached ? 'request-header-rows' : undefined">
        <template v-if="automaticHeaders">
          <tr v-for="row in automaticRows()" :key="`auto-${row.key}`" class="automatic-header-row">
            <td class="ordercell" aria-hidden="true"></td>
            <td class="checkcell">
              <span title="Automatic header"><MdiIcon name="cog-outline" /></span>
            </td>
            <td :title="row.key">
              <code>{{ row.key }}</code>
            </td>
            <td
              v-if="overridable(row.key)"
              :data-auto-header-value="row.key"
              tabindex="0"
              role="button"
              :aria-label="`Edit ${row.key} value`"
              title="Double-click or press Enter to override"
              @dblclick="editAutomatic(row.key)"
              @keydown.self.enter.prevent="editAutomatic(row.key)"
              @keydown.self.space.prevent="editAutomatic(row.key)"
            >
              <input
                v-if="editingAutomatic === row.key"
                v-focus-select
                class="automatic-header-value-input"
                :value="row.value"
                :aria-label="`Override ${row.key}`"
                autocomplete="off"
                spellcheck="false"
                @blur="finishAutomatic(row.key, input($event), row.value, true)"
                @keydown="onAutomaticKeydown($event, row.key, row.value)"
              /><code v-else>{{ row.value }}</code>
            </td>
            <td v-else title="Calculated by the HTTP client">
              <code>{{ row.value }}</code>
            </td>
            <td :title="row.description">{{ row.description }}</td>
            <td class="deletecell"><span class="sr-only">Managed automatically</span></td>
          </tr>
        </template>
        <tr
          v-for="(row, index) in allRows()"
          :key="keyOf(row)"
          :class="{
            'row-dragging': drag?.row === row,
            'row-drop-before': drop?.index === index && !drop.after,
            'row-drop-after': drop?.index === index && drop.after,
          }"
          :data-order-index="ordered ? index : undefined"
          :data-order-type="ordered ? type : undefined"
          @dragover="ordered && onDragOver($event, index)"
          @dragleave="ordered && onDragLeave($event, index)"
          @drop="ordered && onDrop($event, index)"
          @contextmenu="row !== draft && openRowMenu($event, index)"
          @keydown="row !== draft && onRowMenuKeydown($event, index)"
        >
          <td v-if="ordered" class="ordercell">
            <UiIconButton
              v-if="row !== draft"
              :label="`Reorder ${type === 'headers' ? 'header' : 'parameter'} row ${index + 1}: drag or use Arrow Up / Down; Home / End moves to first / last`"
              icon="drag-vertical"
              class="row-order-handle"
              draggable="true"
              :data-row-order="index"
              :data-order-type="type"
              @keydown="onHandleKeydown($event, index)"
              @dragstart="onDragStart($event, index)"
              @dragend="endDrag"
            />
          </td>
          <td class="checkcell">
            <input
              v-checked="row.enabled"
              type="checkbox"
              :data-row="index"
              :data-type="type"
              data-field="enabled"
              :aria-label="`Enable row ${index + 1}`"
              @change="update(index, 'enabled', checked($event))"
            />
          </td>
          <td v-for="field in ['key', 'value'] as const" :key="field">
            <KvCombobox
              v-if="ordered"
              :id="`${keyOf(row)}:${field}`"
              :type="orderedType"
              :field="field"
              :index="index"
              :value="row[field]"
              :suggest="
                () =>
                  fieldSuggestions(
                    detached ? 'response-headers' : orderedType,
                    field,
                    props.rows(),
                    props.rows()[index],
                  )
              "
              :value-placeholder="detached ? 'Value or {{template}}' : undefined"
              @update="update(index, field, $event)"
            />
            <div v-else-if="field === 'value' && formData" class="body-field-value">
              <UiSelect
                :data-body-kind="index"
                :aria-label="`Row ${index + 1} value type`"
                :value="bodyField(row).kind === 'file' ? 'file' : 'text'"
                @change="setKind(index, input($event) as 'text' | 'file')"
                :options="
                  withIcons(
                    [
                      ['text', 'Text'],
                      ['file', 'File'],
                    ],
                    OPTION_ICONS.rowType,
                  )
                "
              />
              <label
                v-if="bodyField(row).kind === 'file'"
                class="file-value"
                :title="bodyField(row).fileName || 'Choose file'"
                ><span>{{ bodyField(row).fileName || 'Choose file' }}</span
                ><input
                  type="file"
                  :data-body-file="index"
                  :aria-label="`Choose file for row ${index + 1}`"
                  @change="chooseFile(index, $event)"
              /></label>
              <input
                v-else
                placeholder="Value or {{variable}}"
                :aria-label="`Row ${index + 1} value`"
                :value="row.value"
                :data-row="index"
                :data-type="type"
                data-field="value"
                spellcheck="false"
                @input="update(index, 'value', input($event))"
              />
            </div>
            <div v-else-if="field === 'value' && masked(row)" class="masked-value">
              <input
                :type="revealed(row) ? 'text' : 'password'"
                placeholder="Value or {{variable}}"
                :aria-label="`Row ${index + 1} value`"
                :value="row.value"
                :data-row="index"
                :data-type="type"
                data-field="value"
                spellcheck="false"
                autocomplete="off"
                @input="update(index, 'value', input($event))"
              /><UiIconButton
                :label="`${revealed(row) ? 'Hide' : 'Reveal'} ${row.key}`"
                :icon="revealed(row) ? 'eye-off-outline' : 'eye-outline'"
                :data-reveal-variable="row.key"
                :aria-pressed="revealed(row)"
                @click="environments.toggleReveal(workspace.state.environment, row.key)"
              />
            </div>
            <CaptureSourceInput
              v-else-if="captures && field === 'value'"
              :id="`capture-${keyOf(row)}`"
              :index="index"
              :value="row.value"
              :name="row.key"
              :response="captureResponse"
              @update="update(index, 'value', $event)"
            />
            <input
              v-else
              :placeholder="
                captures
                  ? field === 'key'
                    ? 'variable_name'
                    : '$.data.token or header x-request-id'
                  : field === 'key'
                    ? 'Key'
                    : 'Value or {{variable}}'
              "
              :aria-label="`Row ${index + 1} ${captures ? (field === 'key' ? 'variable' : 'source') : field}`"
              :value="row[field]"
              :data-row="index"
              :data-type="type"
              :data-field="field"
              spellcheck="false"
              @input="update(index, field, input($event))"
            />
          </td>
          <td v-if="!variables">
            <input
              placeholder="Description"
              :aria-label="`Row ${index + 1} description`"
              :value="row.description || ''"
              :data-row="index"
              :data-type="type"
              data-field="description"
              @input="update(index, 'description', input($event))"
            />
          </td>
          <td class="deletecell">
            <UiIconButton
              v-if="row !== draft"
              label="Remove row"
              icon="close"
              :data-delete="index"
              :data-type="type"
              @click="remove(index)"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <ContextMenu
    ref="contextMenu"
    label="Row actions"
    :items="rowMenuItems()"
    :data-row-menu="type"
    @select="onRowMenu"
  />
</template>
