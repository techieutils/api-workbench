<script setup lang="ts">
import { nextTick, ref } from 'vue';
import {
  addPathParam,
  mockPathParams,
  removePathParam,
  renamePathParam,
  validPathParamName,
} from '@techieutils/api-workbench-common/mocks';
import {
  constrainsPathParam,
  pathParamSetupProblem,
} from '@techieutils/api-workbench-common/mock-validation';
import type {
  MockPathParam,
  MockPathParamType,
  MockRoute,
} from '@techieutils/api-workbench-common/types';
import { withIcons } from '../../select-options';
import { toast } from '../../utils';
import UiIconButton from '../ui/UiIconButton.vue';
import UiSelect from '../ui/UiSelect.vue';

/**
 * A route's path parameters, one row per `:name` in its path: what its value must be, an example,
 * and a description. The last row adds a parameter to the end of the path; renaming or removing
 * one changes the path too. Giving one a type calls `constrained`, so the route can validate.
 */
const props = defineProps<{
  /** Read on every render: the route is edited in place. */
  route(): MockRoute;
  changed(): void;
  /** Called when a parameter gets its first constraint. */
  constrained(): void;
}>();
const TYPES: [string, string, MdiIconName][] = [
  ['', 'Any value', 'asterisk'],
  ['integer', 'Integer', 'numeric'],
  ['number', 'Number', 'numeric'],
  ['boolean', 'Boolean', 'toggle-switch-outline'],
  ['uuid', 'UUID', 'identifier'],
  ['date', 'Date (YYYY-MM-DD)', 'calendar-outline'],
  ['enum', 'One of…', 'format-list-bulleted'],
  ['pattern', 'Pattern', 'regex'],
];
const typeOptions = withIcons(
  TYPES.map(([value, label]) => ({ value, label })),
  (option) => TYPES.find(([value]) => value === option.value)?.[2] ?? 'tune-variant',
);
const rows = () => mockPathParams(props.route());
/** Saves a change to one parameter, keeping only the parameters the path still has. */
function set(name: string, patch: Partial<MockPathParam>): void {
  const route = props.route();
  const before = rows().find((param) => param.name === name)!;
  const next: MockPathParam = { ...before, ...patch };
  for (const key of ['type', 'values', 'example', 'description'] as const)
    if (!next[key]) delete next[key];
  route.pathParams = rows().map((param) => (param.name === name ? next : param));
  // Drop empty entries so a path's file stays tidy.
  route.pathParams = route.pathParams.filter((param) => Object.keys(param).length > 1);
  if (!route.pathParams.length) delete route.pathParams;
  if (!constrainsPathParam(before) && constrainsPathParam(next)) props.constrained();
  props.changed();
}
/** Why a name cannot be used for a parameter of this route, or undefined when it can. */
function nameProblem(name: string, current?: string): string | undefined {
  if (!validPathParamName(name))
    return 'Use a letter or underscore, then letters, digits, or underscores, such as userId.';
  if (name !== current && rows().some((param) => param.name === name))
    return `The path already has :${name}.`;
  return undefined;
}
/** The name typed in the last row, for a new parameter. */
const draft = ref('');
const draftProblem = () => (draft.value.trim() ? nameProblem(draft.value.trim()) : undefined);
/** Adds the typed parameter to the end of the path, and focuses its example. */
function add(): void {
  const name = draft.value.trim();
  if (!name) return;
  const problem = nameProblem(name);
  if (problem) return void toast(problem, 'warning');
  props.route().path = addPathParam(props.route().path, name);
  draft.value = '';
  props.changed();
  void nextTick(() =>
    document.querySelector<HTMLInputElement>(`[data-mock-path-param-example="${name}"]`)?.focus(),
  );
}
/** Renames a parameter in the path, keeping its details; an unusable name is put back. */
function rename(param: MockPathParam, event: Event): void {
  const input = event.target as HTMLInputElement;
  const name = input.value.trim().replace(/^:/, '');
  if (name === param.name) return void (input.value = param.name);
  const problem = nameProblem(name, param.name);
  if (problem) {
    input.value = param.name;
    return void toast(problem, 'warning');
  }
  const route = props.route();
  route.path = renamePathParam(route.path, param.name, name);
  if (route.pathParams)
    route.pathParams = route.pathParams.map((item) =>
      item.name === param.name ? { ...item, name } : item,
    );
  props.changed();
}
/** Takes a parameter out of the path, with its details. */
function remove(param: MockPathParam): void {
  const route = props.route();
  route.path = removePathParam(route.path, param.name);
  route.pathParams = route.pathParams?.filter((item) => item.name !== param.name);
  if (!route.pathParams?.length) delete route.pathParams;
  props.changed();
}
const text = (event: Event) => (event.target as HTMLInputElement).value;
const placeholder = (param: MockPathParam) =>
  param.type === 'enum'
    ? 'Values, comma-separated'
    : param.type === 'pattern'
      ? 'Regular expression'
      : 'Not needed';
</script>

<template>
  <div class="table-scroll" data-mock-path-params>
    <table class="kv-table mock-path-params-table">
      <thead>
        <tr>
          <th class="mock-path-param-name">NAME</th>
          <th class="mock-path-param-type">TYPE</th>
          <th>ALLOWED VALUES</th>
          <th>EXAMPLE</th>
          <th>DESCRIPTION</th>
          <th class="deletecell"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="param in rows()" :key="param.name" :data-mock-path-param="param.name">
          <td>
            <label class="mock-path-param-field"
              ><span aria-hidden="true">:</span
              ><input
                :value="param.name"
                spellcheck="false"
                :aria-label="`Name of path parameter ${param.name}`"
                :data-mock-path-param-name="param.name"
                @change="rename(param, $event)"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
                @keydown.escape="
                  ($event.target as HTMLInputElement).value = param.name;
                  ($event.target as HTMLInputElement).blur();
                "
            /></label>
          </td>
          <td>
            <UiSelect
              class="field-input"
              :aria-label="`Type of ${param.name}`"
              :data-mock-path-param-type="param.name"
              :value="param.type ?? ''"
              :options="withIcons(typeOptions, 'tune-variant')"
              @change="
                set(param.name, {
                  type: (($event.target as HTMLSelectElement).value || undefined) as
                    MockPathParamType | undefined,
                })
              "
            />
          </td>
          <td :class="{ 'has-problem': Boolean(pathParamSetupProblem(param)) }">
            <input
              :value="param.values ?? ''"
              spellcheck="false"
              :disabled="param.type !== 'enum' && param.type !== 'pattern'"
              :placeholder="placeholder(param)"
              :aria-label="`Allowed values of ${param.name}`"
              :data-mock-path-param-values="param.name"
              @input="set(param.name, { values: text($event) })"
            />
          </td>
          <td>
            <input
              :value="param.example ?? ''"
              spellcheck="false"
              placeholder="42"
              :aria-label="`Example ${param.name}`"
              :data-mock-path-param-example="param.name"
              @input="set(param.name, { example: text($event) })"
            />
          </td>
          <td>
            <input
              :value="param.description ?? ''"
              placeholder="What it identifies"
              :aria-label="`Description of ${param.name}`"
              :data-mock-path-param-description="param.name"
              @input="set(param.name, { description: text($event) })"
            />
          </td>
          <td class="deletecell">
            <UiIconButton
              :label="`Remove :${param.name} from the path`"
              icon="close"
              :data-mock-path-param-remove="param.name"
              @click="remove(param)"
            />
          </td>
        </tr>
        <tr class="is-draft" data-mock-path-param-draft>
          <td colspan="6" :class="{ 'has-problem': Boolean(draftProblem()) }">
            <label class="mock-path-param-field mock-path-param-add"
              ><span aria-hidden="true">:</span
              ><input
                v-model="draft"
                spellcheck="false"
                placeholder="Add a parameter, such as id, and press Enter"
                aria-label="New path parameter name"
                data-mock-path-param-new
                @keydown.enter.prevent="add"
                @blur="!draftProblem() && add()"
              /><button
                type="button"
                class="text-button"
                data-mock-path-param-add
                :disabled="!draft.trim() || Boolean(draftProblem())"
                @mousedown.prevent
                @click="add"
              >
                Add to path
              </button></label
            >
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <p v-if="draftProblem()" class="field-help mock-path-param-help">{{ draftProblem() }}</p>
  <ul v-if="rows().some((param) => pathParamSetupProblem(param))" class="mock-rule-problems">
    <template v-for="param in rows()" :key="param.name">
      <li v-if="pathParamSetupProblem(param)" class="form-error">
        {{ pathParamSetupProblem(param) }}
      </li>
    </template>
  </ul>
</template>
