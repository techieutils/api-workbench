<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { keyLabel, mac } from '../shortcuts';
import { toast } from '../utils';
import type { MenuItem } from './ActionMenu.vue';
import ContextMenu from './ContextMenu.vue';
import type { EditorHandle } from '../editor/runtime';

/**
 * A CodeMirror editor (src/editor/runtime.ts). It re-mounts when its language or wrapping
 * changes, and follows outside changes to `value` (formatting, imports) without echoing them.
 */
const props = defineProps<{
  value: string;
  language: string;
  wrap: boolean;
  label: string;
  readOnly?: boolean;
  /** Stays scrolled to the end as content grows, while the reader is already there. */
  follow?: boolean;
  /** Right-click (or Shift+F10) opens a menu of copy, find, and folding commands. */
  contextMenu?: boolean;
  /** The menu offers Format, which emits `format`. */
  formattable?: boolean;
  /** Suggestions for the `{{template}}` being typed. */
  completions?: (typed: string) => import('../editor/runtime').EditorCompletion[];
  /** Checks the text as a script or library module, underlining a syntax error. */
  syntax?: 'script' | 'module';
  /** Makes this a request script's editor, suggesting the `aw` API with what this gives. */
  scriptContext?: () => import('@techieutils/api-workbench-common/script-api').ScriptCompletionContext;
  /**
   * The menu offers Capture value for the clicked or selected text: this says how (`apply`), or
   * why it cannot be captured (`reason`, shown with the disabled item).
   */
  capture?: (target: {
    text: string;
    from: number;
    to: number;
  }) => { apply: () => void } | { reason: string };
}>();
const emit = defineEmits<{
  change: [value: string];
  format: [];
  /** The live editor while mounted, then undefined. */
  handle: [handle: EditorHandle | undefined];
  /** The syntax error found after a change, or undefined once there is none (with `syntax`). */
  syntax: [
    problem:
      import('@techieutils/api-workbench-common/script-syntax').ScriptSyntaxProblem | undefined,
  ];
}>();
const host = ref<HTMLElement>();
let editor: EditorHandle | undefined;
let syncing = false;

function mount(): void {
  editor?.destroy();
  editor = WorkbenchEditor.mount(host.value!, {
    value: props.value,
    language: props.language,
    readOnly: props.readOnly ?? false,
    wrap: props.wrap,
    label: props.label,
    onChange: (value) => {
      if (!syncing) emit('change', value);
    },
    onFormat: () => emit('format'),
    completions: props.completions,
    scriptContext: props.scriptContext,
    syntax: props.syntax,
    onSyntax: (problem) => emit('syntax', problem),
  });
  emit('handle', editor);
}
onMounted(mount);
watch(() => [props.language, props.wrap], mount);
watch(
  () => props.value,
  (value) => {
    if (!editor || editor.getValue() === value) return;
    const scroller = host.value?.querySelector<HTMLElement>('.cm-scroller');
    const atEnd =
      props.follow &&
      scroller &&
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const position = scroller?.scrollTop || 0;
    syncing = true;
    editor.setValue(value);
    syncing = false;
    if (scroller) scroller.scrollTop = atEnd ? scroller.scrollHeight : position;
  },
);
// The editor's context menu. Focus returns to the editor's input when it closes.
const menu = ref<InstanceType<typeof ContextMenu>>();
const selected = ref('');
const history = ref({ undo: 0, redo: 0 });
const captureOffer = ref<{ apply: () => void } | { reason: string }>();
const keys = (...names: string[]) => names.map(keyLabel).join(mac ? '' : '+');
const editing = (): MenuItem[] =>
  props.readOnly
    ? []
    : [
        {
          id: 'undo',
          label: 'Undo',
          icon: 'undo',
          shortcut: keys('Mod', 'Z'),
          disabled: !history.value.undo,
        },
        {
          id: 'redo',
          label: 'Redo',
          icon: 'redo',
          shortcut: keys('Mod', 'Shift', 'Z'),
          disabled: !history.value.redo,
        },
        {
          id: 'cut',
          label: 'Cut',
          icon: 'content-cut',
          shortcut: keys('Mod', 'X'),
          separated: true,
          disabled: !selected.value,
        },
      ];
const menuItems = computed<MenuItem[]>(() => [
  ...editing(),
  {
    id: 'copy',
    label: 'Copy',
    icon: 'content-copy',
    shortcut: keys('Mod', 'C'),
    disabled: !selected.value,
  },
  ...(props.readOnly
    ? [{ id: 'copy-all', label: 'Copy all', icon: 'content-copy' } satisfies MenuItem]
    : [
        {
          id: 'paste',
          label: 'Paste',
          icon: 'content-paste',
          shortcut: keys('Mod', 'V'),
        } satisfies MenuItem,
      ]),
  { id: 'select-all', label: 'Select all', icon: 'select-all', shortcut: keys('Mod', 'A') },
  ...(captureOffer.value
    ? [
        {
          id: 'capture',
          label:
            'reason' in captureOffer.value
              ? `Capture value · ${captureOffer.value.reason}`
              : 'Capture value',
          icon: 'variable',
          separated: true,
          disabled: 'reason' in captureOffer.value,
        } satisfies MenuItem,
      ]
    : []),
  { id: 'find', label: 'Find…', icon: 'magnify', shortcut: keys('Mod', 'F'), separated: true },
  { id: 'fold', label: 'Fold all', icon: 'chevron-up', separated: true },
  { id: 'unfold', label: 'Unfold all', icon: 'chevron-down' },
  ...(props.formattable
    ? [
        {
          id: 'format',
          label: 'Format',
          icon: 'code-braces',
          shortcut: keys('Shift', 'Alt', 'F'),
          separated: true,
        } satisfies MenuItem,
      ]
    : []),
]);
const input = () => host.value?.querySelector<HTMLElement>('.cm-content') ?? host.value!;
function openMenu(at?: { x: number; y: number }): void {
  if (!editor) return;
  selected.value = editor.selection();
  history.value = editor.history();
  if (props.capture) {
    // A right-click inside the selection captures it; elsewhere, what is under the pointer.
    const range = editor.selectionRange();
    const offset = editor.offsetAt(at);
    const inSelection =
      range.from !== range.to && (!at || (offset >= range.from && offset <= range.to));
    captureOffer.value = props.capture({
      text: editor.getValue(),
      from: inSelection ? range.from : offset,
      to: inSelection ? range.to : offset,
    });
  } else captureOffer.value = undefined;
  menu.value?.openFor(input(), at ?? editor.cursorPoint());
}
function onContextMenu(event: MouseEvent): void {
  if (!props.contextMenu) return;
  event.preventDefault();
  openMenu({ x: event.clientX, y: event.clientY });
}
function onKeydown(event: KeyboardEvent): void {
  if (
    !props.contextMenu ||
    !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
  )
    return;
  event.preventDefault();
  openMenu();
}
async function onMenuSelect(command: string): Promise<void> {
  if (!editor) return;
  if (command === 'undo' || command === 'redo') {
    editor.focus();
    editor.command(command);
  } else if (command === 'cut' || command === 'paste') {
    try {
      if (command === 'cut') {
        await navigator.clipboard.writeText(selected.value);
        editor.replaceSelection('');
      } else editor.replaceSelection(await navigator.clipboard.readText());
      editor.focus();
    } catch {
      toast('Clipboard unavailable', 'error');
    }
  } else if (command === 'copy' || command === 'copy-all')
    try {
      await navigator.clipboard.writeText(command === 'copy' ? selected.value : editor.getValue());
      toast(command === 'copy' ? 'Selection copied' : 'Copied', 'success');
    } catch {
      toast('Clipboard unavailable', 'error');
    }
  else if (command === 'select-all') {
    editor.focus();
    editor.command('selectAll');
  } else if (command === 'find') {
    editor.focus();
    editor.command('find');
  } else if (command === 'fold') editor.command('foldAll');
  else if (command === 'unfold') editor.command('unfoldAll');
  else if (command === 'format') emit('format');
  else if (command === 'capture' && captureOffer.value && 'apply' in captureOffer.value)
    captureOffer.value.apply();
}
onBeforeUnmount(() => {
  editor?.destroy();
  editor = undefined;
  emit('handle', undefined);
  if (props.syntax) emit('syntax', undefined);
});
</script>

<template>
  <!-- Callers set the host's classes and id. -->
  <div ref="host" @contextmenu="onContextMenu" @keydown="onKeydown">
    <ContextMenu
      v-if="contextMenu"
      ref="menu"
      :label="`${label} actions`"
      :items="menuItems"
      data-editor-menu
      @select="onMenuSelect"
    />
  </div>
</template>
