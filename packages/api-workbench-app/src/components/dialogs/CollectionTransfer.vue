<script setup lang="ts">
import { requestMethodIcon } from '../../stores/protocols';
import MdiIcon from '../MdiIcon.vue';
import { OPTION_ICONS, withIcons } from '../../select-options';
import { collectionOf, folderLabel } from '@techieutils/api-workbench-common/folders';
import { computed, nextTick, ref, watch, watchEffect } from 'vue';
import { useRendered } from '../../composables/rendered';
import { errorMessage } from '../../utils';
import { useDialogsStore } from '../../stores/dialogs';
import { useShareStore } from '../../stores/share';
import { useVaultStore } from '../../stores/vault';
import { useWorkspaceStore } from '../../stores/workspace';
import UiButton from '../ui/UiButton.vue';
import UiIconButton from '../ui/UiIconButton.vue';
import UiExpansionPanel from '../ui/UiExpansionPanel.vue';
import UiSelect from '../ui/UiSelect.vue';
import UiTabs from '../ui/UiTabs.vue';

/**
 * Import collections and specifications from files, a link, or pasted text, with a preview; or
 * export the workspace or a collection as a download, to the clipboard, or as a GitHub gist.
 */
const dialogs = useDialogsStore();
const transfer = dialogs.transfer;
const share = useShareStore();
const gist = share.gist;
const vault = useVaultStore();
const workspace = useWorkspaceStore();
const importing = computed(() => transfer.mode === 'import');
const formats = WorkbenchTransfer.exportFormats;
const format = computed(() => formats.find((item) => item.id === transfer.format)!);
const folders = computed(() => [
  ...new Set(workspace.state.requests.map((request) => collectionOf(request.folder))),
]);
const linkImport = Boolean(window.workbench?.importLink);
const gistSharing = Boolean(window.workbench?.gists);
const IMPORT_FORMATS = [
  'Postman',
  'Bruno',
  'Insomnia',
  'Hoppscotch',
  'OpenCollection',
  'OpenAPI',
  'Swagger',
  'WSDL',
  'HAR',
  'cURL',
  '.http',
  'ZIP',
];

// The export is generated as its options change, so its size and notes show before it goes anywhere.
const exportError = ref('');
watchEffect(() => {
  if (transfer.mode !== 'export') return;
  void workspace.state;
  exportError.value = '';
  try {
    transfer.exported = dialogs.exportCollection(
      dialogs.exportSnapshot(),
      transfer.format,
      transfer.archive,
    );
  } catch (error) {
    transfer.exported = undefined;
    exportError.value = errorMessage(error);
  }
});
const requiresArchive = computed(
  () =>
    format.value.id === 'bruno' ||
    (!transfer.archive && Boolean(transfer.exported?.name.endsWith('.zip'))),
);
const isZip = computed(() => Boolean(transfer.exported?.name.endsWith('.zip')));
// A ZIP is bytes, not text: it can only be downloaded.
watch(isZip, (zip) => {
  if (zip && transfer.destination !== 'download') transfer.destination = 'download';
});
watch(
  () => [transfer.mode, transfer.scope, transfer.format, transfer.source?.name],
  () => {
    if (transfer.mode === 'export') share.prepare();
  },
  { immediate: true },
);

const label = (request: Partial<ApiRequest>) =>
  request.protocol && request.protocol !== 'http' ? request.protocol.toUpperCase() : request.method;
const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Import
const importTabs = computed<UITab[]>(() => [
  { name: 'Files', icon: 'file-upload-outline' },
  ...(linkImport ? [{ name: 'Link', icon: 'link-variant' } as UITab] : []),
  { name: 'Paste', icon: 'content-paste' },
]);
function selectSource(name: string): void {
  transfer.importSource = name as typeof transfer.importSource;
  transfer.error = '';
}
/** The preview's first 50 requests, by collection. */
const previewGroups = computed(() => {
  const groups = new Map<string, Partial<ApiRequest>[]>();
  for (const request of transfer.preview?.data.requests.slice(0, 50) ?? []) {
    const collection = request.folder ? collectionOf(request.folder) : 'Imported';
    groups.set(collection, [...(groups.get(collection) ?? []), request]);
  }
  return [...groups];
});
const previewStats = computed(() => {
  const preview = transfer.preview;
  if (!preview) return [];
  const requests = preview.data.requests;
  return [
    { label: 'Requests', value: requests.length, icon: 'console-network-outline' },
    {
      label: 'Collections',
      value: new Set(requests.map((request) => collectionOf(request.folder || 'Imported'))).size,
      icon: 'folder-outline',
    },
    {
      label: 'Environments',
      value: preview.data.environments?.length || 0,
      icon: 'layers-outline',
    },
    { label: 'Files read', value: preview.files, icon: 'file-document-outline' },
  ] as const;
});
function setLink(event: Event): void {
  transfer.link = (event.target as HTMLInputElement).value;
}
function setPasted(event: Event): void {
  transfer.pasted = (event.target as HTMLTextAreaElement).value;
  transfer.preview = undefined;
}
const chooseFiles = () => document.querySelector<HTMLInputElement>('#import-file')?.click();
const chooseFolder = () => document.querySelector<HTMLInputElement>('#import-directory')?.click();
function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  transfer.dragging = true;
}
function onDragLeave(event: DragEvent): void {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null))
    transfer.dragging = false;
}
function onDrop(event: DragEvent): void {
  event.preventDefault();
  transfer.dragging = false;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) void dialogs.previewFiles(files);
}

// Export
function setFormat(event: Event): void {
  transfer.format = (event.target as HTMLSelectElement).value;
  transfer.error = '';
}
function setScope(event: Event): void {
  transfer.scope = (event.target as HTMLSelectElement).value;
  transfer.error = '';
}
const exportCounts = computed(() => {
  void workspace.state;
  const snapshot = transfer.mode === 'export' ? dialogs.exportSnapshot() : undefined;
  return {
    requests: snapshot?.requests.length ?? 0,
    environments: snapshot?.environments.length ?? 0,
  };
});
/** The first lines of a text export, so what will be shared can be read before it is. */
const exportPreview = computed(() => {
  const exported = transfer.exported;
  if (!exported || isZip.value) return '';
  const bytes = new Uint8Array(exported.data);
  const lines = new TextDecoder().decode(bytes.slice(0, 8192)).split('\n');
  return lines.slice(0, 60).join('\n') + (lines.length > 60 || bytes.length > 8192 ? '\n…' : '');
});
type Destination = 'download' | 'copy' | 'gist';
const destinations = computed(() => [
  {
    id: 'download' as Destination,
    label: 'Download',
    detail: 'Save a file to share or keep',
    icon: 'download-outline' as MdiIconName,
    disabled: false,
  },
  {
    id: 'copy' as Destination,
    label: 'Copy',
    detail: isZip.value ? 'Not available for ZIP' : 'Paste into a chat, ticket, or editor',
    icon: 'content-copy' as MdiIconName,
    disabled: isZip.value,
  },
  ...(gistSharing
    ? [
        {
          id: 'gist' as Destination,
          label: 'GitHub Gist',
          detail: isZip.value ? 'Not available for ZIP' : 'A link teammates can import',
          icon: 'github' as MdiIconName,
          disabled: isZip.value,
        },
      ]
    : []),
]);
function setDestination(id: Destination): void {
  transfer.destination = id;
  transfer.error = '';
  if (id === 'gist') {
    share.prepare();
    void nextTick(() =>
      document
        .querySelector('[data-transfer-gist]')
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  }
}
/** Arrow keys move between destinations, as in a radio group. */
function onDestinationKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const enabled = destinations.value.filter((item) => !item.disabled);
  const index = enabled.findIndex((item) => item.id === transfer.destination);
  const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const next = enabled[(index + step + enabled.length) % enabled.length];
  setDestination(next.id);
  document.querySelector<HTMLElement>(`[data-transfer-destination="${next.id}"]`)?.focus();
}
const githubCredentials = useRendered(() => share.githubCredentials());
const vaultLocked = useRendered(() => Boolean(window.workbench) && !vault.loaded);
const remembered = useRendered(() =>
  transfer.mode === 'export' ? share.rememberedGist() : undefined,
);
type GistText = 'description' | 'target' | 'tokenName' | 'tokenServer' | 'token';
function setGistText(key: GistText, event: Event): void {
  gist[key] = (event.target as HTMLInputElement).value;
  if (key.startsWith('token')) gist.tokenError = '';
}
function setCredential(event: Event): void {
  gist.credentialId = (event.target as HTMLSelectElement).value;
}

const confirmLabel = computed(() => {
  if (transfer.busy) return 'Reading…';
  if (importing.value)
    return transfer.preview
      ? `Import ${plural(transfer.preview.data.requests.length, 'request')}`
      : 'Import into workspace';
  if (transfer.destination === 'copy') return 'Copy to clipboard';
  if (transfer.destination === 'gist')
    return gist.busy ? 'Publishing…' : gist.mode === 'update' ? 'Update gist' : 'Publish gist';
  return 'Download export';
});
const confirmIcon = computed<MdiIconName>(() =>
  importing.value
    ? 'import'
    : transfer.destination === 'copy'
      ? 'content-copy'
      : transfer.destination === 'gist'
        ? 'github'
        : 'download-outline',
);
const confirmDisabled = computed(
  () =>
    transfer.busy ||
    gist.busy ||
    (importing.value
      ? !transfer.preview
      : !transfer.exported ||
        (transfer.destination === 'gist' && (!gist.credentialId || vaultLocked.value))),
);

const dialog = ref<HTMLElement>();
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    dialogs.closeTransfer();
  }
  if (event.key !== 'Tab') return;
  const targets = Array.from(
    dialog.value!.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select, textarea, summary, a[href]',
    ),
  ).filter((element) => !element.closest('[hidden]') && element.tabIndex !== -1);
  const first = targets[0],
    last = targets[targets.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
</script>

<template>
  <div class="modal-backdrop">
    <section
      ref="dialog"
      class="modal collection-transfer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-title"
      aria-describedby="transfer-subtitle"
      :aria-busy="transfer.busy || gist.busy"
      @keydown="onKeydown"
    >
      <div class="modal-heading transfer-heading">
        <span class="transfer-heading-icon" aria-hidden="true"
          ><MdiIcon :name="importing ? 'import' : 'share-variant-outline'"
        /></span>
        <div class="transfer-heading-text">
          <span class="eyebrow">COLLECTIONS &amp; SPECIFICATIONS</span>
          <h2 id="transfer-title">{{ importing ? 'Import' : 'Export and share' }}</h2>
          <p id="transfer-subtitle" class="transfer-subtitle">
            {{
              importing
                ? 'Bring in collections and specifications from other tools. Nothing is added until you review it.'
                : 'Share the workspace or one collection as a file, on the clipboard, or as a GitHub gist.'
            }}
          </p>
        </div>
        <UiIconButton
          label="Close import/export"
          icon="close"
          data-transfer-close
          :disabled="transfer.busy"
          @click="dialogs.closeTransfer()"
        />
      </div>
      <div class="transfer-content">
        <p v-if="transfer.error" class="transfer-alert" role="alert">
          <MdiIcon name="alert-circle-outline" /><span>{{ transfer.error }}</span>
        </p>
        <template v-if="importing">
          <UiTabs
            group="transfer-source"
            label="Import from"
            attribute="data-transfer-tab"
            class="transfer-tabs"
            :items="importTabs"
            :active="transfer.importSource"
            :disabled="transfer.busy"
            @select="selectSource"
          />
          <div
            id="transfer-source-panel"
            class="transfer-source-panel"
            role="tabpanel"
            :aria-labelledby="`transfer-source-tab-${transfer.importSource.toLowerCase()}`"
          >
            <div
              :hidden="transfer.importSource !== 'Files'"
              :class="['transfer-dropzone', { dragging: transfer.dragging }]"
              data-transfer-dropzone
              @dragover="onDragOver"
              @dragleave="onDragLeave"
              @drop="onDrop"
            >
              <span class="transfer-dropzone-icon" aria-hidden="true"
                ><MdiIcon name="file-upload-outline"
              /></span>
              <strong>{{
                transfer.dragging ? 'Drop to preview' : 'Drop files or a ZIP here'
              }}</strong>
              <p>Or choose them. A whole collection folder, such as a Bruno one, works too.</p>
              <div class="transfer-file-actions">
                <UiButton
                  label="Choose files"
                  icon="import"
                  variant="primary"
                  data-transfer-files
                  :disabled="transfer.busy"
                  @click="chooseFiles"
                /><UiButton
                  label="Choose folder"
                  icon="folder-outline"
                  data-transfer-folder
                  :disabled="transfer.busy"
                  @click="chooseFolder"
                />
              </div>
              <ul class="transfer-format-chips" aria-label="Formats that can be imported">
                <li v-for="name in IMPORT_FORMATS" :key="name">{{ name }}</li>
              </ul>
            </div>
            <form
              v-if="linkImport"
              :hidden="transfer.importSource !== 'Link'"
              class="transfer-link"
              data-transfer-link-form
              @submit.prevent="dialogs.previewLink()"
            >
              <label class="form-field" for="transfer-link"
                ><span>Link to a collection or specification</span
                ><input
                  id="transfer-link"
                  class="field-input"
                  type="url"
                  inputmode="url"
                  spellcheck="false"
                  autocomplete="off"
                  placeholder="https://github.com/team/api/blob/main/collection.json"
                  aria-describedby="transfer-link-help"
                  :disabled="transfer.busy"
                  :value="transfer.link"
                  @input="setLink"
              /></label>
              <UiButton
                type="submit"
                label="Preview link"
                icon="link-variant"
                variant="primary"
                data-transfer-link
                :disabled="transfer.busy || !transfer.link.trim()"
              />
              <ul id="transfer-link-help" class="transfer-link-kinds">
                <li><MdiIcon name="github" />Gists: every file in the gist</li>
                <li>
                  <MdiIcon name="source-branch" />Files on GitHub, GitLab, or Bitbucket, by their
                  page or raw link
                </li>
                <li><MdiIcon name="web" />Any public http(s) URL, such as an openapi.json</li>
              </ul>
            </form>
            <div :hidden="transfer.importSource !== 'Paste'" class="transfer-paste">
              <label class="form-field" for="transfer-source"
                ><span>A collection, specification, or cURL command</span
                ><textarea
                  id="transfer-source"
                  class="field-input transfer-source"
                  spellcheck="false"
                  placeholder="Paste JSON, YAML, WSDL, or curl …"
                  :disabled="transfer.busy"
                  :value="transfer.pasted"
                  @input="setPasted"
                ></textarea>
              </label>
              <UiButton
                label="Preview pasted content"
                icon="eye-outline"
                data-transfer-parse
                :disabled="transfer.busy"
                @click="dialogs.previewPasted()"
              />
            </div>
          </div>
          <section
            v-if="transfer.preview"
            class="transfer-preview"
            role="status"
            aria-labelledby="transfer-preview-title"
          >
            <div class="transfer-preview-heading">
              <div>
                <span class="eyebrow">READY TO IMPORT</span>
                <h3 id="transfer-preview-title">{{ transfer.preview.format }}</h3>
              </div>
              <span class="transfer-badge"
                ><MdiIcon name="briefcase-outline" />Into
                {{ workspace.settings().workspaceName }}</span
              >
            </div>
            <dl class="transfer-stats">
              <div v-for="stat in previewStats" :key="stat.label">
                <dt><MdiIcon :name="stat.icon" />{{ stat.label }}</dt>
                <dd>{{ stat.value.toLocaleString() }}</dd>
              </div>
            </dl>
            <div class="transfer-request-list">
              <div v-for="[collection, requests] in previewGroups" :key="collection">
                <h4><MdiIcon name="folder-outline" />{{ collection }}</h4>
                <div v-for="(request, index) in requests" :key="index" class="transfer-request">
                  <span :class="['method', label(request)]"
                    ><MdiIcon
                      :name="requestMethodIcon(request as ApiRequest)"
                      class="method-icon"
                    />{{ label(request) }}</span
                  ><span>{{ request.name || request.url }}</span
                  ><small>{{ request.folder ? folderLabel(request.folder) : 'Imported' }}</small>
                </div>
              </div>
              <p v-if="transfer.preview.data.requests.length > 50" class="field-help">
                And {{ plural(transfer.preview.data.requests.length - 50, 'more request') }}.
              </p>
            </div>
            <UiExpansionPanel
              v-if="transfer.preview.warnings.length"
              class="transfer-warnings"
              title="Conversion notes"
              description="What could not be converted exactly. Review it before you continue."
              icon="alert-outline"
              :badge="String(transfer.preview.warnings.length)"
              open
            >
              <ul>
                <li v-for="(warning, index) in transfer.preview.warnings" :key="index">
                  {{ warning }}
                </li>
              </ul>
            </UiExpansionPanel>
          </section>
          <p v-else class="transfer-assurance">
            <MdiIcon name="shield-check-outline" /><span
              >Imports are parsed, never run: scripts in the source are not executed, and existing
              requests stay as they are.</span
            >
          </p>
        </template>
        <template v-else>
          <div class="transfer-export-layout">
            <div class="transfer-export-options">
              <div class="transfer-export-grid">
                <div v-if="transfer.source" class="form-field" data-transfer-source>
                  <span>What to export</span>
                  <p class="transfer-source">
                    <MdiIcon name="server-network" />Mock server: {{ transfer.source.name }} ·
                    {{ plural(transfer.source.snapshot.requests.length, 'route') }} as requests
                  </p>
                </div>
                <label v-else class="form-field"
                  ><span>What to export</span
                  ><UiSelect
                    id="transfer-scope"
                    class="field-input"
                    :value="transfer.scope"
                    @change="setScope"
                    :options="
                      withIcons(
                        [
                          ['', 'Entire workspace'],
                          ...folders.map((folder) => [folder, folder] as [string, string]),
                        ],
                        (option) => (option.value ? 'folder-outline' : 'briefcase-outline'),
                      )
                    "
                /></label>
                <label class="form-field"
                  ><span>Format</span
                  ><UiSelect
                    id="transfer-format"
                    class="field-input"
                    :value="transfer.format"
                    @change="setFormat"
                    :options="
                      withIcons(
                        formats.map((item) => [item.id, item.label] as [string, string]),
                        OPTION_ICONS.exportFormat,
                        'file-code-outline',
                      )
                    "
                  /><small class="field-help">{{ format.detail }}</small></label
                >
              </div>
              <label class="transfer-archive"
                ><input
                  id="transfer-archive"
                  type="checkbox"
                  :checked="transfer.archive || requiresArchive"
                  :disabled="requiresArchive"
                  @change="transfer.archive = ($event.target as HTMLInputElement).checked"
                />
                Package as ZIP{{
                  format.id === 'postman' ? ' (includes all environments)' : ''
                }}</label
              >
              <p v-if="exportError" class="transfer-alert" role="alert">
                <MdiIcon name="alert-circle-outline" /><span>{{ exportError }}</span>
              </p>
              <div class="transfer-destinations">
                <span id="transfer-destination-label" class="transfer-label">Send it to</span>
                <div
                  role="radiogroup"
                  aria-labelledby="transfer-destination-label"
                  @keydown="onDestinationKeydown"
                >
                  <button
                    v-for="item in destinations"
                    :key="item.id"
                    type="button"
                    role="radio"
                    :class="['transfer-destination', { active: transfer.destination === item.id }]"
                    :aria-checked="transfer.destination === item.id"
                    :tabindex="transfer.destination === item.id ? 0 : -1"
                    :disabled="item.disabled || gist.busy"
                    :data-transfer-destination="item.id"
                    @click="setDestination(item.id)"
                  >
                    <MdiIcon :name="item.icon" /><span
                      ><strong>{{ item.label }}</strong
                      ><small>{{ item.detail }}</small></span
                    >
                  </button>
                </div>
              </div>
              <section
                v-if="transfer.destination === 'gist'"
                class="transfer-gist"
                aria-labelledby="transfer-gist-title"
                data-transfer-gist
              >
                <h3 id="transfer-gist-title"><MdiIcon name="github" />Publish to GitHub Gist</h3>
                <p v-if="gist.error" class="transfer-alert" role="alert" data-transfer-gist-error>
                  <MdiIcon name="alert-circle-outline" /><span>{{ gist.error }}</span>
                </p>
                <div v-if="gist.result" class="transfer-gist-result" role="status" data-gist-result>
                  <MdiIcon name="check-circle-outline" />
                  <div>
                    <strong>{{ gist.result.updated ? 'Gist updated' : 'Gist published' }}</strong>
                    <a :href="gist.result.url" data-gist-link @click.prevent="share.openGist()">{{
                      gist.result.url
                    }}</a>
                    <small
                      >{{
                        gist.result.public ? 'Public' : 'Secret: only people with the link see it'
                      }}. Teammates can import it with Import → Link.</small
                    >
                  </div>
                  <div class="transfer-gist-result-actions">
                    <UiButton
                      label="Copy link"
                      icon="content-copy"
                      data-gist-copy
                      @click="share.copyLink()"
                    /><UiButton label="Open" icon="open-in-new" @click="share.openGist()" />
                  </div>
                </div>
                <div v-if="vaultLocked" class="transfer-gist-locked">
                  <p>GitHub tokens are kept in the credential vault. Unlock it to choose one.</p>
                  <UiButton
                    label="Unlock vault"
                    icon="lock-open-outline"
                    data-transfer-unlock
                    :disabled="vault.loading"
                    @click="vault.unlock()"
                  />
                </div>
                <template v-else>
                  <div v-if="!gist.adding" class="transfer-gist-account">
                    <label class="form-field" for="transfer-gist-account"
                      ><span>GitHub token</span
                      ><UiSelect
                        v-if="githubCredentials.length"
                        id="transfer-gist-account"
                        class="field-input"
                        :value="gist.credentialId"
                        :disabled="gist.busy"
                        @change="setCredential"
                        :options="
                          withIcons(
                            githubCredentials.map(
                              (item) =>
                                [
                                  item.id,
                                  `${item.name} · ${item.allowedOrigin.replace('https://', '')}`,
                                ] as [string, string],
                            ),
                            () => 'key-outline',
                          )
                        "
                      /><span v-else class="transfer-gist-empty"
                        >No GitHub token in the vault yet.</span
                      ></label
                    >
                    <UiButton
                      label="Add token…"
                      icon="plus"
                      data-transfer-add-token
                      :disabled="gist.busy"
                      @click="gist.adding = true"
                    />
                  </div>
                  <form
                    v-else
                    class="transfer-gist-token"
                    data-transfer-token-form
                    @submit.prevent="share.saveToken()"
                  >
                    <p class="field-help">
                      Create a classic token with the <code>gist</code> scope, or a fine-grained
                      token with <strong>Gists: read and write</strong>, in GitHub's Developer
                      settings. It is encrypted in the vault and sent only to GitHub.
                    </p>
                    <div class="transfer-gist-fields">
                      <label class="form-field" for="transfer-token-name"
                        ><span>Name</span
                        ><input
                          id="transfer-token-name"
                          class="field-input"
                          maxlength="80"
                          autocomplete="off"
                          :value="gist.tokenName"
                          @input="setGistText('tokenName', $event)"
                      /></label>
                      <label class="form-field" for="transfer-token-server"
                        ><span>GitHub Enterprise Server (optional)</span
                        ><input
                          id="transfer-token-server"
                          class="field-input"
                          autocomplete="off"
                          spellcheck="false"
                          placeholder="github.example.com"
                          :value="gist.tokenServer"
                          @input="setGistText('tokenServer', $event)"
                      /></label>
                    </div>
                    <label class="form-field" for="transfer-token"
                      ><span>Token</span
                      ><input
                        id="transfer-token"
                        class="field-input"
                        type="password"
                        autocomplete="off"
                        spellcheck="false"
                        aria-describedby="transfer-token-error"
                        :aria-invalid="Boolean(gist.tokenError)"
                        :value="gist.token"
                        @input="setGistText('token', $event)"
                    /></label>
                    <p id="transfer-token-error" class="form-error" aria-live="polite">
                      {{ gist.tokenError }}
                    </p>
                    <div class="transfer-file-actions">
                      <UiButton
                        label="Cancel"
                        variant="ghost"
                        :disabled="gist.busy"
                        @click="gist.adding = false"
                      /><UiButton
                        type="submit"
                        label="Save to vault"
                        icon="shield-key-outline"
                        variant="primary"
                        data-transfer-save-token
                        :disabled="gist.busy"
                      />
                    </div>
                  </form>
                  <div class="transfer-gist-fields">
                    <div class="form-field">
                      <span id="transfer-gist-mode-label">Gist</span>
                      <div
                        class="transfer-segmented"
                        role="radiogroup"
                        aria-labelledby="transfer-gist-mode-label"
                      >
                        <label
                          ><input
                            v-model="gist.mode"
                            type="radio"
                            name="transfer-gist-mode"
                            value="new"
                            data-gist-mode="new"
                          />Create new</label
                        ><label
                          ><input
                            v-model="gist.mode"
                            type="radio"
                            name="transfer-gist-mode"
                            value="update"
                            data-gist-mode="update"
                          />Update existing</label
                        >
                      </div>
                    </div>
                    <div v-if="gist.mode === 'new'" class="form-field">
                      <span id="transfer-gist-visibility-label">Visibility</span>
                      <div
                        class="transfer-segmented"
                        role="radiogroup"
                        aria-labelledby="transfer-gist-visibility-label"
                      >
                        <label
                          ><input
                            v-model="gist.visibility"
                            type="radio"
                            name="transfer-gist-visibility"
                            value="secret"
                            data-gist-visibility="secret"
                          /><MdiIcon name="lock-outline" />Secret</label
                        ><label
                          ><input
                            v-model="gist.visibility"
                            type="radio"
                            name="transfer-gist-visibility"
                            value="public"
                            data-gist-visibility="public"
                          /><MdiIcon name="earth" />Public</label
                        >
                      </div>
                    </div>
                    <label v-else class="form-field" for="transfer-gist-target"
                      ><span>Gist link or ID</span
                      ><input
                        id="transfer-gist-target"
                        class="field-input"
                        spellcheck="false"
                        autocomplete="off"
                        placeholder="https://gist.github.com/you/0123…"
                        :value="gist.target"
                        :disabled="gist.busy"
                        @input="setGistText('target', $event)"
                      /><small
                        v-if="remembered && remembered.url !== gist.target.trim()"
                        class="field-help"
                        >Last published from here: {{ remembered.url }}</small
                      ></label
                    >
                  </div>
                  <label class="form-field" for="transfer-gist-description"
                    ><span>Description</span
                    ><input
                      id="transfer-gist-description"
                      class="field-input"
                      maxlength="1000"
                      autocomplete="off"
                      :placeholder="`${workspace.settings().workspaceName} API collection`"
                      :value="gist.description"
                      :disabled="gist.busy"
                      @input="setGistText('description', $event)"
                  /></label>
                  <p class="transfer-assurance">
                    <MdiIcon name="shield-check-outline" /><span
                      >The gist holds exactly the export above, with secrets left out.
                      {{
                        gist.visibility === 'public' && gist.mode === 'new'
                          ? 'Public gists are listed on your GitHub profile and can be found by search.'
                          : 'Secret gists are not listed, but anyone with the link can open them.'
                      }}</span
                    >
                  </p>
                </template>
              </section>
            </div>
            <section
              v-if="transfer.exported"
              class="transfer-preview transfer-export-summary"
              aria-labelledby="transfer-file-title"
            >
              <div class="transfer-preview-heading">
                <div>
                  <span class="eyebrow">YOUR EXPORT</span>
                  <h3 id="transfer-file-title" class="transfer-file-name">
                    <MdiIcon :name="isZip ? 'folder-zip-outline' : 'file-code-outline'" /><span>{{
                      transfer.exported.name
                    }}</span>
                  </h3>
                </div>
                <span class="transfer-badge">{{ size(transfer.exported.data.length) }}</span>
              </div>
              <dl class="transfer-stats">
                <div>
                  <dt><MdiIcon name="console-network-outline" />Requests</dt>
                  <dd>{{ exportCounts.requests.toLocaleString() }}</dd>
                </div>
                <div>
                  <dt><MdiIcon name="layers-outline" />Environments</dt>
                  <dd>{{ exportCounts.environments.toLocaleString() }}</dd>
                </div>
              </dl>
              <div class="transfer-excluded">
                <strong><MdiIcon name="shield-lock-outline" />Left out, for safety</strong>
                <p>
                  Saved credentials and vault links, tokens and passwords, values of secret-looking
                  headers, parameters, and variables, responses, and history. Review URLs and bodies
                  before sharing.
                </p>
              </div>
              <UiExpansionPanel
                v-if="exportPreview"
                class="transfer-warnings"
                title="Preview contents"
                description="The first lines of what will be shared."
                icon="eye-outline"
              >
                <pre class="transfer-code" data-transfer-contents>{{ exportPreview }}</pre>
              </UiExpansionPanel>
              <UiExpansionPanel
                v-if="transfer.exported.warnings.length"
                class="transfer-warnings"
                title="Conversion notes"
                description="What could not be converted exactly. Review it before you continue."
                icon="alert-outline"
                :badge="String(transfer.exported.warnings.length)"
              >
                <ul>
                  <li v-for="(warning, index) in transfer.exported.warnings" :key="index">
                    {{ warning }}
                  </li>
                </ul>
              </UiExpansionPanel>
            </section>
          </div>
        </template>
      </div>
      <div class="transfer-footer">
        <span class="transfer-footer-note">
          <template v-if="importing">
            <MdiIcon name="information-outline" />{{
              transfer.preview ? 'Adds to this workspace' : 'Preview first, then import'
            }}
          </template>
          <template v-else-if="transfer.exported">
            <MdiIcon name="shield-lock-outline" />Secrets are left out
          </template>
        </span>
        <UiButton
          label="Cancel"
          data-transfer-close
          :disabled="transfer.busy || gist.busy"
          @click="dialogs.closeTransfer()"
        /><UiButton
          :label="confirmLabel"
          :icon="confirmIcon"
          variant="primary"
          data-transfer-confirm
          :disabled="confirmDisabled"
          @click="dialogs.confirmTransfer()"
        />
      </div>
    </section>
  </div>
</template>
