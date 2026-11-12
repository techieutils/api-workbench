<script setup lang="ts">
import { nextTick } from 'vue';
import { render } from '../../shell';
import { errorMessage, toast } from '../../utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { useRequestsStore } from '../../stores/requests';
import { useRequestRowsStore } from '../../stores/request-rows';
import MdiIcon from '../MdiIcon.vue';
import KeyValueTable from '../table/KeyValueTable.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import UiButton from '../ui/UiButton.vue';

/** Query parameters or headers, edited in the table or as `Key: Value` text. */
const props = defineProps<{ type: 'params' | 'headers' }>();
const store = useRequestRowsStore();
const workspace = useWorkspaceStore();
const requests = useRequestsStore();
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
const bulk = () =>
  store.bulk?.requestId === request().id && store.bulk.type === props.type ? store.bulk : undefined;
/** Params mirror the URL query, so every change rewrites it. */
function changed(previousKeys: string[]): void {
  if (props.type === 'params') requests.syncRequestQuery(request(), previousKeys);
  workspace.persist();
}

function openBulk(): void {
  try {
    store.bulk = {
      requestId: request().id,
      type: props.type,
      text: store.serializeBulkRows(request()[props.type]),
      error: '',
    };
    void nextTick(() => document.querySelector<HTMLTextAreaElement>('#bulk-rows')?.focus());
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}
function applyBulk(): void {
  const draft = bulk();
  if (!draft) return;
  try {
    const previousKeys = request()[props.type].map((row) => row.key);
    request()[props.type] = store.parseBulkRows(draft.text, request()[props.type]);
    store.bulk = undefined;
    changed(previousKeys);
    render();
  } catch (error) {
    draft.error = errorMessage(error);
  }
}
function addRow(): void {
  request()[props.type].push({ enabled: true, key: '', value: '' });
  changed(request()[props.type].map((row) => row.key));
  render();
}
</script>

<template>
  <div class="table-label">
    <div>
      <strong>{{ type === 'params' ? 'Query parameters' : 'Request headers' }}</strong
      ><span>{{
        bulk()
          ? 'One Key: Value per line · // disables a row'
          : 'Drag handles to reorder · New rows appear as you type'
      }}</span>
    </div>
    <!-- The actions stay on one line; in a narrow pane they scroll with arrows. -->
    <ScrollRow class="table-actions" frame-class="table-actions-frame" noun="actions">
      <template v-if="bulk()">
        <UiButton
          label="Cancel"
          variant="ghost"
          data-action="bulk-cancel"
          @click="store.bulk = undefined"
        /><UiButton label="Apply" variant="primary" data-action="bulk-apply" @click="applyBulk" />
      </template>
      <template v-else>
        <button
          v-if="type === 'headers'"
          type="button"
          class="automatic-headers-toggle"
          data-action="toggle-automatic-headers"
          :aria-expanded="store.automaticHeaders.expanded"
          aria-controls="request-header-rows"
          @click="store.automaticHeaders.expanded = !store.automaticHeaders.expanded"
        >
          <MdiIcon
            :name="store.automaticHeaders.expanded ? 'eye-off-outline' : 'eye-outline'"
          /><span
            >{{ store.automaticHeaders.expanded ? 'Hide' : 'Show' }}
            {{ store.automaticHeaderRows(request()).length }} automatic headers</span
          ></button
        ><UiButton
          label="Bulk edit"
          icon="code-tags"
          variant="ghost"
          data-action="bulk-open"
          @click="openBulk"
        /><UiButton
          label="Add row"
          icon="plus"
          variant="ghost"
          data-action="add-row"
          @click="addRow"
        />
      </template>
    </ScrollRow>
  </div>
  <template v-if="bulk()">
    <textarea
      id="bulk-rows"
      class="config-text bulk-editor"
      :aria-label="`Bulk edit ${type}`"
      aria-describedby="bulk-help"
      spellcheck="false"
      :value="bulk()!.text"
      @input="bulk()!.text = ($event.target as HTMLTextAreaElement).value"
    ></textarea>
    <p
      id="bulk-help"
      :class="bulk()!.error ? 'form-error' : 'field-help'"
      :role="bulk()!.error ? 'alert' : 'note'"
    >
      {{
        bulk()!.error ||
        'Values may contain colons. Descriptions are retained for matching keys. Apply to save your changes.'
      }}
    </p>
  </template>
  <!-- Keyed by type, so Params and Headers never share draft rows or editing state. -->
  <KeyValueTable
    v-else
    :key="type"
    :type="type"
    :rows="() => request()[type]"
    :changed="changed"
    :automatic-headers="type === 'headers' && store.automaticHeaders.expanded"
  />
</template>
