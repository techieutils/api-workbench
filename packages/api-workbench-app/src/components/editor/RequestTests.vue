<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../select-options';
import { computed, nextTick, toRaw, watchEffect } from 'vue';
import { render } from '../../shell';
import { errorMessage } from '../../utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { useRequestTestsStore } from '../../stores/request-tests';
import { useResponseStore } from '../../stores/response';
import MdiIcon from '../MdiIcon.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import GuideButton from '../ui/GuideButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import { examples as assertionExamples } from '@techieutils/api-workbench-common/assertions';
import * as testCases from '@techieutils/api-workbench-common/test-cases';
import UiSelect from '../ui/UiSelect.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import { useContextMenu } from '../../composables/context-menu';
import { toast } from '../../utils';

/** Response tests: a visual case designer, or the assertion source as text. */
const store = useRequestTestsStore();
const response = useResponseStore();
const workspace = useWorkspaceStore();
const builder = testCases;
const designer = store.designer;
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();

function resetDesigner(): void {
  designer.editing = null;
  designer.source = request().tests;
  designer.name = '';
  designer.enabled = true;
  designer.rule = builder.defaultRule();
  designer.error = '';
}
// A different request, or an outside change to the case being edited, starts a fresh case.
watchEffect(() => {
  const current = request();
  if (designer.requestId !== current.id) {
    designer.requestId = current.id;
    resetDesigner();
  } else if (designer.editing !== null && designer.source !== current.tests) resetDesigner();
});

function saveTests(source: string): void {
  request().tests = source;
  workspace.persist();
  designer.source = source;
  // The response viewer's Tests tab reflects the new assertions.
  render();
}
function append(text: string): void {
  const tests = request().tests;
  saveTests(tests + (tests && !tests.endsWith('\n') ? '\n' : '') + text);
  resetDesigner();
}
const basicSuite =
  'status between 200 299\nresponse-time < 3000\nheader-exists content-type\nbody-not-empty';
function setText(event: Event): void {
  request().tests = (event.target as HTMLTextAreaElement).value;
  workspace.persist();
}

// Visual designer
const operatorLabels: Record<string, string> = {
  equals: 'Equals',
  'not-equals': 'Does not equal',
  contains: 'Contains',
  'not-contains': 'Does not contain',
  exists: 'Exists',
  'not-exists': 'Does not exist',
  empty: 'Is empty',
  'not-empty': 'Is not empty',
  'starts-with': 'Starts with',
  'not-starts-with': 'Does not start with',
  'ends-with': 'Ends with',
  'not-ends-with': 'Does not end with',
  'contains-all': 'Contains all of',
  'contains-any': 'Contains any of',
  'is-uuid': 'Is a UUID',
  'is-email': 'Is an email address',
  'is-url': 'Is a URL',
  'is-date': 'Is a date',
  'is-number': 'Is a number',
  'is-integer': 'Is an integer',
  'is-empty': 'Is empty',
  'is-not-empty': 'Is not empty',
  'is-unique': 'Has no repeated items',
  'is-sorted': 'Is sorted, ascending',
  'is-sorted-desc': 'Is sorted, descending',
  'equals-ignore-case': 'Equals, any case',
  'contains-ignore-case': 'Contains, any case',
  matches: 'Matches pattern',
  'not-matches': 'Does not match pattern',
  between: 'Between',
  in: 'Is one of',
  'not-in': 'Is none of',
  '<': 'Less than',
  '<=': 'At most',
  '>': 'Greater than',
  '>=': 'At least',
};
const rule = computed(() => designer.rule!);
const operators = computed(() => builder.operators(rule.value.kind));
const needsTarget = computed(() =>
  ['header', 'cookie', 'json-field', 'json', 'json-type', 'json-length', 'json-schema'].includes(
    rule.value.kind,
  ),
);
/** What the target field names: a header, a cookie, or a JSON path. */
const targetLabel = computed(() =>
  rule.value.kind === 'header'
    ? 'Header name'
    : rule.value.kind === 'cookie'
      ? 'Cookie name'
      : rule.value.kind === 'json-schema'
        ? 'JSON path ($ for the whole body)'
        : 'JSON path',
);
const listed = computed(() =>
  ['in', 'not-in', 'contains-all', 'contains-any'].includes(rule.value.operator),
);
const pattern = computed(() => ['matches', 'not-matches'].includes(rule.value.operator));
const noValue = computed(
  () =>
    rule.value.kind === 'json-valid' ||
    rule.value.kind === 'json-field' ||
    ['exists', 'not-exists', 'empty', 'not-empty'].includes(rule.value.operator) ||
    builder.VALUELESS_OPERATORS.includes(rule.value.operator),
);
const typed = computed(
  () => rule.value.kind === 'json' && ['equals', 'not-equals'].includes(rule.value.operator),
);
const numeric = computed(
  () =>
    [
      'status',
      'response-time',
      'response-size',
      'json-length',
      'body-length',
      'timing',
      'certificate-days-left',
    ].includes(rule.value.kind) ||
    (rule.value.kind === 'json' && builder.NUMERIC_OPERATORS.includes(rule.value.operator)) ||
    (typed.value && rule.value.valueType === 'number'),
);
/** How the expected value is entered for the current check. */
const expected = computed(() => {
  if (noValue.value) return 'none';
  if (rule.value.kind === 'json-type') return 'json-type';
  if (typed.value && rule.value.valueType === 'null') return 'null';
  if (typed.value && rule.value.valueType === 'boolean') return 'boolean';
  if (
    rule.value.kind === 'custom' ||
    rule.value.kind === 'json-schema' ||
    (typed.value && ['object', 'array'].includes(rule.value.valueType))
  )
    return 'multiline';
  return 'text';
});
const expectedLabel = computed(() => {
  if (rule.value.operator === 'between') return 'Minimum';
  if (listed.value)
    return rule.value.kind === 'status'
      ? 'Status codes (comma separated)'
      : 'Values (comma separated)';
  if (pattern.value) return 'Regular expression';
  return 'Expected value';
});
const expectedPlaceholder = computed(() => {
  if (pattern.value) return '^ok$ or /^ok$/i';
  if (listed.value) return rule.value.kind === 'status' ? '401, 403' : '"active", "pending"';
  return rule.value.kind === 'body' ? 'Text to check' : '';
});
const preview = computed(() => {
  try {
    // A copy reads every field, so the preview follows each edit, not only a new kind of check.
    return builder.buildAssertion({ ...rule.value });
  } catch {
    // Incomplete fields are allowed while typing; saving reports them.
    return '';
  }
});
type RuleField = 'target' | 'operator' | 'valueType' | 'value' | 'secondValue';
function setField(field: RuleField, value: string): void {
  (designer.rule as unknown as Record<string, string>)[field] = value;
  designer.error = '';
}
function onInput(field: RuleField | 'name', event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  if (field === 'name') {
    designer.name = value;
    designer.error = '';
  } else setField(field, value);
}
function onSelect(field: RuleField | 'kind', event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (field === 'kind') {
    designer.rule = builder.defaultRule(value as TestRule['kind']);
    return;
  }
  setField(field, value);
  if (field === 'operator' && rule.value.kind === 'json')
    rule.value.valueType = builder.NUMERIC_OPERATORS.includes(value) ? 'number' : 'string';
  if (field === 'valueType')
    rule.value.value =
      { object: '{}', array: '[]', boolean: 'true', null: 'null', number: '0' }[value] ?? '';
}
function saveCase(): void {
  try {
    saveTests(
      builder.writeCase(
        request().tests,
        designer.editing,
        designer.name,
        toRaw(rule.value),
        designer.enabled,
      ),
    );
    resetDesigner();
  } catch (error) {
    designer.error = errorMessage(error);
  }
}

// Designed cases
const cases = computed(() => builder.parseCases(request().tests));
const results = computed(() => {
  const response = request().response;
  return response && response.error === undefined ? store.runTests(request(), response) : [];
});
function caseLabel(entry: (typeof cases.value)[number]): string {
  return (
    entry.name ||
    builder.ruleKinds.find((kind) => kind.id === entry.rule.kind)?.label ||
    'Test case'
  );
}
function caseStatus(index: number): { label: string; tone: UITone } {
  const entry = cases.value[index];
  const result = results.value.find((item) => item.line === entry.line + 1);
  if (!entry.enabled) return { label: 'Disabled', tone: 'neutral' };
  if (!result) return { label: 'Ready', tone: 'neutral' };
  return result.pass ? { label: 'Passed', tone: 'success' } : { label: 'Failed', tone: 'danger' };
}
const caseResult = (index: number) =>
  results.value.find((item) => item.line === cases.value[index].line + 1);
function modify(transform: (source: string) => string): void {
  saveTests(transform(request().tests));
  resetDesigner();
}
// A test case's context menu, with the card's own actions and copying its assertion.
const {
  menu: caseMenu,
  target: caseFor,
  open: openCaseMenu,
  onKeydown: onCaseKeydown,
} = useContextMenu<number>();
const caseMenuItems = computed<MenuItem[]>(() => {
  const index = caseFor.value ?? -1;
  const entry = cases.value[index];
  return [
    {
      id: 'toggle',
      label: entry?.enabled === false ? 'Enable test' : 'Disable test',
      icon: entry?.enabled === false ? 'check-circle-outline' : 'circle-outline',
    },
    { id: 'edit', label: 'Edit test case', icon: 'pencil-outline' },
    { id: 'duplicate', label: 'Duplicate test case', icon: 'content-copy' },
    { id: 'up', label: 'Move up', icon: 'chevron-up', separated: true, disabled: index <= 0 },
    {
      id: 'down',
      label: 'Move down',
      icon: 'chevron-down',
      disabled: index < 0 || index >= cases.value.length - 1,
    },
    { id: 'copy', label: 'Copy assertion', icon: 'content-copy', separated: true },
    {
      id: 'delete',
      label: 'Delete test case',
      icon: 'delete-outline',
      danger: true,
      separated: true,
    },
  ];
});
async function onCaseMenu(command: string): Promise<void> {
  const index = caseFor.value;
  const entry = index === undefined ? undefined : cases.value[index];
  if (index === undefined || !entry) return;
  if (command === 'toggle') modify((source) => builder.toggleCase(source, index, !entry.enabled));
  else if (command === 'edit') editCase(index);
  else if (command === 'duplicate') modify((source) => builder.duplicateCase(source, index));
  else if (command === 'up' || command === 'down')
    modify((source) => builder.moveCase(source, index, command === 'up' ? -1 : 1));
  else if (command === 'delete') modify((source) => builder.removeCase(source, index));
  else if (command === 'copy')
    try {
      await navigator.clipboard.writeText(entry.assertion);
      toast('Assertion copied', 'success');
    } catch {
      toast('The assertion could not be copied', 'error');
    }
}
function editCase(index: number): void {
  const entry = builder.parseCases(request().tests)[index];
  designer.editing = index;
  designer.name = entry.name;
  designer.enabled = entry.enabled;
  designer.rule = { ...entry.rule };
  designer.source = request().tests;
  designer.error = '';
  void nextTick(() => {
    document
      .querySelector<HTMLInputElement>('[data-case-field=name]')
      ?.focus({ preventScroll: true });
    document.querySelector('#test-case-form')?.scrollIntoView({ block: 'nearest' });
  });
}

// Text mode examples
const examples = computed(() =>
  assertionExamples
    .map((example, index) => ({ ...example, index }))
    .filter((example) => store.example.group === 'All' || example.group === store.example.group),
);
const groups = computed(() => [
  'All',
  ...new Set(assertionExamples.map((example) => example.group)),
]);
// Keeps the selected example within the chosen category.
const selectedExample = computed(() => {
  const selected = examples.value.some((example) => example.index === store.example.selected)
    ? store.example.selected
    : examples.value[0]?.index || 0;
  return assertionExamples[selected] ? selected : 0;
});
function setGroup(event: Event): void {
  store.example.group = (event.target as HTMLSelectElement).value;
  store.example.selected = selectedExample.value;
}
</script>

<template>
  <section class="request-tests">
    <div class="table-label">
      <div>
        <strong>Response tests</strong><span>Design checks for your API response</span
        ><GuideButton guide="tests" topic="tests" />
      </div>
      <UiButton
        label="Run tests"
        icon="play-outline"
        data-run-request-tests
        :disabled="!request().response || request().response!.error !== undefined"
        @click="response.showTests()"
      />
    </div>
    <div class="test-design-modes" role="group" aria-label="Test editor mode">
      <button
        v-for="mode in ['Builder', 'Text'] as const"
        :key="mode"
        type="button"
        :data-test-mode="mode"
        :aria-pressed="store.mode === mode"
        @click="store.mode = mode"
      >
        <MdiIcon :name="mode === 'Builder' ? 'tune-variant' : 'code-tags'" />{{
          mode === 'Builder' ? 'Visual builder' : 'Text'
        }}
      </button>
    </div>

    <template v-if="store.mode === 'Builder' && designer.rule">
      <form id="test-case-form" class="test-designer" @submit.prevent="saveCase">
        <div class="test-designer-heading">
          <h3>{{ designer.editing === null ? 'Design a test case' : 'Edit test case' }}</h3>
          <label class="test-case-enabled"
            ><input
              id="test-case-enabled"
              v-model="designer.enabled"
              type="checkbox"
            />Enabled</label
          >
        </div>
        <div class="test-designer-fields">
          <label class="form-field"
            ><span>Test case name</span
            ><input
              class="field-input"
              data-case-field="name"
              type="text"
              :value="designer.name"
              placeholder="e.g. API returns an active user"
              aria-label="Test case name"
              @input="onInput('name', $event)"
          /></label>
          <label class="form-field"
            ><span>Check</span
            ><UiSelect
              class="field-input"
              data-case-field="kind"
              aria-label="Check"
              :value="rule.kind"
              @change="onSelect('kind', $event)"
              :options="
                withIcons(
                  builder.ruleKinds.map((kind) => [kind.id, kind.label] as [string, string]),
                  OPTION_ICONS.ruleKind,
                )
              "
          /></label>
          <label v-if="needsTarget" class="form-field"
            ><span>{{ targetLabel }}</span
            ><input
              class="field-input"
              data-case-field="target"
              type="text"
              :value="rule.target"
              :placeholder="
                rule.kind === 'header'
                  ? 'content-type'
                  : rule.kind === 'cookie'
                    ? 'session'
                    : '$.data.id'
              "
              :aria-label="targetLabel"
              @input="onInput('target', $event)"
          /></label>
          <label v-if="rule.kind === 'timing'" class="form-field"
            ><span>Timing</span
            ><UiSelect
              class="field-input"
              data-case-field="target"
              aria-label="Timing"
              :value="rule.target"
              @change="onSelect('target', $event)"
              :options="withIcons([...builder.TIMING_TARGETS], 'timer-outline')"
          /></label>
          <label v-if="operators.length" class="form-field"
            ><span>Comparison</span
            ><UiSelect
              class="field-input"
              data-case-field="operator"
              aria-label="Comparison"
              :value="rule.operator"
              @change="onSelect('operator', $event)"
              :options="
                withIcons(
                  operators.map(
                    (operator) =>
                      [operator, operatorLabels[operator] || operator] as [string, string],
                  ),
                  OPTION_ICONS.operator,
                  'equal',
                )
              "
          /></label>
          <label v-if="typed" class="form-field"
            ><span>Expected value type</span
            ><UiSelect
              class="field-input"
              data-case-field="valueType"
              aria-label="Expected value type"
              :value="rule.valueType"
              @change="onSelect('valueType', $event)"
              :options="
                withIcons(
                  ['string', 'number', 'boolean', 'null', 'object', 'array'],
                  OPTION_ICONS.jsonType,
                )
              "
          /></label>
          <label v-if="expected === 'json-type'" class="form-field"
            ><span>Expected JSON type</span
            ><UiSelect
              class="field-input"
              data-case-field="value"
              aria-label="Expected JSON type"
              :value="rule.value"
              @change="onSelect('value', $event)"
              :options="
                withIcons(
                  ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'],
                  OPTION_ICONS.jsonType,
                )
              "
          /></label>
          <p v-else-if="expected === 'null'" class="field-help">Expected value: null</p>
          <label v-else-if="expected === 'boolean'" class="form-field"
            ><span>Expected value</span
            ><UiSelect
              class="field-input"
              data-case-field="value"
              aria-label="Expected value"
              :value="rule.value"
              @change="onSelect('value', $event)"
              :options="withIcons(['true', 'false'], OPTION_ICONS.boolean)"
          /></label>
          <label v-else-if="expected === 'multiline'" class="form-field test-designer-wide"
            ><span>{{
              rule.kind === 'custom'
                ? 'Assertion'
                : rule.kind === 'json-schema'
                  ? 'JSON Schema'
                  : `Expected JSON ${rule.valueType}`
            }}</span
            ><textarea
              class="field-input test-json-value"
              data-case-field="value"
              :aria-label="
                rule.kind === 'custom'
                  ? 'Assertion'
                  : rule.kind === 'json-schema'
                    ? 'JSON Schema'
                    : 'Expected JSON value'
              "
              spellcheck="false"
              :value="rule.value"
              @input="onInput('value', $event)"
            ></textarea>
          </label>
          <label v-else-if="expected === 'text'" class="form-field"
            ><span>{{ expectedLabel }}</span
            ><input
              class="field-input"
              data-case-field="value"
              :type="numeric && !listed ? 'number' : 'text'"
              :step="numeric && !listed ? 'any' : undefined"
              :value="rule.value"
              :placeholder="expectedPlaceholder"
              :aria-label="expectedLabel"
              @input="onInput('value', $event)"
          /></label>
          <label v-if="rule.operator === 'between'" class="form-field"
            ><span>Maximum</span
            ><input
              class="field-input"
              data-case-field="secondValue"
              type="number"
              step="any"
              :value="rule.secondValue"
              aria-label="Maximum"
              @input="onInput('secondValue', $event)"
          /></label>
        </div>
        <div class="test-designer-preview">
          <span>Assertion preview</span
          ><code id="test-case-preview">{{
            preview || 'Complete the fields to preview the assertion.'
          }}</code>
        </div>
        <p id="test-case-error" class="form-error" role="alert" :hidden="!designer.error">
          {{ designer.error }}
        </p>
        <div class="test-designer-actions">
          <UiButton
            v-if="designer.editing !== null"
            label="Cancel edit"
            data-test-cancel-edit
            @click="resetDesigner"
          /><UiButton
            :label="designer.editing === null ? 'Add test case' : 'Save test case'"
            :icon="designer.editing === null ? 'plus' : 'content-save-outline'"
            variant="primary"
            type="submit"
          />
        </div>
      </form>
      <div class="test-cases-heading">
        <strong
          >Test cases <span class="count">{{ cases.length }}</span></strong
        ><UiButton
          label="Add basic suite"
          icon="check-circle-outline"
          data-add-basic-tests
          @click="append(basicSuite)"
        />
      </div>
      <ContextMenu
        ref="caseMenu"
        label="Test case actions"
        :items="caseMenuItems"
        data-test-case-menu
        @select="onCaseMenu"
      />
      <div class="test-case-list">
        <article
          v-for="(entry, index) in cases"
          :key="`${index}-${entry.line}`"
          :class="['test-case-card', { 'is-disabled': !entry.enabled }]"
          :data-test-case="index"
          @contextmenu="openCaseMenu($event, index)"
          @keydown="onCaseKeydown($event, index)"
        >
          <label class="test-case-toggle"
            ><input
              type="checkbox"
              :data-test-enabled="index"
              :checked="entry.enabled"
              :aria-label="`Enable ${caseLabel(entry)}`"
              @change="
                modify((source) =>
                  builder.toggleCase(source, index, ($event.target as HTMLInputElement).checked),
                )
              "
          /></label>
          <div class="test-case-summary">
            <h4>{{ caseLabel(entry) }}</h4>
            <code>{{ entry.assertion }}</code
            ><small
              v-if="caseResult(index) && entry.enabled"
              :class="['test-case-result', caseResult(index)!.pass ? 'passed' : 'failed']"
              >{{ caseResult(index)!.message }}</small
            >
          </div>
          <UiBadge v-bind="caseStatus(index)" />
          <div class="test-case-actions">
            <UiIconButton
              label="Move test up"
              icon="chevron-up"
              :data-test-move="index"
              data-direction="-1"
              :disabled="index === 0"
              @click="modify((source) => builder.moveCase(source, index, -1))"
            /><UiIconButton
              label="Move test down"
              icon="chevron-down"
              :data-test-move="index"
              data-direction="1"
              :disabled="index === cases.length - 1"
              @click="modify((source) => builder.moveCase(source, index, 1))"
            /><UiIconButton
              label="Edit test case"
              icon="pencil-outline"
              :data-test-edit="index"
              @click="editCase(index)"
            /><UiIconButton
              label="Duplicate test case"
              icon="content-copy"
              :data-test-duplicate="index"
              @click="modify((source) => builder.duplicateCase(source, index))"
            /><UiIconButton
              label="Delete test case"
              icon="delete-outline"
              :data-test-remove="index"
              @click="modify((source) => builder.removeCase(source, index))"
            />
          </div>
        </article>
        <UiEmptyState
          v-if="!cases.length"
          icon="check-circle-outline"
          title="No test cases yet"
          description="Choose a check above and add your first case."
        />
      </div>
    </template>

    <template v-else-if="store.mode === 'Text'">
      <div class="test-example-picker">
        <label class="form-field"
          ><span>Category</span
          ><UiSelect
            id="test-example-group"
            class="field-input"
            aria-label="Test category"
            :value="store.example.group"
            @change="setGroup"
            :options="withIcons(groups, OPTION_ICONS.exampleGroup, 'tag-outline')"
        /></label>
        <label class="form-field"
          ><span>Assertion example</span
          ><UiSelect
            id="test-example"
            class="field-input"
            aria-label="Assertion example"
            @change="store.example.selected = Number(($event.target as HTMLSelectElement).value)"
            :value="String(selectedExample)"
            :options="
              withIcons(
                examples.map((example) => ({ value: String(example.index), label: example.label })),
                'lightbulb-outline',
              )
            "
        /></label>
        <UiButton
          label="Add test"
          icon="plus"
          data-add-test-example
          @click="append(assertionExamples[selectedExample].syntax)"
        /><UiButton
          label="Add basic suite"
          icon="check-circle-outline"
          data-add-basic-tests
          @click="append(basicSuite)"
        />
      </div>
      <p id="test-example-description" class="field-help test-example-description">
        {{ assertionExamples[selectedExample].description }}
        <code>{{ assertionExamples[selectedExample].syntax }}</code>
      </p>
      <textarea
        id="tests"
        class="config-text tests-editor"
        aria-label="Response assertions"
        spellcheck="false"
        :value="request().tests"
        @input="setText"
      ></textarea>
    </template>
    <p class="field-help mt-2">
      Tests run after Send and in collection runs. Run tests checks the latest response. Text mode
      preserves custom assertions and comments.
    </p>
  </section>
</template>
