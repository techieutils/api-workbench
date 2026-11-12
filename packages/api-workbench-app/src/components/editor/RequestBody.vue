<script setup lang="ts">
import { OPTION_ICONS, withIcons } from '../../select-options';
import { computed } from 'vue';
import { render } from '../../shell';
import { action } from '../../actions';
import { errorMessage, toast } from '../../utils';
import { useWorkspaceStore } from '../../stores/workspace';
import { useRequestBodyStore } from '../../stores/request-body';
import { useSourceEditorsStore } from '../../stores/source-editors';
import MdiIcon from '../MdiIcon.vue';
import SourceEditor from '../SourceEditor.vue';
import KeyValueTable from '../table/KeyValueTable.vue';
import UiButton from '../ui/UiButton.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import UiSelect from '../ui/UiSelect.vue';
import { languageOptions } from '../../language-options';
const body = useRequestBodyStore();

/** The request body: none, form fields, raw text in a source editor, or a binary file. */
const editors = useSourceEditorsStore();
const workspace = useWorkspaceStore();
/** CodeMirror languages and formatting, from the editor runtime. */
const editorRuntime = WorkbenchEditor;
// The request is mutated in place, so read it on every render rather than caching it in a computed.
const request = () => workspace.current();
const mode = () => body.bodyType(request());
const modes: BodyType[] = ['none', 'form-data', 'x-www-form-urlencoded', 'raw', 'binary'];
const contentTypes = body.rawContentTypes;

const mime = () =>
  request().headers.find((header) => header.enabled && header.key.toLowerCase() === 'content-type')
    ?.value ||
  request().rawContentType ||
  'application/json';
const knownMime = () => contentTypes.some(([, value]) => value === mime() && value !== 'custom');
const language = () => editors.requestLanguage(request());
const wrap = computed(() => workspace.settings().wordWrap);

function setMode(next: BodyType): void {
  request().bodyType = next;
  workspace.persist();
  render();
}
/** Keeps an explicit Content-Type header in step with the chosen body type. */
function setContentType(value: string): void {
  request().rawContentType = value;
  const header = request().headers.find((row) => row.key.toLowerCase() === 'content-type');
  if (header) {
    header.value = value;
    header.enabled = true;
  }
  workspace.persist();
}
function chooseContentType(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  setContentType(value === 'custom' ? 'application/octet-stream' : value);
  render();
}
function setLanguage(event: Event): void {
  request().editorLanguage = (event.target as HTMLSelectElement).value;
  workspace.persist();
  render();
}
function setBody(value: string): void {
  request().body = value;
  workspace.persist();
}
async function chooseBinary(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const current = request();
  try {
    const data = await body.readUpload(file);
    current.binaryName = file.name;
    body.uploads.set(current.id, data);
    workspace.persist();
    render();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}
const binaryName = () =>
  body.uploads.get(request().id)?.name || request().binaryName || 'No file selected';
const binaryNote = () =>
  body.uploads.has(request().id)
    ? 'Ready to upload'
    : request().binaryName
      ? 'Select the file again for this session'
      : 'Choose any file, up to 20 MB';
</script>

<template>
  <!-- The body types and the raw editor's controls stay on one line; narrow, they scroll. -->
  <ScrollRow
    class="body-modes"
    frame-class="body-modes-frame"
    role="group"
    aria-label="Request body type"
    noun="body types"
  >
    <button
      v-for="type in modes"
      :key="type"
      type="button"
      :data-body-type="type"
      :class="{ active: mode() === type }"
      :aria-pressed="mode() === type"
      @click="setMode(type)"
    >
      <span class="mode-dot"></span>{{ type }}
    </button>
  </ScrollRow>
  <div class="body-content">
    <div v-if="mode() === 'none'" class="body-empty">
      <strong>No request body</strong><span>This request sends no body content.</span>
    </div>
    <template v-else-if="mode() === 'raw'">
      <ScrollRow class="body-format-row" frame-class="body-format-row-frame" noun="tools">
        <label class="inline-field" for="raw-content-type"
          >Content type<UiSelect
            id="raw-content-type"
            class="field-input"
            :value="knownMime() ? mime() : 'custom'"
            @change="chooseContentType"
            :options="
              withIcons(
                contentTypes.map(([label, value]) => [value, label] as [string, string]),
                OPTION_ICONS.contentType,
                'file-document-outline',
              )
            "
        /></label>
        <input
          v-if="!knownMime()"
          id="custom-content-type"
          class="field-input custom-content-type"
          aria-label="Custom content type"
          :value="mime()"
          placeholder="application/vnd.example+json"
          @input="setContentType(($event.target as HTMLInputElement).value)"
        />
        <code v-else class="body-mime">{{ mime() }}</code>
        <label class="inline-field" for="request-editor-language"
          >Language<UiSelect
            id="request-editor-language"
            class="field-input"
            :value="request().editorLanguage || 'auto'"
            @change="setLanguage"
            :options="languageOptions()"
        /></label>
        <UiButton
          label="Format"
          icon="code-tags"
          variant="ghost"
          data-action="format"
          :disabled="!editorRuntime.canFormat(language())"
          @click="action('format')"
        />
      </ScrollRow>
      <SourceEditor
        id="request-source-editor"
        class="source-editor-host request-editor-host"
        :value="request().body"
        :language="language()"
        :wrap="wrap"
        label="Request body editor"
        context-menu
        formattable
        @change="setBody"
        @format="action('format')"
        @handle="editors.setRequestEditor($event)"
      />
      <!-- Kept for scripts and assistive tools that set the body as plain text. -->
      <textarea
        id="body"
        hidden
        class="config-text body-source"
        aria-label="Request body"
        placeholder="Enter request body"
        spellcheck="false"
        :value="request().body"
        @input="setBody(($event.target as HTMLTextAreaElement).value)"
      ></textarea>
    </template>
    <template v-else-if="mode() === 'form-data' || mode() === 'x-www-form-urlencoded'">
      <p class="body-note">
        {{
          mode() === 'form-data'
            ? 'Text fields and file uploads. The multipart boundary is generated automatically.'
            : 'Fields are URL encoded when sent. Duplicate keys are supported.'
        }}
      </p>
      <KeyValueTable
        :key="mode()"
        type="bodyFields"
        :rows="() => request().bodyFields || []"
        :create="() => (request().bodyFields ||= [])"
        :form-data="mode() === 'form-data'"
      />
    </template>
    <div v-else-if="mode() === 'binary'" class="binary-upload">
      <label class="ui-button ui-button-secondary" for="binary-file"
        ><MdiIcon name="file-code-outline" />Choose file</label
      ><input id="binary-file" class="sr-only" type="file" @change="chooseBinary" />
      <div>
        <strong>{{ binaryName() }}</strong>
        <p class="field-help">{{ binaryNote() }}</p>
      </div>
    </div>
  </div>
</template>
