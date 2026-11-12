<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../select-options';
import { computed, ref, shallowRef } from 'vue';
import { download as saveFile, errorMessage, toast } from '../../utils';
import { useToolsStore } from '../../stores/tools';
import MdiIcon from '../MdiIcon.vue';
import UiSelect from '../ui/UiSelect.vue';
import type { MenuItem } from '../ActionMenu.vue';
import ContextMenu from '../ContextMenu.vue';

/** Generated code for the active request, docked beside it or as a dialog (App.vue adds the backdrop). */
const props = defineProps<{ docked?: boolean }>();
const tools = useToolsStore();
const dialog = computed(() =>
  tools.codeDialog && Boolean(tools.codeDialog.docked) === Boolean(props.docked)
    ? tools.codeDialog
    : undefined,
);
const selected = computed(() =>
  dialog.value?.targets.find((target) => target.id === dialog.value!.target),
);
const adapters = computed(() =>
  (dialog.value?.targets || []).reduce((total, target) => total + target.clients.length, 0),
);
const ready = computed(() => Boolean(dialog.value?.result) && !dialog.value?.loading);

/** Snippet languages the editors' formatter knows, by the generated file's extension. */
const FORMAT_LANGUAGES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  graphql: 'graphql',
};
const formatLanguage = computed(
  () => FORMAT_LANGUAGES[dialog.value?.result?.filename.split('.').pop()?.toLowerCase() ?? ''],
);
/**
 * The code as formatted, for the snippet it was made from: a new target, client, or request shows
 * freshly generated code again. Copy and Download take what is shown.
 */
const formatted = shallowRef<{ source: string; text: string }>();
const code = computed(() => {
  const generated = dialog.value?.result?.code ?? '';
  return formatted.value?.source === generated ? formatted.value.text : generated;
});
async function format(): Promise<void> {
  const generated = dialog.value?.result?.code;
  const language = formatLanguage.value;
  if (!generated || !language) return;
  try {
    const text = await WorkbenchEditor.formatText(generated, language);
    if (dialog.value?.result?.code !== generated) return;
    if (text === code.value) toast('Already formatted', 'info');
    formatted.value = { source: generated, text };
  } catch (error) {
    toast(`Format failed: ${errorMessage(error)}`, 'error');
  }
}

function setTarget(event: Event): void {
  const current = dialog.value;
  if (!current) return;
  current.target = (event.target as HTMLSelectElement).value;
  current.client = current.targets.find((target) => target.id === current.target)!.clients[0].id;
  void tools.updateCodeGeneration();
}
function setClient(event: Event): void {
  if (!dialog.value) return;
  dialog.value.client = (event.target as HTMLSelectElement).value;
  void tools.updateCodeGeneration();
}
function setRedact(event: Event): void {
  if (!dialog.value) return;
  dialog.value.redact = (event.target as HTMLInputElement).checked;
  void tools.updateCodeGeneration();
}
async function copy(): Promise<void> {
  if (!dialog.value?.result) return;
  try {
    await navigator.clipboard.writeText(code.value);
    toast('Code copied', 'success');
  } catch {
    toast('Clipboard unavailable', 'error');
  }
}
function download(): void {
  const result = dialog.value?.result;
  if (result) saveFile(result.filename, code.value, 'text/plain');
}

// The generated code's context menu: right-click, or Shift+F10 when it has focus.
const source = ref<HTMLElement>();
const codeMenu = ref<InstanceType<typeof ContextMenu>>();
const selection = ref('');
const codeMenuItems = computed<MenuItem[]>(() => [
  { id: 'copy', label: 'Copy code', icon: 'content-copy', disabled: !ready.value },
  {
    id: 'copy-selection',
    label: 'Copy selection',
    icon: 'content-copy',
    disabled: !selection.value,
  },
  { id: 'select-all', label: 'Select all', icon: 'select-all', disabled: !ready.value },
  {
    id: 'format',
    label: 'Format',
    icon: 'code-tags',
    disabled: !ready.value || !formatLanguage.value,
  },
  { id: 'download', label: 'Download', icon: 'download', separated: true, disabled: !ready.value },
  {
    id: 'redact',
    label: dialog.value?.redact ? 'Show secrets' : 'Redact secrets',
    icon: dialog.value?.redact ? 'eye-outline' : 'eye-off-outline',
    separated: true,
  },
]);
/** The selected text when it lies in the generated code. */
function codeSelection(): string {
  const current = getSelection();
  return current && source.value?.contains(current.anchorNode) ? current.toString() : '';
}
function openCodeMenu(event: MouseEvent | KeyboardEvent): void {
  if (
    event instanceof KeyboardEvent &&
    !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
  )
    return;
  if (!source.value) return;
  event.preventDefault();
  selection.value = codeSelection();
  const box = source.value.getBoundingClientRect();
  codeMenu.value?.openFor(
    source.value,
    event instanceof MouseEvent
      ? { x: event.clientX, y: event.clientY }
      : { x: box.left + 12, y: box.top + 12 },
  );
}
async function onCodeMenu(command: string): Promise<void> {
  if (command === 'copy') return copy();
  if (command === 'download') return download();
  if (command === 'format') return format();
  if (command === 'redact' && dialog.value) {
    dialog.value.redact = !dialog.value.redact;
    void tools.updateCodeGeneration();
  } else if (command === 'select-all' && source.value) {
    const range = document.createRange();
    range.selectNodeContents(source.value);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  } else if (command === 'copy-selection')
    try {
      await navigator.clipboard.writeText(selection.value);
      toast('Selection copied', 'success');
    } catch {
      toast('Clipboard unavailable', 'error');
    }
}
</script>

<template>
  <section
    v-if="dialog"
    :class="docked ? 'codegen-panel' : 'modal codegen-modal'"
    :role="docked ? 'region' : 'dialog'"
    :aria-modal="docked ? undefined : 'true'"
    aria-labelledby="codegen-title"
  >
    <div class="modal-heading">
      <div>
        <span class="eyebrow">DEVELOPER TOOLS · {{ adapters }} ADAPTERS</span>
        <h2 id="codegen-title">Generate request code</h2>
        <p class="field-help">{{ dialog.requestName }}</p>
      </div>
      <button
        type="button"
        class="icon-button"
        data-code-close
        aria-label="Close code generator"
        @click="tools.closeCodeGenerator()"
      >
        <MdiIcon name="close" />
      </button>
    </div>
    <div class="codegen-controls">
      <label class="form-field"
        ><span>Language / tool</span
        ><UiSelect
          id="code-language"
          class="field-input"
          :value="dialog.target"
          @change="setTarget"
          :options="
            withIcons(
              dialog.targets.map((target) => [target.id, target.label] as [string, string]),
              OPTION_ICONS.codeTarget,
              'code-tags',
            )
          "
      /></label>
      <label class="form-field"
        ><span>Library / client</span
        ><UiSelect
          id="code-library"
          class="field-input"
          :value="dialog.client"
          @change="setClient"
          :options="
            withIcons(
              (selected?.clients || []).map(
                (client) => [client.id, client.label] as [string, string],
              ),
              'package-variant-closed',
            )
          "
      /></label>
    </div>
    <label class="codegen-redaction"
      ><input id="code-redact" type="checkbox" :checked="dialog.redact" @change="setRedact" />
      Redact auth headers and common secret fields</label
    >
    <div id="codegen-preview" class="codegen-preview">
      <div v-if="dialog.loading" class="codegen-message" role="status">Generating snippet…</div>
      <div v-else-if="dialog.error" class="form-error p-5" role="alert">{{ dialog.error }}</div>
      <pre
        v-else
        ref="source"
        class="codegen-source"
        tabindex="0"
        aria-label="Generated request code"
        @contextmenu="openCodeMenu"
        @keydown="openCodeMenu"
      ><code>{{ code }}</code></pre>
    </div>
    <ContextMenu
      ref="codeMenu"
      label="Generated code actions"
      :items="codeMenuItems"
      data-code-menu
      @select="onCodeMenu"
    />
    <div id="codegen-notes" class="codegen-notes">
      <p v-for="note in dialog.result?.notes || []" :key="note">{{ note }}</p>
    </div>
    <div class="modal-footer">
      <span>Saved credentials use placeholders. Review raw data before sharing.</span
      ><button
        type="button"
        class="ui-button ui-button-ghost"
        data-code-format
        :disabled="!ready || !formatLanguage"
        :title="
          formatLanguage
            ? 'Format the generated code'
            : 'Formatting is available for JavaScript, TypeScript, JSON, and YAML snippets'
        "
        @click="format"
      >
        <MdiIcon name="code-tags" />Format</button
      ><button
        type="button"
        class="ui-button ui-button-secondary"
        data-code-download
        :disabled="!ready"
        @click="download"
      >
        <MdiIcon name="download" />Download</button
      ><button
        type="button"
        class="ui-button ui-button-primary"
        data-code-copy
        :disabled="!ready"
        @click="copy"
      >
        <MdiIcon name="content-copy" />Copy code
      </button>
    </div>
  </section>
</template>
