<script setup lang="ts">
import { computed } from 'vue';
import type { AssertionResult } from '@techieutils/api-workbench-common/assertions';
import {
  captureSourceForAssertion,
  captureVariableName,
} from '@techieutils/api-workbench-common/capture-suggestions';
import { useContextMenu } from '../../composables/context-menu';
import { useRequestTestsStore } from '../../stores/request-tests';
import { useWorkspaceStore } from '../../stores/workspace';
import { toast } from '../../utils';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import MdiIcon from '../MdiIcon.vue';

/**
 * Test results, one row per assertion. With `capture`, a row's menu captures the value its
 * assertion checks (`$.id` for `json $.id equals 7`) into a request: the current one, or
 * `requestId`'s, which then opens (History).
 */
const props = defineProps<{
  results: AssertionResult[];
  capture?: boolean;
  requestId?: string;
  /** Why capturing is unavailable, shown with the disabled item (a deleted request). */
  captureUnavailable?: string;
}>();
const workspace = useWorkspaceStore();
const tests = useRequestTestsStore();

const { menu, target, open, onKeydown } = useContextMenu<AssertionResult>();
const offer = computed(() =>
  target.value ? captureSourceForAssertion(target.value.label) : undefined,
);
const items = computed<MenuItem[]>(() => [
  { id: 'copy', label: 'Copy assertion', icon: 'content-copy' },
  ...(props.capture
    ? [
        {
          id: 'capture',
          label: props.captureUnavailable
            ? `Capture into a variable · ${props.captureUnavailable}`
            : offer.value
              ? `Capture ${offer.value.source}`
              : 'Capture into a variable · this check has no single value',
          icon: 'variable',
          separated: true,
          disabled: Boolean(props.captureUnavailable) || !offer.value,
        } satisfies MenuItem,
      ]
    : []),
]);
async function select(command: string): Promise<void> {
  const result = target.value;
  if (!result) return;
  const capture = offer.value;
  if (command === 'capture' && capture) {
    const request = props.requestId
      ? workspace.state.requests.find((item) => item.id === props.requestId)
      : workspace.current();
    const taken = (request?.captures ?? []).map((row) => row.key.trim());
    const variable = capture.path
      ? captureVariableName(capture.path, taken)
      : captureVariableName(undefined, taken, capture.name);
    tests.addCapture(variable, capture.source, capture.path ?? capture.source, props.requestId);
    return;
  }
  try {
    await navigator.clipboard.writeText(result.label);
    toast('Assertion copied', 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
</script>

<template>
  <div
    v-for="(test, index) in results"
    :key="index"
    :class="['assertion-result', test.pass ? 'passed' : 'failed']"
    :tabindex="capture ? 0 : undefined"
    :data-test-result="index"
    @contextmenu="capture && open($event, test)"
    @keydown="capture && onKeydown($event, test)"
  >
    <MdiIcon :name="test.pass ? 'check-circle-outline' : 'close-circle-outline'" /><strong>{{
      test.pass ? 'PASS' : 'FAIL'
    }}</strong>
    <div class="assertion-result-detail">
      <span>{{ test.name || test.label }}</span
      ><small
        >{{ test.line ? `Line ${test.line} · ` : '' }}{{ test.name ? `${test.label} · ` : ''
        }}{{ test.message }}</small
      >
    </div>
  </div>
  <ContextMenu
    v-if="capture"
    ref="menu"
    label="Test result actions"
    :items="items"
    data-test-result-menu
    @select="select"
  />
</template>
