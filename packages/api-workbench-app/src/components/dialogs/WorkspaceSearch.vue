<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useWorkspaceStore } from '../../stores/workspace';
import { useDialogsStore } from '../../stores/dialogs';
import MdiIcon from '../MdiIcon.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import TagFilterChips from '../ui/TagFilterChips.vue';
import { effectiveTags, tagCounts, type TagFilter } from '@techieutils/api-workbench-common/tags';

/** Search across requests, collections, environments, and pages; `>` switches to commands. */
const dialogs = useDialogsStore();
const workspace = useWorkspaceStore();
const search = dialogs.search;
// The results read the search query and the workspace store, so this tracks both.
const results = computed(() => dialogs.searchResults());
const selected = computed(() => Math.max(0, Math.min(search.selected, results.value.length - 1)));
const categories = ['All', 'Requests', 'Collections', 'Environments', 'Pages'];
/** Every tag in the workspace, with how many requests have it. */
const tagCountsInWorkspace = computed(() =>
  tagCounts(
    workspace.state.requests.map((request) => ({ tags: effectiveTags(workspace.state, request) })),
  ),
);
function setTags(filter: TagFilter): void {
  search.tags = filter;
  search.selected = 0;
  input.value?.focus();
}
const input = ref<HTMLInputElement>();
const backdrop = ref<HTMLElement>();

function onInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  if (value.startsWith('>')) {
    dialogs.openPalette(value.slice(1).trimStart());
    return;
  }
  search.query = value;
  search.selected = 0;
}
function setCategory(category: string): void {
  search.category = category;
  search.selected = 0;
  input.value?.focus();
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    dialogs.closeSearch();
  } else if (
    event.target === input.value &&
    ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)
  ) {
    event.preventDefault();
    const count = results.value.length;
    if (event.key === 'Enter') dialogs.selectSearchResult(selected.value);
    else if (count) {
      search.selected = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      void nextTick(() =>
        document
          .querySelector(`#workspace-search-result-${search.selected}`)
          ?.scrollIntoView({ block: 'nearest' }),
      );
    }
  } else if (event.key === 'Tab') {
    const controls = Array.from(
      backdrop.value!.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])'),
    );
    if (event.shiftKey && document.activeElement === controls[0]) {
      event.preventDefault();
      controls.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
      event.preventDefault();
      controls[0].focus();
    }
  }
}
</script>

<template>
  <div
    ref="backdrop"
    class="modal-backdrop workspace-search-backdrop"
    @click.self="dialogs.closeSearch()"
    @keydown="onKeydown"
  >
    <section
      class="modal workspace-search-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Search workspace"
    >
      <div class="workspace-search-input-row">
        <MdiIcon name="magnify" /><input
          id="global-workspace-search"
          ref="input"
          role="combobox"
          aria-label="Search workspace"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="workspace-search-results"
          :aria-activedescendant="
            results.length ? `workspace-search-result-${selected}` : undefined
          "
          autocomplete="off"
          placeholder="Search requests, collections, environments, or #tag…"
          :value="search.query"
          @input="onInput"
        /><UiIconButton
          label="Close search"
          icon="close"
          data-search-close
          @click="dialogs.closeSearch()"
        />
      </div>
      <div class="workspace-search-categories" aria-label="Search category">
        <button
          v-for="category in categories"
          :key="category"
          type="button"
          :data-search-category="category"
          :aria-pressed="search.category === category"
          @click="setCategory(category)"
        >
          {{ category }}
        </button>
      </div>
      <TagFilterChips
        v-if="tagCountsInWorkspace.length"
        class="workspace-search-tags"
        :counts="tagCountsInWorkspace"
        :filter="search.tags"
        verb="show"
        :limit="8"
        data-search-tags
        @change="setTags"
      />
      <div class="workspace-search-scope">
        <MdiIcon name="layers-outline" /><span>{{ workspace.settings().workspaceName }}</span
        ><span id="workspace-search-count" role="status"
          >{{ results.length }} result{{ results.length === 1 ? '' : 's' }}</span
        >
      </div>
      <div
        id="workspace-search-results"
        class="workspace-search-results"
        role="listbox"
        aria-label="Search results"
      >
        <button
          v-for="(item, index) in results"
          :id="`workspace-search-result-${index}`"
          :key="`${item.kind}:${item.name}:${index}`"
          type="button"
          :class="['workspace-search-result', { 'is-selected': index === selected }]"
          role="option"
          :aria-selected="index === selected"
          :data-search-result="index"
          tabindex="-1"
          @click="dialogs.selectSearchResult(index)"
        >
          <span class="workspace-search-result-icon"><MdiIcon :name="item.icon" /></span
          ><span class="workspace-search-result-copy"
            ><strong>{{ item.name }}</strong
            ><small>{{ item.detail }}</small></span
          ><span class="workspace-search-result-kind">{{ item.kind }}</span
          ><MdiIcon name="chevron-right" />
        </button>
        <UiEmptyState
          v-if="!results.length"
          icon="magnify"
          title="No matches found"
          description="Try a request name, URL, method, collection, or environment."
        />
      </div>
      <div class="workspace-search-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span
        ><span><kbd>Esc</kbd> Close</span
        ><span class="right">Type <kbd>&gt;</kbd> for commands</span>
      </div>
    </section>
  </div>
</template>
