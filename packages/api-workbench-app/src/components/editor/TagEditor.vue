<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { folderLabel } from '@techieutils/api-workbench-common/folders';
import { parseTags, sameTag, tagCounts, tagProblem } from '@techieutils/api-workbench-common/tags';
import { useWorkspaceStore } from '../../stores/workspace';
import MdiIcon from '../MdiIcon.vue';

/**
 * Tags as chips that can be removed, with a field to type new ones, suggesting the tags already
 * used in the workspace. Tags from a collection or folder above are shown first, and are removed
 * there, not here. Used for a request's tags and a collection's or folder's.
 */
const props = withDefaults(
  defineProps<{
    tags: readonly string[];
    /** Tags this one has from the collection and folders it is in. */
    inherited?: readonly { tag: string; from: string }[];
    /** What the tags belong to, for labels: "Request", "Users". */
    owner: string;
    /** Open the field straight away, as a dialog does. */
    autofocus?: boolean;
  }>(),
  { inherited: () => [], autofocus: false },
);
const emit = defineEmits<{ change: [tags: string[]] }>();
const workspace = useWorkspaceStore();
const draft = ref('');
const problem = ref('');
const adding = ref(props.autofocus);
const field = ref<HTMLInputElement>();
if (props.autofocus) void nextTick(() => field.value?.focus());

const all = computed(() => [...props.inherited.map((entry) => entry.tag), ...props.tags]);
/** Tags used elsewhere in the workspace that this one does not have yet. */
const suggestions = computed(() =>
  tagCounts([
    ...workspace.state.requests,
    ...Object.values(workspace.state.collectionTags ?? {}).map((tags) => ({ tags })),
  ])
    .map((entry) => entry.tag)
    .filter((tag) => !all.value.some((mine) => sameTag(mine, tag))),
);
const listId = `tag-suggestions-${Math.random().toString(36).slice(2, 8)}`;

function startAdding() {
  adding.value = true;
  problem.value = '';
  void nextTick(() => field.value?.focus());
}
/** Adds what was typed; several tags at once are separated by commas or spaces. */
function add() {
  const tags = [...props.tags];
  for (const tag of parseTags(draft.value)) {
    // A tag the collection or folder already gives needs no copy here.
    const inherited = props.inherited.find((entry) => sameTag(entry.tag, tag));
    const issue = inherited
      ? `It already has ${inherited.tag} from ${folderLabel(inherited.from)}.`
      : tagProblem(tag, tags);
    if (issue) {
      problem.value = issue;
      return;
    }
    tags.push(tag);
  }
  if (tags.length !== props.tags.length) emit('change', tags);
  draft.value = '';
  problem.value = '';
}
/** Leaving the field adds what was typed; an empty field closes, clearing any message. */
function finish() {
  if (draft.value.trim()) add();
  else problem.value = '';
  if (!problem.value && !props.autofocus) adding.value = false;
}
function remove(tag: string) {
  emit(
    'change',
    props.tags.filter((own) => own !== tag),
  );
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    add();
  } else if (event.key === 'Escape' && !props.autofocus) {
    draft.value = '';
    problem.value = '';
    adding.value = false;
  } else if (event.key === 'Backspace' && !draft.value && props.tags.length)
    remove(props.tags[props.tags.length - 1]);
}
</script>

<template>
  <div class="request-tags" role="group" :aria-label="`${owner} tags`" data-request-tags>
    <span
      v-for="entry in inherited"
      :key="`inherited-${entry.tag}`"
      class="request-tag is-inherited"
      :data-inherited-tag="entry.tag"
      :title="`From ${folderLabel(entry.from)}: change it in the ${entry.from.includes('/') ? 'folder' : 'collection'}'s tags`"
      ><MdiIcon name="folder-outline" />{{ entry.tag }}</span
    >
    <span v-for="tag in tags" :key="tag" class="request-tag" :data-tag="tag"
      ><MdiIcon name="tag-outline" />{{ tag
      }}<button
        type="button"
        :aria-label="`Remove tag ${tag}`"
        :title="`Remove ${tag}`"
        @click="remove(tag)"
      >
        <MdiIcon name="close" /></button
    ></span>
    <template v-if="adding">
      <input
        ref="field"
        v-model="draft"
        class="request-tag-input"
        :list="listId"
        :aria-label="`New tag for ${owner}`"
        placeholder="smoke, auth…"
        spellcheck="false"
        data-tag-input
        @keydown="onKeydown"
        @blur="finish"
      />
      <datalist :id="listId">
        <option v-for="tag in suggestions" :key="tag" :value="tag" />
      </datalist>
    </template>
    <button v-else type="button" class="request-tag-add" data-action="add-tag" @click="startAdding">
      <MdiIcon name="tag-plus-outline" />{{ all.length ? 'Tag' : 'Add tags' }}
    </button>
    <span v-if="problem" class="request-tag-problem" role="alert">{{ problem }}</span>
  </div>
</template>
