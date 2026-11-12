import { defineStore } from 'pinia';
import { markRaw, ref } from 'vue';
import type { AssertionResult } from '@techieutils/api-workbench-common/assertions';
import { folderEntry, isWithin, setFolderEntry } from '@techieutils/api-workbench-common/folders';
import {
  PHASE_LABELS,
  SCRIPT_PHASES,
  applyScriptVariables,
  allScriptSteps,
  runScriptSteps,
  scriptAssertions,
  scriptOf,
  scriptSteps,
  stepScope,
  type ScriptStep,
  type StepResult,
  scriptRequestOf,
  scriptResponseOf,
  withScriptRequest,
  type ScriptOutput,
  type ScriptPhase,
} from '@techieutils/api-workbench-common/scripts';
import type {
  ApiRequest,
  Environment,
  HttpResponse,
  RequestResponse,
} from '@techieutils/api-workbench-common/types';
import { confirmAction } from '../confirm';
import type { UserSnippet } from '@techieutils/api-workbench-common/script-snippets';
import { render } from '../shell';
import { errorMessage, toast, uid } from '../utils';
import { useToolsStore } from './tools';
import { useWorkspaceStore } from './workspace';

/** What a request's scripts did on its last send, shown with its response; never saved. */
export interface ScriptRun {
  /** The response the results belong to, so an older response never shows newer results. */
  response?: RequestResponse;
  pre: StepResult[];
  post: StepResult[];
}

/**
 * Request scripts in the window: which may run, allowing a collection's scripts, and running a
 * request's scripts around a send. The scripts themselves run in the main process; the window
 * only sends their text and data and applies what comes back.
 */
export const useScriptsStore = defineStore('scripts', () => {
  const workspace = useWorkspaceStore();
  /** Whether each script text may run, as the main process last said. */
  const trust = markRaw(new Map<string, boolean>());
  /** Bumped when `trust` changes, so views that read it repaint. */
  const trustVersion = ref(0);
  const runs = markRaw(new Map<string, ScriptRun>());
  const available = () => Boolean(window.workbench?.scripts);

  /**
   * Every script that runs for requests in a collection: its requests', its folders', its own,
   * and the workspace's, which runs for every request.
   */
  const sourcesIn = (collection: string): string[] => [
    ...SCRIPT_PHASES.map((phase) => workspace.state.workspaceScripts?.[phase]).filter(
      (source): source is string => Boolean(source?.trim()),
    ),
    // The library, which any of them may require.
    ...(workspace.state.scriptLibrary ?? [])
      .map((module) => module.source)
      .filter((source) => source.trim()),
    ...workspace.state.requests
      .filter((request) => isWithin(request.folder, collection))
      .flatMap((request) =>
        SCRIPT_PHASES.map((phase) => scriptOf(request, phase)).filter(
          (source): source is string => source !== undefined,
        ),
      ),
    ...Object.entries(workspace.state.collectionScripts ?? {})
      .filter(([folder]) => isWithin(folder, collection))
      .flatMap(([, scripts]) =>
        SCRIPT_PHASES.map((phase) => scripts[phase]).filter((source): source is string =>
          Boolean(source?.trim()),
        ),
      ),
  ];
  /** False for a script known to be paused; unknown scripts are looked up in the background. */
  function trusted(source: string): boolean {
    void trustVersion.value;
    const known = trust.get(source);
    if (known === undefined && available()) void refreshSources([source]);
    return known ?? true;
  }
  /** Scripts being looked up, so a view that repaints while it waits asks only once. */
  const asking = new Set<string>();
  async function refreshSources(sources: string[]) {
    const bridge = window.workbench?.scripts;
    const fresh = sources.filter((source) => !asking.has(source));
    if (!bridge || !fresh.length) return;
    fresh.forEach((source) => asking.add(source));
    try {
      const answers = await bridge.trusted(fresh);
      fresh.forEach((source, index) => trust.set(source, answers[index]));
    } finally {
      fresh.forEach((source) => asking.delete(source));
    }
    trustVersion.value++;
    render();
  }
  /** The request's scripts that are waiting for their collection to be allowed. */
  const pausedPhases = (request: ApiRequest): ScriptPhase[] =>
    SCRIPT_PHASES.filter((phase) => {
      const source = scriptOf(request, phase);
      return source !== undefined && !trusted(source);
    });
  /** A folder's scripts that are waiting for their collection to be allowed. */
  const pausedFolderPhases = (folder: string): ScriptPhase[] =>
    SCRIPT_PHASES.filter((phase) => {
      const source = folderEntry(workspace.state.collectionScripts, folder)?.[phase];
      return Boolean(source?.trim()) && !trusted(source!);
    });
  /** The workspace's scripts that are waiting to be allowed. */
  const pausedWorkspacePhases = (): ScriptPhase[] =>
    SCRIPT_PHASES.filter((phase) => {
      const source = workspace.state.workspaceScripts?.[phase];
      return Boolean(source?.trim()) && !trusted(source!);
    });
  /** Whether a library module is waiting to be allowed. */
  const modulePaused = (name: string): boolean => {
    const source = workspace.state.scriptLibrary?.find((module) => module.name === name)?.source;
    return Boolean(source?.trim()) && !trusted(source!);
  };
  /** How many scripts in a collection are paused, its folders' included. */
  const pausedCount = (collection: string): number =>
    new Set(sourcesIn(collection).filter((source) => !trusted(source))).size;
  /** Whether any script that runs for a request — its own or a folder's — is paused. */
  const requestPaused = (request: ApiRequest): boolean =>
    allScriptSteps(workspace.state, request).some((step) => !trusted(step.source));

  /** After the person confirms, allows every paused script in a collection. */
  async function allowCollection(collection: string): Promise<void> {
    const bridge = window.workbench?.scripts;
    if (!bridge) return;
    const sources = [...new Set(sourcesIn(collection).filter((source) => !trusted(source)))];
    if (!sources.length) return;
    const confirmed = await confirmAction({
      title: `Allow scripts in “${collection}”?`,
      message: `${sources.length} script${sources.length === 1 ? '' : 's'} in this collection came from outside API Workbench: an import, a teammate's change, or an edit to the workspace's files. Review them first — each request's Scripts tab shows the scripts of its folders, its collection, and the workspace. Scripts can change requests before they are sent, read responses, and set variables; they cannot reach your files, the network, or the vault.`,
      confirmLabel: 'Allow scripts',
    });
    if (!confirmed) return;
    try {
      await bridge.allow(sources);
      sources.forEach((source) => trust.set(source, true));
      trustVersion.value++;
      toast(`Scripts in ${collection} will run`, 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
    render();
  }

  /**
   * Saves an edit made in the editor and tells the main process, which allows the new text when
   * the old text was allowed: your own scripts keep running as you type, paused ones stay paused.
   */
  function edit(request: ApiRequest, phase: ScriptPhase, next: string): void {
    const previous = request.scripts?.[phase] ?? '';
    if (previous === next) return;
    request.scripts = { ...request.scripts, [phase]: next };
    if (!next.trim()) delete request.scripts[phase];
    if (!Object.keys(request.scripts).length) delete request.scripts;
    workspace.persist();
    edited(previous, next);
  }
  /** The same, for a collection's or folder's script, kept in the workspace by folder path. */
  function editFolder(folder: string, phase: ScriptPhase, next: string): void {
    const state = workspace.state;
    const scripts = { ...folderEntry(state.collectionScripts, folder) };
    const previous = scripts[phase] ?? '';
    if (previous === next) return;
    scripts[phase] = next;
    if (!next.trim()) delete scripts[phase];
    const all = { ...state.collectionScripts };
    if (Object.keys(scripts).length) setFolderEntry(all, folder, scripts);
    else delete all[folder];
    if (Object.keys(all).length) state.collectionScripts = all;
    else delete state.collectionScripts;
    workspace.persist();
    edited(previous, next);
  }
  /** The same, for the workspace's script, which runs for every request. */
  function editWorkspace(phase: ScriptPhase, next: string): void {
    const state = workspace.state;
    const scripts = { ...state.workspaceScripts };
    const previous = scripts[phase] ?? '';
    if (previous === next) return;
    scripts[phase] = next;
    if (!next.trim()) delete scripts[phase];
    if (Object.keys(scripts).length) state.workspaceScripts = scripts;
    else delete state.workspaceScripts;
    workspace.persist();
    edited(previous, next);
  }
  /** The workspace's saved snippets, in the order they were added. */
  const snippets = (): UserSnippet[] => workspace.state.scriptSnippets ?? [];
  /** Adds a snippet, or replaces the one with the same id; the caller checks it first. */
  function saveSnippet(snippet: Omit<UserSnippet, 'id'> & { id?: string }): UserSnippet {
    const saved: UserSnippet = {
      id: snippet.id ?? uid(),
      title: snippet.title.trim(),
      ...(snippet.description?.trim() ? { description: snippet.description.trim() } : {}),
      places: [...snippet.places],
      code: snippet.code,
    };
    const list = snippets();
    const index = list.findIndex((item) => item.id === saved.id);
    workspace.state.scriptSnippets =
      index >= 0 ? list.map((item, at) => (at === index ? saved : item)) : [...list, saved];
    workspace.persist();
    return saved;
  }
  async function deleteSnippet(id: string): Promise<boolean> {
    const snippet = snippets().find((item) => item.id === id);
    if (!snippet) return false;
    const confirmed = await confirmAction({
      title: `Delete the snippet “${snippet.title}”?`,
      message: 'It is removed from the snippets panel for everyone in this workspace.',
      confirmLabel: 'Delete snippet',
      tone: 'danger',
    });
    if (!confirmed) return false;
    const rest = snippets().filter((item) => item.id !== id);
    if (rest.length) workspace.state.scriptSnippets = rest;
    else delete workspace.state.scriptSnippets;
    workspace.persist();
    render();
    return true;
  }
  /** The library's modules, by name, in the order they were added. */
  const library = () => workspace.state.scriptLibrary ?? [];
  /** Adds an empty module; the caller checks the name with moduleNameProblem first. */
  function addModule(name: string): void {
    workspace.state.scriptLibrary = [...library(), { name, source: '' }];
    workspace.persist();
  }
  function editModule(name: string, next: string): void {
    const module = library().find((item) => item.name === name);
    if (!module || module.source === next) return;
    const previous = module.source;
    module.source = next;
    workspace.persist();
    edited(previous, next);
  }
  function renameModule(name: string, next: string): void {
    const module = library().find((item) => item.name === name);
    if (!module) return;
    module.name = next;
    workspace.persist();
  }
  async function deleteModule(name: string): Promise<boolean> {
    const confirmed = await confirmAction({
      title: `Delete the module “${name}”?`,
      message: `Scripts that call aw.require('${name}') will fail until it is added again.`,
      confirmLabel: 'Delete module',
      tone: 'danger',
    });
    if (!confirmed) return false;
    const rest = library().filter((item) => item.name !== name);
    if (rest.length) workspace.state.scriptLibrary = rest;
    else delete workspace.state.scriptLibrary;
    workspace.persist();
    return true;
  }
  function edited(previous: string, next: string) {
    const bridge = window.workbench?.scripts;
    if (!bridge) return;
    if (trust.get(previous) !== false) trust.set(next, true);
    void bridge.edited(previous, next).then((allowed) => {
      if (trust.get(next) !== allowed) {
        trust.set(next, allowed);
        trustVersion.value++;
        render();
      }
    });
  }

  /** The variables a script reads: the environment's, then a data row's on top. */
  function variablesFor(environment: Environment | undefined, row?: Record<string, string>) {
    const variables: Record<string, string> = {};
    for (const variable of environment?.variables ?? [])
      if (variable.enabled && variable.key) variables[variable.key] = variable.value;
    return { ...variables, ...row };
  }
  /** A script's console lines in the dev tools console, labelled with its phase. */
  function logOutput(request: ApiRequest, step: ScriptStep, output: ScriptOutput) {
    const tools = useToolsStore();
    const scope = stepScope(step);
    const label = `${scope ? `${scope} · ` : ''}${PHASE_LABELS[step.phase].toLowerCase()}`;
    for (const line of output.logs)
      tools.addConsoleEntry(
        request,
        line.level === 'warn' || line.level === 'error' ? 'error' : 'info',
        `[${label} script] ${line.message}`,
      );
    if (!output.ok && output.error)
      tools.addConsoleEntry(request, 'error', `[${label} script] ${output.error}`);
    else {
      const passed = output.tests.filter((test) => test.pass).length;
      tools.addConsoleEntry(
        request,
        passed < output.tests.length ? 'error' : 'info',
        `[${label} script] Ran in ${output.durationMs} ms${output.tests.length ? ` · ${passed}/${output.tests.length} tests passed` : ''}${Object.keys(output.variables).length ? ` · set ${Object.keys(output.variables).join(', ')}` : ''}`,
      );
    }
  }

  /** Runs a phase's scripts — the collection's and folders', then the request's — in order. */
  async function runPhase(
    phase: ScriptPhase,
    request: ApiRequest,
    options: {
      environment?: Environment;
      row?: Record<string, string>;
      response?: HttpResponse;
    },
  ) {
    const bridge = window.workbench?.scripts;
    return runScriptSteps(scriptSteps(workspace.state, request, phase), {
      request: scriptRequestOf(request),
      ...(options.response ? { response: scriptResponseOf(options.response) } : {}),
      variables: () => variablesFor(options.environment, options.row),
      run: async (input) =>
        bridge
          ? bridge.run({ ...input, libraries: library() })
          : {
              ok: false,
              error: 'Scripts run in the desktop app.',
              variables: {},
              tests: [],
              logs: [],
              durationMs: 0,
            },
      applied: ({ step, output }) => {
        if (output.paused && trust.get(step.source) !== false) {
          trust.set(step.source, false);
          trustVersion.value++;
        }
        if (options.environment)
          applyScriptVariables(options.environment.variables, output.variables);
        logOutput(request, step, output);
      },
    });
  }

  /**
   * Runs the pre-request scripts that apply to a request and returns the request to send: a copy
   * with their changes. A script that fails or is paused stops the send.
   */
  async function beforeSend(
    request: ApiRequest,
    environment = workspace.state.environments[workspace.state.environment],
    row?: Record<string, string>,
  ): Promise<{ request: ApiRequest; results: StepResult[] }> {
    if (!scriptSteps(workspace.state, request, 'pre').length) return { request, results: [] };
    const {
      results,
      request: edited,
      failed,
    } = await runPhase('pre', request, {
      environment,
      row,
    });
    if (failed) {
      const scope = stepScope(failed.step);
      throw new Error(
        failed.output.paused
          ? failed.output.error
          : `${scope ? `${scope} pre-request` : 'Pre-request'} script failed: ${failed.output.error ?? 'unknown error'}`,
      );
    }
    return { request: edited ? withScriptRequest(request, edited) : request, results };
  }
  /** Runs the post-response scripts that apply to a request on its response. */
  async function afterResponse(
    request: ApiRequest,
    response: RequestResponse,
    environment = workspace.state.environments[workspace.state.environment],
    row?: Record<string, string>,
  ): Promise<StepResult[]> {
    if (response.error !== undefined || !scriptSteps(workspace.state, request, 'post').length)
      return [];
    return (await runPhase('post', request, { environment, row, response })).results;
  }
  /** Step results as test results; a failed pre-request script already stopped the send. */
  const stepAssertions = (results: StepResult[]): AssertionResult[] =>
    results.flatMap(({ step, output }) =>
      scriptAssertions(
        step.phase,
        step.phase === 'pre' ? { ...output, ok: true } : output,
        stepScope(step),
      ),
    );

  /** Records a send's script results for the response view. */
  function record(requestId: string, run: ScriptRun) {
    if (run.pre.length || run.post.length) runs.set(requestId, run);
    else runs.delete(requestId);
  }
  /** The script results that belong to this response, as test results. */
  function assertionsFor(request: ApiRequest, response: RequestResponse | null): AssertionResult[] {
    const run = runs.get(request.id);
    if (!run || !response || run.response !== response) return [];
    return stepAssertions([...run.pre, ...run.post]);
  }
  const lastRun = (requestId: string) => runs.get(requestId);

  return {
    trustVersion,
    available,
    trusted,
    pausedPhases,
    pausedFolderPhases,
    pausedWorkspacePhases,
    modulePaused,
    snippets,
    saveSnippet,
    deleteSnippet,
    library,
    addModule,
    editModule,
    renameModule,
    deleteModule,
    pausedCount,
    requestPaused,
    allowCollection,
    edit,
    editFolder,
    editWorkspace,
    stepAssertions,
    beforeSend,
    afterResponse,
    record,
    assertionsFor,
    lastRun,
  };
});
