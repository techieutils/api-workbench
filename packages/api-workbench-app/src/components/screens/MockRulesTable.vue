<script setup lang="ts">
import { nextTick, reactive } from 'vue';
import type { MockRouteKind, MockRule } from '@techieutils/api-workbench-common/types';
import {
  MOCK_RULE_OPERATORS,
  MOCK_RULE_TARGETS,
  VALUELESS_RULE_OPERATORS,
  mockRuleProblem,
} from '@techieutils/api-workbench-common/mocks';
import { withIcons } from '../../select-options';
import UiIconButton from '../ui/UiIconButton.vue';
import UiSelect from '../ui/UiSelect.vue';

/**
 * Mock rules as a table like the headers table: a row per rule, and a last row that becomes a
 * rule as you type into it. Edits change the rules in place and then call `changed`.
 */
const props = defineProps<{
  /** Which rules these are, for labels and tests: the route's, or one of its responses'. */
  kind: 'route' | 'response' | 'validation';
  /** The route's protocol, which decides what a rule can check: gRPC calls have metadata and a message, a WebSocket handshake has no body. */
  protocol?: MockRouteKind;
  /** The rules as stored; read on every render because they are edited in place. */
  rules(): MockRule[];
  /** The stored rules for an edit, creating the list if there is none yet. */
  create(): MockRule[];
  changed(): void;
}>();

const TARGETS: Record<MockRule['target'], [string, MdiIconName, string]> = {
  query: ['Query', 'magnify', 'Parameter name'],
  header: ['Header', 'format-list-text', 'Header name'],
  cookie: ['Cookie', 'cookie-outline', 'Cookie name'],
  param: ['Path', 'link-variant', 'Path parameter, as in :id'],
  body: ['Body', 'code-json', 'JSON path, or empty for all'],
};
/** Each operator's label, the group it is listed under, and what its value field asks for. */
const OPERATORS: Record<MockRule['operator'], [string, string, string]> = {
  equals: ['equals', 'Text', 'Value'],
  'not-equals': ['does not equal', 'Text', 'Value'],
  'equals-ignore-case': ['equals, ignoring case', 'Text', 'Value'],
  'not-equals-ignore-case': ['does not equal, in any case', 'Text', 'Value'],
  contains: ['contains', 'Text', 'Text'],
  'not-contains': ['does not contain', 'Text', 'Text'],
  'contains-ignore-case': ['contains, ignoring case', 'Text', 'Text'],
  'not-contains-ignore-case': ['does not contain, in any case', 'Text', 'Text'],
  'starts-with': ['starts with', 'Text', 'Start'],
  'not-starts-with': ['does not start with', 'Text', 'Start'],
  'ends-with': ['ends with', 'Text', 'End'],
  'not-ends-with': ['does not end with', 'Text', 'End'],
  matches: ['matches regex', 'Pattern', '^[A-Z]{3}$ or /^abc$/i'],
  'not-matches': ['does not match regex', 'Pattern', '^test- or /^debug$/i'],
  'one-of': ['is one of', 'List', 'a, b, c'],
  'not-one-of': ['is not one of', 'List', 'a, b, c'],
  'contains-all': ['contains all of', 'List', 'read, write'],
  'contains-any': ['contains any of', 'List', 'admin, owner'],
  eq: ['equals the number', 'Number', '10'],
  ne: ['is not the number', 'Number', '0'],
  gt: ['is greater than', 'Number', '10'],
  gte: ['is at least', 'Number', '10'],
  lt: ['is less than', 'Number', '100'],
  lte: ['is at most', 'Number', '100'],
  between: ['is between', 'Number', '1..10'],
  'not-between': ['is not between', 'Number', '1..10'],
  'length-equals': ['has a length of', 'Length', '8'],
  'min-length': ['has a length of at least', 'Length', '3'],
  'max-length': ['has a length of at most', 'Length', '64'],
  before: ['is before', 'Date', '2026-12-31 or now'],
  after: ['is after', 'Date', '2026-01-01 or now'],
  'is-integer': ['is an integer', 'Kind of value', ''],
  'is-number': ['is a number', 'Kind of value', ''],
  'is-boolean': ['is true or false', 'Kind of value', ''],
  'is-uuid': ['is a UUID', 'Kind of value', ''],
  'is-email': ['is an email address', 'Kind of value', ''],
  'is-date': ['is a date', 'Kind of value', ''],
  'is-url': ['is a URL', 'Kind of value', ''],
  'is-ip': ['is an IP address', 'Kind of value', ''],
  'is-json': ['is valid JSON', 'Kind of value', ''],
  'is-array': ['is a JSON array', 'Kind of value', ''],
  'is-object': ['is a JSON object', 'Kind of value', ''],
  'is-alphanumeric': ['is letters and digits', 'Kind of value', ''],
  'is-base64': ['is Base64', 'Kind of value', ''],
  'is-hex': ['is hexadecimal', 'Kind of value', ''],
  'is-jwt': ['is a JWT', 'Kind of value', ''],
  'is-uppercase': ['is uppercase', 'Kind of value', ''],
  'is-lowercase': ['is lowercase', 'Kind of value', ''],
  empty: ['is empty', 'Presence', ''],
  'not-empty': ['is not empty', 'Presence', ''],
  exists: ['is present', 'Presence', ''],
  missing: ['is missing', 'Presence', ''],
};
const OPERATOR_ICONS: Record<string, MdiIconName> = {
  Text: 'format-text',
  Pattern: 'regex',
  List: 'format-list-bulleted',
  Number: 'numeric',
  Length: 'code-json',
  Date: 'calendar-outline',
  'Kind of value': 'tune-variant',
  Presence: 'filter-variant',
};
/** What a gRPC call's rules check, in its own words. */
const GRPC_TARGETS: Partial<Record<MockRule['target'], [string, MdiIconName, string]>> = {
  header: ['Metadata', 'format-list-text', 'Metadata key'],
  body: ['Message field', 'code-json', 'Field path, or empty for all'],
};
/** What a Socket.IO handshake's rules check: its auth payload is the body. */
const SOCKETIO_TARGETS: Partial<Record<MockRule['target'], [string, MdiIconName, string]>> = {
  body: ['Auth payload', 'code-json', 'Field path, such as token'],
};
/** What an MQTT route's rules check: the client, the topic's levels, and the message. */
const MQTT_TARGETS: Partial<Record<MockRule['target'], [string, MdiIconName, string]>> = {
  header: ['Client', 'card-account-details-outline', 'client-id or username'],
  param: ['Topic level', 'code-braces', 'Name from :name in the topic'],
  body: ['Payload', 'code-json', 'Field path, or empty for all'],
};
const targetsFor = (): MockRule['target'][] =>
  props.protocol === 'grpc'
    ? ['header', 'body']
    : props.protocol === 'websocket'
      ? ['query', 'header', 'cookie', 'param']
      : props.protocol === 'mqtt'
        ? ['header', 'param', 'body']
        : [...MOCK_RULE_TARGETS];
const target = (value: MockRule['target']) =>
  (props.protocol === 'grpc' && GRPC_TARGETS[value]) ||
  (props.protocol === 'socketio' && SOCKETIO_TARGETS[value]) ||
  (props.protocol === 'mqtt' && MQTT_TARGETS[value]) ||
  TARGETS[value];
const targetOptions = () =>
  withIcons(
    targetsFor().map((value) => ({ value, label: target(value)[0] })),
    (option) => target(option.value as MockRule['target'])[1],
  );
const operatorOptions = withIcons(
  MOCK_RULE_OPERATORS.map((operator) => ({
    value: operator,
    label: OPERATORS[operator][0],
    group: OPERATORS[operator][1],
  })),
  (option) =>
    OPERATOR_ICONS[OPERATORS[option.value as MockRule['operator']][1]] ?? 'filter-variant',
);
const draft = reactive<MockRule>({
  enabled: true,
  target: targetsFor()[0],
  name: '',
  operator: 'equals',
  value: '',
});
const rows = () => [...props.rules(), draft];
const valueless = (rule: MockRule) => VALUELESS_RULE_OPERATORS.includes(rule.operator);

function set<K extends keyof MockRule>(index: number, field: K, value: MockRule[K]): void {
  const rules = props.rules();
  if (index < rules.length) {
    rules[index][field] = value;
    props.changed();
    return;
  }
  // The last row becomes a rule once text is typed; its other choices carry over.
  draft[field] = value;
  if ((field !== 'name' && field !== 'value') || !value) return;
  props.create().push({ ...draft });
  Object.assign(draft, {
    enabled: true,
    target: targetsFor()[0],
    name: '',
    operator: 'equals',
    value: '',
  });
  props.changed();
  void nextTick(() =>
    document
      .querySelector<HTMLInputElement>(
        `[data-rules-kind=${props.kind}] [data-mock-rule-${field}="${props.rules().length - 1}"]`,
      )
      ?.focus(),
  );
}
function remove(index: number): void {
  props.rules().splice(index, 1);
  props.changed();
}
const text = (event: Event) => (event.target as HTMLInputElement).value;
const choice = (event: Event) => (event.target as HTMLSelectElement).value;
</script>

<template>
  <div class="table-scroll" :data-rules-kind="kind">
    <table class="kv-table mock-rules-table">
      <thead>
        <tr>
          <th class="checkcell"><span class="sr-only">Enabled</span></th>
          <th class="mock-rule-target">CHECKS</th>
          <th>NAME</th>
          <th class="mock-rule-operator">COMPARISON</th>
          <th>VALUE</th>
          <th class="deletecell"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(rule, index) in rows()"
          :key="index"
          :class="{ 'is-draft': rule === draft, 'is-off': !rule.enabled }"
        >
          <td class="checkcell">
            <input
              type="checkbox"
              :checked="rule.enabled"
              :aria-label="`Use rule ${index + 1}`"
              @change="set(index, 'enabled', ($event.target as HTMLInputElement).checked)"
            />
          </td>
          <td>
            <UiSelect
              class="field-input"
              :aria-label="`Rule ${index + 1} checks`"
              :data-mock-rule-target="index"
              :value="rule.target"
              :options="withIcons(targetOptions(), 'filter-variant')"
              @change="set(index, 'target', choice($event) as MockRule['target'])"
            />
          </td>
          <td
            :class="{
              'has-problem':
                rule !== draft && rule.enabled && !rule.name.trim() && rule.target !== 'body',
            }"
          >
            <input
              :value="rule.name"
              spellcheck="false"
              :placeholder="target(rule.target)[2]"
              :aria-label="`Rule ${index + 1} name`"
              :data-mock-rule-name="index"
              @input="set(index, 'name', text($event))"
            />
          </td>
          <td>
            <UiSelect
              class="field-input"
              :aria-label="`Rule ${index + 1} comparison`"
              :data-mock-rule-operator="index"
              :value="rule.operator"
              :options="withIcons(operatorOptions, 'filter-variant')"
              @change="set(index, 'operator', choice($event) as MockRule['operator'])"
            />
          </td>
          <td
            :class="{
              'has-problem': rule !== draft && !valueless(rule) && Boolean(mockRuleProblem(rule)),
            }"
          >
            <span v-if="valueless(rule)" class="mock-rule-novalue">No value needed</span>
            <input
              v-else
              :value="rule.value"
              spellcheck="false"
              :placeholder="OPERATORS[rule.operator][2] || 'Value'"
              :aria-label="`Rule ${index + 1} value`"
              :data-mock-rule-value="index"
              @input="set(index, 'value', text($event))"
            />
          </td>
          <td class="deletecell">
            <UiIconButton
              v-if="rule !== draft"
              label="Remove rule"
              icon="close"
              :data-mock-remove-rule="index"
              @click="remove(index)"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <ul
    v-if="rules().some((rule) => rule.enabled && mockRuleProblem(rule))"
    class="mock-rule-problems"
  >
    <template v-for="(rule, index) in rules()" :key="index">
      <li
        v-if="rule.enabled && mockRuleProblem(rule)"
        :class="[
          rule.target !== 'body' && !rule.name.trim() ? 'field-help' : 'form-error',
          'mock-rule-problem',
        ]"
      >
        Rule {{ index + 1 }}: {{ mockRuleProblem(rule) }}
      </li>
    </template>
  </ul>
</template>
