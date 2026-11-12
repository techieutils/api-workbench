<script setup lang="ts">
import { withIcons } from '../../select-options';
import { useRendered } from '../../composables/rendered';
import { toast } from '../../utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { useResponseStore } from '../../stores/response';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiSelect from '../ui/UiSelect.vue';
import ResponseDiff from './ResponseDiff.vue';

/** The current response against an earlier one: summary deltas, a body diff, and headers. */
const store = useResponseStore();
const workspace = useWorkspaceStore();
const request = () => workspace.current();
// Snapshots are recorded on send, which render() reports; options are reactive in the store.
const data = useRendered(() => {
  void store.compare.sortKeys;
  void store.compare.baseline.size;
  void store.compare.pinned.size;
  return store.compareData(request());
});
const pinned = () => store.compare.pinned.get(request().id);
const label = (snapshot: ResponseSnapshot, current: boolean) =>
  store.snapshotLabel(snapshot, current);

function setBaseline(event: Event): void {
  store.compare.baseline.set(request().id, (event.target as HTMLSelectElement).value);
}
function togglePin(): void {
  const snapshot = store.comparePair(request()).current;
  if (!snapshot) return;
  if (store.compare.pinned.get(request().id) === snapshot.id)
    store.compare.pinned.delete(request().id);
  else {
    store.compare.pinned.set(request().id, snapshot.id);
    store.compare.baseline.delete(request().id);
    toast('Pinned · later responses compare against this one', 'success');
  }
}
</script>

<template>
  <UiEmptyState
    v-if="!data.current || !data.baseline || !data.body"
    class="response-empty"
    icon="view-split-vertical"
    title="Nothing to compare yet"
    :description="`Send this request again to compare responses side by side. The last ${store.limits.snapshots} successful responses are kept for this session.`"
  />
  <div v-else class="compare-view">
    <div class="compare-toolbar">
      <label class="compare-baseline"
        ><span>Compare with</span
        ><UiSelect
          id="compare-baseline"
          class="field-input"
          :value="data.baseline.id"
          @change="setBaseline"
          :options="
            withIcons(
              data.options.map((snapshot) => ({
                value: snapshot.id,
                label: `${label(snapshot, false)}${snapshot.id === pinned() ? ' · pinned' : ''}`,
              })),
              (option) => (option.label.endsWith(' · pinned') ? 'pin-outline' : 'history'),
            )
          "
      /></label>
      <label class="auth-check"
        ><input id="compare-sort-keys" v-model="store.compare.sortKeys" type="checkbox" /><span
          >Sort JSON keys</span
        ></label
      >
      <label class="auth-check"
        ><input
          id="compare-changes-only"
          v-model="store.compare.changesOnly"
          type="checkbox"
        /><span>Changes only</span></label
      >
      <UiButton
        :label="pinned() === data.current.id ? 'Unpin baseline' : 'Pin current as baseline'"
        icon="key-variant"
        variant="ghost"
        data-compare-pin
        @click="togglePin"
      />
    </div>
    <ResponseDiff
      :baseline="data.baseline.response"
      :current="data.current.response"
      :baseline-label="label(data.baseline, false)"
      :current-label="label(data.current, true)"
      :sort-keys="store.compare.sortKeys"
      :changes-only="store.compare.changesOnly"
      capture
    />
  </div>
</template>
