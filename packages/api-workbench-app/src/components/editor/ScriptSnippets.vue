<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import {
  CUSTOM_GROUP,
  SNIPPET_GROUPS,
  SNIPPET_PLACES,
  SNIPPET_PLACE_LABELS,
  snippetProblem,
  snippetsFor,
  type ScriptSnippet,
  type SnippetPlace,
  type UserSnippet,
} from '@techieutils/api-workbench-common/script-snippets';
import MdiIcon from '../MdiIcon.vue';
import UiButton from '../ui/UiButton.vue';
import UiIconButton from '../ui/UiIconButton.vue';

/**
 * The snippets panel beside a script editor: the workspace's own snippets, then ready-made ones,
 * for the script's place, grouped and searchable. Choosing one emits it for the editor to insert
 * at the cursor; the workspace's own can be added, edited, and deleted here.
 */
const props = defineProps<{
  place: SnippetPlace;
  custom: readonly UserSnippet[];
  /** The editor's selected text, which a new snippet starts from. */
  selection: () => string;
}>();
const emit = defineEmits<{
  insert: [snippet: ScriptSnippet];
  close: [];
  save: [snippet: Omit<UserSnippet, 'id'> & { id?: string }];
  delete: [id: string];
}>();
const query = ref('');

const groups = computed(() => {
  const found = snippetsFor(props.place, query.value, props.custom);
  return SNIPPET_GROUPS.map((group) => ({
    group,
    snippets: found.filter((snippet) => snippet.group === group),
  })).filter((entry) => entry.snippets.length);
});
const count = computed(() => groups.value.reduce((sum, entry) => sum + entry.snippets.length, 0));
const placeLabel = computed(
  () =>
    ({ pre: 'pre-request scripts', post: 'post-response scripts', module: 'library modules' })[
      props.place
    ],
);

// Adding and editing the workspace's own snippets
interface Draft {
  id?: string;
  title: string;
  description: string;
  places: SnippetPlace[];
  code: string;
}
const draft = ref<Draft>();
const problem = ref('');
const titleField = ref<HTMLInputElement>();
function open(next: Draft) {
  draft.value = next;
  problem.value = '';
  void nextTick(() => titleField.value?.focus());
}
/** A new snippet, starting from the selected code, for the place being edited. */
function startNew() {
  open({ title: '', description: '', places: [props.place], code: props.selection() });
}
function startEdit(id: string) {
  const snippet = props.custom.find((item) => item.id === id);
  if (snippet)
    open({
      id: snippet.id,
      title: snippet.title,
      description: snippet.description ?? '',
      places: [...snippet.places],
      code: snippet.code,
    });
}
function togglePlace(place: SnippetPlace, on: boolean) {
  if (!draft.value) return;
  draft.value.places = SNIPPET_PLACES.filter((item) =>
    item === place ? on : draft.value!.places.includes(item),
  );
}
function save() {
  const current = draft.value;
  if (!current) return;
  const snippet = {
    ...(current.id ? { id: current.id } : {}),
    title: current.title.trim(),
    description: current.description.trim(),
    places: current.places,
    code: current.code,
  };
  problem.value = snippetProblem(snippet) ?? '';
  if (problem.value) return;
  emit('save', snippet);
  draft.value = undefined;
}
</script>

<template>
  <aside class="script-snippets" aria-label="Snippets" data-script-snippets>
    <div class="script-snippets-head">
      <strong><MdiIcon name="code-braces" />Snippets</strong>
      <span>
        <UiIconButton
          label="New snippet"
          icon="plus"
          data-action="new-snippet"
          :disabled="Boolean(draft)"
          @click="startNew"
        /><UiIconButton label="Hide snippets" icon="close" @click="emit('close')" />
      </span>
    </div>

    <form
      v-if="draft"
      class="script-snippet-form"
      data-snippet-form
      @submit.prevent="save"
      @keydown.esc.stop="draft = undefined"
    >
      <strong>{{ draft.id ? 'Edit snippet' : 'New snippet' }}</strong>
      <label
        >Title<input
          ref="titleField"
          v-model="draft.title"
          class="field-input"
          :maxlength="80"
          placeholder="Check our error format"
          data-snippet-title
      /></label>
      <label
        >Description<input
          v-model="draft.description"
          class="field-input"
          :maxlength="200"
          placeholder="Optional"
          data-snippet-description
      /></label>
      <fieldset>
        <legend>Use in</legend>
        <label v-for="place in SNIPPET_PLACES" :key="place" class="script-snippet-place"
          ><input
            type="checkbox"
            :checked="draft.places.includes(place)"
            :data-snippet-place="place"
            @change="togglePlace(place, ($event.target as HTMLInputElement).checked)"
          />{{ SNIPPET_PLACE_LABELS[place] }}</label
        >
      </fieldset>
      <label
        >Code<textarea
          v-model="draft.code"
          class="field-input"
          rows="6"
          spellcheck="false"
          placeholder="aw.test('…', () => { … });"
          data-snippet-code
        ></textarea>
      </label>
      <p v-if="problem" class="scripts-error" role="alert">{{ problem }}</p>
      <div class="script-snippet-form-actions">
        <UiButton type="submit" label="Save snippet" icon="check" variant="primary" />
        <UiButton label="Cancel" variant="ghost" @click="draft = undefined" />
      </div>
    </form>

    <template v-else>
      <label class="script-snippets-search">
        <MdiIcon name="magnify" />
        <input
          v-model="query"
          type="search"
          :placeholder="`Search ${count} for ${placeLabel}`"
          aria-label="Search snippets"
          spellcheck="false"
          data-snippet-search
        />
      </label>
      <div class="script-snippets-list">
        <section v-for="entry in groups" :key="entry.group" class="script-snippets-group">
          <h4>{{ entry.group }}</h4>
          <div
            v-for="snippet in entry.snippets"
            :key="snippet.id"
            :class="['script-snippet-row', { 'is-custom': snippet.custom }]"
          >
            <button
              type="button"
              class="script-snippet"
              :data-snippet="snippet.id"
              :title="`Insert at the cursor:\n\n${snippet.code}`"
              @click="emit('insert', snippet)"
            >
              <span class="script-snippet-title">{{ snippet.title }}</span>
              <span v-if="snippet.description" class="script-snippet-description">{{
                snippet.description
              }}</span>
            </button>
            <span v-if="snippet.custom" class="script-snippet-actions">
              <UiIconButton
                :label="`Edit ${snippet.title}`"
                icon="pencil-outline"
                :data-edit-snippet="snippet.id"
                @click="startEdit(snippet.id)"
              /><UiIconButton
                :label="`Delete ${snippet.title}`"
                icon="delete-outline"
                :data-delete-snippet="snippet.id"
                @click="emit('delete', snippet.id)"
              />
            </span>
          </div>
        </section>
        <p v-if="!groups.length" class="script-snippets-empty">No snippets match “{{ query }}”.</p>
        <p v-if="!custom.length && !query" class="script-snippets-empty">
          Save code you use often with <strong>+</strong>: it is listed under {{ CUSTOM_GROUP }} for
          everyone in this workspace.
        </p>
      </div>
    </template>
  </aside>
</template>
