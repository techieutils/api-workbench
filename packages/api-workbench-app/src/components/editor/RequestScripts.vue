<script setup lang="ts">
import { ref } from 'vue';
import {
  collectionOf,
  folderChain,
  folderEntry,
  folderLabel,
  folderName,
  isWithin,
  parentFolder,
} from '@techieutils/api-workbench-common/folders';
import {
  PHASE_LABELS,
  SCRIPT_PHASES,
  moduleNameProblem,
  scriptSteps,
  stepScope,
  type ScriptPhase,
} from '@techieutils/api-workbench-common/scripts';
import { useRendered } from '../../composables/rendered';
import { render } from '../../shell';
import { toast } from '../../utils';
import { useScriptsStore } from '../../stores/scripts';
import { useWorkspaceStore } from '../../stores/workspace';
import type { EditorHandle } from '../../editor/runtime';
import MdiIcon from '../MdiIcon.vue';
import ScrollRow from '../ui/ScrollRow.vue';
import SourceEditor from '../SourceEditor.vue';
import UiButton from '../ui/UiButton.vue';
import GuideButton from '../ui/GuideButton.vue';
import ScriptSnippets from './ScriptSnippets.vue';
import {
  snippetInsertion,
  type ScriptSnippet,
} from '@techieutils/api-workbench-common/script-snippets';
import type { ScriptCompletionContext } from '@techieutils/api-workbench-common/script-api';
import type { ScriptSyntaxProblem } from '@techieutils/api-workbench-common/script-syntax';
import type { RequestResponse } from '@techieutils/api-workbench-common/types';

/**
 * The Scripts tab: a request's pre-request and post-response JavaScript, with the `aw` API.
 * Scripts that came from outside the app show why they are paused and how to allow them.
 */
const workspace = useWorkspaceStore();
const scripts = useScriptsStore();
const request = () => workspace.current();
const phase = ref<ScriptPhase>('pre');
let editor: EditorHandle | undefined;
const setEditor = (handle: EditorHandle | undefined) => (editor = handle);

/** Whether the snippets panel is open beside the editor. */
const showSnippets = ref(true);

/**
 * The level being edited: '' for the request, or a folder path — its collection or a folder
 * between. A level outside the open request's folders falls back to the request.
 */
const level = ref('');
/** The workspace's level; a folder path never starts with a control character. */
const WORKSPACE = '\u0000workspace';
/** The library of shared modules, shown in place of the phases. */
const LIBRARY = '\u0000library';
const target = () =>
  level.value === WORKSPACE ||
  level.value === LIBRARY ||
  (level.value && isWithin(request().folder, level.value))
    ? level.value
    : '';
/** The levels, from the request outward to its collection, as the Settings tab lists them. */
const levels = () => folderChain(request().folder).reverse();
const levelLabel = (path: string) =>
  parentFolder(path) === undefined ? 'Collection' : folderName(path);
const sourceAt = (path: string, item: ScriptPhase) =>
  path === WORKSPACE
    ? (workspace.state.workspaceScripts?.[item] ?? '')
    : path
      ? (folderEntry(workspace.state.collectionScripts, path)?.[item] ?? '')
      : (request().scripts?.[item] ?? '');
/** A level as people read it, for labels and help. */
const levelName = (path: string) =>
  path === WORKSPACE ? 'the workspace' : path ? folderLabel(path) : 'this request';

const view = useRendered(() => {
  const current = request();
  const at = target();
  const collection = collectionOf(current.folder);
  const run = scripts.lastRun(current.id);
  const paused =
    at === WORKSPACE
      ? scripts.pausedWorkspacePhases()
      : at
        ? scripts.pausedFolderPhases(at)
        : scripts.pausedPhases(current);
  return {
    at,
    source: sourceAt(at, phase.value),
    has: Object.fromEntries(
      SCRIPT_PHASES.map((item) => [item, Boolean(sourceAt(at, item).trim())]),
    ) as Record<ScriptPhase, boolean>,
    /** Which levels have a script in this phase, for the dots on the level switch. */
    levelHas: Object.fromEntries(
      ['', ...levels(), WORKSPACE].map((path) => [
        path,
        Boolean(sourceAt(path, phase.value).trim()),
      ]),
    ) as Record<string, boolean>,
    /** The scripts that run for this request in this phase, in order. */
    chain: scriptSteps(workspace.state, current, phase.value).map(
      (step) => stepScope(step) ?? 'This request',
    ),
    paused,
    collection,
    pausedCount: scripts.pausedCount(collection),
    desktop: scripts.available(),
    run: run?.[phase.value].find(
      ({ step }) => (step.workspace ? WORKSPACE : (step.folder ?? '')) === at,
    )?.output,
  };
});

// Suggestions in the editors
/** Larger response bodies are not parsed for suggestions; they would slow typing down. */
const SUGGESTION_BODY_LIMIT = 2 * 1024 * 1024;
const parsedBodies = new WeakMap<object, unknown>();
/** The last response's body parsed as JSON, once per response, or undefined. */
function responseJson(response: RequestResponse | null): unknown {
  if (!response || response.error !== undefined || response.body.length > SUGGESTION_BODY_LIMIT)
    return undefined;
  if (!parsedBodies.has(response)) {
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      value = undefined;
    }
    parsedBodies.set(response, value);
  }
  return parsedBodies.get(response);
}
/**
 * What the script editors suggest besides the `aw` API: the names of the active environment's
 * variables, the library's modules, and the open request's headers, and the keys of its last
 * response. Read each time suggestions open, so they follow edits and new responses. A library
 * module runs in either phase, so it has none.
 */
function completionContext(forPhase?: ScriptPhase): ScriptCompletionContext {
  const current = request();
  const environment = workspace.state.environments[workspace.state.environment];
  const response = current.response?.error === undefined ? current.response : null;
  return {
    phase: forPhase,
    variables: (environment?.variables ?? [])
      .filter((variable) => variable.enabled && variable.key)
      .map((variable) => variable.key),
    modules: scripts.library().map((module) => module.name),
    requestHeaders: current.headers
      .filter((header) => header.enabled && header.key)
      .map((header) => header.key),
    responseHeaders: Object.keys(response?.headers ?? {}),
    responseJson: responseJson(current.response),
  };
}
const phaseContext = () => completionContext(phase.value);

/** The syntax error in the open editor, found after typing pauses, shown under it. */
const syntaxProblem = ref<ScriptSyntaxProblem>();
const setSyntaxProblem = (problem: ScriptSyntaxProblem | undefined) =>
  (syntaxProblem.value = problem);
const goToProblem = () => syntaxProblem.value && editor?.goToLine(syntaxProblem.value.line);
const moduleContext = () => completionContext();

// The library
const moduleName = ref('');
const newName = ref('');
const moduleError = ref('');
/** The module being edited: the one chosen, or the first. */
const currentModule = () => {
  const modules = scripts.library();
  return modules.find((module) => module.name === moduleName.value) ?? modules[0];
};
const libraryView = useRendered(() => ({
  modules: scripts.library().map((module) => ({
    name: module.name,
    paused: scripts.modulePaused(module.name),
  })),
  current: currentModule(),
}));
function selectModule(name: string) {
  moduleName.value = name;
  moduleError.value = '';
  render();
}
function createModule() {
  const name = newName.value.trim();
  const problem = moduleNameProblem(
    name,
    scripts.library().map((module) => module.name),
  );
  moduleError.value = problem ?? '';
  if (problem) return render();
  scripts.addModule(name);
  // A starting point that shows how a module shares its functions.
  scripts.editModule(
    name,
    `// Use in any script with: const { example } = aw.require('${name}');\n\nexports.example = (value) => value;\n`,
  );
  moduleName.value = name;
  newName.value = '';
  render();
}
function renameModule(event: Event) {
  const module = currentModule();
  const input = event.target as HTMLInputElement;
  const next = input.value.trim();
  if (!module || next === module.name) return;
  const problem = moduleNameProblem(
    next,
    scripts
      .library()
      .filter((item) => item !== module)
      .map((item) => item.name),
  );
  moduleError.value = problem ?? '';
  if (problem) {
    input.value = module.name;
    return render();
  }
  scripts.renameModule(module.name, next);
  moduleName.value = next;
  render();
}
async function removeModule() {
  const module = currentModule();
  if (module && (await scripts.deleteModule(module.name))) {
    moduleName.value = '';
    render();
  }
}
function changeModule(value: string) {
  const module = currentModule();
  if (module) scripts.editModule(module.name, value);
  render();
}

function choose(next: ScriptPhase) {
  phase.value = next;
  render();
}
function chooseLevel(path: string) {
  level.value = path;
  render();
}
function change(value: string) {
  const at = target();
  if (at === WORKSPACE) scripts.editWorkspace(phase.value, value);
  else if (at) scripts.editFolder(at, phase.value, value);
  else scripts.edit(request(), phase.value, value);
  render();
}
/** Inserts a snippet at the cursor, on a line of its own, as typing it would. */
function insertSnippet(snippet: ScriptSnippet) {
  if (!editor) return;
  const at = editor.selectionRange().from;
  editor.replaceSelection(snippetInsertion(editor.getValue(), at, snippet.code));
  editor.focus();
}
/** The editor's selection, which a new snippet starts from. */
const selectedText = () => editor?.selection() ?? '';
function saveSnippet(snippet: Parameters<typeof scripts.saveSnippet>[0]) {
  const saved = scripts.saveSnippet(snippet);
  toast(`Saved the snippet “${saved.title}”`, 'success');
  render();
}
function toggleSnippets() {
  showSnippets.value = !showSnippets.value;
  render();
}
const testsSummary = () => {
  const run = view.value.run;
  if (!run) return '';
  const passed = run.tests.filter((test) => test.pass).length;
  return run.tests.length ? `${passed}/${run.tests.length} tests passed` : 'No tests';
};
</script>

<template>
  <div class="scripts-tab" data-scripts-tab>
    <div class="table-label scripts-header">
      <div>
        <strong>Scripts</strong
        ><span
          >JavaScript that runs before the request is sent and after its response arrives, with the
          <code>aw</code> API</span
        ><GuideButton guide="scripts" topic="scripts" />
      </div>
    </div>

    <div v-if="view.pausedCount" class="scripts-paused" role="status" data-scripts-paused>
      <MdiIcon name="shield-lock-outline" />
      <div>
        <strong>Scripts are paused</strong>
        <span
          >{{ view.pausedCount }} script{{ view.pausedCount === 1 ? '' : 's' }} in
          <strong>{{ view.collection }}</strong> came from outside API Workbench — an import, a
          teammate's change, or an edit to the workspace's files. Read them — on this request, its
          folders, the collection, the workspace, and the library — before allowing them to
          run.</span
        >
      </div>
      <UiButton
        label="Allow scripts"
        icon="check"
        data-action="allow-scripts"
        @click="scripts.allowCollection(view.collection)"
      />
    </div>
    <p v-else-if="!view.desktop" class="field-help">Scripts run in the desktop app.</p>

    <!-- Which level's scripts to edit: this request, its folders, its collection. -->
    <ScrollRow
      class="segmented-control scripts-levels"
      role="group"
      aria-label="Script level"
      noun="levels"
    >
      <button
        type="button"
        data-script-level="request"
        :aria-pressed="view.at === ''"
        :class="{ selected: view.at === '' }"
        @click="chooseLevel('')"
      >
        This request<span v-if="view.levelHas['']" class="scripts-dot"></span>
      </button>
      <button
        v-for="path in levels()"
        :key="path"
        type="button"
        :data-script-level="parentFolder(path) === undefined ? 'collection' : 'folder'"
        :data-script-folder="path"
        :title="folderLabel(path)"
        :aria-pressed="view.at === path"
        :class="{ selected: view.at === path }"
        @click="chooseLevel(path)"
      >
        {{ levelLabel(path) }}<span v-if="view.levelHas[path]" class="scripts-dot"></span>
      </button>
      <button
        type="button"
        data-script-level="workspace"
        :aria-pressed="view.at === WORKSPACE"
        :class="{ selected: view.at === WORKSPACE }"
        @click="chooseLevel(WORKSPACE)"
      >
        Workspace<span v-if="view.levelHas[WORKSPACE]" class="scripts-dot"></span>
      </button>
      <button
        type="button"
        class="scripts-library-button"
        data-script-level="library"
        :aria-pressed="view.at === LIBRARY"
        :class="{ selected: view.at === LIBRARY }"
        @click="chooseLevel(LIBRARY)"
      >
        <MdiIcon name="function-variant" />Library<span
          v-if="libraryView.modules.length"
          class="scripts-count"
          >{{ libraryView.modules.length }}</span
        >
      </button>
    </ScrollRow>

    <div v-if="view.at === LIBRARY" class="scripts-library" data-scripts-library>
      <ScrollRow
        class="body-modes scripts-modules"
        frame-class="body-modes-frame"
        role="group"
        aria-label="Library modules"
        noun="modules"
      >
        <button
          v-for="module in libraryView.modules"
          :key="module.name"
          type="button"
          :data-script-module="module.name"
          :class="{ active: libraryView.current?.name === module.name }"
          :aria-pressed="libraryView.current?.name === module.name"
          @click="selectModule(module.name)"
        >
          <span class="mode-dot"></span>{{ module.name
          }}<span v-if="module.paused" class="scripts-paused-tag">Paused</span>
        </button>
        <form class="scripts-new-module" @submit.prevent="createModule">
          <input
            v-model="newName"
            class="field-input"
            aria-label="New module name"
            placeholder="New module, such as signing"
            spellcheck="false"
            data-new-module
          />
          <UiButton type="submit" label="Add module" icon="plus" variant="ghost" />
        </form>
      </ScrollRow>
      <p v-if="moduleError" class="scripts-error" role="alert">{{ moduleError }}</p>
      <template v-if="libraryView.current">
        <div class="scripts-module-head">
          <label class="inline-field" for="script-module-name"
            >Name<input
              id="script-module-name"
              :key="libraryView.current.name"
              class="field-input"
              :value="libraryView.current.name"
              spellcheck="false"
              @change="renameModule"
          /></label>
          <code>aw.require('{{ libraryView.current.name }}')</code>
          <button
            type="button"
            class="scripts-snippets-toggle"
            data-action="toggle-snippets"
            :aria-pressed="showSnippets"
            @click="toggleSnippets"
          >
            <MdiIcon name="code-braces" />Snippets
          </button>
          <UiButton
            label="Delete module"
            icon="delete-outline"
            variant="ghost"
            data-action="delete-module"
            @click="removeModule"
          />
        </div>
        <div :class="['scripts-workspace', { 'has-snippets': showSnippets }]">
          <SourceEditor
            :key="`module-${libraryView.current.name}`"
            class="source-editor-host request-editor-host scripts-editor"
            :value="libraryView.current.source"
            language="javascript"
            :wrap="workspace.settings().wordWrap"
            :label="`Library module ${libraryView.current.name}`"
            :script-context="moduleContext"
            syntax="module"
            context-menu
            @change="changeModule"
            @handle="setEditor"
            @syntax="setSyntaxProblem"
          />
          <ScriptSnippets
            v-if="showSnippets"
            place="module"
            :custom="scripts.snippets()"
            :selection="selectedText"
            @insert="insertSnippet"
            @close="toggleSnippets"
            @save="saveSnippet"
            @delete="scripts.deleteSnippet"
          />
        </div>
        <!-- Always present, so screen readers hear when a syntax error appears or is fixed. -->
        <p class="scripts-syntax" role="status" data-scripts-syntax>
          <template v-if="syntaxProblem"
            ><MdiIcon name="alert-circle-outline" /><span
              >Syntax error on line {{ syntaxProblem.line }}: {{ syntaxProblem.message }}</span
            ><button
              type="button"
              class="text-button"
              data-action="go-to-syntax-error"
              @click="goToProblem"
            >
              Go to line {{ syntaxProblem.line }}
            </button></template
          >
        </p>
      </template>
      <p v-else class="field-help">No modules yet. Name one above to add it.</p>
      <p class="field-help scripts-help">
        Modules hold functions every script in the workspace can use. Share them with
        <code>exports.name = …</code> or <code>module.exports = …</code>, and load them in a script
        with <code>aw.require('name')</code>. A module runs once per script, the first time it is
        required, and can require other modules. Each is saved as
        <code>scripts/&lt;name&gt;.js</code>.
      </p>
    </div>
    <template v-else>
      <ScrollRow
        class="body-modes scripts-phases"
        frame-class="body-modes-frame"
        role="group"
        aria-label="Script phase"
        noun="script phases"
      >
        <button
          v-for="item in SCRIPT_PHASES"
          :key="item"
          type="button"
          :data-script-phase="item"
          :class="{ active: phase === item }"
          :aria-pressed="phase === item"
          @click="choose(item)"
        >
          <span class="mode-dot"></span>{{ PHASE_LABELS[item] }}
          <span v-if="view.has[item]" class="scripts-dot" aria-label="has a script"></span>
        </button>
        <button
          type="button"
          class="scripts-snippets-toggle"
          data-action="toggle-snippets"
          :aria-pressed="showSnippets"
          @click="toggleSnippets"
        >
          <MdiIcon name="code-braces" />Snippets
        </button>
      </ScrollRow>

      <div :class="['scripts-workspace', { 'has-snippets': showSnippets }]">
        <SourceEditor
          :key="`${request().id}-${view.at}-${phase}`"
          class="source-editor-host request-editor-host scripts-editor"
          :value="view.source"
          language="javascript"
          :wrap="workspace.settings().wordWrap"
          :label="`${PHASE_LABELS[phase]} script of ${levelName(view.at)}`"
          :script-context="phaseContext"
          syntax="script"
          context-menu
          @change="change"
          @handle="setEditor"
          @syntax="setSyntaxProblem"
        />
        <ScriptSnippets
          v-if="showSnippets"
          :place="phase"
          :custom="scripts.snippets()"
          :selection="selectedText"
          @insert="insertSnippet"
          @close="toggleSnippets"
          @save="saveSnippet"
          @delete="scripts.deleteSnippet"
        />
      </div>
      <!-- Always present, so screen readers hear when a syntax error appears or is fixed. -->
      <p class="scripts-syntax" role="status" data-scripts-syntax>
        <template v-if="syntaxProblem"
          ><MdiIcon name="alert-circle-outline" /><span
            >Syntax error on line {{ syntaxProblem.line }}: {{ syntaxProblem.message }}</span
          ><button
            type="button"
            class="text-button"
            data-action="go-to-syntax-error"
            @click="goToProblem"
          >
            Go to line {{ syntaxProblem.line }}
          </button></template
        >
      </p>

      <p v-if="view.chain.length" class="field-help scripts-chain" data-scripts-chain>
        <MdiIcon name="arrow-right" />{{ PHASE_LABELS[phase] }} scripts run in this order:
        <template v-for="(name, index) in view.chain" :key="index"
          ><span v-if="index">→</span><strong>{{ name }}</strong></template
        >
      </p>
      <p v-if="view.at === WORKSPACE" class="field-help">
        Runs for every request in this workspace, before the scripts of its collections, folders,
        and requests.
      </p>
      <p v-else-if="view.at" class="field-help">
        Runs for every request in <strong>{{ folderLabel(view.at) }}</strong
        >, before the scripts of its folders and requests.
      </p>
      <div v-if="view.run" class="scripts-run" data-scripts-run>
        <span :class="['captures-fact', view.run.ok ? 'is-live' : 'is-failed']"
          ><MdiIcon :name="view.run.ok ? 'check-circle-outline' : 'close-circle-outline'" />{{
            view.run.ok ? `Ran in ${view.run.durationMs} ms` : 'Failed'
          }}</span
        >
        <span v-if="view.run.ok" class="captures-fact">{{ testsSummary() }}</span>
        <span v-if="Object.keys(view.run.variables).length" class="captures-fact"
          ><MdiIcon name="variable" />Set {{ Object.keys(view.run.variables).join(', ') }}</span
        >
        <span v-if="view.run.logs.length" class="captures-fact"
          ><MdiIcon name="console" />{{ view.run.logs.length }} console line{{
            view.run.logs.length === 1 ? '' : 's'
          }}</span
        >
        <p v-if="!view.run.ok" class="scripts-error">{{ view.run.error }}</p>
      </div>
      <p class="field-help scripts-help">
        <template v-if="phase === 'pre'"
          >Read and set variables with <code>aw.vars</code>, and change the request with
          <code>aw.request</code> — its <code>url</code>, <code>method</code>, <code>body</code>,
          and <code>headers</code>. Variables you set resolve in this request.</template
        >
        <template v-else
          >Read the response with <code>aw.response</code>, check it with
          <code>aw.test(name, () =&gt; aw.expect(value).toBe(expected))</code>, and save values with
          <code>aw.vars.set</code>. Results appear with the request's tests.</template
        >
        <code>aw.log</code>, <code>aw.info</code>, <code>aw.warn</code>, and
        <code>aw.error</code> write to the console. Scripts cannot reach files, the network, or the
        vault, and stop after 2 seconds.
      </p>
    </template>
  </div>
</template>
