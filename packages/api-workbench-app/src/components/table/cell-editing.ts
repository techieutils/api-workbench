import { nextTick, reactive, shallowRef } from 'vue';
import type { FieldSuggestion } from './suggestions';

/**
 * Params and Headers cells show a label until double-clicked; only one cell edits at a time, and
 * at most one suggestion list is open. Both are page-wide, like the focus they follow.
 */
interface EditingCell {
  id: string;
  element: HTMLElement;
  /** Returns focus to the cell's label. */
  focusLabel(): void;
}
export const editing = shallowRef<EditingCell | undefined>();
export const suggestions = reactive({
  /** The cell the list belongs to, or '' when closed. */
  cell: '',
  label: '',
  items: [] as FieldSuggestion[],
  active: -1,
  current: '',
  anchor: undefined as HTMLElement | undefined,
  choose: undefined as ((value: string) => void) | undefined,
});

export function closeSuggestions(): void {
  suggestions.cell = '';
  suggestions.items = [];
  suggestions.active = -1;
  suggestions.anchor = undefined;
  suggestions.choose = undefined;
}
export function finishEditing(id: string, focusLabel = false): void {
  if (suggestions.cell === id) closeSuggestions();
  const cell = editing.value;
  if (cell?.id !== id) return;
  editing.value = undefined;
  if (focusLabel) void nextTick(() => cell.focusLabel());
}
/** Ends any inline cell edit and closes suggestions, as a full render() did before Vue. */
export function endInlineEditing(): void {
  closeSuggestions();
  editing.value = undefined;
}
export function beginEditing(cell: EditingCell): void {
  if (editing.value && editing.value.id !== cell.id) finishEditing(editing.value.id);
  editing.value = cell;
}
export function openSuggestions(options: {
  cell: string;
  label: string;
  anchor: HTMLElement;
  items: FieldSuggestion[];
  current: string;
  choose(value: string): void;
}): void {
  Object.assign(suggestions, { ...options, active: -1 });
}

// Clicks outside the editing cell end its edit; scrolling or resizing closes the list.
document.addEventListener('pointerdown', (event) => {
  const target = event.target as Node;
  const popup = document.getElementById('kv-suggestion-list');
  if (popup?.contains(target)) return;
  if (editing.value && !editing.value.element.contains(target)) finishEditing(editing.value.id);
  if (suggestions.cell && !suggestions.anchor?.contains(target)) closeSuggestions();
});
document.addEventListener(
  'scroll',
  (event) => {
    const popup = document.getElementById('kv-suggestion-list');
    if (suggestions.cell && !popup?.contains(event.target as Node)) closeSuggestions();
  },
  true,
);
window.addEventListener('resize', closeSuggestions);
